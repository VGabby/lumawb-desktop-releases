#!/usr/bin/env node
// Public orchestration only. Private compiler output stays on the ephemeral VM.
import { spawnSync } from 'node:child_process';
import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const root = process.cwd();
const desktop = join(root, 'private-source', 'desktop');
const output = join(root, 'installer-artifacts');
const diagnosticsKey = join(root, 'diagnostics-public.pem');
const target = 'x86_64-pc-windows-msvc';
// MSBuild's file tracker still hits MAX_PATH in deep Cargo/CMake directories.
const targetRoot = join(process.env.RUNNER_TEMP || tmpdir(), 'lt');
process.env.CARGO_TARGET_DIR = targetRoot;
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

// Encrypts the captured build logs for the publisher's offline private key.
// Only the RSA public key is available here; nothing readable is written.
async function writeEncryptedDiagnostics(failedPhase) {
  const pem = await readFile(diagnosticsKey, 'utf8');
  if (/PRIVATE KEY/.test(pem)) throw new Error('diagnostics key must be public');
  const recipient = createPublicKey(pem);
  if (recipient.type !== 'public' || recipient.asymmetricKeyType !== 'rsa') throw new Error('diagnostics key must be RSA public');

  const captured = {};
  for (const entry of await readdir(logs, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.log')) captured[entry.name] = await readFile(join(logs, entry.name), 'utf8');
  }
  const plaintext = deflateSync(Buffer.from(JSON.stringify({ version: 1, phase: failedPhase, logs: captured }), 'utf8'));

  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedKey = publicEncrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  key.fill(0);

  const envelope = {
    version: 1,
    format: 'lumawb-build-diagnostics',
    compression: 'zlib-deflate',
    content: 'json',
    cipher: 'AES-256-GCM',
    keyEncryption: 'RSA-OAEP-SHA256',
    encryptedKey: encryptedKey.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'build-diagnostics.enc.json'), `${JSON.stringify(envelope)}\n`);
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
  run('Offline HTTP integration', process.execPath, ['scripts/http-smoke.mjs', '--binary', join(targetRoot, target, 'debug', 'lumawb-api.exe')]);
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
  console.error(`Build failed during: ${phase}.`);
  try {
    await writeEncryptedDiagnostics(phase);
    console.error('Encrypted diagnostics written; readable only with the publisher\'s offline private key.');
  } catch {
    await rm(output, { recursive: true, force: true });
    console.error('Encrypted diagnostics could not be created.');
  }
  process.exitCode = 1;
} finally {
  await rm(logs, { recursive: true, force: true });
}
