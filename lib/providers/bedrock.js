const crypto = require('crypto');
const { BridgeError } = require('../errors');

function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

function sigv4Sign({ method, url, body, service, region, accessKey, secretKey, sessionToken }) {
  const u = new URL(url);
  const now = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = date.slice(0, 8);
  const bodyHash = hash(body);
  const headers = { 'content-type': 'application/json', 'host': u.host, 'x-amz-date': date, 'x-amz-content-sha256': bodyHash };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => k + ':' + headers[k]).join('\n') + '\n';
  const canonicalRequest = [method, u.pathname, u.search.slice(1), canonicalHeaders, signedHeaders, bodyHash].join('\n');
  const credScope = [dateStamp, region, service, 'aws4_request'].join('/');
  const stringToSign = ['AWS4-HMAC-SHA256', date, credScope, hash(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

const FINISH_REASON_MAP = { end_turn: 'stop', tool_use: 'tool-calls', max_tokens: 'length' };

async function* streamBedrock({ model, messages, system, tools, temperature, maxOutputTokens, awsRegion, awsAccessKeyId, awsSecretAccessKey, awsSessionToken }) {
  const region = awsRegion || process.env.AWS_REGION || 'us-east-1';
  const accessKey = awsAccessKeyId || process.env.AWS_ACCESS_KEY_ID;
  const secretKey = awsSecretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = awsSessionToken || process.env.AWS_SESSION_TOKEN;
  if (!accessKey || !secretKey) throw new BridgeError('AWS credentials required', { retryable: false });

  const bedrockMessages = messages.map(m => ({
    role: m.role,
    content: (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]).map(b => {
      if (b.type === 'text') return { text: b.text };
      if (b.type === 'tool_use') return { toolUse: { toolUseId: b.id, name: b.name, input: b.input } };
      if (b.type === 'tool_result') return { toolResult: { toolUseId: b.tool_use_id, content: [{ text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) }], status: 'success' } };
      return b;
    }),
  }));

  const body = { messages: bedrockMessages };
  if (system) body.system = [{ text: system }];
  if (temperature !== undefined || maxOutputTokens !== undefined) {
    body.inferenceConfig = {};
    if (temperature !== undefined) body.inferenceConfig.temperature = temperature;
    if (maxOutputTokens !== undefined) body.inferenceConfig.maxTokens = maxOutputTokens;
  }
  if (tools) {
    body.toolConfig = { tools: Object.entries(tools).map(([name, t]) => ({ toolSpec: { name, description: t.description || '', inputSchema: { json: t.parameters || {} } } })) };
  }

  const bodyStr = JSON.stringify(body);
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${model}/converse-stream`;
  const reqHeaders = sigv4Sign({ method: 'POST', url, body: bodyStr, service: 'bedrock-runtime', region, accessKey, secretKey, sessionToken });

  const res = await fetch(url, { method: 'POST', headers: reqHeaders, body: bodyStr });
  if (!res.ok) { const t = await res.text(); throw new BridgeError(t, { status: res.status, retryable: res.status === 429 || res.status >= 500 }); }

  yield { type: 'start-step' };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let ev; try { ev = JSON.parse(trimmed); } catch { continue; }
        if (ev.contentBlockDelta?.delta?.text) yield { type: 'text-delta', textDelta: ev.contentBlockDelta.delta.text };
        if (ev.contentBlockStart?.contentBlock?.toolUse) {
          const tu = ev.contentBlockStart.contentBlock.toolUse;
          yield { type: 'tool-call', toolCallId: tu.toolUseId, toolName: tu.name, args: {} };
        }
        if (ev.messageStop) {
          const finishReason = FINISH_REASON_MAP[ev.messageStop.stopReason] || 'stop';
          yield { type: 'finish-step', finishReason };
        }
      }
    }
  } finally { reader.releaseLock(); }
}

module.exports = { streamBedrock };
