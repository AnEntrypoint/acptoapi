'use strict';
const { makeChunk } = require('./translate');

const STOP_REASON_MAP = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
};

function createClaudeMapper(id, model) {
  let roleEmitted = false;
  const toolCalls = new Map();

  const ensureRole = emit => {
    if (!roleEmitted) { emit(makeChunk(id, model, { role: 'assistant', content: '' })); roleEmitted = true; }
  };

  return {
    mapEvent(ev, emit) {
      if (ev.type === 'stream_event') {
        const e = ev.event;
        if (!e) return false;

        if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          const tcIdx = toolCalls.size;
          toolCalls.set(e.index, { tcIdx, id: e.content_block.id, name: e.content_block.name, args: '' });
          ensureRole(emit);
          emit(makeChunk(id, model, { tool_calls: [{
            index: tcIdx,
            id: e.content_block.id,
            type: 'function',
            function: { name: e.content_block.name, arguments: '' },
          }]}));
          return false;
        }

        if (e.type === 'content_block_delta') {
          if (e.delta?.type === 'text_delta' && e.delta.text) {
            ensureRole(emit);
            emit(makeChunk(id, model, { content: e.delta.text }));
          } else if (e.delta?.type === 'input_json_delta') {
            const tc = toolCalls.get(e.index);
            if (tc) {
              tc.args += e.delta.partial_json || '';
              emit(makeChunk(id, model, { tool_calls: [{
                index: tc.tcIdx,
                function: { arguments: e.delta.partial_json || '' },
              }]}));
            }
          } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) {
            ensureRole(emit);
            emit(makeChunk(id, model, { reasoning_content: e.delta.thinking }));
          }
          return false;
        }

        if (e.type === 'message_delta' && e.delta?.stop_reason) {
          return false;
        }

        return false;
      }

      if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
        for (const part of ev.message.content) {
          if (part.type === 'tool_result') {
            const text = typeof part.content === 'string'
              ? part.content
              : (Array.isArray(part.content) ? part.content.map(c => c.text || '').join('') : JSON.stringify(part.content));
            ensureRole(emit);
            emit(makeChunk(id, model, { content: `\n[tool_result ${part.tool_use_id}]\n${text}\n[/tool_result]\n` }));
          }
        }
        return false;
      }

      if (ev.type === 'result') {
        return { terminal: true, stop_reason: STOP_REASON_MAP[ev.stop_reason] || 'stop', usage: ev.usage };
      }

      return false;
    },
  };
}

module.exports = { createClaudeMapper };
