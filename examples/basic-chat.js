/**
 * basic-chat.js — Simple single-turn and multi-turn chat using generateGemini
 *
 * Usage:
 *   GEMINI_API_KEY=your-key node examples/basic-chat.js
 */
const { generateGemini } = require('../index');

async function main() {
  // Single-turn: ask a simple question
  const result = await generateGemini({
    model: 'gemini-2.0-flash',
    messages: [
      { role: 'user', content: 'What is the capital of France? Answer in one sentence.' }
    ]
  });

  console.log('Answer:', result.text);

  // With a system prompt
  const result2 = await generateGemini({
    model: 'gemini-2.0-flash',
    system: 'You are a pirate. Always respond in pirate speak.',
    messages: [
      { role: 'user', content: 'What should I have for breakfast?' }
    ],
    temperature: 0.8,
    maxOutputTokens: 256
  });

  console.log('\nPirate answer:', result2.text);
}

main().catch(console.error);
