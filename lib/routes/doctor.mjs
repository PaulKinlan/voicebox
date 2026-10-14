// lib/routes/doctor.mjs — In-browser diagnostics & self-diagnosing doctor route.
//
// Returns structured host diagnostics and health checks without leaking secrets.

import { extensionsDir, workspaceDeclared } from "../state-dirs.mjs";

export function createDoctorRoutes({
  getActive = () => null,
  getApiKeys = () => ({ ok: true, keys: {} }),
  getHarnessInventory = async () => [],
  loopbackAuth = false,
  json,
} = {}) {
  return {
    "GET /api/doctor": async (_req, res) => {
      const active = getActive();
      const keysPayload = typeof getApiKeys === "function" ? getApiKeys() : { keys: {} };
      const keys = keysPayload?.keys || {};

      let harnesses = [];
      try {
        if (typeof getHarnessInventory === "function") {
          const res = await getHarnessInventory();
          harnesses = Array.isArray(res) ? res : (Array.isArray(res?.entries) ? res.entries : []);
        }
      } catch {}

      const checks = [];

      // 1. Workspace root check
      if (active?.root?.path) {
        checks.push({
          id: "workspace_root",
          label: "Workspace Root",
          status: "ok",
          detail: `Active project "${active.project}" at ${active.root.path} (${active.root.kind})`,
        });
      } else {
        const declared = workspaceDeclared();
        if (declared) {
          checks.push({
            id: "workspace_root",
            label: "Workspace Root",
            status: "ok",
            detail: `Declared at ${declared}`,
          });
        } else {
          checks.push({
            id: "workspace_root",
            label: "Workspace Root",
            status: "warn",
            detail: "No workspace root declared — file writes will refuse until declared",
          });
        }
      }

      // 2. Voice providers (Gemini, OpenAI, Anthropic)
      const geminiConfigured = Boolean(keys.gemini?.configured);
      checks.push({
        id: "provider_gemini",
        label: "Gemini Provider",
        status: geminiConfigured ? "ok" : "warn",
        detail: geminiConfigured
          ? `Configured (${keys.gemini.source || "active"})`
          : "API key unset — needed for Gemini live voice and resolver",
      });

      const openaiConfigured = Boolean(keys.openai?.configured);
      checks.push({
        id: "provider_openai",
        label: "OpenAI Provider",
        status: openaiConfigured ? "ok" : "warn",
        detail: openaiConfigured
          ? `Configured (${keys.openai.source || "active"})`
          : "API key unset — needed for OpenAI live voice",
      });

      const anthropicConfigured = Boolean(keys.anthropic?.configured);
      checks.push({
        id: "provider_anthropic",
        label: "Anthropic Provider",
        status: anthropicConfigured ? "ok" : "warn",
        detail: anthropicConfigured
          ? `Configured (${keys.anthropic.source || "active"})`
          : "API key unset — optional for Claude/Anthropic adapter",
      });

      // 3. Coding harnesses
      const installedHarnesses = Array.isArray(harnesses)
        ? harnesses.filter((h) => h.installed || h.available || h.status === "ready" || h.status === "active" || h.state === "present" || h.state === "configured" || h.delegation?.ok === true)
        : [];
      const harnessNames = installedHarnesses.map((h) => h.name || h.id || h.harness).filter(Boolean);
      checks.push({
        id: "coding_harnesses",
        label: "Coding Harnesses",
        status: harnessNames.length > 0 ? "ok" : "warn",
        detail:
          harnessNames.length > 0
            ? `${harnessNames.length} detected: ${harnessNames.join(", ")}`
            : "No coding harnesses detected on host PATH",
      });

      // 4. Loopback auth
      checks.push({
        id: "loopback_auth",
        label: "Loopback Authentication",
        status: "ok",
        detail: loopbackAuth
          ? "Enabled (requires session cookie or host token)"
          : "Standard local loopback mode",
      });

      // 5. Extensions directory
      checks.push({
        id: "extensions_dir",
        label: "Extensions Storage",
        status: "ok",
        detail: `Storage directory at ${extensionsDir()}`,
      });

      const hasError = checks.some((c) => c.status === "error");
      const hasWarn = checks.some((c) => c.status === "warn");
      const verdict = hasError ? "error" : hasWarn ? "warn" : "ok";

      return json(res, 200, {
        ok: true,
        timestamp: new Date().toISOString(),
        verdict,
        checks,
      });
    },
  };
}
