'use strict';

const DASHED_TO_DOTTED_GLM_IDS = {
  'z-ai/glm-5-1': 'z-ai/glm-5.1',
  'glm-5-1': 'glm-5.1',
};

function normalizeModelId(model) {
  if (typeof model !== 'string') return model;
  return DASHED_TO_DOTTED_GLM_IDS[model] || model;
}

function splitBrandModel(fullModel, { normalize = false } = {}) {
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(fullModel || '');
  if (!m) return null;
  return { prefix: m[1], model: normalize ? normalizeModelId(m[2]) : m[2] };
}

module.exports = { splitBrandModel, normalizeModelId };
