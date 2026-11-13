/** Offline measurement of gateway RTK text transforms. Never calls a model/provider. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { get_encoding } from "tiktoken";
import {
  processRtkText,
  applyRtkCompression,
} from "../../open-sse/services/compression/engines/rtk/index.ts";
import { readRtkRawOutput } from "../../open-sse/services/compression/engines/rtk/rawOutput.ts";
import type { RtkConfig } from "../../open-sse/services/compression/types.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: node --import tsx/esm scripts/compression/vibe-toolkit-audit.ts --out FILE [--settings FILE] [--fixtures FILE]\nOffline only; settings is the sanitized compression namespace [[key,value],...]."
  );
  process.exit(0);
}
const option = (name: string) => args[args.indexOf(name) + 1];
if (!args.includes("--out")) throw new Error("--out is required");
const out = path.resolve(option("--out"));
const settings = args.includes("--settings")
  ? Object.fromEntries(JSON.parse(fs.readFileSync(option("--settings"), "utf8")))
  : {};
const liveConfig: Partial<RtkConfig> = settings.rtkConfig ?? {
  enabled: true,
  intensity: "minimal",
  maxLinesPerResult: 100000,
  maxCharsPerResult: 500000,
  customFiltersEnabled: false,
  rawOutputRetention: "never",
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "omni-vibe-audit-"));
const encoder = get_encoding("o200k_base");
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = path.join(temporary, "isolated-data");
type Sample = {
  name: string;
  command: string;
  origin: string;
  text: string;
  exitCode: number;
  critical: string[];
};
const samples: Sample[] = [];
function run(argv: string[]) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: temporary,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", NO_COLOR: "1" },
  });
  if (r.error || r.status === null) throw r.error ?? new Error(`No exit status: ${argv[0]}`);
  return { text: r.stdout + r.stderr, exitCode: r.status };
}
function git(...args: string[]) {
  const r = run([
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "user.name=Audit Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]);
  if (r.exitCode !== 0) throw new Error(r.text);
  return r;
}
function metrics(text: string) {
  return {
    bytes: Buffer.byteLength(text),
    lines: text.split(/\r?\n/).length,
    tokens: encoder.encode(text).length,
  };
}
try {
  git("init", "-b", "audit");
  fs.writeFileSync(path.join(temporary, "app.ts"), "export const safe = false;\n");
  git("add", "app.ts");
  git("commit", "-m", "Initial fixture");
  for (let i = 0; i < 12; i++) {
    fs.appendFileSync(path.join(temporary, "app.ts"), `// fixture ${i}\n`);
    git("commit", "-am", `Fixture ${i}`);
  }
  fs.appendFileSync(path.join(temporary, "app.ts"), "// Do not deploy without tenant validation\n");
  fs.writeFileSync(path.join(temporary, "security-policy.ts"), "// preserve untracked path\n");
  for (const command of ["status", "diff", "log"]) {
    samples.push({
      name: `git-${command}`,
      command: `git ${command}`,
      origin: "actual git in disposable repository",
      ...git(command),
      critical:
        command === "status"
          ? ["security-policy.ts", "app.ts"]
          : command === "diff"
            ? ["+// Do not deploy without tenant validation", "@@"]
            : ["Initial fixture", "Fixture 11"],
    });
  }
  fs.writeFileSync(
    path.join(temporary, "example.test.cjs"),
    "const {test}=require('node:test');const assert=require('node:assert/strict');for(let i=0;i<120;i++)test('passing '+i,()=>assert.equal(1,1));test('failing tenant check',()=>{throw new Error('SECURITY: do not deploy; /repo/auth.ts:27:3')});"
  );
  samples.push({
    name: "unit-tests-failure",
    command: "node --test",
    origin: "actual Node test runner: 120 passes, one intentional failure",
    ...run([process.execPath, "--test", "--test-reporter=tap", "example.test.cjs"]),
    critical: ["SECURITY: do not deploy; /repo/auth.ts:27:3", "# fail 1"],
  });
  samples.push({
    name: "build-diagnostics",
    command: "webpack",
    origin: "representative deterministic webpack output fixture; no build executed",
    text: [
      ...Array.from({ length: 80 }, (_, i) => `cacheable modules chunk ${i}`),
      "asset main.js 10 KiB",
      "WARNING in ./src/auth.ts 27:3",
      "Do not deploy unless the tenant check passes.",
      "Only administrators may bypass this check.",
      "Module not found: Cannot resolve ./policy",
      "  at /repo/src/auth.ts:27:3",
      "ERROR in ./src/config.ts 15:2",
      "webpack 5 compiled with 1 error and 1 warning",
    ].join("\n"),
    exitCode: 1,
    critical: [
      "Do not deploy unless the tenant check passes.",
      "Only administrators may bypass this check.",
      "at /repo/src/auth.ts:27:3",
      "ERROR in ./src/config.ts 15:2",
    ],
  });
  samples.push({
    name: "lint-diagnostics",
    command: "eslint .",
    origin: "representative deterministic ESLint fixture; no lint executed",
    text:
      Array.from(
        { length: 30 },
        (_, i) =>
          `/repo/src/module${i}.ts\n  ${i + 1}:3  warning  unused binding  no-unused-vars\n  ${i + 2}:7  error  forbidden access  no-restricted-syntax\n`
      ).join("\n") + "✖ 60 problems (30 errors, 30 warnings)\n",
    exitCode: 1,
    critical: ["/repo/src/module15.ts", "17:7  error", "60 problems"],
  });
  for (const exitCode of [2, 7])
    samples.push({
      name: `command-exit-${exitCode}`,
      command: "node failure.cjs",
      origin: "actual subprocess with intentional nonzero exit",
      ...run([
        process.execPath,
        "-e",
        `console.error('Error: denied at /repo/auth.ts:27:3');process.exit(${exitCode})`,
      ]),
      critical: ["Error: denied at /repo/auth.ts:27:3"],
    });
  const measure = (sample: Sample, config: Partial<RtkConfig>) => {
    const started = performance.now();
    const result = processRtkText(sample.text, { command: sample.command, config });
    const compressionMs = performance.now() - started;
    const before = metrics(sample.text);
    const after = metrics(result.text);
    const twice = processRtkText(result.text, { command: sample.command, config });
    return {
      name: sample.name,
      command: sample.command,
      origin: sample.origin,
      inputSha256: createHash("sha256").update(sample.text).digest("hex"),
      exitCode: sample.exitCode,
      before,
      after,
      reductionPercent: 100 * (1 - after.tokens / before.tokens),
      compressionMs,
      missingCritical: sample.critical.filter((x) => !result.text.includes(x)),
      rules: result.rulesApplied,
      secondPassChanged: twice.text !== result.text,
      engineEstimatedBefore: result.originalTokens,
      engineEstimatedAfter: result.compressedTokens,
    };
  };
  if (args.includes("--fixtures")) {
    const captured = JSON.parse(fs.readFileSync(option("--fixtures"), "utf8"));
    if (!Array.isArray(captured) || captured.length !== samples.length) {
      throw new Error("--fixtures must contain the captured text for the eight built-in cases");
    }
    // Reuse text only. Commands, labels, origins and expected diagnostics always come
    // from this script, so arbitrary fixture metadata cannot leak into the report.
    for (let index = 0; index < samples.length; index += 1) {
      if (typeof captured[index]?.text !== "string") throw new Error("Invalid fixture text");
      samples[index].text = captured[index].text;
    }
  }
  const rows = samples.map((sample) => measure(sample, liveConfig));
  const stress: Sample = {
    name: "adversarial-small-budget",
    command: "webpack",
    origin: "adversarial fixture; 2000-character budget, outside live settings",
    text: [
      ...Array.from({ length: 200 }, (_, i) => `asset module${i}.js ${"x".repeat(100)}`),
      "WARNING in ./src/security.ts 101:4",
      "Do not deploy unless all tenant checks pass.",
      "Only administrators may override this restriction.",
      "Traceback (most recent call last):",
      "  File /repo/src/security.py, line 101",
      "Exception: invalid tenant",
      ...Array.from({ length: 200 }, (_, i) => `asset tail${i}.js ${"y".repeat(100)}`),
    ].join("\n"),
    exitCode: 1,
    critical: [
      "WARNING in ./src/security.ts 101:4",
      "Do not deploy unless all tenant checks pass.",
      "Only administrators may override this restriction.",
      "File /repo/src/security.py, line 101",
      "Exception: invalid tenant",
    ],
  };
  const recovery = processRtkText(samples[3].text, {
    command: samples[3].command,
    config: { ...liveConfig, rawOutputRetention: "always" },
  });
  const pointer = recovery.rawOutputPointers?.[0];
  const recovered = pointer ? readRtkRawOutput(pointer.id) : null;
  const responses = {
    model: "gpt-6.1",
    input: [
      {
        type: "function_call",
        name: "exec_command",
        call_id: "audit_1",
        arguments: '{"cmd":"git status"}',
      },
      { type: "function_call_output", call_id: "audit_1", output: samples[0].text },
    ],
  };
  const envelope = applyRtkCompression(responses, { config: liveConfig });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        tokenizer: "tiktoken/o200k_base",
        runtime: process.version,
        scope: "offline text-token counts, not provider/session usage or billed savings",
        rows,
        stress: measure(stress, { ...liveConfig, maxCharsPerResult: 2000, maxLinesPerResult: 100 }),
        stressModuleNoise: measure(
          {
            ...stress,
            name: "adversarial-module-noise",
            text: stress.text.replace(/^asset /gm, "  ./src/"),
          },
          { ...liveConfig, maxCharsPerResult: 2000, maxLinesPerResult: 100 }
        ),
        recovery: {
          retentionTestOverride: "always",
          hasPointer: !!pointer,
          exactFixtureRecovered: recovered === samples[3].text,
          productionRetention: liveConfig.rawOutputRetention,
        },
        responses: {
          compressed: envelope.compressed,
          callIdPreserved: JSON.stringify(envelope.body).includes("audit_1"),
          untrackedPathPreserved: JSON.stringify(envelope.body).includes("security-policy.ts"),
        },
        sessionBenchmark: {
          status: "NÃO VALIDADO",
          reason:
            "No model calls executed: no measured session tokens, cost, quality, cache billing or actual client interception.",
        },
      },
      null,
      2
    ) + "\n"
  );
  console.log(
    JSON.stringify({
      out,
      cases: rows.length,
      missingCritical: rows.filter((x) => x.missingCritical.length),
      recoveryExact: recovered === samples[3].text,
    })
  );
} finally {
  encoder.free();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(temporary, { recursive: true, force: true });
}
