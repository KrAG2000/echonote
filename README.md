# EchoNote

**Press a shortcut, say what's on your mind, keep working.** EchoNote turns the thought into a task,
reminder, idea or reference note — using speech recognition and a language model that run entirely
on your own computer.

* 🎙 **Capture in one keystroke** from any app. A red dot in the top bar shows while the microphone is live
  (like GNOME's screen recorder), and recording stops by itself after 5 seconds of silence.
* 📝 **Local speech-to-text** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
* 🧠 **Local organizing** with [llama.cpp](https://github.com/ggml-org/llama.cpp) and Google's open-weight **Gemma 4** (E2B):
  category, short title, summary, action, and the date phrase you said.
* ⏰ **Reminders** with desktop notifications, scheduled from SQLite and restored after restarts.
* 📥 **Nothing is ever lost**: the transcript is saved before the AI runs. If the model is loading,
  missing, slow or wrong, the note waits in the Inbox.
* 🔒 **Offline after setup.** No account, no API key, no telemetry, no cloud.

| Capture | Reminders | Settings |
| --- | --- | --- |
| ![Capture](docs/screenshots/capture.png) | ![Reminders](docs/screenshots/reminders.png) | ![Settings](docs/screenshots/settings.png) |

Built for the [DEV Hacktoberfest Weekend Challenge 2026](https://dev.to/challenges/hacktoberfest-weekend-2026-10-01) ("Build for a Friend").

---

## Install (Linux x86-64)

Download from the [latest release](https://github.com/KrAG2000/echonote/releases/latest).

**Fedora / RHEL (recommended): RPM package.** It installs like any other app, shows up in the app menu
and in GNOME Software under *Installed*, and can be uninstalled from there.

```bash
sudo dnf install ./echonote-1.0.3.x86_64.rpm
```

**Any other distribution: AppImage.** A single portable file; nothing is installed.

```bash
chmod +x EchoNote-1.0.3-x86_64.AppImage
./EchoNote-1.0.3-x86_64.AppImage
```
(Needs FUSE, which Fedora ships. Elsewhere install `fuse`/`libfuse2`, or run with `--appimage-extract-and-run`.)

Then:

1. The first-run screen downloads two model files (2.7 GB total) from Hugging Face and verifies their
   SHA-256 checksums. **This is the only time EchoNote uses the network.**
2. Click **Set up GNOME shortcut** (on GNOME/Wayland). The default shortcut is <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd>.

Nothing else is needed: no Node.js, Python, Ollama, compiler, database server or manual model files.
The inference runtimes (`whisper-server`, `llama-server`) are inside the package.

**Requirements:** x86-64 CPU with AVX2 (Intel Haswell / AMD Zen or newer), ~4.5 GB free RAM for the
default models (smaller models are available in Settings for low-memory machines), ~3 GB disk for models.
Tested on Fedora 44, GNOME 50 (Wayland). Other distributions/desktops are untested.

## Uninstall

1. *(Optional, removes your notes and the 2.7 GB of models.)* In EchoNote open **Settings → Delete all
   data**, tick **Also delete downloaded models**, type `DELETE`, and confirm. This also removes the GNOME
   shortcut and the launch-at-login entry.
2. Quit EchoNote: **Settings → Quit EchoNote completely** (closing the window keeps it running in the background).
3. Remove the app:
   * **RPM:** GNOME Software → *Installed* → EchoNote → **Uninstall**, or `sudo dnf remove echonote`.
   * **AppImage:** delete the `.AppImage` file (and any menu entry you created for it).

If you skipped step 1, your data stays in `~/.config/EchoNote` (delete that folder to remove it), and the
GNOME shortcut can be removed in GNOME Settings → Keyboard → Custom Shortcuts.

## Using it

* Press the shortcut (or the big button), speak, then press it again, or just stop talking: after 5 s of
  silence the recording stops automatically (Settings → While recording). If nothing was said, nothing is saved.
* While recording, a **red dot** appears in the top bar. After you stop, a **green check** shows for 3 s and
  then disappears. On GNOME this needs the AppIndicator extension
  (`sudo dnf install gnome-shell-extension-appindicator`, then log out and in). Without it, EchoNote shows a
  small floating popup instead, and GNOME's own microphone icon still appears in the top bar.
* Within a few seconds the note appears under **Tasks / Reminders / Ideas / Reference**.
* If EchoNote isn't sure — e.g. "remind me next Friday" said on a Tuesday, a reminder with no date, or
  an unclear category — the note goes to **Inbox → Needs confirmation** with the reason and a
  pre-filled date you can correct.
* Search finds text in transcripts, titles and summaries.
* Closing the window keeps EchoNote running in the background so reminders and the shortcut work.
  Quit from Settings → Quit EchoNote completely.

## How it works

```text
shortcut ─► recorder (renderer, 16 kHz WAV) ─► SQLite capture row ─► whisper-server ─► transcript saved
                                                                                         │
                         reminder scheduler ◄─ validated record ◄─ zod + date resolver ◄─ llama-server + Gemma 4 (grammar)
```

* The LLM never computes dates; it copies the date *phrase* ("tomorrow at 7 pm"). A deterministic
  resolver (chrono-node, local timezone) turns it into a time, and a phrase that does not occur in
  the transcript is discarded — so deadlines are never invented.
* Model output is treated as untrusted input: grammar-constrained decoding (compact JSON, no whitespace), then strict validation.
* "Thinking" is switched off for classification, so Gemma 4 answers directly.
* Both inference servers are started once and stay warm; the shared prompt is cached at startup.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/PRIVACY.md](docs/PRIVACY.md) ·
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## Models

| Purpose | Model | Size | License |
| --- | --- | --- | --- |
| Speech (default) | Whisper base.en, 5-bit (ggml) | 57 MB | MIT (OpenAI Whisper weights) |
| Speech (options) | Whisper tiny.en / small.en / small (multilingual, for Hindi/Hinglish – experimental, untested) | 31–181 MB | MIT |
| Organizing (default) | **Gemma 4 E2B Instruct**, Q4_0 GGUF (ggml-org) | 2.65 GB | Apache-2.0 |
| Organizing (faster) | Qwen2.5-1.5B-Instruct, Q4_K_M GGUF | 1.04 GB | Apache-2.0 |
| Organizing (low memory) | Gemma 3 1B Instruct QAT Q4_0 / Qwen2.5-0.5B-Instruct Q4_K_M | 687 / 469 MB | Gemma Terms of Use / Apache-2.0 |

All are open-weight models. Gemma 4 and Qwen2.5 weights are Apache-2.0, Gemma 3 uses Google's Gemma Terms of Use, and the Whisper weights are MIT. The training
data of these models is not open, so they are "open-weight", not fully open-source AI.

## Measured performance

Development machine: Intel i7-13620H (6P+4E cores, 16 threads), 16 GB RAM, Fedora 44, GNOME 50
Wayland, **CPU only**, system power profile *quiet* / `powersave` governor (as configured by the
owner — expect better numbers in Balanced/Performance mode). Numbers from the automated suites in this
repo (`docs/benchmarks/`, `captures.timings`).

| Operation | Measured |
| --- | --- |
| App window ready | 0.22 s (dev), 0.67 s (AppImage, incl. FUSE mount) |
| Shortcut → app receives toggle (GNOME shortcut via named pipe) | 17–27 ms (warm); 1.4 s if EchoNote has to be started |
| Toggle → microphone recording | 0.13–0.58 s (getUserMedia + AudioWorklet start) |
| Stop → audio persisted | ~0.15 s |
| whisper base.en load / transcription of a 3–11 s clip | 0.23–0.5 s / 1.8–2.3 s |
| llama-server load / prompt-cache warm-up (once per launch) | 2.0–2.9 s / 15–17 s |
| LLM classification, warm — **Gemma 4 E2B (default)** | median 8.6 s, 8/8 correct |
| LLM classification, warm — Qwen2.5 1.5B | median 5.5 s, 8/8 correct |
| LLM classification, warm — Gemma 3 1B / Qwen2.5 0.5B | 4.2 s / 2.8 s, 6/8 correct each |
| Gemma 4 load / prompt-cache warm-up (once per launch) | 4.5–13 s / ~35 s |
| Stop → organized note in the app | 11.3–13.0 s with Gemma 4, 7.4–8.3 s with Qwen 1.5B (transcript visible after ~2.3 s) |
| Memory (RSS) | llama-server with Gemma 4 E2B ~4.0 GB (Qwen 1.5B: 1.8–1.9 GB) · after startup / after 5 captures (Qwen run): llama-server 1.9 / 1.9 GB · whisper-server 105 / 164 MB · Electron (all processes, shared pages counted repeatedly) 0.74 / 0.96 GB |

Speech model comparison (same machine, synthetic espeak voice, which is harder than a human voice):

| Model | Load | Short clip | RSS | Notes |
| --- | --- | --- | --- | --- |
| tiny.en q5_1 | 0.15 s | 0.9 s | 111 MB | most errors |
| **base.en q5_1** | 0.22 s | 1.8 s | 160 MB | **default** – good balance |
| small.en q5_1 | 0.42 s | 6.5 s | 353 MB | most accurate, ~3.5× slower |

**Targets not met on this machine:** the spec's "warm LLM P95 < 2 s" — warm classification takes
~8.6 s with Gemma 4 E2B on this throttled CPU (generation runs at ~7 tokens/s; ~5.5 s with Qwen 1.5B).
The transcript is saved and visible ~2 s after you stop, so nothing waits on the LLM, but organizing is
not instant. Forcing compact JSON output cut Gemma's time from ~14 s to ~8.6 s. GPU offload is not implemented (the build machine has
no CUDA/Vulkan SDK).

## Testing

```bash
npm test                    # 96 unit tests: validation, dates, DB, pipeline, reminders, downloads, IPC, audio
npm run test:integration    # real whisper.cpp + llama.cpp on the real models (8 tests)
npm run test:e2e            # 7 end-to-end workflows driving the built Electron app
```

The end-to-end suite feeds WAV files into Chromium's fake microphone and drives the app exactly like
the GNOME shortcut does (`--toggle`). It covers: reference note persisted & searchable after restart;
a "remind me in two minutes" reminder delivered exactly once and not re-delivered after restart; a
future reminder restored after restart; the LLM missing → transcript kept in the inbox → organized
after the model returns, without duplicates; first-run setup with a failed then successful real model
download; an invalid shortcut, denied microphone and duplicate-toggle protection; and a full
capture → transcription → classification run **inside a Linux network namespace with no network
interface** (offline). The same suites were run against `dist/linux-unpacked` and the AppImage
(`ECHONOTE_E2E_EXE=…`).

Not automated: actually pressing a key on a physical keyboard, a real human voice, and the visual
appearance of the desktop notification — check these manually (see below).

## Build from source

Requires Node.js 24 (`.nvmrc`), git, g++, cmake (or `CMAKE="uvx --from cmake cmake"`). Building the RPM
also needs `rpmbuild` and `libxcrypt-compat` (electron-builder's bundled fpm links against `libcrypt.so.1`).

```bash
npm ci
npm run native:build        # builds whisper-server + llama-server into resources/bin/linux-x64
npm run models:prepare      # optional: pre-download default models to ~/.config/EchoNote/models
npm run dev                 # run in development
npm run package:linux       # -> dist/EchoNote-<version>-x86_64.AppImage and dist/echonote-<version>.x86_64.rpm
```

## Limitations

* Linux x86-64 only; tested on Fedora 44 / GNOME 50 Wayland. Windows/macOS are not supported yet (the
  main-process logic is portable; packaging, shortcuts and runtimes are not done).
* On GNOME Wayland, Electron cannot register global shortcuts (tested: returns false even with the
  GlobalShortcutsPortal feature), so EchoNote installs a GNOME custom keyboard shortcut on request.
  Other Wayland desktops need a manually bound shortcut running `EchoNote… --toggle`.
* Reminders fire only while EchoNote is running. Missed reminders are shown as overdue at next start.
  Launch-at-login is available for the AppImage build.
* English is the tested language. The multilingual Whisper model for Hindi/Hinglish is selectable but
  has not been tested with real speech.
* One primary intent per recording; a note containing several tasks becomes one item.
* The top-bar recording indicator needs the AppIndicator extension on GNOME (stock GNOME has no tray);
  without it a floating popup is used.
* Models are downloaded at first run (not bundled) to keep the packages small (AppImage 135 MB, RPM 96 MB).
* Gemma 4 E2B needs ~4 GB of RAM; on machines with less free memory EchoNote offers the smaller models.

## License

MIT for EchoNote's code. Bundled runtimes: whisper.cpp and llama.cpp (MIT). Models are downloaded
from their publishers under their own licenses (see the table above).
