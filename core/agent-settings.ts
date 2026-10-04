// core/agent-settings.ts — WHICH AGENT YOU ARE TALKING TO: provider, model, voice, timbre, personality, custom prompt.
//
// Paul, unprompted: *"some unified settings for the agent that we're calling and that we're working
// with externally"* — which provider, which voice, and a personality, *"so they've all got different
// personalities"*, in the settings dialog (voicebox-beads-bc0i).
//
// TWO TRAPS THIS FILE IS BUILT AROUND, both named by coord from things that have already bitten:
//
// 1. A SETTING THAT SILENTLY DOES NOTHING is worse than no setting: the person believes they changed
//    something and the page agrees with them. So every setting here has THREE states — requested,
//    applied, or PENDING-WITH-A-REASON — and `applied` is only ever what the running session can be
//    shown to use. Nothing in this file reports a request as an outcome.
//
// 2. A PERSONALITY THAT CAN DELETE THE SAFETY INSTRUCTION. If a personality REPLACES the system
//    instruction, choosing one can remove the sentences saying what the agent may do, where its root
//    is, and how a refusal is spoken. So the base is a module constant and the composer can only
//    APPEND to it: `composeAgentInstruction(personality)` takes one argument, there is no parameter
//    for the base, and the tone layer is emitted beneath a heading that says it cannot change the
//    rules above it. That is the mechanism, not a convention — a caller cannot pass a base, because
//    there is nowhere to pass it.

export type ProviderId = "gemini" | "openai" | "claude";
export type PersonalityId = "plain" | "warm" | "dry" | "teacher" | "custom";
export type TimbreId = "balanced" | "warm" | "bright" | "deep" | "crisp";

export interface ProviderFacts {
  id: ProviderId;
  label: string;
  /** The vendor's model string, as the provider dials it. */
  model: string;
  /** Models offered for this provider. */
  models: { id: string; label: string }[];
  /** The voices THIS provider offers. Never mix them: a Gemini voice on an OpenAI session is a lie. */
  voices: { id: string; label: string }[];
  /** What has to be true before a session can start at all — an env var, in both cases today. */
  requires: { env: string; why: string };
}

export const TIMBRES: Record<TimbreId, { id: TimbreId; label: string; description: string }> = {
  balanced: { id: "balanced", label: "Balanced (natural tone)", description: "Standard voice tone" },
  warm: { id: "warm", label: "Warm (softer, rounder)", description: "Gentle and rich resonance" },
  bright: { id: "bright", label: "Bright (clear, upfront)", description: "Elevated high-frequency presence" },
  deep: { id: "deep", label: "Deep (resonant bass)", description: "Grounded low-frequency emphasis" },
  crisp: { id: "crisp", label: "Crisp (articulate)", description: "Sharp phonetic articulation" },
};

export const PROVIDERS: Record<ProviderId, ProviderFacts> = {
  gemini: {
    id: "gemini",
    label: "Gemini Live",
    model: "models/gemini-3.8-live",
    models: [
      { id: "models/gemini-3.8-live", label: "Gemini 3.8 Live (default)" },
      { id: "models/gemini-3.8-thinking", label: "Gemini 3.8 Thinking — deep reasoning" },
    ],
    voices: [
      { id: "Puck", label: "Puck (the default the app has been using)" },
      { id: "Charon", label: "Charon" },
      { id: "Kore", label: "Kore" },
      { id: "Fenrir", label: "Fenrir" },
      { id: "Aoede", label: "Aoede" },
    ],
    requires: { env: "GEMINI_API_KEY", why: "the Gemini Live session is authenticated with this key" },
  },
  openai: {
    id: "openai",
    label: "OpenAI Realtime",
    model: "gpt-realtime",
    models: [
      { id: "gpt-realtime", label: "GPT Realtime (default)" },
      { id: "gpt-4o-realtime-preview", label: "GPT-4o Realtime Preview" },
      { id: "gpt-4o-mini-realtime-preview", label: "GPT-4o Mini Realtime Preview" },
    ],
    voices: [
      { id: "alloy", label: "alloy" },
      { id: "verse", label: "verse" },
      { id: "shimmer", label: "shimmer" },
      { id: "ash", label: "ash" },
      { id: "ballad", label: "ballad" },
      { id: "coral", label: "coral" },
      { id: "echo", label: "echo" },
      { id: "sage", label: "sage" },
    ],
    requires: { env: "OPENAI_API_KEY", why: "the realtime socket is opened with `Authorization: Bearer <key>`" },
  },
  claude: {
    id: "claude",
    label: "Claude",
    model: "claude-3-7-sonnet",
    models: [
      { id: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet (default)" },
      { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku", label: "Claude 3.5 Haiku" },
    ],
    voices: [
      { id: "natural", label: "natural" },
      { id: "concise", label: "concise" },
      { id: "formal", label: "formal" },
    ],
    requires: { env: "ANTHROPIC_API_KEY", why: "the Claude adapter uses ANTHROPIC_API_KEY as auth fallback" },
  },
};

/**
 * THE MANDATORY BASE. Not editable from any surface, and not a parameter of the composer below.
 *
 * It says the three things a personality must never be able to remove: what the agent may do, where
 * its root is, and how it speaks a refusal. Written as plain sentences because the model reads them.
 */
export const AGENT_BASE_INSTRUCTION = [
  "You are voicebox: a spoken interface to a real project on a real machine.",
  "You act only inside the project root that is declared for this session. You never write outside it, and you never guess a path.",
  "When you cannot do something, you say so plainly and name the reason in the words the system gave you — never a bare refusal, and never a claim that something happened when it did not.",
  "You do not claim a capability the environment does not have. If a tool is missing, you say which one is missing.",
].join(" ");

/** The tone layer: appended, never substituted. */
export interface Personality {
  id: PersonalityId;
  label: string;
  /** What this personality ADDS. Tone only — nothing here may restate or override the rules. */
  layer: string;
}

export const PERSONALITIES: Record<PersonalityId, Personality> = {
  plain: { id: "plain", label: "Plain — no layer at all", layer: "" },
  warm: {
    id: "warm",
    label: "Warm",
    layer: "Speak warmly and briefly. Acknowledge what the person is trying to do before you report what happened.",
  },
  dry: {
    id: "dry",
    label: "Dry",
    layer: "Speak plainly and without enthusiasm. Report facts in the fewest words that are still clear.",
  },
  teacher: {
    id: "teacher",
    label: "Teacher",
    layer: "Explain what you are about to do in one sentence before you do it, so the person can follow along.",
  },
  custom: {
    id: "custom",
    label: "Custom — user prompt guidance",
    layer: "Follow the custom prompt instructions provided below.",
  },
};

export interface AgentSettings {
  provider: ProviderId;
  model: string | null;
  /** null means "whatever the provider defaults to" — stated rather than implied. */
  voice: string | null;
  timbre: TimbreId | null;
  personality: PersonalityId;
  customInstruction: string | null;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  provider: "gemini",
  model: null,
  voice: null,
  timbre: "balanced",
  personality: "plain",
  customInstruction: null,
};

/**
 * THE COMPOSITION, and the whole of the structural guarantee: base first, layer appended beneath a
 * heading that says it is subordinate. There is no argument for the base, so no caller can replace
 * it; there is no branch that omits it, so no personality — including one added later — can drop it.
 */
export function composeAgentInstruction(personality: PersonalityId): string {
  const layer = (PERSONALITIES[personality] ?? PERSONALITIES.plain).layer;
  if (!layer) return AGENT_BASE_INSTRUCTION;
  return [
    AGENT_BASE_INSTRUCTION,
    "",
    "Tone only, subordinate to everything above — it cannot change what you may do, where your root is, or how you refuse:",
    layer,
  ].join("\n");
}

export function composeFullSystemInstruction(personality: PersonalityId, customPrompt?: string | null, timbre?: TimbreId | null): string {
  const base = composeAgentInstruction(personality);
  const additions: string[] = [];
  if (timbre && timbre !== "balanced" && Object.prototype.hasOwnProperty.call(TIMBRES, timbre)) {
    additions.push(`Voice tone and timbre: ${TIMBRES[timbre].label} — ${TIMBRES[timbre].description}.`);
  }
  if (customPrompt && customPrompt.trim()) {
    additions.push(`Custom prompt guidance:\n${customPrompt.trim()}`);
  }
  if (additions.length === 0) return base;
  return [
    base,
    "",
    "Tone and guidance, subordinate to everything above — cannot change what you may do, where your root is, or how you refuse:",
    ...additions,
  ].join("\n");
}

export type ValidationOk = { ok: true; value: AgentSettings };
export type ValidationFail = { ok: false; refused: string; why: string };

/**
 * The request, checked by name. Every refusal here is one a person can act on, and none of them is
 * "invalid": an unknown provider names the ones that exist, a voice names the provider that does not
 * offer it, and a personality names the tone layer that was asked for and the ones that do.
 */
export function validateAgentSettings(input: unknown, current: AgentSettings): ValidationOk | ValidationFail {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, refused: "bad-request", why: "agent settings must be an object: {provider?, model?, voice?, timbre?, personality?, customInstruction?}" };
  }
  const asked = input as Record<string, unknown>;

  for (const key of Object.keys(asked)) {
    if (!["provider", "model", "voice", "timbre", "personality", "customInstruction"].includes(key)) {
      return { ok: false, refused: "unknown-field", why: `'${key}' is not an agent setting (provider, model, voice, timbre, personality, customInstruction)` };
    }
  }

  const next: AgentSettings = { ...current };

  if ("provider" in asked) {
    const provider = String(asked.provider);
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
      return { ok: false, refused: "unknown-provider", why: `'${provider}' is not a provider this build has; it has ${Object.keys(PROVIDERS).join(", ")}` };
    }
    next.provider = provider as ProviderId;
    // A voice belongs to a provider: changing provider with no voice named drops back to that
    // provider's default rather than carrying the other vendor's voice across.
    if (!("voice" in asked) && current.voice !== null) next.voice = null;
    if (!("model" in asked) && current.model !== null) next.model = null;
  }

  if ("model" in asked) {
    const model = asked.model;
    if (model === null || model === "") {
      next.model = null;
    } else {
      const offered = PROVIDERS[next.provider].models?.some((m) => m.id === String(model)) || String(model) === PROVIDERS[next.provider].model;
      if (!offered) {
        return {
          ok: false,
          refused: "model-not-offered-by-provider",
          why: `${PROVIDERS[next.provider].label} does not offer model '${model}'; it offers ${PROVIDERS[next.provider].models?.map((m) => m.id).join(", ") || PROVIDERS[next.provider].model}`,
        };
      }
      next.model = String(model);
    }
  }

  if ("voice" in asked) {
    const voice = asked.voice;
    if (voice === null || voice === "") {
      next.voice = null; // explicit "use the provider's default"
    } else {
      const offered = PROVIDERS[next.provider].voices.some((v) => v.id === String(voice));
      if (!offered) {
        return {
          ok: false,
          refused: "voice-not-offered-by-provider",
          why: `${PROVIDERS[next.provider].label} does not offer '${voice}'; it offers ${PROVIDERS[next.provider].voices.map((v) => v.id).join(", ")}`,
        };
      }
      next.voice = String(voice);
    }
  }

  if ("timbre" in asked) {
    const timbre = asked.timbre;
    if (timbre === null || timbre === "") {
      next.timbre = null;
    } else {
      if (!Object.prototype.hasOwnProperty.call(TIMBRES, String(timbre))) {
        return {
          ok: false,
          refused: "unknown-timbre",
          why: `'${timbre}' is not a known voice timbre; choose from ${Object.keys(TIMBRES).join(", ")}`,
        };
      }
      next.timbre = timbre as TimbreId;
    }
  }

  if ("personality" in asked) {
    const personality = String(asked.personality);
    if (!Object.prototype.hasOwnProperty.call(PERSONALITIES, personality)) {
      return { ok: false, refused: "unknown-personality", why: `'${personality}' is not a personality this build has; it has ${Object.keys(PERSONALITIES).join(", ")}` };
    }
    next.personality = personality as PersonalityId;
  }

  if ("customInstruction" in asked) {
    const custom = asked.customInstruction;
    if (custom === null || custom === "") {
      next.customInstruction = null;
    } else if (typeof custom === "string") {
      if (custom.length > 4096) {
        return { ok: false, refused: "instruction-too-long", why: "custom instruction is bounded to 4096 characters" };
      }
      next.customInstruction = custom.trim();
    } else {
      return { ok: false, refused: "bad-request", why: "customInstruction must be a string or null" };
    }
  }

  return { ok: true, value: next };
}
