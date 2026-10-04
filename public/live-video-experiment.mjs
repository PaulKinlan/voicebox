// public/live-video-experiment.mjs — Camera (getUserMedia) and Desktop Screen Share (getDisplayMedia)
// live frame capture controller for Gemini Live multimodal sessions.

const FALLBACK_JPEG_DATA_URL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

function createFallbackVideoElement() {
  return {
    videoWidth: 1280,
    videoHeight: 720,
    muted: true,
    playsInline: true,
    autoplay: true,
    srcObject: null,
    play() {
      return Promise.resolve();
    },
  };
}

function createFallbackCanvasElement() {
  return {
    width: 640,
    height: 360,
    getContext() {
      return {
        drawImage() {},
      };
    },
    toDataURL() {
      return FALLBACK_JPEG_DATA_URL;
    },
  };
}

export function scaleFrameDimensions(rawWidth, rawHeight, maxDimension = 1024) {
  const widthIn = Number(rawWidth) > 0 ? Number(rawWidth) : 640;
  const heightIn = Number(rawHeight) > 0 ? Number(rawHeight) : 480;
  const limit = Number(maxDimension) > 0 ? Number(maxDimension) : 1024;
  const largest = Math.max(widthIn, heightIn, 1);
  const ratio = largest > limit ? limit / largest : 1;
  return {
    width: Math.max(1, Math.round(widthIn * ratio)),
    height: Math.max(1, Math.round(heightIn * ratio)),
  };
}

export function createLiveVideoController({
  mediaDevices = globalThis.navigator?.mediaDevices,
  documentObj = globalThis.document,
  videoElement = null,
  canvasElement = null,
  onFrame,
  onStateChange,
  fps = 1,
  maxDimension = 1024,
  quality = 0.78,
} = {}) {
  let active = false;
  let source = null;
  let currentFps = Number(fps) > 0 ? Number(fps) : 1;
  let currentMaxDimension = Number(maxDimension) > 0 ? Number(maxDimension) : 1024;
  let currentQuality = Number(quality) > 0 && Number(quality) <= 1 ? Number(quality) : 0.78;
  let framesSent = 0;
  let activeStream = null;
  let samplingTimer = null;
  let videoEl = videoElement;
  let canvasEl = canvasElement;

  function ensureElements() {
    if (!videoEl) {
      if (documentObj && typeof documentObj.createElement === "function") {
        videoEl = documentObj.createElement("video");
        videoEl.autoplay = true;
        videoEl.muted = true;
        videoEl.playsInline = true;
      } else {
        videoEl = createFallbackVideoElement();
      }
    }
    if (!canvasEl) {
      if (documentObj && typeof documentObj.createElement === "function") {
        canvasEl = documentObj.createElement("canvas");
      } else {
        canvasEl = createFallbackCanvasElement();
      }
    }
    return { video: videoEl, canvas: canvasEl };
  }

  function clearSamplingTimer() {
    if (samplingTimer !== null) {
      clearInterval(samplingTimer);
      samplingTimer = null;
    }
  }

  function stopTracksOnly() {
    if (!activeStream) return;
    const stream = activeStream;
    activeStream = null;
    const tracks =
      typeof stream.getTracks === "function"
        ? stream.getTracks()
        : typeof stream.getVideoTracks === "function"
          ? stream.getVideoTracks()
          : [];
    for (const track of tracks) {
      if (track && typeof track.stop === "function") {
        track.stop();
      }
    }
  }

  function startSamplingLoop() {
    clearSamplingTimer();
    const intervalMs = Math.max(100, Math.round(1000 / currentFps));
    samplingTimer = setInterval(() => {
      if (active) {
        captureSingleFrame();
      }
    }, intervalMs);
    if (typeof samplingTimer?.unref === "function") {
      samplingTimer.unref();
    }
  }

  function getPrimaryVideoTrack(stream) {
    if (!stream) return null;
    if (typeof stream.getVideoTracks === "function") {
      const videoTracks = stream.getVideoTracks();
      if (Array.isArray(videoTracks) && videoTracks.length > 0) {
        return videoTracks[0];
      }
    }
    if (typeof stream.getTracks === "function") {
      const allTracks = stream.getTracks();
      if (Array.isArray(allTracks) && allTracks.length > 0) {
        return allTracks[0];
      }
    }
    return null;
  }

  function captureSingleFrame() {
    const { video, canvas } = ensureElements();
    const primaryTrack = getPrimaryVideoTrack(activeStream);
    const trackSettings =
      primaryTrack && typeof primaryTrack.getSettings === "function"
        ? primaryTrack.getSettings()
        : null;

    const rawWidth = Number(video.videoWidth || trackSettings?.width || 640);
    const rawHeight = Number(video.videoHeight || trackSettings?.height || 480);
    const { width, height } = scaleFrameDimensions(rawWidth, rawHeight, currentMaxDimension);

    canvas.width = width;
    canvas.height = height;

    const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (ctx && typeof ctx.drawImage === "function") {
      ctx.drawImage(video, 0, 0, width, height);
    }

    const rawDataUrl =
      typeof canvas.toDataURL === "function"
        ? String(canvas.toDataURL("image/jpeg", currentQuality) || "")
        : FALLBACK_JPEG_DATA_URL;
    const jpegPrefix = "data:image/jpeg;base64,";
    const base64Data = rawDataUrl.startsWith(jpegPrefix)
      ? rawDataUrl.slice(jpegPrefix.length)
      : rawDataUrl.replace(/^data:[^;]+;base64,/, "");

    framesSent += 1;
    const frame = {
      source,
      mimeType: "image/jpeg",
      data: base64Data,
      width,
      height,
      timestamp: Date.now(),
    };
    onFrame?.(frame);
    return frame;
  }

  async function attachStream(stream, nextSource) {
    const { video } = ensureElements();
    video.srcObject = stream;
    if (typeof video.play === "function") {
      try {
        await video.play();
      } catch {
        // Autoplay restrictions in background tabs do not block canvas frame reads once playing.
      }
    }
    activeStream = stream;
    active = true;
    source = nextSource;
    startSamplingLoop();
  }

  async function startCamera({ facingMode = "user", deviceId } = {}) {
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
      throw new Error("Camera access is not available in this browser.");
    }
    clearSamplingTimer();
    stopTracksOnly();

    const stream = await mediaDevices.getUserMedia({
      video: {
        facingMode,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: currentMaxDimension },
        height: { ideal: currentMaxDimension },
      },
      audio: false,
    });

    await attachStream(stream, "camera");
    onStateChange?.({
      active: true,
      source: "camera",
      fps: currentFps,
      maxDimension: currentMaxDimension,
    });
    return { active: true, source: "camera", stream };
  }

  async function startScreenShare({ preferCurrentTab = false } = {}) {
    if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== "function") {
      throw new Error("Screen sharing is not available in this browser.");
    }
    clearSamplingTimer();
    stopTracksOnly();

    const constraints = {
      video: {
        width: { ideal: currentMaxDimension },
        height: { ideal: currentMaxDimension },
        frameRate: { ideal: Math.max(1, currentFps) },
      },
      audio: false,
      ...(preferCurrentTab ? { preferCurrentTab: true } : {}),
    };

    const stream = await mediaDevices.getDisplayMedia(constraints);
    const videoTrack = getPrimaryVideoTrack(stream);
    if (videoTrack) {
      let endedHandled = false;
      const handleEnded = () => {
        if (endedHandled) return;
        endedHandled = true;
        clearSamplingTimer();
        stopTracksOnly();
        if (videoEl) {
          videoEl.srcObject = null;
        }
        active = false;
        source = null;
        onStateChange?.({ active: false, source: null });
      };
      if (typeof videoTrack.addEventListener === "function") {
        videoTrack.addEventListener("ended", handleEnded, { once: true });
      }
      if (videoTrack.onended === undefined || videoTrack.onended === null) {
        videoTrack.onended = handleEnded;
      }
    }

    await attachStream(stream, "screen");
    onStateChange?.({
      active: true,
      source: "screen",
      fps: currentFps,
      maxDimension: currentMaxDimension,
    });
    return { active: true, source: "screen", stream };
  }

  function stop() {
    clearSamplingTimer();
    stopTracksOnly();
    if (videoEl) {
      videoEl.srcObject = null;
    }
    active = false;
    source = null;
    const stateSnapshot = { active: false, source: null, framesSent };
    onStateChange?.(stateSnapshot);
    return stateSnapshot;
  }

  function updateSettings({ fps: nextFps, maxDimension: nextMax, quality: nextQuality } = {}) {
    if (Number(nextFps) > 0) {
      currentFps = Number(nextFps);
      if (active) {
        startSamplingLoop();
      }
    }
    if (Number(nextMax) > 0) {
      currentMaxDimension = Number(nextMax);
    }
    if (Number(nextQuality) > 0 && Number(nextQuality) <= 1) {
      currentQuality = Number(nextQuality);
    }
    return getStatus();
  }

  function getStatus() {
    return {
      active,
      source,
      fps: currentFps,
      maxDimension: currentMaxDimension,
      quality: currentQuality,
      framesSent,
    };
  }

  return {
    startCamera,
    startScreenShare,
    captureSingleFrame,
    stop,
    updateSettings,
    getStatus,
  };
}
