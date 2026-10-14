#!/usr/bin/env node
// Public orchestration only. Private compiler output stays on the ephemeral VM.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const desktop = join(root, 'private-source', 'desktop');
const output = join(root, 'installer-artifacts');
const target = 'x86_64-pc-windows-msvc';
const logs = await mkdtemp(join(tmpdir(), 'lumawb-private-build-'));
let phase = 'initialization';

function run(name, executable, args, options = {}) {
  phase = name;
  console.log(`Starting: ${name}`);
  const descriptor = openSync(join(logs, `${name.replace(/[^a-z0-9]/gi, '_')}.log`), 'w');
  let result;
  try {
    result = spawnSync(executable, args, { cwd: desktop, stdio: ['ignore', descriptor, descriptor], windowsHide: true, ...options });
  } finally {
    closeSync(descriptor);
  }
  if (result.error || result.status !== 0) throw new Error('private command failed');
  console.log(`Passed: ${name}`);
}

try {
  if (process.platform !== 'win32') throw new Error('Windows runner required');
  if (!/^[a-f0-9]{40}$/i.test(process.env.LUMAWB_SOURCE_COMMIT || '')) throw new Error('invalid source revision');
  phase = 'Verify checked out revision';
  const revision = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: desktop, encoding: 'utf8', windowsHide: true });
  if (revision.status !== 0 || revision.stdout.trim().toLowerCase() !== process.env.LUMAWB_SOURCE_COMMIT.toLowerCase()) throw new Error('wrong checkout');
  console.log(`Passed: ${phase}`);
  // npm.cmd is a Windows shim; this invocation has fixed, non-interpolated args.
  run('Install frontend dependencies', 'npm.cmd', ['ci'], { shell: true });
  run('Prepare checked model and runtime', process.execPath, ['scripts/prepare-runtime.mjs', '--target', target]);
  run('Build frontend', 'npm.cmd', ['run', 'build'], { shell: true });
  run('Core tests', 'cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features', '--target', target]);
  run('Python reference parity', 'cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features', '--target', target, '--test', 'core_parity', '--', '--ignored']);
  run('Build real HTTP API', 'cargo', ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features', '--bin', 'lumawb-api', '--target', target]);
  run('Offline HTTP integration', process.execPath, ['scripts/http-smoke.mjs', '--binary', `src-tauri/target/${target}/debug/lumawb-api.exe`]);
  run('Build Windows installer', process.execPath, ['scripts/build-release.mjs', '--target', target]);

  phase = 'Validate installer artifacts';
  const source = join(desktop, 'release-artifacts', 'win32-x64');
  const names = await readdir(source);
  const installers = names.filter(name => /^[^\\/]+\.exe$/i.test(name));
  if (!installers.length) throw new Error('no installer');
  const checksums = await readFile(join(source, 'SHA256SUMS.txt'), 'utf8');
  const expected = new Map();
  for (const line of checksums.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([^\\/]+\.exe)$/i.exec(line);
    if (!match) throw new Error('invalid checksum manifest');
    expected.set(match[2], match[1].toLowerCase());
  }
  await mkdir(output, { recursive: true });
  for (const name of installers) {
    const path = join(source, name);
    if (!(await stat(path)).isFile()) throw new Error('not a regular installer');
    const bytes = await readFile(path);
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('not a PE installer');
    if (createHash('sha256').update(bytes).digest('hex') !== expected.get(name)) throw new Error('installer hash mismatch');
    await copyFile(path, join(output, name));
  }
  if (expected.size !== installers.length) throw new Error('unexpected manifest entry');
  await copyFile(join(source, 'SHA256SUMS.txt'), join(output, 'SHA256SUMS.txt'));
  console.log(`Passed: ${phase}; ${installers.length} installer(s), checksums only.`);
} catch {
  await rm(output, { recursive: true, force: true });
  console.error(`Build failed during: ${phase}. Raw output remains private on the ephemeral runner; no source or logs are uploaded.`);
  process.exitCode = 1;
} finally {
  await rm(logs, { recursive: true, force: true });
}
