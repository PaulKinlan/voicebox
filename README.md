# Voicebox

**A voice-first web front end to a build environment.** You talk to it; it makes things.

> Working name. Rename is cheap — see [docs/00-brief.md](docs/00-brief.md).

## The idea

An agent you speak to, in a browser, that can create anything you ask for — because it
has a real build environment behind it and a tool surface you can extend. Not a chat box
with a voice bolted on: the voice *is* the interface, and the thing on the other end can
act on your machine.

## Principles

1. **Voice-first.** The interface is conversation, and it stays available — you can keep
   talking to it while working on something else.
2. **A web front end to a real environment.** Not a sandbox demo: it drives a build
   system that can produce software.
3. **Extensible models.** Gemini Live first, OpenAI Realtime alongside — swap the live
   model without rewriting the harness.
4. **Extensible platform.** Give it new tools and skills when you need them; extensions
   can add tools into the agent loop.
5. **Light, not a framework.** Inspired by minimal single-harness designs rather than by
   heavyweight agent frameworks.
6. **Local project files.** A project on disk is the unit of work.

## Lineage

Built from parts of projects that already work — see [docs/00-brief.md](docs/00-brief.md)
for what is borrowed from where, and [docs/01-questions.md](docs/01-questions.md) for what
is still undecided.

## Status

Seeded 2026-09-19 from a spoken brief. Design in progress.
