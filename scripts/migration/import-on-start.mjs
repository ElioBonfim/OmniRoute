import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

if (process.env.MIGRATION_IMPORT_ON_START !== 'true') process.exit(0);

const dataDir = resolve(process.env.DATA_DIR || '/app/data');
const transferUrl = process.env.MIGRATION_TRANSFER_URL;
const transferToken = process.env.MIGRATION_TRANSFER_TOKEN;
const expectedSha = process.env.MIGRATION_ARCHIVE_SHA256?.toLowerCase();
const allowedRoots = new Set([
  'storage.sqlite',
  'cli-token-salt.json',
  'chatgpt-web-codex-omniroute',
  'tls-client',
  'agent-router',
  'call_logs',
]);

if (!transferUrl || !transferToken || !/^[a-f0-9]{64}$/.test(expectedSha || '')) {
  throw new Error('Migration settings are incomplete.');
}

const markerPath = join(dataDir, `.migration-imported-${expectedSha.slice(0, 16)}`);
if (await exists(markerPath)) {
  console.log('Migration archive already imported.');
  process.exit(0);
}

const workDir = join(dataDir, '.migration-work');
const archivePath = join(workDir, 'archive.tar.zst');
const tarPath = join(workDir, 'archive.tar');
const stageDir = join(workDir, 'stage');
const backupDir = join(dataDir, `.pre-migration-${Date.now()}`);

await rm(workDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });

console.log('Downloading migration archive.');
const response = await fetch(transferUrl, {
  headers: { Authorization: `Bearer ${transferToken}` },
  signal: AbortSignal.timeout(30 * 60 * 1000),
});
if (!response.ok || !response.body) {
  throw new Error(`Migration download failed with HTTP ${response.status}.`);
}
await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath, { mode: 0o600 }));

const hash = createHash('sha256');
for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
if (hash.digest('hex') !== expectedSha) {
  throw new Error('Migration archive checksum mismatch.');
}

console.log('Extracting migration archive.');
await pipeline(createReadStream(archivePath), createZstdDecompress(), createWriteStream(tarPath, { mode: 0o600 }));
await validateTarEntries(tarPath);
await run('tar', ['--no-same-owner', '--no-same-permissions', '-xf', tarPath, '-C', stageDir]);

const stageRoots = await readdir(stageDir);
if (!stageRoots.includes('storage.sqlite')) {
  throw new Error('Migration archive has no storage.sqlite.');
}
for (const root of stageRoots) {
  if (!allowedRoots.has(root)) throw new Error(`Unexpected migration root: ${root}`);
  if (!resolve(stageDir, root).startsWith(stageDir + sep)) throw new Error('Unsafe migration path.');
}

const database = new DatabaseSync(join(stageDir, 'storage.sqlite'), { readOnly: true });
const quickCheck = database.prepare('PRAGMA quick_check').get().quick_check;
database.close();
if (quickCheck !== 'ok') throw new Error('Migrated SQLite database failed quick_check.');

await mkdir(backupDir, { recursive: true });
const backedUp = [];
const promoted = [];
try {
  for (const root of stageRoots) {
    const destination = join(dataDir, root);
    if (await exists(destination)) {
      await rename(destination, join(backupDir, root));
      backedUp.push(root);
    }
  }
  for (const root of stageRoots) {
    await rename(join(stageDir, root), join(dataDir, root));
    promoted.push(root);
  }
} catch (error) {
  for (const root of promoted.reverse()) {
    await rm(join(dataDir, root), { recursive: true, force: true });
  }
  for (const root of backedUp.reverse()) {
    await rename(join(backupDir, root), join(dataDir, root));
  }
  throw error;
}

await writeFile(markerPath, `${expectedSha}\n`, { mode: 0o600 });
await rm(workDir, { recursive: true, force: true });
const dbSize = (await stat(join(dataDir, 'storage.sqlite'))).size;
console.log(`Migration import complete. SQLite bytes: ${dbSize}.`);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} failed (${signal || code}).`));
    });
  });
}

async function validateTarEntries(path) {
  const child = spawn('tar', ['-tf', path], { stdio: ['ignore', 'pipe', 'inherit'] });
  const completed = new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`tar listing failed (${signal || code}).`));
    });
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let unsafe = false;
  for await (const line of lines) {
    const normalized = line.replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized) continue;
    const parts = normalized.split('/');
    if (line.startsWith('/') || parts.includes('..') || !allowedRoots.has(parts[0])) {
      unsafe = true;
      child.kill('SIGTERM');
      break;
    }
  }
  if (unsafe) {
    await completed.catch(() => {});
    throw new Error('Migration archive contains an unsafe path.');
  }
  await completed;
}
