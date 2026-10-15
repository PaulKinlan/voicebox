import test from "node:test";
import assert from "node:assert/strict";
import { classifySuiteConditions } from "../scripts/suite-condition-verdict.mjs";

const measurements = (standalone, heavy_slot, shard_concurrency) => Object.fromEntries(
  Object.entries({ standalone, heavy_slot, shard_concurrency }).map(([name, status]) => [name, { status }]),
);

test("one named suite must be green in all three measured conditions", () => {
  const suite = "tests/example.test.mjs";
  assert.equal(classifySuiteConditions(suite, measurements("passed", "passed", "passed")).verdict, "passed");
  const flaky = classifySuiteConditions(suite, measurements("passed", "failed", "passed"));
  assert.equal(flaky.verdict, "suite-defect");
  assert.match(flaky.reason, /tests\/example\.test\.mjs.*heavy_slot=failed.*suite is the defect/);
  assert.equal(classifySuiteConditions(suite, measurements("failed", "failed", "failed")).verdict, "suite-defect");
});

test("missing, killed or unmeasured arms never become green", () => {
  const suite = "tests/example.test.mjs";
  assert.match(classifySuiteConditions(suite, { standalone: { status: "passed" } }).reason, /incomplete.*heavy_slot, shard_concurrency/);
  assert.equal(classifySuiteConditions(suite, measurements("passed", "timeout", "passed")).verdict, "unknown");
  assert.equal(classifySuiteConditions(suite, measurements("passed", "unknown", "passed")).verdict, "unknown");
  assert.equal(classifySuiteConditions(suite, measurements("passed", "made-up", "passed")).verdict, "unknown");
});
