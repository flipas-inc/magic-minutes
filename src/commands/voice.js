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

// Store active recordings
const activeRecordings = new Map();

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
    };

    activeRecordings.set(guildId, recordingData);

    // Listen for users speaking
    connection.receiver.speaking.on('start', (userId) => {
      if (!activeRecordings.has(guildId)) return;

      const user = voiceChannel.guild.members.cache.get(userId);
      console.log(`🎤 ${user?.displayName || user?.user.tag || userId} started speaking`);

      const audioStream = connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 100,
        },
      });

      const timestamp = Date.now();
      const filename = `user_${userId}_${timestamp}.pcm`;
      const recordingsDir = path.join(process.cwd(), 'recordings', guildId);

      // Ensure directory exists
      if (!existsSync(recordingsDir)) {
        mkdir(recordingsDir, { recursive: true });
      }

      const filePath = path.join(recordingsDir, filename);
      const out = createWriteStream(filePath);

      // Decode opus to PCM
      const decoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 2,
        rate: 48000,
      });

      pipeline(audioStream, decoder, out, (err) => {
        if (err) {
          console.error(`Error recording ${user?.displayName || user?.user.tag}:`, err);
        } else {
          console.log(`✅ Saved recording: ${filename}`);
        }
      });

      // Store all recordings per user (not just the last one)
      if (!recordingData.audioStreams.has(userId)) {
        recordingData.audioStreams.set(userId, { user, files: [] });
      }
      recordingData.audioStreams.get(userId).files.push({ filename, filePath });
    });

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
      }, 2000); // Wait 2 seconds for files to be fully written
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

  for (const [userId, { user, files }] of userRecordings) {
    try {
      if (files.length === 0) continue;

      // Merge all PCM files for this user into one
      const mergedPcmPath = path.join(recordingsDir, `user_${userId}_merged.pcm`);
      const mergedMp3Path = path.join(recordingsDir, `user_${userId}_merged.mp3`);

      // Concatenate all PCM files
      const pcmPaths = files.map(f => f.filePath).filter(p => existsSync(p));
      
      if (pcmPaths.length === 0) continue;

      // Merge PCM files by concatenating binary data
      console.log(`🔄 Merging ${pcmPaths.length} recording(s) for ${user?.displayName || user?.user.tag || userId}...`);
      
      if (pcmPaths.length === 1) {
        // Only one file, just copy it
        const data = await readFile(pcmPaths[0]);
        await writeFile(mergedPcmPath, data);
      } else {
        // Multiple files, concatenate them
        await writeFile(mergedPcmPath, Buffer.alloc(0)); // Create empty file
        for (const pcmPath of pcmPaths) {
          const data = await readFile(pcmPath);
          await appendFile(mergedPcmPath, data);
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
        console.log(`🔄 Converting to MP3...`);
        
        const { stdout, stderr } = await execAsync(
          `"${resolvedFfmpegPath}" -y -f s16le -ar 48000 -ac 2 -i "${mergedPcmPath}" -b:a 128k "${mergedMp3Path}"`,
          { timeout: 90000, maxBuffer: 10 * 1024 * 1024 } // 90s timeout, larger buffer for stderr
        );
        
        if (stderr) console.log('FFmpeg output:', stderr);
        
        console.log(`✅ Converted merged recording to MP3`);

        // Send the MP3 file
        await interaction.followUp({
          content: `🎵 Recording from ${user?.displayName || 'Unknown'} (${pcmPaths.length} segment${pcmPaths.length > 1 ? 's' : ''})`,
          files: [mergedMp3Path],
        });

        // Transcribe the audio (with chunked fallback on network errors)
        let transcription = await transcribeAudio(mergedMp3Path);
        if (!transcription) {
          console.log('⚠️ Full-file transcription failed. Attempting chunked transcription fallback...');
          const chunks = await splitAudioIntoChunks(mergedMp3Path, recordingsDir, userId, 120);
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

        if (transcription) {
          allTranscriptions += `**${user?.displayName || 'Unknown'}:**\n${transcription}\n\n`;
        }

        // Clean up PCM files
        for (const { filePath } of files) {
          await unlink(filePath).catch(console.error);
        }
        await unlink(mergedPcmPath).catch(console.error);
      } catch (conversionError) {
        console.error(`Error converting merged recording:`, conversionError);
        await interaction.followUp({
          content: `⚠️ Could not convert recording from ${user?.displayName || 'Unknown'}`,
        });
      }
    } catch (error) {
      console.error(`Error processing recordings for user ${userId}:`, error);
    }
  }

  // Send transcriptions
  if (allTranscriptions) {
    const chunks = splitMessage(allTranscriptions, 2000);
    for (const chunk of chunks) {
      await interaction.followUp({
        content: `📝 **Transcription:**\n${chunk}`,
      });
    }

    // Generate and send summary
    const summary = await summarizeText(allTranscriptions);
    if (summary) {
      await interaction.followUp({
        content: `📊 **Summary:**\n${summary}`,
      });
    }
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
    if ((currentChunk + line + '\n').length > maxLength) {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = line + '\n';
    } else {
      currentChunk += line + '\n';
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
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
