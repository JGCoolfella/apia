// The vector style is hand-written cartography; these tests keep it honest.

import { test, expect } from '@playwright/test';
import { BASEMAPS, probeVectorBasemap, TERRAIN_SOURCE } from '../src/basemaps.js';
import { BBOX } from '../src/config.js';

const light = BASEMAPS.vector.build(false);
const dark = BASEMAPS.vector.build(true);

test.describe('vector style', () => {
  test('light and dark are the same map at different hours', () => {
    // Identical layer structure — only paint may differ. A dark mode that adds
    // or drops layers is a second map to maintain and they will drift.
    expect(dark.layers.map((l) => l.id)).toEqual(light.layers.map((l) => l.id));
    expect(dark.layers.map((l) => l.type)).toEqual(light.layers.map((l) => l.type));
  });

  test('dark is actually dark and light actually light', () => {
    const lum = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    expect(lum(light.layers[0].paint['background-color'])).toBeGreaterThan(0.6);
    expect(lum(dark.layers[0].paint['background-color'])).toBeLessThan(0.2);
  });

  test('references the self-hosted archive, no external tile server', () => {
    const src = light.sources.protomaps;
    expect(src.type).toBe('vector');
    expect(src.url).toContain('pmtiles://');
    expect(JSON.stringify(light.sources)).not.toContain('tile.openstreetmap.org');
  });

  test('roads render above landuse and below labels', () => {
    const ids = light.layers.map((l) => l.id);
    expect(ids.indexOf('roads-major')).toBeGreaterThan(ids.indexOf('landuse-green'));
    expect(ids.indexOf('place-labels')).toBeGreaterThan(ids.indexOf('roads-major'));
  });

  test('attribution credits OpenStreetMap', () => {
    expect(light.sources.protomaps.attribution).toContain('OpenStreetMap');
  });

  test('extrudes buildings at street zoom with an honest default height', () => {
    for (const style of [light, dark]) {
      const b3d = style.layers.find((l) => l.id === 'buildings-3d');
      expect(b3d.type).toBe('fill-extrusion');
      expect(b3d.minzoom).toBeGreaterThanOrEqual(15);
      // Apia's buildings rarely carry height tags; a missing height must fall
      // back to a modest default, never to zero (invisible) or a tower.
      const h = JSON.stringify(b3d.paint['fill-extrusion-height']);
      expect(h).toContain('coalesce');
      expect(h).toContain('height');
    }
  });

  test('every theme has a sky, so 3D ends at a horizon instead of a hard edge', () => {
    expect(light.sky['sky-color']).toBeTruthy();
    expect(dark.sky['sky-color']).toBeTruthy();
    expect(light.sky['sky-color']).not.toBe(dark.sky['sky-color']);
  });

  test('carries real relief: a DEM source and a hillshade layer in both themes', () => {
    for (const style of [light, dark]) {
      expect(style.sources.dem.type).toBe('raster-dem');
      expect(style.sources.dem.encoding).toBe('terrarium');
      const hs = style.layers.find((l) => l.id === 'hillshade');
      expect(hs.type).toBe('hillshade');
      expect(hs.source).toBe('dem');
      // Relief is texture under the roads, never over them.
      const ids = style.layers.map((l) => l.id);
      expect(ids.indexOf('hillshade')).toBeLessThan(ids.indexOf('roads-major'));
    }
  });
});

test.describe('terrain source', () => {
  test('is the open AWS terrarium DEM at its documented parameters', () => {
    expect(TERRAIN_SOURCE.type).toBe('raster-dem');
    expect(TERRAIN_SOURCE.encoding).toBe('terrarium');
    expect(TERRAIN_SOURCE.tiles[0]).toBe('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png');
    // The dataset tops out at z15; asking deeper returns 404s that MapLibre
    // treats as holes in the terrain.
    expect(TERRAIN_SOURCE.maxzoom).toBe(15);
    expect(TERRAIN_SOURCE.attribution).toContain('Mapzen');
  });
});

test.describe('satellite style', () => {
  test('uses the Esri {z}/{y}/{x} scheme and credits the imagery providers', () => {
    const style = BASEMAPS.satellite.build(false, { hasVector: false });
    const sat = style.sources.satellite;
    // Esri's REST tile path is row-before-column; {z}/{x}/{y} here fetches
    // real tiles of the wrong place, which renders and looks plausible.
    expect(sat.tiles[0]).toContain('/tile/{z}/{y}/{x}');
    expect(sat.attribution).toContain('Esri');
    expect(sat.attribution).toContain('Maxar');
    expect(sat.attribution).toContain('OpenStreetMap');
    expect(style.sources.dem.encoding).toBe('terrarium');
    expect(style.sky['sky-color']).toBeTruthy();
  });

  test('is plain imagery without the archive, hybrid with it', () => {
    const plain = BASEMAPS.satellite.build(false, { hasVector: false });
    expect(plain.layers.find((l) => l.id === 'sat-place-labels')).toBeUndefined();
    expect(JSON.stringify(plain.sources)).not.toContain('pmtiles');

    const hybrid = BASEMAPS.satellite.build(false, { hasVector: true });
    const labels = hybrid.layers.find((l) => l.id === 'sat-place-labels');
    expect(labels.type).toBe('symbol');
    expect(hybrid.layers.find((l) => l.id === 'sat-ferry').type).toBe('line');
    expect(hybrid.sources.protomaps.url).toContain('pmtiles://');
  });

  test('the hybrid is navigable: roads ghost over the imagery with names', () => {
    const hybrid = BASEMAPS.satellite.build(false, { hasVector: true });
    const roads = hybrid.layers.find((l) => l.id === 'sat-roads');
    expect(roads.type).toBe('line');
    expect(roads.minzoom).toBeGreaterThanOrEqual(10);   // never clutter the island view
    const roadLabels = hybrid.layers.find((l) => l.id === 'sat-road-labels');
    expect(roadLabels.type).toBe('symbol');
    expect(roadLabels.layout['symbol-placement']).toBe('line');

    const plain = BASEMAPS.satellite.build(false, { hasVector: false });
    expect(plain.layers.find((l) => l.id === 'sat-roads')).toBeUndefined();
  });
});

test.describe('vector probe', () => {
  test('accepts a real archive answering a range request', async () => {
    const fetchImpl = async () => ({ ok: false, status: 206, headers: new Map([['content-type', 'application/octet-stream']]) });
    expect(await probeVectorBasemap((u, o) => fetchImpl(u, o).then((r) => ({ ...r, headers: { get: (k) => r.headers.get(k) } })))).toBe(true);
  });

  test('rejects an SPA rewrite that answers HTML for the missing file', async () => {
    // CloudFront's 404->index.html fallback answers 200 for EVERYTHING, so a
    // status check alone would enable the vector map on a deployment that has
    // no archive — and the map would render nothing.
    const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' } });
    expect(await probeVectorBasemap(fetchImpl)).toBe(false);
  });

  test('rejects cleanly when offline', async () => {
    const fetchImpl = async () => { throw new Error('offline'); };
    expect(await probeVectorBasemap(fetchImpl)).toBe(false);
  });
});

test.describe('coverage', () => {
  test('the data bbox now spans both islands', () => {
    // Salelologa (Savai'i ferry terminal) is ~-172.33; Cape Mulinu'u, the far
    // west of Savai'i, ~-172.78. The whole country, ferry to ferry.
    expect(BBOX.west).toBeLessThan(-172.7);
    expect(BBOX.east).toBeGreaterThan(-171.5);
    expect(BBOX.north).toBeGreaterThan(-13.45);
    expect(BBOX.south).toBeLessThan(-14.0);
  });
});
