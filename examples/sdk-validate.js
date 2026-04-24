const Anthropic = require('@anthropic-ai/sdk').default;

const client = new Anthropic({
  apiKey: 'placeholder',
  baseURL: process.env.THEBIRD_URL || 'http://localhost:3456',
});

async function main() {
  process.stdout.write('[streaming] ');
  const stream = client.messages.stream({
    model: 'gemini-2.5-flash',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Say exactly: thebird works' }],
  });
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      process.stdout.write(ev.delta.text);
    }
  }
  process.stdout.write('\n');

  process.stdout.write('[non-streaming] ');
  const msg = await client.messages.create({
    model: 'gemini-2.5-flash',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Say exactly: thebird works' }],
  });
  console.log(msg.content[0].text);
}

main().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
