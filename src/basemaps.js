// Basemap style definitions.
//
// Three options, all pure OpenStreetMap data:
//
//   "vector"            - a self-hosted Protomaps .pmtiles archive served from
//                         this site's own CDN. No API key, no third-party tile
//                         server, no usage limits, range-request cheap, and the
//                         only option with a TRUE dark style rather than dimmed
//                         raster tiles. The default whenever the archive has
//                         been built (CI fetches it; see fetch-basemap.yml).
//   "streets" / "topo"  - public raster tile services. Zero setup, and the
//                         fallback when no archive is present. The OSMF tile
//                         policy (operations.osmfoundation.org/policies/tiles/)
//                         asks apps not to lean on tile.openstreetmap.org, which
//                         is exactly why the vector archive exists.

const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>';

export const PMTILES_URL = import.meta.env?.VITE_PMTILES_URL || 'basemap/samoa.pmtiles';

/**
 * Does the self-hosted archive actually exist on this deployment? A cheap
 * range probe (2 bytes) answers without downloading anything meaningful.
 * SPA rewrites can answer 200 with HTML for missing files, so the content
 * type is checked too.
 */
export async function probeVectorBasemap(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(PMTILES_URL, { headers: { Range: 'bytes=0-1' } });
    if (!res.ok && res.status !== 206) return false;
    const type = res.headers.get('content-type') || '';
    return !type.includes('text/html');
  } catch {
    return false;
  }
}

export const BASEMAPS = {
  vector: {
    label: 'Samoa (vector)',
    hint: 'Self-hosted, sharpest rendering, true dark mode, works offline',
    kind: 'vector',
    build: (dark) => vectorStyle(PMTILES_URL, !!dark),
  },
  streets: {
    label: 'Streets',
    hint: 'OpenStreetMap standard raster tiles',
    kind: 'raster',
    build: () => rasterStyle(
      ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      19,
      OSM_ATTRIBUTION,
    ),
  },
  topo: {
    label: 'Terrain',
    hint: 'OpenTopoMap — contours and relief',
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
};

export const DEFAULT_BASEMAP = 'streets'; // boot upgrades to 'vector' when the archive probes present

function rasterStyle(tiles, maxzoom, attribution) {
  return {
    version: 8,
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
 * The house cartography: a calm lagoon-and-sand basemap in light mode and a
 * genuine night style in dark mode, designed to sit underneath this app's pins
 * rather than compete with them. Colours are chosen as pairs so the two themes
 * read as the same map at different hours, not two different products.
 */
function vectorStyle(pmtilesUrl, dark) {
  // [light, dark]
  const c = (l, d) => (dark ? d : l);
  const palette = {
    background: c('#dfeef2', '#0b1420'),
    earth: c('#f7f4ee', '#101c26'),
    park: c('#d6ecca', '#16281e'),
    forest: c('#cfe6c2', '#142419'),
    sand: c('#f2e9cf', '#26251a'),
    water: c('#a9d6e8', '#0e2233'),
    waterway: c('#9fcfe3', '#123047'),
    building: c('#e8e2d6', '#1d2c38'),
    minor: c('#ffffff', '#243543'),
    minorCase: c('#e0dbd2', '#1a2833'),
    medium: c('#ffffff', '#2b3f4f'),
    mediumCase: c('#d8d2c8', '#1a2833'),
    major: c('#fdf0c0', '#3d4c55'),
    majorCase: c('#e6d49a', '#1a2833'),
    boundary: c('#b9b2a6', '#3a4a56'),
    labelText: c('#3d4238', '#c8d4dc'),
    labelHalo: c('#ffffff', '#0b1420'),
    roadLabel: c('#5c574e', '#9fb0bc'),
    waterLabel: c('#4b7f99', '#5f8ba3'),
  };

  const src = 'protomaps';
  const L = (id, layer, extra) => ({ id, source: src, 'source-layer': layer, ...extra });
  const roadWidth = (base) => ['interpolate', ['exponential', 1.6], ['zoom'], 7, base * 0.4, 12, base, 16, base * 4.2, 20, base * 14];

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
      { id: 'background', type: 'background', paint: { 'background-color': palette.background } },
      L('earth', 'earth', { type: 'fill', paint: { 'fill-color': palette.earth } }),
      L('landuse-green', 'landuse', {
        type: 'fill',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['park', 'nature_reserve', 'garden', 'golf_course', 'cemetery', 'grass', 'pitch']]],
        paint: { 'fill-color': palette.park },
      }),
      L('landuse-forest', 'landuse', {
        type: 'fill',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['forest', 'wood', 'scrub']]],
        paint: { 'fill-color': palette.forest },
      }),
      L('natural-green', 'natural', {
        type: 'fill',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['wood', 'scrub', 'grassland']]],
        paint: { 'fill-color': palette.forest },
      }),
      L('landuse-sand', 'landuse', {
        type: 'fill',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['beach', 'sand']]],
        paint: { 'fill-color': palette.sand },
      }),
      L('natural-sand', 'natural', {
        type: 'fill',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['beach', 'sand']]],
        paint: { 'fill-color': palette.sand },
      }),
      L('water', 'water', { type: 'fill', paint: { 'fill-color': palette.water } }),
      L('waterways', 'physical_line', {
        type: 'line',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['river', 'stream']]],
        paint: {
          'line-color': palette.waterway,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, 0.5, 16, 2.5],
        },
      }),
      L('buildings', 'buildings', {
        type: 'fill', minzoom: 14,
        paint: { 'fill-color': palette.building, 'fill-opacity': 0.85 },
      }),

      // Roads: casing under fill, three classes.
      L('roads-minor-case', 'roads', {
        type: 'line', minzoom: 12,
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['minor_road', 'other', 'path']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': palette.minorCase, 'line-gap-width': roadWidth(0.7), 'line-width': 1 },
      }),
      L('roads-minor', 'roads', {
        type: 'line',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['minor_road', 'other', 'path']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': palette.minor, 'line-width': roadWidth(0.7) },
      }),
      L('roads-medium-case', 'roads', {
        type: 'line', minzoom: 10,
        filter: ['==', ['get', 'pmap:kind'], 'medium_road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': palette.mediumCase, 'line-gap-width': roadWidth(1.1), 'line-width': 1 },
      }),
      L('roads-medium', 'roads', {
        type: 'line',
        filter: ['==', ['get', 'pmap:kind'], 'medium_road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': palette.medium, 'line-width': roadWidth(1.1) },
      }),
      L('roads-major-case', 'roads', {
        type: 'line',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['major_road', 'highway']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': palette.majorCase, 'line-gap-width': roadWidth(1.6), 'line-width': 1 },
      }),
      L('roads-major', 'roads', {
        type: 'line',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['major_road', 'highway']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': palette.major, 'line-width': roadWidth(1.6) },
      }),

      L('boundaries', 'boundaries', {
        type: 'line',
        paint: { 'line-color': palette.boundary, 'line-width': 1, 'line-dasharray': [3, 2] },
      }),

      // Labels: roads at high zoom, water bodies, then places on top.
      L('road-labels', 'roads', {
        type: 'symbol', minzoom: 14,
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
        },
        paint: { 'text-color': palette.roadLabel, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.4 },
      }),
      L('water-labels', 'physical_point', {
        type: 'symbol',
        filter: ['in', ['get', 'pmap:kind'], ['literal', ['sea', 'ocean', 'bay', 'water']]],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 14],
          'text-letter-spacing': 0.08,
        },
        paint: { 'text-color': palette.waterLabel, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.2 },
      }),
      L('place-labels', 'places', {
        type: 'symbol',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Medium'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            7, ['match', ['get', 'pmap:kind'], 'locality', 12, 10],
            14, ['match', ['get', 'pmap:kind'], 'locality', 18, 13],
          ],
          'text-max-width': 8,
        },
        paint: { 'text-color': palette.labelText, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.8 },
      }),
    ],
  };
}
