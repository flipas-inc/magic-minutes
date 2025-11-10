import OpenAI from 'openai';
import { config } from 'dotenv';

config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Summarize transcribed text using OpenAI GPT API
 * @param {string} text - Text to summarize
 * @returns {Promise<string>} - Summary
 */
export async function summarizeText(text) {
  try {
    console.log('📝 Generating summary...');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that creates concise summaries of voice chat transcriptions. Focus on key points, decisions made, and action items.',
        },
        {
          role: 'user',
          content: `Please summarize the following voice chat transcription:\n\n${text}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    const summary = response.choices[0].message.content;
    console.log('✅ Summary generated');
    return summary;
  } catch (error) {
    console.error('Error generating summary:', error.message);
    return null;
  }
}
