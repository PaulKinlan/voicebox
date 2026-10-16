/**
 * @summary Harness inventory and configuration HTTP endpoints.
 */
// lib/routes/harnesses.mjs — Harness inventory, configuration, and activation HTTP routes.
//
// Extracted from server.mjs (voicebox-beads-r9hv.1).

export const SUPPORTED_HARNESS_NAMES = [
  "pi",
  "claude",
  "antigravity",
  "codex",
  "gemini",
  "opencode",
  "aider",
];

export const DEFAULT_SUPPORTED_HARNESS_DEFAULTS = {
  pi: { id: "pi", name: "Pi", harness: "pi", adapter: "pi-acp" },
  "pi-acp": { id: "pi", name: "Pi", harness: "pi", adapter: "pi-acp" },
  claude: { id: "claude", name: "Claude", harness: "claude", adapter: "claude-code" },
  "claude-code": { id: "claude", name: "Claude", harness: "claude", adapter: "claude-code" },
  "claude-agent-acp": { id: "claude", name: "Claude", harness: "claude", adapter: "claude-code" },
  antigravity: { id: "antigravity", name: "Anti-Gravity", harness: "antigravity", adapter: "antigravity" },
  agy: { id: "antigravity", name: "Anti-Gravity", harness: "antigravity", adapter: "antigravity" },
  agentapi: { id: "antigravity", name: "Anti-Gravity", harness: "antigravity", adapter: "antigravity" },
  codex: { id: "codex", name: "Codex", harness: "codex", adapter: "codex-cli" },
  "codex-cli": { id: "codex", name: "Codex", harness: "codex", adapter: "codex-cli" },
  gemini: { id: "gemini", name: "Gemini CLI", harness: "gemini", adapter: "gemini-cli" },
  "gemini-cli": { id: "gemini", name: "Gemini CLI", harness: "gemini", adapter: "gemini-cli" },
  opencode: { id: "opencode", name: "OpenCode", harness: "opencode", adapter: "opencode" },
  aider: { id: "aider", name: "Aider", harness: "aider", adapter: "aider" },
};

export function defaultNormalizeHarnessId(raw) {
  if (raw === "pi-acp") return "pi";
  if (raw === "claude-code" || raw === "claude-agent-acp") return "claude";
  if (raw === "agy" || raw === "agentapi") return "antigravity";
  if (raw === "codex-cli") return "codex";
  if (raw === "gemini-cli") return "gemini";
  return raw;
}

export function createHarnessRoutes({
  harnessInventory,
  listHarnessesWithConfiguredAgents,
  agentRegistry,
  getActiveHarness,
  setActiveHarness,
  activeHarness,
  activeHarnesses = new Set(),
  supportedHarnessDefaults = DEFAULT_SUPPORTED_HARNESS_DEFAULTS,
  normalizeHarnessId = defaultNormalizeHarnessId,
  activateHarnessInProcess = () => {},
  deactivateHarnessInProcess = () => {},
  installTaskExecutor = () => {},
  writePersistedHarnessSettings = () => {},
  recordWorkActivity = () => {},
  json,
  readJsonBody,
  answerOnce = (_res, fn) => fn(),
}) {
  let localActiveHarness = activeHarness ?? null;
  const getActive = typeof getActiveHarness === "function" ? getActiveHarness : () => localActiveHarness;
  const setActive = typeof setActiveHarness === "function" ? setActiveHarness : (val) => { localActiveHarness = val; };

  return {
    "GET /api/harnesses": async (_req, res) => {
      const inv = typeof harnessInventory === "function" ? await harnessInventory() : [];
      const combined = typeof listHarnessesWithConfiguredAgents === "function"
        ? await listHarnessesWithConfiguredAgents(inv, agentRegistry)
        : { harnesses: inv };
      return json(res, 200, {
        ...combined,
        activeHarness: getActive(),
        activeHarnesses: [...activeHarnesses],
      });
    },

    "POST /api/harnesses/configure": async (req, res) => {
      const parsed = await readJsonBody(req, res);
      if (parsed === null || typeof parsed !== "object") {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON" });
      }
      return answerOnce(res, async () => {
        if (Array.isArray(parsed?.harnesses)) {
          const validList = [];
          for (const h of parsed.harnesses) {
            const trimmed = String(h ?? "").trim();
            if (!trimmed || !supportedHarnessDefaults[trimmed]) {
              return json(res, 400, {
                ok: false,
                refused: "bad-request",
                why: `harness must be one of: ${SUPPORTED_HARNESS_NAMES.join(", ")}`,
              });
            }
            validList.push(trimmed);
          }
          activeHarnesses.clear();
          setActive(null);
          for (const h of validList) {
            activateHarnessInProcess(h);
          }
          if (typeof parsed.harness === "string" && supportedHarnessDefaults[parsed.harness.trim()]) {
            setActive(normalizeHarnessId(parsed.harness.trim()));
          }
          if (activeHarnesses.size === 0) {
            installTaskExecutor(null);
          }
          writePersistedHarnessSettings(getActive(), activeHarnesses);
          recordWorkActivity({
            kind: "harness",
            summary: `Connected harnesses: ${[...activeHarnesses].join(", ") || "none"}`,
            status: "ok",
          });
        } else {
          const harnessRaw = String(parsed?.harness ?? parsed?.id ?? "").trim();
          if (!harnessRaw || !supportedHarnessDefaults[harnessRaw]) {
            return json(res, 400, {
              ok: false,
              refused: "bad-request",
              why: `harness must be one of: ${SUPPORTED_HARNESS_NAMES.join(", ")}`,
            });
          }
          const normalized = normalizeHarnessId(harnessRaw);
          if (parsed?.active === false) {
            deactivateHarnessInProcess(normalized);
            writePersistedHarnessSettings(getActive(), activeHarnesses);
            recordWorkActivity({
              kind: "harness",
              summary: `Disconnected harness ${normalized}`,
              status: "info",
            });
          } else {
            activateHarnessInProcess(harnessRaw, parsed);
            writePersistedHarnessSettings(getActive(), activeHarnesses);
            recordWorkActivity({
              kind: "harness",
              summary: `Connected harness ${normalized}`,
              status: "ok",
            });
          }
        }
        const inv = typeof harnessInventory === "function" ? await harnessInventory() : [];
        const combined = typeof listHarnessesWithConfiguredAgents === "function"
          ? await listHarnessesWithConfiguredAgents(inv, agentRegistry)
          : { harnesses: inv };
        return json(res, 200, {
          ok: true,
          activeHarness: getActive(),
          activeHarnesses: [...activeHarnesses],
          ...combined,
        });
      });
    },
  };
}

export const createHarnessesRoutes = createHarnessRoutes;
