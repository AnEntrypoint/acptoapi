function convertTools(tools) {
  if (!tools || typeof tools !== 'object') return undefined;
  const list = Object.entries(tools).map(([name, t]) => ({
    type: 'function', function: { name, description: t.description || '',
      parameters: t.parameters?.jsonSchema || t.parameters || { type: 'object' } }
  }));
  return list.length ? list : undefined;
}


async function* readerIterable(reader) {
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    yield dec.decode(value, { stream: true });
  }
}


module.exports = { convertTools, readerIterable };
