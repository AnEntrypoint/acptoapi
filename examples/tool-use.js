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
      // Safe arithmetic-only evaluator. Whitelists digits, decimals, whitespace,
      // and + - * / ( ). Anything else → reject. No Function/eval.
      if (typeof expression !== 'string' || !/^[\d+\-*/().\s]+$/.test(expression)) {
        return { error: 'Invalid expression' };
      }
      try {
        const tokens = expression.match(/\d+(?:\.\d+)?|[+\-*/()]/g) || [];
        let pos = 0;
        const peek = () => tokens[pos];
        const eat = () => tokens[pos++];
        const parseExpr = () => {
          let left = parseTerm();
          while (peek() === '+' || peek() === '-') { const op = eat(); const right = parseTerm(); left = op === '+' ? left + right : left - right; }
          return left;
        };
        const parseTerm = () => {
          let left = parseFactor();
          while (peek() === '*' || peek() === '/') { const op = eat(); const right = parseFactor(); left = op === '*' ? left * right : left / right; }
          return left;
        };
        const parseFactor = () => {
          const t = eat();
          if (t === '(') { const v = parseExpr(); if (eat() !== ')') throw new Error('paren'); return v; }
          if (t === '-') return -parseFactor();
          if (t === '+') return parseFactor();
          const n = Number(t);
          if (!Number.isFinite(n)) throw new Error('num');
          return n;
        };
        const result = parseExpr();
        if (pos !== tokens.length) throw new Error('trailing');
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
