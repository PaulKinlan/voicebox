import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactObject } from "../lib/redact.mjs";

test("redactSecrets: removes sensitive credentials, tokens and keys", () => {
  const sample = "Error connecting: Bearer sec_tok_1234567890abcdef at https://api.anthropic.com";
  assert.equal(redactSecrets(sample), "Error connecting: [redacted] at https://api.anthropic.com");

  const apiKeySample = 'Connecting with api_key="sk-ant-api03-verysecretstring12345"';
  assert.equal(redactSecrets(apiKeySample), 'Connecting with api_key="[redacted]"');

  const rawKeySample = "Using provider key sk-ant-secret123456789 and AIzaSyD_fixture12345678";
  assert.equal(redactSecrets(rawKeySample), "Using provider key [redacted] and [redacted]");

  const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----";
  assert.equal(redactSecrets(privateKey), "[redacted]");
});

test("redactSecrets: strips ambient environment secrets", () => {
  const origKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-live-super-secret-anthropic-key-999";
  try {
    const text = "Process failed with key sk-live-super-secret-anthropic-key-999 in trace";
    assert.doesNotMatch(redactSecrets(text), /sk-live-super-secret-anthropic-key-999/);
    assert.match(redactSecrets(text), /\[redacted\]/);
  } finally {
    if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = origKey;
  }
});

test("redactObject: deeply sanitizes nested object structures", () => {
  const data = {
    agent: "claude-code",
    config: {
      apiKey: "sk-secret-12345",
      token: "secret-token-val",
    },
    items: [
      "Normal text",
      "Authorization: Bearer secret-auth-token-12345",
    ],
  };

  const clean = redactObject(data);
  assert.equal(clean.agent, "claude-code");
  assert.equal(clean.config.apiKey, "[redacted]");
  assert.equal(clean.config.token, "[redacted]");
  assert.equal(clean.items[0], "Normal text");
  assert.match(clean.items[1], /\[redacted\]/);
});
