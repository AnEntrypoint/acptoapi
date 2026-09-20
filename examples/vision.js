const { generateGemini } = require('../index');

const tinyTransparentPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function base64Example() {
  console.log('=== Base64 image (Anthropic style) ===');

  const result = await generateGemini({
    model: 'gemini-2.0-flash',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: tinyTransparentPngBase64 }
        },
        { type: 'text', text: 'Describe this image in one sentence.' }
      ]
    }]
  });
  console.log('Response:', result.text);
}

async function inlineDataExample() {
  console.log('\n=== Gemini inlineData style ===');

  const result = await generateGemini({
    model: 'gemini-2.0-flash',
    messages: [{
      role: 'user',
      content: [
        { inlineData: { mimeType: 'image/png', data: tinyTransparentPngBase64 } },
        { type: 'text', text: 'What color is this image?' }
      ]
    }]
  });
  console.log('Response:', result.text);
}

async function publicUrlExample() {
  console.log('\n=== Public URL via fileData ===');
  const result = await generateGemini({
    model: 'gemini-2.0-flash',
    messages: [{
      role: 'user',
      content: [
        {
          fileData: {
            mimeType: 'image/jpeg',
            fileUri: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/240px-PNG_transparency_demonstration_1.png'
          }
        },
        { type: 'text', text: 'What do you see in this image?' }
      ]
    }]
  });
  console.log('Response:', result.text);
}

async function main() {
  await base64Example();
  await inlineDataExample();
}

main().catch(console.error);
