#!/usr/bin/env bash
# Regenerates the synthetic speech fixtures used by integration and end-to-end tests.
# Requires espeak-ng and ffmpeg (development machine only). Output: 16 kHz mono 16-bit WAV.
set -euo pipefail
cd "$(dirname "$0")/../tests/fixtures"
say() { # name text
  espeak-ng -v en-us -s 150 -w "/tmp/echonote-$1.wav" "$2"
  ffmpeg -loglevel error -y -i "/tmp/echonote-$1.wav" -af "adelay=300,apad=pad_dur=0.4" -ar 16000 -ac 1 -sample_fmt s16 "$1.wav"
  rm -f "/tmp/echonote-$1.wav"
}
say reference "The staging server uses port eight zero eight one."
say reminder "Remind me tomorrow at nine in the morning to call the dentist."
say task "I need to fix the login bug on the settings page."
say idea "I could build a tool that explains database query plans in plain English."
say near_reminder "Remind me in two minutes to stretch."
ls -la ./*.wav
