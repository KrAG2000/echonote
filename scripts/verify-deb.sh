#!/usr/bin/env bash
# Installs the .deb in a clean Ubuntu container and proves the bundled runtimes work there:
#   - apt resolves the package's dependencies and installs it
#   - whisper-server and llama-server start (no missing glibc / libstdc++ symbols)
#   - with models available: whisper transcribes tests/fixtures/jfk.wav and llama classifies a note
#
#   bash scripts/verify-deb.sh dist/echonote_<version>_amd64.deb [ubuntu:24.04]
# Models are read (read-only) from $ECHONOTE_MODELS_DIR or ~/.config/EchoNote/models.
set -euo pipefail
DEB="$(realpath "$1")"
IMAGE="${2:-ubuntu:24.04}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS="${ECHONOTE_MODELS_DIR:-$HOME/.config/EchoNote/models}"
ENGINE="${CONTAINER_ENGINE:-$(command -v docker || command -v podman)}"
LLM_FILE="$(node -p "const m=require('$ROOT/resources/models.json').models.find(x=>x.kind==='llm'&&x.default);m.fileName")"
SPEECH_FILE="$(node -p "const m=require('$ROOT/resources/models.json').models.find(x=>x.kind==='speech'&&x.default);m.fileName")"

exec "$ENGINE" run --rm --security-opt label=disable \
  -v "$DEB:/pkg/echonote.deb:ro" -v "$ROOT/tests/fixtures:/fixtures:ro" -v "$MODELS:/models:ro" \
  -e LLM_FILE="$LLM_FILE" -e SPEECH_FILE="$SPEECH_FILE" "$IMAGE" bash -c '
set -e
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release; echo "== $PRETTY_NAME, glibc $(ldd --version | head -1 | grep -o "[0-9.]*$")"
apt-get update -qq >/dev/null
apt-get install -y -qq /pkg/echonote.deb curl >/dev/null 2>&1 || apt-get install -y /pkg/echonote.deb curl
echo "== installed: $(dpkg-query -W -f="\${Package} \${Version}" echonote)"
ls /usr/share/applications/echonote.desktop /usr/share/metainfo/dev.echonote.app.metainfo.xml >/dev/null && echo "== desktop entry + AppStream metadata present"
BIN=/opt/EchoNote/resources/bin/linux-x64
for s in whisper-server llama-server; do
  if ldd $BIN/$s | grep -q "not found"; then echo "FAIL: $s has missing libraries"; ldd $BIN/$s; exit 1; fi
  $BIN/$s --help >/dev/null 2>&1 || { echo "FAIL: $s does not start"; $BIN/$s --help 2>&1 | head -3; exit 1; }
  echo "== $s starts (no missing symbols)"
done
if [ -f "/models/$SPEECH_FILE" ]; then
  $BIN/whisper-server -m "/models/$SPEECH_FILE" --host 127.0.0.1 --port 18900 -t 4 >/dev/null 2>&1 &
  until curl -sf 127.0.0.1:18900/health >/dev/null; do sleep 0.3; done
  T=$(curl -s -F file=@/fixtures/jfk.wav -F response_format=json -F language=en 127.0.0.1:18900/inference)
  echo "== whisper transcript: $T"
  echo "$T" | grep -qi "ask not what your country" || { echo "FAIL: unexpected transcript"; exit 1; }
fi
if [ -f "/models/$LLM_FILE" ]; then
  $BIN/llama-server -m "/models/$LLM_FILE" -c 2048 -ub 256 -np 1 -t 8 --no-webui --jinja --host 127.0.0.1 --port 18901 >/dev/null 2>&1 &
  until curl -sf 127.0.0.1:18901/health >/dev/null; do sleep 0.5; done
  R=$(curl -s 127.0.0.1:18901/v1/chat/completions -H "content-type: application/json" -d "{\"messages\":[{\"role\":\"system\",\"content\":\"Classify the note as task, reminder, idea or reference. Answer with one word.\"},{\"role\":\"user\",\"content\":\"The staging server uses port 8081.\"}],\"max_tokens\":5,\"temperature\":0,\"chat_template_kwargs\":{\"enable_thinking\":false}}")
  echo "== llama answer: $(echo "$R" | grep -o "\"content\":\"[^\"]*\"" | head -1)"
  echo "$R" | grep -qi "reference" || { echo "FAIL: unexpected LLM answer"; exit 1; }
fi
echo "== PASS: .deb verified on $PRETTY_NAME"
'
