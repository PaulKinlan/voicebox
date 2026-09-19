# The brief

Spoken by Paul, 2026-09-19, and written down here as the source of truth. Quoted where his
words carry a requirement; interpreted where transcription garbled them.

## What it is

> "Essentially kind of open claw but the voice... a primarily web-based experience that is
> a front end to a kind of build system or an environment that can create anything that I
> need to."

> "I want to use the voice agent UI and system... that's kind of the part of the interface
> that I want to see."

## What it is not

> "I also want it to be kind of extensible like agent-d project but that's also too
> heavyweight."

Light rather than framework-heavy. The reference point for minimalism is the **pi harness**:

> "I'm really inspired by the pi harness where it's only got pi harness."

## What is borrowed, and the one thing borrowed from each

| Source | What to take |
|---|---|
| **pi harness** | Minimalism: one harness, not an adapter zoo. |
| **Isocan's voice agent** | The voice UI and system — the interface itself. |
| **Chrome Agent Platform** | Tools, skills and WebAssembly modules; a powerful platform where new tool sets can be dropped in, and extensions can add tools into the agent loop. |
| **Open agent CLIs ("open claw, but the voice")** | The open agent-harness model, driven by voice. |

## Models

- **Gemini** — the latest **Gemini 3.8 Live** and **live thinking** models, first.
- **OpenAI** — the live/realtime model as an alternative harness: the platform stays
  model-extensible rather than betting on one provider.
- **Fable through the pi harness** — the capability Paul explicitly wants to work towards:

  > "This is the bit I want to try and work towards — a fable model using the pi harness
  > that you've got access to."

## The environment

> "Your box obviously got access to my machine."

The agent acts on a real machine — the pattern already proven by the ACP bridge — not on a
simulation of one. And:

> "We think about local project files now... this actually might be like the answer to this."

A project on disk is the unit of work.

## The relationship he wants with it

> "I want the user interface to kind of like — as in me and you keep talking — because I
> also do want to work on some isocan projects at the same time."

Not a session you open and close. **An agent that stays in the conversation while he does
something else**, which is the requirement most likely to shape the UI.

## How this gets built

> "Astra to kind of help me build out and plan the interface and the experience. And then
> obviously I want you to use the deepseek models and k3... we need to kind of fan out and
> like design this and model UI."

Fan out: interface and experience first (astra), architecture and harness design alongside
(k3 and the deepseek lanes), with the UI modelled rather than described.

---

## Added after the first pass (2026-09-19, 12:20) — from Paul's reply

His spoken answer confirmed the name and added four requirements. Kept separate from the
original brief so the first pass stays readable as what it was.

### The name

> "Yeah, voicebox. The name is fine. It's actually pretty cool."

**Confirmed.** No longer a working name.

### Does it use Chrome Agent Platform?

> "Does it use CAP? Runtime no — but you do the analysis of CAP to see if it kind of helps me
> meet my needs... the thing with CAP is it's got a lot of like agent-d project, that might be
> too heavyweight, it's not an extensible platform like pi is. So maybe think about that a
> little bit more."

**Runtime: no.** An explicit analysis is owed, and his two axes of scepticism are **weight**
and **extensibility** — so the question is which parts meet the needs below and which are
weight we would inherit, not whether CAP is good.

### The harness runs on the client *and* on the server

> "The harness should be on the client and also running on the server. Isocan as a project does
> that really well — but with isocan, I'm not sure."

**One harness shape, two placements**: in a browser and on a machine. Isocan is the precedent
and he is uncertain whether it generalises. This is a requirement arriving after PR #1, which
assumed a local host.

### The browser needs OPFS; the server holds the real filesystem

> "I'm going to probably access this through a website. I do want to be able to use OPFS, right?
> But then also, we're on the server as well. We need to think about how do I access all the
> files from the server — securely, talking to it."

So: **OPFS on the client**, **the real filesystem on the server**, and **secure reachability
from elsewhere** — his example being to talk to it over Telegram while it has access to the
machine, which is the shape this session already runs in.

### The canvas, and his doubt about it

> "I kind of need the canvas part of this thing. It's very much focused on the UI versus the
> build — but maybe that's where I'm kind of making some mistakes."

A voice agent that can build needs somewhere the building is **visible**. He names isocan's
canvas, notes it is oriented to UI work rather than building, and questions whether it is the
right answer. **The doubt is carried deliberately** — engaging with it is worth more than
drawing a better canvas.
