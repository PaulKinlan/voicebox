import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_API_BASE,
  GEMINI_IMAGE_MODEL,
  GEMINI_VIDEO_MODEL,
  GEMINI_EMBEDDING_MODEL,
  GEMINI_GROUNDING_MODEL,
  listGeminiCapabilities,
  generateGeminiImage,
  startGeminiVideoGeneration,
  pollGeminiVideoOperation,
  embedGeminiTexts,
  cosineSimilarity,
  semanticSearchDocuments,
} from "../lib/gemini-models.mjs";

test("listGeminiCapabilities reports configured status when GEMINI_API_KEY is set or unset", () => {
  const unconfigured = listGeminiCapabilities({ apiKey: "" });
  assert.equal(unconfigured.ok, true);
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.capabilities.liveAudioVideo.available, false);
  assert.equal(unconfigured.capabilities.imageGeneration.available, false);
  assert.equal(unconfigured.capabilities.videoGeneration.available, false);
  assert.equal(unconfigured.capabilities.embeddings.available, false);
  assert.equal(unconfigured.capabilities.searchGrounding.available, false);

  const configured = listGeminiCapabilities({ apiKey: "test-gemini-key" });
  assert.equal(configured.ok, true);
  assert.equal(configured.configured, true);
  assert.equal(configured.capabilities.liveAudioVideo.available, true);
  assert.equal(configured.capabilities.imageGeneration.model, GEMINI_IMAGE_MODEL);
  assert.equal(configured.capabilities.videoGeneration.model, GEMINI_VIDEO_MODEL);
  assert.equal(configured.capabilities.embeddings.model, GEMINI_EMBEDDING_MODEL);
  assert.equal(configured.capabilities.searchGrounding.model, GEMINI_GROUNDING_MODEL);
});

test("generateGeminiImage refuses missing-api-key and missing-prompt and extracts base64 image + caption", async () => {
  const noKey = await generateGeminiImage({ prompt: "A neon studio mic", apiKey: "" });
  assert.deepEqual(noKey, {
    ok: false,
    refused: "missing-api-key",
    why: "GEMINI_API_KEY is not configured",
  });

  const noPrompt = await generateGeminiImage({ prompt: "   ", apiKey: "key-123" });
  assert.deepEqual(noPrompt, {
    ok: false,
    refused: "missing-prompt",
    why: "An image generation prompt is required",
  });

  const samplePngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const sampleBase64 = samplePngBytes.toString("base64");
  const calls = [];

  const mockFetch = async (url, init) => {
    calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  { text: "Generated a minimalist studio microphone icon." },
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: sampleBase64,
                    },
                  },
                ],
              },
            },
          ],
        };
      },
    };
  };

  const result = await generateGeminiImage({
    prompt: "Draw a minimalist studio microphone icon",
    aspectRatio: "16:9",
    referenceImages: [{ mimeType: "image/png", data: sampleBase64 }],
    apiKey: "key-img-99",
    fetchImpl: mockFetch,
  });

  assert.equal(result.ok, true);
  assert.equal(result.model, GEMINI_IMAGE_MODEL);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.data, sampleBase64);
  assert.deepEqual(result.bytes, samplePngBytes);
  assert.equal(result.caption, "Generated a minimalist studio microphone icon.");

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${GEMINI_API_BASE}/models/${GEMINI_IMAGE_MODEL}:generateContent?key=key-img-99`,
  );
  assert.deepEqual(calls[0].init.body.generationConfig, {
    responseModalities: ["TEXT", "IMAGE"],
    imageConfig: { aspectRatio: "16:9" },
  });
  assert.equal(calls[0].init.body.contents[0].parts.length, 2);
  assert.equal(
    calls[0].init.body.contents[0].parts[0].text,
    "Draw a minimalist studio microphone icon",
  );
  assert.deepEqual(calls[0].init.body.contents[0].parts[1], {
    inlineData: { mimeType: "image/png", data: sampleBase64 },
  });
});

test("startGeminiVideoGeneration and pollGeminiVideoOperation handle Veo long-running operations", async () => {
  const noKey = await startGeminiVideoGeneration({ prompt: "Ocean waves", apiKey: "" });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.refused, "missing-api-key");

  const badOp = await pollGeminiVideoOperation({
    operationName: "../etc/passwd",
    apiKey: "key-video",
  });
  assert.equal(badOp.ok, false);
  assert.equal(badOp.refused, "invalid-operation-name");

  const calls = [];
  let pollCount = 0;

  const mockFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
    if (url.includes(":predictLongRunning")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            name: "operations/veo-op-42",
            done: false,
          };
        },
      };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            name: "operations/veo-op-42",
            done: false,
          };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          name: "operations/veo-op-42",
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [
                {
                  video: {
                    uri: "https://generativelanguage.googleapis.com/v1beta/files/veo-42:download?alt=media",
                  },
                },
              ],
            },
          },
        };
      },
    };
  };

  const started = await startGeminiVideoGeneration({
    prompt: "Aerial timelapse of aurora borealis over snow peaks",
    aspectRatio: "16:9",
    durationSeconds: 6,
    apiKey: "key-veo-1",
    fetchImpl: mockFetch,
  });

  assert.deepEqual(started, {
    ok: true,
    model: GEMINI_VIDEO_MODEL,
    operationName: "operations/veo-op-42",
    done: false,
    status: "running",
  });
  assert.equal(
    calls[0].url,
    `${GEMINI_API_BASE}/models/${GEMINI_VIDEO_MODEL}:predictLongRunning?key=key-veo-1`,
  );
  assert.deepEqual(calls[0].body, {
    instances: [{ prompt: "Aerial timelapse of aurora borealis over snow peaks" }],
    parameters: { aspectRatio: "16:9", durationSeconds: 6 },
  });

  const firstPoll = await pollGeminiVideoOperation({
    operationName: started.operationName,
    apiKey: "key-veo-1",
    fetchImpl: mockFetch,
  });
  assert.deepEqual(firstPoll, {
    ok: true,
    operationName: "operations/veo-op-42",
    done: false,
    status: "running",
    videoUri: null,
    error: null,
  });

  const secondPoll = await pollGeminiVideoOperation({
    operationName: started.operationName,
    apiKey: "key-veo-1",
    fetchImpl: mockFetch,
  });
  assert.deepEqual(secondPoll, {
    ok: true,
    operationName: "operations/veo-op-42",
    done: true,
    status: "completed",
    videoUri: "https://generativelanguage.googleapis.com/v1beta/files/veo-42:download?alt=media",
    error: null,
  });
});

test("embedGeminiTexts, cosineSimilarity, and semanticSearchDocuments rank matching document #1", async () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(cosineSimilarity([], []), 0);

  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const embeddings = body.requests.map((req) => {
      const text = req.content.parts[0].text.toLowerCase();
      if (text.includes("auth") || text.includes("session") || text.includes("cookie") || text.includes("ticket")) {
        return { values: [0.95, 0.1, 0.05] };
      }
      if (text.includes("audio") || text.includes("pcm") || text.includes("worklet")) {
        return { values: [0.05, 0.96, 0.1] };
      }
      return { values: [0.1, 0.1, 0.95] };
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return { embeddings };
      },
    };
  };

  const batch = await embedGeminiTexts({
    texts: ["session cookie auth", "pcm16 audio worklet"],
    outputDimensionality: 3,
    apiKey: "key-embed-1",
    fetchImpl: mockFetch,
  });
  assert.equal(batch.ok, true);
  assert.equal(batch.model, GEMINI_EMBEDDING_MODEL);
  assert.equal(batch.embeddings.length, 2);
  assert.deepEqual(batch.embeddings[0], [0.95, 0.1, 0.05]);

  const docs = [
    {
      id: "docs/20-webassembly-tools.md",
      title: "WebAssembly Tools",
      text: "Digest-pinned WASI tool execution shelf with memory bounds.",
    },
    {
      id: "docs/18-loopback-session-auth.md",
      title: "Loopback Session Auth",
      text: "Single-use bootstrap ticket exchanged for an HttpOnly session cookie.",
    },
    {
      id: "public/pcm-worklet.js",
      title: "PCM Audio Worklet",
      text: "Streams 16 kHz PCM16 audio frames from the microphone.",
    },
  ];

  const search = await semanticSearchDocuments({
    query: "Where do we handle authentication tickets and session cookies?",
    documents: docs,
    topK: 2,
    apiKey: "key-embed-1",
    fetchImpl: mockFetch,
  });

  assert.equal(search.ok, true);
  assert.equal(search.results.length, 2);
  assert.equal(search.results[0].id, "docs/18-loopback-session-auth.md");
  assert.ok(search.results[0].score > 0.99);
  assert.ok(search.results[0].score > search.results[1].score);
});
