#!/usr/bin/env node
// Builds the updater feed (latest.json) from downloaded CI artifacts.
// Usage: node scripts/make-latest.mjs --version 0.2.0 --notes notes.md --dir artifacts --out latest.json
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`missing ${name}`); return args[i + 1]; };
const version = option('--version');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('version must be X.Y.Z');
const dir = option('--dir');
const base = `https://github.com/VGabby/lumawb-desktop-releases/releases/download/v${version}`;
const files = {
  'darwin-aarch64': 'Lumawb-Desktop-darwin-arm64.app.tar.gz',
  'windows-x86_64': 'Lumawb-Desktop-win32-x64-setup.exe',
};
const platforms = {};
for (const [platform, file] of Object.entries(files)) {
  const signature = (await readFile(join(dir, `${file}.sig`), 'utf8')).trim();
  platforms[platform] = { signature, url: `${base}/${file}` };
}
const feed = {
  version,
  notes: (await readFile(option('--notes'), 'utf8')).trim(),
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms,
};
await writeFile(option('--out'), JSON.stringify(feed, null, 2) + '\n');
console.log(`Wrote latest.json for ${version}: ${Object.keys(platforms).join(', ')}`);
