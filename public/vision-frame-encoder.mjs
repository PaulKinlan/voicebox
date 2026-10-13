// public/vision-frame-encoder.mjs — Off-main-thread video frame encoder and bounded memory cache.

/**
 * Creates a FIFO bounded Set for ID deduplication that evicts the oldest entries when maxSize is reached.
 * @param {number} maxSize - Maximum entries to keep in memory (default 200).
 */
export function createBoundedSeenSet(maxSize = 200) {
  const limit = Math.max(1, Number(maxSize) || 200);
  const items = new Set();

  return {
    has(id) {
      return items.has(id);
    },
    add(id) {
      if (items.has(id)) return this;
      if (items.size >= limit) {
        const oldest = items.values().next().value;
        if (oldest !== undefined) {
          items.delete(oldest);
        }
      }
      items.add(id);
      return this;
    },
    delete(id) {
      return items.delete(id);
    },
    clear() {
      items.clear();
    },
    get size() {
      return items.size;
    },
  };
}

/**
 * Helper to convert Blob to base64 string.
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === "undefined") {
      if (typeof blob.arrayBuffer === "function") {
        blob.arrayBuffer().then((buf) => {
          const b64 = Buffer.from(buf).toString("base64");
          resolve(b64);
        }).catch(reject);
        return;
      }
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = String(reader.result || "");
      const commaIdx = res.indexOf(",");
      resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res);
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Encodes a video element frame into JPEG base64, using OffscreenCanvas where available
 * with an async fallback to a DOM canvas.
 *
 * @param {HTMLVideoElement|any} videoEl
 * @param {number} targetW
 * @param {number} targetH
 * @param {number} quality
 * @param {HTMLCanvasElement|any} fallbackCanvas
 * @returns {Promise<{ width: number, height: number, base64: string }>}
 */
export async function encodeVisionFrame(videoEl, targetW, targetH, quality = 0.78, fallbackCanvas = null) {
  const width = Math.max(1, Math.round(targetW));
  const height = Math.max(1, Math.round(targetH));

  // Try OffscreenCanvas if available
  if (typeof OffscreenCanvas !== "undefined") {
    try {
      const offscreen = new OffscreenCanvas(width, height);
      const ctx = offscreen.getContext("2d");
      if (ctx) {
        ctx.drawImage(videoEl, 0, 0, width, height);
        if (typeof offscreen.convertToBlob === "function") {
          const blob = await offscreen.convertToBlob({ type: "image/jpeg", quality });
          const base64 = await blobToBase64(blob);
          return { width, height, base64 };
        }
      }
    } catch {
      // Fall through to fallback canvas if OffscreenCanvas fails
    }
  }

  // Fallback to DOM canvas
  if (fallbackCanvas) {
    try {
      fallbackCanvas.width = width;
      fallbackCanvas.height = height;
      const ctx = fallbackCanvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(videoEl, 0, 0, width, height);
        if (typeof fallbackCanvas.toBlob === "function") {
          const blob = await new Promise((resolve) => {
            fallbackCanvas.toBlob(resolve, "image/jpeg", quality);
          });
          if (blob) {
            const base64 = await blobToBase64(blob);
            return { width, height, base64 };
          }
        }
        if (typeof fallbackCanvas.toDataURL === "function") {
          const dataUrl = fallbackCanvas.toDataURL("image/jpeg", quality);
          const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
          return { width, height, base64 };
        }
      }
    } catch (err) {
      console.warn("[voicebox] canvas frame encoding error:", err?.message ?? err);
    }
  }

  return { width, height, base64: "" };
}
