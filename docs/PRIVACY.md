# Privacy

EchoNote is designed so that what you say stays on your computer.

## What happens to your voice

1. The microphone is opened **only** between pressing the shortcut/button and pressing it again. A
   red overlay, a red tray icon and a banner in the app show while it is open. There is no
   wake word and no background listening.
2. The recording is written to `~/.config/EchoNote/audio-pending/` and transcribed by
   whisper.cpp running on your CPU.
3. **By default the audio file is deleted as soon as the transcript is saved.** If transcription
   fails, the audio is kept so you can retry; it is deleted when the retry succeeds or when you delete
   the capture. You can opt in to keeping audio in Settings → Privacy & data.
4. The transcript is organized by a language model (llama.cpp) running on your CPU.

## Network access

* Recording, transcription, organizing, search, reminders and notifications make **no network
  requests**. This is enforced, not just promised: the renderer's network requests are blocked, and the
  inference servers only listen on `127.0.0.1`. The end-to-end test suite runs the app inside a Linux
  network namespace with no network interface to verify it.
* The only network traffic is the model download you start in the first-run setup (or Settings), from
  `huggingface.co`, over HTTPS, verified by SHA-256.
* No telemetry, analytics, crash reporting, accounts or API keys.

## What is stored

| Data | Where | How to remove |
| --- | --- | --- |
| Transcripts, titles, summaries, reminders, settings | `~/.config/EchoNote/echonote.db` | Delete individual items, or Settings → Delete all data |
| Pending audio | `~/.config/EchoNote/audio-pending/` | Deleted automatically after transcription; Delete all data |
| Logs | `~/.config/EchoNote/logs/` | Delete all data |
| Models | `~/.config/EchoNote/models/` | Delete all data → "also delete downloaded models" |
| Launch-at-login entry (if enabled) | `~/.config/autostart/echonote.desktop` | Turn the setting off, or Delete all data |
| GNOME keyboard shortcut (if set up) | GNOME settings (custom keybinding `echonote`) | Settings → Remove GNOME shortcut, or Delete all data |

Logs record ids, error codes, durations and sizes — never transcripts, note text or audio. The
diagnostics export excludes personal content unless you explicitly choose otherwise.

The database is not encrypted; it is protected by your user account's file permissions, like other
local notes apps. Use full-disk encryption if that matters to you.
