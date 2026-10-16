// tests/route-harness.test.mjs — unit tests for in-process route harness (voicebox-beads-ybwq)

import test from "node:test";
import assert from "node:assert/strict";
import { invokeRoute, mockJson, mockReadJsonBody } from "./lib/route-harness.mjs";

test("route-harness: invokeRoute dispatches by method and path", async () => {
  const routes = {
    "GET /api/test": (_req, res) => mockJson(res, 200, { ok: true, name: "get" }),
    "POST /api/test": (_req, res) => mockJson(res, 201, { ok: true, name: "post" }),
  };

  const getRes = await invokeRoute(routes, { method: "GET", url: "/api/test" });
  assert.equal(getRes.status, 200);
  assert.deepEqual(getRes.json(), { ok: true, name: "get" });

  const postRes = await invokeRoute(routes, { method: "POST", url: "/api/test" });
  assert.equal(postRes.status, 201);
  assert.deepEqual(postRes.json(), { ok: true, name: "post" });
});

test("route-harness: returns 404 for unmatched routes", async () => {
  const routes = {
    "GET /api/known": (_req, res) => mockJson(res, 200, { ok: true }),
  };

  const res = await invokeRoute(routes, { method: "GET", url: "/api/unknown" });
  assert.equal(res.status, 404);
  assert.equal(res.json().refused, "not-found");
});

test("route-harness: passes parsed URL and query parameters", async () => {
  const routes = {
    "GET /api/query": (_req, res, url) => {
      return mockJson(res, 200, {
        ok: true,
        filter: url.searchParams.get("filter"),
        limit: url.searchParams.get("limit"),
      });
    },
  };

  const res = await invokeRoute(routes, {
    method: "GET",
    url: "/api/query",
    query: { filter: "active", limit: "10" },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, filter: "active", limit: "10" });
});

test("route-harness: stream request body and mockReadJsonBody helper", async () => {
  const routes = {
    "POST /api/echo": async (req, res) => {
      const data = await mockReadJsonBody(req, res);
      return mockJson(res, 200, { ok: true, received: data });
    },
  };

  const res = await invokeRoute(routes, {
    method: "POST",
    url: "/api/echo",
    body: { hello: "world", count: 42 },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), {
    ok: true,
    received: { hello: "world", count: 42 },
  });
});

test("route-harness: handles direct function handlers and context injection", async () => {
  const directHandler = (req, res) => {
    return mockJson(res, 200, { ok: true, user: req.user });
  };

  const res = await invokeRoute(directHandler, {
    method: "GET",
    url: "/any",
    context: { user: "alice" },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json().user, "alice");
});
