import OpenAI from 'openai';
import { createReadStream } from 'fs';
import { config } from 'dotenv';

config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Transcribe audio file using OpenAI Whisper API
 * @param {string} filePath - Path to the audio file
 * @returns {Promise<string>} - Transcribed text
 */
export async function transcribeAudio(filePath) {
  try {
    console.log(`🎯 Transcribing: ${filePath}`);

    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(filePath),
      model: 'whisper-1',
      language: 'en', // You can change this or make it dynamic
      response_format: 'text',
    });

    console.log(`✅ Transcription complete`);
    return transcription;
  } catch (error) {
    console.error('Error transcribing audio:', error.message);
    return null;
  }
}
