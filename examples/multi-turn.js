/**
 * multi-turn.js — Multi-turn conversation (chat history) example
 *
 * Usage:
 *   GEMINI_API_KEY=your-key node examples/multi-turn.js
 */
const { generateGemini } = require('../index');

async function chat(history, userMessage, options = {}) {
  history.push({ role: 'user', content: userMessage });
  const result = await generateGemini({ messages: history, ...options });
  history.push({ role: 'assistant', content: result.text });
  return result.text;
}

async function main() {
  const history = [];
  const opts = {
    model: 'gemini-2.0-flash',
    system: 'You are a knowledgeable astronomy tutor. Keep answers brief.',
    temperature: 0.4
  };

  console.log('=== Multi-turn conversation ===\n');

  let reply = await chat(history, 'What is a black hole?', opts);
  console.log('User: What is a black hole?');
  console.log('Assistant:', reply, '\n');

  reply = await chat(history, 'How does one form?', opts);
  console.log('User: How does one form?');
  console.log('Assistant:', reply, '\n');

  reply = await chat(history, 'Can anything escape from it?', opts);
  console.log('User: Can anything escape from it?');
  console.log('Assistant:', reply, '\n');

  reply = await chat(history, 'Summarize our conversation so far in bullet points.', opts);
  console.log('User: Summarize our conversation so far in bullet points.');
  console.log('Assistant:', reply, '\n');

  console.log(`Total turns: ${history.length / 2}`);
}

main().catch(console.error);
