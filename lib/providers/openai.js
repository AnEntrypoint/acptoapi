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

// A "thinking"/reasoning model (several models behind auto-discovered
// extra-providers.js aggregator endpoints) rejects a FORCED tool_choice
// outright with an HTTP 400 naming "thinking" explicitly -- distinct from
// every other tool_choice-adjacent failure this codebase has hit (a plain
// unsupported-shape error, e.g. the reverted "tool_choice.type must be
// function, got required" bug, never mentions "thinking" -- this predicate
// requires BOTH words so it cannot re-trigger that class). Live-verified
// against the real endpoint: the SAME model that rejects tool_choice:'required'
// outright with this specific error accepts tool_choice:'auto' fine and still
// makes a real tool call when the situation warrants one -- these models are
// not broken for tool use, only for the FORCED variant. Casey's own
// tool_choice:'required' is an ITERATION-0-ONLY weak-model nudge (a hint the
// model is free to ignore); a model that outright REJECTS the request has no
// way to honor that nudge regardless, so downgrading to 'auto' for exactly
// this failure shape loses nothing the forced choice could have delivered
// anyway, while a model that merely ignores 'required' (accepts it, just
// doesn't call a tool) never enters this path at all -- its 2xx response
// never reaches the retry branch, so its own (working) nudge behavior is
// completely unaffected.
function _isThinkingToolChoiceError(text) {
  return /tool_choice/i.test(text) && /thinking/i.test(text);
}
function _isForcedToolChoice(tc) {
  return tc === 'required' || !!(tc && typeof tc === 'object' && tc.type === 'required');
}

// Process-lifetime capability map: which (url, model) pairs are known to
// REJECT a forced tool_choice outright (a "thinking"/reasoning model 400ing
// with an explicit "thinking mode" error, distinct from every other
// tool_choice-adjacent failure this codebase handles). This exists on top of
// the same-request retry below, not instead of it -- live-witnessed: the
// retry-on-error approach alone was correct in isolation (a doomed forced
// attempt + a slow reasoning-heavy retry both succeed) but a real casey
// conversation turn regularly lost the RACE against acptoapi's own per-link
// chain timeout (chain-machine.js DEFAULT_LINK_TIMEOUT_MS, 10s default):
// the first (fast-failing, ~0.5s) forced attempt plus the second
// (reasoning-heavy, 5-25s+ for these models) retry together routinely
// exceeded 10s combined, so the chain killed the link as a timeout/error
// before the working retry could ever return -- even though the retry
// itself, given enough time, always succeeded. Once a model has been
// caught rejecting a forced choice, every SUBSequent call for that same
// (url, model) skips straight to 'auto' on the FIRST attempt: no wasted
// doomed request, no doubled latency, and the model's own real (slow but
// working) response time is the only latency the chain timeout has to
// tolerate. Deliberately in-memory/per-process, not persisted to disk --
// this is a fast-learning cache for the CURRENT run, not a claim about a
// model's capability that should outlive a restart; a restarted process
// simply re-learns it on the model's next forced-choice rejection, which
// is cheap (one extra 400 the very first time, never again this process).
const _thinkingModeModels = new Set();
function _capabilityKey(url, model) { return `${url}::${model}`; }

// A small, best-effort SEED of model ids directly confirmed (live, against
// real endpoints) to reject a forced tool_choice with the "thinking mode"
// 400 -- pre-populates the learning cache above so even the FIRST real
// request for one of these bare model ids (any base URL) skips the doomed
// forced attempt, closing the timeout-race gap _thinkingModeModels alone
// leaves on a fresh process (first call still pays the race until it
// learns). Matched by bare model id substring, not full capability key,
// since the same underlying model is commonly re-served behind different
// aggregator base URLs with the same id. Deliberately small and
// non-exhaustive -- this is a head start, not a substitute for the live
// learning path above, which still catches every id not listed here.
const _KNOWN_THINKING_MODEL_IDS = [
  'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3.2',
  'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7', 'kimi-k3',
  'glm-5', 'ep-gmv4flash', 'ep-zz2xjij6',
];
function _seedKnownThinkingModel(model) {
  return _KNOWN_THINKING_MODEL_IDS.some(id => model && model.includes(id));
}

async function callOpenAI({ url, apiKey, headers, body }) {
  const timeoutMs = Number(process.env.OPENAI_COMPAT_TIMEOUT_MS || 180000);
  const doFetch = (b) => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, ...(headers || {}) },
    body: JSON.stringify(b),
    signal: AbortSignal.timeout(timeoutMs) });

  const capKey = _capabilityKey(url, body.model);
  if (_isForcedToolChoice(body.tool_choice) && (_thinkingModeModels.has(capKey) || _seedKnownThinkingModel(body.model))) {
    return doFetch({ ...body, tool_choice: 'auto' });
  }

  const res = await doFetch(body);
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 400 && _isForcedToolChoice(body.tool_choice) && _isThinkingToolChoiceError(t)) {
      // Learn it now so every later call to this (url, model) this process
      // skips the doomed forced attempt entirely -- see _thinkingModeModels above.
      _thinkingModeModels.add(capKey);
      // One retry, same model, tool_choice downgraded to 'auto' -- never a
      // second retry, never applied to any other error shape or status code.
      const retryRes = await doFetch({ ...body, tool_choice: 'auto' });
      if (retryRes.ok) return retryRes;
      const retryText = await retryRes.text();
      throw new GeminiError(retryText, { status: retryRes.status, retryable: retryRes.status === 429 || retryRes.status >= 500, headers: retryRes.headers });
    }
    // A bare 5xx from an aggregator backend (live-witnessed against
    // tokenhun.shadw.app: "RUNTIME_TUNNEL_FAILED" plain-text 502, no JSON
    // body) is commonly a brief tunnel/gateway hiccup on a genuinely GOOD
    // model, not the model itself being broken -- directly confirmed: 3 of 4
    // models hit with this exact error recovered instantly on an immediate
    // retry moments later. Without a same-model retry, chain-machine.js's own
    // fallback-to-NEXT-model behavior burns a perfectly healthy model's
    // chain slot on a one-off infrastructure blip instead of just trying it
    // again. One immediate retry, same model and same tool_choice (unlike
    // the thinking-mode branch above, a 5xx says nothing about tool_choice
    // compatibility) -- never a second retry, never applied to a 4xx (a
    // client-shaped error retrying the identical request will only fail the
    // identical way).
    if (res.status >= 500) {
      const retryRes = await doFetch(body);
      if (retryRes.ok) return retryRes;
      const retryText = await retryRes.text();
      throw new GeminiError(retryText, { status: retryRes.status, retryable: retryRes.status === 429 || retryRes.status >= 500, headers: retryRes.headers });
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
