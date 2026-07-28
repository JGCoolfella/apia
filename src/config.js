// Central configuration for the Apia interactive map.
//
// Every coordinate that appears as a map pin comes from OpenStreetMap via the
// data pipeline (see scripts/fetch-osm.mjs). The only coordinates hard-coded in
// this file are the map's default camera position and the extraction bounding
// box, both of which are approximate by design.

/** Apia town centre. 13deg 50' S, 171deg 46' W. */
export const APIA_CENTER = [-171.7667, -13.8333]; // [lng, lat]

/**
 * Opening camera. Pulled a little south of the town centre and out to z13.5 so
 * the first view spans the whole of Apia proper: the harbour and Beach Road at
 * the top, Vailima and the foot of Mount Vaea at the bottom. At z14 a MapLibre
 * viewport is only about 4 km wide, which cuts Vailima off entirely.
 */
export const DEFAULT_CENTER = [-171.769, -13.841];
export const DEFAULT_ZOOM = 13.5;

/**
 * Extraction bounding box: the whole of Samoa — Upolu, Savai'i, Manono and
 * Apolima. Apia remains the map's home and focus, but a visitor's trip does not
 * stop at the town limits: the ferry crosses to Savai'i, and a map that ends at
 * the wharf strands them. Both islands, ferry to ferry.
 */
export const BBOX = {
  south: -14.10,
  west: -172.85,
  north: -13.40,
  east: -171.35,
};

/** Camera clamp: the same area with a little breathing room. */
export const MAX_BOUNDS = [
  [BBOX.west - 0.15, BBOX.south - 0.15],
  [BBOX.east + 0.15, BBOX.north + 0.15],
];

export const IANA_TZ = 'Pacific/Apia'; // UTC+13 year-round; Samoa abolished DST in 2021.

/**
 * Bump this whenever the extraction changes shape — the Overpass selectors, the
 * classifier, the property schema, deduplication. The refresh workflow compares
 * it against the value recorded in meta.json and rebuilds the snapshot when they
 * differ, so a pipeline change cannot leave stale data behind.
 *
 *   1  initial extraction
 *   2  collapse OSM node/way duplicates of the same place
 *   3  restrict that merge to node+way pairs, with a wider radius for villages
 *   4  reject Overpass mirrors lagging behind the planet
 *   5  expand coverage from the Apia coast to the whole of Samoa
 */
export const PIPELINE_VERSION = 5;

/**
 * Overpass mirrors, tried in order. The build script and the in-browser "refresh
 * from OpenStreetMap" action both walk this list.
 */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/**
 * How far behind the OpenStreetMap planet a mirror may be before it is skipped.
 *
 * Mirrors replicate independently and some fall a long way behind while still
 * serving complete, valid-looking results — one in this list answered with data
 * 82 days old. For a map whose whole claim is currency, that is a silent
 * failure, so freshness is checked as part of accepting a response.
 */
export const MAX_OSM_AGE_DAYS = 14;

/** Age at which a committed snapshot fails validation outright. */
export const STALE_SNAPSHOT_DAYS = 30;

export const DATA_URL = 'data/apia.geojson';
export const META_URL = 'data/meta.json';
