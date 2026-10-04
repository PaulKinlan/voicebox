// Public live-model library entry point. No UI, HTTP server or tool executor is started on import.
// The host supplies callbacks and a catalogue; providers own only vendor protocol translation.
export {
  createLiveSession,
  registerLiveProvider,
  availableLiveProviders,
  resolvedLiveProviderName,
  inputRateRequiredBy,
} from "./live-session.mjs";
