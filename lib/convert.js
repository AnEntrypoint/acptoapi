function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

function convertTools(tools) {
  if (!tools || typeof tools !== 'object') return [];
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description || '',
    parameters: cleanSchema(t.parameters?.jsonSchema || t.parameters || { type: 'object' })
  }));
}

function convertImageBlock(b) {
  // Handle inlineData: { mimeType, data } (base64)
  if (b.inlineData || b.type === 'image') {
    const src = b.inlineData || b.source;
    if (src?.data) return { inlineData: { mimeType: src.mimeType || 'image/jpeg', data: src.data } };
    if (src?.url) return { fileData: { mimeType: src.mimeType || 'image/jpeg', fileUri: src.url } };
  }
  // Handle fileData: { mimeType, fileUri }
  if (b.fileData) return { fileData: { mimeType: b.fileData.mimeType, fileUri: b.fileData.fileUri } };
  // Anthropic-style image block
  if (b.type === 'image' && b.source) {
    if (b.source.type === 'base64') return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
    if (b.source.type === 'url') return { fileData: { mimeType: b.source.media_type || 'image/jpeg', fileUri: b.source.url } };
  }
  return null;
}

function convertMessages(messages) {
  const contents = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') {
      if (m.content) contents.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    if (Array.isArray(m.content)) {
      const parts = m.content.map(b => {
        if (b.type === 'text' && b.text) return { text: b.text };
        if (b.type === 'image' || b.inlineData || b.fileData) return convertImageBlock(b);
        if (b.type === 'tool_use') return { functionCall: { name: b.name, args: b.input || {} } };
        if (b.type === 'tool_result') {
          let resp;
          try { resp = typeof b.content === 'string' ? JSON.parse(b.content) : (b.content || {}); }
          catch { resp = { result: b.content }; }
          return { functionResponse: { name: b.name || 'unknown', response: resp } };
        }
        return null;
      }).filter(Boolean);
      if (parts.length) contents.push({ role, parts });
    }
  }
  return contents;
}

function extractModelId(model) {
  if (typeof model === 'string') return model;
  if (model?.modelId) return model.modelId;
  if (model?.id) return model.id;
  return 'gemini-2.0-flash';
}

function buildConfig({ system, tools, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities } = {}) {
  const geminiTools = convertTools(tools);
  const config = {
    maxOutputTokens: maxOutputTokens ?? 8192,
    temperature: temperature ?? 0.5,
    topP: topP ?? 0.95
  };
  if (topK != null) config.topK = topK;
  if (system) config.systemInstruction = system;
  if (geminiTools.length > 0) config.tools = [{ functionDeclarations: geminiTools }];
  if (safetySettings) config.safetySettings = safetySettings;
  if (responseModalities) config.responseModalities = responseModalities;
  return { config, geminiTools };
}

module.exports = { cleanSchema, convertTools, convertMessages, extractModelId, buildConfig, convertImageBlock };
