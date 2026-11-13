import assert from "node:assert/strict";
import test from "node:test";
import { applyLossyRequestPolicy } from "../../../open-sse/services/compression/lossyRequestPolicy.ts";
import type { DerivedPlan } from "../../../open-sse/services/compression/deriveDefaultPlan.ts";

const lossyProfile: DerivedPlan = {
  mode: "stacked",
  source: "active-profile",
  stackedPipeline: [
    { engine: "rtk", intensity: "standard" },
    { engine: "caveman", intensity: "full" },
  ],
};

test("an explicitly selected active profile is honored without a client header", () => {
  assert.equal(applyLossyRequestPolicy(lossyProfile, null), lossyProfile);
  assert.equal(applyLossyRequestPolicy(lossyProfile, "  "), lossyProfile);
});

for (const source of ["default", "auto-trigger", "routing-override"] as const) {
  test(`${source} still requires request opt-in for lossy engines`, () => {
    const plan = applyLossyRequestPolicy({ ...lossyProfile, source }, null);
    assert.deepEqual(plan.stackedPipeline, [{ engine: "session-dedup" }, { engine: "lite" }]);
  });
}

for (const header of ["safe", "default", "off", "unknown-profile", " SAFE "]) {
  test(`an active profile does not override the client header ${header}`, () => {
    const plan = applyLossyRequestPolicy(lossyProfile, header);
    assert.deepEqual(plan.stackedPipeline, [{ engine: "session-dedup" }, { engine: "lite" }]);
  });
}

test("default path replaces a lossy default plan with dedup and whitespace folding", () => {
  const plan = applyLossyRequestPolicy({ ...lossyProfile, source: "default" }, null);
  assert.equal(plan.mode, "stacked");
  assert.deepEqual(plan.stackedPipeline, [{ engine: "session-dedup" }, { engine: "lite" }]);
});

test("allow-lossy keeps the operator profile for this request", () => {
  const plan = applyLossyRequestPolicy(lossyProfile, "allow-lossy");
  assert.deepEqual(plan.stackedPipeline, lossyProfile.stackedPipeline);
});

test("engine header is the opt-in for that engine", () => {
  const plan = applyLossyRequestPolicy(
    {
      mode: "rtk",
      source: "request-header",
      stackedPipeline: [],
    },
    "engine:rtk"
  );
  assert.equal(plan.mode, "rtk");
});

test("a safe stacked plan is left as-is", () => {
  const safe: DerivedPlan = {
    mode: "stacked",
    source: "default",
    stackedPipeline: [{ engine: "lite" }],
  };
  assert.equal(applyLossyRequestPolicy(safe, null), safe);
});
