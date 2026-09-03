const { loadConfig } = require('./config');

const SUBAGENT_RE = /<CCR-SUBAGENT-MODEL>([^<]+)<\/CCR-SUBAGENT-MODEL>/;

function estimateTokens(messages, system) {
  let chars = typeof system === 'string' ? system.length : (system ? JSON.stringify(system).length : 0);
  for (const m of (messages || [])) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
  }
  return Math.ceil(chars / 4);
}

function extractSubagentModel(messages) {
  const first = messages?.[0];
  if (!first) return null;
  const text = typeof first.content === 'string' ? first.content :
    (Array.isArray(first.content) ? first.content.map(b => b.text || '').join('') : '');
  const m = SUBAGENT_RE.exec(text);
  return m ? m[1].trim() : null;
}

function parseProviderModel(str) {
  const idx = str.indexOf(',');
  if (idx === -1) return { providerName: null, modelName: str };
  return { providerName: str.slice(0, idx), modelName: str.slice(idx + 1) };
}

async function route(params, routerCfg, customRouterFn) {
  const { messages, system, taskType } = params;

  if (customRouterFn) {
    const custom = await customRouterFn(params, routerCfg);
    if (custom) return parseProviderModel(custom);
  }

  const subagent = extractSubagentModel(messages);
  if (subagent) return parseProviderModel(subagent);

  if (taskType === 'background' && routerCfg.background) return parseProviderModel(routerCfg.background);
  if (taskType === 'think' && routerCfg.think) return parseProviderModel(routerCfg.think);
  if (taskType === 'webSearch' && routerCfg.webSearch) return parseProviderModel(routerCfg.webSearch);
  if (taskType === 'image' && routerCfg.image) return parseProviderModel(routerCfg.image);

  const threshold = routerCfg.longContextThreshold || 60000;
  if (routerCfg.longContext && estimateTokens(messages, system) > threshold) return parseProviderModel(routerCfg.longContext);

  if (routerCfg.default) return parseProviderModel(routerCfg.default);
  return { providerName: null, modelName: null };
}

module.exports = { route, estimateTokens, parseProviderModel };
