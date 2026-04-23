import assert from 'assert';
import { createServer } from './lib/server.js';
import { splitModel, probe, resolveBackend } from './lib/acp-client.js';
import { openAIMessagesToACP, createEventMapper } from './lib/translate.js';
import { isClaudeModel, parseClaudeModel, probeClaude } from './lib/claude-client.js';
import { createClaudeMapper } from './lib/claude-translate.js';

console.log('=== acptoapi test ===\n');

assert.deepStrictEqual(splitModel('kilo/x-ai/grok-code-fast-1:optimized:free'), { prefix: 'kilo', model: 'x-ai/grok-code-fast-1:optimized:free' });
assert.deepStrictEqual(splitModel('opencode/minimax-m2.5-free'), { prefix: 'opencode', model: 'minimax-m2.5-free' });
assert.strictEqual(splitModel('raw-model').prefix, 'kilo');
console.log('✓ splitModel');

const prompt = openAIMessagesToACP([
  { role: 'system', content: 'be terse' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: 'who?' },
]);
assert(prompt.startsWith('be terse\n\n'));
assert(prompt.includes('User: hi'));
assert(prompt.includes('Assistant: hello'));
console.log('✓ openAIMessagesToACP');

const emitted = [];
const mapper = createEventMapper('id-x', 'm-x');
const t1 = mapper.mapEvent({ type: 'message.part.delta', properties: { field: 'text', delta: 'hello' } }, c => emitted.push(c));
assert.strictEqual(t1, false);
assert.strictEqual(emitted.length, 2);
assert.strictEqual(emitted[0].choices[0].delta.role, 'assistant');
assert.strictEqual(emitted[1].choices[0].delta.content, 'hello');
const t2 = mapper.mapEvent({ type: 'session.idle' }, () => {});
assert.strictEqual(t2, true);
console.log('✓ createEventMapper (delta + terminal)');

assert.strictEqual(isClaudeModel('claude/sonnet'), true);
assert.strictEqual(isClaudeModel('kilo/x'), false);
assert.strictEqual(parseClaudeModel('claude/haiku'), 'haiku');
assert.strictEqual(parseClaudeModel('claude'), 'sonnet');
console.log('✓ claude model parsing');

const cEmitted = [];
const cMapper = createClaudeMapper('id-c', 'claude/haiku');
cMapper.mapEvent({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }, c => cEmitted.push(c));
cMapper.mapEvent({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } }, c => cEmitted.push(c));
cMapper.mapEvent({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_X', name: 'Read', input: {} } } }, c => cEmitted.push(c));
cMapper.mapEvent({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file":"a"}' } } }, c => cEmitted.push(c));
const term = cMapper.mapEvent({ type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 10 } }, c => cEmitted.push(c));
assert(cEmitted.some(c => c.choices[0].delta.role === 'assistant'), 'role chunk emitted');
assert(cEmitted.some(c => c.choices[0].delta.content === 'hello'), 'text_delta mapped');
assert(cEmitted.some(c => c.choices[0].delta.tool_calls?.[0]?.id === 'toolu_X'), 'tool_use mapped');
assert(cEmitted.some(c => c.choices[0].delta.tool_calls?.[0]?.function?.arguments === '{"file":"a"}'), 'input_json_delta mapped');
assert.strictEqual(term.terminal, true);
assert.strictEqual(term.stop_reason, 'stop');
console.log('✓ createClaudeMapper (text + tool_use + result)');

const kiloBackend = resolveBackend('kilo');
const kiloUp = await probe(kiloBackend, 1500);
console.log(`kilo probe: ${kiloUp ? 'UP' : 'DOWN'}`);

if (kiloUp) {
  const { server, port } = await createServer({ port: 0 });
  const base = `http://127.0.0.1:${port}`;

  const models = await (await fetch(base + '/v1/models')).json();
  assert.strictEqual(models.object, 'list');
  assert(models.data.length > 0, 'expected model list');
  assert(models.data.some(m => m.id.startsWith('kilo/')));
  console.log('✓ /v1/models lists kilo models');

  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kilo/x-ai/grok-code-fast-1:optimized:free', messages: [{ role: 'user', content: 'reply with just: ok' }], stream: true }),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'text/event-stream');

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const chunks = [];
  let gotContent = '';
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') { buf = ''; break; }
      const c = JSON.parse(payload);
      chunks.push(c);
      if (c.choices?.[0]?.delta?.content) gotContent += c.choices[0].delta.content;
    }
    if (buf === '' && chunks.some(c => c.choices?.[0]?.finish_reason === 'stop')) break;
  }
  assert(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
  assert(gotContent.length > 0, `expected content, got: "${gotContent}"`);
  console.log(`✓ /v1/chat/completions streaming (${chunks.length} chunks, text: "${gotContent.slice(0, 60)}")`);

  server.close();
} else {
  console.log('⚠ skipping kilo live tests (start: kilo serve --port 4780)');
}

const claudeUp = await probeClaude();
console.log(`claude probe: ${claudeUp ? 'UP' : 'DOWN'}`);
if (claudeUp) {
  const { server, port } = await createServer({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude/haiku', messages: [{ role: 'user', content: 'reply with: ok' }], stream: true }),
  });
  assert.strictEqual(r.status, 200);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let chunks = 0;
  let sawFinish = false;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
      if (!line.startsWith('data: ')) continue;
      const p = line.slice(6);
      if (p === '[DONE]') { buf = ''; break; }
      const c = JSON.parse(p);
      chunks++;
      if (c.choices?.[0]?.delta?.content) content += c.choices[0].delta.content;
      if (c.choices?.[0]?.finish_reason) sawFinish = true;
    }
    if (sawFinish) break;
  }
  assert(chunks >= 2, `claude expected multiple chunks, got ${chunks}`);
  assert(content.length > 0, `claude expected content, got: "${content}"`);
  assert(sawFinish, 'claude expected finish_reason chunk');
  console.log(`✓ claude /v1/chat/completions streaming (${chunks} chunks, text: "${content.slice(0, 60).trim()}")`);
  server.close();
} else {
  console.log('⚠ skipping claude live tests (install claude CLI)');
}

console.log('\n=== all checks passed ===');
