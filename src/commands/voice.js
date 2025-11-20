import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  EndBehaviorType,
  getVoiceConnection,
} from '@discordjs/voice';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { exec } from 'child_process';
import prism from 'prism-media';
import { mkdir, unlink, readFile, writeFile, appendFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import { transcribeAudio } from '../services/transcription.js';
import { summarizeText } from '../services/summarization.js';

const pipelineAsync = promisify(pipeline);
const execAsync = promisify(exec);

// Resolve ffmpeg binary: prefer FFMPEG_PATH env, then system binary, else bundled static
const resolvedFfmpegPath = (() => {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  // Common system path inside Debian slim image
  const systemPath = '/usr/bin/ffmpeg';
  if (existsSync(systemPath)) return systemPath;
  return ffmpegStatic; // fall back to static module binary
})();
console.log(`🎬 Using ffmpeg binary: ${resolvedFfmpegPath}`);

// Transcoding and transcription tunables (override via env)
const MP3_BITRATE_K = Number(process.env.MP3_BITRATE_K || 96); // kbps; 96 is good for voice
const PROACTIVE_CHUNK_MB = Number(process.env.PROACTIVE_CHUNK_MB || 12); // chunk files larger than this
const DEFAULT_CHUNK_SECONDS = Number(process.env.CHUNK_SECONDS || 120);

// Store active recordings
const activeRecordings = new Map();

// Tuning constants for capture reliability and robustness
const SILENCE_CLOSE_MS = 1000; // was 100ms – increased to avoid clipping tail of speech
const FINAL_FLUSH_DELAY_MS = 5000; // wait longer before processing after stop (increased for large files)
const STREAM_FLUSH_INTERVAL_MS = 30000; // flush write streams every 30s to prevent data loss
const MAX_RECONNECT_ATTEMPTS = 3; // reconnection attempts if connection drops
const STREAM_HIGH_WATER_MARK = 64 * 1024; // 64KB buffer for write streams (helps with concurrent writes)

export async function handleVoiceCommand(interaction) {
  const action = interaction.options.getString('action');
  const member = interaction.member;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    if (interaction.deferred) {
      return interaction.editReply({
        content: '❌ You need to be in a voice channel to use this command!',
      });
    }
    return interaction.reply({
      content: '❌ You need to be in a voice channel to use this command!',
      ephemeral: true,
    });
  }

  if (action === 'start') {
    await startRecording(interaction, voiceChannel);
  } else if (action === 'stop') {
    await stopRecording(interaction, voiceChannel);
  }
}

async function startRecording(interaction, voiceChannel) {
  const guildId = voiceChannel.guild.id;

  if (activeRecordings.has(guildId)) {
    if (interaction.deferred) {
      return interaction.editReply({ content: '❌ Already recording in this server!' });
    }
    return interaction.reply({ content: '❌ Already recording in this server!', ephemeral: true });
  }

  // Interaction already deferred in index.js; provide status
  await interaction.editReply({ content: `🔄 Joining ${voiceChannel.name}...` });

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      selfDeaf: false,
      selfMute: true,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    const recordingData = {
      connection,
      startTime: Date.now(),
      audioStreams: new Map(),
      voiceChannel,
      interaction,
      flushIntervals: new Map(), // Track flush intervals per user
      reconnectAttempts: 0,
      voiceStateHandler: null, // Will be set below
    };

    activeRecordings.set(guildId, recordingData);

    // Monitor connection status and attempt recovery
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('⚠️ Voice connection disconnected, attempting recovery...');
      try {
        await Promise.race([
          connection.reconnect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Reconnection timeout')), 5000)),
        ]);
        console.log('✅ Voice connection recovered');
      } catch (error) {
        console.error('❌ Failed to recover connection:', error);
        if (recordingData.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          recordingData.reconnectAttempts++;
          console.log(`🔄 Reconnection attempt ${recordingData.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
        } else {
          console.error('❌ Max reconnection attempts reached, stopping recording');
          connection.destroy();
          activeRecordings.delete(guildId);
        }
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.log('🔌 Voice connection destroyed');
      // Cleanup flush intervals
      if (recordingData.flushIntervals) {
        recordingData.flushIntervals.forEach(interval => clearInterval(interval));
        recordingData.flushIntervals.clear();
      }
      // Remove voice state listener
      if (recordingData.voiceStateHandler) {
        voiceChannel.guild.client.removeListener('voiceStateUpdate', recordingData.voiceStateHandler);
        recordingData.voiceStateHandler = null;
      }
    });

    // Continuous per-user aggregation approach to reduce lost chunks
    connection.receiver.speaking.on('start', async (userId) => {
      if (!activeRecordings.has(guildId)) return;
      const user = voiceChannel.guild.members.cache.get(userId);
      const recordingsDir = path.join(process.cwd(), 'recordings', guildId);
      if (!existsSync(recordingsDir)) {
        await mkdir(recordingsDir, { recursive: true }).catch(console.error);
      }

      // If already tracking user with a persistent subscription, skip creating another
      const existing = recordingData.audioStreams.get(userId);
      if (existing && existing.persistent) {
        return; // subscription already active
      }

      console.log(`🎤 (persistent) ${user?.displayName || user?.user.tag || userId} started speaking`);

      // Create a single PCM file for entire session for this user
      const aggregatedFilename = `user_${userId}_full.pcm`;
      const aggregatedPath = path.join(recordingsDir, aggregatedFilename);
      const aggregatedOut = createWriteStream(aggregatedPath, { 
        flags: 'a', // append if exists
        highWaterMark: STREAM_HIGH_WATER_MARK, // larger buffer for concurrent writes
      });

      // Manual end so stream stays available across pauses; Discord only sends frames when user speaks
      const audioStream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
      });

      const decoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 2,
        rate: 48000,
      });

      let streamActive = true;
      let bytesWritten = 0;

      // Handle stream errors gracefully without breaking the pipeline
      audioStream.on('error', (err) => {
        // Log but don't crash - streams may close when users disconnect
        if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          console.error(`Audio stream error for ${user?.displayName || user?.user.tag}:`, err);
        }
        streamActive = false;
      });

      decoder.on('error', (err) => {
        console.error(`Decoder error for ${user?.displayName || user?.user.tag}:`, err);
        // Try to recover by recreating the decoder if possible
        streamActive = false;
      });

      aggregatedOut.on('error', (err) => {
        console.error(`Write stream error for ${user?.displayName || user?.user.tag}:`, err);
        streamActive = false;
      });

      // Track bytes written for monitoring
      aggregatedOut.on('drain', () => {
        // Buffer has drained, can write more
      });

      // Monitor data flow
      decoder.on('data', (chunk) => {
        bytesWritten += chunk.length;
      });

      pipeline(audioStream, decoder, aggregatedOut, (err) => {
        streamActive = false;
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          console.error(`Pipeline error for ${user?.displayName || user?.user.tag}:`, err);
        }
        console.log(`📊 Total bytes written for ${user?.displayName || user?.user.tag}: ${(bytesWritten / 1024).toFixed(2)} KB`);
        
        // Clear flush interval for this user
        const flushInterval = recordingData.flushIntervals?.get(userId);
        if (flushInterval) {
          clearInterval(flushInterval);
          recordingData.flushIntervals.delete(userId);
        }
      });

      // Periodic flush to ensure data is written to disk (critical for long recordings)
      const flushInterval = setInterval(() => {
        if (streamActive && !aggregatedOut.destroyed) {
          // Force flush by corking and uncorking
          aggregatedOut.cork();
          setImmediate(() => {
            if (!aggregatedOut.destroyed) {
              aggregatedOut.uncork();
              console.log(`💾 Flushed stream for ${user?.displayName || user?.user.tag} (${(bytesWritten / 1024).toFixed(2)} KB total)`);
            }
          });
        } else {
          clearInterval(flushInterval);
          recordingData.flushIntervals?.delete(userId);
        }
      }, STREAM_FLUSH_INTERVAL_MS);

      recordingData.audioStreams.set(userId, {
        user,
        files: [], // legacy field retained for backward compatibility
        persistent: true,
        aggregatedPath,
        stream: audioStream,
        writeStream: aggregatedOut,
        decoder: decoder,
        startTime: Date.now(),
      });

      recordingData.flushIntervals?.set(userId, flushInterval);
    });

    // Monitor voice state changes to handle users leaving the channel
    const voiceStateHandler = async (oldState, newState) => {
      // Only process if recording is still active
      if (!activeRecordings.has(guildId)) return;
      
      const userId = newState.id;
      const leftChannel = oldState.channelId === voiceChannel.id && newState.channelId !== voiceChannel.id;
      
      if (leftChannel && recordingData.audioStreams.has(userId)) {
        console.log(`👋 User ${newState.member?.displayName || userId} left the voice channel, finalizing their recording...`);
        await finalizeUserRecording(guildId, userId, recordingData);
      }
    };

    recordingData.voiceStateHandler = voiceStateHandler;
    voiceChannel.guild.client.on('voiceStateUpdate', voiceStateHandler);

    await interaction.editReply({
      content: `✅ Started recording in ${voiceChannel.name}! Use /record stop when finished.`,
    });
  } catch (error) {
    console.error('Error starting recording:', error);
    if (interaction.deferred) {
      await interaction.editReply({
        content: '❌ Failed to start recording. Make sure the bot has proper permissions.',
      }).catch(console.error);
    } else {
      await interaction.followUp({ content: '❌ Failed to start recording.' }).catch(console.error);
    }
  }
}

async function stopRecording(interaction, voiceChannel) {
  const guildId = voiceChannel.guild.id;
  
  // Check for active connection first (more reliable than Map after restarts)
  const connection = getVoiceConnection(guildId);
  const recordingData = activeRecordings.get(guildId);

  if (!connection && !recordingData) {
    if (interaction.deferred) {
      return interaction.editReply({ content: '❌ No active recording in this server!' });
    }
    return interaction.reply({ content: '❌ No active recording in this server!', ephemeral: true });
  }

  // Provide stopping status
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content: '🔄 Stopping recording...' }).catch(console.error);
  } else {
    await interaction.followUp({ content: '🔄 Stopping recording...' }).catch(console.error);
  }

  try {
    // Remove voice state listener
    if (recordingData && recordingData.voiceStateHandler) {
      voiceChannel.guild.client.removeListener('voiceStateUpdate', recordingData.voiceStateHandler);
      recordingData.voiceStateHandler = null;
    }

    // Properly finalize all active streams before destroying connection
    if (recordingData && recordingData.audioStreams.size > 0) {
      console.log(`🔄 Finalizing ${recordingData.audioStreams.size} active stream(s)...`);
      
      // Stop all flush intervals first
      if (recordingData.flushIntervals) {
        recordingData.flushIntervals.forEach(interval => clearInterval(interval));
        recordingData.flushIntervals.clear();
      }

      // Gracefully close all streams
      const closePromises = [];
      for (const [userId, streamData] of recordingData.audioStreams.entries()) {
        const { writeStream, stream: audioStream, user } = streamData;
        
        closePromises.push(
          new Promise((resolve) => {
            if (writeStream && !writeStream.destroyed) {
              // Ensure all data is flushed
              writeStream.end(() => {
                console.log(`✅ Closed stream for ${user?.displayName || user?.user.tag || userId}`);
                resolve();
              });
              // Force close after timeout to prevent hanging
              setTimeout(() => {
                if (!writeStream.destroyed) {
                  writeStream.destroy();
                  resolve();
                }
              }, 2000);
            } else {
              resolve();
            }
          })
        );
      }

      // Wait for all streams to close, with timeout
      await Promise.race([
        Promise.all(closePromises),
        new Promise(resolve => setTimeout(resolve, 3000)), // max 3s wait
      ]);
      
      console.log('✅ All streams finalized');
    }

    // Destroy connection if it exists
    if (connection) {
      connection.destroy();
    }

    const duration = recordingData 
      ? Math.floor((Date.now() - recordingData.startTime) / 1000) 
      : 0;
    const recordingsDir = path.join(process.cwd(), 'recordings', guildId);

    // Clean up from Map
    activeRecordings.delete(guildId);

    if (interaction.deferred) {
      await interaction.editReply({
        content: `⏹️ Recording stopped! Duration: ${duration}s\n📁 Processing recordings...`,
      }).catch(console.error);
    } else {
      await interaction.followUp({
        content: `⏹️ Recording stopped! Duration: ${duration}s\n📁 Processing recordings...`,
      }).catch(console.error);
    }

    // Process recordings with transcription and summarization
    if (recordingData && recordingData.audioStreams.size > 0) {
      setTimeout(async () => {
        try {
          await processRecordings(guildId, recordingData, interaction);
        } catch (error) {
          console.error('Error processing recordings:', error);
          await interaction.followUp({
            content: '❌ Error processing recordings.',
          }).catch(console.error);
        }
      }, FINAL_FLUSH_DELAY_MS); // Wait for writes to flush
    } else {
      await interaction.followUp({
        content: '📭 No audio was captured during this recording session.',
      }).catch(console.error);
    }
  } catch (error) {
    console.error('Error stopping recording:', error);
    if (interaction.deferred) {
      await interaction.editReply({
        content: '❌ Failed to stop recording properly.',
      }).catch(console.error);
    } else {
      await interaction.followUp({ content: '❌ Failed to stop recording properly.' }).catch(console.error);
    }
  }
}

async function processRecordings(guildId, recordingData, interaction) {
  const recordingsDir = path.join(process.cwd(), 'recordings', guildId);
  const userRecordings = Array.from(recordingData.audioStreams.entries());

  if (userRecordings.length === 0) {
    return interaction.followUp({
      content: '📭 No audio was captured during this recording session.',
    });
  }

  let allTranscriptions = '';
  let successfulProcessing = 0;
  let failedProcessing = 0;

  for (const [userId, record] of userRecordings) {
    const { user, files = [], persistent, aggregatedPath, startTime } = record;
    try {
      const userDisplayName = user?.displayName || user?.user?.tag || userId;
      
      // Persistent mode: we have a single aggregated file
      let useAggregatedDirectly = false;
      if (persistent && aggregatedPath && existsSync(aggregatedPath)) {
        // Verify file is not empty and is readable
        const { size } = await stat(aggregatedPath).catch(() => ({ size: 0 }));
        if (size > 0) {
          useAggregatedDirectly = true;
          const recordingDuration = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
          console.log(`✅ Found recording for ${userDisplayName}: ${(size / 1024).toFixed(2)} KB (${recordingDuration}s)`);
        } else {
          console.warn(`⚠️ Empty recording file for ${userDisplayName}, skipping`);
          continue;
        }
      }

      if (!useAggregatedDirectly && files.length === 0) {
        console.log(`ℹ️ No recordings for ${userDisplayName}`);
        continue;
      }

      // Merge all PCM files for this user into one
      const mergedPcmPath = useAggregatedDirectly
        ? aggregatedPath
        : path.join(recordingsDir, `user_${userId}_merged.pcm`);
      const mergedMp3Path = path.join(recordingsDir, `user_${userId}_merged.mp3`);

      // Concatenate all PCM files
      const pcmPaths = useAggregatedDirectly
        ? [aggregatedPath]
        : files.map(f => f.filePath).filter(p => existsSync(p));

      if (pcmPaths.length === 0) continue;

      // Merge PCM files by concatenating binary data
      if (!useAggregatedDirectly) {
        console.log(`🔄 Merging ${pcmPaths.length} recording(s) for ${user?.displayName || user?.user.tag || userId}...`);
      } else {
        console.log(`🔄 Using aggregated recording for ${user?.displayName || user?.user.tag || userId}`);
      }
      
      if (!useAggregatedDirectly) {
        if (pcmPaths.length === 1) {
          const data = await readFile(pcmPaths[0]);
          await writeFile(mergedPcmPath, data);
        } else {
          await writeFile(mergedPcmPath, Buffer.alloc(0));
          for (const pcmPath of pcmPaths) {
            const data = await readFile(pcmPath);
            await appendFile(mergedPcmPath, data);
          }
        }
      }

      console.log(`✅ Merged ${pcmPaths.length} recordings for ${user?.displayName || user?.user.tag || userId}`);

      // Check merged file size
      const { size: mergedSize } = await stat(mergedPcmPath);
      console.log(`📊 Merged PCM file size: ${(mergedSize / 1024).toFixed(2)} KB`);

      if (mergedSize === 0) {
        console.error('⚠️ Merged file is empty, skipping conversion');
        await interaction.followUp({
          content: `⚠️ No audio data for ${user?.displayName || 'Unknown'}`,
        });
        continue;
      }

      // Convert merged PCM to MP3
      try {
        console.log(`🔄 Converting to MP3 for ${userDisplayName}...`);
        
        // Calculate reasonable timeout based on file size
        // Large files need more time: ~500ms per MB of PCM, minimum 90s, max 10 minutes
        const mergedSizeMB = mergedSize / (1024 * 1024);
        const timeoutMs = Math.floor(Math.max(90000, Math.min(600000, mergedSizeMB * 500)));
        
        console.log(`⏱️ FFmpeg timeout set to ${(timeoutMs / 1000).toFixed(1)}s for ${mergedSizeMB.toFixed(2)} MB file`);
        
        const { stdout, stderr } = await execAsync(
          `"${resolvedFfmpegPath}" -y -f s16le -ar 48000 -ac 2 -i "${mergedPcmPath}" -b:a ${MP3_BITRATE_K}k "${mergedMp3Path}"`,
          { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 } // larger buffer for stderr
        );
        
        if (stderr && stderr.includes('error')) {
          console.warn('FFmpeg warnings:', stderr);
        }
        
        // Verify MP3 was created and is not empty
        const { size: mp3Size } = await stat(mergedMp3Path).catch(() => ({ size: 0 }));
        if (mp3Size === 0) {
          throw new Error('MP3 conversion produced empty file');
        }
        
        console.log(`✅ Converted to MP3: ${(mp3Size / 1024).toFixed(2)} KB`);

        // Send the MP3 file
        // await interaction.followUp({
        //   content: `🎵 Recording from ${user?.displayName || 'Unknown'} (${useAggregatedDirectly ? 'aggregated stream' : pcmPaths.length + ' segment' + (pcmPaths.length > 1 ? 's' : '')})`,
        //   files: [mergedMp3Path],
        // });

        // Decide whether to transcribe whole file or proactively chunk based on file size
        const { size: mp3Bytes } = await stat(mergedMp3Path).catch(() => ({ size: 0 }));
        const mp3MB = mp3Bytes / (1024 * 1024);
        const shouldChunkProactively = mp3MB > PROACTIVE_CHUNK_MB;

        let transcription = '';
        if (shouldChunkProactively) {
          console.log(`🔪 Proactively chunking audio (~${mp3MB.toFixed(2)} MB > ${PROACTIVE_CHUNK_MB} MB)...`);
          const chunks = await splitAudioIntoChunks(mergedMp3Path, recordingsDir, userId, DEFAULT_CHUNK_SECONDS);
          if (chunks.length > 0) {
            for (let i = 0; i < chunks.length; i++) {
              const chunkPath = chunks[i];
              const partText = await transcribeAudio(chunkPath);
              if (partText) {
                transcription += partText + '\n';
              } else {
                console.warn(`⚠️ Transcription failed for chunk #${i + 1}`);
              }
              await unlink(chunkPath).catch(console.error);
            }
            transcription = transcription.trim();
          } else {
            console.warn('⚠️ No chunks were produced for proactive transcription; attempting whole-file transcription.');
            transcription = await transcribeAudio(mergedMp3Path);
          }
        } else {
          // Transcribe the audio (with chunked fallback on network errors)
          transcription = await transcribeAudio(mergedMp3Path);
          if (!transcription) {
            console.log('⚠️ Full-file transcription failed. Attempting chunked transcription fallback...');
            const chunks = await splitAudioIntoChunks(mergedMp3Path, recordingsDir, userId, DEFAULT_CHUNK_SECONDS);
            if (chunks.length > 0) {
              let combined = '';
              for (let i = 0; i < chunks.length; i++) {
                const chunkPath = chunks[i];
                const partText = await transcribeAudio(chunkPath);
                if (partText) {
                  combined += partText + '\n';
                } else {
                  console.warn(`⚠️ Transcription failed for chunk #${i + 1}`);
                }
                // Clean up chunk as we go
                await unlink(chunkPath).catch(console.error);
              }
              transcription = combined.trim();
            } else {
              console.warn('⚠️ No chunks were produced for fallback transcription.');
            }
          }
        }

        if (transcription) {
          allTranscriptions += `**${user?.displayName || 'Unknown'}:**\n${transcription}\n\n`;
        }

        // Clean up PCM files
        if (!useAggregatedDirectly) {
          for (const { filePath } of files) {
            await unlink(filePath).catch(console.error);
          }
          await unlink(mergedPcmPath).catch(console.error);
        } else {
          // In aggregated mode, remove the source aggregated PCM now that we have MP3
          await unlink(aggregatedPath).catch(console.error);
        }
      } catch (conversionError) {
        console.error(`Error converting merged recording:`, conversionError);
        failedProcessing++;
        await interaction.followUp({
          content: `⚠️ Could not convert recording from ${user?.displayName || 'Unknown'}`,
        });
        // Continue to next user instead of stopping
        continue;
      }
      
      successfulProcessing++;
    } catch (error) {
      console.error(`Error processing recordings for user ${userId}:`, error);
      failedProcessing++;
      // Continue to next user
    }
  }

  // Log processing summary
  console.log(`📊 Processing complete: ${successfulProcessing} successful, ${failedProcessing} failed`);

  // Send transcriptions and summary even if some recordings failed
  if (allTranscriptions) {
    // const chunks = splitMessage(allTranscriptions, 1950); // Leave room for "📝 **Transcription:**\n" prefix
    // for (let i = 0; i < chunks.length; i++) {
    //   const prefix = i === 0 ? '📝 **Transcription:**\n' : '📝 **Transcription (continued):**\n';
    //   await interaction.followUp({
    //     content: `${prefix}${chunks[i]}`,
    //   });
    // }

    // Generate and send summary
    try {
      const summary = await summarizeText(allTranscriptions);
      if (summary) {
        // Split summary into chunks if it's too long
        const summaryChunks = splitMessage(summary, 1950); // Leave room for "📊 **Summary:**\n" prefix
        for (let i = 0; i < summaryChunks.length; i++) {
          const prefix = i === 0 ? '📊 **Summary:**\n' : '📊 **Summary (continued):**\n';
          await interaction.followUp({
            content: `${prefix}${summaryChunks[i]}`,
          });
        }
      } else {
        await interaction.followUp({
          content: '⚠️ Could not generate summary.',
        });
      }
    } catch (summaryError) {
      console.error('Error generating summary:', summaryError);
      await interaction.followUp({
        content: '⚠️ Error generating summary.',
      });
    }
  } else if (failedProcessing > 0) {
    await interaction.followUp({
      content: `⚠️ All ${failedProcessing} recording(s) failed to process. No transcriptions available.`,
    });
  } else {
    await interaction.followUp({
      content: '⚠️ No transcription could be generated from the recordings.',
    });
  }
}

function splitMessage(text, maxLength = 2000) {
  const chunks = [];
  let currentChunk = '';

  const lines = text.split('\n');
  for (const line of lines) {
    // If a single line is longer than maxLength, split it by words
    if (line.length > maxLength) {
      // First, add current chunk if it has content
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      
      // Split long line by words
      const words = line.split(' ');
      let tempLine = '';
      for (const word of words) {
        if ((tempLine + word + ' ').length > maxLength) {
          if (tempLine) {
            chunks.push(tempLine.trim());
            tempLine = word + ' ';
          } else {
            // Single word longer than maxLength, force split
            chunks.push(word.substring(0, maxLength));
            tempLine = word.substring(maxLength) + ' ';
          }
        } else {
          tempLine += word + ' ';
        }
      }
      if (tempLine) {
        currentChunk = tempLine.trim() + '\n';
      }
    } else if ((currentChunk + line + '\n').length > maxLength) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = line + '\n';
    } else {
      currentChunk += line + '\n';
    }
  }

  if (currentChunk) chunks.push(currentChunk.trim());
  return chunks;
}

// Finalize a single user's recording (called when they leave or when stopping)
async function finalizeUserRecording(guildId, userId, recordingData) {
  const streamData = recordingData.audioStreams.get(userId);
  if (!streamData) return;

  const { writeStream, stream: audioStream, user, decoder } = streamData;

  // Clear flush interval for this user
  const flushInterval = recordingData.flushIntervals?.get(userId);
  if (flushInterval) {
    clearInterval(flushInterval);
    recordingData.flushIntervals.delete(userId);
  }

  // Gracefully close the write stream
  return new Promise((resolve) => {
    if (writeStream && !writeStream.destroyed) {
      writeStream.end(() => {
        console.log(`✅ Finalized recording for ${user?.displayName || user?.user?.tag || userId}`);
        resolve();
      });
      // Force close after timeout to prevent hanging
      setTimeout(() => {
        if (!writeStream.destroyed) {
          writeStream.destroy();
          resolve();
        }
      }, 2000);
    } else {
      resolve();
    }
  });
}

// Split an audio file into smaller chunks to avoid large upload failures
async function splitAudioIntoChunks(inputPath, recordingsDir, userId, segmentSeconds = 120) {
  try {
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outPattern = path.join(recordingsDir, `${baseName}_part_%03d.mp3`);

    console.log(`🔪 Segmenting audio into ~${segmentSeconds}s chunks for user ${userId}...`);
    // Use ffmpeg segment muxer; reset timestamps for each part
  const cmd = `"${resolvedFfmpegPath}" -y -i "${inputPath}" -c copy -f segment -segment_time ${segmentSeconds} -reset_timestamps 1 "${outPattern}"`;
  const { stderr } = await execAsync(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    if (stderr) console.log('FFmpeg segment output:', stderr);

    // Collect produced chunks (part_000.mp3, part_001.mp3, ...). We'll probe up to 999 just in case.
    const produced = [];
    for (let i = 0; i < 999; i++) {
      const candidate = path.join(recordingsDir, `${baseName}_part_${String(i).padStart(3, '0')}.mp3`);
      if (existsSync(candidate)) produced.push(candidate);
      else if (i > 0) break; // stop when first missing after at least one found
    }
    console.log(`✅ Created ${produced.length} chunk(s) for transcription fallback.`);
    return produced;
  } catch (err) {
    console.error('Error segmenting audio for chunked transcription:', err);
    return [];
  }
}
