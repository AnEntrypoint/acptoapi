const { getClient } = require('./lib/client');
const { GeminiError, withRetry } = require('./lib/errors');
const { convertMessages, convertTools, cleanSchema, extractModelId, buildConfig } = require('./lib/convert');
const { guardStream } = require('./lib/stream-guard');

function streamGemini({ model, system, messages, tools, onStepFinish, apiKey,
  temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities }) {
  return {
    fullStream: createFullStream({ model, system, messages, tools, onStepFinish, apiKey, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities }),
    warnings: Promise.resolve([])
  };
}

async function* createFullStream({ model, system, messages, tools, onStepFinish, apiKey, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities, streamGuard }) {
  const client = getClient(apiKey);
  const modelId = extractModelId(model);
  let contents = convertMessages(messages);
  const { config } = buildConfig({ system, tools, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities });
  while (true) {
    yield { type: 'start-step' };
    try {
      const stream = await withRetry(() => client.models.generateContentStream({ model: modelId, contents, config }));
      const allParts = [];
      for await (const chunk of guardStream(stream, streamGuard)) {
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

const { streamRouter, generateRouter, createRouter } = require('./lib/router-stream');
const { cloudGenerate, streamCloud, cloudStream } = require('./lib/cloud-generate');
const { ensureAuth, login: oauthLogin } = require('./lib/oauth');
const { BridgeError, AuthError, RateLimitError, TimeoutError, ContextWindowError, ContentPolicyError, ProviderError, classifyError, redactKeys } = require('./lib/errors');
const { streamACP, generateACP } = require('./lib/providers/acp');
const { translate, translateSync, buffer, stream } = require('./lib/translate');
const { getFormat, FORMATS } = require('./lib/formats/index');
const { getProvider, PROVIDERS } = require('./lib/providers/index');
const { createStreamActor } = require('./lib/machine');
const { Anthropic } = require('./lib/sdk/anthropic');
const { OpenAI } = require('./lib/sdk/openai');
const { createAnthropicServer } = require('./lib/server/anthropic');
const { createOpenAIServer } = require('./lib/server/openai');
const { resolveModel, chat, chain, chatChain, streamChain } = require('./lib/sdk');
const sdkStream = require('./lib/sdk').stream;

module.exports = { streamGemini, createFullStream, generateGemini, streamRouter, generateRouter, createRouter, convertMessages, convertTools, cleanSchema, GeminiError, BridgeError, AuthError, RateLimitError, TimeoutError, ContextWindowError, ContentPolicyError, ProviderError, classifyError, redactKeys, cloudGenerate, streamCloud, cloudStream, ensureAuth, oauthLogin, streamACP, generateACP, translate, translateSync, buffer, stream, getFormat, FORMATS, getProvider, PROVIDERS, createStreamActor, Anthropic, OpenAI, createAnthropicServer, createOpenAIServer, resolveModel, chat, chain, chatChain, streamChain, sdkStream };
