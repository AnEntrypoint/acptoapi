/**
 * vision.js — Image/vision understanding examples
 *
 * Demonstrates three ways to pass images:
 *   1. Base64 inline data (Anthropic SDK style)
 *   2. Gemini inlineData style
 *   3. Public URL via fileData
 *
 * Usage:
 *   GEMINI_API_KEY=your-key node examples/vision.js
 */
const fs = require('fs');
const path = require('path');
const { generateGemini } = require('../index');

async function base64Example() {
  console.log('=== Base64 image (Anthropic style) ===');
  // Read a local image and encode as base64
  // const imageBuffer = fs.readFileSync(path.join(__dirname, 'sample.jpg'));
  // const base64 = imageBuffer.toString('base64');

  // For demo purposes, use a tiny 1x1 transparent PNG
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const result = await generateGemini({
    model: 'gemini-2.0-flash',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: base64 }
        },
        { type: 'text', text: 'Describe this image in one sentence.' }
      ]
    }]
  });
  console.log('Response:', result.text);
}

async function inlineDataExample() {
  console.log('\n=== Gemini inlineData style ===');
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const result = await generateGemini({
    model: 'gemini-2.0-flash',
    messages: [{
      role: 'user',
      content: [
        { inlineData: { mimeType: 'image/png', data: base64 } },
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
  // await publicUrlExample(); // Uncomment to test with public URLs
}

main().catch(console.error);
