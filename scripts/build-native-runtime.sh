#!/usr/bin/env bash
# Builds the two native inference runtimes EchoNote bundles:
#   whisper-server (whisper.cpp)  -> local speech-to-text
#   llama-server   (llama.cpp)    -> local LLM classification
# Output: resources/bin/linux-x64/{whisper-server,llama-server}
#
# Binaries are statically linked against ggml. libstdc++/libgcc_s from the
# build machine are copied next to them and found via an $ORIGIN rpath, so the
# packaged app only needs glibc (both libraries are redistributable under the
# GCC Runtime Library Exception). CPU baseline is x86-64 with AVX2/FMA/F16C
# (Intel Haswell / AMD Zen and newer). Requires: git, cmake >= 3.14, g++.
# If cmake is not installed, set CMAKE="uvx --from cmake cmake".
set -euo pipefail

WHISPER_TAG="${WHISPER_TAG:-v1.9.4}"
LLAMA_TAG="${LLAMA_TAG:-b11379}"
CMAKE="${CMAKE:-cmake}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${NATIVE_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/echonote-native-build}"
OUT="$ROOT/resources/bin/linux-x64"
JOBS="$(nproc)"

COMMON_FLAGS=(
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON
  -DGGML_OPENMP=OFF
  '-DCMAKE_BUILD_RPATH=$ORIGIN' -DCMAKE_BUILD_RPATH_USE_ORIGIN=ON
)

mkdir -p "$WORK" "$OUT"
# Always configure from scratch so changed flags never mix with a stale CMake cache.
rm -rf "$WORK/whisper.cpp/build" "$WORK/llama.cpp/build"

fetch() { # repo tag dir
  if [ ! -d "$WORK/$3/.git" ]; then
    git clone --depth 1 --branch "$2" "$1" "$WORK/$3"
  else
    git -C "$WORK/$3" fetch --depth 1 origin tag "$2" && git -C "$WORK/$3" checkout -q "$2"
  fi
}

echo "==> whisper.cpp $WHISPER_TAG"
fetch https://github.com/ggml-org/whisper.cpp "$WHISPER_TAG" whisper.cpp
$CMAKE -S "$WORK/whisper.cpp" -B "$WORK/whisper.cpp/build" "${COMMON_FLAGS[@]}" \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF
$CMAKE --build "$WORK/whisper.cpp/build" --target whisper-server -j "$JOBS"
install -m 755 "$WORK/whisper.cpp/build/bin/whisper-server" "$OUT/whisper-server"

echo "==> llama.cpp $LLAMA_TAG"
fetch https://github.com/ggml-org/llama.cpp "$LLAMA_TAG" llama.cpp
$CMAKE -S "$WORK/llama.cpp" -B "$WORK/llama.cpp/build" "${COMMON_FLAGS[@]}" \
  -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_TOOLS=ON
$CMAKE --build "$WORK/llama.cpp/build" --target llama-server -j "$JOBS"
install -m 755 "$WORK/llama.cpp/build/bin/llama-server" "$OUT/llama-server"

strip "$OUT/whisper-server" "$OUT/llama-server" || true
for lib in libstdc++.so.6 libgcc_s.so.1; do
  src="$(ldd "$OUT/llama-server" | awk -v l="$lib" '$1==l {print $3}')"
  [ -n "$src" ] && install -m 644 "$(readlink -f "$src")" "$OUT/$lib"
done
cat > "$OUT/VERSIONS.txt" <<VERS
whisper.cpp $WHISPER_TAG (MIT License)
llama.cpp $LLAMA_TAG (MIT License)
built $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(uname -srm)
VERS
echo "==> Done. Dynamic dependencies:"
ldd "$OUT/whisper-server" "$OUT/llama-server" || true
ls -la "$OUT"
if [ "${KEEP_NATIVE_BUILD:-0}" != "1" ]; then rm -rf "$WORK/whisper.cpp/build" "$WORK/llama.cpp/build"; fi
