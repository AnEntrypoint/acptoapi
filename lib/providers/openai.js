const { GeminiError } = require('../errors');
const { guardStream } = require('../stream-guard');

function convertMessages(messages, system) {
  const result = [];
  if (system) result.push({ role: 'system', content: typeof system === 'string' ? system : JSON.stringify(system) });
  for (const m of messages) {
    if (typeof m.content === 'string') { result.push({ role: m.role, content: m.content }); continue; }
    if (!Array.isArray(m.content)) continue;
    const toolCalls = m.content.filter(b => b.type === 'tool_use');
    const toolResults = m.content.filter(b => b.type === 'tool_result');
    if (toolResults.length) {
      for (const b of toolResults) {
        const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
        result.push({ role: 'tool', tool_call_id: b.tool_use_id || b.id || b.name, content: c });
      }
      continue;
    }
    const textParts = m.content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (toolCalls.length) {
      result.push({ role: 'assistant', content: textParts || null,
        tool_calls: toolCalls.map(b => ({ id: b.id || ('call_' + Math.random().toString(36).slice(2,8)), type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) } })) });
    } else {
      result.push({ role: m.role, content: textParts });
    }
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

async function callOpenAI({ url, apiKey, headers, body }) {
  const res = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, ...(headers || {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000) });
  if (!res.ok) { const t = await res.text(); throw new GeminiError(t, { status: res.status, retryable: res.status === 429 || res.status >= 500, headers: res.headers }); }
  return res;
}

async function* readerIterable(reader) {
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    yield dec.decode(value, { stream: true });
  }
}

async function* streamOpenAI({ url, apiKey, headers, body, tools, onStepFinish, streamGuard }) {
  while (true) {
    yield { type: 'start-step' };
    const res = await callOpenAI({ url, apiKey, headers, body: { ...body, stream: true } });
    const reader = res.body.getReader();
    let buf = '', toolCallsMap = {};
    try {
      for await (const text of guardStream(readerIterable(reader), streamGuard)) {
        buf += text;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6).trim();
          if (d === '[DONE]') break;
          let chunk; try { chunk = JSON.parse(d); } catch { continue; }
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) yield { type: 'text-delta', textDelta: delta.content };
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap[idx]) toolCallsMap[idx] = { id: tc.id || '', name: '', args: '' };
              if (tc.id) toolCallsMap[idx].id = tc.id;
              if (tc.function?.name) toolCallsMap[idx].name += tc.function.name;
              if (tc.function?.arguments) toolCallsMap[idx].args += tc.function.arguments;
            }
          }
        }
      }
    } finally { reader.releaseLock(); }

    const pending = Object.values(toolCallsMap);
    if (!pending.length) {
      yield { type: 'finish-step', finishReason: 'stop' };
      if (onStepFinish) await onStepFinish();
      return;
    }
    const toolResultMsgs = [];
    for (const tc of pending) {
      let args; try { args = JSON.parse(tc.args || '{}'); } catch { args = {}; }
      const toolDef = tools?.[tc.name];
      let result = toolDef ? null : { error: true, message: 'Tool not found: ' + tc.name };
      if (toolDef?.execute) try { result = await toolDef.execute(args, { toolCallId: tc.id }); } catch(e) { result = { error: true, message: e.message }; }
      yield { type: 'tool-call', toolCallId: tc.id, toolName: tc.name, args };
      yield { type: 'tool-result', toolCallId: tc.id, toolName: tc.name, args, result };
      toolResultMsgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result ?? '') });
    }
    yield { type: 'finish-step', finishReason: 'tool-calls' };
    if (onStepFinish) await onStepFinish();
    body = { ...body, messages: [...body.messages,
      { role: 'assistant', content: null, tool_calls: pending.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })) },
      ...toolResultMsgs
    ]};
    toolCallsMap = {};
  }
}

async function generateOpenAI({ url, apiKey, headers, body, tools }) {
  while (true) {
    const res = await callOpenAI({ url, apiKey, headers, body: { ...body, stream: false } });
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new GeminiError('No message in response', { retryable: false });
    if (!msg.tool_calls?.length) return { text: msg.content || '', response: data };
    const toolResultMsgs = [];
    for (const tc of msg.tool_calls) {
      let args; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
      const toolDef = tools?.[tc.function?.name];
      let result = toolDef ? null : { error: true, message: 'Tool not found: ' + tc.function?.name };
      if (toolDef?.execute) try { result = await toolDef.execute(args); } catch(e) { result = { error: true, message: e.message }; }
      toolResultMsgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result ?? '') });
    }
    body = { ...body, messages: [...body.messages, msg, ...toolResultMsgs] };
  }
}

module.exports = { streamOpenAI, generateOpenAI, convertMessages, convertTools };
