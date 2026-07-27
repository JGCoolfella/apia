// Apia interactive map — application entry point.

// maplibre-gl 6 exposes named exports only. `MapLibreMap` is the library's own
// alias for `Map`, used here so the global `Map` constructor stays available.
import {
  MapLibreMap, AttributionControl, NavigationControl, GeolocateControl,
  ScaleControl, FullscreenControl, addProtocol, setWorkerUrl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre 6 runs its tile/GeoJSON processing in a worker loaded from a
// SEPARATE file, resolved relative to the library bundle at runtime. Left
// alone, that file never makes it into a Vite build: the worker request 404s,
// no source ever finishes loading, and the map renders no pins at all — while
// everything else on the page works. `?worker&url` makes Vite bundle the worker
// (with its own imports) as a real worker entry and hand back its final URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';

setWorkerUrl(maplibreWorkerUrl);

import './styles.css';
import { APIA_CENTER, DEFAULT_CENTER, DEFAULT_ZOOM, MAX_BOUNDS, IANA_TZ, STALE_SNAPSHOT_DAYS } from './config.js';
import { CATEGORIES, CATEGORY_ORDER } from './classify.js';
import { BASEMAPS, DEFAULT_BASEMAP } from './basemaps.js';
import { loadDataset, refreshFromOSM, clearCache } from './data.js';
import { buildIndex, search } from './search.js';
import {
  escapeHTML, distanceMeters, formatDistance, walkingTime, evaluateHours,
  telHref, osmLink, osmEditLink, directionsLinks, joinHighlights, currentApiaTime,
  resolveWalk,
} from './format.js';

addProtocol('pmtiles', new Protocol().tile);

const $ = (sel) => document.querySelector(sel);

const state = {
  map: null,
  all: [],            // every feature in the dataset
  byId: new Map(),
  index: [],
  meta: {},
  curated: { essentials: [], notices: [], highlights: [] },
  highlightById: new Map(),
  active: new Set(CATEGORY_ORDER),
  selectedId: null,
  userLocation: null,
  basemap: localStorage.getItem('apia-map:basemap') || DEFAULT_BASEMAP,
  dimDark: localStorage.getItem('apia-map:dim-dark') !== 'off',
  searchHighlight: -1,
  searchMatches: [],
  openNow: false,
  sortMode: 'smart',        // 'smart' | 'near' | 'az'
  walks: [],                // resolved walks (stops joined to OSM features)
  walk: null,               // active resolved walk
  walkStep: 0,
};

// Introspection hook, deliberately present in production too: it holds nothing
// that is not already on screen, and it is what lets a deployed instance be
// smoke-tested for the silent failures (worker missing, source never loading)
// that this app has actually had.
window.__apia = state;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

boot().catch((err) => {
  console.error(err);
  // The overwhelmingly likely cause is no committed snapshot plus no reachable
  // Overpass mirror, so say what to do about it rather than just failing.
  $('#loadingText').innerHTML = `
    <strong>The map could not load its places.</strong><br>
    No dataset was found at <code>data/apia.geojson</code>, and OpenStreetMap's
    Overpass API could not be reached as a fallback.<br><br>
    If you are running this yourself, build the dataset first:<br>
    <code>npm run fetch:data</code><br><br>
    <small>${escapeHTML(err.message)}</small>`;
  $('#loadingText').style.maxWidth = '32rem';
  $('#loadingText').style.textAlign = 'left';
  $('.spinner')?.remove();
});

async function boot() {
  const initial = readHash();
  if (initial.cats?.length) state.active = new Set(initial.cats);

  setLoading('Loading places…');
  const [dataset, curated] = await Promise.all([
    loadDataset(),
    fetch('data/curated.json').then((r) => r.json()).catch(() => null),
  ]);

  state.all = dataset.geojson.features;
  state.meta = dataset.meta || {};
  state.byId = new Map(state.all.map((f) => [f.properties.id, f]));
  if (curated) {
    state.curated = curated;
    state.highlightById = joinHighlights(state.all, curated.highlights);
  }
  state.index = buildIndex(state.all, aliasesFromHighlights(state.highlightById));

  // Walks resolve through the same joins: a stop is only ever a real OSM
  // object, and a walk that cannot muster two real stops is not offered.
  const featureByHighlight = new Map(
    [...state.highlightById].map(([fid, h]) => [h.id, state.byId.get(fid)]),
  );
  state.walks = (state.curated.walks || [])
    .map((w) => resolveWalk(w, featureByHighlight))
    .filter(Boolean);

  setLoading('Drawing the map…');
  initMap(initial);
  buildChips();
  wireUI();
  startClock();
  showDataAge();

  if (dataset.origin === 'live') {
    toast('Loaded live data straight from OpenStreetMap.');
  }
}

/**
 * Local and historic names for the places the editorial layer covers, keyed by
 * OSM id, so searching the name people actually use finds the right pin.
 */
function aliasesFromHighlights(highlightById) {
  const out = new Map();
  for (const [id, h] of highlightById) out.set(id, h.match || []);
  return out;
}

function setLoading(text) {
  const el = $('#loadingText');
  if (el) el.textContent = text;
}

function hideLoading() {
  const el = $('#loading');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => { el.hidden = true; }, 300);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function initMap(initial) {
  const map = new MapLibreMap({
    container: 'map',
    style: BASEMAPS[state.basemap]?.build() ?? BASEMAPS[DEFAULT_BASEMAP].build(),
    center: initial.center || DEFAULT_CENTER,
    zoom: initial.zoom ?? DEFAULT_ZOOM,
    maxBounds: MAX_BOUNDS,
    minZoom: 9,
    maxZoom: 19,
    attributionControl: false,
  });
  state.map = map;

  map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new NavigationControl({ visualizePitch: false }), 'bottom-right');

  const geolocate = new GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  });
  map.addControl(geolocate, 'bottom-right');
  geolocate.on('geolocate', (e) => {
    state.userLocation = [e.coords.longitude, e.coords.latitude];
    renderList();
    if (state.selectedId) showDetail(state.selectedId);
  });

  map.addControl(new ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
  map.addControl(new FullscreenControl(), 'bottom-right');
  map.getCanvas().setAttribute('tabindex', '0');

  // Set up on style.load, not load: the map's `load` event also waits for the
  // initial tiles, so a slow or unreachable tile server would hold the whole
  // app hostage behind the loading screen. Pins, search and the list need none
  // of that — tiles can stream in whenever they arrive.
  map.once('style.load', () => {
    addPinImages(map);
    addLayers(map);
    applyFilter();
    applyDarkDim();
    hideLoading();
    if (initial.sel && state.byId.has(initial.sel)) selectFeature(initial.sel, { fly: false });
    if (initial.walk) {
      const w = state.walks.find((x) => x.id === initial.walk);
      if (w) startWalk(w.id, { step: initial.step ?? 0, fly: !initial.center });
    }
  });

  // Belt and braces: nothing should be able to leave the loading screen up.
  setTimeout(hideLoading, 10_000);

  map.on('moveend', () => { renderList(); writeHash(); });
  map.on('click', 'poi', (e) => {
    const id = e.features?.[0]?.properties?.id;
    if (id) selectFeature(id, { fly: false });
  });
  map.on('click', 'clusters', (e) => {
    const f = e.features?.[0];
    if (!f) return;
    map.getSource('poi').getClusterExpansionZoom(f.properties.cluster_id)
      .then((zoom) => map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(zoom, 18) }))
      .catch(() => map.easeTo({ center: f.geometry.coordinates, zoom: map.getZoom() + 2 }));
  });
  map.on('click', (e) => {
    // A click on empty map closes the detail panel.
    const hits = map.queryRenderedFeatures(e.point, { layers: ['poi', 'clusters'] });
    if (hits.length === 0) closeDetail();
  });

  for (const layer of ['poi', 'clusters', 'walk-stops']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }

  // Hover tooltip: pointer devices only — on touch it would just flicker.
  if (window.matchMedia('(pointer: fine)').matches) {
    const tip = $('#mapTooltip');
    map.on('mousemove', 'poi', (e) => {
      const p = e.features?.[0]?.properties;
      if (!p?.name) { tip.hidden = true; return; }
      const hours = evaluateHours(p.hours);
      tip.innerHTML = `<strong>${escapeHTML(p.name)}</strong><span>${escapeHTML(p.kind || '')}` +
        `${hours.state === 'open' ? ' · open' : hours.state === 'closed' ? ' · closed' : ''}</span>`;
      tip.style.left = `${e.point.x}px`;
      tip.style.top = `${e.point.y}px`;
      tip.hidden = false;
    });
    map.on('mouseleave', 'poi', () => { tip.hidden = true; });
    map.on('movestart', () => { tip.hidden = true; });
  }

  map.on('click', 'walk-stops', (e) => {
    const idx = e.features?.[0]?.properties?.step;
    if (idx !== undefined && state.walk) goToWalkStep(Number(idx));
  });
}

/**
 * In dark mode the standard OSM raster tiles glare. Dim and desaturate the
 * raster layer itself (not the canvas, which would also recolour the pins).
 */
function applyDarkDim() {
  const map = state.map;
  if (!map?.getLayer('basemap')) return;
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches && state.dimDark;
  map.setPaintProperty('basemap', 'raster-saturation', dark ? -0.7 : 0);
  map.setPaintProperty('basemap', 'raster-brightness-max', dark ? 0.65 : 1);
  map.setPaintProperty('basemap', 'raster-contrast', dark ? -0.05 : 0);
}

/**
 * Category pins are drawn to a canvas at load time — no sprite sheet, no
 * network request, and the palette stays in one place in classify.js.
 */
function addPinImages(map) {
  const dpr = 2;
  for (const [cat, def] of Object.entries(CATEGORIES)) {
    const w = 30, h = 40;
    const c = document.createElement('canvas');
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);

    const cx = w / 2, cy = 14, r = 12;
    ctx.beginPath();
    ctx.moveTo(cx, h - 1.5);
    ctx.quadraticCurveTo(cx - r * 0.62, cy + r * 0.86, cx - r * 0.86, cy + r * 0.5);
    ctx.arc(cx, cy, r, Math.PI * 0.83, Math.PI * 0.17, false);
    ctx.quadraticCurveTo(cx + r * 0.62, cy + r * 0.86, cx, h - 1.5);
    ctx.closePath();

    ctx.fillStyle = def.color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, 8.4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.font = '11px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.icon, cx, cy + 0.5);

    const img = ctx.getImageData(0, 0, c.width, c.height);
    if (map.hasImage(`pin-${cat}`)) map.removeImage(`pin-${cat}`);
    map.addImage(`pin-${cat}`, img, { pixelRatio: dpr });
  }
}

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

function addLayers(map) {
  map.addSource('poi', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    cluster: true,
    clusterRadius: 46,
    clusterMaxZoom: 15,
  });

  map.addSource('selected', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: 'clusters',
    type: 'circle',
    source: 'poi',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': '#0b6fb8',
      'circle-opacity': 0.86,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
      'circle-radius': ['step', ['get', 'point_count'], 15, 20, 20, 60, 25, 150, 31],
    },
  });

  map.addLayer({
    id: 'cluster-count',
    type: 'symbol',
    source: 'poi',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Noto Sans Medium'],
      'text-size': 12,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#ffffff' },
  });

  map.addSource('walk-line', { type: 'geojson', data: EMPTY_FC });
  map.addSource('walk-stops', { type: 'geojson', data: EMPTY_FC });

  // Stop-order line for the active walk. Dashed on purpose: it connects stops
  // in sequence, it is not a routed path, and it should not look like one.
  map.addLayer({
    id: 'walk-line',
    type: 'line',
    source: 'walk-line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#0b6fb8',
      'line-width': 3.5,
      'line-opacity': 0.75,
      'line-dasharray': [0.1, 2],
    },
  });

  map.addLayer({
    id: 'walk-stops',
    type: 'circle',
    source: 'walk-stops',
    paint: {
      'circle-radius': 13,
      'circle-color': ['case', ['get', 'active'], '#0b6fb8', '#ffffff'],
      'circle-stroke-color': ['case', ['get', 'active'], '#ffffff', '#0b6fb8'],
      'circle-stroke-width': 2.5,
    },
  });

  map.addLayer({
    id: 'walk-stop-numbers',
    type: 'symbol',
    source: 'walk-stops',
    layout: {
      'text-field': ['to-string', ['+', ['get', 'step'], 1]],
      'text-font': ['Noto Sans Medium'],
      'text-size': 13,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': ['case', ['get', 'active'], '#ffffff', '#0b6fb8'] },
  });

  map.addLayer({
    id: 'selected-halo',
    type: 'circle',
    source: 'selected',
    paint: {
      'circle-radius': 20,
      'circle-color': '#0b6fb8',
      'circle-opacity': 0.18,
      'circle-stroke-color': '#0b6fb8',
      'circle-stroke-width': 2,
      'circle-stroke-opacity': 0.9,
    },
  });

  map.addLayer({
    id: 'poi',
    type: 'symbol',
    source: 'poi',
    filter: ['!', ['has', 'point_count']],
    layout: {
      'icon-image': ['concat', 'pin-', ['get', 'cat']],
      'icon-anchor': 'bottom',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.7, 16, 1],
      'icon-allow-overlap': false,
      'icon-padding': 2,
      'symbol-sort-key': ['get', 'rank'],
      'text-field': ['step', ['zoom'], '', 15, ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11.5,
      'text-anchor': 'top',
      'text-offset': [0, 0.35],
      'text-max-width': 9,
      'text-optional': true,
    },
    paint: {
      'text-color': '#25313f',
      'text-halo-color': 'rgba(255,255,255,0.92)',
      'text-halo-width': 1.6,
    },
  });
}

function switchBasemap(key) {
  if (!BASEMAPS[key]) return;
  state.basemap = key;
  localStorage.setItem('apia-map:basemap', key);
  const map = state.map;
  map.setStyle(BASEMAPS[key].build());
  map.once('styledata', () => {
    addPinImages(map);
    addLayers(map);
    applyFilter();
    applyDarkDim();
    if (state.selectedId) highlightOnMap(state.selectedId);
    if (state.walk) applyWalkToMap();
  });
}

// ---------------------------------------------------------------------------
// Filtering, list and selection
// ---------------------------------------------------------------------------

function visibleFeatures() {
  let out = state.all.filter((f) => state.active.has(f.properties.cat));
  if (state.openNow) {
    // Strictly places whose hours parse AND cover this moment. A place with no
    // usable opening_hours is excluded — "might be open" is not "open".
    out = out.filter((f) => evaluateHours(f.properties.hours).state === 'open');
  }
  return out;
}

function applyFilter() {
  const src = state.map?.getSource('poi');
  if (!src) return;
  src.setData({ type: 'FeatureCollection', features: visibleFeatures() });
  renderList();
  updateChipCounts();
  writeHash();
}

function buildChips() {
  const wrap = $('#chips');
  wrap.innerHTML = CATEGORY_ORDER.map((cat) => {
    const c = CATEGORIES[cat];
    return `<button class="chip" role="switch" data-cat="${cat}" aria-pressed="${state.active.has(cat)}" title="${escapeHTML(c.blurb)}">
      <span class="swatch" style="background:${c.color}"></span>${escapeHTML(c.label)}
      <span class="n" data-count="${cat}"></span>
    </button>`;
  }).join('');

  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const cat = btn.dataset.cat;
    if (state.active.has(cat)) state.active.delete(cat); else state.active.add(cat);
    btn.setAttribute('aria-pressed', String(state.active.has(cat)));
    applyFilter();
  });
}

function updateChipCounts() {
  const counts = {};
  for (const f of state.all) counts[f.properties.cat] = (counts[f.properties.cat] || 0) + 1;
  for (const cat of CATEGORY_ORDER) {
    const el = document.querySelector(`[data-count="${cat}"]`);
    if (el) el.textContent = counts[cat] ? counts[cat] : '';
  }
}

const LIST_LIMIT = 120;

function renderList() {
  const map = state.map;
  const list = $('#results');
  if (!map || !list) return;

  const bounds = map.getBounds();
  const centre = map.getCenter().toArray();
  const origin = state.userLocation || centre;

  const sorters = {
    smart: (a, b) => (a.f.properties.rank - b.f.properties.rank) || (a.d - b.d),
    near: (a, b) => a.d - b.d,
    az: (a, b) => a.f.properties.name.localeCompare(b.f.properties.name),
  };

  const inView = visibleFeatures()
    .filter((f) => bounds.contains(f.geometry.coordinates))
    .map((f) => ({ f, d: distanceMeters(origin, f.geometry.coordinates) }))
    .sort(sorters[state.sortMode] || sorters.smart);

  $('#listCount').textContent = inView.length
    ? `${inView.length} place${inView.length === 1 ? '' : 's'}`
    : '';
  $('#listTitle').textContent =
    state.openNow ? 'Open now, in view'
    : state.sortMode === 'near' ? (state.userLocation ? 'Nearest to you' : 'Nearest map centre')
    : 'In view';
  $('#listEmpty').hidden = inView.length > 0;

  list.innerHTML = inView.slice(0, LIST_LIMIT).map(({ f, d }) => {
    const p = f.properties;
    const cat = CATEGORIES[p.cat];
    const hours = evaluateHours(p.hours);
    const badge = hours.state === 'open'
      ? '<span class="badge open">Open</span>'
      : hours.state === 'closed' ? '<span class="badge closed">Closed</span>' : '';
    const pick = state.highlightById.has(p.id) ? '<span class="badge pick">Pick</span>' : '';
    return `<li>
      <button class="result" data-id="${escapeHTML(p.id)}" aria-current="${state.selectedId === p.id}">
        <span class="res-dot" style="background:${cat.color}"></span>
        <span class="res-body">
          <span class="res-name">${escapeHTML(p.name)}${badge}${pick}</span>
          <span class="tagline">${escapeHTML(p.kind)}${p.addr ? ' · ' + escapeHTML(p.addr) : ''}</span>
        </span>
        <span class="res-dist">${formatDistance(d)}</span>
      </button>
    </li>`;
  }).join('');

  if (inView.length > LIST_LIMIT) {
    list.insertAdjacentHTML('beforeend',
      `<li class="empty">Showing the ${LIST_LIMIT} closest of ${inView.length}. Zoom in or filter to narrow it down.</li>`);
  }
}

function selectFeature(id, { fly = true } = {}) {
  const f = state.byId.get(id);
  if (!f) return;
  state.selectedId = id;
  if (fly) {
    state.map.easeTo({
      center: f.geometry.coordinates,
      zoom: Math.max(state.map.getZoom(), 16),
      duration: prefersReducedMotion() ? 0 : 700,
    });
  }
  highlightOnMap(id);
  showDetail(id);
  renderList();
  writeHash();
  if (window.matchMedia('(max-width: 860px)').matches) setSidebar(false);
}

function highlightOnMap(id) {
  const f = state.byId.get(id);
  const src = state.map?.getSource('selected');
  if (src) src.setData({ type: 'FeatureCollection', features: f ? [f] : [] });
}

function closeDetail() {
  state.selectedId = null;
  $('#detail').hidden = true;
  highlightOnMap(null);
  renderList();
  writeHash();
}

// ---------------------------------------------------------------------------
// Guided walks
// ---------------------------------------------------------------------------

function openWalks() {
  if (!state.walks.length) {
    toast('No walks available — their stops are missing from the current dataset.');
    return;
  }
  const items = state.walks.map((w) => `
    <button class="opt" data-walk="${escapeHTML(w.id)}">
      <span aria-hidden="true">${w.icon || '🥾'}</span>
      <span>
        <strong>${escapeHTML(w.title)}</strong>
        <span>${w.stops.length} stops · ${formatDistance(w.total)} ${w.mode === 'drive' ? 'by road (as the crow flies)' : 'on foot'}</span>
        <span>${escapeHTML(w.blurb)}</span>
      </span>
    </button>`).join('');

  const dlg = openDialog('#walksDlg', 'Guided walks', `
    ${items}
    <p class="note">
      Every stop is a real OpenStreetMap object, and the dashed line on the map
      connects the stops <strong>in order</strong> — it is not turn-by-turn
      routing. Distances are straight-line between stops, so the walking
      distance on the ground is longer.
    </p>`);

  dlg.querySelectorAll('[data-walk]').forEach((btn) => {
    btn.addEventListener('click', () => { dlg.close(); startWalk(btn.dataset.walk); });
  });
}

function startWalk(id, { step = 0, fly = true } = {}) {
  const walk = state.walks.find((w) => w.id === id);
  if (!walk) return;
  state.walk = walk;
  state.walkStep = Math.min(Math.max(0, step), walk.stops.length - 1);
  closeDetail();
  applyWalkToMap();
  renderWalkPanel();
  if (fly) fitWalk();
  if (window.matchMedia('(max-width: 860px)').matches) setSidebar(false);
  writeHash();
}

function fitWalk() {
  const coords = state.walk.stops.map((s) => s.feature.geometry.coordinates);
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  state.map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: { top: 90, bottom: 180, left: 60, right: 60 }, duration: prefersReducedMotion() ? 0 : 900, maxZoom: 16 },
  );
}

function applyWalkToMap() {
  const map = state.map;
  if (!map?.getSource('walk-line')) return;
  const w = state.walk;
  if (!w) {
    map.getSource('walk-line').setData(EMPTY_FC);
    map.getSource('walk-stops').setData(EMPTY_FC);
    return;
  }
  map.getSource('walk-line').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: w.stops.map((s) => s.feature.geometry.coordinates) },
    properties: {},
  });
  map.getSource('walk-stops').setData({
    type: 'FeatureCollection',
    features: w.stops.map((s, i) => ({
      type: 'Feature',
      geometry: s.feature.geometry,
      properties: { step: i, active: i === state.walkStep },
    })),
  });
}

function goToWalkStep(i) {
  const w = state.walk;
  if (!w) return;
  state.walkStep = Math.min(Math.max(0, i), w.stops.length - 1);
  applyWalkToMap();
  renderWalkPanel();
  const stop = w.stops[state.walkStep];
  state.map.easeTo({
    center: stop.feature.geometry.coordinates,
    zoom: Math.max(state.map.getZoom(), 16),
    duration: prefersReducedMotion() ? 0 : 600,
  });
  writeHash();
}

function renderWalkPanel() {
  const w = state.walk;
  const panel = $('#walkPanel');
  if (!w) { panel.hidden = true; return; }

  const i = state.walkStep;
  const stop = w.stops[i];
  const p = stop.feature.properties;
  const legNext = i < w.legs.length
    ? `${formatDistance(w.legs[i])} to the next stop`
    : 'final stop';

  panel.innerHTML = `
    <div class="walk-head">
      <span class="walk-title">${w.icon || '🥾'} ${escapeHTML(w.title)}</span>
      <button class="icon-btn ghost" data-act="end" title="End walk"><span aria-hidden="true">✕</span><span class="sr-only">End walk</span></button>
    </div>
    <div class="walk-stop">
      <span class="walk-n">${i + 1}</span>
      <div class="walk-body">
        <strong>${escapeHTML(p.name)}</strong>
        <p>${escapeHTML(stop.note)}</p>
        <small>${escapeHTML(p.kind)} · ${escapeHTML(legNext)}</small>
      </div>
    </div>
    <div class="walk-nav">
      <button class="btn" data-act="prev" ${i === 0 ? 'disabled' : ''}>← Back</button>
      <span class="walk-progress">${i + 1} / ${w.stops.length}</span>
      <button class="btn primary" data-act="next" ${i === w.stops.length - 1 ? 'disabled' : ''}>Next →</button>
      <button class="btn" data-act="detail">Details</button>
    </div>`;
  panel.hidden = false;

  panel.querySelector('[data-act="end"]').onclick = endWalk;
  panel.querySelector('[data-act="prev"]').onclick = () => goToWalkStep(i - 1);
  panel.querySelector('[data-act="next"]').onclick = () => goToWalkStep(i + 1);
  panel.querySelector('[data-act="detail"]').onclick = () => {
    selectFeature(p.id, { fly: false });
  };
}

function endWalk() {
  state.walk = null;
  state.walkStep = 0;
  $('#walkPanel').hidden = true;
  applyWalkToMap();
  writeHash();
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function showDetail(id) {
  const f = state.byId.get(id);
  if (!f) return;
  const p = f.properties;
  const cat = CATEGORIES[p.cat];
  const hi = state.highlightById.get(p.id);
  const hours = evaluateHours(p.hours);
  const coords = f.geometry.coordinates;

  const facts = [];
  if (p.addr) facts.push(fact('📍', escapeHTML(p.addr)));
  if (p.hours) {
    facts.push(fact('🕒', `${escapeHTML(p.hours)}${hours.label ? `<span class="sub">${escapeHTML(hours.label)}</span>` : ''}`));
  }
  if (p.phone) {
    const href = telHref(p.phone);
    facts.push(fact('📞', href ? `<a href="${href}">${escapeHTML(p.phone)}</a>` : escapeHTML(p.phone)));
  }
  if (p.website) {
    facts.push(fact('🌐', `<a href="${escapeHTML(p.website)}" target="_blank" rel="noopener noreferrer">${escapeHTML(prettyUrl(p.website))}</a>`));
  }
  if (p.email) facts.push(fact('✉️', `<a href="mailto:${escapeHTML(p.email)}">${escapeHTML(p.email)}</a>`));
  if (p.cuisine) facts.push(fact('🍽️', escapeHTML(p.cuisine.replace(/;/g, ', ').replace(/_/g, ' '))));
  if (p.operator) facts.push(fact('🏢', escapeHTML(p.operator)));
  if (p.wheelchair) facts.push(fact('♿', `Wheelchair access: ${escapeHTML(p.wheelchair)}`));
  if (p.description && !hi) facts.push(fact('📝', escapeHTML(p.description)));

  if (state.userLocation) {
    const d = distanceMeters(state.userLocation, coords);
    facts.push(fact('🚶', `${formatDistance(d)} away<span class="sub">${escapeHTML(walkingTime(d))}</span>`));
  }

  const dirs = directionsLinks(coords, p.name)
    .map((l) => `<a class="btn" href="${l.url}" target="_blank" rel="noopener noreferrer">${l.label}</a>`)
    .join('');

  $('#detail').innerHTML = `
    <div class="detail-head">
      <button class="icon-btn ghost detail-close" data-act="close" title="Close"><span aria-hidden="true">✕</span><span class="sr-only">Close</span></button>
      <h2>${escapeHTML(p.name)}</h2>
      ${p.name_sm ? `<div class="detail-sm">${escapeHTML(p.name_sm)}</div>` : ''}
      <div class="detail-kind">
        <span class="res-dot" style="background:${cat.color}"></span>
        <span>${escapeHTML(p.kind)} · ${escapeHTML(cat.label)}</span>
        ${hours.state === 'open' ? '<span class="badge open">Open now</span>' : ''}
        ${hours.state === 'closed' ? '<span class="badge closed">Closed now</span>' : ''}
      </div>
    </div>
    <div class="detail-body">
      ${hi?.blurb ? `<p class="blurb">${escapeHTML(hi.blurb)}</p>` : ''}
      ${hi?.tip ? `<div class="tip"><b>Local tip</b>${escapeHTML(hi.tip)}</div>` : ''}
      ${facts.length ? `<div class="facts">${facts.join('')}</div>` : ''}
      <div class="actions">
        <button class="btn primary" data-act="centre">Centre map</button>
        <button class="btn" data-act="copy">Copy coordinates</button>
        <button class="btn" data-act="share">Share</button>
      </div>
      <div class="actions">${dirs}</div>
      <div class="provenance">
        <span>${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}</span>
        <a href="${osmLink(p)}" target="_blank" rel="noopener noreferrer">View on OpenStreetMap</a>
        <a href="${osmEditLink(p)}" target="_blank" rel="noopener noreferrer">Something wrong? Fix it</a>
      </div>
    </div>`;
  $('#detail').hidden = false;
}

function fact(icon, valueHTML) {
  return `<div class="fact"><span class="k" aria-hidden="true">${icon}</span><span class="v">${valueHTML}</span></div>`;
}

function prettyUrl(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function wireUI() {
  $('#results').addEventListener('click', (e) => {
    const btn = e.target.closest('.result');
    if (btn) selectFeature(btn.dataset.id);
  });

  $('#detail').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const f = state.byId.get(state.selectedId);
    if (btn.dataset.act === 'close') closeDetail();
    if (btn.dataset.act === 'centre' && f) {
      state.map.easeTo({ center: f.geometry.coordinates, zoom: Math.max(state.map.getZoom(), 17) });
    }
    if (btn.dataset.act === 'copy' && f) {
      const [lng, lat] = f.geometry.coordinates;
      copy(`${lat.toFixed(6)}, ${lng.toFixed(6)}`, 'Coordinates copied.');
    }
    if (btn.dataset.act === 'share' && f) sharePlace(f);
  });

  $('#sidebarToggle').addEventListener('click', () => {
    setSidebar($('#app').dataset.sidebar !== 'open');
  });

  $('#filterReset').addEventListener('click', () => {
    state.active = new Set(CATEGORY_ORDER);
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'true'));
    applyFilter();
  });

  wireSearch();

  $('#guideBtn').addEventListener('click', openGuide);
  $('#layersBtn').addEventListener('click', openLayers);
  $('#dataBtn').addEventListener('click', openData);
  $('#walksBtn').addEventListener('click', openWalks);

  $('#openNowChip').addEventListener('click', () => {
    state.openNow = !state.openNow;
    $('#openNowChip').setAttribute('aria-pressed', String(state.openNow));
    applyFilter();
    if (state.openNow) {
      const n = visibleFeatures().length;
      toast(`${n.toLocaleString()} place${n === 1 ? '' : 's'} with hours saying open right now. Places with no usable hours are hidden.`);
    }
  });

  $('#sortMode').addEventListener('change', (e) => {
    state.sortMode = e.target.value;
    if (state.sortMode === 'near' && !state.userLocation) {
      // Nearest-to-you needs a location; nudge the geolocate control.
      document.querySelector('.maplibregl-ctrl-geolocate')?.click();
    }
    renderList();
  });

  // Connection status: the map keeps working offline (cached tiles + local
  // data), but the user deserves to know which world they are in.
  const netDot = $('#netDot');
  const setNet = () => {
    const off = !navigator.onLine;
    netDot.hidden = !off;
    netDot.textContent = 'offline';
    if (off) toast('You are offline. Cached areas and all place data still work.');
  };
  window.addEventListener('online', () => { netDot.hidden = true; toast('Back online.'); });
  window.addEventListener('offline', setNet);
  setNet();

  document.addEventListener('keydown', (e) => {
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'SELECT') {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); return; }
    if (e.key === '?') { openHelp(); return; }
    if (state.walk && !document.querySelector('dialog[open]')) {
      if (e.key === 'ArrowRight' || e.key === 'n') { goToWalkStep(state.walkStep + 1); return; }
      if (e.key === 'ArrowLeft' || e.key === 'p') { goToWalkStep(state.walkStep - 1); return; }
    }
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
      if (state.selectedId) closeDetail();
      else if (state.walk) endWalk();
    }
  });

  window.addEventListener('hashchange', () => {
    const h = readHash();
    if (h.sel && h.sel !== state.selectedId && state.byId.has(h.sel)) selectFeature(h.sel);
  });
}

function setSidebar(open) {
  $('#app').dataset.sidebar = open ? 'open' : 'closed';
  $('#sidebarToggle').setAttribute('aria-expanded', String(open));
  setTimeout(() => state.map?.resize(), 240);
}

function wireSearch() {
  const input = $('#searchInput');
  const list = $('#searchResults');
  const clear = $('#searchClear');
  const combo = input.closest('.search');

  const close = () => {
    list.hidden = true;
    combo.setAttribute('aria-expanded', 'false');
    state.searchHighlight = -1;
  };

  // One-tap searches for the things people actually stop and look for.
  const QUICKS = [
    ['💵', 'atm'], ['⛽', 'petrol'], ['💊', 'pharmacy'], ['🚌', 'bus stop'],
    ['☕', 'cafe'], ['🏧', 'bank'], ['🏥', 'hospital'], ['🛒', 'supermarket'],
  ];

  const showQuicks = () => {
    list.innerHTML = `<li class="search-quicks" role="presentation">
      ${QUICKS.map(([icon, q]) =>
        `<button class="chip" data-q="${escapeHTML(q)}">${icon} ${escapeHTML(q)}</button>`).join('')}
      </li>
      <li class="search-empty" role="presentation">Type to search ${state.all.length.toLocaleString()} places — English or Samoan spelling both work.</li>`;
    list.hidden = false;
    combo.setAttribute('aria-expanded', 'true');
  };

  const run = () => {
    const q = input.value.trim();
    clear.hidden = q.length === 0;
    if (q.length === 0) { showQuicks(); return; }
    if (q.length < 2) { close(); return; }

    const origin = state.userLocation || state.map?.getCenter().toArray() || APIA_CENTER;
    state.searchMatches = search(state.index, q, 25);
    state.searchHighlight = -1;

    if (state.searchMatches.length === 0) {
      list.innerHTML = `<li class="search-empty">Nothing matching “${escapeHTML(q)}”. This map only holds what OpenStreetMap knows about the Apia area — try a shorter or different word.</li>`;
    } else {
      list.innerHTML = state.searchMatches.map((f, i) => {
        const p = f.properties;
        const c = CATEGORIES[p.cat];
        const d = formatDistance(distanceMeters(origin, f.geometry.coordinates));
        return `<li role="option" id="sr-${i}" aria-selected="false">
          <button data-id="${escapeHTML(p.id)}" data-i="${i}">
            <span class="res-dot" style="background:${c.color}"></span>
            <span class="res-body">
              <span class="res-name">${escapeHTML(p.name)}</span>
              <span class="res-meta">${escapeHTML(p.kind)}${p.addr ? ' · ' + escapeHTML(p.addr) : ''}</span>
            </span>
            <span class="res-dist">${d}</span>
          </button></li>`;
      }).join('');
    }
    list.hidden = false;
    combo.setAttribute('aria-expanded', 'true');
  };

  input.addEventListener('input', run);
  input.addEventListener('focus', run);

  list.addEventListener('click', (e) => {
    const quick = e.target.closest('button[data-q]');
    if (quick) {
      input.value = quick.dataset.q;
      input.focus();
      run();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const n = state.searchMatches.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!n) return;
      state.searchHighlight = (state.searchHighlight + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      list.querySelectorAll('[role="option"]').forEach((li, i) => {
        li.setAttribute('aria-selected', String(i === state.searchHighlight));
      });
      input.setAttribute('aria-activedescendant', `sr-${state.searchHighlight}`);
      list.querySelectorAll('[role="option"]')[state.searchHighlight]
        ?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = state.searchMatches[state.searchHighlight >= 0 ? state.searchHighlight : 0];
      if (pick) { selectFeature(pick.properties.id); input.blur(); close(); }
    } else if (e.key === 'Escape') {
      close();
      input.blur();
    }
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    selectFeature(btn.dataset.id);
    close();
    input.blur();
  });

  clear.addEventListener('click', () => { input.value = ''; clear.hidden = true; close(); input.focus(); });

  document.addEventListener('click', (e) => {
    if (!combo.contains(e.target)) close();
  });
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function openDialog(sel, title, bodyHTML) {
  const dlg = $(sel);
  dlg.innerHTML = `
    <div class="dlg-head">
      <h2>${escapeHTML(title)}</h2>
      <button class="icon-btn ghost" data-close title="Close"><span aria-hidden="true">✕</span><span class="sr-only">Close</span></button>
    </div>
    <div class="dlg-body">${bodyHTML}</div>`;
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
  return dlg;
}

function srcList(sources = []) {
  if (!sources.length) return '';
  return `<div class="src">${sources.map((s) =>
    `<a href="${escapeHTML(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(s.label)} ↗</a>`).join('')}</div>`;
}

function openGuide() {
  const c = state.curated;
  const notices = (c.notices || []).map((n) => `
    <div class="notice">
      <h3>⚠️ ${escapeHTML(n.title)}</h3>
      <p>${escapeHTML(n.body)}</p>
      ${srcList(n.sources)}
    </div>`).join('');

  const items = (c.essentials || []).map((e) => `
    <div class="guide-item">
      <div class="gi" aria-hidden="true">${e.icon || '•'}</div>
      <div>
        <h3>${escapeHTML(e.title)}</h3>
        <p>${escapeHTML(e.body)}</p>
        ${srcList(e.sources)}
      </div>
    </div>`).join('');

  openDialog('#guideDlg', 'Know before you go', `
    ${notices}
    ${items}
    <p class="note" style="margin-top:14px">
      Practical details were last checked on <strong>${escapeHTML(c.checked || 'unknown')}</strong>.
      Schedules, fares and opening hours in Samoa change without much notice — treat this as orientation,
      and confirm anything time-critical with the operator or an official source before you rely on it.
    </p>`);
}

function openLayers() {
  const opts = Object.entries(BASEMAPS).map(([key, b]) => `
    <button class="opt" data-basemap="${key}" aria-pressed="${state.basemap === key}">
      <span aria-hidden="true">${b.kind === 'vector' ? '🧩' : '🗺️'}</span>
      <span><strong>${escapeHTML(b.label)}</strong><span>${escapeHTML(b.hint)}</span></span>
    </button>`).join('');

  const dlg = openDialog('#layersDlg', 'Basemap', `
    ${opts}
    <button class="opt" data-toggle-dim aria-pressed="${state.dimDark}">
      <span aria-hidden="true">🌙</span>
      <span><strong>Dim the map in dark mode</strong>
      <span>Desaturates and darkens the raster tiles when your system is in dark mode. Pins and labels are unaffected.</span></span>
    </button>
    <p class="note">
      Streets and Terrain pull raster tiles from public tile servers, which is fine for personal use
      but not for a busy public site. Vector uses a Protomaps <code>.pmtiles</code> file you host
      yourself — no API key, no rate limit, and it keeps working offline. See
      <code>scripts/fetch-basemap.sh</code> in the repository.
    </p>`);

  dlg.querySelectorAll('[data-basemap]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchBasemap(btn.dataset.basemap);
      dlg.close();
    });
  });

  dlg.querySelector('[data-toggle-dim]').addEventListener('click', (e) => {
    state.dimDark = !state.dimDark;
    localStorage.setItem('apia-map:dim-dark', state.dimDark ? 'on' : 'off');
    e.currentTarget.setAttribute('aria-pressed', String(state.dimDark));
    applyDarkDim();
  });
}

function openData() {
  const m = state.meta || {};
  const origin = {
    snapshot: 'Committed snapshot in <code>data/apia.geojson</code>',
    cache: 'Cached in this browser from an earlier refresh',
    live: 'Fetched live from the Overpass API',
  }[m.origin] || 'Unknown';

  // Overpass mirrors replicate independently and some fall a long way behind.
  // If the data underneath this map is old, say so rather than let it pass as
  // current — that is the whole difference between a map and a guess.
  const ageDays = m.osm_data_timestamp
    ? (Date.now() - new Date(m.osm_data_timestamp)) / 86_400_000
    : null;
  const staleNotice = ageDays !== null && ageDays > STALE_SNAPSHOT_DAYS
    ? `<div class="notice"><h3>⚠️ This data is ${Math.round(ageDays)} days old</h3>
       <p>The snapshot behind this map is well behind OpenStreetMap. Places that
       have opened, closed or moved since then will be wrong. Use
       <strong>Refresh from OpenStreetMap</strong> below to pull current data.</p></div>`
    : '';

  const dlg = openDialog('#dataDlg', 'Where this map comes from', `
    ${staleNotice}
    <dl class="kv">
      <dt>Places loaded</dt><dd>${(m.feature_count ?? state.all.length).toLocaleString()}</dd>
      <dt>Source</dt><dd>${origin}</dd>
      <dt>Snapshot built</dt><dd>${m.generated ? escapeHTML(new Date(m.generated).toLocaleString()) : '—'}</dd>
      <dt>OSM data as of</dt><dd>${m.osm_data_timestamp ? escapeHTML(new Date(m.osm_data_timestamp).toLocaleString()) : '—'}</dd>
      <dt>Area covered</dt><dd>${m.bbox ? `${m.bbox.south}, ${m.bbox.west} → ${m.bbox.north}, ${m.bbox.east}` : '—'}</dd>
      <dt>Licence</dt><dd>Map data © OpenStreetMap contributors, <a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noopener noreferrer">ODbL 1.0</a></dd>
    </dl>
    <div class="actions">
      <button class="btn primary" data-act="refresh">Refresh from OpenStreetMap</button>
      <button class="btn" data-act="clear">Clear cached data</button>
    </div>
    <p class="note">
      Every marker on this map is an OpenStreetMap object — nothing is hand-placed. If something is
      wrong or missing, the fix belongs in OSM itself, and the “Something wrong? Fix it” link on each
      place opens that object in the OSM editor. A refresh queries the Overpass API directly from your
      browser and can take a minute over this area.
    </p>
    <p id="refreshStatus" class="note" hidden></p>`);

  dlg.querySelector('[data-act="refresh"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const status = dlg.querySelector('#refreshStatus');
    btn.disabled = true;
    status.hidden = false;
    status.textContent = 'Contacting Overpass…';
    try {
      const ds = await refreshFromOSM((msg) => { status.textContent = msg; });
      state.all = ds.geojson.features;
      state.meta = ds.meta;
      state.byId = new Map(state.all.map((f) => [f.properties.id, f]));
      state.highlightById = joinHighlights(state.all, state.curated.highlights);
      state.index = buildIndex(state.all, aliasesFromHighlights(state.highlightById));
      const fbh = new Map([...state.highlightById].map(([fid, h]) => [h.id, state.byId.get(fid)]));
      state.walks = (state.curated.walks || []).map((w) => resolveWalk(w, fbh)).filter(Boolean);
      if (state.walk) endWalk();
      applyFilter();
      showDataAge();
      dlg.close();
      toast(`Refreshed — ${state.all.length.toLocaleString()} places from OpenStreetMap.`);
    } catch (err) {
      status.textContent = `Refresh failed: ${err.message}`;
      btn.disabled = false;
    }
  });

  dlg.querySelector('[data-act="clear"]').addEventListener('click', () => {
    clearCache();
    toast('Cached data cleared. Reload to pull it again.');
  });
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

function showDataAge() {
  const el = $('#dataAge');
  const ts = state.meta?.osm_data_timestamp;
  if (!el || !ts) return;
  const days = (Date.now() - new Date(ts)) / 86_400_000;
  el.textContent = days < 1.5 ? 'data: today'
    : days < 30 ? `data: ${Math.round(days)}d old`
    : `data: ${Math.round(days)} days old ⚠`;
  el.title = `OpenStreetMap snapshot taken ${new Date(ts).toLocaleString()}. Open the 🛰️ panel for details or to refresh.`;
}

function openHelp() {
  openDialog('#helpDlg', 'Keyboard shortcuts', `
    <dl class="kv">
      <dt><kbd>/</kbd></dt><dd>Focus search</dd>
      <dt><kbd>↑</kbd> <kbd>↓</kbd> <kbd>Enter</kbd></dt><dd>Move through and pick search results</dd>
      <dt><kbd>Esc</kbd></dt><dd>Close panels, end a walk</dd>
      <dt><kbd>→</kbd> / <kbd>←</kbd></dt><dd>Next / previous walk stop</dd>
      <dt><kbd>?</kbd></dt><dd>This help</dd>
      <dt>Arrow keys, <kbd>+</kbd> <kbd>−</kbd></dt><dd>Pan and zoom the map when it has focus</dd>
    </dl>`);
}

function startClock() {
  const el = $('#clock');
  const tick = () => { el.textContent = `Apia ${currentApiaTime()}`; };
  tick();
  setInterval(tick, 20000);
  el.title = `Local time in Apia — ${IANA_TZ}, UTC+13 all year`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

async function copy(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    toast(text);
  }
}

async function sharePlace(f) {
  const url = new URL(location.href);
  url.hash = hashString({ sel: f.properties.id });
  const data = { title: f.properties.name, text: `${f.properties.name} — Apia, Samoa`, url: url.toString() };
  if (navigator.share) {
    try { await navigator.share(data); return; } catch { /* user cancelled */ }
  }
  copy(url.toString(), 'Link copied.');
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// --- URL state -------------------------------------------------------------

function hashString({ sel } = {}) {
  const map = state.map;
  const parts = [];
  if (map) {
    const c = map.getCenter();
    parts.push(`map=${map.getZoom().toFixed(2)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`);
  }
  const id = sel ?? state.selectedId;
  if (id) parts.push(`sel=${id}`);
  if (state.active.size !== CATEGORY_ORDER.length) parts.push(`cat=${[...state.active].join(',')}`);
  if (state.walk) parts.push(`walk=${state.walk.id}&step=${state.walkStep}`);
  return `#${parts.join('&')}`;
}

let hashTimer;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    history.replaceState(null, '', hashString());
  }, 250);
}

function readHash() {
  const out = {};
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return out;
  for (const part of raw.split('&')) {
    const [k, v] = part.split('=');
    if (k === 'map' && v) {
      const [z, lat, lng] = v.split('/').map(Number);
      if ([z, lat, lng].every(Number.isFinite)) { out.zoom = z; out.center = [lng, lat]; }
    }
    if (k === 'sel' && v) out.sel = v;
    if (k === 'cat' && v) out.cats = v.split(',').filter((c) => CATEGORIES[c]);
    if (k === 'walk' && v) out.walk = v;
    if (k === 'step' && v) out.step = Number(v) || 0;
  }
  return out;
}

// Offline support: the service worker is only registered in production builds.
if ('serviceWorker' in navigator && import.meta.env?.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  });
}
