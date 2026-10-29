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
    hasExtensionAuthority: () => true,
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

test("branches-route: POST /api/branches/merge requires host-token or session authority (voicebox-beads-gi60)", async () => {
  // The authority seam mirrors hasExtensionAuthority in server.mjs: host token, in-room session
  // token, or the room's own page origin. The stub reads exactly those headers so the drive is
  // about the ROUTE's wall, not a constant.
  const authorized = (req) =>
    req.headers["x-voicebox-host-token"] === "host-secret" ||
    req.headers["x-voicebox-session-token"] === "room-secret";
  const routes = createBranchRoutes({
    repoRoot: "/mock/repo",
    json: mockJson,
    readJsonBody: mockReadJsonBody,
    answerOnce: (_res, fn) => fn(),
    hasExtensionAuthority: authorized,
  });

  // No credentials at all: refused before the body is read and before any git runs.
  const resAnonymous = await invokeRoute(routes, {
    method: "POST",
    url: "/api/branches/merge",
    body: { branch: "feat/anything" },
  });
  assert.equal(resAnonymous.status, 403);
  const anonymousBody = resAnonymous.json();
  assert.equal(anonymousBody.ok, false);
  assert.equal(anonymousBody.refused, "host-token-required");
  assert.match(anonymousBody.why, /landing a branch merges it into the repository/);

  // Wrong credentials are the same refusal.
  const resWrong = await invokeRoute(routes, {
    method: "POST",
    url: "/api/branches/merge",
    headers: { "x-voicebox-host-token": "not-the-host-secret" },
    body: { branch: "feat/anything" },
  });
  assert.equal(resWrong.status, 403);
  assert.equal(resWrong.json().refused, "host-token-required");

  // The real host token passes the wall: the request reaches the landing seam, which answers for
  // the (nonexistent) repo — proof the route got past authority to the lander itself.
  const resHost = await invokeRoute(routes, {
    method: "POST",
    url: "/api/branches/merge",
    headers: { "x-voicebox-host-token": "host-secret" },
    body: { branch: "feat/anything" },
  });
  // The merge route maps every lander refusal to 409; reaching it proves authority passed.
  assert.equal(resHost.status, 409);
  assert.equal(resHost.json().refused, "not-a-git-repo");

  // The in-room session token is the second door, same seam.
  const resSession = await invokeRoute(routes, {
    method: "POST",
    url: "/api/branches/merge",
    headers: { "x-voicebox-session-token": "room-secret" },
    body: { branch: "feat/anything" },
  });
  assert.equal(resSession.status, 409);
  assert.equal(resSession.json().refused, "not-a-git-repo");
});

test("branches-route: merge route is fail-closed when wired without an authority seam (voicebox-beads-gi60)", async () => {
  // No hasExtensionAuthority passed at all: the default must close the door, not open it.
  const routes = createBranchRoutes({
    repoRoot: "/mock/repo",
    json: mockJson,
    readJsonBody: mockReadJsonBody,
    answerOnce: (_res, fn) => fn(),
  });

  const res = await invokeRoute(routes, {
    method: "POST",
    url: "/api/branches/merge",
    body: { branch: "feat/anything" },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json().refused, "host-token-required");
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
