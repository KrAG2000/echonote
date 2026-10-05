# Troubleshooting

Logs: `~/.config/EchoNote/logs/echonote.log` (Settings → Diagnostics shows the paths, runtime
versions, memory and recent pipeline timings; "Export diagnostics" writes a shareable JSON without
personal content).

## The shortcut does nothing

* **GNOME on Wayland** (Fedora default): applications cannot grab global keys. Open Settings →
  Recording shortcut → **Set up GNOME shortcut**. EchoNote adds a GNOME custom keyboard shortcut
  (visible in GNOME Settings → Keyboard → Custom Shortcuts) that runs `EchoNote --toggle`.
  If nothing happens, check that the key combination is not already used by GNOME.
* **Other Wayland desktops**: bind a custom shortcut in your desktop settings to
  `/path/to/EchoNote-1.0.4-x86_64.AppImage --toggle` (RPM install: `echonote --toggle`).
* **X11**: the shortcut is registered directly. If registration fails, another app owns the keys —
  choose a different combination in Settings.
* You can always record with the big button, the overlay's Stop button or the tray menu.

## "Microphone access was denied" / "No microphone was found"

* Check GNOME Settings → Privacy → Microphone is enabled, and that an input device is selected and
  unmuted in Settings → Sound.
* Use Settings → Run setup again → Test microphone to see a live level meter.
* "No sound was picked up" means the recording was silent (wrong input device or muted mic). Nothing is
  saved in that case.

## AI model shows "low memory"

The default LLM (Gemma 4 E2B) needs about 3.8 GB of free RAM (Qwen 1.5B: ~2 GB, the small models ~1 GB). EchoNote checks `MemAvailable` before loading it. Close some
applications and press **Restart AI model**, press **Load anyway**, or switch to a smaller model in
Settings. Captures are still transcribed and wait in the Inbox in the meantime.

## Organizing is slow

On CPU-only machines Gemma 4 E2B takes several seconds per note (~8.6 s on the test laptop); much slower when the CPU is in a
power-saving profile (GNOME "Power Saver" / platform profile `quiet`). Options: switch the power mode
to Balanced/Performance, or select Qwen2.5 1.5B in Settings (~1.6× faster, equally accurate in our tests). The transcript is saved immediately either way.

## Model download failed

Downloads resume from where they stopped: press **Retry download**. A file that fails its SHA-256
check is discarded automatically. If the disk is full, free space and retry; partial downloads are
kept.

## Reminder didn't fire

Reminders are delivered only while EchoNote is running. Closing the window keeps it running in the
background (unless disabled in Settings). Reminders that came due while EchoNote was not running are
shown once as "Overdue" at the next start. Enable **Launch at login** (AppImage build) to have it
start automatically. Check that notifications are not muted (GNOME "Do Not Disturb").

## No red dot in the top bar while recording

GNOME does not show app indicators without the AppIndicator extension:
`sudo dnf install gnome-shell-extension-appindicator`, then log out and back in (and enable it in the
Extensions app if needed). Until then EchoNote shows a floating popup while recording (Settings → While
recording → Floating recording popup), and GNOME's own microphone icon appears in the top bar.

## Recording stops by itself

That's the silence auto-stop: after 5 s without speech the recording ends (and is discarded if nothing
was said). Change or disable it in Settings → While recording.

## Reset everything

Settings → Delete all data (optionally including models), or quit EchoNote and delete
`~/.config/EchoNote`.
