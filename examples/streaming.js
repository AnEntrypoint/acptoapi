/**
 * streaming.js — Streaming with all event types demonstrated
 *
 * Usage:
 *   GEMINI_API_KEY=your-key node examples/streaming.js
 */
const { streamGemini } = require('../index');

const tools = {
  get_time: {
    description: 'Get the current time in a timezone.',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA timezone name, e.g. America/New_York' }
      },
      required: ['timezone']
    },
    execute: async ({ timezone }) => {
      const now = new Date().toLocaleString('en-US', { timeZone: timezone });
      return { timezone, time: now };
    }
  }
};

async function main() {
  console.log('Streaming all event types:\n');

  const { fullStream } = streamGemini({
    model: 'gemini-2.0-flash',
    system: 'You are a helpful assistant. Be concise.',
    messages: [
      { role: 'user', content: "What time is it in Tokyo and New York right now?" }
    ],
    tools,
    temperature: 0.3,
    maxOutputTokens: 512,
    onStepFinish: async () => {
      console.log('\n[step finished]');
    }
  });

  const stats = { steps: 0, toolCalls: 0, chars: 0 };

  for await (const event of fullStream) {
    switch (event.type) {
      case 'start-step':
        stats.steps++;
        console.log(`\n[start-step #${stats.steps}]`);
        break;

      case 'text-delta':
        stats.chars += event.textDelta.length;
        process.stdout.write(event.textDelta);
        break;

      case 'tool-call':
        stats.toolCalls++;
        console.log(`\n[tool-call] id=${event.toolCallId} name=${event.toolName}`);
        console.log('  args:', JSON.stringify(event.args));
        break;

      case 'tool-result':
        console.log(`[tool-result] id=${event.toolCallId} name=${event.toolName}`);
        console.log('  result:', JSON.stringify(event.result));
        break;

      case 'finish-step':
        console.log(`\n[finish-step] reason=${event.finishReason}`);
        break;

      case 'error':
        console.error('\n[error]', event.error.message);
        break;
    }
  }

  console.log(`\n\nStats: ${stats.steps} steps, ${stats.toolCalls} tool calls, ${stats.chars} chars`);
}

main().catch(console.error);
