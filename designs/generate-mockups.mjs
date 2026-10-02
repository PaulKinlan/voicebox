#!/usr/bin/env node
/**
 * Generate UI concept mockups in `designs/` using Gemini Nano Banana
 * (`gemini-2.5-flash-image` / `gemini-2.0-flash-exp-image-generation`).
 *
 * Usage:
 *   node designs/generate-mockups.mjs "<prompt>" [output-filename.png]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const envPath = path.join(repoRoot, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.+)\s*$/);
      if (match) {
        return match[1].replace(/^['"]|['"]$/g, '').trim();
      }
    }
  }
  return null;
}

async function generateMockup(prompt, outputPath, model = process.env.NANO_BANANA_MODEL || 'gemini-2.5-flash-image') {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY is required in environment or .env file.');
    process.exit(1);
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE']
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);

  if (!imagePart) {
    throw new Error(`No image returned by ${model}. Response parts: ${JSON.stringify(parts)}`);
  }

  const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  console.log(`Saved Nano Banana mockup (${buffer.length} bytes) -> ${outputPath}`);
}

const [, , rawPrompt, rawOut] = process.argv;
if (!rawPrompt) {
  console.log('Usage: node designs/generate-mockups.mjs "<prompt>" [output-filename.png]');
  process.exit(0);
}

const outFile = rawOut
  ? path.resolve(process.cwd(), rawOut)
  : path.join(__dirname, `mockup-${Date.now()}.png`);

generateMockup(rawPrompt, outFile).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
