import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCategories } from "../src/server/classify.js";

test("normalizeCategories clamps scores and maps treatment spellings", () => {
  const out = normalizeCategories({
    lgbtq: { score: 3, treatment: "Matter-of-fact", notes: "a" },
    faith: { score: 7, treatment: "approving", notes: "b" },
    morals: { score: 0, treatment: "approving", notes: "c" },
    war: { score: 2, treatment: "not_present", notes: "d" },
    racism: { score: 2, treatment: "glorified", notes: "e" },
    violence: { score: 2.6, treatment: "critical", notes: "f" },
  });
  assert.deepEqual(out.lgbtq, { score: 3, treatment: "matter_of_fact", notes: "a" });
  assert.deepEqual(out.faith, { score: 5, treatment: "approving", notes: "b" });
  assert.equal(out.morals.treatment, "not_present");
  assert.equal(out.war.treatment, "matter_of_fact");
  assert.equal(out.racism.treatment, "matter_of_fact");
  // Categories without a treatment always get null.
  assert.deepEqual(out.violence, { score: 3, treatment: null, notes: "f" });
  // Missing categories default to score 0.
  assert.deepEqual(out.gods_name, { score: 0, treatment: null, notes: "" });
  assert.equal(out.spiritual.treatment, "not_present");
});
