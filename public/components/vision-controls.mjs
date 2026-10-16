/**
 * @summary Live camera/screen capture streaming and push-to-talk controls.
 */
// public/components/vision-controls.mjs — the Room's Live Vision and Push to talk surface
// (voicebox-beads-uei2.12, a slice of the public/fused.js decomposition scoped in voicebox-beads-uei2).
//
// WHAT IT OWNS. The three things the surface is: the STREAM (camera or screen capture, its tracks, its
// timer, the encode-in-flight guard, and the metadata line), the PREFERENCES behind it (the
// `voicebox:vision-prefs` key: resolution, fps, thinking level, PTT on/off) and PUSH TO TALK (the button's
// visibility, its pressed state, and the activity control it sends to a live session). It owns the
// listeners too, including the eleven the host used to attach inline, and the initial paint from saved
// preferences.
//
// WHAT DELIBERATELY DID NOT MOVE. `setState`, `encodeVisionFrame` and `visionGroundingController` are
// handed in: the encoder and the grounding controller already own their own behaviour and each has its own
// test, so a second copy here would be a second thing to keep in step — the exact duplication this slice
// exists to avoid. The debug / offline-speech / doctor handlers that sat BETWEEN this surface's two
// discontiguous blocks stay in the host: enabling debug logging and running the doctor are not vision, and
// a slice that swept them up because they were nearby would be an extraction by adjacency.
//
// LIVE, NEVER CAPTURED. Every host fact the module needs arrives as a callback that is called at the moment
// it is needed — `isLiveSessionActive` before sending a frame, restarting a session or starting the
// microphone, `sendLiveVideo` for a frame, `sendActivityControl` for PTT, `setPipVisionStream` for the
// document-PiP companion. The host passes closures over the globals, so a snapshot taken at init cannot
// freeze a stale answer — the `voicebox-beads-w1f9` shape, which this repo has paid for twice.
//
// INJECTED FOR TESTABILITY: `storage`, `media` (mediaDevices) and `timers` default to the real globals and
// exist so the unit arms can drive the rules with no browser, no camera and no real clock.
//
// The moved text is BYTE-IDENTICAL to the region it was cut from apart from the named seams listed above and
// in the extraction test; the two blocks that were separated by the debug handlers are joined here, which is
// behaviour-preserving because nothing between them read or wrote this module's state.
export function createVisionControls({
  els,
  encodeVisionFrame,
  visionGroundingController,
  setState,
  isLiveSessionActive = () => false,
  sendLiveVideo = () => false,
  restartLiveSession = () => {},
  sendActivityControl = () => {},
  setPipVisionStream = () => {},
  storage = globalThis.localStorage,
  media = globalThis.navigator?.mediaDevices,
  timers = globalThis,
} = {}) {
  // Core Live Vision & manual speech activity controls (camera, screen share, push-to-talk, settings)
  const VISION_PREFS_KEY = "voicebox:vision-prefs";
  let visionStream = null;
  let visionTimer = null;
  let visionMode = null;
  let pttActive = false;

  const readVisionPrefs = () => {
    try {
      const raw = storage.getItem(VISION_PREFS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };
  const writeVisionPrefs = (patch) => {
    try {
      const next = { ...readVisionPrefs(), ...patch };
      storage.setItem(VISION_PREFS_KEY, JSON.stringify(next));
      return next;
    } catch {
      return patch;
    }
  };
  const formatThinkingLevelState = (level) => {
    const normalized = String(level || "medium").toLowerCase();
    const label = normalized === "high" ? "High" : normalized === "low" ? "Low" : "Medium";
    return `${label} depth — applies to Gemini 3.8 Live Extended Thinking (audio & vision)`;
  };
  const savedVision = readVisionPrefs();
  if (els.settingVisionResolution && savedVision.resolution) els.settingVisionResolution.value = savedVision.resolution;
  if (els.settingVisionFps && savedVision.fps) els.settingVisionFps.value = String(savedVision.fps);
  if (els.settingThinkingLevel && savedVision.thinkingLevel) els.settingThinkingLevel.value = savedVision.thinkingLevel;
  if (els.settingThinkingLevelState) {
    els.settingThinkingLevelState.textContent = formatThinkingLevelState(els.settingThinkingLevel?.value);
  }
  const initialPttEnabled = Boolean(savedVision.pttEnabled);
  if (els.settingPttEnabled) els.settingPttEnabled.checked = initialPttEnabled;
  if (els.visionPttBtn) els.visionPttBtn.hidden = !initialPttEnabled;
  if (els.settingPttState) {
    els.settingPttState.textContent = initialPttEnabled
      ? "Shown — manual Push to talk button visible"
      : "Hidden — automatic voice detection active";
  }

  let visionEncodingInFlight = false;
  const captureAndSendVisionFrame = async () => {
    if (visionEncodingInFlight) return false;
    const video = els.visionCoreVideo;
    const canvas = els.visionCoreCanvas;
    if (!video || !canvas || !visionStream) return false;
    const resPref = els.settingVisionResolution?.value || "MEDIA_RESOLUTION_MEDIUM";
    const targetWidth = resPref === "MEDIA_RESOLUTION_HIGH" ? 960 : resPref === "MEDIA_RESOLUTION_LOW" ? 320 : 640;
    const vw = video.videoWidth || targetWidth;
    const vh = video.videoHeight || Math.round(targetWidth * 0.75);
    const scale = Math.min(1, targetWidth / Math.max(1, vw));
    const targetW = Math.max(1, Math.round(vw * scale));
    const targetH = Math.max(1, Math.round(vh * scale));

    visionEncodingInFlight = true;
    try {
      const result = await encodeVisionFrame(video, targetW, targetH, 0.78, canvas);
      const base64 = result?.base64 || "";
      const liveActive = Boolean(isLiveSessionActive?.());
      const sent = liveActive && base64 ? (sendLiveVideo?.(base64, "image/jpeg") ?? false) : false;
      if (els.visionCoreMeta) {
        els.visionCoreMeta.textContent = sent
          ? `${visionMode === "screen" ? "Screen" : "Camera"} live (${targetW}×${targetH})`
          : `${visionMode === "screen" ? "Screen" : "Camera"} preview ready (start mic to stream)`;
      }
      return sent;
    } finally {
      visionEncodingInFlight = false;
    }
  };

  const stopVisionStream = () => {
    if (visionTimer) {
      timers.clearInterval(visionTimer);
      visionTimer = null;
    }
    if (visionStream) {
      for (const track of visionStream.getTracks?.() ?? []) {
        try { track.stop(); } catch {}
      }
      visionStream = null;
    }
    visionMode = null;
    visionGroundingController?.clearCallouts();
    setPipVisionStream?.(null);
    if (els.visionCoreVideo) els.visionCoreVideo.srcObject = null;
    if (els.visionCoreCard) els.visionCoreCard.hidden = true;
    if (els.visionCameraBtn) els.visionCameraBtn.setAttribute("aria-pressed", "false");
    if (els.visionScreenBtn) els.visionScreenBtn.setAttribute("aria-pressed", "false");
    if (els.visionCoreMeta) els.visionCoreMeta.textContent = "Camera off";
  };

  const restartVisionTimer = () => {
    if (visionTimer) timers.clearInterval(visionTimer);
    if (!visionStream) return;
    const fps = Math.max(0.25, Math.min(5, Number(els.settingVisionFps?.value) || 1));
    visionTimer = timers.setInterval(captureAndSendVisionFrame, Math.round(1000 / fps));
  };

  const startVisionStream = async (mode) => {
    if (visionMode === mode && visionStream) {
      stopVisionStream();
      return;
    }
    stopVisionStream();
    try {
      const stream = mode === "screen"
        ? await media.getDisplayMedia({ video: true, audio: false })
        : await media.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      visionStream = stream;
      visionMode = mode;
      const [track] = stream.getVideoTracks?.() ?? [];
      track?.addEventListener?.("ended", () => stopVisionStream());
      if (els.visionCoreVideo) {
        els.visionCoreVideo.srcObject = stream;
        await els.visionCoreVideo.play?.().catch(() => {});
        els.visionCoreVideo.onloadedmetadata = () => {
          visionGroundingController?.resizeOverlay(
            els.visionCoreVideo.videoWidth || 320,
            els.visionCoreVideo.videoHeight || 180,
          );
        };
      }
      if (els.visionCoreCard) els.visionCoreCard.hidden = false;
      if (els.visionCameraBtn) els.visionCameraBtn.setAttribute("aria-pressed", String(mode === "camera"));
      if (els.visionScreenBtn) els.visionScreenBtn.setAttribute("aria-pressed", String(mode === "screen"));
      if (els.visionCoreMeta) els.visionCoreMeta.textContent = `${mode === "screen" ? "Screen share" : "Camera"} active`;
      setPipVisionStream?.(stream);
      captureAndSendVisionFrame();
      restartVisionTimer();
      if (!isLiveSessionActive?.() && els.mic && els.mic.getAttribute("aria-pressed") !== "true") {
        els.mic.click();
      }
    } catch (error) {
      stopVisionStream();
      setState(`Video capture unavailable: ${error?.message ?? error}`, "warn");
    }
  };

  els.visionCameraBtn?.addEventListener("click", () => void startVisionStream("camera"));
  els.visionScreenBtn?.addEventListener("click", () => void startVisionStream("screen"));
  els.visionSnapshotBtn?.addEventListener("click", () => { captureAndSendVisionFrame(); });
  els.visionStopBtn?.addEventListener("click", () => stopVisionStream());
  els.settingStartCamera?.addEventListener("click", () => void startVisionStream("camera"));
  els.settingStartScreen?.addEventListener("click", () => void startVisionStream("screen"));
  els.settingVisionResolution?.addEventListener("change", () => {
    writeVisionPrefs({ resolution: els.settingVisionResolution.value });
  });
  els.settingVisionFps?.addEventListener("change", () => {
    writeVisionPrefs({ fps: Number(els.settingVisionFps.value) || 1 });
    restartVisionTimer();
  });
  els.settingThinkingLevel?.addEventListener("change", () => {
    const level = els.settingThinkingLevel.value;
    writeVisionPrefs({ thinkingLevel: level });
    if (els.settingThinkingLevelState) {
      els.settingThinkingLevelState.textContent = formatThinkingLevelState(level);
    }
    if (isLiveSessionActive?.()) {
      void restartLiveSession?.();
    }
  });
  els.settingPttEnabled?.addEventListener("change", () => {
    const enabled = Boolean(els.settingPttEnabled.checked);
    writeVisionPrefs({ pttEnabled: enabled });
    if (els.visionPttBtn) {
      els.visionPttBtn.hidden = !enabled;
      if (!enabled && pttActive) {
        pttActive = false;
        els.visionPttBtn.setAttribute("aria-pressed", "false");
        els.visionPttBtn.textContent = "Push to talk";
        sendActivityControl?.("end");
      }
    }
    if (els.settingPttState) {
      els.settingPttState.textContent = enabled
        ? "Shown — manual Push to talk button visible"
        : "Hidden — automatic voice detection active";
    }
  });

  // The Push to talk button's own listener lives AFTER the debug/offline/doctor block in the host's
  // original order. It is attached here instead: those handlers are unrelated to PTT, nothing between them
  // reads or writes `pttActive`, and a listener's position among listeners on OTHER elements is
  // unobservable — so the two discontiguous blocks become one factory without changing behaviour.
  els.visionPttBtn?.addEventListener("click", () => {
    pttActive = !pttActive;
    els.visionPttBtn.setAttribute("aria-pressed", String(pttActive));
    els.visionPttBtn.textContent = pttActive ? "End turn" : "Push to talk";
    sendActivityControl?.(pttActive ? "start" : "end");
  });

  // The host ignores this handle today: every entry point is a listener. It is returned so the surface can
  // be driven directly (the extraction test does), and so a future caller does not have to reach for a
  // listener to start a stream.
  return { startVisionStream, stopVisionStream, captureAndSendVisionFrame, restartVisionTimer };
}
