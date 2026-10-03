---
title: EchoNote — say it once, find it organized (a local voice-to-action assistant for [FRIEND'S NAME])
published: false
tags: hf26challenge, devchallenge, weekendchallenge, opensource
---

<!--
DRAFT. Before publishing:
  1. Copy the official submission template from the challenge announcement post and move these
     sections into it (the template wasn't available through the API).
  2. Fill every [PLACEHOLDER] with what really happened. Do not publish a friend story or user
     reaction that did not happen — say "I haven't handed it over yet" if that's the truth.
  3. Add the demo video and the repository link.
  4. Deadline: October 5, 2026, 06:59 UTC (12:29 PM IST).
  5. DEV requires disclosure of AI assistance: this project and draft were built with an AI coding agent.
-->

## What I Built

[FRIEND'S NAME / relationship, e.g. "my sister", shared with their permission] always has ideas, to-dos and
"oh I must remember this" moments while [CONTEXT — studying / working / commuting]. [ONE OR TWO REAL
SENTENCES ABOUT THE PROBLEM IN THEIR WORDS.] Opening a notes app, typing it out and filing it takes just
long enough that the thought is gone.

**EchoNote** is a small desktop utility for them: press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd>
from any app, say the thought, press it again, keep working. A few seconds later it shows up as a
**task**, a **reminder** (with a desktop notification at the right time), an **idea**, or a
**reference note** — searchable, editable, and never lost.

It's not a chatbot. There's no prompt to write and no category to choose. And none of it leaves the laptop.

![Capture screen](docs/screenshots/capture.png)

## Demo

[DEMO VIDEO LINK — suggested 60–90 s: press shortcut in another app → speak "Remind me tomorrow at 9 to
call the dentist" → overlay shows Recording / Organizing → reminder appears with "Tomorrow, 9:00" → show
Inbox "needs confirmation" for "remind me next Friday" → show the app working with Wi-Fi off.]

## Code

[GITHUB REPOSITORY LINK] — MIT licensed. Linux AppImage in the releases.

## How I Built It

```text
shortcut ─► recorder (16 kHz WAV) ─► SQLite ─► whisper.cpp ─► transcript saved (≈2 s)
                                                                 │
     reminder scheduler ◄─ validated record ◄─ zod + date resolver ◄─ llama.cpp + Qwen2.5-1.5B (JSON grammar)
```

* **Electron + React + TypeScript**, SQLite via Node's built-in `node:sqlite` (no native modules).
* **whisper.cpp** (`whisper-server`, base.en 5-bit) for speech-to-text, kept warm in a child process.
* **llama.cpp** (`llama-server`) running **Qwen2.5-1.5B-Instruct (Q4_K_M, Apache-2.0)**, also kept warm. The
  output is constrained by a JSON-schema grammar, then validated again with zod — model output is treated
  as untrusted input.
* Both runtimes are compiled into the AppImage. The first-run screen downloads the two model files once
  (1.1 GB) and checks their SHA-256; after that EchoNote never touches the network.

Three decisions I'm happy with:

1. **Capture first, interpret second.** The transcript is written to SQLite before the LLM ever sees it.
   If the model is still loading, missing, slow, or returns garbage, the note waits in the Inbox — it's
   never lost. An end-to-end test runs the app without the language model installed, then adds it back and checks the note gets organized exactly once.
2. **The LLM never does date math.** Small models are bad at "next Friday". The model only copies the
   date *phrase* it heard ("tomorrow at 7 pm"); a deterministic resolver turns it into a time in the local
   timezone. If the phrase isn't actually in the transcript, it's thrown away — so no invented deadlines.
   Ambiguous phrases ("next Friday" on a Tuesday, "the 15th", "sometime next week") go to the Inbox with a
   pre-filled date to confirm.
3. **Wayland reality.** On GNOME Wayland, apps can't grab global keys (I tested Electron's portal support;
   it returns false on GNOME 50). So EchoNote offers a one-click GNOME custom shortcut whose command
   writes one byte into a private named pipe the app listens on: 17–27 ms from key press to the app,
   instead of 2.7 s for relaunching the AppImage.

### Testing it like a user

The end-to-end tests drive the real built app with real models: WAV files are fed into Chromium's fake
microphone, and recording is toggled exactly the way the keyboard shortcut does it. They cover a reminder
that must fire exactly once (and not again after a restart), the LLM being unavailable, a failed model
download and retry, a denied microphone — and a full run **inside a Linux network namespace with no network
interface at all**, to prove the "offline" claim instead of just stating it.

### Honest numbers

On my laptop (i7-13620H, CPU only, power-saver profile): transcript visible ≈2.3 s after I stop talking;
organized ≈7–8 s after. The LLM is the slow part (~5 s per note with the 1.5B model, ~2.8 s with the 0.5B
one, which got 6/8 test sentences right vs 8/8). It's not instant, but because the transcript is saved
first, nothing waits on it.

## Why Open Matters Here

[IN YOUR OWN WORDS — some points that are true for this project:]

* **It's their private brain-dump.** Half-formed ideas, reminders about doctors, passwords-on-the-fridge
  notes. With open-weight models running locally, none of it goes to a server they don't control. That's
  verified by a test that runs the app with no network interface.
* **It works without internet** — on a train, in a hostel with bad Wi-Fi, anywhere.
* **It costs nothing to run.** No API key, no per-request bill, no account for [FRIEND] to manage.
* **I could pick and swap the parts.** I benchmarked three Whisper sizes and two Qwen sizes on the actual
  hardware and chose by measured speed and accuracy. Users with less RAM can switch to the 0.5B model, and
  a multilingual Whisper for Hinglish is one dropdown away.
* **Precise about licenses:** whisper.cpp and llama.cpp are MIT; the Whisper weights are MIT; Qwen2.5-1.5B
  is Apache-2.0. These are open-*weight* models — their training data isn't public.

Where open was harder: [e.g. CPU-only latency, Wayland shortcut work, packaging native binaries.]

## What [FRIEND] Said

[ONLY IF IT HAPPENED: what they tried, what they said, what you changed because of it. If you haven't
handed it over yet, say so and say when you will.]

## What's Next

* GPU offload (the laptop has an RTX 4060 that EchoNote doesn't use yet).
* Testing Hindi/Hinglish with real speech.
* Splitting one recording with several tasks into several items.

<!-- Optional: embed or link the DevRelay agent session (see the challenge page). -->
