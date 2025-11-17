import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from 'dotenv';

config();

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

/**
 * Summarize transcribed text using Google Gemini API
 * @param {string} text - Text to summarize
 * @returns {Promise<string>} - Summary
 */
export async function summarizeText(text) {
  try {
    console.log('📝 Generating summary...');

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `You are a helpful assistant that creates concise summaries of voice chat transcriptions from a team called Flipas that is currently working on two main projects: Sombra and Aurora. Focus on key points, decisions made, and action items.

Please summarize the following voice chat transcription:

${text}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const summary = response.text();

    console.log('✅ Summary generated');
    return summary;
  } catch (error) {
    console.error('Error generating summary:', error.message);
    return null;
  }
}
