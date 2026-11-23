#!/usr/bin/env bash
# Package the built Linux and Windows hosts as release assets.
#
# Expects package/ego-browser, package/ego-windows-host and package/ego-linux-host
# to be built already (`npm run build` in each). Writes:
#   <out>/ego-linux-host-<tag>.tgz
#   <out>/ego-windows-host-<tag>.zip
#   <out>/SHA256SUMS-hosts.txt
#
# The Windows host loads ego-browser-v2/dist/src/run.js at runtime through a
# file:../ego-browser symlink, so the archive carries a real copy of that build
# instead of the link. The built harness has no bare-module imports, so its
# dist/ is all it needs.
set -euo pipefail

tag="${1:?usage: package-hosts.sh <tag> <out-dir>}"
out="${2:?usage: package-hosts.sh <tag> <out-dir>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
pkg="$root/package"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

for f in "$pkg/ego-linux-host/dist/cli.js" "$pkg/ego-windows-host/dist/src/cli.js" "$pkg/ego-browser/dist/src/run.js"; do
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
mkdir -p "$win/node_modules/ego-browser-v2"
cp -R "$pkg/ego-windows-host/bin" "$pkg/ego-windows-host/dist" "$pkg/ego-windows-host/package.json" "$pkg/ego-windows-host/README.md" "$win/"
cp -R "$pkg/ego-browser/dist" "$pkg/ego-browser/package.json" "$win/node_modules/ego-browser-v2/"
(cd "$stage" && zip -qr "$out/ego-windows-host-$tag.zip" "ego-windows-host-$tag")

(cd "$out" && sha256sum "ego-linux-host-$tag.tgz" "ego-windows-host-$tag.zip" > SHA256SUMS-hosts.txt)
ls -l "$out"
