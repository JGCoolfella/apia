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
 * Extraction bounding box: the north coast of Upolu from Mulifanua / Faleolo in
 * the west to Falefa in the east, inland past Vailima and Mount Vaea. Chosen so
 * that both airports and the Savai'i ferry terminal fall inside the dataset.
 */
export const BBOX = {
  south: -13.95,
  west: -172.1,
  north: -13.7,
  east: -171.6,
};

/** Camera clamp: the same area with a little breathing room. */
export const MAX_BOUNDS = [
  [BBOX.west - 0.15, BBOX.south - 0.15],
  [BBOX.east + 0.15, BBOX.north + 0.15],
];

export const IANA_TZ = 'Pacific/Apia'; // UTC+13 year-round; Samoa abolished DST in 2021.

/**
 * Overpass mirrors, tried in order. The build script and the in-browser "refresh
 * from OpenStreetMap" action both walk this list.
 */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

export const DATA_URL = 'data/apia.geojson';
export const META_URL = 'data/meta.json';
