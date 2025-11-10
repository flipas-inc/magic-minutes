import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  EndBehaviorType,
  getVoiceConnection,
} from '@discordjs/voice';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';
import prism from 'prism-media';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { transcribeAudio } from '../services/transcription.js';
import { summarizeText } from '../services/summarization.js';

const pipelineAsync = promisify(pipeline);

// Store active recordings
const activeRecordings = new Map();

export async function handleVoiceCommand(interaction) {
  const action = interaction.options.getString('action');
  const member = interaction.member;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
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
    return interaction.reply({
      content: '❌ Already recording in this server!',
      ephemeral: true,
    });
  }

  await interaction.deferReply();

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
      console.log(`🎤 ${user?.user.tag || userId} started speaking`);

      const audioStream = connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 100,
        },
      });

      const oggStream = new prism.opus.OggLogicalBitstream({
        opusHead: new prism.opus.OpusHead({
          channelCount: 2,
          sampleRate: 48000,
        }),
        pageSizeControl: {
          maxPackets: 10,
        },
      });

      const timestamp = Date.now();
      const filename = `user_${userId}_${timestamp}.ogg`;
      const recordingsDir = path.join(process.cwd(), 'recordings', guildId);

      // Ensure directory exists
      if (!existsSync(recordingsDir)) {
        mkdir(recordingsDir, { recursive: true });
      }

      const filePath = path.join(recordingsDir, filename);
      const out = createWriteStream(filePath);

      pipeline(audioStream, oggStream, out, (err) => {
        if (err) {
          console.error(`Error recording ${user?.user.tag}:`, err);
        } else {
          console.log(`✅ Saved recording: ${filename}`);
        }
      });

      recordingData.audioStreams.set(userId, { filename, filePath, user });
    });

    await interaction.editReply({
      content: `✅ Started recording in ${voiceChannel.name}! Use \`/record stop\` when finished.`,
    });
  } catch (error) {
    console.error('Error starting recording:', error);
    await interaction.editReply({
      content: '❌ Failed to start recording. Make sure the bot has proper permissions.',
    });
  }
}

async function stopRecording(interaction, voiceChannel) {
  const guildId = voiceChannel.guild.id;
  const recordingData = activeRecordings.get(guildId);

  if (!recordingData) {
    return interaction.reply({
      content: '❌ No active recording in this server!',
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  try {
    const connection = getVoiceConnection(guildId);
    if (connection) {
      connection.destroy();
    }

    const duration = Math.floor((Date.now() - recordingData.startTime) / 1000);
    const recordingsDir = path.join(process.cwd(), 'recordings', guildId);

    activeRecordings.delete(guildId);

    await interaction.editReply({
      content: `⏹️ Recording stopped! Duration: ${duration}s\n📁 Processing recordings...`,
    });

    // Process recordings with transcription and summarization
    setTimeout(async () => {
      try {
        await processRecordings(guildId, recordingData, interaction);
      } catch (error) {
        console.error('Error processing recordings:', error);
        await interaction.followUp({
          content: '❌ Error processing recordings.',
        });
      }
    }, 2000); // Wait 2 seconds for files to be fully written
  } catch (error) {
    console.error('Error stopping recording:', error);
    await interaction.editReply({
      content: '❌ Failed to stop recording properly.',
    });
  }
}

async function processRecordings(guildId, recordingData, interaction) {
  const recordingsDir = path.join(process.cwd(), 'recordings', guildId);
  const audioFiles = Array.from(recordingData.audioStreams.values());

  if (audioFiles.length === 0) {
    return interaction.followUp({
      content: '📭 No audio was captured during this recording session.',
    });
  }

  let allTranscriptions = '';

  for (const { filePath, user, filename } of audioFiles) {
    try {
      if (existsSync(filePath)) {
        await interaction.followUp({
          content: `🎵 Recording from ${user?.user.tag || 'Unknown'}`,
          files: [filePath],
        });

        // Transcribe the audio
        const transcription = await transcribeAudio(filePath);
        if (transcription) {
          allTranscriptions += `**${user?.user.tag || 'Unknown'}:**\n${transcription}\n\n`;
        }
      }
    } catch (error) {
      console.error(`Error processing ${filename}:`, error);
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
