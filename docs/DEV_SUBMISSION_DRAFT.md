---
title: EchoNote — say it once, find it organized (a local voice-to-action assistant for friends who have no time to fetch a notebook for notes or too lazy to type, write and set reminders, etc)
published: false
tags: hf26challenge, devchallenge, weekendchallenge, opensource
---

*This is a submission for the [Hacktoberfest Weekend Challenge: Build for a Friend](https://dev.to/challenges/hacktoberfest-weekend-2026-10-01).*

## What I Built

Creative people always have ideas, to-dos and "oh I must remember this" moments while studying, commuting,
working or maybe simply sitting idle. Many times, ideas come and go in a second, and many a time you do not
get enough time to search for a note or even open an app to type it down. It has occurred to me that if I get
an idea and I suddenly change my focus to look for Keep or some notes app to quickly write it down, it goes
away, and god knows when I'll remember it again, if I ever do!

That's why this app. You press the keyboard shortcut, speak whatever you want to, and my system understands
and saves it. Simple! Be it ideas, reminders, note taking, etc.

I built it for me and my friends — anyone creative whose thoughts flow so fast that an idea is lost if it
isn't captured right away.

**EchoNote** is a small desktop utility: press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> from any app,
say the thought, press it again, keep working. A few seconds later it shows up as a **task**, a **reminder**
(with a desktop notification at the right time), an **idea**, or a **reference note** — searchable, editable,
and never lost. It's not a chatbot: there's no prompt to write and no category to choose. And none of it
leaves the laptop — speech recognition and the language model both run locally.

**Honest note on the "friend" part:** I haven't shown EchoNote to any friend yet. This weekend went into
making the capture pipeline reliable and testing it, so for now I'm the first user. Next, I'm giving the
AppImage to my friends and fixing whatever gets in their way.

Where I'm taking it: I have planned to add tasks like performing a web search as you speak, performing tasks
on your computer with your permission, and scanning folders to remove garbage/unnecessary files (with
permission, of course), de-cluttering them and possibly moving them to their assigned folders, if feasible.
More extensions will come as more ideas come to my mind — which I will now note down using this app only ;)

## Demo

*A demo video of the app working on my local machine is coming soon. Until then, here are screenshots of the
real app.*

**Capture** — press the shortcut (or the button), speak, done. Recent notes are already filed:

![EchoNote capture screen](https://raw.githubusercontent.com/KrAG2000/echonote/main/docs/screenshots/capture.png)

**Reminders** — "Remind me tomorrow … to call the dentist" became a reminder for tomorrow. EchoNote shows the
words it understood as the date, and says when it had to fill in a default time:

![Reminders view](https://raw.githubusercontent.com/KrAG2000/echonote/main/docs/screenshots/reminders.png)

**First run** — the models are downloaded once and checked against their SHA-256 checksums. The screen says up
front that this download is the only time EchoNote uses the network:

![First-run setup](https://raw.githubusercontent.com/KrAG2000/echonote/main/docs/screenshots/setup-first-run.png)

## Code

- **Repository (MIT):** https://github.com/KrAG2000/echonote
- **Download (Linux AppImage):** https://github.com/KrAG2000/echonote/releases/tag/v1.0.0

```bash
chmod +x EchoNote-1.0.0-x86_64.AppImage
./EchoNote-1.0.0-x86_64.AppImage
```

Tested on Fedora 44 / GNOME 50 (Wayland). Needs an x86-64 CPU with AVX2 and about 2.5 GB of free RAM.

## How I Built It

* **Electron + React + TypeScript**, SQLite via Node's built-in `node:sqlite` (no native modules).
* **whisper.cpp** (`whisper-server`, base.en 5-bit) for speech-to-text, kept warm in a child process.
* **llama.cpp** (`llama-server`) running **Qwen2.5-1.5B-Instruct (Q4_K_M, Apache-2.0)**, also kept warm. The
  output is constrained by a JSON-schema grammar, then validated again with zod — model output is treated
  as untrusted input.
* Both runtimes are compiled from pinned releases and shipped inside the AppImage — no Python, Ollama or
  compiler needed. The first-run screen downloads the two model files once (1.1 GB) and checks their
  SHA-256; after that EchoNote never touches the network.

Three decisions I'm happy with:

1. **Capture first, interpret second.** The transcript is written to SQLite before the LLM ever sees it.
   If the model is still loading, missing, slow, or returns garbage, the note waits in the Inbox — it's
   never lost. An end-to-end test runs the app without the language model installed, then adds it back and
   checks the note gets organized exactly once.
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

Testing found real bugs, which I fixed:

- If the app was killed hard, its AI servers kept running and held ~2 GB of RAM. Now they die with it.
- The first note after startup took 18 s because it raced the model's warm-up.
- The GNOME shortcut setup wrote an invalid `gsettings` value.

### Honest numbers

On my laptop (i7-13620H, CPU only, power-saver profile): transcript visible ≈2.3 s after I stop talking;
organized ≈7–8 s after. The LLM is the slow part: ~5.4 s per note with the 1.5B model (8/8 test sentences
correct), ~2.8 s with the 0.5B one (6/8). My goal was organizing in under 2 seconds and I didn't reach it on
this hardware — but because the transcript is saved first, nothing you said waits on the model.

## Why Open Matters Here

* **It's my private brain-dump.** Half-formed ideas, reminders, things I haven't told anyone yet. With
  open-weight models running locally, none of it goes to a server I don't control. A test runs the whole
  app with no network interface to prove it.
* **It works without internet** — on a train, in a café with bad Wi-Fi, anywhere an idea shows up.
* **It costs nothing to run.** No API key, no per-request bill, no account. I can give the AppImage to a
  friend and that's the whole setup.
* **I could pick and swap the parts by measuring them.** I benchmarked three Whisper sizes (tiny 0.9 s,
  base 1.8 s, small 6.5 s per clip) and two Qwen sizes on the actual laptop and chose by speed and
  accuracy. Users with less RAM can switch to the 0.5B model in Settings, and a multilingual Whisper model
  for Hindi/Hinglish is one dropdown away (not yet tested with real speech).
* **Precise about licenses:** whisper.cpp and llama.cpp are MIT; the Whisper weights are MIT;
  Qwen2.5-1.5B-Instruct is Apache-2.0. These are open-*weight* models — their training data isn't public.

Where open was harder: CPU-only inference on a power-saving laptop is slower than a hosted API, Wayland had
no ready-made global shortcut, and I had to package the native inference binaries myself.

## What's Next

* Give it to my friends and fix what annoys them.
* Record the demo video.
* GPU offload (the laptop has an RTX 4060 that EchoNote doesn't use yet) to get organizing under 2 seconds.
* Test Hindi/Hinglish with real voices.
* Split one recording with several tasks into several items.
* The bigger ideas above: voice-triggered web search, permissioned actions, and folder clean-up.

*Disclosure: EchoNote and this post were built with help from an AI coding agent (Claude Code).*
