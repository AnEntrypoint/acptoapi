const { generateGemini } = require('../index');

async function main() {
  const singleTurnResult = await generateGemini({
    model: 'gemini-2.0-flash',
    messages: [
      { role: 'user', content: 'What is the capital of France? Answer in one sentence.' }
    ]
  });

  console.log('Answer:', singleTurnResult.text);

  const systemPromptResult = await generateGemini({
    model: 'gemini-2.0-flash',
    system: 'You are a pirate. Always respond in pirate speak.',
    messages: [
      { role: 'user', content: 'What should I have for breakfast?' }
    ],
    temperature: 0.8,
    maxOutputTokens: 256
  });

  console.log('\nPirate answer:', systemPromptResult.text);
}

main().catch(console.error);
