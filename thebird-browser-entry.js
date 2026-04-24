const { getClient } = require('./lib/client.js');
const { GeminiError, withRetry } = require('./lib/errors.js');
const { convertMessages, convertTools, cleanSchema, extractModelId, buildConfig } = require('./lib/convert.js');

function streamGemini({ model, system, messages, tools, onStepFinish, apiKey, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities }) {
  return { fullStream: createFullStream({ model, system, messages, tools, onStepFinish, apiKey, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities }), warnings: Promise.resolve([]) };
}

async function* createFullStream({ model, system, messages, tools, onStepFinish, apiKey, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities }) {
  const client = getClient(apiKey);
  const modelId = extractModelId(model);
  let contents = convertMessages(messages);
  const { config } = buildConfig({ system, tools, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities });
  while (true) {
    yield { type: 'start-step' };
    try {
      const stream = await withRetry(() => client.models.generateContentStream({ model: modelId, contents, config }));
      const allParts = [];
      for await (const chunk of stream) {
        for (const candidate of (chunk.candidates || [])) {
          for (const part of (candidate.content?.parts || [])) {
            allParts.push(part);
            if (part.text && !part.thought) yield { type: 'text-delta', textDelta: part.text };
          }
        }
      }
      const fcParts = allParts.filter(p => p.functionCall);
      if (fcParts.length === 0) {
        yield { type: 'finish-step', finishReason: 'stop' };
        if (onStepFinish) await onStepFinish();
        return;
      }
      const toolResultParts = [];
      for (const part of fcParts) {
        const name = part.functionCall.name;
        const args = part.functionCall.args || {};
        const toolId = 'toolu_' + Math.random().toString(36).slice(2, 10);
        yield { type: 'tool-call', toolCallId: toolId, toolName: name, args };
        const toolDef = tools?.[name];
        let result = toolDef ? null : { error: true, message: 'Tool not found: ' + name };
        if (toolDef?.execute) {
          try { result = await toolDef.execute(args, { toolCallId: toolId }); }
          catch (e) { result = { error: true, message: e.message }; }
        }
        yield { type: 'tool-result', toolCallId: toolId, toolName: name, args, result };
        toolResultParts.push({ functionResponse: { name, response: typeof result === 'string' ? { output: result } : (result || {}) } });
      }
      yield { type: 'finish-step', finishReason: 'tool-calls' };
      if (onStepFinish) await onStepFinish();
      contents.push({ role: 'model', parts: allParts });
      contents.push({ role: 'user', parts: toolResultParts });
    } catch (err) {
      yield { type: 'error', error: err };
      yield { type: 'finish-step', finishReason: 'error' };
      if (onStepFinish) await onStepFinish();
      return;
    }
  }
}

async function generateGemini({ model, system, messages, tools, apiKey, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities }) {
  const client = getClient(apiKey);
  const modelId = extractModelId(model);
  let contents = convertMessages(messages);
  const { config } = buildConfig({ system, tools, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities });
  while (true) {
    const response = await withRetry(() => client.models.generateContent({ model: modelId, contents, config }));
    const candidate = response.candidates?.[0];
    if (!candidate) throw new GeminiError('No candidates returned', { retryable: false });
    const allParts = candidate.content?.parts || [];
    const fcParts = allParts.filter(p => p.functionCall);
    if (fcParts.length === 0) {
      const text = allParts.filter(p => p.text && !p.thought).map(p => p.text).join('');
      return { text, parts: allParts, response };
    }
    const toolResultParts = [];
    for (const part of fcParts) {
      const name = part.functionCall.name;
      const args = part.functionCall.args || {};
      const toolDef = tools?.[name];
      let result = toolDef ? null : { error: true, message: 'Tool not found: ' + name };
      if (toolDef?.execute) {
        try { result = await toolDef.execute(args); }
        catch (e) { result = { error: true, message: e.message }; }
      }
      toolResultParts.push({ functionResponse: { name, response: typeof result === 'string' ? { output: result } : (result || {}) } });
    }
    contents.push({ role: 'model', parts: allParts });
    contents.push({ role: 'user', parts: toolResultParts });
  }
}

function convertMessagesOAI(messages, system) {
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

function convertToolsOAI(tools) {
  if (!tools || typeof tools !== 'object') return undefined;
  const list = Object.entries(tools).map(([name, t]) => ({
    type: 'function', function: { name, description: t.description || '',
      parameters: t.parameters?.jsonSchema || t.parameters || { type: 'object' } }
  }));
  return list.length ? list : undefined;
}

async function* streamOpenAI({ url, apiKey, messages, system, model, tools, maxOutputTokens, temperature, onStepFinish }) {
  const oaiMsgs = convertMessagesOAI(messages, system);
  const oaiTools = convertToolsOAI(tools);
  let body = { messages: oaiMsgs, model, max_tokens: maxOutputTokens || 8192, temperature: temperature ?? 0.5 };
  if (oaiTools) body.tools = oaiTools;
  while (true) {
    yield { type: 'start-step' };
    const res = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ ...body, stream: true }) });
    if (!res.ok) { const t = await res.text(); throw new Error(t); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', toolCallsMap = {};
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
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

module.exports = { streamGemini, generateGemini, streamOpenAI };
