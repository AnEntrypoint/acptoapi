const { BridgeError } = require('../errors');
const { crypto } = globalThis;

function uid() {
  return 'msg_' + Math.random().toString(36).slice(2, 18);
}

function toParams(req) {
  const tools = {};
  if (Array.isArray(req.tools)) {
    for (const t of req.tools) {
      tools[t.name] = { description: t.description, parameters: t.input_schema };
    }
  }
  return {
    model: req.model,
    messages: req.messages,
    system: req.system,
    tools: Object.keys(tools).length ? tools : undefined,
    temperature: req.temperature,
    maxOutputTokens: req.max_tokens,
    url: req.url,
    apiKey: req.apiKey,
    headers: req.headers,
    body: req.body,
  };
}

function anthropic_image_block_to_openai_part(block) {
  const source = block && block.source;
  if (!source) return null;
  const stype = source.type;
  if (stype === 'base64') {
    const data = source.data;
    if (!data) return null;
    const media_type = source.media_type || 'image/jpeg';
    return { type: 'image_url', image_url: { url: 'data:' + media_type + ';base64,' + data } };
  }
  if (stype === 'url') {
    const url = source.url;
    if (!url) return null;
    return { type: 'image_url', image_url: { url } };
  }
  return null;
}

function anthropic_messages_to_openai(messages, system) {
  const result = [];
  if (system) {
    if (typeof system === 'string') {
      result.push({ role: 'system', content: system });
    } else if (Array.isArray(system)) {
      const parts = [];
      for (const block of system) {
        if (block && block.type === 'text') parts.push(block.text);
        else if (typeof block === 'string') parts.push(block);
      }
      if (parts.length) result.push({ role: 'system', content: parts.join('\n') });
    }
  }
  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;
    if (typeof content === 'string') {
      result.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const block of content) {
        const btype = block.type;
        if (btype === 'text') textParts.push(block.text);
        else if (btype === 'tool_use') {
          toolCalls.push({
            id: block.id, type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          });
        }
      }
      const msgDict = { role: 'assistant' };
      if (textParts.length) msgDict.content = textParts.join('\n');
      if (toolCalls.length) msgDict.tool_calls = toolCalls;
      result.push(msgDict);
      continue;
    }
    if (role === 'user') {
      const userParts = [];
      let hasImage = false;
      const toolResults = [];
      for (const block of content) {
        const btype = block.type;
        if (btype === 'text') userParts.push({ type: 'text', text: block.text });
        else if (btype === 'image') {
          const part = anthropic_image_block_to_openai_part(block);
          if (part) { userParts.push(part); hasImage = true; }
        } else if (btype === 'tool_result') {
          let tc = block.content;
          if (Array.isArray(tc)) tc = tc.filter(p => p && p.type === 'text').map(p => p.text).join(' ');
          toolResults.push({
            role: 'tool', tool_call_id: block.tool_use_id, content: String(tc || ''),
          });
        }
      }
      if (hasImage) {
        result.push({ role: 'user', content: userParts });
      } else {
        const text = userParts.filter(p => p.type === 'text').map(p => p.text).join('\n');
        if (text) result.push({ role: 'user', content: text });
      }
      for (const tr of toolResults) result.push(tr);
    }
  }
  return result;
}

function anthropic_tools_to_openai(tools) {
  const result = [];
  for (const t of tools) {
    if (!t.name || !t.input_schema) continue;
    result.push({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema },
    });
  }
  return result.length ? result : undefined;
}

function anthropic_tool_choice_to_openai(tc) {
  if (!tc || typeof tc !== 'object') return 'auto';
  const t = tc.type;
  if (t === 'auto') return 'auto';
  if (t === 'any') return 'required';
  if (t === 'none') return 'none';
  if (t === 'tool') return tc.name ? { type: 'function', function: { name: tc.name } } : 'auto';
  return 'auto';
}

function openai_finish_to_anthropic_stop(finish_reason, had_tool_calls) {
  if (finish_reason === 'length') return 'max_tokens';
  if (finish_reason === 'tool_calls' || had_tool_calls) return 'tool_use';
  if (finish_reason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

function toResponse(events) {
  let text = '';
  let reasoning = '';
  let stopReason = 'end_turn';
  const toolUses = [];
  for (const ev of events) {
    if (ev.type === 'text-delta') text += ev.textDelta;
    if (ev.type === 'reasoning-delta') reasoning += ev.reasoningDelta;
    if (ev.type === 'tool-call') toolUses.push({ type: 'tool_use', id: ev.toolCallId, name: ev.toolName, input: ev.args });
    if (ev.type === 'finish-step') {
      if (ev.finishReason === 'tool-calls') stopReason = 'tool_use';
      if (ev.finishReason === 'error') stopReason = 'error';
    }
  }
  const content = [];
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
  if (text) content.push({ type: 'text', text });
  for (const t of toolUses) content.push(t);
  return {
    id: uid(),
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function anthropic_tool_use_id(upstream_id) {
  if (upstream_id && typeof upstream_id === 'string' && upstream_id.startsWith('toolu_')) return upstream_id;
  return 'toolu_' + require('crypto').randomUUID().replace(/-/g, '').slice(0, 24);
}

function _message_delta_usage(usage) {
  usage = usage || {};
  return {
    input_tokens: usage.prompt_tokens || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: usage.completion_tokens || 0,
  };
}

class AnthropicPassthroughEmitter {
  constructor() {
    this.block_index = -1;
    this._current_block_type = null;
    this._tool_call_states = {};
    this._usage = {};
    this._stop_reason = 'end_turn';
    this._stop_sequence = null;
  }

  start(message_id, model, input_tokens) {
    return [{
      type: 'sse',
      raw: 'event: message_start\ndata: ' + JSON.stringify({
        type: 'message_start',
        message: {
          id: message_id, type: 'message', role: 'assistant', content: [],
          model, stop_reason: null, stop_sequence: null,
          usage: { input_tokens: input_tokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }) + '\n\n',
    }];
  }

  feed_chunk(chunk) {
    const events = [];
    const usage = chunk.usage;
    if (usage) this._usage = usage;
    const choices = chunk.choices || [];
    if (!choices.length) return events;
    const choice = choices[0];
    const delta = choice.delta || {};
    const finish_reason = choice.finish_reason;
    const content = delta.content;
    if (content) {
      if (this._current_block_type !== 'text') {
        if (this._current_block_type !== null) events.push(this._close_current_block());
        events.push(...this._open_text_block());
      }
      events.push({
        type: 'sse',
        raw: 'event: content_block_delta\ndata: ' + JSON.stringify({
          type: 'content_block_delta', index: this.block_index,
          delta: { type: 'text_delta', text: content },
        }) + '\n\n',
      });
    }
    const tool_calls = delta.tool_calls || [];
    for (const tc of tool_calls) {
      const tc_idx = tc.index || 0;
      const fn = tc.function || {};
      if (!(tc_idx in this._tool_call_states)) {
        if (this._current_block_type !== null) events.push(this._close_current_block());
        const tc_id = anthropic_tool_use_id(tc.id || '');
        const tc_name = fn.name || '';
        this.block_index += 1;
        this._current_block_type = 'tool_use';
        this._tool_call_states[tc_idx] = { block_index: this.block_index, id: tc_id, name: tc_name };
        events.push({
          type: 'sse',
          raw: 'event: content_block_start\ndata: ' + JSON.stringify({
            type: 'content_block_start', index: this.block_index,
            content_block: { type: 'tool_use', id: tc_id, name: tc_name, input: {} },
          }) + '\n\n',
        });
      }
      const args_delta = fn.arguments || '';
      if (args_delta) {
        events.push({
          type: 'sse',
          raw: 'event: content_block_delta\ndata: ' + JSON.stringify({
            type: 'content_block_delta', index: this._tool_call_states[tc_idx].block_index,
            delta: { type: 'input_json_delta', partial_json: args_delta },
          }) + '\n\n',
        });
      }
    }
    if (delta.reasoning_content) {
      if (this._current_block_type !== 'thinking') {
        if (this._current_block_type !== null) events.push(this._close_current_block());
        this.block_index += 1;
        this._current_block_type = 'thinking';
        events.push({
          type: 'sse',
          raw: 'event: content_block_start\ndata: ' + JSON.stringify({
            type: 'content_block_start', index: this.block_index,
            content_block: { type: 'thinking', thinking: '' },
          }) + '\n\n',
        });
      }
      events.push({
        type: 'sse',
        raw: 'event: content_block_delta\ndata: ' + JSON.stringify({
          type: 'content_block_delta', index: this.block_index,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        }) + '\n\n',
      });
    }
    if (finish_reason) {
      this._stop_reason = openai_finish_to_anthropic_stop(finish_reason);
    }
    return events;
  }

  finish() {
    const events = [];
    if (this._current_block_type !== null) events.push(this._close_current_block());
    events.push({
      type: 'sse',
      raw: 'event: message_delta\ndata: ' + JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: this._stop_reason, stop_sequence: this._stop_sequence },
        usage: _message_delta_usage(this._usage),
      }) + '\n\n',
    });
    events.push({
      type: 'sse',
      raw: 'event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n',
    });
    return events;
  }

  _open_text_block() {
    this.block_index += 1;
    this._current_block_type = 'text';
    return [{
      type: 'sse',
      raw: 'event: content_block_start\ndata: ' + JSON.stringify({
        type: 'content_block_start', index: this.block_index,
        content_block: { type: 'text', text: '' },
      }) + '\n\n',
    }];
  }

  _close_current_block() {
    const idx = this.block_index;
    this._current_block_type = null;
    return {
      type: 'sse',
      raw: 'event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: idx }) + '\n\n',
    };
  }
}

const SSE_HANDLERS = {
  'start-step': (ev, state) => {
    const id = uid();
    state.msgId = id;
    state.blockIndex = 0;
    const lines = [
      `event: message_start`,
      `data: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })}`,
      '',
    ];
    return lines.join('\n');
  },
  'text-delta': (ev, state) => {
    const parts = [];
    if (!state.textStarted) {
      state.textStarted = true;
      parts.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: state.blockIndex, content_block: { type: 'text', text: '' } })}\n`);
    }
    parts.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'text_delta', text: ev.textDelta } })}\n`);
    return parts.join('\n\n');
  },
  'tool-call': (ev, state) => {
    state.blockIndex += state.textStarted ? 1 : 0;
    state.textStarted = false;
    const idx = state.blockIndex++;
    return [
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: ev.toolCallId, name: ev.toolName, input: {} } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(ev.args) } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}`,
      '',
    ].join('\n\n');
  },
  'finish-step': (ev, state) => {
    const stopMap = { stop: 'end_turn', 'tool-calls': 'tool_use', error: 'error' };
    const stop_reason = stopMap[ev.finishReason] || 'end_turn';
    const parts = [];
    if (state.textStarted) {
      parts.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: state.blockIndex })}`);
      state.textStarted = false;
    }
    if (state.reasoningStarted) {
      parts.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: state.blockIndex })}`);
      state.reasoningStarted = false;
    }
    parts.push(
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 0 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    );
    return parts.join('\n\n');
  },
  'reasoning-delta': (ev, state) => {
    const parts = [];
    if (!state.reasoningStarted) {
      state.reasoningStarted = true;
      parts.push('event: content_block_start\ndata: ' + JSON.stringify({type:'content_block_start', index: state.blockIndex, content_block:{type:'thinking',thinking:''}}) + '\n');
    }
    parts.push('event: content_block_delta\ndata: ' + JSON.stringify({type:'content_block_delta', index: state.blockIndex, delta:{type:'thinking_delta', thinking: ev.reasoningDelta}}) + '\n');
    return parts.join('\n\n');
  },
  'error': (ev) => `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: ev.error?.message || 'unknown' } })}\n`,
};

function toSSE(event, state = {}) {
  const handler = SSE_HANDLERS[event.type];
  if (!handler) return '';
  return handler(event, state);
}

function openai_message_to_anthropic(msg) {
  const content = [];
  const text = msg.content || '';
  if (text) content.push({ type: 'text', text });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let args;
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: args });
    }
  }
  const stop_reason = openai_finish_to_anthropic_stop(msg.finish_reason || 'stop', !!msg.tool_calls);
  return {
    id: uid(),
    type: 'message',
    role: 'assistant',
    content,
    stop_reason,
    usage: { input_tokens: msg.usage?.prompt_tokens || 0, output_tokens: msg.usage?.completion_tokens || 0 },
  };
}

function openai_chat_response_to_anthropic(response) {
  const choice = response.choices && response.choices[0];
  if (!choice) return null;
  const msg = choice.message || {};
  return openai_message_to_anthropic({ ...msg, finish_reason: choice.finish_reason || 'stop', usage: response.usage });
}

module.exports = {
  toParams, toResponse, toSSE,
  anthropic_messages_to_openai,
  anthropic_tools_to_openai,
  anthropic_tool_choice_to_openai,
  openai_finish_to_anthropic_stop,
  anthropic_image_block_to_openai_part,
  anthropic_tool_use_id,
  openai_message_to_anthropic,
  openai_chat_response_to_anthropic,
  AnthropicPassthroughEmitter,
};
