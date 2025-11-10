import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFile } from 'fs/promises';
import { stat } from 'fs/promises';
import { config } from 'dotenv';

config();

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

/**
 * Transcribe audio file using Google Gemini API
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
      const audioData = await readFile(filePath);
      const base64Audio = audioData.toString('base64');

      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

      const result = await model.generateContent([
        {
          inlineData: {
            mimeType: 'audio/ogg',
            data: base64Audio,
          },
        },
        { text: 'Please transcribe this audio file. Provide only the transcription text without any additional commentary.' },
      ]);

      const response = await result.response;
      const transcription = response.text();

      console.log(`✅ Transcription complete`);
      return transcription;
    } catch (error) {
      console.error(`Error transcribing audio (attempt ${attempt}/${maxAttempts}):`, error);

      const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']);
      const isTransient =
        transientCodes.has(error?.code) ||
        error?.status >= 500 ||
        error?.name === 'APIConnectionError' ||
        error?.type === 'api_connection_error' ||
        error?.status === undefined;

      if (!isTransient || attempt >= maxAttempts) {
        if (error?.status === 401 || error?.message?.includes('API key')) {
          console.error('❌ Authentication error - check your GOOGLE_API_KEY in .env');
        } else if (error?.status === 429) {
          console.error('❌ Rate limit exceeded - too many requests to Google API');
        } else if (error?.code === 'ENOTFOUND') {
          console.error('❌ DNS resolution failed - cannot reach Google servers');
        }
        return null;
      }

      const delayMs = Math.min(4000, 1000 * 2 ** (attempt - 1));
      console.log(`⏳ Retrying transcription in ${delayMs}ms...`);
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  return null;
}
