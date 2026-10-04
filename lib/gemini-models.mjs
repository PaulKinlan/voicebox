// lib/gemini-models.mjs — Unified, zero-dependency Gemini multi-model client and
// workspace semantic search for Voicebox.
//
// A single host-held GEMINI_API_KEY unlocks the broader Gemini model family alongside
// the real-time BidiGenerateContent voice session (lib/live-providers/gemini.mjs):
//   1. Conversational Image Generation & Editing (gemini-2.5-flash-image)
//   2. Long-Running Video Generation with Veo (veo-2.0-generate-001)
//   3. Text & Code Embeddings + Cosine Semantic Search (text-embedding-004)
//   4. Search-Grounded Reasoning (gemini-2.5-flash with googleSearch tool)
//
// All network calls use injected fetchImpl (defaulting to globalThis.fetch) and
// return structured { ok: true, ... } or named refusals { ok: false, refused, why }.

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
export const GEMINI_VIDEO_MODEL = "veo-2.0-generate-001";
export const GEMINI_EMBEDDING_MODEL = "text-embedding-004";
export const GEMINI_GROUNDING_MODEL = "gemini-2.5-flash";

function normalizeModelId(model, fallback) {
  const raw = String(model || fallback).trim();
  return raw.startsWith("models/") ? raw.slice("models/".length) : raw;
}

function resolveApiKey(apiKey) {
  const key = apiKey !== undefined ? apiKey : process.env.GEMINI_API_KEY;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : "";
}

/**
 * Reports which Gemini multi-model capabilities are available given the host's
 * GEMINI_API_KEY configuration.
 */
export function listGeminiCapabilities({ apiKey = process.env.GEMINI_API_KEY } = {}) {
  const configured = Boolean(resolveApiKey(apiKey));
  return {
    ok: true,
    configured,
    capabilities: {
      liveAudioVideo: {
        available: configured,
        model: "models/gemini-3.8-live",
        endpoint: "BidiGenerateContent",
        modalities: ["AUDIO", "VIDEO", "TEXT"],
      },
      imageGeneration: {
        available: configured,
        model: GEMINI_IMAGE_MODEL,
        endpoint: ":generateContent",
        modalities: ["TEXT", "IMAGE"],
      },
      videoGeneration: {
        available: configured,
        model: GEMINI_VIDEO_MODEL,
        endpoint: ":predictLongRunning",
        modalities: ["VIDEO"],
      },
      embeddings: {
        available: configured,
        model: GEMINI_EMBEDDING_MODEL,
        endpoint: ":batchEmbedContents",
        modalities: ["EMBEDDING"],
      },
      searchGrounding: {
        available: configured,
        model: GEMINI_GROUNDING_MODEL,
        endpoint: ":generateContent",
        tools: ["googleSearch"],
      },
    },
  };
}

/**
 * Generates or edits an image using Gemini's native multimodal image output
 * (`gemini-2.5-flash-image` with `responseModalities: ["TEXT", "IMAGE"]`).
 */
export async function generateGeminiImage({
  prompt,
  model = GEMINI_IMAGE_MODEL,
  aspectRatio = "1:1",
  referenceImages = [],
  apiKey = process.env.GEMINI_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = resolveApiKey(apiKey);
  if (!key) {
    return { ok: false, refused: "missing-api-key", why: "GEMINI_API_KEY is not configured" };
  }
  const cleanPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!cleanPrompt) {
    return { ok: false, refused: "missing-prompt", why: "An image generation prompt is required" };
  }

  const cleanModel = normalizeModelId(model, GEMINI_IMAGE_MODEL);
  const referenceImageParts = (Array.isArray(referenceImages) ? referenceImages : [])
    .filter((img) => img && typeof img === "object")
    .map((img) => {
      const inline = img.inlineData ?? img;
      const rawData = Buffer.isBuffer(inline.data)
        ? inline.data.toString("base64")
        : String(inline.data ?? "");
      return {
        inlineData: {
          mimeType: inline.mimeType || "image/png",
          data: rawData,
        },
      };
    })
    .filter((part) => part.inlineData.data.length > 0);

  const url = `${GEMINI_API_BASE}/models/${cleanModel}:generateContent?key=${encodeURIComponent(key)}`;
  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: cleanPrompt }, ...referenceImageParts],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
    },
  };

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      ok: false,
      refused: "upstream-unreachable",
      why: `Could not reach Gemini image endpoint: ${err?.message ?? err}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      refused: "upstream-error",
      status: res.status,
      why: `Gemini image endpoint returned HTTP ${res.status}`,
    };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      refused: "invalid-json",
      why: "Gemini image endpoint returned unreadable JSON",
    };
  }

  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
  const inline = imagePart?.inlineData ?? imagePart?.inline_data;
  if (!inline?.data) {
    return {
      ok: false,
      refused: "no-image-returned",
      why: "Model response did not include inline image data",
    };
  }

  const mimeType = inline.mimeType ?? inline.mime_type ?? "image/png";
  const data = String(inline.data);
  const caption = parts
    .filter((p) => typeof p?.text === "string" && p.text.trim())
    .map((p) => p.text.trim())
    .join("\n");

  return {
    ok: true,
    model: cleanModel,
    mimeType,
    data,
    bytes: Buffer.from(data, "base64"),
    caption,
  };
}

/**
 * Starts an asynchronous video generation operation using Veo (`:predictLongRunning`).
 */
export async function startGeminiVideoGeneration({
  prompt,
  model = GEMINI_VIDEO_MODEL,
  aspectRatio = "16:9",
  durationSeconds = 5,
  apiKey = process.env.GEMINI_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = resolveApiKey(apiKey);
  if (!key) {
    return { ok: false, refused: "missing-api-key", why: "GEMINI_API_KEY is not configured" };
  }
  const cleanPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!cleanPrompt) {
    return { ok: false, refused: "missing-prompt", why: "A video generation prompt is required" };
  }

  const cleanModel = normalizeModelId(model, GEMINI_VIDEO_MODEL);
  const url = `${GEMINI_API_BASE}/models/${cleanModel}:predictLongRunning?key=${encodeURIComponent(key)}`;
  const payload = {
    instances: [{ prompt: cleanPrompt }],
    parameters: {
      aspectRatio,
      durationSeconds,
    },
  };

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      ok: false,
      refused: "upstream-unreachable",
      why: `Could not reach Gemini video endpoint: ${err?.message ?? err}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      refused: "upstream-error",
      status: res.status,
      why: `Gemini video endpoint returned HTTP ${res.status}`,
    };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      refused: "invalid-json",
      why: "Gemini video endpoint returned unreadable JSON",
    };
  }

  if (!body?.name || typeof body.name !== "string") {
    return {
      ok: false,
      refused: "invalid-operation",
      why: "Gemini video endpoint did not return an operation name",
    };
  }

  const done = Boolean(body.done);
  return {
    ok: true,
    model: cleanModel,
    operationName: body.name,
    done,
    status: done ? "completed" : "running",
  };
}

/**
 * Polls a long-running Veo video generation operation (`GET /v1beta/{operationName}`).
 */
export async function pollGeminiVideoOperation({
  operationName,
  apiKey = process.env.GEMINI_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = resolveApiKey(apiKey);
  if (!key) {
    return { ok: false, refused: "missing-api-key", why: "GEMINI_API_KEY is not configured" };
  }
  const cleanOp = typeof operationName === "string" ? operationName.trim() : "";
  if (
    !cleanOp ||
    !/^(operations|models)\/[a-zA-Z0-9._/-]+$/.test(cleanOp) ||
    cleanOp.includes("..")
  ) {
    return {
      ok: false,
      refused: "invalid-operation-name",
      why: "operationName must start with 'operations/' or 'models/'",
    };
  }

  const url = `${GEMINI_API_BASE}/${cleanOp}?key=${encodeURIComponent(key)}`;
  let res;
  try {
    res = await fetchImpl(url, { method: "GET" });
  } catch (err) {
    return {
      ok: false,
      refused: "upstream-unreachable",
      why: `Could not poll Gemini video operation: ${err?.message ?? err}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      refused: "upstream-error",
      status: res.status,
      why: `Gemini operation poll returned HTTP ${res.status}`,
    };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      refused: "invalid-json",
      why: "Gemini operation poll returned unreadable JSON",
    };
  }

  const done = Boolean(body.done);
  const videoUri = done
    ? (body.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ??
       body.response?.videos?.[0]?.uri ??
       body.response?.predictions?.[0]?.videoUri ??
       body.response?.predictions?.[0]?.uri ??
       body.response?.videoUri ??
       null)
    : null;
  const status = done ? (body.error ? "failed" : "completed") : "running";

  return {
    ok: true,
    operationName: body.name ?? cleanOp,
    done,
    status,
    videoUri,
    error: body.error ?? null,
  };
}

/**
 * Generates vector embeddings for one or more text inputs using `:batchEmbedContents`.
 */
export async function embedGeminiTexts({
  texts = [],
  model = GEMINI_EMBEDDING_MODEL,
  taskType = "RETRIEVAL_DOCUMENT",
  outputDimensionality,
  apiKey = process.env.GEMINI_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = resolveApiKey(apiKey);
  if (!key) {
    return { ok: false, refused: "missing-api-key", why: "GEMINI_API_KEY is not configured" };
  }
  if (!Array.isArray(texts) || texts.length === 0) {
    return { ok: false, refused: "missing-texts", why: "A non-empty texts array is required" };
  }
  const normalizedTexts = texts.map((t) => String(t ?? "").trim());
  if (normalizedTexts.some((t) => t.length === 0)) {
    return { ok: false, refused: "empty-text-item", why: "All texts to embed must be non-empty strings" };
  }

  const cleanModel = normalizeModelId(model, GEMINI_EMBEDDING_MODEL);
  const modelResource = `models/${cleanModel}`;
  const url = `${GEMINI_API_BASE}/${modelResource}:batchEmbedContents?key=${encodeURIComponent(key)}`;

  const requests = normalizedTexts.map((text) => ({
    model: modelResource,
    content: { parts: [{ text }] },
    ...(taskType ? { taskType } : {}),
    ...(Number.isInteger(outputDimensionality) && outputDimensionality > 0
      ? { outputDimensionality }
      : {}),
  }));

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests }),
    });
  } catch (err) {
    return {
      ok: false,
      refused: "upstream-unreachable",
      why: `Could not reach Gemini embedding endpoint: ${err?.message ?? err}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      refused: "upstream-error",
      status: res.status,
      why: `Gemini embedding endpoint returned HTTP ${res.status}`,
    };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      refused: "invalid-json",
      why: "Gemini embedding endpoint returned unreadable JSON",
    };
  }

  const rawList = Array.isArray(body?.embeddings)
    ? body.embeddings
    : body?.embedding
      ? [body.embedding]
      : [];
  const vectors = rawList
    .map((entry) => (Array.isArray(entry?.values) ? entry.values.map((v) => Number(v) || 0) : null))
    .filter((vec) => Array.isArray(vec));

  if (vectors.length !== normalizedTexts.length) {
    return {
      ok: false,
      refused: "invalid-embeddings",
      why: `Expected ${normalizedTexts.length} embedding vector(s), received ${vectors.length}`,
    };
  }

  return {
    ok: true,
    model: cleanModel,
    embeddings: vectors,
  };
}

/**
 * Computes the cosine similarity in [-1, 1] between two numeric vectors.
 */
export function cosineSimilarity(vecA = [], vecB = []) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB)) return 0;
  const len = Math.min(vecA.length, vecB.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const a = Number(vecA[i]) || 0;
    const b = Number(vecB[i]) || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Performs semantic search over an array of workspace documents (`{ id, title, text }`)
 * by embedding the query (`RETRIEVAL_QUERY`) and documents (`RETRIEVAL_DOCUMENT`) and
 * ranking by cosine similarity.
 */
export async function semanticSearchDocuments({
  query,
  documents = [],
  model = GEMINI_EMBEDDING_MODEL,
  topK = 5,
  apiKey = process.env.GEMINI_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = resolveApiKey(apiKey);
  if (!key) {
    return { ok: false, refused: "missing-api-key", why: "GEMINI_API_KEY is not configured" };
  }
  const cleanQuery = typeof query === "string" ? query.trim() : "";
  if (!cleanQuery) {
    return { ok: false, refused: "missing-query", why: "A search query is required" };
  }
  if (!Array.isArray(documents)) {
    return { ok: false, refused: "invalid-documents", why: "documents must be an array" };
  }
  if (documents.length === 0) {
    return { ok: true, query: cleanQuery, results: [] };
  }

  const validDocs = documents.filter(
    (d) => d && typeof d === "object" && String(d.text ?? d.title ?? "").trim().length > 0,
  );
  if (validDocs.length === 0) {
    return { ok: true, query: cleanQuery, results: [] };
  }

  const queryEmbed = await embedGeminiTexts({
    texts: [cleanQuery],
    model,
    taskType: "RETRIEVAL_QUERY",
    apiKey: key,
    fetchImpl,
  });
  if (!queryEmbed.ok) return queryEmbed;

  const docTexts = validDocs.map((d) =>
    [d.title, d.text].filter((part) => typeof part === "string" && part.trim()).join("\n"),
  );
  const docEmbeds = await embedGeminiTexts({
    texts: docTexts,
    model,
    taskType: "RETRIEVAL_DOCUMENT",
    apiKey: key,
    fetchImpl,
  });
  if (!docEmbeds.ok) return docEmbeds;

  const queryVec = queryEmbed.embeddings[0];
  const scored = validDocs.map((doc, idx) => ({
    id: doc.id ?? String(idx),
    ...(doc.title !== undefined ? { title: doc.title } : {}),
    text: doc.text ?? "",
    score: cosineSimilarity(queryVec, docEmbeds.embeddings[idx]),
  }));

  scored.sort((a, b) => b.score - a.score);
  const limit = Number.isInteger(topK) && topK > 0 ? topK : 5;

  return {
    ok: true,
    query: cleanQuery,
    results: scored.slice(0, limit),
  };
}
