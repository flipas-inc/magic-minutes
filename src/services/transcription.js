import OpenAI from 'openai';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { config } from 'dotenv';

config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 2,
  timeout: 120000, // default per-request timeout (ms)
});

/**
 * Transcribe audio file using OpenAI Whisper API
 * @param {string} filePath - Path to the audio file
 * @returns {Promise<string>} - Transcribed text
 */
export async function transcribeAudio(filePath) {
  const { size } = await stat(filePath).catch(() => ({ size: 0 }));
  const sizeMB = (size / (1024 * 1024)).toFixed(2);
  console.log(`🎯 Transcribing: ${filePath} (${sizeMB} MB)`);

  const maxAttempts = 3;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      // Create a fresh stream each attempt
      const stream = createReadStream(filePath, { highWaterMark: 256 * 1024 }); // 256KB chunks
      const transcription = await openai.audio.transcriptions.create(
        {
          file: stream,
          model: 'whisper-1',
          response_format: 'text',
        },
        {
          timeout: 120000, // 120s per attempt
        }
      );

      console.log(`✅ Transcription complete`);
      return transcription;
    } catch (error) {
      // Detailed diagnostics
      console.error(`Error transcribing audio (attempt ${attempt}/${maxAttempts}):`, error);

      const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']);
      const isTransient =
        transientCodes.has(error?.code) ||
        error?.status >= 500 ||
        error?.name === 'APIConnectionError' ||
        error?.type === 'api_connection_error' ||
        error?.status === undefined; // often network layer

      if (!isTransient || attempt >= maxAttempts) {
        if (error?.status === 401) {
          console.error('❌ Authentication error - check your OPENAI_API_KEY in .env');
        } else if (error?.status === 429) {
          console.error('❌ Rate limit exceeded - too many requests to OpenAI API');
        } else if (error?.code === 'ENOTFOUND') {
          console.error('❌ DNS resolution failed - cannot reach OpenAI servers');
        }
        return null;
      }

      // Backoff before retry
      const delayMs = Math.min(4000, 1000 * 2 ** (attempt - 1));
      console.log(`⏳ Retrying transcription in ${delayMs}ms...`);
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  return null;
}
