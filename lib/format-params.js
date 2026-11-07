function buildParams({ model, messages, system, tools, temperature, maxOutputTokens, ...rest }) {
  return {
    model,
    messages,
    system,
    tools: tools && Object.keys(tools).length ? tools : undefined,
    temperature,
    maxOutputTokens,
    ...rest,
  };
}

module.exports = { buildParams };
