// lib/fence-child-env.mjs — the minimal, measured child environment for fence exec (voicebox-beads-4uw0).
//
// WHY THIS FILE EXISTS:
// In voicebox-beads-pehr, the environment's mutating doors (/exec, /git/config, /git/init)
// were secured with timing-safe bearer authentication. However, commands spawned inside
// the fence still inherited process.env minus GIT_* plus pinned HOME/XDG, leaking ambient
// host secrets (e.g. ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, SSH keys, session tokens).
//
// THE MINIMAL MEASURED INVENTORY:
// Unix tools and git commands inside the sandbox need only:
//   - PATH: binary resolution (/usr/bin:/bin by default, or host PATH)
//   - HOME: the isolated sandbox home directory
//   - TMPDIR: temporary directory inside the sandbox (/tmp)
//   - USER / LOGNAME: execution identity inside sandbox ('voice' by default)
//   - SHELL: shell executable (/usr/bin/sh)
//   - LANG / LC_ALL: character encoding and locale (C.UTF-8)
//   - TERM: terminal formatting capability (dumb)
//   - XDG_CONFIG_HOME: isolated configuration path ($HOME/.config)
//   - GIT_CONFIG_GLOBAL: isolated global git config ($HOME/.gitconfig)
//   - TZ: optional timezone if set in hostEnv
//   - VOICEBOX_FENCE: marker that we are executing in a fenced sandbox ('1')
//
// Ambient secrets (API keys, tokens, session IDs) and host repository bindings (GIT_DIR, GIT_WORK_TREE)
// are strictly excluded by construction.

import path from "node:path";

export function buildFenceChildEnv({
  home = "/home/voice",
  hostEnv = process.env,
} = {}) {
  const env = {
    PATH: hostEnv.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: hostEnv.TMPDIR ?? "/tmp",
    USER: hostEnv.USER ?? "voice",
    LOGNAME: hostEnv.LOGNAME ?? hostEnv.USER ?? "voice",
    SHELL: hostEnv.SHELL ?? "/usr/bin/sh",
    LANG: hostEnv.LANG ?? "C.UTF-8",
    TERM: hostEnv.TERM ?? "dumb",
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    VOICEBOX_FENCE: "1",
  };
  if (hostEnv.LC_ALL) env.LC_ALL = hostEnv.LC_ALL;
  if (hostEnv.TZ) env.TZ = hostEnv.TZ;
  if (hostEnv.SANDBOX_PROBE_PATHS) env.SANDBOX_PROBE_PATHS = hostEnv.SANDBOX_PROBE_PATHS;
  if (hostEnv.INVOCATION_ID) env.INVOCATION_ID = hostEnv.INVOCATION_ID;
  return Object.freeze(env);
}
