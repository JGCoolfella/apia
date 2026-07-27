#!/usr/bin/env node
// Builds data/apia.geojson from live OpenStreetMap data via the Overpass API.
//
//   npm run fetch:data
//
// Every pin the app draws comes from this file. Nothing here invents a
// coordinate: the script asks OpenStreetMap for the Apia area and normalises
// whatever comes back. Re-run it whenever you want the map to be current, then
// commit the regenerated data/ files.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BBOX, OVERPASS_ENDPOINTS } from '../src/config.js';
import { buildQuery, toGeoJSON, runOverpass } from '../src/overpass.js';
import { CATEGORIES } from '../src/classify.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_GEOJSON = resolve(ROOT, 'public/data/apia.geojson');
const OUT_META = resolve(ROOT, 'public/data/meta.json');

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

async function main() {
  const query = buildQuery(BBOX);
  log('Overpass query:\n' + query.split('\n').map((l) => '  ' + l).join('\n'));
  log(`\nBounding box: S ${BBOX.south} W ${BBOX.west} N ${BBOX.north} E ${BBOX.east}`);
  log('Requesting... (a cold Overpass query over this area usually takes 20-90s)\n');

  const started = Date.now();
  const { json, endpoint } = await runOverpass(query, OVERPASS_ENDPOINTS, fetch, (url) =>
    log(`  -> ${url}`),
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  log(`\nGot ${json.elements.length} raw elements from ${endpoint} in ${elapsed}s.`);

  const geojson = toGeoJSON(json);
  if (geojson.features.length === 0) {
    throw new Error('Overpass returned no usable features - refusing to write an empty dataset.');
  }

  const counts = {};
  for (const f of geojson.features) {
    counts[f.properties.cat] = (counts[f.properties.cat] || 0) + 1;
  }

  const meta = {
    generated: new Date().toISOString(),
    // Overpass reports the moment the data was last synced from the OSM planet.
    osm_data_timestamp: json.osm3s?.timestamp_osm_base ?? null,
    endpoint,
    bbox: BBOX,
    feature_count: geojson.features.length,
    raw_element_count: json.elements.length,
    counts,
    source: 'OpenStreetMap contributors',
    license: 'Open Database License (ODbL) 1.0',
    license_url: 'https://opendatacommons.org/licenses/odbl/',
    attribution: '(c) OpenStreetMap contributors',
  };

  await mkdir(dirname(OUT_GEOJSON), { recursive: true });
  await writeFile(OUT_GEOJSON, JSON.stringify(geojson) + '\n');
  await writeFile(OUT_META, JSON.stringify(meta, null, 2) + '\n');

  log(`\nWrote ${geojson.features.length} features -> public/data/apia.geojson`);
  log(`OSM data timestamp: ${meta.osm_data_timestamp || 'not reported'}`);
  log('\nBy category:');
  for (const [cat, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    log(`  ${String(n).padStart(5)}  ${CATEGORIES[cat]?.label ?? cat}`);
  }
}

main().catch((err) => {
  log(`\nfetch-osm failed: ${err.message}`);
  process.exitCode = 1;
});
