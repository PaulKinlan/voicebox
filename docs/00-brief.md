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
