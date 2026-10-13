import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  detectLocalSpeechEngines,
  synthesizeSpeechOffline,
  transcribeAudioOffline,
} from "../lib/offline-speech.mjs";
import { createOfflineSpeechController } from "../public/offline-speech-client.mjs";
import { identifiersInRenderedText } from "../tools/rendered-plain-language.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_MODULE_PATH = path.join(ROOT, "public", "offline-speech-client.mjs");

describe("Local offline speech-to-text and text-to-speech fallback", () => {
  it("detects mock whisper-cli and piper binaries in PATH and transcribes/synthesizes offline", async () => {
    const scratchBin = mkdtempSync(path.join(os.tmpdir(), "vb-offline-speech-bin-"));
    try {
      const whisperScript = path.join(scratchBin, "whisper-cli");
      writeFileSync(
        whisperScript,
        "#!/bin/sh\necho \"open the files panel\"\n",
        "utf8",
      );
      chmodSync(whisperScript, 0o755);

      const piperScript = path.join(scratchBin, "piper");
      writeFileSync(
        piperScript,
        "#!/bin/sh\nprintf \"RIFF-mock-wav-bytes\"\n",
        "utf8",
      );
      chmodSync(piperScript, 0o755);

      const env = { PATH: scratchBin };
      const detected = detectLocalSpeechEngines({ env });
      assert.equal(detected.ok, true);
      assert.equal(detected.stt.available, true);
      assert.equal(detected.stt.engine, "whisper-cpp");
      assert.equal(detected.stt.binary, whisperScript);
      assert.equal(detected.tts.available, true);
      assert.equal(detected.tts.engine, "piper");
      assert.equal(detected.tts.binary, piperScript);

      const sttRes = await transcribeAudioOffline(Buffer.from([1, 2, 3, 4]), {
        env,
        language: "en",
      });
      assert.equal(sttRes.ok, true);
      assert.equal(sttRes.mode, "local-cli");
      assert.equal(sttRes.engine, "whisper-cpp");
      assert.equal(sttRes.transcript, "open the files panel");

      const ttsRes = await synthesizeSpeechOffline("Hello from local voice", { env });
      assert.equal(ttsRes.ok, true);
      assert.equal(ttsRes.mode, "local-cli");
      assert.equal(ttsRes.engine, "piper");
      assert.ok(ttsRes.audioBytes > 0);
      assert.equal(
        Buffer.from(ttsRes.audioBase64, "base64").toString("utf8"),
        "RIFF-mock-wav-bytes",
      );
    } finally {
      rmSync(scratchBin, { recursive: true, force: true });
    }
  });

  it("ignores relative and empty PATH entries while retaining trusted absolute speech binaries (voicebox-beads-34or)", async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-offline-speech-path-"));
    try {
      const relativeDir = path.join(scratch, "relative-bin");
      const absoluteDir = path.join(scratch, "absolute-bin");
      const marker = path.join(scratch, "untrusted-executed");
      mkdirSync(relativeDir);
      mkdirSync(absoluteDir);
      for (const binary of ["whisper-cli", "piper"]) {
        // The marker stub must never execute, even when the relative directory comes first.
        const untrusted = path.join(relativeDir, binary);
        writeFileSync(untrusted, `#!/bin/sh\nprintf executed > '${marker}'\nexit 1\n`);
        chmodSync(untrusted, 0o755);
        const trusted = path.join(absoluteDir, binary);
        writeFileSync(trusted, binary === "piper" ? "#!/bin/sh\nprintf RIFF-trusted\n" : "#!/bin/sh\necho trusted-transcript\n");
        chmodSync(trusted, 0o755);
      }

      const relativeSegment = path.relative(process.cwd(), relativeDir);
      const ignoredEnv = { PATH: ["", relativeSegment, ""].join(path.delimiter) };
      const ignored = detectLocalSpeechEngines({ env: ignoredEnv });
      assert.equal(ignored.stt.binary, null);
      assert.equal(ignored.tts.binary, null);
      const fallback = await transcribeAudioOffline(Buffer.from([1]), { env: ignoredEnv });
      assert.equal(fallback.fallback, "browser-speech-recognition");
      assert.equal(existsSync(marker), false);

      const trustedEnv = { PATH: ["", relativeSegment, absoluteDir, ""].join(path.delimiter) };
      const retained = detectLocalSpeechEngines({ env: trustedEnv });
      assert.equal(retained.stt.binary, path.join(absoluteDir, "whisper-cli"));
      assert.equal(retained.tts.binary, path.join(absoluteDir, "piper"));
      const transcript = await transcribeAudioOffline(Buffer.from([1]), { env: trustedEnv });
      assert.equal(transcript.transcript, "trusted-transcript");
      const speech = await synthesizeSpeechOffline("test", { env: trustedEnv });
      assert.equal(Buffer.from(speech.audioBase64, "base64").toString(), "RIFF-trusted");
      assert.equal(existsSync(marker), false);

      const configured = detectLocalSpeechEngines({
        env: { PATH: relativeSegment, VOICEBOX_WHISPER_CLI: path.join(absoluteDir, "whisper-cli") },
      });
      assert.equal(configured.stt.binary, path.join(absoluteDir, "whisper-cli"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("tolerates EPIPE when a local TTS binary exits immediately without draining large stdin (voicebox-beads-uck3)", async () => {
    const scratchBin = mkdtempSync(path.join(os.tmpdir(), "vb-offline-epipe-bin-"));
    try {
      const piperScript = path.join(scratchBin, "piper");
      writeFileSync(
        piperScript,
        "#!/bin/sh\nexec <&-\nprintf \"RIFF-early-exit-wav\"\nexit 0\n",
        "utf8",
      );
      chmodSync(piperScript, 0o755);

      const env = { PATH: scratchBin };
      const largeText = "Voicebox offline synthesis payload. ".repeat(8192);
      const ttsRes = await synthesizeSpeechOffline(largeText, { env });
      assert.equal(ttsRes.ok, true);
      assert.equal(ttsRes.mode, "local-cli");
      assert.equal(
        Buffer.from(ttsRes.audioBase64, "base64").toString("utf8"),
        "RIFF-early-exit-wav",
      );
    } finally {
      rmSync(scratchBin, { recursive: true, force: true });
    }
  });

  it("falls back to browser speech recognition and synthesis when PATH has no local speech binaries", async () => {
    const emptyEnv = { PATH: "" };
    const detected = detectLocalSpeechEngines({ env: emptyEnv });
    assert.equal(detected.stt.available, false);
    assert.equal(detected.stt.binary, null);
    assert.equal(detected.tts.available, false);
    assert.equal(detected.tts.binary, null);
    assert.deepEqual(detected.browserFallback, {
      webSpeechStt: true,
      speechSynthesisTts: true,
    });

    const emptyAudio = await transcribeAudioOffline(Buffer.alloc(0), { env: emptyEnv });
    assert.equal(emptyAudio.ok, false);
    assert.equal(emptyAudio.refused, "empty-audio");

    const sttFallback = await transcribeAudioOffline(Buffer.from([10, 20, 30]), {
      env: emptyEnv,
    });
    assert.equal(sttFallback.ok, false);
    assert.equal(sttFallback.fallback, "browser-speech-recognition");
    assert.equal(sttFallback.mode, "browser-fallback");

    const emptyText = await synthesizeSpeechOffline("   ", { env: emptyEnv });
    assert.equal(emptyText.ok, false);
    assert.equal(emptyText.refused, "empty-text");

    const ttsFallback = await synthesizeSpeechOffline("Ready when you are.", {
      env: emptyEnv,
      voice: "Alex",
      rate: 1.1,
    });
    assert.equal(ttsFallback.ok, true);
    assert.equal(ttsFallback.mode, "browser-speech-synthesis");
    assert.equal(ttsFallback.fallback, "browser-speech-synthesis");
    assert.equal(ttsFallback.text, "Ready when you are.");
    assert.equal(ttsFallback.voice, "Alex");
    assert.equal(ttsFallback.rate, 1.1);
  });

  it("drives browser SpeechSynthesis and SpeechRecognition in offline mode via createOfflineSpeechController", () => {
    const states = [];
    const transcripts = [];
    const spokenUtterances = [];
    let cancelledCount = 0;
    let lastRecognitionInstance = null;

    class MockUtterance {
      constructor(text) {
        this.text = text;
        this.rate = 1.0;
        this.pitch = 1.0;
      }
    }

    class MockSpeechRecognition {
      constructor() {
        this.continuous = false;
        this.interimResults = true;
        this.lang = "en-US";
        this.started = false;
        this.stopped = false;
        lastRecognitionInstance = this;
      }
      start() {
        this.started = true;
        this.onstart?.();
      }
      stop() {
        this.stopped = true;
        this.onend?.();
      }
    }

    const mockNavigator = { onLine: false };
    const mockWindow = {
      SpeechSynthesisUtterance: MockUtterance,
      SpeechRecognition: MockSpeechRecognition,
      speechSynthesis: {
        getVoices() {
          return [{ name: "Local English", lang: "en-US" }];
        },
        speak(utterance) {
          spokenUtterances.push(utterance);
          utterance.onend?.();
        },
        cancel() {
          cancelledCount += 1;
        },
      },
    };

    const controller = createOfflineSpeechController({
      windowObj: mockWindow,
      navigatorObj: mockNavigator,
      onTranscript(text, meta) {
        transcripts.push({ text, ...meta });
      },
      onStateChange(state) {
        states.push(state);
      },
    });

    assert.equal(controller.shouldUseOfflineFallback({ cloudProviderAvailable: true }), true);
    mockNavigator.onLine = true;
    assert.equal(controller.shouldUseOfflineFallback({ cloudProviderAvailable: false }), true);
    assert.equal(controller.shouldUseOfflineFallback({ cloudProviderAvailable: true }), false);

    const statusOffline = controller.getStatus({ cloudProviderAvailable: false });
    assert.deepEqual(statusOffline, {
      online: true,
      activeMode: "offline",
      browserSttSupported: true,
      browserTtsSupported: true,
    });

    const speakRes = controller.speak("Offline reply ready", {
      rate: 1.2,
      pitch: 1.0,
      voiceName: "Local English",
    });
    assert.equal(speakRes.ok, true);
    assert.equal(speakRes.mode, "browser-speech-synthesis");
    assert.equal(spokenUtterances.length, 1);
    assert.equal(spokenUtterances[0].text, "Offline reply ready");
    assert.equal(spokenUtterances[0].rate, 1.2);

    controller.stopSpeaking();
    assert.ok(cancelledCount >= 2);

    const listenRes = controller.startListening({ lang: "en-GB" });
    assert.equal(listenRes.ok, true);
    assert.equal(listenRes.mode, "browser-speech-recognition");
    assert.ok(lastRecognitionInstance);
    assert.equal(lastRecognitionInstance.started, true);

    lastRecognitionInstance.onresult?.({
      results: [[{ transcript: "switch to dark mode" }]],
    });
    assert.equal(transcripts.length, 1);
    assert.equal(transcripts[0].text, "switch to dark mode");

    controller.stopListening();
    assert.equal(lastRecognitionInstance.stopped, true);
    assert.ok(states.includes("speaking"));
    assert.ok(states.includes("listening"));
    assert.equal(states.at(-1), "idle");
  });

  it("public/offline-speech-client.mjs passes the plain-language source scan with 0 hits", () => {
    const source = readFileSync(CLIENT_MODULE_PATH, "utf8");
    const hits = identifiersInRenderedText(source);
    assert.deepEqual(
      hits,
      [],
      `Expected 0 plain-language hits in public/offline-speech-client.mjs, got: ${JSON.stringify(hits)}`,
    );
  });

  it("public/index.html includes offline voice fallback settings and passes plain-language scan", () => {
    const indexHtml = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
    assert.match(indexHtml, /id="setting-offline-speech-enabled"/);
    assert.match(indexHtml, /id="setting-offline-speech-state"/);

    const match = indexHtml.match(/<fieldset[^>]*id="settings-offline-voice-group"[\s\S]*?<\/fieldset>/i);
    assert.ok(match, "settings-offline-voice-group must exist in public/index.html");

    const hits = identifiersInRenderedText(match[0]);
    assert.deepEqual(
      hits,
      [],
      `Expected 0 plain-language hits in settings-offline-voice-group, got: ${JSON.stringify(hits)}`,
    );
  });
});
