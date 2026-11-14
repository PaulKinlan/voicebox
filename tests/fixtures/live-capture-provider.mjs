// Host-only, key-free /live fixture for browser tests that prove real microphone
// capture and UI painting, not vendor speech recognition. The page, WebSocket,
// media capture, and renderer are real; only the upstream model is replaced.
import { registerLiveProvider } from "../../lib/live-session.mjs";

registerLiveProvider("gemini", ({ emit }) => ({
  start() {
    queueMicrotask(() => {
      emit({ type: "transport-open" });
      emit({ type: "ready" });
    });
  },
  sendAudio() {},
  sendText() {},
  sendToolResponse() {},
  interrupt() {},
  close() { emit({ type: "closed", code: 1000, reason: "capture fixture closed" }); },
}), { inputRate: 16000 });
