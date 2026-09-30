// tests/voice-extensions.test.mjs — Speech and typed turn commands to create/propose
// extensions and stage catalogue extensions (voicebox-beads-t1kj).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMANDS, COMMAND_VERBS, commandToAction, functionDeclarations } from "../lib/commands.mjs";
import { resolveTurn, script, validateModelAction, makeGeminiResolver } from "../lib/resolver.mjs";

test("COMMANDS declares propose_extension and commandToAction maps or refuses cleanly", () => {
  assert.ok(COMMAND_VERBS.has("propose_extension"), "COMMAND_VERBS must contain propose_extension");
  const cmd = COMMANDS.find((c) => c.name === "propose_extension");
  assert.ok(cmd, "propose_extension must be in COMMANDS");
  assert.equal(cmd.verb, "propose_extension");
  const decl = functionDeclarations().find((d) => d.name === "propose_extension");
  assert.ok(decl, "functionDeclarations must include propose_extension");
  assert.ok(decl.parameters.properties.catalogueId);
  assert.ok(decl.parameters.properties.primitive);

  // Refuses when catalogueId, id, and name are all missing
  const refused = commandToAction("propose_extension", {});
  assert.equal(refused.refused, "missing-argument");
  assert.match(refused.why, /catalogueId|id|name/);

  const refusedBlank = commandToAction("propose_extension", { id: "   " });
  assert.equal(refusedBlank.refused, "missing-argument");

  // Maps catalogueId
  const catAction = commandToAction("propose_extension", { catalogueId: "web-search" });
  assert.deepEqual(catAction, {
    verb: "propose_extension",
    name: "web-search",
    args: { catalogueId: "web-search" },
  });

  // Maps custom id/name
  const customArgs = {
    id: "weather-api",
    name: "Weather API",
    primitive: "http-get",
    toolName: "fetch_weather",
    host: "api.open-meteo.com",
  };
  const customAction = commandToAction("propose_extension", customArgs);
  assert.deepEqual(customAction, {
    verb: "propose_extension",
    name: "weather-api",
    args: customArgs,
  });
});

test("script resolver parses natural speech phrasings for installing and creating extensions", async () => {
  // 1. Catalogue / install phrasings
  for (const [utterance, expectedId] of [
    ["install extension web-search", "web-search"],
    ["load extension local-notes", "local-notes"],
    ["enable extension web-search", "web-search"],
    ["stage extension brave-search", "brave-search"],
    ["install the web-search extension", "web-search"],
  ]) {
    const action = await resolveTurn(utterance, "script");
    assert.deepEqual(action, {
      verb: "propose_extension",
      name: expectedId,
      args: { catalogueId: expectedId },
    });
    assert.deepEqual(script(utterance), action);
  }

  // 2. Read-file extension phrasings
  for (const [utterance, expectedId, expectedPath] of [
    ["create an extension called todo-reader that reads todo.md", "todo-reader", "todo.md"],
    ["create extension notes-reader to read notes/daily.txt", "notes-reader", "notes/daily.txt"],
  ]) {
    const action = await resolveTurn(utterance, "script");
    assert.deepEqual(action, {
      verb: "propose_extension",
      name: expectedId,
      args: {
        id: expectedId,
        name: expectedId,
        primitive: "read-file",
        defaultPath: expectedPath,
      },
    });
  }

  // 3. Write-file extension phrasings
  const writeAction = await resolveTurn("create an extension called log-writer that writes logs/app.log", "script");
  assert.deepEqual(writeAction, {
    verb: "propose_extension",
    name: "log-writer",
    args: {
      id: "log-writer",
      name: "log-writer",
      primitive: "write-file",
      defaultPath: "logs/app.log",
    },
  });

  // 4. HTTP-GET extension phrasings (full URL and bare host)
  const urlAction = await resolveTurn(
    "create an extension called weather-api that fetches https://api.open-meteo.com/v1/forecast",
    "script",
  );
  assert.deepEqual(urlAction, {
    verb: "propose_extension",
    name: "weather-api",
    args: {
      id: "weather-api",
      name: "weather-api",
      primitive: "http-get",
      host: "api.open-meteo.com",
      defaultUrl: "https://api.open-meteo.com/v1/forecast",
    },
  });

  const hostAction = await resolveTurn("create an extension called weather-api for api.open-meteo.com", "script");
  assert.deepEqual(hostAction, {
    verb: "propose_extension",
    name: "weather-api",
    args: {
      id: "weather-api",
      name: "weather-api",
      primitive: "http-get",
      host: "api.open-meteo.com",
      defaultUrl: "https://api.open-meteo.com",
    },
  });
});

test("validateModelAction and model resolvers map propose_extension through commandToAction", async () => {
  const valid = validateModelAction({
    verb: "propose_extension",
    catalogueId: "web-search",
  });
  assert.deepEqual(valid, {
    verb: "propose_extension",
    name: "web-search",
    args: { catalogueId: "web-search" },
  });

  const invalid = validateModelAction({ verb: "propose_extension" });
  assert.ok(invalid.unresolved);
  assert.match(invalid.unresolved, /catalogueId|id|name/);

  const resolve = makeGeminiResolver({
    key: "test-key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    verb: "propose_extension",
                    id: "weather-api",
                    name: "Weather API",
                    primitive: "http-get",
                    host: "api.open-meteo.com",
                  }),
                },
              ],
            },
          },
        ],
      }),
    }),
  });
  const fromModel = await resolve("create a weather api extension for api.open-meteo.com");
  assert.equal(fromModel.verb, "propose_extension");
  assert.equal(fromModel.name, "weather-api");
  assert.equal(fromModel.args.host, "api.open-meteo.com");
});

test("proposeExtensionFromTurn stages catalogue and custom extensions, passes reviewProposal, and admits via admitProposal", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-voice-ext-"));
  const rootDir = path.join(scratch, "workspace");
  const hostDir = path.join(scratch, "extensions");
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(hostDir, { recursive: true });

  const prevWs = process.env.VOICEBOX_WORKSPACE;
  const prevExt = process.env.VOICEBOX_EXTENSIONS_DIR;
  process.env.VOICEBOX_WORKSPACE = rootDir;
  process.env.VOICEBOX_EXTENSIONS_DIR = hostDir;

  try {
    const { proposeExtensionFromTurn, reviewProposal, admitProposal } = await import("../lib/extensions.mjs");

    // 1. Stage catalogue extension ("web-search") with approval code callback
    const issuedCodes = [];
    const catRes = proposeExtensionFromTurn(
      { catalogueId: "web-search" },
      {
        rootDir,
        hostDir,
        issueApprovalCode: (id, plan) => {
          issuedCodes.push({ id, decision: plan?.gate?.decision });
          return { code: "123456" };
        },
      },
    );
    assert.equal(catRes.ok, true);
    assert.equal(catRes.action, "proposed extension web-search");
    assert.equal(catRes.descriptor.id, "web-search");
    assert.equal(catRes.proposal.state, "pending");
    assert.equal(issuedCodes.length, 1);
    assert.equal(issuedCodes[0].id, "web-search");
    assert.equal(issuedCodes[0].decision, "admitted");
    assert.equal(existsSync(path.join(rootDir, "proposals", "web-search.json")), true);

    const catReview = reviewProposal("web-search", { rootDir, hostDir });
    assert.ok(catReview);
    assert.equal(catReview.ok, true);
    assert.equal(catReview.gate.decision, "admitted");

    const catAdmit = admitProposal("web-search", { rootDir, hostDir, decision: "admit" });
    assert.equal(catAdmit.ok, true);
    assert.equal(catAdmit.decision, "admitted");
    assert.equal(existsSync(path.join(hostDir, "web-search.json")), true);

    // 2. Stage catalogue alias ("local-notes") with custom defaultPath override
    const notesRes = proposeExtensionFromTurn(
      { catalogueId: "local-notes", defaultPath: "journal.md" },
      { rootDir, hostDir },
    );
    assert.equal(notesRes.ok, true);
    assert.equal(notesRes.action, "proposed extension local-notes");
    assert.equal(notesRes.descriptor.tools[0].params.path, "journal.md");

    // 3. Stage custom http-get extension from turn args
    const customHttpRes = proposeExtensionFromTurn(
      {
        id: "Weather API",
        name: "Weather Forecast",
        description: "Fetches weather forecast from Open-Meteo",
        primitive: "http-get",
        toolName: "fetch-weather",
        host: "api.open-meteo.com",
        defaultUrl: "https://api.open-meteo.com/v1/forecast",
      },
      { rootDir, hostDir },
    );
    assert.equal(customHttpRes.ok, true);
    assert.equal(customHttpRes.action, "proposed extension weather-api");
    assert.equal(customHttpRes.descriptor.id, "weather-api");
    assert.equal(customHttpRes.descriptor.tools[0].name, "fetch_weather");
    assert.deepEqual(customHttpRes.descriptor.capabilities, ["network"]);
    assert.deepEqual(customHttpRes.descriptor.bounds.hosts, ["api.open-meteo.com"]);

    const customReview = reviewProposal("weather-api", { rootDir, hostDir });
    assert.equal(customReview.ok, true);
    assert.equal(customReview.gate.decision, "admitted");

    const customAdmit = admitProposal("weather-api", { rootDir, hostDir, decision: "admit" });
    assert.equal(customAdmit.ok, true);
    assert.equal(customAdmit.decision, "admitted");
    const admittedOnDisk = JSON.parse(readFileSync(path.join(hostDir, "weather-api.json"), "utf8"));
    assert.equal(admittedOnDisk.tools[0].name, "fetch_weather");

    // 4. Refuses invalid catalogueId or unbounded http-get
    const unknownCat = proposeExtensionFromTurn({ catalogueId: "non-existent-cat" }, { rootDir, hostDir });
    assert.equal(unknownCat.ok, false);
    assert.equal(unknownCat.refused, "invalid-id");

    const missingHost = proposeExtensionFromTurn(
      { id: "broken-http", primitive: "http-get" },
      { rootDir, hostDir },
    );
    assert.equal(missingHost.ok, false);
    assert.equal(missingHost.refused, "network-unbounded");
  } finally {
    if (prevWs) process.env.VOICEBOX_WORKSPACE = prevWs;
    else delete process.env.VOICEBOX_WORKSPACE;
    if (prevExt) process.env.VOICEBOX_EXTENSIONS_DIR = prevExt;
    else delete process.env.VOICEBOX_EXTENSIONS_DIR;
    rmSync(scratch, { recursive: true, force: true });
  }
});
