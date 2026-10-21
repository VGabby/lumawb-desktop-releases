#!/usr/bin/env node
// Public orchestration only. Private compiler output stays on the ephemeral VM.
// Builds the Windows x64 or Apple Silicon installer and its signed update file.
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
const windows = process.platform === 'win32';
const target = windows ? 'x86_64-pc-windows-msvc' : 'aarch64-apple-darwin';
const platformName = windows ? 'win32-x64' : 'darwin-arm64';
// The update signing key goes only to the installer build. Dependency
// installs, tests and diagnostics never see it.
const signing = {
  TAURI_SIGNING_PRIVATE_KEY: process.env.TAURI_SIGNING_PRIVATE_KEY || '',
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '',
};
delete process.env.TAURI_SIGNING_PRIVATE_KEY;
delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
const npm = windows ? 'npm.cmd' : 'npm';
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
  if (!['win32', 'darwin'].includes(process.platform) || (!windows && process.arch !== 'arm64')) throw new Error('Windows x64 or Apple Silicon runner required');
  if (!signing.TAURI_SIGNING_PRIVATE_KEY || !signing.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) throw new Error('update signing key missing');
  if (!/^[a-f0-9]{40}$/i.test(process.env.LUMAWB_SOURCE_COMMIT || '')) throw new Error('invalid source revision');
  phase = 'Verify checked out revision';
  const revision = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: desktop, encoding: 'utf8', windowsHide: true });
  if (revision.status !== 0 || revision.stdout.trim().toLowerCase() !== process.env.LUMAWB_SOURCE_COMMIT.toLowerCase()) throw new Error('wrong checkout');
  console.log(`Passed: ${phase}`);
  // npm.cmd is a Windows shim; this invocation has fixed, non-interpolated args.
  run('Install frontend dependencies', npm, ['ci'], { shell: windows });
  run('Prepare checked model and runtime', process.execPath, ['scripts/prepare-runtime.mjs', '--target', target]);
  run('Build frontend', npm, ['run', 'build'], { shell: windows });
  if (process.env.LUMAWB_RUN_TESTS === 'true') {
    run('Core tests', 'cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features', '--target', target]);
    run('Python reference parity', 'cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features', '--target', target, '--test', 'core_parity', '--', '--ignored']);
    run('Build real HTTP API', 'cargo', ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features', '--bin', 'lumawb-api', '--target', target]);
    run('Offline HTTP integration', process.execPath, ['scripts/http-smoke.mjs', '--binary', join(targetRoot, target, 'debug', windows ? 'lumawb-api.exe' : 'lumawb-api')]);
    if (windows) {
      // Report the runner's accelerator result; this prints only JSON status.
      phase = 'Accelerator check';
      const api = join(targetRoot, target, 'debug', 'lumawb-api.exe');
      const runtime = join(desktop, 'src-tauri', 'resources', 'native', 'win32-x64', 'onnxruntime.dll');
      const resources = join(desktop, 'src-tauri', 'resources');
      for (const extra of [[], ['--include-software-adapter']]) {
        const detect = spawnSync(api, ['--detect-accelerator', ...extra], { encoding: 'utf8', windowsHide: true });
        console.log(`Accelerator detection ${extra.join(' ') || '(hardware only)'}: ${(detect.stdout || '').trim() || 'failed'}`);
      }
      const probe = spawnSync(api, ['--try-accelerator', '--include-software-adapter', '--resources', resources, '--runtime', runtime, '--threads', '2'], { encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000 });
      const line = (probe.stdout || '').trim().split(/\r?\n/).pop() || '';
      console.log(`DirectML load on the runner's software adapter: ${/^\{.*\}$/.test(line) ? line : 'no result (exit ' + probe.status + ')'}`);
    }
  } else {
    console.log('Skipped: tests (run the workflow with run_tests for parity and HTTP integration).');
  }
  run('Build installer and signed update', process.execPath, ['scripts/build-release.mjs', '--target', target], { env: { ...process.env, ...signing } });

  phase = 'Validate installer artifacts';
  const source = join(desktop, 'release-artifacts', platformName);
  const allowed = windows
    ? ['Lumawb-Desktop-win32-x64-setup.exe', 'Lumawb-Desktop-win32-x64-setup.exe.sig']
    : ['Lumawb-Desktop-darwin-arm64.app.zip', 'Lumawb-Desktop-darwin-arm64.app.tar.gz', 'Lumawb-Desktop-darwin-arm64.app.tar.gz.sig'];
  const checksums = await readFile(join(source, 'SHA256SUMS.txt'), 'utf8');
  const expected = new Map();
  for (const line of checksums.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || !allowed.includes(match[2])) throw new Error('invalid checksum manifest');
    expected.set(match[2], match[1].toLowerCase());
  }
  if (allowed.some(name => !expected.has(name))) throw new Error('missing installer or signed update file');
  await mkdir(output, { recursive: true });
  for (const name of allowed) {
    const path = join(source, name);
    if (!(await stat(path)).isFile()) throw new Error('not a regular file');
    const bytes = await readFile(path);
    if (name.endsWith('.exe') && (bytes[0] !== 0x4d || bytes[1] !== 0x5a)) throw new Error('not a PE installer');
    if (name.endsWith('.sig') && !/^[A-Za-z0-9+/=\s]+$/.test(bytes.toString('utf8'))) throw new Error('invalid update signature');
    if (createHash('sha256').update(bytes).digest('hex') !== expected.get(name)) throw new Error('artifact hash mismatch');
    await copyFile(path, join(output, name));
  }
  await copyFile(join(source, 'SHA256SUMS.txt'), join(output, 'SHA256SUMS.txt'));
  console.log(`Passed: ${phase}; ${allowed.join(', ')}.`);
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
