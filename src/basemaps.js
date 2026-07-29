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

/**
 * Real elevation: the open Mapzen/AWS terrain tiles (SRTM and friends, terrarium
 * encoding), hosted as an AWS Open Data set. No key, no quota. This is what
 * makes 3D honest — Mount Vaea, the Upolu ridge and Savai'i's 1,858 m shield
 * volcano at their measured heights, not decorative extrusion.
 */
export const TERRAIN_SOURCE = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: 15,
  attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Mapzen/AWS Open Data (SRTM)</a>',
};

const ESRI_IMAGERY_ATTRIBUTION =
  'Imagery: <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community';

/**
 * Sky and haze for the tilted view. Without this the map ends at a hard edge
 * against the page background the moment 3D is on; with it the terrain fades
 * into a horizon and the sky above it, which is most of what makes the tilted
 * view read as a landscape instead of a skewed rectangle.
 */
function skyFor(kind) {
  const s = {
    day: { sky: '#76c1e6', horizon: '#dcedf6', fog: '#e9f4f9' },
    night: { sky: '#050e18', horizon: '#27506b', fog: '#0e2233' },
    imagery: { sky: '#06121d', horizon: '#3a6c8c', fog: '#1c3a4f' },
  }[kind];
  return {
    'sky-color': s.sky,
    'horizon-color': s.horizon,
    'fog-color': s.fog,
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.85,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 1, 12, 0],
  };
}

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
  satellite: {
    label: 'Satellite',
    hint: 'Esri world imagery — with place labels when the vector archive is present',
    kind: 'raster',
    build: (dark, { hasVector = false } = {}) => satelliteStyle(hasVector),
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

/**
 * Satellite imagery, hybrid when possible: Esri's world imagery underneath and,
 * when the self-hosted vector archive exists, our own place labels and the ferry
 * route drawn over it so the imagery is navigable rather than just pretty.
 * Note the Esri tile scheme is {z}/{y}/{x}.
 */
function satelliteStyle(hasVector) {
  const style = {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sky: skyFor('imagery'),
    sources: {
      satellite: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: `${ESRI_IMAGERY_ATTRIBUTION} | ${OSM_ATTRIBUTION}`,
      },
      dem: { ...TERRAIN_SOURCE },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0a1a24' } },
      { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-fade-duration': 200 } },
    ],
  };

  if (hasVector) {
    style.sources.protomaps = {
      type: 'vector',
      url: `pmtiles://${PMTILES_URL}`,
      attribution: '',
    };
    style.layers.push(
      {
        id: 'sat-ferry',
        type: 'line',
        source: 'protomaps',
        'source-layer': 'roads',
        filter: ['==', ['get', 'kind'], 'ferry'],
        paint: { 'line-color': '#9fd8ea', 'line-width': 1.6, 'line-dasharray': [3, 3] },
      },
      {
        id: 'sat-place-labels',
        type: 'symbol',
        source: 'protomaps',
        'source-layer': 'places',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 7, 11, 14, 15],
          'text-max-width': 8,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(6,14,20,0.85)',
          'text-halo-width': 1.8,
        },
      },
    );
  }
  return style;
}

export const DEFAULT_BASEMAP = 'streets'; // boot upgrades to 'vector' when the archive probes present

function rasterStyle(tiles, maxzoom, attribution) {
  return {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sky: skyFor('day'),
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
    reef: c('#c3e4dd', '#12303a'),
    building: c('#e8e2d6', '#1d2c38'),
    buildingWall: c('#d9d1c1', '#26394a'),
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
    sky: skyFor(dark ? 'night' : 'day'),
    sources: {
      [src]: {
        type: 'vector',
        url: `pmtiles://${pmtilesUrl}`,
        attribution: `${OSM_ATTRIBUTION} | <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>`,
      },
      dem: { ...TERRAIN_SOURCE },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': palette.background } },
      L('earth', 'earth', { type: 'fill', paint: { 'fill-color': palette.earth } }),
      L('landuse-green', 'landuse', {
        type: 'fill',
        filter: ['in', ['get', 'kind'], ['literal', ['park', 'nature_reserve', 'garden', 'golf_course', 'cemetery', 'grass', 'pitch', 'recreation_ground']]],
        paint: { 'fill-color': palette.park },
      }),
      L('landuse-forest', 'landuse', {
        type: 'fill',
        filter: ['in', ['get', 'kind'], ['literal', ['forest', 'wood', 'scrub']]],
        paint: { 'fill-color': palette.forest },
      }),
      L('landuse-sand', 'landuse', {
        type: 'fill',
        filter: ['in', ['get', 'kind'], ['literal', ['beach', 'sand']]],
        paint: { 'fill-color': palette.sand },
      }),
      L('landuse-wetland', 'landuse', {
        type: 'fill',
        filter: ['==', ['get', 'kind'], 'wetland'],
        paint: { 'fill-color': palette.reef, 'fill-opacity': 0.5 },
      }),
      // Real relief from the same DEM that powers the 3D toggle. Kept subtle:
      // it should read as texture on the volcanic ridges, not as a shaded-relief
      // poster fighting the road network.
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem',
        paint: {
          'hillshade-exaggeration': dark ? 0.35 : 0.25,
          'hillshade-shadow-color': c('#5f6c5e', '#02070c'),
          'hillshade-highlight-color': c('#ffffff', '#33506b'),
          'hillshade-accent-color': c('#7a8a76', '#0a1520'),
        },
      },
      L('aeroways', 'roads', {
        type: 'line',
        filter: ['==', ['get', 'kind'], 'aeroway'],
        paint: {
          'line-color': palette.mediumCase,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, 1.5, 14, 8, 17, 40],
        },
      }),
      // The Mulifanua–Salelologa crossing, straight from the data: the one
      // line on this map that is genuinely a route, drawn as one.
      L('ferry-routes', 'roads', {
        type: 'line',
        filter: ['==', ['get', 'kind'], 'ferry'],
        paint: { 'line-color': palette.waterLabel, 'line-width': 1.6, 'line-dasharray': [3, 3] },
      }),
      // Water needs discrimination, not a blanket fill: reef flats are not open
      // sea, and narrow stream polygons are tagged min_zoom 14 by the tileset -
      // painted early they smear into valley-wide wedges.
      L('water', 'water', {
        type: 'fill',
        filter: ['!', ['in', ['get', 'kind'], ['literal', ['reef', 'stream', 'drain', 'ditch']]]],
        paint: { 'fill-color': palette.water },
      }),
      L('water-reef', 'water', {
        type: 'fill',
        filter: ['==', ['get', 'kind'], 'reef'],
        paint: { 'fill-color': palette.reef, 'fill-opacity': 0.55 },
      }),
      L('water-streams', 'water', {
        type: 'fill', minzoom: 14,
        filter: ['in', ['get', 'kind'], ['literal', ['stream', 'drain', 'ditch']]],
        paint: { 'fill-color': palette.waterway },
      }),
      L('waterways', 'physical_line', {
        type: 'line',
        filter: ['in', ['get', 'kind'], ['literal', ['river', 'stream']]],
        paint: {
          'line-color': palette.waterway,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, 0.5, 16, 2.5],
        },
      }),
      L('buildings', 'buildings', {
        type: 'fill', minzoom: 14,
        paint: { 'fill-color': palette.building, 'fill-opacity': 0.85 },
      }),
      // At street zoom every footprint stands up. Apia's OSM buildings rarely
      // carry a height tag, so a modest single-storey default keeps the town
      // honest — real heights are used wherever they exist.
      L('buildings-3d', 'buildings', {
        type: 'fill-extrusion', minzoom: 15.5,
        paint: {
          'fill-extrusion-color': palette.buildingWall,
          'fill-extrusion-height': ['to-number', ['coalesce', ['get', 'height'], 5], 5],
          'fill-extrusion-base': ['to-number', ['coalesce', ['get', 'min_height'], 0], 0],
          'fill-extrusion-opacity': 0.82,
        },
      }),

      // Roads: casing under fill, three classes.
      L('roads-minor-case', 'roads', {
        type: 'line', minzoom: 12,
        filter: ['in', ['get', 'kind'], ['literal', ['minor_road', 'other', 'path']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': palette.minorCase, 'line-gap-width': roadWidth(0.7), 'line-width': 1 },
      }),
      L('roads-minor', 'roads', {
        type: 'line',
        filter: ['in', ['get', 'kind'], ['literal', ['minor_road', 'other', 'path']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': palette.minor, 'line-width': roadWidth(0.7) },
      }),
      L('roads-medium-case', 'roads', {
        type: 'line', minzoom: 10,
        filter: ['==', ['get', 'kind'], 'medium_road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': palette.mediumCase, 'line-gap-width': roadWidth(1.1), 'line-width': 1 },
      }),
      L('roads-medium', 'roads', {
        type: 'line',
        filter: ['==', ['get', 'kind'], 'medium_road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': palette.medium, 'line-width': roadWidth(1.1) },
      }),
      L('roads-major-case', 'roads', {
        type: 'line',
        filter: ['in', ['get', 'kind'], ['literal', ['major_road', 'highway']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': palette.majorCase, 'line-gap-width': roadWidth(1.6), 'line-width': 1 },
      }),
      L('roads-major', 'roads', {
        type: 'line',
        filter: ['in', ['get', 'kind'], ['literal', ['major_road', 'highway']]],
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
        filter: ['in', ['get', 'kind'], ['literal', ['sea', 'ocean', 'bay', 'water']]],
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
            7, ['match', ['get', 'kind'], 'locality', 12, 10],
            14, ['match', ['get', 'kind'], 'locality', 18, 13],
          ],
          'text-max-width': 8,
        },
        paint: { 'text-color': palette.labelText, 'text-halo-color': palette.labelHalo, 'text-halo-width': 1.8 },
      }),
    ],
  };
}
