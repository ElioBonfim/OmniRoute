import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const runnerCli = dockerfile.split('FROM runner-base AS runner-cli')[1] ?? '';

test('runner-cli ships the Playwright Chromium used by browser providers', () => {
  assert.match(runnerCli, /PLAYWRIGHT_BROWSERS_PATH=\/home\/node\/\.cache\/ms-playwright/);
  assert.match(runnerCli, /playwright\/cli\.js install chromium --with-deps/);
  assert.match(runnerCli, /chown -R node:node \/home\/node\/\.cache/);
});

test('container health check resumes normal startup timing', () => {
  assert.match(dockerfile, /HEALTHCHECK[^\n]*--start-period=15s/);
  assert.doesNotMatch(dockerfile, /HEALTHCHECK[^\n]*--start-period=20m/);
});
