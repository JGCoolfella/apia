// The vector style is hand-written cartography; these tests keep it honest.

import { test, expect } from '@playwright/test';
import { BASEMAPS, probeVectorBasemap } from '../src/basemaps.js';
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
