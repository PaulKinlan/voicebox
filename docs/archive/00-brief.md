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

---

## Added 2026-09-19, 12:40 — dynamic tools, environments, and what it should look like

A second addition, kept separate for the same reason as the first. His framing: *"this is one of
the bits we're going to have to design and maybe do multiple iterations on — I really just want
them all right."* So this is a brief for **iteration**, not a specification to close.

### N10 — The agent builds its own tools, and they work locally

> "We have to think about how we can do **dynamic tool creation**, because you start off without
> anything... like, I want to look at how my journal works — the agent prompt could create, from
> previous history, a new **now** with you. **What tools there should be? We will create the tools
> and we will create the objects, the nouns — and the verbs are based off us somehow.** I don't
> know how to do this. I want to build those extensions and have them work locally somehow. And
> we end up building all these new tools up that we can start to use, then it can be extended
> out. Something like OpenClaw [transcribed: "open claw"] but we can build it on the fly, dynamic.
> **I think there's something really powerful there.**"

The strongest statement of intent in the brief. **Nouns and verbs derived from the conversation
itself**, tools created because a need appeared in the talking, accumulated, and working
**locally** first. The journal is his own precedent for an agent extending its own surface from
history rather than from a fixed tool list.

### N11 — Environments, and the browser is the first one

> "There are real constraints and design challenges about how we think about **tools on the
> server, tools that run locally** — and maybe that's what we think about, that we have
> **environment configuration** and **by default the first environment is the browser**... think
> about the things and assets and tools we might want to create and just enable them to happen.
> **You obviously build extensions like we can with pi and then just have the model register
> them. That would actually be pretty cool.** Your **local safe environment**, and then maybe a
> **hosted cloud server environment** as well."

So the axis is **environments**, not placements-as-implementations: **the browser first**, then a
**local safe environment**, then a **hosted cloud server environment**. And the mechanism is
named: **extensions written the way pi extensions are written, and then registered by the model**
— extensible platform and dynamic tools arriving as the same idea.

Note this **changes a milestone order**: the browser was M2, after the machine placement. As
*"the first environment"* it is no longer a later mode.

### N12 — It should look like isocan's voice agent, and assets should appear

> "The screenshot you just sent looks terrible. **I want it to look like the voice agent in
> isocan.** I don't want to be too explicit — you'll see some **assets getting created in front
> of you**, like these types of things. I really want to explore that kind of model."

The screenshot was the skeleton's bare unstyled page, sent as XSS evidence. It is now an
**anti-reference**: the interface should not look like a debug view. And the positive model is
specific — **assets appearing as they are created**, which is the artefact surface, *"not too
explicit"*.

### N13 — "Create a project" is a spoken verb

> "I might say something like **'you create a project'** and then that creates a project **that is
> sandboxed** — a project that is distinct from other projects. But **it knows about them** and
> has a full understanding of things that are local."

A sandbox per project, distinct, with the agent aware of the others and of what is local.

### Open problem he named twice

> "**I don't know how to deal with the server side of things.** ... We also have access to an
> environment that is on the server — I don't know how to deal with that at the moment."

Stated as unresolved rather than delegated. It should stay unresolved in the document rather than
be quietly closed by a design that assumes an answer.

---

## Added 2026-09-19, 20:55 — the success criterion, and where this goes next

### N14 — Voicebox builds voicebox

> "It's actually one success criteria that we'll have with this is if I can use the voice agent itself
> — voicebox essentially — **to build itself**, and kind of to make edits and stuff."

**This is a criterion rather than a feature**, and it should be treated as one: a build that cannot be
driven to change its own source has not reached the thing he is asking for, however well it handles a
demo project. It also settles a design question by putting a floor under it — the environment's work
has to be *good enough to be used on real code*, not merely safe on synthetic assets.

### The client cannot do this, and the remote placement can

He asked the question himself: *"I know that we're not going to be able to do that from the user
interface side, potentially in the client — and maybe we can?"*

**In the browser placement: no.** There is no shell, no git, and no path outside the origin's private
filesystem, so a browser-only session cannot edit voicebox's own repository. That is not a limitation
to work around; it is what makes the browser the *safest* first environment.

**In the remote placement: yes — and it is the shape he already works in.** The harness runs on the
machine that holds the checkout, and the browser is a client onto it. Which means **bootstrapping from
a walk is the remote placement doing exactly what it was designed for**, and the milestone order
matters less than it looked: E1 is first because it is safest, not because it is the only way to be
useful.

### And what it extends into

> "I could imagine there's a world where if we get this right then we **extend this into the Chrome
> Agent Platform project** — and then that has access to all the tools that control the browser. If
> we're building more and more tools as we go, there's a lot of opportunities for us."

**This reframes CAP's role without changing today's decision.** The analysis concluded: take three
descriptor fields, a fails-closed convention and a budget-gate habit; leave the admission pipeline.
That remains right **for a dependency**. What is new is that CAP is a **destination** — the platform
whose tools control a browser — and voicebox is the voice front end that could drive it. So the
relationship is *convergence later*, not *dependency now*, and the greppable test that keeps
voicebox's documents free of isocan's packages applies to CAP's packages in exactly the same way.

### And the way he wants to work on it

> "I actually do like this back and forth between us where it's like, you know, if you get something
> wrong that's fine because we can iterate quickly. We are basically venturing forth on a project that
> no one else has really done before. So we're going to make mistakes and we're going to have to learn
> about the UI and the UX and the server interaction and the browser interaction."

Worth recording because it sets the standard for what a good session looks like: **wrong artefacts,
corrected quickly, beat right artefacts, delivered slowly.** Today produced three wrong artefacts and
nine rules.

---

## Added 2026-09-19, 23:20 — the harness gets capabilities, and becomes a library

Four requirements noted as **project-level work to do at some point**, in his words, plus one that is
already a constraint in the environment design.

### N15 — The harness can delegate to other harnesses

> "This is going to be a harness, right, that can maybe **delegate out to other harnesses** as well? I
> don't quite know at the moment."

Related to the multi-harness observation he made earlier about isocan. Unresolved by design.

### N16 — Capabilities arrive as extensions, and they are the stress test

> "We are going to want to be able to **load skills** in — I do that in the Chrome Agent Platform
> project... **pi doesn't have a concept of skills. I think you have to install an extension, and so I'm
> okay to follow that same model** — where out by default, the agent loop that we have on the client
> and the server needs **custom-built extensions** to do these things."

And the part that makes it a programme rather than a backlog:

> "We might need **MCP servers** at some point, we might need **web search**... a whole bunch of other
> advanced features and capabilities — but **maybe they're a stress test for how the extensions can
> work** and how we can build them."

**A decision is embedded here**: skills are **not** a first-class concept. Capabilities are
**extensions**, out by default, and the named future ones exist to prove the extension system.

### N17 — A surface for extensions

> "We probably also need some **user interface** to kind of tell the user **what extensions exist, what
> extensions are installed, how to maybe sideload extensions** that someone else has made."

Three verbs: **discover**, **inventory**, **sideload** — and sideloading is the one with a security
story attached, so it is not merely a list view.

### N18 — The agent loop and harness are a library

> "Make sure that the **agent loop and the harness that we have is abstracted into a library in the
> project that can be imported and reused** across client, server, and a bunch of other places as well.
> I think we're going to want **consistency at that level**. **It's going to be an important part of the
> project.**"

**This is already the environment design's constraint, arriving from the other direction.** §1.7
requires the core — project records, tier table, capabilities, audit, path resolution — to be **"pure
data and small functions with a narrow dependency surface, because the same code has to run in a machine
process *and* a page worker"**, with isocan's extracted provider layer cited as the precedent for
*shape* rather than as code to lift. He is now stating it as a **product** requirement rather than a
portability technique, and calling it important — which is the correct weighting, because a core that
runs in one placement becomes two implementations that drift.

---

## Added 2026-09-20, 01:30 — N19: shared state, and why it is not an alternative to merging

> "I feel like I want the **shared model**... I think we do want some understanding and concept of like
> **global state**, maybe, and all at the same time, because **multiple agents and multiple harnesses
> can be working together**."

**Decision: shared.** And the question he asked underneath it is the important part:

> "I just don't know how **sharing works without having a merge concept**. Actually this is one of the
> issues I struggle with in isocan."

### They are not alternatives — they apply to different things

The confusion is real and it dissolves once the two are separated by **what they reconcile**:

| | **what is shared** | **what is merged** |
|---|---|---|
| **the data** | state: presence, what each agent is doing, what it has **read** | artefacts: files, code |
| **the shape** | an **append-only log** — no reconciliation needed, because nothing is overwritten | a **diff** — reconciliation required, because one file has one writer |
| **the channel** | live: you see it as it happens | late: you see it when the work lands |

So it is not *shared instead of merged*. It is **`shared log + per-root work that still merges`** — the
merge never goes away, it stops being the *only* way two sessions learn about each other.

### What that means for the walk

- **Both sessions append to the shared log** — *"I'm editing the parser"*, *"I'm reading the tier
  table"*, *"holding the microphone"*. **Append-only, so no merge is needed**, and no write conflicts
  are possible by construction.
- **Both act on their own execution root** — one writer per root, as the design already requires.
- **Their files meet as an ordinary merge when they land** — and that merge is a *user-visible event*,
  not a background reconciliation.

**You see each other live; you merge the artefacts.** The liveness comes from the log; the safety comes
from the root boundary; and neither needs the other's mechanism.

### Why this is worth stating plainly in the design

Because the same confusion is what makes isocan's model hard to hold in the head, and it is a
**category error rather than a hard problem**: *"how do we merge the log?"* has no answer because the
log never needs merging, and *"how do we share the files?"* has no answer because files are what
merging is for.

The global state is **the log**; the global state is **not** the files.

---

## Added 2026-09-20, 06:00 — N20: persistent directory handles, not only OPFS

> "Remember it's not just OPFS, but also **directory handles that are persistent**."

**Two storage shapes, and they are not the same mechanism:**

| | **OPFS** | **a picked directory handle** |
|---|---|---|
| where the files are | inside the browser, per-origin, invisible to the OS | **a real folder on the user's machine** |
| how access is granted | implicitly, to the origin | **the user picks it once** — `showDirectoryPicker()` |
| does it survive a reload | yes, with no gesture | **only if the handle is persisted and re-permissioned** |
| who else can see it | nothing outside the origin | **anything on the machine, and the user's own tools** |

**So the requirement is that a project can live in a real directory and the page can still reach it tomorrow.**
That is the *window* shape rather than the *peer* shape: the files are the user's, in a place they chose,
and the page holds a **persisted handle** rather than a copy.

### What "persistent" has to mean, concretely

- **The handle is persisted, not re-picked** — an `IndexedDB` record, not a variable. A reload must not ask
  the user to find their folder again.
- **Re-acquisition may need a gesture** — and this is measured rather than assumed: **OPFS needs none**,
  because it is origin-private, while a picked directory may require the user to click before access is
  restored. **The two shapes have different permission stories and the UI must not blur them.**
- **Permission is queryable, so the state is displayable** — `queryPermission` before use, `requestPermission`
  when it is needed, and an honest line on the page about which of the two states the project is in.
- **And there is a fallback that is not a failure**: a browser without the API, or a user who declines, gets
  **OPFS** — which is a real project in a real place, just not the user's own folder.

### Why this matters beyond storage

**It is the difference between a project the browser owns and a project the user owns.** With OPFS alone,
the artefacts live somewhere the user cannot open in their own editor — which is fine for a prototype and
wrong for a tool that is supposed to build real things. **A directory handle makes the machine's filesystem
the project's home, with the browser as a window onto it** — which is exactly the shape the environment
design calls *window*, and exactly what Paul asked for when he said *"local project files are the unit of
work."*
