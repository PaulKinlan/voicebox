# Voicebox

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Production stack is undecided. The interface exploration uses dependency-free HTML, CSS and JavaScript. Coordinator approved code-first, rendered interaction studies on 2026-09-19; this is not a framework decision.

## Users

Paul wants to keep talking with an agent while working elsewhere, including from a phone on a walk. Several live instances may work on the same machine-backed project in separate execution roots.

## Product Purpose

A voice-first frontend to an environment that makes things. Created assets and tools should appear in front of the user. The conversation continues without requiring the user to watch a transcript.

## Capabilities and Constraints

- Browser first, with OPFS; a local safe environment and hosted environments follow. Server access and trust remain open questions.
- Project identity includes its environment. A browser-only project is not a synced copy of a machine project with the same name.
- The interface must distinguish microphone state, connection state and work state. Silencing speech does not undo work; resuming after a disconnection is not blindly replaying commands.
- Projects declare their undo mechanism. No generic promise of undo or automatic recovery.
- Machine-backed projects can have several instances and execution roots. Their work meets through an explicit, refusable merge. A confirmation can be answered from another live instance of the same project.
- Model-created tools are assets. Being written or registered is distinct from being admitted to run. Missing capabilities are environment facts, not failed commands.
- Gemini Live first, other live models possible; pi-inspired minimalism. Do not reuse the CAP runtime wholesale.

## Brand Commitments

Voicebox is the confirmed name. Paul explicitly wants the visual language of isocan's voice agent: dominant microphone, quiet rings, short captions, Logs and Settings out of the main view. The unstyled skeleton/transcript screenshot is an anti-reference.

## Evidence on Hand

[Brief](docs/00-brief.md), including N10–N13, is the source of truth. `docs/01-questions.md` predates the name/CAP decisions. The interface study records exact isocan and environment-design revisions in [its design note](docs/interface.md). Prototype content, instances, permissions and execution are synthetic and labelled; they are not evidence of a working harness, sandbox, OPFS implementation or live audio.

## Product Principles

- Show what was made where the conversation happens; keep the process record available separately.
- Let the user leave and return without losing the objects, the active work or the unanswered decisions.
- Make consequential choices concrete at the point of decision, without turning every turn into a control panel.
- Describe the environment's actual reach, privacy and recoverability before a user relies on them.
