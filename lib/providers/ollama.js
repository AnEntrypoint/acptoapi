const { BridgeError } = require('../errors');
const { randomUUID } = require('crypto');

function convertMessages(messages, system) {
  const result = [];
  if (system) result.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') { result.push({ role: m.role, content: m.content }); continue; }
    if (!Array.isArray(m.content)) continue;
    const toolResults = m.content.filter(b => b.type === 'tool_result');
    if (toolResults.length) {
      for (const b of toolResults) {
        const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
        result.push({ role: 'tool', content: c });
      }
      continue;
    }
    const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('');
    result.push({ role: m.role, content: text });
  }
  return result;
}

function convertTools(tools) {
  if (!tools || typeof tools !== 'object') return undefined;
  const list = Object.entries(tools).map(([name, t]) => ({
    type: 'function', function: { name, description: t.description || '',
      parameters: t.parameters?.jsonSchema || t.parameters || { type: 'object' } }
  }));
  return list.length ? list : undefined;
}

async function* streamOllama({ url, model, messages, system, tools, temperature, maxOutputTokens, onStepFinish }) {
  const base = (url || process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  let msgs = convertMessages(messages, system);
  const ollamaTools = convertTools(tools);

  while (true) {
    yield { type: 'start-step' };
    const body = { model, messages: msgs, stream: true };
    if (ollamaTools) body.tools = ollamaTools;
    if (temperature != null || maxOutputTokens != null) {
      body.options = {};
      if (temperature != null) body.options.temperature = temperature;
      if (maxOutputTokens != null) body.options.num_predict = maxOutputTokens;
    }

    const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      if (res.status === 404) throw new BridgeError('Model not found: ' + model, { retryable: false });
      const t = await res.text();
      throw new BridgeError(t, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const pendingToolCalls = [];
    let finishReason = 'stop';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk; try { chunk = JSON.parse(line); } catch { continue; }
          if (chunk.message?.content) yield { type: 'text-delta', textDelta: chunk.message.content };
          if (chunk.message?.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              const id = randomUUID();
              const args = tc.function.args || tc.function.arguments || {};
              pendingToolCalls.push({ id, name: tc.function.name, args });
              yield { type: 'tool-call', toolCallId: id, toolName: tc.function.name, args };
            }
          }
          if (chunk.done) finishReason = chunk.done_reason === 'length' ? 'length' : 'stop';
        }
      }
    } finally { reader.releaseLock(); }

    if (!pendingToolCalls.length) {
      yield { type: 'finish-step', finishReason };
      if (onStepFinish) await onStepFinish();
      return;
    }

    const toolResultMsgs = [];
    for (const tc of pendingToolCalls) {
      const toolDef = tools?.[tc.name];
      let result = toolDef ? null : { error: true, message: 'Tool not found: ' + tc.name };
      if (toolDef?.execute) try { result = await toolDef.execute(tc.args, { toolCallId: tc.id }); } catch(e) { result = { error: true, message: e.message }; }
      yield { type: 'tool-result', toolCallId: tc.id, toolName: tc.name, args: tc.args, result };
      toolResultMsgs.push({ role: 'tool', content: JSON.stringify(result ?? '') });
    }
    yield { type: 'finish-step', finishReason: 'tool-calls' };
    if (onStepFinish) await onStepFinish();
    msgs = [...msgs,
      { role: 'assistant', content: '', tool_calls: pendingToolCalls.map(tc => ({ function: { name: tc.name, arguments: tc.args } })) },
      ...toolResultMsgs
    ];
  }
}

module.exports = { streamOllama };
