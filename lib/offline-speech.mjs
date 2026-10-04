import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STT_CANDIDATES = [
  { binary: "whisper-cli", engine: "whisper-cpp" },
  { binary: "whisper-cpp", engine: "whisper-cpp" },
  { binary: "whisper", engine: "whisper" },
  { binary: "faster-whisper", engine: "faster-whisper" },
];

const TTS_CANDIDATES = [
  { binary: "piper", engine: "piper" },
  { binary: "espeak-ng", engine: "espeak-ng" },
  { binary: "espeak", engine: "espeak" },
  { binary: "say", engine: "macos-say" },
  { binary: "spd-say", engine: "speech-dispatcher" },
];

function isExecutableFile(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  try {
    accessSync(filePath, fsConstants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getSearchDirectories(env = process.env) {
  const hasExplicitPath = Object.prototype.hasOwnProperty.call(env, "PATH");
  const rawPath = typeof env.PATH === "string" ? env.PATH : "";
  const fromPath = rawPath
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (hasExplicitPath && env !== process.env) {
    return fromPath;
  }

  const home = env.HOME || os.homedir();
  const extraDirs = [
    home ? path.join(home, ".local", "bin") : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ].filter(Boolean);

  return [...new Set([...fromPath, ...extraDirs])];
}

function resolveCandidate(candidates, overridePath, searchDirs) {
  if (overridePath && typeof overridePath === "string") {
    const trimmed = overridePath.trim();
    if (trimmed) {
      if (path.isAbsolute(trimmed) && isExecutableFile(trimmed)) {
        return { binary: trimmed, engine: path.basename(trimmed) };
      }
      for (const dir of searchDirs) {
        const resolved = path.join(dir, trimmed);
        if (isExecutableFile(resolved)) {
          return { binary: resolved, engine: path.basename(trimmed) };
        }
      }
    }
  }

  for (const candidate of candidates) {
    for (const dir of searchDirs) {
      const fullPath = path.join(dir, candidate.binary);
      if (isExecutableFile(fullPath)) {
        return { binary: fullPath, engine: candidate.engine };
      }
    }
  }
  return { binary: null, engine: null };
}

/**
 * Inspects PATH for local offline STT (Whisper) and TTS (Piper / espeak / say) binaries.
 */
export function detectLocalSpeechEngines({ env = process.env } = {}) {
  const searchDirs = getSearchDirectories(env);
  const sttMatch = resolveCandidate(STT_CANDIDATES, env.VOICEBOX_WHISPER_CLI, searchDirs);
  const ttsMatch = resolveCandidate(TTS_CANDIDATES, env.VOICEBOX_PIPER_CLI, searchDirs);

  return {
    ok: true,
    stt: {
      available: Boolean(sttMatch.binary),
      engine: sttMatch.engine,
      binary: sttMatch.binary,
    },
    tts: {
      available: Boolean(ttsMatch.binary),
      engine: ttsMatch.engine,
      binary: ttsMatch.binary,
    },
    browserFallback: {
      webSpeechStt: true,
      speechSynthesisTts: true,
    },
  };
}

function runBinary(binary, args, { env = process.env, timeoutMs = 15000, stdinBuffer = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(new Error(`Offline speech command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (code !== 0) {
        reject(new Error(stderr.toString("utf8").trim() || `Exited with status ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    if (stdinBuffer && stdinBuffer.length > 0) {
      child.stdin.write(stdinBuffer);
    }
    child.stdin.end();
  });
}

/**
 * Transcribes raw audio bytes using a local Whisper CLI binary when available,
 * or instructs the caller to use browser SpeechRecognition fallback.
 */
export async function transcribeAudioOffline(
  audioBuffer,
  { env = process.env, language = "en", timeoutMs = 15000 } = {},
) {
  const isByteSource =
    Buffer.isBuffer(audioBuffer) ||
    audioBuffer instanceof Uint8Array ||
    audioBuffer instanceof ArrayBuffer;
  const buf = isByteSource ? Buffer.from(audioBuffer) : null;

  if (!buf || buf.length === 0) {
    return {
      ok: false,
      refused: "empty-audio",
      why: "Audio buffer is empty.",
    };
  }

  const engines = detectLocalSpeechEngines({ env });
  if (!engines.stt.available || !engines.stt.binary) {
    return {
      ok: false,
      fallback: "browser-speech-recognition",
      mode: "browser-fallback",
      why: "No local Whisper binary found in PATH; use browser SpeechRecognition fallback.",
    };
  }

  const tempId = `voicebox-stt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempWavPath = path.join(os.tmpdir(), `${tempId}.wav`);
  const tempTxtPath = `${tempWavPath}.txt`;

  try {
    writeFileSync(tempWavPath, buf);
    const { stdout } = await runBinary(
      engines.stt.binary,
      ["--language", String(language || "en"), tempWavPath],
      { env, timeoutMs },
    );

    let transcript = stdout.toString("utf8").trim();
    if (!transcript && existsSync(tempTxtPath)) {
      transcript = readFileSync(tempTxtPath, "utf8").trim();
    }

    return {
      ok: true,
      mode: "local-cli",
      engine: engines.stt.engine,
      transcript,
    };
  } catch (err) {
    return {
      ok: false,
      fallback: "browser-speech-recognition",
      mode: "browser-fallback",
      engine: engines.stt.engine,
      why: err?.message || "Local transcription command failed.",
    };
  } finally {
    try {
      rmSync(tempWavPath, { force: true });
    } catch {}
    try {
      rmSync(tempTxtPath, { force: true });
    } catch {}
  }
}

/**
 * Synthesizes speech offline using a local CLI TTS binary (such as Piper) or returns
 * a browser SpeechSynthesis fallback payload.
 */
export async function synthesizeSpeechOffline(
  text,
  { env = process.env, voice = "", rate = 1.0, timeoutMs = 10000 } = {},
) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return {
      ok: false,
      refused: "empty-text",
      why: "Text to synthesize is empty.",
    };
  }

  const engines = detectLocalSpeechEngines({ env });
  const preferCli =
    env.VOICEBOX_OFFLINE_TTS_PREFER_CLI === "1" ||
    Boolean(env.VOICEBOX_PIPER_CLI) ||
    (engines.tts.available && engines.tts.engine !== "macos-say" && env.VOICEBOX_OFFLINE_TTS_PREFER_CLI !== "0");

  if (engines.tts.available && engines.tts.binary && preferCli) {
    const tempId = `voicebox-tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempOutPath = path.join(os.tmpdir(), `${tempId}.wav`);

    try {
      const { stdout } = await runBinary(
        engines.tts.binary,
        ["--output_file", tempOutPath, "--text", trimmed],
        {
          env,
          timeoutMs,
          stdinBuffer: Buffer.from(trimmed, "utf8"),
        },
      );

      let audioBuf = Buffer.alloc(0);
      if (existsSync(tempOutPath) && statSync(tempOutPath).size > 0) {
        audioBuf = readFileSync(tempOutPath);
      } else if (stdout.length > 0) {
        audioBuf = stdout;
      }

      if (audioBuf.length > 0) {
        return {
          ok: true,
          mode: "local-cli",
          engine: engines.tts.engine,
          audioBytes: audioBuf.length,
          audioBase64: audioBuf.toString("base64"),
        };
      }
    } catch {
      // Fall through to browser speech synthesis fallback on CLI failure.
    } finally {
      try {
        rmSync(tempOutPath, { force: true });
      } catch {}
    }
  }

  return {
    ok: true,
    mode: "browser-speech-synthesis",
    fallback: "browser-speech-synthesis",
    text: trimmed,
    voice,
    rate,
  };
}
