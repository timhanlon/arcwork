#!/usr/bin/env bash
# Regenerate all app-icon / favicon assets from the brand master SVGs.
# Sources:  assets/brand/arc-icon.svg (tile)  ·  assets/brand/favicon.svg (adaptive mark)
# Requires: rsvg-convert, magick (ImageMagick), iconutil (macOS).
set -euo pipefail
cd "$(dirname "$0")/.."

TILE=assets/brand/arc-icon.svg
FAVI=assets/brand/favicon.svg
TMP="$(mktemp -d)"
ICONSET="$TMP/arc.iconset"
mkdir -p "$ICONSET" build

render() { rsvg-convert -w "$2" -h "$2" "$1" -o "$3"; }   # svg size out

echo "→ macOS .iconset"
for spec in 16:16x16 32:16x16@2x 32:32x32 64:32x32@2x \
            128:128x128 256:128x128@2x 256:256x256 512:256x256@2x \
            512:512x512 1024:512x512@2x; do
  px=${spec%%:*}; name=${spec##*:}
  render "$TILE" "$px" "$ICONSET/icon_${name}.png"
done
iconutil -c icns "$ICONSET" -o build/icon.icns

echo "→ Linux / generic PNG (512)"
render "$TILE" 512 build/icon.png

echo "→ Windows .ico (16/32/48/256)"
for px in 16 32 48 256; do render "$TILE" "$px" "$TMP/ico-$px.png"; done
magick "$TMP/ico-16.png" "$TMP/ico-32.png" "$TMP/ico-48.png" "$TMP/ico-256.png" build/icon.ico

echo "→ favicons"
for px in 16 32 48; do render "$FAVI" "$px" "$TMP/fav-$px.png"; done
magick "$TMP/fav-16.png" "$TMP/fav-32.png" "$TMP/fav-48.png" assets/brand/favicon.ico
render "$TILE" 180 assets/brand/apple-touch-icon.png   # opaque tile for iOS home screen

echo "✓ wrote build/icon.{icns,ico,png} and assets/brand/{favicon.ico,apple-touch-icon.png}"
rm -rf "$TMP"
