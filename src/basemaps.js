// Basemap style definitions.
//
// Two paths, both pure OpenStreetMap:
//
//   "streets" / "topo"  - raster tiles fetched from a public tile service. Zero
//                         setup, ideal for local development and low-traffic
//                         personal use.
//   "vector"            - a self-hosted Protomaps .pmtiles file (see
//                         scripts/fetch-basemap.sh). No API key, no third-party
//                         tile server, no usage limits, and it works offline.
//                         This is the right choice for anything public.
//
// The OSM Foundation's tile usage policy (https://operations.osmfoundation.org/policies/tiles/)
// asks that apps not become heavy users of tile.openstreetmap.org. If this map
// is going to get real traffic, switch the default to "vector".

const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>';

export const PMTILES_URL = import.meta.env?.VITE_PMTILES_URL || 'basemap/samoa.pmtiles';

export const BASEMAPS = {
  streets: {
    label: 'Streets',
    hint: 'OpenStreetMap standard tiles',
    kind: 'raster',
    build: () => rasterStyle(
      ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      19,
      OSM_ATTRIBUTION,
    ),
  },
  topo: {
    label: 'Terrain',
    hint: 'OpenTopoMap - contours and relief',
    kind: 'raster',
    build: () => rasterStyle(
      [
        'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
        'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
        'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
      ],
      17,
      `${OSM_ATTRIBUTION} | <a href="https://opentopomap.org/" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)`,
    ),
  },
  vector: {
    label: 'Vector',
    hint: 'Self-hosted Protomaps basemap - works offline',
    kind: 'vector',
    build: () => vectorStyle(PMTILES_URL),
  },
};

export const DEFAULT_BASEMAP = 'streets';

function rasterStyle(tiles, maxzoom, attribution) {
  return {
    version: 8,
    // Glyphs are only needed by the app's own label layers; they come from the
    // same public MapLibre demo font server used by the default style.
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      basemap: { type: 'raster', tiles, tileSize: 256, maxzoom, attribution },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#eaf2f5' } },
      { id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-fade-duration': 200 } },
    ],
  };
}

/**
 * A compact Protomaps-flavoured vector style. Deliberately minimal: land, water,
 * green space, roads, buildings and place labels. The point is a calm backdrop
 * that lets the POI pins carry the map.
 */
function vectorStyle(pmtilesUrl) {
  const src = 'protomaps';
  const L = (id, extra) => ({ id, source: src, 'source-layer': extra['source-layer'], ...extra });
  return {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      [src]: {
        type: 'vector',
        url: `pmtiles://${pmtilesUrl}`,
        attribution: `${OSM_ATTRIBUTION} | <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>`,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f6f4f0' } },
      L('earth', { 'source-layer': 'earth', type: 'fill', paint: { 'fill-color': '#f6f4f0' } }),
      L('landuse', {
        'source-layer': 'landuse',
        type: 'fill',
        paint: {
          'fill-color': [
            'match', ['get', 'pmap:kind'],
            'park', '#d9ecd0', 'forest', '#d3e7c8', 'nature_reserve', '#d9ecd0',
            'beach', '#f5ecd0', 'pitch', '#dfeccf', 'cemetery', '#e2e6dc',
            'hospital', '#f3e0e0', 'school', '#e8e6f2', 'aerodrome', '#e9e9ee',
            'transparent',
          ],
        },
      }),
      L('water', { 'source-layer': 'water', type: 'fill', paint: { 'fill-color': '#a8d5e6' } }),
      L('roads-minor', {
        'source-layer': 'roads',
        type: 'line',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['minor_road', 'other', 'path']]],
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 0.4, 16, 3, 20, 12],
        },
      }),
      L('roads-medium', {
        'source-layer': 'roads',
        type: 'line',
        filter: ['==', ['get', 'pmap:kind'], 'medium_road'],
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, 0.6, 16, 5, 20, 18],
        },
      }),
      L('roads-major', {
        'source-layer': 'roads',
        type: 'line',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['major_road', 'highway']]],
        paint: {
          'line-color': '#fdf2c8',
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 7, 0.8, 16, 7, 20, 24],
        },
      }),
      L('buildings', {
        'source-layer': 'buildings',
        type: 'fill',
        minzoom: 14,
        paint: { 'fill-color': '#e6e2da', 'fill-opacity': 0.9 },
      }),
      L('roads-labels', {
        'source-layer': 'roads',
        type: 'symbol',
        minzoom: 15,
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
        },
        paint: { 'text-color': '#5b5750', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      }),
      L('place-labels', {
        'source-layer': 'places',
        type: 'symbol',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 15],
          'text-max-width': 8,
        },
        paint: { 'text-color': '#3d3a35', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
      }),
    ],
  };
}
