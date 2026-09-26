# Receipt: claude-code adapter live smoke (voicebox-beads-a74y, 2026-09-26)

**Scope:** one real delegation through the claude-code task executor — the real
registry adapter (npx launch of **@agentclientprotocol/claude-agent-acp** 0.78.0),
the real Claude CLI on this host, one trivial prompt, timeout-bounded. This is a
recorded smoke, not a gate; the unit contract is in tests/claude-acp.test.mjs.

## The three arms (same box, same adapter, same CLI, one variable moved)

| arm | ANTHROPIC_API_KEY in the child env | result |
| --- | --- | --- |
| A | inherited from the server env | prompt never settled; cancelled at the 55s deadline |
| B | removed by hand | answer "OK" in 7,964 ms |
| C | present in the shell, scoped out by the executor (shipped behavior) | answer "OK" in 10,067 ms |

Arm A reproduces the voicebox-beads-5f5u stall shape and attributes it: an inherited
ANTHROPIC_API_KEY takes precedence over the claude.ai login inside the adapter and the
prompt stalls. The executor therefore scopes the variable out of the adapter child by
default (the host env is never mutated; VOICEBOX_CLAUDE_KEEP_API_KEY=1 opts back in).

## Independent re-run

voicebox-glmflash1 re-ran the live smoke on this box during review: completed with the
answer "acknowledged" in 4.3s.

## Driver

The smoke driver is cap-evidence/astra/voicebox-a74y-smoke.mjs (outside the tree): it
builds the executor with a 55s deadline, checks admission, and runs one prompt in a
scratch root. check() reported mechanism: "stdio-acp-client: npx
@agentclientprotocol/claude-agent-acp@0.78.0; drives the Claude CLI found on PATH".
