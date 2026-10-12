// Settings dialog, agent preferences and masked provider-key controls.
// The host owns audio device routing, theme, root facts and shared dialog dismissal.
export function initSettingsUi({ els, request, health, refreshDevices, on }) {
  // ── Provider API keys configuration (voicebox-beads-5drl) ─────────────────
  function describeProviderKeySlot(slot) {
    if (!slot) return "Not configured";
    if (typeof slot === "boolean") return slot ? "Configured" : "Not configured";
    if (typeof slot === "object") {
      const configured = Boolean(slot.configured || slot.present || slot.set);
      if (!configured) return "Not configured";
      const src = String(slot.source || "").toLowerCase();
      if (src.includes("env")) return "Configured (from environment)";
      if (src.includes("store") || src.includes("file") || src.includes("host") || src.includes("saved")) {
        return "Configured (saved on this host)";
      }
      return "Configured";
    }
    return "Not configured";
  }

  async function loadApiKeysSettings() {
    try {
      const res = await fetch("/api/keys", { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const body = await res.json();
      const providers = body.providers || body.keys || body;
      const mapping = [
        ["gemini", els.apiKeyGeminiStatus, els.apiKeyGemini],
        ["openai", els.apiKeyOpenaiStatus, els.apiKeyOpenai],
        ["anthropic", els.apiKeyAnthropicStatus, els.apiKeyAnthropic],
      ];
      for (const [id, statusEl, inputEl] of mapping) {
        const slot = providers?.[id];
        const text = describeProviderKeySlot(slot);
        const isConfigured = text.startsWith("Configured");
        if (statusEl) statusEl.textContent = text;
        if (inputEl && isConfigured && !inputEl.value) {
          const masked = typeof slot === "object" && typeof slot.masked === "string" ? slot.masked : "";
          inputEl.placeholder = masked ? `Saved (${masked}) — paste to replace` : "Saved — paste a new key to replace";
        }
      }
    } catch {
      // Endpoint may not be mounted yet; keep clean initial labels
    }
  }

  on(els.apiKeysSave, "click", async () => {
    const payload = {};
    const gVal = (els.apiKeyGemini?.value ?? "").trim();
    const oVal = (els.apiKeyOpenai?.value ?? "").trim();
    const aVal = (els.apiKeyAnthropic?.value ?? "").trim();
    if (gVal) payload.gemini = gVal;
    if (oVal) payload.openai = oVal;
    if (aVal) payload.anthropic = aVal;
    if (Object.keys(payload).length === 0) {
      if (els.apiKeysStatus) els.apiKeysStatus.textContent = "Paste at least one API key before saving.";
      return;
    }
    if (els.apiKeysSave) els.apiKeysSave.disabled = true;
    if (els.apiKeysStatus) els.apiKeysStatus.textContent = "Saving API keys…";
    try {
      const res = await fetch("/api/keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        throw new Error(body.why || body.error || `HTTP ${res.status}`);
      }
      if (els.apiKeyGemini) els.apiKeyGemini.value = "";
      if (els.apiKeyOpenai) els.apiKeyOpenai.value = "";
      if (els.apiKeyAnthropic) els.apiKeyAnthropic.value = "";
      if (els.apiKeysStatus) els.apiKeysStatus.textContent = "Saved API keys on this host.";
      await loadApiKeysSettings();
      await loadAgentSettings();
      void health();
    } catch (err) {
      if (els.apiKeysStatus) els.apiKeysStatus.textContent = `Could not save API keys (${err?.message ?? String(err)}).`;
    } finally {
      if (els.apiKeysSave) els.apiKeysSave.disabled = false;
    }
  });

  on(els.settingsOpen, "click", () => {
    if (!els.settings || els.settings.open) return;
    // Opening settings does not start capture, stop playback or end the session.
    //
    // showModal() IS the feature: top layer, modality, focus trapped inside, the room behind inert,
    // Esc as a close request, and focus handed back here on close. All of it is the platform's, which
    // is the point — a hand-rolled overlay gets four of those five wrong.
    els.settings.showModal();
    els.settingsOpen.setAttribute("aria-expanded", "true");
    refreshDevices();
    void loadAgentSettings();
    void loadApiKeysSettings();
  });

  // Every close path — the form's method="dialog" button, Esc, light dismiss, or a programmatic
  // close — arrives here, so the trigger's state is honest whichever way it went.
  on(els.settings, "close", () => {
    els.settingsOpen.setAttribute("aria-expanded", "false");
    els.settingsOpen.focus();
  });

  // ── the agent you are talking to: provider, voice, personality ────────────
  //
  // THE ONE RULE THIS SECTION KEEPS: a control shows what is APPLIED, and says where the request and
  // the reality differ. A picker bound to a field the session never reads is worse than no picker —
  // the person believes they changed something and the page agrees with them — so `voice` and
  // `personality` say "stored, not applied" in words until a provider carries them.
  let agent = null; // the last payload, kept so a change can be rendered against it

  const AGENT_SETTINGS_KEY = "voicebox.agent.settings.v1";

  function readLocalAgentSettings() {
    try {
      const raw = localStorage.getItem(AGENT_SETTINGS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeLocalAgentSettings(settings) {
    try {
      if (settings) localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(settings));
    } catch { /* private mode */ }
  }

  async function loadAgentSettings() {
    const local = readLocalAgentSettings();
    if (local && typeof local === "object") {
      try {
        agent = await request("/api/agent-settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(local),
        });
      } catch {
        try { agent = await request("/api/agent-settings"); } catch { agent = null; }
      }
    } else {
      try {
        agent = await request("/api/agent-settings");
      } catch {
        agent = null;
      }
    }
    renderAgentSettings();
  }

  function fillAgentPicker(picker, options, selected) {
    if (!picker) return;
    picker.textContent = "";
    for (const option of options) {
      const el = document.createElement("option");
      el.value = option.value;
      el.textContent = option.label;
      if (option.value === selected) el.selected = true;
      picker.append(el);
    }
  }

  let reconnectedLiveModel = null;

  function renderAgentSettings() {
    const providerState = document.getElementById("agent-provider-state");
    const modelState = document.getElementById("agent-model-state");
    const voiceState = document.getElementById("agent-voice-state");
    const timbreState = document.getElementById("agent-timbre-state");
    const personalityState = document.getElementById("agent-personality-state");
    const customState = document.getElementById("agent-custom-instruction-state");
    if (!providerState) return;

    if (!agent) {
      providerState.textContent = "The server does not report agent settings.";
      return;
    }

    // PROVIDER — applied
    const chosen = agent.capabilities.find((c) => c.id === agent.requested.provider) || agent.capabilities[0];
    fillAgentPicker(
      document.getElementById("agent-provider"),
      agent.capabilities.map((c) => ({ value: c.id, label: c.available ? c.label : `${c.label} — not available` })),
      agent.requested.provider,
    );
    const running = agent.runningSession ? ` A live session is using ${agent.runningSession.provider}.` : " No live session is open.";
    providerState.textContent = chosen && !chosen.available
      ? `Cannot be used: ${chosen.why}.`
      : `In use for the next session: ${chosen.label} · ${agent.applied.model}.${running}`;

    // MODEL — per provider
    const modelPicker = document.getElementById("agent-model");
    const models = chosen.models ?? [{ id: chosen.model, label: chosen.model }];
    const currentModel = agent.requested.model ?? chosen.model;
    fillAgentPicker(
      modelPicker,
      models.map((m) => ({ value: m.id, label: m.label })),
      currentModel,
    );
    const liveActive = Boolean(
      (typeof window.__voiceboxIsLiveSessionActive === "function" && window.__voiceboxIsLiveSessionActive())
      || agent.runningSession,
    );
    if (!liveActive) {
      reconnectedLiveModel = null;
    }
    if (modelState) {
      if (liveActive && (reconnectedLiveModel === currentModel || agent.runningSession?.model === currentModel)) {
        modelState.textContent = reconnectedLiveModel === currentModel
          ? `Reconnected live session with ${currentModel}.`
          : `${currentModel} active in running session.`;
      } else {
        modelState.textContent = agent.requested.model
          ? `Applied model: ${agent.requested.model} — the next session starts with it.`
          : `Applied default model: ${chosen.model} — the next session starts with it.`;
      }
    }

    // VOICE — per provider
    const voicePicker = document.getElementById("agent-voice");
    fillAgentPicker(voicePicker, [
      { value: "", label: `${chosen.label}'s default` },
      ...chosen.voices.map((v) => ({ value: v.id, label: v.label })),
    ], agent.requested.voice ?? "");
    if (voiceState) {
      voiceState.textContent = agent.pending.voice
        ? (agent.requested.voice
          ? `Chosen: ${agent.requested.voice}. ${agent.pending.voice}`
          : `Using ${chosen.label}'s default voice. ${agent.pending.voice}`)
        : (agent.requested.voice
          ? `Applied: ${agent.requested.voice} — the next session starts with it.`
          : `Applied: ${chosen.label}'s default voice — the next session starts with it.`);
    }

    // TIMBRE
    const timbrePicker = document.getElementById("agent-timbre");
    const timbres = agent.timbres ?? [
      { id: "balanced", label: "Balanced (natural tone)", description: "Standard voice tone" },
      { id: "warm", label: "Warm (softer, rounder)", description: "Gentle and rich resonance" },
      { id: "bright", label: "Bright (clear, upfront)", description: "Elevated high-frequency presence" },
      { id: "deep", label: "Deep (resonant bass)", description: "Grounded low-frequency emphasis" },
      { id: "crisp", label: "Crisp (articulate)", description: "Sharp phonetic articulation" },
    ];
    fillAgentPicker(timbrePicker, timbres.map((t) => ({ value: t.id, label: t.label })), agent.requested.timbre ?? "balanced");
    if (timbreState) {
      const curTimbre = timbres.find((t) => t.id === (agent.requested.timbre ?? "balanced"));
      timbreState.textContent = `Applied timbre: ${curTimbre?.label ?? "Balanced"}.`;
    }

    // PERSONALITY
    const personalityPicker = document.getElementById("agent-personality");
    fillAgentPicker(personalityPicker, agent.personalities.map((p) => ({ value: p.id, label: p.label })), agent.requested.personality);
    if (personalityState) {
      personalityState.textContent = agent.pending.personality
        ? `Chosen: ${agent.requested.personality}. ${agent.pending.personality}`
        : `Applied: ${agent.requested.personality} — layered beneath the base rules for the next session.`;
    }

    // CUSTOM INSTRUCTION PROMPT
    const customInput = document.getElementById("agent-custom-instruction");
    if (customInput && document.activeElement !== customInput) {
      customInput.value = agent.requested.customInstruction ?? "";
    }
    if (customState) {
      customState.textContent = agent.requested.customInstruction
        ? "Custom prompt active: layered subordinate to the mandatory base rules."
        : "Layered subordinate to the mandatory base rules.";
    }

    const base = document.getElementById("agent-base");
    if (base) base.textContent = agent.base.instruction;
    const note = document.getElementById("agent-base-note");
    if (note) note.textContent = `${agent.base.note} (editable here: ${agent.base.editable ? "yes" : "no"}). Settings are ${agent.persisted}.`;
  }

  async function saveAgentSetting(patch) {
    // Declared JSON: the server's bounded body door refuses an undeclared text/plain body with 415 (voicebox-beads-d808).
    const answer = await request("/api/agent-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    if (!answer || answer.ok === false) {
      const why = answer?.why ?? "the server did not accept that";
      for (const id of [
        "agent-provider-state",
        "agent-model-state",
        "agent-voice-state",
        "agent-timbre-state",
        "agent-personality-state",
        "agent-custom-instruction-state",
      ]) {
        const el = document.getElementById(id);
        if (el) el.textContent = `Refused (${answer?.refused ?? "unknown"}): ${why}`;
      }
      return;
    }
    agent = answer;
    writeLocalAgentSettings(agent.requested);
    if (("model" in patch || "provider" in patch) && typeof window.__voiceboxIsLiveSessionActive === "function" && window.__voiceboxIsLiveSessionActive()) {
      try {
        const restarted = await window.__voiceboxRestartLiveSession?.();
        const savedModel = agent.applied?.model ?? agent.requested?.model ?? "default model";
        if (restarted?.restarted !== false) {
          reconnectedLiveModel = savedModel;
        }
        renderAgentSettings();
        const modelStateEl = document.getElementById("agent-model-state");
        if (modelStateEl) {
          modelStateEl.textContent = `Reconnected live session with ${savedModel}.`;
        }
      } catch {
        renderAgentSettings();
      }
    } else {
      renderAgentSettings();
    }
    void health();
  }

  for (const [id, patch] of [
    ["agent-provider", (value) => ({ provider: value })],
    ["agent-model", (value) => ({ model: value || null })],
    ["agent-voice", (value) => ({ voice: value || null })],
    ["agent-timbre", (value) => ({ timbre: value || null })],
    ["agent-personality", (value) => ({ personality: value })],
  ]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => void saveAgentSetting(patch(el.value)));
  }

  const customEl = document.getElementById("agent-custom-instruction");
  if (customEl) {
    customEl.addEventListener("change", () => void saveAgentSetting({ customInstruction: customEl.value || null }));
  }

  return { loadAgentSettings, loadApiKeysSettings };
}
