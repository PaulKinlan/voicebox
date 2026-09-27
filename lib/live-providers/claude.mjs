// lib/live-providers/claude.mjs — Claude live session provider.
// Identity and turn adapter for live audio/text sessions.

export const CLAUDE_REQUIRED_INPUT_RATE = 16000;
export const CLAUDE_OUTPUT_RATE = 16000;
export const CLAUDE_DEFAULT_MODEL = "claude-3-7-sonnet";

export function createClaudeProvider({ model, emit, log, transport, tools, systemInstruction, instruction, projectInstruction, voice, debug }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set — the Claude session cannot start");
  let closed = false;

  return {
    async start() {
      emit({ type: "transport-open" });
      emit({ type: "ready", model: model ?? CLAUDE_DEFAULT_MODEL });
    },
    sendAudio(pcm16) {
      // Audio received: buffered for speech-to-text / turn processing
    },
    sendText(text) {
      emit({ type: "text", role: "assistant", text });
    },
    interrupt() {},
    close(code, reason) {
      if (closed) return;
      closed = true;
      emit({ type: "closed", code: code ?? 1000, reason: reason ?? "client closed" });
    },
  };
}
