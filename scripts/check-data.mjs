#!/usr/bin/env node
// Validates the generated dataset before you ship it.
//
//   npm run check
//
// Catches the failure modes that matter for a map people navigate by: points
// outside the intended area, broken or missing geometry, duplicate OSM ids,
// features with no category, and editorial blurbs that failed to find the OSM
// object they were written about.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BBOX } from '../src/config.js';
import { CATEGORIES } from '../src/classify.js';
import { joinHighlights } from '../src/format.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = (s = '') => process.stdout.write(s + '\n');

let failures = 0;
let warnings = 0;
const fail = (msg) => { failures++; out(`  FAIL  ${msg}`); };
const warn = (msg) => { warnings++; out(`  warn  ${msg}`); };
const pass = (msg) => out(`  ok    ${msg}`);

async function readJSON(rel) {
  return JSON.parse(await readFile(resolve(ROOT, rel), 'utf8'));
}

const geojson = await readJSON('public/data/apia.geojson').catch(() => null);
if (!geojson) {
  out('No dataset found at public/data/apia.geojson.');
  out('Run `npm run fetch:data` first — it pulls the Apia area from OpenStreetMap.');
  process.exit(1);
}
const meta = await readJSON('public/data/meta.json').catch(() => ({}));
const curated = await readJSON('public/data/curated.json').catch(() => null);

const features = geojson.features || [];
out(`\nDataset: ${features.length} features\n`);

// --- Geometry --------------------------------------------------------------
out('Geometry');
let badGeom = 0, outside = 0;
const pad = 0.02;
for (const f of features) {
  const c = f.geometry?.coordinates;
  if (!Array.isArray(c) || c.length !== 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
    badGeom++;
    continue;
  }
  const [lng, lat] = c;
  if (lat < BBOX.south - pad || lat > BBOX.north + pad || lng < BBOX.west - pad || lng > BBOX.east + pad) {
    outside++;
    if (outside <= 3) warn(`outside the bounding box: ${f.properties?.name} at ${lat}, ${lng}`);
  }
  // Apia is in the western hemisphere and southern latitudes; a sign flip is the
  // classic geodata bug and would put pins in the wrong ocean.
  if (lat > 0 || lng > 0) fail(`wrong hemisphere: ${f.properties?.name} at ${lat}, ${lng}`);
}
badGeom ? fail(`${badGeom} features with unusable geometry`) : pass('every feature has a finite lat/lng');
outside ? warn(`${outside} features outside the bounding box`) : pass('all points inside the target area');

// --- Identity and schema ---------------------------------------------------
out('\nSchema');
const ids = new Set();
let dupes = 0, noName = 0, noCat = 0, badCat = 0;
for (const f of features) {
  const p = f.properties || {};
  if (!p.id) { fail('feature with no id'); continue; }
  if (ids.has(p.id)) dupes++;
  ids.add(p.id);
  if (!p.name) noName++;
  if (!p.cat) noCat++;
  else if (!CATEGORIES[p.cat]) { badCat++; fail(`unknown category "${p.cat}" on ${p.name}`); }
}
dupes ? fail(`${dupes} duplicate ids`) : pass('all ids unique');
noName ? fail(`${noName} features with no name`) : pass('every feature has a name');
noCat ? fail(`${noCat} features with no category`) : pass('every feature has a category');
if (!badCat) pass('all categories are known');

// --- Category coverage -----------------------------------------------------
out('\nCoverage');
const counts = {};
for (const f of features) counts[f.properties.cat] = (counts[f.properties.cat] || 0) + 1;
for (const cat of Object.keys(CATEGORIES)) {
  const n = counts[cat] || 0;
  if (n === 0) warn(`no features in "${CATEGORIES[cat].label}" — check the Overpass selectors`);
}
for (const [cat, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  out(`        ${String(n).padStart(5)}  ${CATEGORIES[cat]?.label ?? cat}`);
}

// --- Editorial join --------------------------------------------------------
if (curated) {
  out('\nEditorial layer');
  const joined = joinHighlights(features, curated.highlights || []);
  const matchedIds = new Set(joined.keys());
  const matchedHighlights = new Set([...joined.values()].map((h) => h.id));
  const missing = (curated.highlights || []).filter((h) => !matchedHighlights.has(h.id));

  pass(`${matchedIds.size} of ${(curated.highlights || []).length} highlights matched an OSM feature`);
  for (const h of missing) {
    warn(`no OSM match for "${h.id}" (patterns: ${h.match.join(', ')}) — the blurb will not appear`);
  }
  for (const [id, h] of joined) {
    const f = features.find((x) => x.properties.id === id);
    out(`        ${h.id.padEnd(18)} -> ${f.properties.name} (${f.properties.kind})`);
  }
}

// --- Freshness -------------------------------------------------------------
out('\nFreshness');
if (meta.osm_data_timestamp) {
  const age = (Date.now() - new Date(meta.osm_data_timestamp)) / 86400000;
  out(`        OSM data as of ${meta.osm_data_timestamp} (${age.toFixed(1)} days old)`);
  if (age > 30) warn('snapshot is more than a month old — consider `npm run fetch:data`');
  else pass('snapshot is recent');
} else {
  warn('no OSM timestamp in meta.json');
}

out(`\n${failures} failure(s), ${warnings} warning(s).\n`);
process.exit(failures ? 1 : 0);
