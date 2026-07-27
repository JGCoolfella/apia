#!/usr/bin/env bash
# Cuts a Samoa-sized basemap out of the Protomaps daily planet build and drops it
# in public/basemap/samoa.pmtiles.
#
#   npm run fetch:basemap
#
# Why bother: a .pmtiles file is a single archive served over plain HTTP range
# requests. Put it on S3 behind CloudFront and you have a complete vector
# basemap with no tile server, no API key, no rate limit and no third-party
# dependency at runtime - for a few cents a month. It also makes the map work
# fully offline, which matters both for travellers and for an APK build.
#
# Requires the pmtiles CLI: https://github.com/protomaps/go-pmtiles/releases
#   macOS:  brew install pmtiles
#   Linux:  download the release binary and put it on your PATH

set -euo pipefail

OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/public/basemap"
OUT_FILE="$OUT_DIR/samoa.pmtiles"

# Upolu and Savai'i, with room around the coasts. Matches BBOX in src/config.js,
# widened so the basemap never runs out before the POI data does.
BBOX="${BBOX:--172.90,-14.20,-171.30,-13.35}"   # west,south,east,north
MAXZOOM="${MAXZOOM:-15}"

if ! command -v pmtiles >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: the `pmtiles` CLI is not on your PATH.

  Install it from https://github.com/protomaps/go-pmtiles/releases
  (macOS: `brew install pmtiles`), then run this script again.

Alternatively, build an extract in the browser at https://app.protomaps.com/
by drawing a box around Samoa, and save the download to:
  public/basemap/samoa.pmtiles
EOF
  exit 1
fi

mkdir -p "$OUT_DIR"

# Protomaps publishes a dated global build; "latest" resolves to the most recent.
SOURCE="${SOURCE:-https://build.protomaps.com/$(date -u +%Y%m%d).pmtiles}"

echo "Source : $SOURCE"
echo "BBox   : $BBOX"
echo "Maxzoom: $MAXZOOM"
echo "Output : $OUT_FILE"
echo

if ! pmtiles extract "$SOURCE" "$OUT_FILE" --bbox="$BBOX" --maxzoom="$MAXZOOM"; then
  echo >&2
  echo "Today's global build may not be published yet. Retrying with yesterday's..." >&2
  YESTERDAY="https://build.protomaps.com/$(date -u -d 'yesterday' +%Y%m%d 2>/dev/null || date -u -v-1d +%Y%m%d).pmtiles"
  echo "Source : $YESTERDAY" >&2
  pmtiles extract "$YESTERDAY" "$OUT_FILE" --bbox="$BBOX" --maxzoom="$MAXZOOM"
fi

echo
ls -lh "$OUT_FILE"
echo
echo "Done. Switch the basemap to \"Vector\" in the app's basemap panel (🗺️),"
echo "or set it as the default in src/basemaps.js."
