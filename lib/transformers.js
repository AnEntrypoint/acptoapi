function removeCacheControl(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(removeCacheControl);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'cache_control') continue;
    out[k] = removeCacheControl(v);
  }
  return out;
}

const BUILT_IN = {
  cleancache: {
    request(req) { return { ...req, messages: removeCacheControl(req.messages), system: removeCacheControl(req.system) }; }
  },
  deepseek: {
    request(req) {
      const r = removeCacheControl(req);
      if (r.system && typeof r.system !== 'string') {
        r.system = (Array.isArray(r.system) ? r.system : [r.system]).map(b => b.text || '').join('\n');
      }
      return r;
    }
  },
  openrouter: {
    options: {},
    request(req, opts) {
      const headers = { 'HTTP-Referer': 'https://github.com/AnEntrypoint/thebird', 'X-Title': 'thebird', ...(opts || {}).headers };
      if ((opts || {}).provider) req = { ...req, provider: (opts || {}).provider };
      return { ...req, _extraHeaders: { ...(req._extraHeaders || {}), ...headers } };
    }
  },
  maxtoken: {
    request(req, opts) { return { ...req, max_tokens: (opts || {}).max_tokens || req.max_tokens }; }
  },
  tooluse: {
    request(req) {
      if (req.tools && req.tools.length > 0) return { ...req, tool_choice: { type: 'required' } };
      return req;
    }
  },
  reasoning: {
    request(req) { return req; },
    response(res) {
      if (!res.choices) return res;
      return {
        ...res,
        choices: res.choices.map(c => {
          if (!c.message) return c;
          const msg = { ...c.message };
          if (msg.reasoning_content) { msg._reasoning = msg.reasoning_content; delete msg.reasoning_content; }
          return { ...c, message: msg };
        })
      };
    }
  },
  sampling: {
    request(req) {
      const r = { ...req };
      delete r.top_k;
      delete r.repetition_penalty;
      return r;
    }
  },
  groq: {
    request(req) {
      const r = { ...req };
      delete r.top_k;
      return r;
    }
  }
};

function resolveTransformers(useList, customMap) {
  if (!useList) return [];
  return useList.map(entry => {
    const name = Array.isArray(entry) ? entry[0] : entry;
    const opts = Array.isArray(entry) ? entry[1] : undefined;
    const t = (customMap && customMap[name]) || BUILT_IN[name];
    if (!t) { console.warn('[thebird] unknown transformer:', name); return null; }
    return { transformer: t, opts };
  }).filter(Boolean);
}

function applyRequestTransformers(req, transformers) {
  return transformers.reduce((r, { transformer, opts }) => transformer.request ? transformer.request(r, opts) : r, req);
}

function applyResponseTransformers(res, transformers) {
  return transformers.reduce((r, { transformer, opts }) => transformer.response ? transformer.response(r, opts) : r, res);
}

module.exports = { resolveTransformers, applyRequestTransformers, applyResponseTransformers, BUILT_IN };
