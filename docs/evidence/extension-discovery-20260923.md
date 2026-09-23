# Extension discovery/use: driven evidence

Baseline: `710a0da9cd722dab8db799b525edc94bf36406b4` (the assigned served checkout had
advanced from `0635dd5`). Isolated worktree and ephemeral Node server, scratch extension
registry/workspace, Chromium via `tests/lib/cdp.mjs`. No restart or writes to the owner's
running server. Four real Gemini Live sessions total; no real OpenAI session.

## Before

Staged catalogue `web-search` over HTTP, then drove the Extensions dialog's review,
request-code and approval controls. Read the one-use code only from this test server's
console and entered it in the page. UI: “Web Search Running”. API inventory:
`web-search`, tools `["web_search"]`, proposal state `admitted`.

Sent text turns over a real browser `/live` socket (not microphone audio):

- “List the extensions I have installed and approved, and their tool names.”
  Model: **“I cannot do that yet.”** No tool calls.
- “Use the Web Search extension to search for the planet Saturn.”
  Model: **“I cannot do that yet.”** No tool calls.

## After

Same staging/approval and prompts on the changed tree:

- Model: **“You have the Web Search extension installed with the web search tool.”**
  Server: `list_extensions:ok — toolResponse sent`.
- Model: **“The search results indicate that Saturn is the sixth planet from the Sun
  and the second largest in our solar system.”**
  Server: `call_extension:ok — toolResponse sent`.

Two intervening diagnostic sessions initially captured empty transcripts: the drive
stopped collecting at Gemini's first `turn-complete`, which can precede speech after a
tool result. Corrected the drive to wait for output text AND subsequent completion;
the successful quotes above are from the fourth session, not inferred from those two.
The provider is nondeterministic; these are observed replies, not exact-string tests.
Raw local logs: `/tmp/vb-extension-baseline.log`, `/tmp/vb-extension-fixed-wait.log`.

## Deterministic regression coverage

`tests/extensions-live.test.mjs` drives the actual server and both provider encoders over
native WebSockets, redirecting only vendor destinations to a local synthetic endpoint.
It starts the live session BEFORE staging/approval, verifies declarations, pending
refusal, console-code admission, refreshed discovery, network request with the exact
query, correlated tool result and audit, app/model inventory agreement, host/budget
refusals, malformed/unknown calls, and absence of descriptor defaults/host tokens in
discovery. No paid model or external search claim is made for this fixture.

## Cause and scope

The shared model-facing command list had only `write_file`, `read_file`, `list_files`;
its instruction said there were no other capabilities. The `/live` route mapped calls
only through this list. The extension runtime already worked but was reachable only
through other callers (including the script resolver's explicit tool syntax).

Successful console-code approval calls `admitProposal`, records admission and reloads
the registry. There is no separate extension process with an independent enabled state:
the extension is a descriptor backed by host primitives. “Running” correctly reflected
admission but did not prove model reachability.

Deployment requires restarting the Node server and opening a new live session to get
the new command declarations. Future approvals within that session need no reconnect.
