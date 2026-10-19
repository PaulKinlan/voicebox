// tests/branches-route.test.mjs — in-process unit tests for candidate branch routes (voicebox-beads-ybwq)

import test from "node:test";
import assert from "node:assert/strict";
import { createBranchRoutes } from "../lib/routes/branches.mjs";
import { invokeRoute, mockJson, mockReadJsonBody } from "./lib/route-harness.mjs";

test("branches-route: GET /api/branches/candidates lists branches for active repo", async () => {
  const routes = createBranchRoutes({
    repoRoot: process.cwd(),
    json: mockJson,
    readJsonBody: mockReadJsonBody,
    answerOnce: (_res, fn) => fn(),
  });

  const res = await invokeRoute(routes, {
    method: "GET",
    url: "/api/branches/candidates",
    query: { baseBranch: "main" },
  });

  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.branches));
});

test("branches-route: GET /api/branches/candidates refuses non-git folder with 400 not-a-git-repo", async () => {
  const routes = createBranchRoutes({
    repoRoot: "/mock/nonexistent-repo",
    json: mockJson,
    readJsonBody: mockReadJsonBody,
    answerOnce: (_res, fn) => fn(),
  });

  const res = await invokeRoute(routes, {
    method: "GET",
    url: "/api/branches/candidates",
    query: { baseBranch: "main" },
  });

  assert.equal(res.status, 400);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.refused, "not-a-git-repo");
});

test("branches-route: GET /api/branches/diff requires branch parameter", async () => {
  const routes = createBranchRoutes({
    repoRoot: "/mock/repo",
    json: mockJson,
    readJsonBody: mockReadJsonBody,
    answerOnce: (_res, fn) => fn(),
  });

  const res = await invokeRoute(routes, {
    method: "GET",
    url: "/api/branches/diff",
  });

  assert.equal(res.status, 400);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.refused, "bad-request");
  assert.match(body.why, /branch query parameter is required/);
});

test("branches-route: POST /api/branches/merge validates JSON body and branch", async () => {
  const routes = createBranchRoutes({
    repoRoot: "/mock/repo",
    json: mockJson,
    readJsonBody: mockReadJsonBody,
    answerOnce: (_res, fn) => fn(),
  });

  // Missing body/branch
  const resMissing = await invokeRoute(routes, {
    method: "POST",
    url: "/api/branches/merge",
    body: {},
  });
  assert.equal(resMissing.status, 400);
  assert.equal(resMissing.json().refused, "bad-request");

  // An untyped empty body is refused at the shared JSON door before route validation.
  const resInvalid = await invokeRoute(routes, {
    method: "POST",
    url: "/api/branches/merge",
    body: null,
  });
  assert.equal(resInvalid.status, 415);
  assert.equal(resInvalid.json().refused, "unsupported-content-type");
});

test("branches-route: POST /api/branches/keep-separate validates branch field", async () => {
  const routes = createBranchRoutes({
    repoRoot: "/mock/repo",
    json: mockJson,
    readJsonBody: mockReadJsonBody,
    answerOnce: (_res, fn) => fn(),
  });

  const resMissing = await invokeRoute(routes, {
    method: "POST",
    url: "/api/branches/keep-separate",
    body: { note: "skip for now" },
  });
  assert.equal(resMissing.status, 400);
  assert.equal(resMissing.json().refused, "bad-request");
});
