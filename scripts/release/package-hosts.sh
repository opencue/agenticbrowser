#!/usr/bin/env bash
# Package the built Linux and Windows hosts as release assets.
#
# Expects package/ego-browser-v2, package/ego-windows-host and package/ego-linux-host
# to be built already (`npm run build` in each). Writes:
#   <out>/ego-linux-host-<tag>.tgz
#   <out>/ego-windows-host-<tag>.zip
#   <out>/SHA256SUMS-hosts.txt
#
# The Windows host loads ego-browser-v2/dist/src/run.js at runtime through a
# file:../ego-browser-v2 symlink, so the archive carries a real copy of that build
# instead of the link, plus the runtime's own production dependencies (acorn).
set -euo pipefail

tag="${1:?usage: package-hosts.sh <tag> <out-dir>}"
out="${2:?usage: package-hosts.sh <tag> <out-dir>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
pkg="$root/package"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

for f in "$pkg/ego-linux-host/dist/cli.js" "$pkg/ego-windows-host/dist/src/cli.js" "$pkg/ego-browser-v2/dist/src/run.js"; do
  test -f "$f" || { echo "missing build output: $f" >&2; exit 1; }
done

# Linux host
linux="$stage/ego-linux-host-$tag"
mkdir -p "$linux"
cp -R "$pkg/ego-linux-host/bin" "$pkg/ego-linux-host/package.json" "$pkg/ego-linux-host/README.md" "$linux/"
mkdir -p "$linux/dist"
tar -C "$pkg/ego-linux-host/dist" --exclude='*.test.js' --exclude='*.map' -cf - . | tar -C "$linux/dist" -xf -
tar -C "$stage" -czf "$out/ego-linux-host-$tag.tgz" "ego-linux-host-$tag"

# Windows host
win="$stage/ego-windows-host-$tag"
mkdir -p "$win/node_modules/ego-browser-v2" "$win/dist"
cp -R "$pkg/ego-windows-host/bin" "$pkg/ego-windows-host/package.json" "$pkg/ego-windows-host/README.md" "$win/"
tar -C "$pkg/ego-windows-host/dist" --exclude='*.test.js' --exclude='*.map' -cf - . | tar -C "$win/dist" -xf -
cp -R "$pkg/ego-browser-v2/dist" "$pkg/ego-browser-v2/package.json" "$win/node_modules/ego-browser-v2/"
for dep in $(node -p 'Object.keys(require(process.argv[1]).dependencies ?? {}).join(" ")' "$pkg/ego-browser-v2/package.json"); do
  test -d "$pkg/ego-browser-v2/node_modules/$dep" || { echo "missing dependency: $dep (run npm ci in package/ego-browser-v2)" >&2; exit 1; }
  cp -R "$pkg/ego-browser-v2/node_modules/$dep" "$win/node_modules/$dep"
done
(cd "$stage" && zip -qr "$out/ego-windows-host-$tag.zip" "ego-windows-host-$tag")

(cd "$out" && sha256sum "ego-linux-host-$tag.tgz" "ego-windows-host-$tag.zip" > SHA256SUMS-hosts.txt)
ls -l "$out"
