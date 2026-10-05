# EchoNote architecture

EchoNote is an Electron app with three processes of its own plus two local inference servers.

```text
┌──────────────────────── Electron main process (Node 24) ────────────────────────┐
│  RecordingController ── single source of truth for the mic session              │
│  ShortcutManager     ── globalShortcut (X11) / GNOME custom shortcut (Wayland)  │
│  Pipeline            ── transcription queue ─► classification queue             │
│  ValidationService   ── zod schema + business rules on LLM output               │
│  DateResolver        ── chrono-node, local timezone, documented defaults        │
│  ReminderService     ── SQLite-backed scheduler + desktop notifications         │
│  ModelManager        ── manifest, resumable download, SHA-256, atomic install   │
│  RuntimeManager      ── starts/stops the inference servers, memory check        │
│  SQLite (node:sqlite) ── captures, reminders, settings, schema_migrations       │
└───────────────┬───────────────────────────────┬─────────────────────────────────┘
        typed IPC (zod-validated)        HTTP on 127.0.0.1:<random port>
                │                               │
┌───────────────┴──────────────┐   ┌────────────┴────────────┐  ┌──────────────────┐
│ Renderer: main window        │   │ whisper-server          │  │ llama-server     │
│  React UI + mic recorder     │   │ (whisper.cpp v1.9.4)    │  │ (llama.cpp b11379)│
│  (getUserMedia → AudioWorklet│   │ base.en q5_1, warm      │  │ Gemma 4 E2B Q4_0, │
│   → 16 kHz PCM WAV)          │   └─────────────────────────┘  │ warm, GBNF grammar│
│ Renderer: capture overlay    │                                └──────────────────┘
└──────────────────────────────┘
```

## Capture pipeline

| Stage | Input → output | State after | Timeout | Failure path |
| --- | --- | --- | --- | --- |
| Shortcut / button / tray / `--toggle` | key press → `RecordingController.toggle()` | `starting` | 10 s watchdog | back to `idle` with error |
| Recorder (renderer) | mic → Float32 frames → WAV | `recording` | 5 min max length | mic errors mapped to `MIC_PERMISSION_DENIED`, `NO_INPUT_DEVICE`, `DEVICE_BUSY` |
| Finalize | WAV bytes via IPC (≤12 MB) → header + silence check → atomic file write | capture `processing` | 15 s watchdog | `EMPTY_RECORDING` (nothing saved), `DISK_FULL` |
| Transcription | WAV → whisper-server → text | capture `inbox` (transcript persisted) | 120 s | `failed`, audio kept for retry; one automatic retry after a worker crash |
| Classification | transcript → llama-server (GBNF grammar) → JSON | `ready` / `needs_confirmation` | 90 s | stays in `inbox` with error code; LLM unavailable doesn't consume attempts |
| Validation | JSON → zod → date resolution → business rules | — | — | invalid output retried once at higher temperature, then left in inbox |
| Reminder | `ready` reminder with due time → `reminders` row | `pending` | — | notification failure recorded, reminder still visible in app |

Every stage writes its timestamp into `captures.timings` (shortcut received, recording started/stopped,
audio finalized, transcription started/finished, transcript persisted, classification queued, LLM
started/finished, validation finished, final item persisted). Settings → Diagnostics shows them.

### Idempotency

* Each capture id is queued at most once per stage.
* Classification results are applied with `UPDATE … WHERE status = 'inbox'`, so a duplicate or late
  job cannot overwrite an item the user already filed or create a second record.
* `reminders.capture_id` is `UNIQUE`; `syncForCapture()` upserts and only re-arms a reminder when its due
  time changes.
* Delivery is claimed with `UPDATE … SET status='delivered' WHERE id=? AND status='pending'` before the
  notification is shown, so a reminder is never delivered twice, even across restarts.

## LLM contract

The model never computes dates. It returns:

```json
{ "category": "reminder", "title": "Call the dentist", "summary": "…", "action": "…",
  "date_expression": "tomorrow at 7 pm", "needs_confirmation": false, "reason": null, "confidence": 0.95 }
```

A GBNF grammar (`LLM_GRAMMAR` in `src/shared/schemas.ts`) constrains decoding to this exact shape —
compact, fixed key order, no whitespace (pretty-printed JSON nearly doubled Gemma 4's token count) —
so output is structurally valid by construction. Thinking is disabled per request
(`chat_template_kwargs.enable_thinking = false`). It is still treated as untrusted:

1. `zod` validation (unknown categories, wrong types → rejected; long strings → clipped).
2. `date_expression` must literally occur in the transcript, otherwise it is discarded (for reminders
   the transcript itself is searched for a date phrase instead).
3. The phrase is resolved by `DateResolver` in the OS timezone and stored as a UTC ISO instant plus the
   capture's IANA timezone.
4. Ideas and reference notes never get a due date. Reminders without a date, ambiguous dates, model
   uncertainty or confidence < 0.5 → `needs_confirmation` (shown at the top of the Inbox).

The prompt is ~700 tokens (system prompt + 4 examples) and identical for every request, so
llama-server's prompt cache makes subsequent requests process only the new transcript (~10–20 tokens).
A warm-up request runs right after the model loads. Transcripts are truncated to 2,000 characters for
classification only; output is capped at 300 tokens; one inference slot (`-np 1`).

<a id="dates"></a>
## Date interpretation rules

| Phrase | Result | Confirmation? |
| --- | --- | --- |
| "tomorrow" | tomorrow at the default reminder hour (09:00, configurable) | no, but marked "default time" |
| "tomorrow morning / afternoon / evening / tonight" | 09:00 / 14:00 / 18:00 / 20:00 | no (marked default time) |
| "at 3 pm" | today if still ahead, otherwise tomorrow | no |
| "in 10 minutes", "in two hours" | relative to now | no |
| "next Friday" | the nearest upcoming Friday | **yes** if that Friday is still in the current Mon–Sun week (it could mean the following one) |
| "on the 15th" / "15th" | next 15th that hasn't passed | **yes** (month not stated) |
| "October 15 at noon" | exact | no |
| "next week", "sometime", "this weekend", "next month" | candidate date | **always** |
| unparseable ("whenever") | no date | yes for reminders; ignored for tasks |
| resolves to the past | candidate | yes |

Unconfirmed reminders are **not** scheduled until the user confirms (or edits) them.

## Runtime management

* `whisper-server` and `llama-server` are spawned once with `--host 127.0.0.1 --port <random>` and
  kept warm. A crashed server is restarted with back-off (max 3 restarts per 5 minutes, then the UI
  offers a manual restart).
* Before loading the LLM, `MemAvailable` is compared with the model's `minMemoryMB` from the manifest.
  If memory is short the app enters a degraded mode: captures are transcribed and saved to the inbox,
  the user can file them manually or press "Load anyway".
* Optional idle unload (Settings) stops llama-server after N minutes; it is restarted when needed.

## Storage layout

| Path | Contents | Writable |
| --- | --- | --- |
| `<AppImage>/resources/bin/linux-x64/` | `whisper-server`, `llama-server`, `libstdc++.so.6`, `libgcc_s.so.1` | no |
| `<AppImage>/resources/models.json` | model manifest (URL, size, SHA-256, license, min memory) | no |
| `~/.config/EchoNote/echonote.db` | SQLite (WAL) | yes |
| `~/.config/EchoNote/models/` | downloaded models + `.verified.json` markers | yes |
| `~/.config/EchoNote/audio-pending/` | WAVs waiting for (re)transcription | yes |
| `~/.config/EchoNote/logs/` | rotating log, 3 × 1 MB, no personal content | yes |

## Security

* Renderer: `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, navigation and
  `window.open` blocked, all `http(s)`/`ws(s)` requests from the renderer session cancelled.
* Permissions: only `media` with audio-only is granted; everything else is denied.
* IPC: one handler per channel, sender frame must be the app's own renderer, payloads validated by
  strict zod schemas (unknown keys rejected, sizes bounded). No handler accepts paths, shell commands
  or SQL. All SQL uses bound parameters; search escapes `LIKE` wildcards.
* Model output is never executed. The only process spawning is the two bundled servers (fixed args)
  and `gsettings` (fixed args via `execFile`, no shell) when the user sets up the GNOME shortcut.
* Model downloads: HTTPS from `huggingface.co` only (enforced by the manifest schema), size + SHA-256
  verified before an atomic rename into place.
* The inference servers listen on loopback only. Other processes of the same user could reach them;
  they hold no data beyond the request being processed.

## Packaging

`npm run dist:linux` (`scripts/package-linux.sh`) is the single entry point. It:

1. refuses native runtimes that need a glibc newer than 2.35 (override: `--allow-host-glibc`);
2. runs lint and unit tests;
3. builds the app and runs electron-builder for **AppImage**, **rpm** and **deb**;
4. inspects each package for the runtimes, model manifest, tray icons, desktop entry and AppStream
   metadata;
5. writes `dist/SHA256SUMS`;
6. optionally installs the `.deb` in clean Ubuntu 24.04 and 22.04 containers and runs the bundled
   whisper-server/llama-server against the real models (`--verify-deb`);
7. optionally publishes the GitHub release (`--release`).

The native runtimes come from `scripts/build-native-runtime.sh --container`, which compiles pinned
whisper.cpp and llama.cpp inside Ubuntu 22.04 with static libstdc++/libgcc and an AVX2 baseline. The
binaries therefore need only glibc ≥ 2.34 (Ubuntu 22.04+, Debian 12+, Fedora 36+). The RPM and DEB install
to `/opt/EchoNote` with `/usr/bin/echonote`, an app-menu entry, the icon and
`/usr/share/metainfo/dev.echonote.app.metainfo.xml`, so GNOME Software / App Center list the app and can
uninstall it. Models are not bundled (2.7 GB); the first-run setup downloads and verifies them.
