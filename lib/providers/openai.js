const { GeminiError } = require('../errors');
const { guardStream } = require('../stream-guard');

const MAX_TOOL_ITERATIONS = Number(process.env.ACPTOAPI_MAX_TOOL_ITERATIONS) || 50;

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

function _isThinkingModeRejectsForcedToolChoiceError(text) {
  return /tool_choice/i.test(text) && /thinking/i.test(text);
}
function _isForcedToolChoice(tc) {
  return tc === 'required' || !!(tc && typeof tc === 'object' && tc.type === 'required');
}

function _isGoBackendAnthropicToolChoiceUnmarshalError(text) {
  return /anthropic/i.test(text) && /tool_choice/i.test(text) && /unmarshal/i.test(text);
}

const _forcedToolChoiceRejectedByModelCache = new Set();
function _capabilityKey(url, model) { return `${url}::${model}`; }

const _SEED_FORCED_TOOL_CHOICE_REJECTING_MODEL_IDS = [
  'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3.2',
  'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7', 'kimi-k3',
  'glm-5', 'ep-gmv4flash', 'ep-zz2xjij6',
];
function _isSeededForcedToolChoiceRejectingModel(model) {
  return _SEED_FORCED_TOOL_CHOICE_REJECTING_MODEL_IDS.some(id => model && model.includes(id));
}

async function callOpenAI({ url, apiKey, headers, body }) {
  const timeoutMs = Number(process.env.OPENAI_COMPAT_TIMEOUT_MS || 180000);
  const doFetch = (b) => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, ...(headers || {}) },
    body: JSON.stringify(b),
    signal: AbortSignal.timeout(timeoutMs) });

  const capKey = _capabilityKey(url, body.model);
  if (_isForcedToolChoice(body.tool_choice) && (_forcedToolChoiceRejectedByModelCache.has(capKey) || _isSeededForcedToolChoiceRejectingModel(body.model))) {
    return doFetch({ ...body, tool_choice: 'auto' });
  }

  const res = await doFetch(body);
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 400 && _isForcedToolChoice(body.tool_choice) && _isThinkingModeRejectsForcedToolChoiceError(t)) {
      _forcedToolChoiceRejectedByModelCache.add(capKey);
      const retryRes = await doFetch({ ...body, tool_choice: 'auto' });
      if (retryRes.ok) return retryRes;
      const retryText = await retryRes.text();
      throw new GeminiError(retryText, { status: retryRes.status, retryable: retryRes.status === 429 || retryRes.status >= 500, headers: retryRes.headers });
    }
    if (res.status === 400 && _isForcedToolChoice(body.tool_choice) && _isGoBackendAnthropicToolChoiceUnmarshalError(t)) {
      const retryRes = await doFetch({ ...body, tool_choice: { type: 'any' } });
      if (retryRes.ok) return retryRes;
      const retryText = await retryRes.text();
      throw new GeminiError(retryText, { status: retryRes.status, retryable: retryRes.status === 429 || retryRes.status >= 500, headers: retryRes.headers });
    }
    if (res.status >= 500) {
      const retryRes = await doFetch(body);
      if (retryRes.ok) return retryRes;
      const retryText = await retryRes.text();
      throw new GeminiError(retryText, { status: retryRes.status, retryable: retryRes.status === 429 || retryRes.status >= 500, headers: retryRes.headers });
    }
    if (res.status === 400 && (body.max_tokens != null || body.max_completion_tokens != null)) {
      const { isPromptLengthReservationError, stripMaxTokens } = require('../model-token-limits');
      if (isPromptLengthReservationError(t)) {
        const retryRes = await doFetch(stripMaxTokens(body));
        if (retryRes.ok) return retryRes;
        const retryText = await retryRes.text();
        throw new GeminiError(retryText, { status: retryRes.status, retryable: retryRes.status === 429 || retryRes.status >= 500, headers: retryRes.headers });
      }
    }
    throw new GeminiError(t, { status: res.status, retryable: res.status === 429 || res.status >= 500, headers: res.headers });
  }
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

function stripAnthropicOnlyKeys(body) {
  const { thinking, ...rest } = body;
  return rest;
}

async function* streamOpenAI({ url, apiKey, headers, body, tools, onStepFinish, streamGuard }) {
  body = stripAnthropicOnlyKeys(body);
  let iterations = 0;
  while (true) {
    if (++iterations > MAX_TOOL_ITERATIONS) {
      yield { type: 'error', error: new GeminiError(`tool-call loop exceeded MAX_TOOL_ITERATIONS (${MAX_TOOL_ITERATIONS})`, { retryable: false }) };
      yield { type: 'finish-step', finishReason: 'error' };
      if (onStepFinish) await onStepFinish();
      return;
    }
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
    if (Array.isArray(tools)) {
      for (const tc of pending) {
        let args; try { args = JSON.parse(tc.args || '{}'); } catch { args = {}; }
        yield { type: 'tool-call', toolCallId: tc.id, toolName: tc.name, args };
      }
      yield { type: 'finish-step', finishReason: 'tool-calls' };
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
  body = stripAnthropicOnlyKeys(body);
  let iterations = 0;
  while (true) {
    if (++iterations > MAX_TOOL_ITERATIONS) throw new GeminiError(`tool-call loop exceeded MAX_TOOL_ITERATIONS (${MAX_TOOL_ITERATIONS})`, { retryable: false });
    const res = await callOpenAI({ url, apiKey, headers, body: { ...body, stream: false } });
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new GeminiError('No message in response', { retryable: false });
    if (!msg.tool_calls?.length) return { text: msg.content || '', response: data };
    if (Array.isArray(tools)) {
      const parsedToolCalls = msg.tool_calls.map(tc => {
        let args; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
        return { toolCallId: tc.id, toolName: tc.function?.name, args };
      });
      return { text: msg.content || '', tool_calls: parsedToolCalls, response: data };
    }
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
