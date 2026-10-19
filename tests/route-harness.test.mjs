// tests/route-harness.test.mjs — unit tests for in-process route harness (voicebox-beads-ybwq)

import test from "node:test";
import assert from "node:assert/strict";
import {
  invokeRoute,
  mockJson,
  mockReadJsonBody,
  MockRequest,
  MockResponse,
  BodyRefusal,
} from "./lib/route-harness.mjs";

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
    headers: { "content-type": "application/json" },
    body: { hello: "world", count: 42 },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), {
    ok: true,
    received: { hello: "world", count: 42 },
  });
});

test("route-harness: mockReadJsonBody refuses an absent Content-Type even for an empty body", async () => {
  const req = new MockRequest({ method: "POST", url: "/api/echo" });
  let response;
  const res = new MockResponse((outcome) => { response = outcome; });
  await assert.rejects(() => mockReadJsonBody(req, res), BodyRefusal);
  assert.equal(res.statusCode, 415);
  assert.equal(JSON.parse(response.body).refused, "unsupported-content-type");
});

test("route-harness: mockReadJsonBody refuses non-JSON content-type with 415", async () => {
  const routes = {
    "POST /api/echo": async (req, res) => {
      const data = await mockReadJsonBody(req, res);
      return mockJson(res, 200, { ok: true, received: data });
    },
  };

  const res = await invokeRoute(routes, {
    method: "POST",
    url: "/api/echo",
    headers: { "content-type": "text/plain" },
    body: "not json",
  });

  assert.equal(res.status, 415);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.refused, "unsupported-content-type");
});

test("route-harness: mockReadJsonBody resolves null on malformed JSON", async () => {
  const routes = {
    "POST /api/echo": async (req, res) => {
      const data = await mockReadJsonBody(req, res);
      if (data === null) {
        return mockJson(res, 400, { ok: false, refused: "bad-request", why: "malformed JSON" });
      }
      return mockJson(res, 200, { ok: true, received: data });
    },
  };

  const res = await invokeRoute(routes, {
    method: "POST",
    url: "/api/echo",
    headers: { "content-type": "application/json" },
    body: "{ malformed json",
  });

  assert.equal(res.status, 400);
  assert.equal(res.json().why, "malformed JSON");
});

test("route-harness: mockReadJsonBody rejects with BodyRefusal and returns 413 on oversize body (voicebox-beads-hyks)", async () => {
  const req = new MockRequest({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { hello: "world-overflowing-the-cap" },
  });
  let responseData = null;
  const res = new MockResponse((outcome) => {
    responseData = outcome;
  });

  await assert.rejects(
    () => mockReadJsonBody(req, res, 10),
    (err) => {
      assert.ok(err instanceof BodyRefusal);
      assert.equal(err.refusal, "body-too-large");
      return true;
    }
  );

  assert.equal(res.statusCode, 413);
  const json = JSON.parse(responseData.body);
  assert.equal(json.ok, false);
  assert.equal(json.refused, "body-too-large");
  assert.match(json.why, /at most 10 bytes/);

  // Also assert end-to-end behavior when dispatched via invokeRoute
  const invokedRes = await invokeRoute(
    async (r, s) => {
      await mockReadJsonBody(r, s, 10);
    },
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { hello: "world-overflowing-the-cap" },
    }
  );
  assert.equal(invokedRes.status, 413);
  assert.equal(invokedRes.json().refused, "body-too-large");
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
