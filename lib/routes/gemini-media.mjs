/**
 * @summary Gemini media capabilities and processing endpoints.
 */
// lib/routes/gemini-media.mjs — the room's Gemini media routes.
//
// Extracted from server.mjs (voicebox-beads-r9hv.4, slice 3 of the voicebox-beads-r9hv ADR): four
// CONTIGUOUS entries — GET /api/gemini/capabilities, POST /api/gemini/image, POST /api/gemini/video,
// POST /api/gemini/embed — owned here and spread back into the host's route table at the SAME position,
// between ...activityRoutes and "DELETE /api/root". Order is not decoration in this table: it is dispatch.
//
// WHY THIS SLICE, AND WHAT IT IS NOT. The ADR measured server.mjs as the repo's collision hotspot (214
// commits in 30 days against 1-2 for each lib/routes module) and named this group as the only SUBSTANTIVE
// one (90 lines) with no module-level mutable-state writes. It is NOT a speed win: a change here still maps
// to ~137 tests, because server.mjs imports this module and 137 test files name server.mjs. Do not claim
// otherwise in a landing summary.
//
// THE BODIES ARE MOVED VERBATIM, with exactly two seams.
//
//   1. THE LIVE ROOT READ. `POST /api/gemini/image` honours `saveAs` only when the ACTIVE root is a machine
//      root. In server.mjs `active` is a module-level `let` that is REASSIGNED when a root is declared or
//      deleted, so the host passes `getActiveRoot` and each handler reads it into a local `active` on every
//      request — which keeps the moved body character-for-character what it was. Handing the value over
//      would freeze the boot-time root for the life of the process (the voicebox-beads-w1f9 shape):
//      tests/gemini-media-route-seam.test.mjs drives the handler twice with the accessor changing in
//      between, which is what a snapshot fails.
//
//   2. THE PROVIDER CALLS ARRIVE AS DEPS. These handlers reach for external media APIs, so they receive
//      `generateGeminiImage`, `startGeminiVideoGeneration`, `pollGeminiVideoOperation`, `embedGeminiTexts`
//      and `semanticSearchDocuments` from the host rather than importing them. That is what makes the
//      focused test possible at all: it drives every branch with injected fakes and asserts that NO
//      external network call happens (a fetch spy that throws if touched), rather than asserting model
//      output against a live provider.
//
// WHAT DID NOT MOVE, deliberately: the refusal shapes and their ORDER (a non-JSON body is refused with 400
// `bad-request` BEFORE any provider call, so a refusing request never reaches out), the image route's larger
// `CONTENT_JSON_BODY_MAX_BYTES` cap and the other POSTs' reader default, `answerOnce`'s single-answer
// discipline, the `saveAs` write (host filesystem, still through the host's `resolveActive`), and the whole
// FENCED static/CSP surface, which this slice does not touch. `node:fs` and `node:path` are imported here
// directly, the way lib/routes/workspace.mjs does; they are stdlib, not host state.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Build the Gemini media routes.
 *
 * @param {object} deps
 * @param {(res: any, status: number, payload: any) => any} deps.json      server.mjs's JSON responder (identical envelope)
 * @param {(req: any, res: any, max?: number) => Promise<any>} deps.readJsonBody  bounded JSON reader
 * @param {(res: any, fn: () => any) => any} deps.answerOnce              single-answer discipline
 * @param {(name: string) => { ok: boolean, path?: string }} deps.resolveActive  the host's path seam
 * @param {() => any} deps.getActiveRoot                                 LIVE read of server.mjs's `active` — never a snapshot
 * @param {number} deps.contentBodyMaxBytes                              the larger body cap the image route takes
 * @param {() => any} deps.listGeminiCapabilities                        model catalogue (reads the environment for a key)
 * @param {any} deps.liveConfigCatalogue                                the frozen live-config catalogue
 * @param {(args: any) => Promise<any>} deps.generateGeminiImage          provider: image
 * @param {(args: any) => Promise<any>} deps.startGeminiVideoGeneration   provider: video start
 * @param {(args: any) => Promise<any>} deps.pollGeminiVideoOperation     provider: video poll
 * @param {(args: any) => Promise<any>} deps.embedGeminiTexts             provider: embeddings
 * @param {(args: any) => Promise<any>} deps.semanticSearchDocuments      provider: semantic search
 * @returns {Record<string, (req: any, res: any, url?: any) => any>} the route table entries, in their original order
 */
export function createGeminiMediaRoutes({
  json,
  readJsonBody,
  answerOnce,
  resolveActive,
  getActiveRoot,
  contentBodyMaxBytes,
  listGeminiCapabilities,
  liveConfigCatalogue,
  generateGeminiImage,
  startGeminiVideoGeneration,
  pollGeminiVideoOperation,
  embedGeminiTexts,
  semanticSearchDocuments,
}) {
  return {
    "GET /api/gemini/capabilities": (req, res) => {
      return json(res, 200, {
        ...listGeminiCapabilities(),
        liveConfigCatalogue,
      });
    },
    // referenceImages are base64 pictures — a content body, so the larger cap (voicebox-beads-d808).
    "POST /api/gemini/image": async (req, res) => {
      // LIVE, per request: `active` is reassigned when a root is declared or deleted (see the header).
      const active = typeof getActiveRoot === "function" ? getActiveRoot() : null;
      const parsed = await readJsonBody(req, res, contentBodyMaxBytes);
      if (parsed === null || typeof parsed !== "object") {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON" });
      }
      return answerOnce(res, async () => {
        const generated = await generateGeminiImage({
          prompt: parsed?.prompt,
          model: parsed?.model,
          aspectRatio: parsed?.aspectRatio,
          referenceImages: Array.isArray(parsed?.referenceImages) ? parsed.referenceImages : [],
        });
        if (!generated.ok) return json(res, 400, generated);
        let savedFile = null;
        if (typeof parsed?.saveAs === "string" && parsed.saveAs.trim() && active?.root?.kind === "machine") {
          const target = resolveActive(parsed.saveAs.trim());
          if (target.ok) {
            mkdirSync(path.dirname(target.path), { recursive: true });
            writeFileSync(target.path, generated.bytes);
            savedFile = parsed.saveAs.trim();
          }
        }
        return json(res, 200, {
          ok: true,
          model: generated.model,
          mimeType: generated.mimeType,
          data: generated.data,
          caption: generated.caption,
          savedFile,
        });
      });
    },
    "POST /api/gemini/video": async (req, res) => {
      const parsed = await readJsonBody(req, res);
      if (parsed === null || typeof parsed !== "object") {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON" });
      }
      return answerOnce(res, async () => {
        if (typeof parsed?.operationName === "string" && parsed.operationName.trim()) {
          const polled = await pollGeminiVideoOperation({ operationName: parsed.operationName.trim() });
          return json(res, polled.ok ? 200 : 400, polled);
        }
        const started = await startGeminiVideoGeneration({
          prompt: parsed?.prompt,
          model: parsed?.model,
          aspectRatio: parsed?.aspectRatio,
          durationSeconds: parsed?.durationSeconds,
        });
        return json(res, started.ok ? 200 : 400, started);
      });
    },
    "POST /api/gemini/embed": async (req, res) => {
      const parsed = await readJsonBody(req, res);
      if (parsed === null || typeof parsed !== "object") {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON" });
      }
      return answerOnce(res, async () => {
        if (typeof parsed?.query === "string" && Array.isArray(parsed?.documents)) {
          const searchResult = await semanticSearchDocuments({
            query: parsed.query,
            documents: parsed.documents,
            model: parsed?.model,
            topK: parsed?.topK,
          });
          return json(res, searchResult.ok ? 200 : 400, searchResult);
        }
        const embedded = await embedGeminiTexts({
          texts: Array.isArray(parsed?.texts) ? parsed.texts : (typeof parsed?.text === "string" ? [parsed.text] : []),
          model: parsed?.model,
          taskType: parsed?.taskType,
          outputDimensionality: parsed?.outputDimensionality,
        });
        return json(res, embedded.ok ? 200 : 400, embedded);
      });
    },
  };
}
