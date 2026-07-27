// Loading and caching of the POI dataset.
//
// Order of preference:
//   1. data/apia.geojson         - the committed snapshot (fast, offline-safe)
//   2. localStorage cache        - a previous live refresh
//   3. live Overpass query       - so the map still works from a bare checkout
//
// The user can force step 3 at any time from the data panel, which is what makes
// the map current rather than frozen at whenever the snapshot was built.

import { DATA_URL, META_URL, OVERPASS_ENDPOINTS, BBOX } from './config.js';
import { buildQuery, toGeoJSON, runOverpass } from './overpass.js';

const CACHE_KEY = 'apia-map:osm-cache:v1';
const CACHE_META_KEY = 'apia-map:osm-cache-meta:v1';

/** @typedef {{geojson: object, meta: object, origin: 'snapshot'|'cache'|'live'}} Dataset */

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const meta = localStorage.getItem(CACHE_META_KEY);
    if (!raw || !meta) return null;
    return { geojson: JSON.parse(raw), meta: JSON.parse(meta), origin: 'cache' };
  } catch {
    return null;
  }
}

function writeCache(geojson, meta) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(geojson));
    localStorage.setItem(CACHE_META_KEY, JSON.stringify(meta));
  } catch {
    // Quota exceeded on a large dataset is not worth failing the app over.
  }
}

export function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_META_KEY);
  } catch { /* ignore */ }
}

/** @returns {Promise<Dataset>} */
export async function loadDataset() {
  try {
    const [geojson, meta] = await Promise.all([
      fetchJSON(DATA_URL),
      fetchJSON(META_URL).catch(() => ({})),
    ]);
    if (geojson?.features?.length) {
      return { geojson, meta: { ...meta, origin: 'snapshot' }, origin: 'snapshot' };
    }
  } catch {
    // No snapshot committed yet - fall through.
  }

  const cached = readCache();
  if (cached?.geojson?.features?.length) return cached;

  return refreshFromOSM();
}

/**
 * Query Overpass directly from the browser. Overpass sends
 * `Access-Control-Allow-Origin: *`, so this works from any origin.
 * @returns {Promise<Dataset>}
 */
export async function refreshFromOSM(onProgress) {
  const query = buildQuery(BBOX);
  const { json, endpoint } = await runOverpass(query, OVERPASS_ENDPOINTS, fetch, (url) =>
    onProgress?.(`Querying ${new URL(url).host}...`),
  );
  onProgress?.('Processing results...');
  const geojson = toGeoJSON(json);
  const meta = {
    generated: new Date().toISOString(),
    osm_data_timestamp: json.osm3s?.timestamp_osm_base ?? null,
    endpoint,
    bbox: BBOX,
    feature_count: geojson.features.length,
    source: 'OpenStreetMap contributors',
    license: 'Open Database License (ODbL) 1.0',
    origin: 'live',
  };
  writeCache(geojson, meta);
  return { geojson, meta, origin: 'live' };
}
