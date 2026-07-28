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
import { BASEMAPS, DEFAULT_BASEMAP, probeVectorBasemap } from './basemaps.js';
import { loadDataset, refreshFromOSM, clearCache } from './data.js';
import { buildIndex, search, matchSegments } from './search.js';
import { CATEGORY_ICONS, svgIcon } from './icons.js';
import {
  resolvePhotosBatch, resolveArticle, photosNear, commonsUrls, clearMediaCache,
  classifyPhotos,
} from './photos.js';
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
  darkMap: window.matchMedia('(prefers-color-scheme: dark)').matches,
  measure: null,            // { pts: [[lng,lat],...], done: boolean } while measuring
  dimDark: localStorage.getItem('apia-map:dim-dark') !== 'off',
  searchHighlight: -1,
  searchMatches: [],
  openNow: false,
  sortMode: 'smart',        // 'smart' | 'near' | 'az'
  walks: [],                // resolved walks (stops joined to OSM features)
  walk: null,               // active resolved walk
  walkStep: 0,
  photoByQid: new Map(),    // wikidata qid -> [commons file names]
  photoShots: [],           // nearby photographs currently dotted on the map
  lightbox: null,           // { items, index }
  pitched: false,
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

  // Prefer the self-hosted vector basemap whenever this deployment carries the
  // archive — unless the user has explicitly picked something else. A cheap
  // 2-byte probe decides; a checkout without the archive falls back to raster.
  if (!localStorage.getItem('apia-map:basemap') && await probeVectorBasemap()) {
    state.basemap = 'vector';
  }

  setLoading('Drawing the map…');
  initMap(initial);
  buildChips();
  wireUI();
  startClock();
  showDataAge();

  if (dataset.origin === 'live') {
    toast('Loaded live data straight from OpenStreetMap.');
  }

  prefetchPhotos();
}

/**
 * One batched Wikidata call resolves photographs for every linked place on the
 * map, which is what makes thumbnails in the list affordable. Deliberately not
 * awaited by boot: the map is fully usable without a single picture, and on a
 * bad connection in Samoa it may never complete.
 */
async function prefetchPhotos() {
  const qids = state.all.map((f) => f.properties.wikidata).filter(Boolean);
  if (!qids.length) return;
  try {
    const map = await resolvePhotosBatch(qids);
    if (!map.size) return;
    state.photoByQid = map;
    renderList();
    if (state.selectedId) showDetail(state.selectedId);
  } catch { /* imagery is an enhancement, never a requirement */ }
}

/** First Commons thumbnail for a feature, if its own record has one. */
function thumbFor(props, width = 160) {
  const files = props.wikidata && state.photoByQid.get(props.wikidata);
  return files?.length ? commonsUrls(files[0], width).thumb : null;
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
    style: (BASEMAPS[state.basemap] ?? BASEMAPS[DEFAULT_BASEMAP]).build(state.darkMap),
    center: initial.center || DEFAULT_CENTER,
    zoom: initial.zoom ?? DEFAULT_ZOOM,
    maxBounds: MAX_BOUNDS,
    minZoom: 8,   // both islands fit in one view
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

  // A 3D tilt toggle, which on a harbour town with hills behind it genuinely
  // helps you read the terrain rather than being decoration — and a measuring
  // tape, because "how far is that really?" is the question a paper map
  // answers with a thumb and this one can answer properly.
  map.addControl({
    onAdd() {
      const el = document.createElement('div');
      el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      el.innerHTML = `
        <button type="button" id="pitchBtn" title="Tilt the map (3D)" aria-pressed="false">3D</button>
        <button type="button" id="measureBtn" title="Measure distances (click points, double-click to finish, Esc to clear)" aria-pressed="false">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M20.7 6.4 17.6 3.3a1 1 0 0 0-1.4 0L3.3 16.2a1 1 0 0 0 0 1.4l3.1 3.1a1 1 0 0 0 1.4 0L20.7 7.8a1 1 0 0 0 0-1.4zM7.1 18.6 5.4 16.9l1.4-1.4 1.1 1.1 1.05-1.06-1.1-1.1 1.4-1.4 1.1 1.1L11.4 13l-1.1-1.1 1.4-1.4 1.1 1.1 1.06-1.05-1.1-1.1 1.4-1.4 1.1 1.1 1.4-1.4 1.7 1.7z"/></svg>
          <span class="sr-only">Measure distances</span>
        </button>`;
      el.querySelector('#pitchBtn').addEventListener('click', togglePitch);
      el.querySelector('#measureBtn').addEventListener('click', toggleMeasure);
      return el;
    },
    onRemove() {},
  }, 'bottom-right');

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
    if (shouldPlayIntro(initial)) introFlyover();
    maybeShowWelcome(initial);
  });

  // Belt and braces: nothing should be able to leave the loading screen up.
  setTimeout(hideLoading, 10_000);

  map.on('moveend', () => { renderList(); writeHash(); });
  map.on('click', 'poi', (e) => {
    if (state.measure && !state.measure.done) return; // the tape owns clicks
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
    if (state.measure && !state.measure.done) {
      state.measure.pts.push([e.lngLat.lng, e.lngLat.lat]);
      renderMeasure();
      return;
    }
    // A click on empty map closes the detail panel.
    const hits = map.queryRenderedFeatures(e.point, { layers: ['poi', 'clusters'] });
    if (hits.length === 0) closeDetail();
  });
  map.on('dblclick', (e) => {
    if (state.measure && !state.measure.done) {
      e.preventDefault();
      state.measure.done = true;   // freeze the tape; Esc or the button clears it
      renderMeasure();
    }
  });

  map.on('click', 'photo-dots', (e) => {
    const i = e.features?.[0]?.properties?.i;
    if (i === undefined || !state.photoShots?.length) return;
    openLightbox(state.photoShots.map((s) => ({
      full: s.full, page: s.page, caption: s.title, artist: s.artist, licence: s.licence,
    })), Number(i));
  });

  for (const layer of ['poi', 'clusters', 'walk-stops', 'photo-dots']) {
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

  // "What's near here?" - right-click on desktop, long-press on touch. Answers
  // the question a paper map cannot: standing at an arbitrary point, what is
  // around me?
  map.on('contextmenu', (e) => {
    e.preventDefault?.();
    showNearby([e.lngLat.lng, e.lngLat.lat]);
  });
  let pressTimer = null;
  map.on('touchstart', (e) => {
    if (e.points?.length !== 1) return;
    const at = e.lngLat;
    pressTimer = setTimeout(() => showNearby([at.lng, at.lat]), 600);
  });
  for (const ev of ['touchend', 'touchcancel', 'touchmove', 'movestart']) {
    map.on(ev, () => { clearTimeout(pressTimer); });
  }
}

function hoverFeature(id) {
  const src = state.map?.getSource('hovered');
  if (!src) return;
  const f = id ? state.byId.get(id) : null;
  src.setData(f ? { type: 'FeatureCollection', features: [f] } : EMPTY_FC);
}

/** List the closest places to an arbitrary point, in the detail panel. */
function showNearby(coords) {
  const nearest = visibleFeatures()
    .map((f) => ({ f, d: distanceMeters(coords, f.geometry.coordinates) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 7);
  if (!nearest.length) return;

  state.selectedId = null;
  highlightOnMap(null);

  const rows = nearest.map(({ f, d }) => {
    const p = f.properties;
    const c = CATEGORIES[p.cat];
    return `<button class="result" data-id="${escapeHTML(p.id)}">
      ${catBubble(p.cat)}
      <span class="res-body">
        <span class="res-name">${escapeHTML(p.name)}</span>
        <span class="tagline">${escapeHTML(p.kind)}</span>
      </span>
      <span class="res-dist">${formatDistance(d)}<br><small>${escapeHTML(walkingTime(d).replace('about ', '~'))}</small></span>
    </button>`;
  }).join('');

  $('#detail').innerHTML = `
    <div class="detail-head">
      <button class="icon-btn ghost detail-close" data-act="close" title="Close"><span aria-hidden="true">✕</span><span class="sr-only">Close</span></button>
      <h2>Near this point</h2>
      <div class="detail-kind"><span>${coords[1].toFixed(5)}, ${coords[0].toFixed(5)} · closest of what's currently shown</span></div>
    </div>
    <div class="detail-body nearby-list">${rows}</div>`;
  $('#detail').hidden = false;

  $('#detail').querySelectorAll('.result[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => selectFeature(btn.dataset.id));
    btn.addEventListener('mouseenter', () => hoverFeature(btn.dataset.id));
    btn.addEventListener('mouseleave', () => hoverFeature(null));
  });
}

const WELCOME_KEY = 'apia-map:welcomed';

/**
 * A one-time orientation card. Features nobody finds are features that do not
 * exist — the walks, the open-now filter and right-click-for-nearby are only
 * real if a first-time visitor learns they are there. Shown once, dismissed
 * forever, and suppressed on deep links (that visitor already knows the app).
 */
function maybeShowWelcome(initial) {
  if (initial.center || initial.sel || initial.walk) return;
  try {
    if (localStorage.getItem(WELCOME_KEY)) return;
  } catch { return; }

  const card = document.createElement('div');
  card.id = 'welcome';
  card.className = 'welcome';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Welcome');
  card.innerHTML = `
    <h2>Tālofa — welcome to Apia</h2>
    <p>Every place on this map is real, live OpenStreetMap data for the whole of
       Sāmoa — ${state.all.length.toLocaleString()} places, refreshed weekly.</p>
    <ul>
      <li>${svgIcon(CATEGORY_ICONS.sights)} <b>Guided walks</b> — the boot icon up top strings the best of Apia together, step by step</li>
      <li>${svgIcon(CATEGORY_ICONS.food)} <b>Open now</b> — filter to places whose hours say they're open this minute</li>
      <li>${svgIcon(CATEGORY_ICONS.places)} <b>Right-click anywhere</b> (long-press on a phone) to see what's nearest that point</li>
    </ul>
    <div class="welcome-actions">
      <button class="btn primary" data-w="explore">Explore the map</button>
      <button class="btn" data-w="walk">Start the waterfront walk</button>
    </div>
    <small>Works offline once loaded · free &amp; open data</small>`;
  $('#map').appendChild(card);

  const dismiss = (thenWalk) => {
    try { localStorage.setItem(WELCOME_KEY, String(Date.now())); } catch { /* ok */ }
    card.remove();
    if (thenWalk) {
      const w = state.walks[0];
      if (w) startWalk(w.id);
    }
  };
  card.querySelector('[data-w="explore"]').addEventListener('click', () => dismiss(false));
  card.querySelector('[data-w="walk"]').addEventListener('click', () => dismiss(true));
}

const INTRO_KEY = 'apia-map:seen-intro';

/**
 * The arrival flourish is a first-impression, not a ritual. It plays once per
 * browser and then never again — a three-second animation on every single
 * visit is an obstacle, however pretty it is the first time.
 *
 * It is also suppressed whenever the link already carried an intention (a view,
 * a place, a walk), and whenever the user has asked for reduced motion.
 */
function shouldPlayIntro(initial) {
  if (initial.center || initial.sel || initial.walk) return false;
  if (prefersReducedMotion()) return false;
  try {
    if (localStorage.getItem(INTRO_KEY)) return false;
    localStorage.setItem(INTRO_KEY, String(Date.now()));
  } catch { /* private mode: play it, harmless */ }
  return true;
}

/**
 * Opening move: start high and wide over Upolu, then settle into Apia with a
 * slight tilt. Costs nothing (the same tiles load either way) and gives the map
 * a sense of place before the user touches anything. Any interaction aborts it
 * immediately — an animation you cannot interrupt is an obstacle, not a
 * flourish.
 */
function introFlyover() {
  const map = state.map;
  map.jumpTo({ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM - 2.4, pitch: 42, bearing: -14 });

  const abort = () => {
    map.stop();
    // Snap, do not ease. The user is already scrolling or dragging, and
    // MapLibre's own gesture animation competes with an easeTo — which left
    // the camera stranded at a couple of degrees of tilt forever. At this
    // point the tilt is incidental; handing control over cleanly is the goal.
    map.setPitch(0);
    map.setBearing(0);
    off();
  };
  const off = () => {
    for (const ev of ['mousedown', 'wheel', 'touchstart', 'keydown']) map.off(ev, abort);
  };
  for (const ev of ['mousedown', 'wheel', 'touchstart', 'keydown']) map.once(ev, abort);

  map.easeTo({
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    pitch: 0,
    bearing: 0,
    duration: 3200,
    easing: (t) => 1 - Math.pow(1 - t, 3),
  });
  map.once('moveend', off);
}

/**
 * In dark mode the standard OSM raster tiles glare. Dim and desaturate the
 * raster layer itself (not the canvas, which would also recolour the pins).
 */
// ---------------------------------------------------------------------------
// Measuring tape
// ---------------------------------------------------------------------------

function toggleMeasure() {
  if (state.measure) { endMeasure(); return; }
  state.measure = { pts: [], done: false };
  $('#measureBtn')?.setAttribute('aria-pressed', 'true');
  $('#measureBtn')?.classList.add('on');
  state.map.getCanvas().style.cursor = 'crosshair';
  renderMeasure();
  toast('Measuring: click points on the map, double-click to finish, Esc to clear.');
}

function endMeasure() {
  state.measure = null;
  $('#measureBtn')?.setAttribute('aria-pressed', 'false');
  $('#measureBtn')?.classList.remove('on');
  state.map.getCanvas().style.cursor = '';
  state.map.getSource('measure')?.setData(EMPTY_FC);
  const chip = $('#measureChip');
  if (chip) chip.hidden = true;
}

function renderMeasure() {
  const m = state.measure;
  const src = state.map.getSource('measure');
  if (!m || !src) return;

  const features = m.pts.map((p, i) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { i },
  }));
  if (m.pts.length >= 2) {
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: m.pts }, properties: {} });
  }
  src.setData({ type: 'FeatureCollection', features });

  let total = 0;
  for (let i = 1; i < m.pts.length; i++) total += distanceMeters(m.pts[i - 1], m.pts[i]);

  let chip = $('#measureChip');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'measureChip';
    chip.className = 'measure-chip';
    $('#map').appendChild(chip);
  }
  chip.hidden = false;
  chip.innerHTML = m.pts.length === 0
    ? 'Click the map to start measuring'
    : `<strong>${formatDistance(total)}</strong>
       <span>${escapeHTML(walkingTime(total))}</span>
       <span class="mc-hint">${m.done ? 'Esc or the ruler button clears' : 'double-click to finish'}</span>`;
}

function togglePitch() {
  state.pitched = !state.pitched;
  const btn = $('#pitchBtn');
  btn?.setAttribute('aria-pressed', String(state.pitched));
  btn?.classList.toggle('on', state.pitched);
  state.map.easeTo({
    pitch: state.pitched ? 55 : 0,
    duration: prefersReducedMotion() ? 0 : 700,
  });
}

function applyDarkDim() {
  const map = state.map;
  if (!map?.getLayer('basemap')) return;
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches && state.dimDark;
  map.setPaintProperty('basemap', 'raster-saturation', dark ? -0.7 : 0);
  map.setPaintProperty('basemap', 'raster-brightness-max', dark ? 0.65 : 1);
  map.setPaintProperty('basemap', 'raster-contrast', dark ? -0.05 : 0);
}

/**
 * Category pins, drawn to a canvas at load time from the same SVG paths the
 * HTML uses — no sprite sheet, no network request, identical artwork on the
 * map and in the UI, and none of emoji's cross-platform lottery.
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

    // White glyph on the coloured head, scaled from the 24x24 icon grid.
    const pathD = CATEGORY_ICONS[cat];
    if (pathD) {
      const scale = 14 / 24;
      ctx.save();
      ctx.translate(cx - 7, cy - 7);
      ctx.scale(scale, scale);
      ctx.fillStyle = '#ffffff';
      ctx.fill(new Path2D(pathD));
      ctx.restore();
    }

    const img = ctx.getImageData(0, 0, c.width, c.height);
    if (map.hasImage(`pin-${cat}`)) map.removeImage(`pin-${cat}`);
    map.addImage(`pin-${cat}`, img, { pixelRatio: dpr });
  }
}

/** The tinted category icon used in list rows, chips, results and cards. */
function catBubble(cat, cls = '') {
  const c = CATEGORIES[cat];
  return `<span class="cat-bubble ${cls}" style="--cat:${c.color}">${svgIcon(CATEGORY_ICONS[cat])}</span>`;
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

  // Ring shown under whichever list row the pointer is on - the glue that ties
  // the sidebar to the map.
  map.addSource('hovered', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({
    id: 'hovered-ring',
    type: 'circle',
    source: 'hovered',
    paint: {
      'circle-radius': 16,
      'circle-color': 'transparent',
      'circle-stroke-color': '#0b6fb8',
      'circle-stroke-width': 2.5,
      'circle-stroke-opacity': 0.85,
    },
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

  // Where nearby photographs were taken, from their own embedded geotags.
  map.addSource('photo-dots', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({
    id: 'photo-dots',
    type: 'circle',
    source: 'photo-dots',
    paint: {
      'circle-radius': 6,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#7c3aed',
      'circle-stroke-width': 2.5,
    },
  });

  map.addSource('measure', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({
    id: 'measure-line',
    type: 'line',
    source: 'measure',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#e0007f', 'line-width': 2.5, 'line-dasharray': [1.5, 1.5] },
  });
  map.addLayer({
    id: 'measure-pts',
    type: 'circle',
    source: 'measure',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 5,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#e0007f',
      'circle-stroke-width': 2,
    },
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

function switchBasemap(key, { persist = true } = {}) {
  if (!BASEMAPS[key]) return;
  state.basemap = key;
  // Only a deliberate pick is remembered. A theme-change rebuild passes
  // persist:false so the automatic vector default stays automatic.
  if (persist) localStorage.setItem('apia-map:basemap', key);
  const map = state.map;
  map.setStyle(BASEMAPS[key].build(state.darkMap));
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
    return `<button class="chip" role="switch" data-cat="${cat}" aria-pressed="${state.active.has(cat)}" title="${escapeHTML(c.blurb)}" style="--cat:${c.color}">
      <span class="chip-icon">${svgIcon(CATEGORY_ICONS[cat])}</span>${escapeHTML(c.label)}
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
    const thumb = thumbFor(p);
    const lead = thumb
      ? `<span class="res-thumb"><img src="${escapeHTML(thumb)}" alt="" loading="lazy" decoding="async"></span>`
      : catBubble(p.cat);
    return `<li>
      <button class="result${thumb ? ' has-thumb' : ''}" data-id="${escapeHTML(p.id)}" aria-current="${state.selectedId === p.id}">
        ${lead}
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
  clearPhotoDots();
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
    const b = bearingDeg(state.userLocation, coords);
    // A live compass needle: which way, from where you are standing, is this
    // place? North-referenced — hold the phone flat with the map's north up.
    facts.push(fact(
      `<span class="bearing-arrow" style="transform:rotate(${Math.round(b) - 90}deg)" title="Direction from your position (map north up)">➤</span>`,
      `${formatDistance(d)} away, ${compassPoint(b)}<span class="sub">${escapeHTML(walkingTime(d))} · bearing ${Math.round(b)}°</span>`,
    ));
  }

  const dirs = directionsLinks(coords, p.name)
    .map((l) => `<a class="btn" href="${l.url}" target="_blank" rel="noopener noreferrer">${l.label}</a>`)
    .join('');

  $('#detail').innerHTML = `
    <div class="detail-hero" id="detailHero" hidden></div>
    <div class="detail-head" style="--cat:${cat.color}">
      <button class="icon-btn ghost detail-close" data-act="close" title="Close"><span aria-hidden="true">✕</span><span class="sr-only">Close</span></button>
      <h2>${escapeHTML(p.name)}</h2>
      ${p.name_sm ? `<div class="detail-sm">${escapeHTML(p.name_sm)}</div>` : ''}
      <div class="detail-kind">
        ${catBubble(p.cat, 'sm')}
        <span>${escapeHTML(p.kind)} · ${escapeHTML(cat.label)}</span>
        ${hours.state === 'open' ? '<span class="badge open">Open now</span>' : ''}
        ${hours.state === 'closed' ? '<span class="badge closed">Closed now</span>' : ''}
      </div>
    </div>
    <div class="detail-body">
      ${hi?.blurb ? `<p class="blurb">${escapeHTML(hi.blurb)}</p>` : ''}
      ${hi?.tip ? `<div class="tip"><b>Local tip</b>${escapeHTML(hi.tip)}</div>` : ''}
      <div id="detailArticle"></div>
      ${facts.length ? `<div class="facts">${facts.join('')}</div>` : ''}
      <div id="detailNearby"></div>
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

  clearPhotoDots();
  loadDetailMedia(p, coords);
}

/**
 * Everything visual and encyclopaedic about a place, loaded after the panel is
 * already on screen so it never delays the facts people actually need.
 *
 * Three independent enrichments, each of which may legitimately find nothing:
 * the place's own photographs (Wikidata), its Wikipedia opening paragraph, and
 * photographs geotagged nearby (Commons). Each is labelled for what it is.
 */
async function loadDetailMedia(p, coords) {
  const forId = p.id;
  const stillShowing = () => state.selectedId === forId && !$('#detail').hidden;
  let heroSet = false;

  // --- The place's own pictures --------------------------------------------
  const ownFiles = p.wikidata ? (state.photoByQid.get(p.wikidata)
    || (await resolvePhotosBatch([p.wikidata]).then((m) => m.get(p.wikidata)).catch(() => null))) : null;

  if (ownFiles?.length && stillShowing()) {
    const items = ownFiles.map((f) => ({ ...commonsUrls(f), caption: p.name }));
    renderHero(items, p.name);
    heroSet = true;
  }

  // --- Wikipedia -----------------------------------------------------------
  if (p.wikipedia) {
    const article = await resolveArticle(p.wikipedia).catch(() => null);
    if (article && stillShowing()) {
      const slot = $('#detailArticle');
      if (slot) {
        slot.innerHTML = `
          <div class="article">
            <p>${escapeHTML(article.extract)}</p>
            <a href="${escapeHTML(article.url)}" target="_blank" rel="noopener noreferrer">
              Read on Wikipedia${article.lang !== 'en' ? ` (${escapeHTML(article.lang)})` : ''} ↗</a>
          </div>`;
      }
      // Fall back to the article's lead image when the entity had none.
      if (!heroSet && article.thumb && stillShowing()) {
        renderHero([{ thumb: article.thumb, full: article.thumb, page: article.url, caption: p.name }], p.name);
        heroSet = true;
      }
    }
  }

  // --- Nearby photography, sorted into OF and AROUND ------------------------
  //
  // The geofence is sized to what the place physically is: a shopfront is not
  // an airport. Inside the fence, title and category matching decides which
  // pictures actually show the place; the rest stay honestly labelled as the
  // area. The fence comes first, always — a perfect title match across town is
  // a different place with the same name, not a photo of this one.
  const radius = photoRadiusFor(p);
  const near = await photosNear(coords, { radius, limit: 30 }).catch(() => []);
  if (!near.length || !stillShowing()) return;

  const ownSet = new Set((ownFiles || []).map((f) => f.replace(/ /g, '_')));
  const fresh = near.filter((n) => !ownSet.has(n.title.replace(/ /g, '_')));
  const names = [p.name, p.name_sm, p.tags?.alt_name, p.tags?.old_name, p.tags?.official_name].filter(Boolean);
  const { of, around } = classifyPhotos(names, fresh, { radius });

  // No own image anywhere, but confidently-named photos at the doorstep? Lead
  // with the best of them, labelled for exactly what it is.
  if (!heroSet && of.length && of[0].score >= 2 && stillShowing()) {
    renderHero([{
      thumb: of[0].thumb, full: of[0].full, page: of[0].page,
      caption: `${p.name} (matched nearby photograph)`,
    }], p.name);
  }

  const slot = $('#detailNearby');
  if (!slot) return;
  const strip = (shots, offset = 0) => shots.map((s, i) => `
    <button class="photo-tile" data-shot="${offset + i}" title="${escapeHTML(s.title)}${s.metres ? ` · ${s.metres} m` : ''}">
      <img src="${escapeHTML(s.thumb)}" alt="${escapeHTML(s.title)}" loading="lazy" decoding="async">
    </button>`).join('');

  const aroundShown = of.length >= 3 ? around.slice(0, 4) : around.slice(0, 8);
  slot.innerHTML = `
    ${of.length ? `
      <div class="nearby-photos">
        <h3>Photographs of ${escapeHTML(shortName(p.name))}
          <span title="Geotagged within ${radius} m of this place and named or categorised for it on Wikimedia Commons.">ⓘ</span>
        </h3>
        <div class="photo-strip">${strip(of)}</div>
      </div>` : ''}
    ${aroundShown.length ? `
      <div class="nearby-photos around">
        <h3>Around here
          <span title="Photographs geotagged nearby. They show the area — not necessarily this place itself.">ⓘ</span>
        </h3>
        <div class="photo-strip">${strip(aroundShown, of.length)}</div>
      </div>` : ''}`;

  const all = [...of, ...aroundShown];
  slot.querySelectorAll('[data-shot]').forEach((btn) => {
    btn.addEventListener('click', () => openLightbox(
      all.map((s) => ({ full: s.full, page: s.page, caption: s.title, artist: s.artist, licence: s.licence })),
      Number(btn.dataset.shot),
    ));
  });

  showPhotoDots(all, coords);
}

/** How wide "at this place" plausibly is, in metres. */
function photoRadiusFor(p) {
  if (['Airport', 'Ferry terminal', 'Bus terminal'].includes(p.kind)) return 350;
  if (p.cat === 'places') return 500;
  if (p.cat === 'outdoors') return 250;
  return 90;
}

function shortName(name) {
  return name.length > 28 ? `${name.slice(0, 26)}…` : name;
}

/**
 * Camera dots on the map at each photograph's own geotag — where the pictures
 * were taken, from their embedded coordinates. Click one to view it.
 */
function showPhotoDots(shots, placeCoords) {
  const src = state.map?.getSource('photo-dots');
  if (!src) return;
  const items = shots.filter((s) => s.coords);
  src.setData({
    type: 'FeatureCollection',
    features: items.map((s, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: s.coords },
      properties: { i, title: s.title },
    })),
  });
  state.photoShots = items;
  void placeCoords;
}

function clearPhotoDots() {
  state.map?.getSource('photo-dots')?.setData(EMPTY_FC);
  state.photoShots = [];
}

/** The photo banner at the top of a detail card, clickable into the lightbox. */
function renderHero(items, name) {
  const slot = $('#detailHero');
  if (!slot || !items.length) return;
  const first = items[0];

  const img = new Image();
  img.alt = `Photograph of ${name}`;
  img.decoding = 'async';
  // Appended only once loaded, so a broken or blocked image leaves no gap.
  img.onload = () => {
    slot.innerHTML = '';
    slot.appendChild(img);
    slot.insertAdjacentHTML('beforeend', `
      ${items.length > 1 ? `<span class="hero-count">1 / ${items.length}</span>` : ''}
      <a class="photo-credit" href="${escapeHTML(first.page)}" target="_blank" rel="noopener noreferrer">Wikimedia Commons</a>
      <button class="hero-expand" title="View full size"><span aria-hidden="true">⤢</span><span class="sr-only">View photograph full size</span></button>`);
    slot.hidden = false;
    slot.querySelector('.hero-expand').addEventListener('click', () => openLightbox(items, 0));
    img.addEventListener('click', () => openLightbox(items, 0));
  };
  img.src = first.thumb;
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

function openLightbox(items, index = 0) {
  state.lightbox = { items, index };
  const box = $('#lightbox');
  box.hidden = false;
  document.body.style.overflow = 'hidden';
  renderLightbox();
}

function renderLightbox() {
  const { items, index } = state.lightbox || {};
  if (!items) return;
  const it = items[index];
  const credit = [it.artist, it.licence].filter(Boolean).join(' · ');

  $('#lightbox').innerHTML = `
    <button class="lb-close" data-lb="close" title="Close (Esc)"><span aria-hidden="true">✕</span><span class="sr-only">Close</span></button>
    ${items.length > 1 ? '<button class="lb-nav prev" data-lb="prev" title="Previous"><span aria-hidden="true">‹</span></button>' : ''}
    <figure class="lb-figure">
      <img src="${escapeHTML(it.full)}" alt="${escapeHTML(it.caption || '')}">
      <figcaption>
        <span>${escapeHTML(it.caption || '')}${items.length > 1 ? ` · ${index + 1} of ${items.length}` : ''}</span>
        <a href="${escapeHTML(it.page)}" target="_blank" rel="noopener noreferrer">
          ${credit ? escapeHTML(credit) + ' — ' : ''}Wikimedia Commons ↗</a>
      </figcaption>
    </figure>
    ${items.length > 1 ? '<button class="lb-nav next" data-lb="next" title="Next"><span aria-hidden="true">›</span></button>' : ''}`;
}

function closeLightbox() {
  state.lightbox = null;
  $('#lightbox').hidden = true;
  document.body.style.overflow = '';
}

function stepLightbox(delta) {
  if (!state.lightbox) return;
  const n = state.lightbox.items.length;
  state.lightbox.index = (state.lightbox.index + delta + n) % n;
  renderLightbox();
}

function fact(icon, valueHTML) {
  return `<div class="fact"><span class="k" aria-hidden="true">${icon}</span><span class="v">${valueHTML}</span></div>`;
}

/** Initial great-circle bearing from a to b, degrees clockwise from north. */
function bearingDeg([lng1, lat1], [lng2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function compassPoint(deg) {
  const points = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return points[Math.round(deg / 45) % 8];
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

  // Hovering a row rings its pin on the map, so the list and the map read as
  // one surface instead of two.
  $('#results').addEventListener('mouseover', (e) => {
    const btn = e.target.closest('.result');
    if (btn?.dataset.id) hoverFeature(btn.dataset.id);
  });
  $('#results').addEventListener('mouseout', (e) => {
    if (!e.relatedTarget?.closest?.('.result')) hoverFeature(null);
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

  // Theme changes rebuild the vector style: it has a real night palette, so a
  // phone sliding into dark mode at sunset takes the map with it.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    state.darkMap = e.matches;
    if (BASEMAPS[state.basemap]?.kind === 'vector') switchBasemap(state.basemap, { persist: false });
    else applyDarkDim();
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

  $('#lightbox').addEventListener('click', (e) => {
    const act = e.target.closest('[data-lb]')?.dataset.lb;
    if (act === 'close') closeLightbox();
    else if (act === 'prev') stepLightbox(-1);
    else if (act === 'next') stepLightbox(1);
    else if (e.target.id === 'lightbox') closeLightbox();   // click the backdrop
  });

  document.addEventListener('keydown', (e) => {
    // The lightbox is modal: it takes every key while open.
    if (state.lightbox) {
      if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
      return;
    }
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
      if (state.measure) endMeasure();
      else if (state.selectedId) closeDetail();
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

  const RECENTS_KEY = 'apia-map:recent-searches';
  const getRecents = () => {
    try { return JSON.parse(localStorage.getItem(RECENTS_KEY)) || []; } catch { return []; }
  };
  const pushRecent = (q) => {
    if (!q || q.length < 2) return;
    try {
      const r = [q, ...getRecents().filter((x) => x !== q)].slice(0, 6);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(r));
    } catch { /* storage full or blocked - recents are a nicety */ }
  };

  const showQuicks = () => {
    const recents = getRecents();
    const recentRow = recents.length
      ? `<li class="search-quicks recents" role="presentation">
          ${recents.map((q) => `<button class="chip" data-q="${escapeHTML(q)}">🕐 ${escapeHTML(q)}</button>`).join('')}
        </li>`
      : '';
    list.innerHTML = `${recentRow}<li class="search-quicks" role="presentation">
      ${QUICKS.map(([icon, q]) =>
        `<button class="chip" data-q="${escapeHTML(q)}">${icon} ${escapeHTML(q)}</button>`).join('')}
      </li>
      <li class="search-empty" role="presentation">Type to search ${state.all.length.toLocaleString()} places — English or Samoan spelling both work, and one-letter typos are forgiven.</li>`;
    list.hidden = false;
    combo.setAttribute('aria-expanded', 'true');
  };
  wireSearch.pushRecent = pushRecent;

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
        const name = matchSegments(p.name, q)
          .map((s) => (s.hit ? `<mark>${escapeHTML(s.text)}</mark>` : escapeHTML(s.text)))
          .join('');
        return `<li role="option" id="sr-${i}" aria-selected="false">
          <button data-id="${escapeHTML(p.id)}" data-i="${i}">
            ${catBubble(p.cat)}
            <span class="res-body">
              <span class="res-name">${name}</span>
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
      if (pick) { wireSearch.pushRecent(input.value.trim()); selectFeature(pick.properties.id); input.blur(); close(); }
    } else if (e.key === 'Escape') {
      close();
      input.blur();
    }
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    wireSearch.pushRecent(input.value.trim());
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
