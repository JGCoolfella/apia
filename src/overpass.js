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

  features.sort((a, b) => (a.properties.rank - b.properties.rank) || a.properties.name.localeCompare(b.properties.name));
  features.forEach((f, i) => { f.id = i + 1; });
  return { type: 'FeatureCollection', features };
}

/** 7 decimal places is ~1 cm - well past what OSM data warrants, but lossless here. */
function round(n) {
  return Math.round(n * 1e7) / 1e7;
}

/** POST the query to each mirror in turn, returning the first success. */
export async function runOverpass(query, endpoints, fetchImpl = fetch, onAttempt) {
  const errors = [];
  for (const url of endpoints) {
    try {
      onAttempt?.(url);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }).toString(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const json = await res.json();
      if (!json || !Array.isArray(json.elements)) throw new Error('unexpected response shape');
      return { json, endpoint: url };
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  throw new Error(`All Overpass endpoints failed:\n  ${errors.join('\n  ')}`);
}
