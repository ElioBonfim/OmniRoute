import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { createZstdCompress } from 'node:zlib';

const scriptPath = fileURLToPath(new URL('../../scripts/migration/import-on-start.mjs', import.meta.url));

test('imports one checked archive and keeps the old data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omniroute-import-'));
  const payload = join(root, 'payload');
  const data = join(root, 'data');
  const tarPath = join(root, 'payload.tar');
  const archivePath = join(root, 'payload.tar.zst');
  await mkdir(payload);
  await mkdir(data);

  const db = new DatabaseSync(join(payload, 'storage.sqlite'));
  db.exec('CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES (\'migrated\');');
  db.close();
  await writeFile(join(payload, 'cli-token-salt.json'), '{"salt":"test"}\n');
  await writeFile(join(data, 'storage.sqlite'), 'old-data');

  await run('tar', ['-cf', tarPath, '-C', payload, '.']);
  await pipeline(createReadStream(tarPath), createZstdCompress(), createWriteStream(archivePath));
  const expectedSha = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  const token = 'test-token';
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { 'content-length': String((await readFile(archivePath)).length) });
    createReadStream(archivePath).pipe(response);
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));

  try {
    const port = server.address().port;
    const env = {
      ...process.env,
      DATA_DIR: data,
      MIGRATION_IMPORT_ON_START: 'true',
      MIGRATION_TRANSFER_URL: `http://127.0.0.1:${port}/stage`,
      MIGRATION_TRANSFER_TOKEN: token,
      MIGRATION_ARCHIVE_SHA256: expectedSha,
    };
    const first = await run(process.execPath, [scriptPath], { env, capture: true });
    assert.match(first, /Migration import complete/);

    const migrated = new DatabaseSync(join(data, 'storage.sqlite'), { readOnly: true });
    assert.equal(migrated.prepare('SELECT value FROM sample').get().value, 'migrated');
    migrated.close();
    const backup = (await readdir(data)).find((name) => name.startsWith('.pre-migration-'));
    assert.equal(await readFile(join(data, backup, 'storage.sqlite'), 'utf8'), 'old-data');

    const second = await run(process.execPath, [scriptPath], { env, capture: true });
    assert.match(second, /already imported/);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let output = '';
    if (options.capture) {
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
    }
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise(output);
      else rejectPromise(new Error(`${command} failed (${signal || code}): ${output}`));
    });
  });
}
