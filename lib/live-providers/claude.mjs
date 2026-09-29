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
      emit({
        type: "state",
        state: "unimplemented",
        refused: "claude-transport-unimplemented",
        detail: "Claude live transport is not yet implemented — use delegate_task for Claude task execution",
      });
      emit({ type: "ready", model: model ?? CLAUDE_DEFAULT_MODEL });
    },
    sendAudio(pcm16) {
      emit({
        type: "error",
        refused: "claude-transport-unimplemented",
        message: "claude-transport-unimplemented: Claude live session does not yet support live audio streaming — select Gemini Live or OpenAI Realtime for voice sessions",
      });
    },
    sendText(text) {
      emit({
        type: "error",
        refused: "claude-transport-unimplemented",
        message: "claude-transport-unimplemented: Claude live session does not yet implement live streaming transport — task delegation is available via delegate_task",
      });
    },
    interrupt() {},
    /**
     * A folder change with an instruction file (voicebox-beads-0zi4). This provider has no live
     * instruction update in its protocol path here, and a silent success would let the page believe the
     * voice had the folder's rules — the failure the bead exists to remove. Named refusal.
     */
    updateProjectInstruction() {
      return { ok: false, reason: "claude-live-has-no-instruction-update", applies: "next-session" };
    },
    close(code, reason) {
      if (closed) return;
      closed = true;
      emit({ type: "closed", code: code ?? 1000, reason: reason ?? "client closed" });
    },
  };
}
