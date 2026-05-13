'use strict';
// Thin passthrough handlers for image generation, TTS, and audio transcription.
// acptoapi forwards the request to the configured upstream so callers (freddie etc.)
// have one place to send LLM/media traffic instead of importing each vendor SDK.

const TARGETS = {
    'images.openai':       { url: 'https://api.openai.com/v1/images/generations', env: 'OPENAI_API_KEY', auth: k => ({ authorization: 'Bearer ' + k }) },
    'images.replicate':    { url: 'https://api.replicate.com/v1/predictions',     env: 'REPLICATE_API_TOKEN', auth: k => ({ authorization: 'Token ' + k }) },
    'audio.speech.openai': { url: 'https://api.openai.com/v1/audio/speech',       env: 'OPENAI_API_KEY', auth: k => ({ authorization: 'Bearer ' + k }) },
    'audio.tts.elevenlabs':{ url: v => `https://api.elevenlabs.io/v1/text-to-speech/${v}`, env: 'ELEVENLABS_API_KEY', auth: k => ({ 'xi-api-key': k }) },
    'audio.transcriptions.openai': { url: 'https://api.openai.com/v1/audio/transcriptions', env: 'OPENAI_API_KEY', auth: k => ({ authorization: 'Bearer ' + k }) },
    'responses.openai':    { url: 'https://api.openai.com/v1/responses',          env: 'OPENAI_API_KEY', auth: k => ({ authorization: 'Bearer ' + k }) },
};

function pickTarget(category, provider) {
    const k = `${category}.${provider}`;
    return TARGETS[k] || null;
}

async function forwardJson({ req, res, json, target }) {
    const apiKey = process.env[target.env];
    if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `missing ${target.env}` } }));
    }
    const url = typeof target.url === 'function' ? target.url(json.voice || '') : target.url;
    const headers = { 'content-type': 'application/json', ...target.auth(apiKey) };
    try {
        const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(json) });
        const contentType = r.headers.get('content-type') || 'application/octet-stream';
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'Content-Type': contentType, 'Content-Length': buf.length });
        return res.end(buf);
    } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: e.message } }));
    }
}

async function forwardMultipart({ req, res, target }) {
    const apiKey = process.env[target.env];
    if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `missing ${target.env}` } }));
    }
    // Read the full body as a buffer and re-post with the original Content-Type header.
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = typeof target.url === 'function' ? target.url('') : target.url;
    const headers = { 'content-type': req.headers['content-type'], ...target.auth(apiKey) };
    try {
        const r = await fetch(url, { method: 'POST', headers, body });
        const contentType = r.headers.get('content-type') || 'application/json';
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'Content-Type': contentType, 'Content-Length': buf.length });
        return res.end(buf);
    } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: e.message } }));
    }
}

module.exports = { pickTarget, forwardJson, forwardMultipart, TARGETS };
