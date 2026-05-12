'use strict';
const { streamClaude, parseClaudeModel } = require('../claude-client');
const { BridgeError } = require('../errors');

function messagesToPrompt(messages) {
    if (!Array.isArray(messages)) return '';
    const parts = [];
    for (const m of messages) {
        if (m.role === 'system') continue;
        const content = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
                ? m.content.map(b => b.type === 'text' ? b.text : '').filter(Boolean).join('\n')
                : '';
        if (content) parts.push(content);
    }
    return parts.join('\n\n');
}

function extractSystem(messages, system) {
    if (system) return typeof system === 'string' ? system : Array.isArray(system) ? system.map(b => b.text || '').join('\n') : '';
    if (!Array.isArray(messages)) return '';
    return messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
}

async function* streamClaudeProvider({ model, messages, system, claudeBin }) {
    const prompt = messagesToPrompt(messages);
    if (!prompt) throw new BridgeError('claude provider requires a user message', { retryable: false });
    const claudeModel = parseClaudeModel(model);
    const systemPrompt = extractSystem(messages, system);

    yield { type: 'start-step' };

    let textBuf = '';
    const toolCalls = new Map();
    let finishReason = 'stop';

    try {
        for await (const ev of streamClaude({ prompt, model: claudeModel, systemPrompt, bin: claudeBin || 'claude', tools: '' })) {
            if (ev.type === 'stream_event') {
                const e = ev.event;
                if (!e) continue;
                if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
                    toolCalls.set(e.index, { id: e.content_block.id, name: e.content_block.name, args: '' });
                } else if (e.type === 'content_block_delta') {
                    if (e.delta?.type === 'text_delta' && e.delta.text) {
                        textBuf += e.delta.text;
                        yield { type: 'text-delta', textDelta: e.delta.text };
                    } else if (e.delta?.type === 'input_json_delta') {
                        const tc = toolCalls.get(e.index);
                        if (tc) tc.args += e.delta.partial_json || '';
                    }
                } else if (e.type === 'message_delta' && e.delta?.stop_reason) {
                    if (e.delta.stop_reason === 'tool_use') finishReason = 'tool-calls';
                    else if (e.delta.stop_reason === 'max_tokens') finishReason = 'stop';
                    else finishReason = 'stop';
                }
            } else if (ev.type === 'result') {
                if (ev.subtype === 'error') throw new BridgeError(ev.result || 'claude CLI error', { retryable: false });
            }
        }
    } catch (e) {
        if (e instanceof BridgeError) throw e;
        throw new BridgeError(e.message || String(e), { retryable: true });
    }

    for (const tc of toolCalls.values()) {
        let args; try { args = JSON.parse(tc.args || '{}'); } catch { args = {}; }
        yield { type: 'tool-call', toolCallId: tc.id, toolName: tc.name, args };
    }

    if (!textBuf && toolCalls.size === 0) throw new BridgeError('claude CLI produced no output', { retryable: true });

    yield { type: 'finish-step', finishReason };
}

module.exports = { streamClaude: streamClaudeProvider };
