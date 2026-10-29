import test from "node:test";
import assert from "node:assert/strict";
import { getTierProgress } from "../src/domain/membership-tiers.mjs";

test("tier progress shows each active requirement and a stable percentage", () => {
  const result = getTierProgress("plus", { verified_profile: true, months_active: 2, eligible_activity_count: 25 });
  assert.equal(result.currentTier, "Plus");
  assert.equal(result.nextTier, "Premier");
  assert.equal(result.qualified, false);
  assert.equal(result.requirements.length, 3);
  assert.equal(result.requirements[1].progressPercent, 17);
  assert.equal(result.requirements[2].met, true);
});

test("top tier has no next-tier requirements", () => {
  assert.deepEqual(getTierProgress("premier", {}), {
    currentTier: "Premier", nextTier: null, progressPercent: 100, requirements: [], qualified: true
  });
});

test("unknown tiers are rejected", () => {
  assert.throws(() => getTierProgress("platinum", {}), TypeError);
});
