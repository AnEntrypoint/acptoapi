/**
 * tool-use.js — Tool/function calling with generateGemini and streamGemini
 *
 * Usage:
 *   GEMINI_API_KEY=your-key node examples/tool-use.js
 */
const { generateGemini, streamGemini } = require('../index');

const tools = {
  get_weather: {
    description: 'Get the current weather for a given city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'The city name' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature unit' }
      },
      required: ['city']
    },
    execute: async ({ city, unit = 'celsius' }) => {
      // Simulated weather data
      return { city, temperature: 22, unit, condition: 'Sunny' };
    }
  },
  calculate: {
    description: 'Evaluate a simple math expression.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Math expression to evaluate, e.g. "2 + 2"' }
      },
      required: ['expression']
    },
    execute: async ({ expression }) => {
      try {
        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + expression + ')')();
        return { result };
      } catch {
        return { error: 'Invalid expression' };
      }
    }
  }
};

async function nonStreamingExample() {
  console.log('=== Non-streaming tool use ===');
  const result = await generateGemini({
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: "What's the weather in Tokyo and what is 17 * 43?" }],
    tools
  });
  console.log('Final answer:', result.text);
}

async function streamingExample() {
  console.log('\n=== Streaming tool use ===');
  const { fullStream } = streamGemini({
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'What is 100 / 4? Use the calculator.' }],
    tools
  });

  for await (const event of fullStream) {
    if (event.type === 'tool-call') console.log(`[tool-call] ${event.toolName}(${JSON.stringify(event.args)})`);
    if (event.type === 'tool-result') console.log(`[tool-result] ${JSON.stringify(event.result)}`);
    if (event.type === 'text-delta') process.stdout.write(event.textDelta);
    if (event.type === 'finish-step') console.log(`\n[finish] reason=${event.finishReason}`);
  }
}

async function main() {
  await nonStreamingExample();
  await streamingExample();
}

main().catch(console.error);
