#!/usr/bin/env bash
# EchoNote Linux bundler: builds, checks and (optionally) publishes every Linux package.
#
#   npm run dist:linux                    # AppImage + .rpm + .deb into dist/, with SHA256SUMS
#   npm run dist:linux -- --release       # ... and publish a GitHub release v<version> (needs gh)
#   npm run dist:linux -- --verify-deb    # also install the .deb in Ubuntu 24.04 + 22.04 containers and
#                                          # run the bundled whisper/llama there (needs Docker/Podman)
#   npm run dist:linux -- --skip-tests    # skip lint + unit tests (not recommended)
#   npm run dist:linux -- --allow-host-glibc   # accept native runtimes built on this machine
#
# Steps:
#   1. check that the native runtimes exist and are portable (glibc <= 2.35, no extra libstdc++),
#      i.e. built with `npm run native:build -- --container`
#   2. lint + unit tests
#   3. build the app and run electron-builder for AppImage, rpm and deb
#   4. inspect every package: native runtimes, model manifest, desktop entry, AppStream metadata
#   5. write dist/SHA256SUMS
#   6. --release: create the GitHub release with all three packages and the checksums
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RELEASE=0
SKIP_TESTS=0
VERIFY_DEB=0
ALLOW_HOST_GLIBC=0
for arg in "$@"; do
  case "$arg" in
    --release) RELEASE=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --verify-deb) VERIFY_DEB=1 ;;
    --allow-host-glibc) ALLOW_HOST_GLIBC=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
BIN="resources/bin/linux-x64"
MAX_GLIBC="2.35"
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

step "EchoNote $VERSION: checking native runtimes"
for f in whisper-server llama-server VERSIONS.txt; do
  [ -e "$BIN/$f" ] || fail "$BIN/$f missing. Run: npm run native:build -- --container"
done
for f in "$BIN/whisper-server" "$BIN/llama-server"; do
  need="$(objdump -T "$f" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1)"
  printf '  %-14s needs glibc %s\n' "$(basename "$f")" "$need"
  if [ "$(printf '%s\n%s\n' "$need" "$MAX_GLIBC" | sort -V | tail -1)" != "$MAX_GLIBC" ] && [ "$ALLOW_HOST_GLIBC" = 0 ]; then
    fail "$(basename "$f") needs glibc $need (> $MAX_GLIBC), so it would not run on Ubuntu 22.04/24.04 or Debian 12.
       Rebuild portable runtimes: npm run native:build -- --container   (or pass --allow-host-glibc)"
  fi
done
sed 's/^/  /' "$BIN/VERSIONS.txt"

if [ "$SKIP_TESTS" = 0 ]; then
  step "Lint + unit tests"
  npm run lint --silent
  npx vitest run --silent
fi

step "Packaging tools"
# electron-builder's bundled fpm (used for rpm and deb) links against libcrypt.so.1.
if ! ldconfig -p | grep -q 'libcrypt.so.1 '; then
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/echonote-build/libxcrypt-compat"
  if [ ! -e "$CACHE/usr/lib64/libcrypt.so.1" ] && command -v dnf >/dev/null; then
    echo "  libcrypt.so.1 not installed; extracting it from Fedora's libxcrypt-compat (no install needed)"
    mkdir -p "$CACHE" && (cd "$CACHE" && dnf download -q libxcrypt-compat --arch x86_64 \
      && rpm2cpio libxcrypt-compat-*.rpm | cpio -idm --quiet)
  fi
  [ -e "$CACHE/usr/lib64/libcrypt.so.1" ] || fail "libcrypt.so.1 is needed (Fedora: libxcrypt-compat, Debian/Ubuntu: libcrypt1)"
  export LD_LIBRARY_PATH="$CACHE/usr/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
command -v rpmbuild >/dev/null || fail "rpmbuild is needed for the .rpm (Fedora: rpm-build, Debian/Ubuntu: rpm)"
echo "  ok"

step "Building AppImage, rpm and deb"
rm -rf dist
npx electron-vite build
npx electron-builder --linux --publish never

APPIMAGE="dist/EchoNote-$VERSION-x86_64.AppImage"
RPM="dist/echonote-$VERSION.x86_64.rpm"
DEB="dist/echonote_${VERSION}_amd64.deb"
for f in "$APPIMAGE" "$RPM" "$DEB"; do [ -f "$f" ] || fail "missing $f"; done

step "Inspecting packages"
REQUIRED=(
  resources/bin/linux-x64/whisper-server
  resources/bin/linux-x64/llama-server
  resources/models.json
  resources/tray-recording.png
)
check_list() { # name listing
  local name="$1" listing="$2" ok=1
  for p in "${REQUIRED[@]}" usr/share/applications/echonote.desktop usr/share/metainfo/dev.echonote.app.metainfo.xml; do
    grep -q "$p" <<<"$listing" || { echo "  $name: MISSING $p"; ok=0; }
  done
  [ "$ok" = 1 ] && echo "  $name: all required files present" || fail "$name is incomplete"
}
check_list "rpm" "$(rpm -qpl "$RPM" 2>/dev/null)"
check_list "deb" "$(dpkg-deb -c "$DEB")"
APP_LISTING="$(cd dist/linux-unpacked && find . -type f)"
for p in "${REQUIRED[@]}"; do grep -q "$p" <<<"$APP_LISTING" || fail "AppImage payload missing $p"; done
echo "  AppImage: all required files present"
echo "  deb depends: $(dpkg-deb -f "$DEB" Depends)"

step "Checksums"
(cd dist && sha256sum "$(basename "$APPIMAGE")" "$(basename "$RPM")" "$(basename "$DEB")" > SHA256SUMS && cat SHA256SUMS)
ls -lh "$APPIMAGE" "$RPM" "$DEB" | awk '{print "  " $5 "  " $9}'

if [ "$VERIFY_DEB" = 1 ]; then
  for img in ubuntu:24.04 ubuntu:22.04; do
    step "Verifying the .deb on $img"
    bash scripts/verify-deb.sh "$DEB" "$img"
  done
fi

if [ "$RELEASE" = 1 ]; then
  step "Publishing GitHub release v$VERSION"
  command -v gh >/dev/null || fail "gh CLI is needed for --release"
  NOTES="docs/release-notes/v$VERSION.md"
  [ -f "$NOTES" ] || fail "write release notes first: $NOTES"
  gh release create "v$VERSION" "$APPIMAGE" "$RPM" "$DEB" dist/SHA256SUMS \
    --title "EchoNote $VERSION" --notes-file "$NOTES" --target main --latest
fi

step "Done"
