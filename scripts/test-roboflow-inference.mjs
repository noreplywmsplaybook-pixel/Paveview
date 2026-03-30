#!/usr/bin/env node
/**
 * Local inference smoke test — same URL shape as api/roboflow-detect.js
 *
 * Usage (from repo root):
 *   export ROBOFLOW_API_KEY="your_private_key"
 *   export ROBOFLOW_MODEL_ID="project-slug/1"
 *   # optional if Deploy URL has a workspace segment:
 *   export ROBOFLOW_WORKSPACE="workspace-slug"
 *   node scripts/test-roboflow-inference.mjs
 *
 * Or put those in .env.local (gitignored) — loaded automatically if present.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const envLocal = join(root, '.env.local');
if (existsSync(envLocal)) {
  const text = readFileSync(envLocal, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

function pickFirst(values) {
  for (const v of values) {
    const s = String(v || '').trim();
    if (s) return s;
  }
  return '';
}

const apiKey = pickFirst([
  process.env.ROBOFLOW_API_KEY,
  process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY,
  process.env.ROBOFLOW_KEY,
  process.env.RF_API_KEY
]);
const modelIdRaw = pickFirst([
  process.env.ROBOFLOW_MODEL_ID,
  process.env.NEXT_PUBLIC_ROBOFLOW_MODEL_ID
]);
const ws = String(process.env.ROBOFLOW_WORKSPACE || '').trim().replace(/^\/+|\/+$/g, '');
const id = String(modelIdRaw || '').trim().replace(/^\/+/, '');
const modelPath = ws ? `${ws}/${id}` : id;

if (!apiKey || !modelIdRaw) {
  console.error(
    'Missing ROBOFLOW_API_KEY or ROBOFLOW_MODEL_ID.\n' +
      'Export them or add .env.local in the repo root (see script header).'
  );
  process.exit(1);
}

// Small real JPEG via HTTPS (Roboflow needs a valid image)
const imgRes = await fetch('https://picsum.photos/320/240');
if (!imgRes.ok) {
  console.error('Could not download test image:', imgRes.status);
  process.exit(1);
}
const imageBase64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');

const confidence = 25;
const overlap = 30;
const url = `https://detect.roboflow.com/${modelPath}?api_key=${encodeURIComponent(apiKey)}&confidence=${confidence}&overlap=${overlap}`;

console.log('POST', `https://detect.roboflow.com/${modelPath}?confidence=${confidence}&overlap=${overlap} (api_key hidden)`);

const rfRes = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: imageBase64
});

let payload = null;
const text = await rfRes.text();
try {
  payload = JSON.parse(text);
} catch {
  payload = { raw: text.slice(0, 500) };
}

if (!rfRes.ok) {
  console.error('FAIL', rfRes.status, payload?.error || payload?.message || text.slice(0, 300));
  process.exit(1);
}

const preds = Array.isArray(payload?.predictions) ? payload.predictions : [];
console.log('OK', rfRes.status, '| predictions:', preds.length);
if (preds.length) {
  console.log('sample:', JSON.stringify(preds[0], null, 2).slice(0, 400));
} else {
  console.log('(no objects above confidence — try a busier image or lower confidence in the app)');
}
process.exit(0);
