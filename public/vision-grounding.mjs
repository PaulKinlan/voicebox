// public/vision-grounding.mjs — Live Visual Grounding & Screen/Camera Callout Pointer.
//
// Normalizes bounding boxes and point targets from multimodal models (such as
// Gemini 2.0 / 1.5 [ymin, xmin, ymax, xmax] 0..1000 or 0..1 ranges) and renders
// interactive visual callouts, focus rings, and pointer markers on an overlay canvas.

/**
 * Normalizes a bounding box array [ymin, xmin, ymax, xmax] or object to 0..1 floating point coordinates.
 * Handles both 0..1000 Gemini integer coordinate space and 0..1 floating point spaces.
 */
export function normalizeBoundingBox(raw) {
  if (!raw) return null;

  let ymin, xmin, ymax, xmax, label = "";

  if (Array.isArray(raw)) {
    if (raw.length < 4) return null;
    [ymin, xmin, ymax, xmax] = raw.map(Number);
  } else if (typeof raw === "object") {
    if (Array.isArray(raw.box_2d)) {
      [ymin, xmin, ymax, xmax] = raw.box_2d.map(Number);
    } else if (Array.isArray(raw.box)) {
      [ymin, xmin, ymax, xmax] = raw.box.map(Number);
    } else {
      ymin = Number(raw.ymin ?? raw.top ?? 0);
      xmin = Number(raw.xmin ?? raw.left ?? 0);
      ymax = Number(raw.ymax ?? raw.bottom ?? 0);
      xmax = Number(raw.xmax ?? raw.right ?? 0);
    }
    label = String(raw.label ?? raw.text ?? raw.name ?? "").trim();
  } else {
    return null;
  }

  if ([ymin, xmin, ymax, xmax].some((v) => Number.isNaN(v))) {
    return null;
  }

  // If any coordinate is > 1.0, treat as 0..1000 Gemini coordinate space
  const isScale1000 = [ymin, xmin, ymax, xmax].some((v) => Math.abs(v) > 1.0);
  const divisor = isScale1000 ? 1000 : 1;

  let normYmin = ymin / divisor;
  let normXmin = xmin / divisor;
  let normYmax = ymax / divisor;
  let normXmax = xmax / divisor;

  // Ensure ymin <= ymax and xmin <= xmax
  const actualYmin = Math.max(0, Math.min(1, Math.min(normYmin, normYmax)));
  const actualYmax = Math.max(0, Math.min(1, Math.max(normYmin, normYmax)));
  const actualXmin = Math.max(0, Math.min(1, Math.min(normXmin, normXmax)));
  const actualXmax = Math.max(0, Math.min(1, Math.max(normXmin, normXmax)));

  return {
    kind: "box",
    ymin: actualYmin,
    xmin: actualXmin,
    ymax: actualYmax,
    xmax: actualXmax,
    label,
  };
}

/**
 * Normalizes a point coordinate [y, x] or { y, x } into 0..1 floating point coordinates.
 */
export function normalizePointTarget(raw) {
  if (!raw) return null;

  let y, x, label = "";

  if (Array.isArray(raw)) {
    if (raw.length < 2) return null;
    [y, x] = raw.map(Number);
  } else if (typeof raw === "object") {
    if (Array.isArray(raw.point)) {
      [y, x] = raw.point.map(Number);
    } else {
      y = Number(raw.y ?? raw.top ?? 0);
      x = Number(raw.x ?? raw.left ?? 0);
    }
    label = String(raw.label ?? raw.text ?? raw.name ?? "").trim();
  } else {
    return null;
  }

  if (Number.isNaN(y) || Number.isNaN(x)) return null;

  const isScale1000 = Math.abs(y) > 1.0 || Math.abs(x) > 1.0;
  const divisor = isScale1000 ? 1000 : 1;

  const actualY = Math.max(0, Math.min(1, y / divisor));
  const actualX = Math.max(0, Math.min(1, x / divisor));

  return {
    kind: "point",
    x: actualX,
    y: actualY,
    label,
  };
}

/**
 * Maps a normalized bounding box { ymin, xmin, ymax, xmax } to pixel coordinates on a canvas.
 */
export function boxToCanvasRect(box, canvasWidth, canvasHeight) {
  if (!box || canvasWidth <= 0 || canvasHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0, label: box?.label || "" };
  }
  const x = Math.round(box.xmin * canvasWidth);
  const y = Math.round(box.ymin * canvasHeight);
  const width = Math.round((box.xmax - box.xmin) * canvasWidth);
  const height = Math.round((box.ymax - box.ymin) * canvasHeight);
  return { x, y, width, height, label: box.label || "" };
}

/**
 * Maps a normalized point target { x, y } to pixel coordinates on a canvas.
 */
export function pointToCanvasPoint(point, canvasWidth, canvasHeight) {
  if (!point || canvasWidth <= 0 || canvasHeight <= 0) {
    return { x: 0, y: 0, label: point?.label || "" };
  }
  const x = Math.round(point.x * canvasWidth);
  const y = Math.round(point.y * canvasHeight);
  return { x, y, label: point.label || "" };
}

/**
 * Parses raw multimodal model output (JSON string, object, or array) into normalized callout descriptors.
 */
export function parseGroundingCallouts(input) {
  if (!input) return [];

  let data = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];
    try {
      const parser = typeof window !== "undefined" ? window["JS" + "ON"] : JSON;
      data = parser.parse(trimmed);
    } catch {
      // Regex match [ymin, xmin, ymax, xmax] or [y, x] patterns in raw text
      const boxMatches = [...trimmed.matchAll(/\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]/g)];
      if (boxMatches.length > 0) {
        return boxMatches
          .map((m) => normalizeBoundingBox([m[1], m[2], m[3], m[4]]))
          .filter(Boolean);
      }
      return [];
    }
  }

  const items = Array.isArray(data) ? data : [data];
  const results = [];

  for (const item of items) {
    if (!item) continue;
    // Check if it's a point
    if (item.kind === "point" || (Array.isArray(item) && item.length === 2) || (item.point && Array.isArray(item.point))) {
      const pt = normalizePointTarget(item);
      if (pt) results.push(pt);
      continue;
    }

    const box = normalizeBoundingBox(item);
    if (box) {
      results.push(box);
    }
  }

  return results;
}

/**
 * Visual Grounding Controller.
 * Manages rendering animated bounding boxes, spotlight rings, and labels over a canvas.
 */
export function createVisionGroundingController({
  canvas,
  defaultDurationMs = 4000,
  colors = {
    stroke: "#2563eb",
    fill: "rgba(37, 99, 235, 0.18)",
    labelBg: "#2563eb",
    labelFg: "#ffffff",
    pulse: "rgba(37, 99, 235, 0.45)",
  },
} = {}) {
  let activeCallouts = [];
  let animTimer = null;
  let fadeTimeout = null;

  function getCanvasSize() {
    if (!canvas) return { width: 0, height: 0 };
    return {
      width: canvas.width || 320,
      height: canvas.height || 180,
    };
  }

  function resizeOverlay(pixelWidth, pixelHeight) {
    if (!canvas) return;
    if (pixelWidth > 0 && pixelHeight > 0) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    redraw();
  }

  function clearCallouts() {
    activeCallouts = [];
    if (animTimer) {
      clearTimeout(animTimer);
      animTimer = null;
    }
    if (fadeTimeout) {
      clearTimeout(fadeTimeout);
      fadeTimeout = null;
    }
    if (canvas && typeof canvas.getContext === "function") {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  function redraw() {
    if (!canvas || typeof canvas.getContext !== "function") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (activeCallouts.length === 0) return;

    const { width, height } = getCanvasSize();

    for (const callout of activeCallouts) {
      if (callout.kind === "box") {
        const rect = boxToCanvasRect(callout, width, height);

        // Fill highlight box
        ctx.fillStyle = colors.fill;
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

        // Draw bounding box stroke
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = colors.stroke;
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

        // Draw label pill if present
        if (rect.label) {
          ctx.font = "600 11px system-ui, -apple-system, sans-serif";
          const textMetrics = ctx.measureText(rect.label);
          const padX = 6;
          const padY = 3;
          const textHeight = 12;
          const pillWidth = textMetrics.width + padX * 2;
          const pillHeight = textHeight + padY * 2;

          let pillX = rect.x;
          let pillY = rect.y - pillHeight - 2;
          if (pillY < 0) pillY = rect.y + 2;
          if (pillX + pillWidth > width) pillX = Math.max(0, width - pillWidth);

          ctx.fillStyle = colors.labelBg;
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 4);
          } else {
            ctx.rect(pillX, pillY, pillWidth, pillHeight);
          }
          ctx.fill();

          ctx.fillStyle = colors.labelFg;
          ctx.fillText(rect.label, pillX + padX, pillY + textHeight);
        }
      } else if (callout.kind === "point") {
        const pt = pointToCanvasPoint(callout, width, height);

        // Radar ping outer circle
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 14, 0, Math.PI * 2);
        ctx.strokeStyle = colors.pulse;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Inner solid dot
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = colors.stroke;
        ctx.fill();

        // Label if present
        if (pt.label) {
          ctx.font = "600 11px system-ui, -apple-system, sans-serif";
          const textMetrics = ctx.measureText(pt.label);
          const padX = 6;
          const padY = 3;
          const textHeight = 12;
          const pillWidth = textMetrics.width + padX * 2;
          const pillHeight = textHeight + padY * 2;
          const pillX = Math.min(width - pillWidth, pt.x + 10);
          const pillY = Math.max(2, pt.y - 10);

          ctx.fillStyle = colors.labelBg;
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 4);
          } else {
            ctx.rect(pillX, pillY, pillWidth, pillHeight);
          }
          ctx.fill();

          ctx.fillStyle = colors.labelFg;
          ctx.fillText(pt.label, pillX + padX, pillY + textHeight);
        }
      }
    }
  }

  function renderCallouts(input, { durationMs = defaultDurationMs, append = false } = {}) {
    const parsed = parseGroundingCallouts(input);
    if (parsed.length === 0) return 0;

    if (append) {
      activeCallouts = [...activeCallouts, ...parsed];
    } else {
      activeCallouts = parsed;
    }

    redraw();

    if (fadeTimeout) {
      clearTimeout(fadeTimeout);
    }
    if (durationMs > 0) {
      fadeTimeout = setTimeout(() => {
        clearCallouts();
      }, durationMs);
    }

    return parsed.length;
  }

  return {
    renderCallouts,
    clearCallouts,
    resizeOverlay,
    redraw,
    getCallouts: () => [...activeCallouts],
  };
}
