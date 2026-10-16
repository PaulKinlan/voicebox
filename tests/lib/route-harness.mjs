// tests/lib/route-harness.mjs — lightweight in-process route test harness (voicebox-beads-ybwq).
//
// Allows individual route handlers in lib/routes/*.mjs to be tested in the fast unit lane (<5ms)
// without starting an HTTP server, opening TCP sockets, or creating child processes.

import { Readable } from "node:stream";

/**
 * Standard JSON response helper matching server.mjs json(res, status, body) signature.
 */
export function mockJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
  return body;
}

/**
 * In-memory Mock Request extending Readable stream so stream-reading helpers
 * (like readJsonBody) function seamlessly without socket overhead.
 */
export class MockRequest extends Readable {
  constructor({
    method = "GET",
    url = "/",
    headers = {},
    body = null,
  } = {}) {
    super();
    this.method = String(method).toUpperCase();
    this.url = url;
    this.headers = {};
    for (const [k, v] of Object.entries(headers)) {
      this.headers[k.toLowerCase()] = String(v);
    }

    let payload = null;
    if (body !== null && body !== undefined) {
      if (typeof body === "string" || Buffer.isBuffer(body)) {
        payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
        if (!this.headers["content-type"]) {
          this.headers["content-type"] = "application/octet-stream";
        }
      } else if (typeof body === "object") {
        const jsonStr = JSON.stringify(body);
        payload = Buffer.from(jsonStr);
        if (!this.headers["content-type"]) {
          this.headers["content-type"] = "application/json";
        }
      }
      this.headers["content-length"] = String(payload.length);
    }

    this._payload = payload;
    this._pushed = false;
  }

  _read() {
    if (!this._pushed) {
      this._pushed = true;
      if (this._payload && this._payload.length > 0) {
        this.push(this._payload);
      }
      this.push(null);
    }
  }
}

/**
 * In-memory Mock Response capturing status, headers, and buffered body.
 */
export class MockResponse {
  constructor(onEnd) {
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.finished = false;
    this._chunks = [];
    this._onEnd = onEnd;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = Number(statusCode);
    for (const [k, v] of Object.entries(headers)) {
      this.headers[k.toLowerCase()] = String(v);
    }
    this.headersSent = true;
    return this;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
  }

  getHeader(name) {
    return this.headers[String(name).toLowerCase()];
  }

  hasHeader(name) {
    return Object.prototype.hasOwnProperty.call(this.headers, String(name).toLowerCase());
  }

  removeHeader(name) {
    delete this.headers[String(name).toLowerCase()];
  }

  write(chunk) {
    if (chunk) {
      this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return true;
  }

  end(chunk) {
    if (this.finished) return this;
    if (chunk) {
      this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.finished = true;
    this.headersSent = true;
    const bodyBuffer = Buffer.concat(this._chunks);
    const bodyText = bodyBuffer.toString("utf8");

    if (typeof this._onEnd === "function") {
      this._onEnd({
        status: this.statusCode,
        headers: { ...this.headers },
        body: bodyText,
        buffer: bodyBuffer,
        json: () => {
          try {
            return JSON.parse(bodyText);
          } catch (e) {
            throw new Error(`Failed to parse JSON response (${this.statusCode}): ${bodyText}\n${e.message}`);
          }
        },
      });
    }
    return this;
  }
}

/**
 * Standard helper simulating server.mjs readJsonBody for route testing without full server dependency.
 */
export async function mockReadJsonBody(req, res, maxBytes = 1024 * 1024) {
  return new Promise((resolve) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, refused: "body-too-large" }));
        resolve(null);
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (res.finished) return;
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, refused: "bad-request", why: "body must be JSON" }));
        resolve(null);
      }
    });
  });
}

/**
 * Dispatches an in-memory request to a route table or handler function.
 *
 * @param {Record<string, Function> | Function} routesOrHandler
 * @param {object} options
 * @param {string} [options.method="GET"]
 * @param {string} [options.url="/"]
 * @param {Record<string, string>} [options.query]
 * @param {Record<string, string>} [options.headers]
 * @param {any} [options.body]
 * @param {object} [options.context]
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string, buffer: Buffer, json: () => any }>}
 */
export async function invokeRoute(routesOrHandler, {
  method = "GET",
  url = "/",
  query = null,
  headers = {},
  body = null,
  context = {},
} = {}) {
  const normMethod = String(method).toUpperCase();
  const parsedUrl = new URL(url, "http://127.0.0.1");

  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      parsedUrl.searchParams.set(k, String(v));
    }
  }

  const reqUrl = parsedUrl.pathname + parsedUrl.search;
  const req = new MockRequest({
    method: normMethod,
    url: reqUrl,
    headers,
    body,
  });
  Object.assign(req, context);

  return new Promise(async (resolve, reject) => {
    const res = new MockResponse(resolve);

    let handler = null;
    if (typeof routesOrHandler === "function") {
      handler = routesOrHandler;
    } else if (routesOrHandler && typeof routesOrHandler === "object") {
      const routeKey = `${normMethod} ${parsedUrl.pathname}`;
      handler = routesOrHandler[routeKey];
    }

    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, refused: "not-found", why: `No route matching ${normMethod} ${parsedUrl.pathname}` }));
      return;
    }

    try {
      const outcome = await handler(req, res, parsedUrl);
      // If handler returned without calling res.end() (e.g. returned a value or undefined)
      if (!res.finished) {
        if (outcome !== undefined && outcome !== null && typeof outcome === "object") {
          mockJson(res, res.statusCode || 200, outcome);
        } else {
          res.end(typeof outcome === "string" ? outcome : "");
        }
      }
    } catch (err) {
      if (!res.finished) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, refused: "server-error", why: err.message }));
      } else {
        reject(err);
      }
    }
  });
}
