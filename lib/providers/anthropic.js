const { BridgeError } = require('../errors');

function convertMessages(messages) {
  const result = [];
  for (const m of messages) {
    if (typeof m.content === 'string') { result.push({ role: m.role, content: m.content }); continue; }
    if (!Array.isArray(m.content)) continue;
    const toolResults = m.content.filter(b => b.type === 'tool_result');
    if (toolResults.length) {
      result.push({ role: 'user', content: toolResults.map(b => ({ type: 'tool_result', tool_use_id: b.tool_use_id || b.id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '') })) });
      continue;
    }
    const blocks = [];
    for (const b of m.content) {
      if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
      if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || {} });
    }
    if (blocks.length) result.push({ role: m.role, content: blocks });
  }
  return result;
}

function convertTools(tools) {
  if (!tools || typeof tools !== 'object') return undefined;
  const list = Object.entries(tools).map(([name, t]) => ({
    name, description: t.description || '',
    input_schema: t.parameters?.jsonSchema || t.parameters || { type: 'object', properties: {}, required: [] }
  }));
  return list.length ? list : undefined;
}

const STOP_REASON_MAP = { end_turn: 'stop', tool_use: 'tool-calls', max_tokens: 'stop' };

async function* readerIterable(reader) {
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    yield dec.decode(value, { stream: true });
  }
}

async function* streamAnthropic({ apiKey, model, messages, system, tools, temperature, maxOutputTokens, onStepFinish }) {
  const convertedTools = convertTools(tools);
  let currentMessages = convertMessages(messages);

  while (true) {
    yield { type: 'start-step' };
    const body = { model, messages: currentMessages, max_tokens: maxOutputTokens || 4096, stream: true };
    if (system) body.system = system;
    if (temperature != null) body.temperature = temperature;
    if (convertedTools) body.tools = convertedTools;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) { const t = await res.text(); throw new BridgeError(t, { status: res.status, retryable: res.status === 429 || res.status >= 500 }); }

    const reader = res.body.getReader();
    let buf = '', toolBlockMap = {}, toolArgsMap = {}, assistantBlocks = [];

    try {
      for await (const text of readerIterable(reader)) {
        buf += text;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6).trim();
          let ev; try { ev = JSON.parse(d); } catch { continue; }
          const t = ev.type;
          if (t === 'content_block_start') {
            const { index, content_block } = ev;
            if (content_block.type === 'tool_use') {
              toolBlockMap[index] = { id: content_block.id, name: content_block.name };
              toolArgsMap[index] = '';
              assistantBlocks.push({ type: 'tool_use', id: content_block.id, name: content_block.name, input: {} });
            } else if (content_block.type === 'text') {
              assistantBlocks.push({ type: 'text', text: '' });
            }
          } else if (t === 'content_block_delta') {
            const { index, delta } = ev;
            if (delta.type === 'text_delta') {
              yield { type: 'text-delta', textDelta: delta.text };
              const last = assistantBlocks[assistantBlocks.length - 1];
              if (last?.type === 'text') last.text += delta.text;
            } else if (delta.type === 'input_json_delta') {
              toolArgsMap[index] = (toolArgsMap[index] || '') + delta.partial_json;
            }
          } else if (t === 'content_block_stop') {
            const tb = toolBlockMap[ev.index];
            if (tb) {
              let args; try { args = JSON.parse(toolArgsMap[ev.index] || '{}'); } catch { args = {}; }
              const block = assistantBlocks.find(b => b.type === 'tool_use' && b.id === tb.id);
              if (block) block.input = args;
            }
          } else if (t === 'message_delta') {
            const finishReason = STOP_REASON_MAP[ev.delta?.stop_reason] || 'stop';
            const pending = Object.values(toolBlockMap);
            if (!pending.length) {
              yield { type: 'finish-step', finishReason };
              if (onStepFinish) await onStepFinish();
              return;
            }
            const toolResultBlocks = [];
            for (const tb of pending) {
              const idx = Object.keys(toolBlockMap).find(k => toolBlockMap[k] === tb);
              let args; try { args = JSON.parse(toolArgsMap[idx] || '{}'); } catch { args = {}; }
              const toolDef = tools?.[tb.name];
              let result = toolDef ? null : { error: true, message: 'Tool not found: ' + tb.name };
              if (toolDef?.execute) try { result = await toolDef.execute(args, { toolCallId: tb.id }); } catch(e) { result = { error: true, message: e.message }; }
              yield { type: 'tool-call', toolCallId: tb.id, toolName: tb.name, args };
              yield { type: 'tool-result', toolCallId: tb.id, toolName: tb.name, args, result };
              toolResultBlocks.push({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result ?? '') });
            }
            yield { type: 'finish-step', finishReason };
            if (onStepFinish) await onStepFinish();
            currentMessages = [...currentMessages, { role: 'assistant', content: assistantBlocks }, { role: 'user', content: toolResultBlocks }];
            toolBlockMap = {}; toolArgsMap = {}; assistantBlocks = [];
          }
        }
      }
    } finally { reader.releaseLock(); }
  }
}

module.exports = { streamAnthropic, convertMessages, convertTools };
