#!/bin/sh
# Install ghx from GitHub Releases:
#
#   curl -fsSL https://github.com/thegoldenmule/gh-for-agents/releases/latest/download/install.sh | sh
#
# Downloads the archive for this OS and CPU, checks it against the release's SHA256SUMS, and puts the
# ghx binary in $GHX_INSTALL_DIR (default ~/.local/bin). No sudo. Run it again to upgrade: the path
# stays the same, so the Claude Code hook that `ghx install` wrote keeps working.
#
#   GHX_VERSION=v0.1.0   install that release instead of the latest
#   GHX_INSTALL_DIR=dir  install into dir instead of ~/.local/bin
#   GHX_SKIP_VERIFY=1    install even when neither sha256sum nor shasum exists (a mismatch still fails)
set -eu

REPO="thegoldenmule/gh-for-agents"

say() { printf '%s\n' "$*"; }
err() {
  printf 'ghx install: %s\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) err "no ghx binary for $(uname -s). Install with npm instead (Node.js 24+): npm i -g https://github.com/$REPO/releases/latest/download/ghx.tgz" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) err "no ghx binary for CPU $(uname -m). Install with npm instead (Node.js 24+): npm i -g https://github.com/$REPO/releases/latest/download/ghx.tgz" ;;
esac

# An x64 shell on Apple silicon runs under Rosetta; the native binary is the better choice there.
if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
  translated=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
  if [ "$translated" = 1 ]; then arch=arm64; fi
fi

asset="ghx-$os-$arch.tar.gz"

version="${GHX_VERSION:-}"
case "$version" in
  "" | latest) version="" ;;
  v*) ;;
  *) version="v$version" ;;
esac
if [ -n "${GHX_BASE_URL:-}" ]; then
  base="${GHX_BASE_URL%/}" # for testing against a local release directory
elif [ -n "$version" ]; then
  base="https://github.com/$REPO/releases/download/$version"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

install_dir="${GHX_INSTALL_DIR:-${HOME:?HOME is not set; set GHX_INSTALL_DIR}/.local/bin}"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  err "need curl or wget to download ghx"
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t ghx)
staged=""
cleanup() {
  rm -rf "$tmp"
  if [ -n "$staged" ]; then rm -f "$staged"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

say "Downloading $asset from $base"
fetch "$base/$asset" "$tmp/$asset" || err "could not download $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || err "could not download $base/SHA256SUMS"

# Check the archive against its line in SHA256SUMS ("<hash>  <name>"), from inside the temp dir so the
# relative name resolves.
grep -E "^[0-9a-f]{64}  $asset\$" "$tmp/SHA256SUMS" >"$tmp/expected" || err "SHA256SUMS has no entry for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp" && sha256sum -c expected >/dev/null 2>&1) || err "checksum mismatch for $asset; not installing"
elif command -v shasum >/dev/null 2>&1; then
  (cd "$tmp" && shasum -a 256 -c expected >/dev/null 2>&1) || err "checksum mismatch for $asset; not installing"
elif [ "${GHX_SKIP_VERIFY:-}" = 1 ]; then
  say "warning: neither sha256sum nor shasum found; installing without checking the checksum (GHX_SKIP_VERIFY=1)"
else
  err "need sha256sum or shasum to check the download (or set GHX_SKIP_VERIFY=1 to skip the check)"
fi

mkdir "$tmp/x"
tar -xzf "$tmp/$asset" -C "$tmp/x" || err "could not extract $asset"
[ -f "$tmp/x/ghx" ] || err "$asset does not contain ghx"

mkdir -p "$install_dir" || err "could not create $install_dir"
# Stage next to the target and rename, so the swap is atomic and a running ghx keeps its old file.
staged="$install_dir/.ghx.$$.tmp"
cp "$tmp/x/ghx" "$staged" || err "could not write to $install_dir"
chmod 755 "$staged"
if [ "$os" = darwin ]; then xattr -d com.apple.quarantine "$staged" >/dev/null 2>&1 || true; fi
mv -f "$staged" "$install_dir/ghx" || err "could not move ghx into $install_dir"
staged=""

target="$install_dir/ghx"
installed=$("$target" --version 2>/dev/null) || err "installed $target, but it does not run"
say "Installed $target"
say "$installed"

cmd=ghx
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *)
    cmd="$target"
    case "${SHELL:-}" in
      */zsh) rc="${HOME:-~}/.zshrc" ;;
      */bash) rc="${HOME:-~}/.bashrc" ;;
      */fish) rc="" ;;
      *) rc="${HOME:-~}/.profile" ;;
    esac
    say ""
    say "$install_dir is not on your PATH. Add it:"
    if [ -n "$rc" ]; then
      say "  echo 'export PATH=\"$install_dir:\$PATH\"' >> $rc"
    else
      say "  fish_add_path $install_dir"
    fi
    ;;
esac
found=$(command -v ghx 2>/dev/null || true)
if [ -n "$found" ] && [ "$found" != "$target" ] && [ "$cmd" = ghx ]; then
  cmd="$target"
  say ""
  say "warning: $found comes before $target on your PATH; remove it (npm rm -g @thegoldenmule/ghx) or reorder PATH"
fi

say ""
say "Next: wire ghx into Claude Code:"
say "  $cmd install"
say "Optional: check the archive's build provenance with gh:"
say "  curl -fsSLO $base/$asset && gh attestation verify $asset --repo $REPO"
