// Builds the Overpass QL query and converts an Overpass JSON response into the
// normalised GeoJSON the app renders. Shared by scripts/fetch-osm.mjs (Node) and
// src/data.js (browser), so the snapshot and any live refresh are identical.

import { BBOX } from './config.js';
import { classify } from './classify.js';

/** Overpass bbox filters are (south,west,north,east). */
export function bboxClause(bbox = BBOX) {
  return `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
}

/**
 * One query covering everything a visitor or resident would want to find.
 * `nwr` matches nodes, ways and relations; `out center` gives ways/relations a
 * representative point so every result can be drawn as a pin.
 */
export function buildQuery(bbox = BBOX, timeout = 180) {
  const b = bboxClause(bbox);
  const selectors = [
    '[amenity]',
    '[shop]',
    '[tourism]',
    '[leisure]',
    '[historic]',
    '[office]',
    '[healthcare]',
    '[craft]',
    '[emergency~"^(ambulance_station|phone|water_rescue|defibrillator|fire_hydrant)$"]',
    '[aeroway~"^(aerodrome|terminal|helipad)$"]',
    '[man_made~"^(lighthouse|pier|water_tower|monitoring_station)$"]',
    '[natural~"^(beach|peak|spring|cave_entrance|reef)$"]',
    '[place~"^(city|town|suburb|village|neighbourhood|hamlet|island|locality)$"]',
    '[highway=bus_stop]',
    '[public_transport~"^(station|stop_position|platform)$"]',
    '[railway=station]',
  ];
  const body = selectors.map((s) => `  nwr${s}${b};`).join('\n');
  return `[out:json][timeout:${timeout}];\n(\n${body}\n);\nout center tags;`;
}

/** Tags worth keeping. Everything else is dropped to keep the payload small. */
const KEEP_TAGS = new Set([
  'name', 'name:sm', 'name:en', 'alt_name', 'official_name', 'old_name', 'brand', 'operator',
  'amenity', 'shop', 'tourism', 'leisure', 'historic', 'office', 'healthcare', 'craft',
  'emergency', 'aeroway', 'man_made', 'natural', 'place', 'highway', 'public_transport',
  'railway', 'cuisine', 'opening_hours', 'phone', 'contact:phone', 'mobile', 'website',
  'contact:website', 'email', 'contact:email', 'facebook', 'contact:facebook',
  'addr:housenumber', 'addr:street', 'addr:city', 'addr:suburb', 'addr:place',
  'wheelchair', 'internet_access', 'wikidata', 'wikipedia', 'description', 'denomination',
  'religion', 'atm', 'fee', 'toilets', 'drinking_water', 'capacity', 'stars', 'rooms',
  'ele', 'ref', 'iata', 'icao', 'network', 'route_ref', 'diplomatic', 'country',
  'takeaway', 'delivery', 'outdoor_seating', 'air_conditioning', 'payment:cash',
  'payment:credit_cards', 'currency:WST', 'opening_hours:covid19', 'check_date',
]);

function pruneTags(tags = {}) {
  const out = {};
  for (const [k, v] of Object.entries(tags)) {
    if (KEEP_TAGS.has(k)) out[k] = v;
  }
  return out;
}

const TYPE_PREFIX = { node: 'n', way: 'w', relation: 'r' };

function first(tags, ...keys) {
  for (const k of keys) {
    if (tags[k]) return tags[k];
  }
  return undefined;
}

function buildAddress(tags) {
  const parts = [];
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  if (street) parts.push(street);
  const area = first(tags, 'addr:suburb', 'addr:place');
  if (area) parts.push(area);
  if (tags['addr:city']) parts.push(tags['addr:city']);
  return parts.length ? parts.join(', ') : undefined;
}

/**
 * Overpass JSON -> GeoJSON FeatureCollection with a stable property schema.
 * Unnamed features are kept only when they are still useful without a name
 * (an ATM, a bus stop, a viewpoint); otherwise they are noise on the map.
 */
export function toGeoJSON(overpassJson) {
  const features = [];
  const seen = new Set();

  for (const el of overpassJson.elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;

    const tags = el.tags || {};
    const name = first(tags, 'name', 'name:en', 'official_name', 'brand');
    const klass = classify(tags);
    if (!klass) continue;
    if (!name && !klass.keepUnnamed) continue;

    const id = `${TYPE_PREFIX[el.type] || 'x'}${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const kept = pruneTags(tags);
    const props = {
      id,
      osm_type: el.type,
      osm_id: el.id,
      name: name || klass.fallbackName,
      unnamed: name ? undefined : true,
      name_sm: tags['name:sm'] && tags['name:sm'] !== name ? tags['name:sm'] : undefined,
      cat: klass.cat,
      kind: klass.kind,
      rank: klass.rank,
      addr: buildAddress(tags),
      phone: first(tags, 'phone', 'contact:phone', 'mobile'),
      website: first(tags, 'website', 'contact:website'),
      email: first(tags, 'email', 'contact:email'),
      hours: tags.opening_hours,
      cuisine: tags.cuisine,
      operator: tags.operator,
      wheelchair: tags.wheelchair,
      wikidata: tags.wikidata,
      wikipedia: tags.wikipedia,
      description: tags.description,
      tags: kept,
    };
    for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];

    features.push({
      type: 'Feature',
      id: features.length + 1, // numeric id required for feature-state
      geometry: { type: 'Point', coordinates: [round(lon), round(lat)] },
      properties: props,
    });
  }

  const deduped = dedupe(features);
  deduped.sort((a, b) => (a.properties.rank - b.properties.rank) || a.properties.name.localeCompare(b.properties.name));
  deduped.forEach((f, i) => { f.id = i + 1; });
  return { type: 'FeatureCollection', deduped: features.length - deduped.length, features: deduped };
}

/**
 * OpenStreetMap frequently holds one real-world place twice — a node for the POI
 * and a way for the building or area, both carrying the same name and tags.
 * Drawn straight onto a map that is two pins a few metres apart for one place.
 *
 * Collapses features that share a folded name and category and sit within
 * DEDUPE_METRES of each other, keeping whichever carries more information.
 */
const DEDUPE_METRES = 120;

function dedupe(features) {
  const keepAsIs = [];
  const groups = new Map();
  for (const f of features) {
    // Unnamed features share a generic fallback name ("ATM", "Beach", "Bus
    // stop"). Two ATMs on the same street are not a duplicate of each other, so
    // they are never collapsed - only genuinely named places are.
    if (f.properties.unnamed) { keepAsIs.push(f); continue; }
    // Keyed on kind as well as category: a bus stop named after the ferry
    // terminal it serves sits metres away and shares a category, but it is a
    // different thing and deserves its own pin. Only like-for-like collapses.
    const key = `${f.properties.cat}::${f.properties.kind}::${foldName(f.properties.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const keep = [...keepAsIs];
  for (const group of groups.values()) {
    if (group.length === 1) { keep.push(group[0]); continue; }

    const clusters = [];
    for (const f of group) {
      const near = clusters.find((c) => metres(c[0].geometry.coordinates, f.geometry.coordinates) < DEDUPE_METRES);
      if (near) near.push(f); else clusters.push([f]);
    }
    for (const cluster of clusters) {
      keep.push(cluster.reduce((best, f) => (richness(f) > richness(best) ? f : best)));
    }
  }
  return keep;
}

const richness = (f) => Object.keys(f.properties.tags || {}).length;

function foldName(s = '') {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().toLowerCase();
}

/** Equirectangular approximation - accurate enough at these distances. */
function metres(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const x = toRad(b[0] - a[0]) * Math.cos(toRad((a[1] + b[1]) / 2));
  const y = toRad(b[1] - a[1]);
  return Math.sqrt(x * x + y * y) * R;
}

/** 7 decimal places is ~1 cm - well past what OSM data warrants, but lossless here. */
function round(n) {
  return Math.round(n * 1e7) / 1e7;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST the query to each mirror in turn, returning the first genuine success.
 *
 * "Genuine" is doing real work here. Overpass mirrors fail in ways that still
 * look like HTTP 200: a `remark` field carrying a runtime error, or an empty
 * `elements` array from an instance that is up but has no data loaded. A query
 * over the whole of northern Upolu cannot legitimately match zero objects, so an
 * empty result is treated as a failed mirror and the next one is tried. Getting
 * this wrong writes a blank map that looks like a successful build.
 *
 * @param {(url: string, attempt: number) => void} [onAttempt]
 * @param {(url: string, attempt: number, message: string) => void} [onFailure]
 */
export async function runOverpass(query, endpoints, fetchImpl = fetch, onAttempt, onFailure) {
  const errors = [];
  const ATTEMPTS = 2;

  // Overpass asks that clients identify themselves. Browsers forbid setting
  // User-Agent, so only send it from Node.
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (typeof window === 'undefined') {
    headers['User-Agent'] = 'apia-map/1.0 (+https://github.com/JGCoolfella/apia)';
  }

  for (const url of endpoints) {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        onAttempt?.(url, attempt);
        const res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: new URLSearchParams({ data: query }).toString(),
        });

        const text = await res.text();
        if (!res.ok) {
          // 429 and 504 mean "busy, come back" rather than "broken".
          const busy = res.status === 429 || res.status === 504;
          throw new Error(`HTTP ${res.status} ${res.statusText}${busy ? ' (server busy)' : ''} ${snippet(text)}`);
        }

        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`response was not JSON: ${snippet(text)}`);
        }

        if (json.remark) throw new Error(`Overpass remark: ${json.remark}`);
        if (!Array.isArray(json.elements)) throw new Error('response had no elements array');
        if (json.elements.length === 0) {
          throw new Error('returned zero elements - the mirror is up but has no data for this area');
        }

        return { json, endpoint: url };
      } catch (err) {
        const message = err.message || String(err);
        errors.push(`${url} (attempt ${attempt}/${ATTEMPTS}): ${message}`);
        onFailure?.(url, attempt, message);
        if (attempt < ATTEMPTS) await sleep(3000);
      }
    }
  }

  throw new Error(`Every Overpass endpoint failed:\n  ${errors.join('\n  ')}`);
}

function snippet(text = '') {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean ? `- ${clean.slice(0, 160)}` : '';
}
