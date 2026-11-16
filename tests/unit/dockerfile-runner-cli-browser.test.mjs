import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const runnerCli =
  dockerfile
    .split("FROM runner-base AS runner-cli-core")[1]
    ?.split("FROM runner-cli-core AS runner-cli-no-docker")[0] ?? "";

test("runner-cli ships the Playwright client for the browser sidecar", () => {
  assert.match(dockerfile, /FROM runner-base AS runner-cli-core/);
  assert.match(dockerfile, /FROM runner-cli-core AS runner-cli\s/);
  assert.match(
    runnerCli,
    /COPY --from=builder \/app\/node_modules\/playwright-core \.\/node_modules\/playwright-core/
  );
  assert.match(
    runnerCli,
    /COPY --from=builder \/app\/node_modules\/playwright \.\/node_modules\/playwright/
  );
  assert.doesNotMatch(runnerCli, /cli\.js install chromium/);
});

test("container health check resumes normal startup timing", () => {
  assert.match(dockerfile, /HEALTHCHECK[^\n]*--start-period=15s/);
  assert.doesNotMatch(dockerfile, /HEALTHCHECK[^\n]*--start-period=20m/);
});
