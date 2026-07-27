// End-to-end smoke test of the map UI in a real browser.
//
// The dataset is stubbed with the fixture so the test does not depend on the
// Overpass API, and basemap tiles and glyph requests are stubbed so it does not
// depend on any external tile server. Everything else is the real application.

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toGeoJSON } from '../src/overpass.js';
import { BBOX } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(await readFile(resolve(HERE, 'fixtures/overpass-sample.json'), 'utf8'));
const fixture = toGeoJSON(sample);

// 1x1 transparent PNG, stands in for every basemap tile.
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test.beforeEach(async ({ page }) => {
  await page.route('**/data/apia.geojson', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture) }));

  await page.route('**/data/meta.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        generated: '2026-07-20T02:00:00Z',
        osm_data_timestamp: '2026-07-20T00:00:00Z',
        feature_count: fixture.features.length,
        bbox: BBOX,
      }),
    }));

  // Nothing external: tiles become a blank pixel, glyphs and Overpass are refused.
  await page.route(/tile\.openstreetmap\.org|tile\.opentopomap\.org/, (route) =>
    route.fulfill({ contentType: 'image/png', body: BLANK_PNG }));
  await page.route(/fonts\.openmaptiles\.org/, (route) => route.abort());
  await page.route(/api\/interpreter/, (route) => route.abort());

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.errors = errors;
});

async function open(page) {
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden({ timeout: 20_000 });
}

test('loads and shows places from the dataset', async ({ page }) => {
  await open(page);

  await expect(page.locator('.brand-text strong')).toHaveText('Apia');
  await expect(page.locator('#chips .chip')).toHaveCount(14);

  const results = page.locator('#results .result');
  await expect(results.first()).toBeVisible();
  expect(await results.count()).toBeGreaterThan(4);

  await expect(page.locator('#results')).toContainText('Robert Louis Stevenson Museum');
  expect(page.errors).toEqual([]);
});

test('shows the live Apia clock', async ({ page }) => {
  await open(page);
  // UTC+13, formatted as "Apia <Day> HH:MM".
  await expect(page.locator('#clock')).toHaveText(/^Apia \w{3},? \d{2}:\d{2}$/);
});

test('search finds a place and opens its detail panel', async ({ page }) => {
  await open(page);

  await page.locator('#searchInput').fill('steven');
  const options = page.locator('#searchResults [role="option"]');
  await expect(options.first()).toBeVisible();
  await expect(options.first()).toContainText('Robert Louis Stevenson Museum');

  await options.first().locator('button').click();

  const detail = page.locator('#detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('h2')).toHaveText('Robert Louis Stevenson Museum');
  await expect(detail).toContainText('Museum');
  // The editorial blurb was joined onto the OSM feature.
  await expect(detail).toContainText('Tusitala');
  // Contact details survived the pipeline.
  await expect(detail.locator('a[href="tel:+68520798"]')).toBeVisible();
  await expect(detail.locator('a[href="https://www.rlsmuseum.org/"]')).toBeVisible();
  // Provenance is always on show.
  await expect(detail).toContainText('View on OpenStreetMap');
  await expect(detail.locator('a[href*="openstreetmap.org/way/2002"]')).toBeVisible();
});

test('search supports keyboard navigation', async ({ page }) => {
  await open(page);
  const input = page.locator('#searchInput');
  await input.fill('market');
  await expect(page.locator('#searchResults [role="option"]').first()).toBeVisible();
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page.locator('#detail')).toBeVisible();
});

test('search folds Samoan diacritics', async ({ page }) => {
  await open(page);
  await page.locator('#searchInput').fill('amanaki cafe');   // data has "Amanaki Café"
  await expect(page.locator('#searchResults [role="option"]').first()).toContainText('Amanaki');
});

test('category filters change what is listed', async ({ page }) => {
  await open(page);
  const results = page.locator('#results .result');
  const before = await results.count();

  await page.locator('.chip[data-cat="money"]').click();
  await expect(page.locator('.chip[data-cat="money"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#results')).not.toContainText('Bank of South Pacific');
  expect(await results.count()).toBeLessThan(before);

  await page.locator('#filterReset').click();
  await expect(page.locator('#results')).toContainText('Bank of South Pacific');
  expect(await results.count()).toBe(before);
});

test('selecting a place is reflected in the URL and survives a reload', async ({ page }) => {
  await open(page);

  await page.locator('#results .result', { hasText: 'Apia Clock Tower' }).click();
  await expect(page.locator('#detail h2')).toHaveText('Apia Clock Tower');

  await expect.poll(() => page.url()).toContain('sel=n1008');

  const url = page.url();
  await page.goto(url);
  await expect(page.locator('#loading')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#detail h2')).toHaveText('Apia Clock Tower');
});

test('the practical guide opens with sourced information', async ({ page }) => {
  await open(page);
  await page.locator('#guideBtn').click();

  const dlg = page.locator('#guideDlg');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Emergency: dial 911');
  await expect(dlg).toContainText('UTC+13');
  await expect(dlg).toContainText('Savalalo bus terminal is being rebuilt');
  // Claims carry a link back to where they came from.
  await expect(dlg.locator('.src a').first()).toHaveAttribute('href', /^https:\/\//);
  await expect(dlg).toContainText('last checked');
});

test('the data panel is honest about where the map comes from', async ({ page }) => {
  await open(page);
  await page.locator('#dataBtn').click();

  const dlg = page.locator('#dataDlg');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('OpenStreetMap');
  await expect(dlg).toContainText('ODbL');
  await expect(dlg).toContainText(String(fixture.features.length));
  await expect(dlg).toContainText('nothing is hand-placed');
});

test('the basemap panel offers the self-hosted vector option', async ({ page }) => {
  await open(page);
  await page.locator('#layersBtn').click();
  const dlg = page.locator('#layersDlg');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('[data-basemap]')).toHaveCount(3);
  await expect(dlg).toContainText('pmtiles');
});

test('works on a phone-sized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);

  await expect(page.locator('#sidebar')).toBeVisible();
  await page.locator('#results .result').first().click();
  await expect(page.locator('#detail')).toBeVisible();

  // The sheet gets out of the way when a place is opened on a small screen.
  await expect(page.locator('#app')).toHaveAttribute('data-sidebar', 'closed');

  // No horizontal overflow.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('open-now filter narrows the list to places verifiably open', async ({ page }) => {
  await open(page);
  const results = page.locator('#results .result');
  const before = await results.count();

  await page.locator('#openNowChip').click();
  await expect(page.locator('#openNowChip')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#listTitle')).toHaveText(/Open now/);

  // Every remaining row must carry the Open badge — no "maybe open" entries.
  const after = await results.count();
  expect(after).toBeLessThan(before);
  for (let i = 0; i < after; i++) {
    await expect(results.nth(i).locator('.badge.open')).toBeVisible();
  }

  await page.locator('#openNowChip').click();
  expect(await results.count()).toBe(before);
});

test('sort control reorders the list', async ({ page }) => {
  await open(page);
  await page.locator('#sortMode').selectOption('az');
  const names = await page.locator('#results .res-name').allTextContents();
  const cleaned = names.map((n) => n.replace(/Open|Closed|Pick/g, '').trim());
  const sorted = [...cleaned].sort((a, b) => a.localeCompare(b));
  expect(cleaned).toEqual(sorted);
});

test('quick-find chips appear on empty search focus and run a search', async ({ page }) => {
  await open(page);
  await page.locator('#searchInput').click();
  const quicks = page.locator('.search-quicks .chip');
  await expect(quicks.first()).toBeVisible();
  await quicks.filter({ hasText: 'atm' }).click();
  await expect(page.locator('#searchInput')).toHaveValue('atm');
  await expect(page.locator('#searchResults [role="option"]').first()).toContainText('ATM');
});

test('a guided walk starts, steps through stops, and is honest about routing', async ({ page }) => {
  await open(page);
  await page.locator('#walksBtn').click();

  const dlg = page.locator('#walksDlg');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('not turn-by-turn');
  await dlg.locator('[data-walk]').first().click();

  const panel = page.locator('#walkPanel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.walk-progress')).toHaveText(/1 \/ \d+/);
  const firstStop = await panel.locator('.walk-body strong').textContent();

  await panel.locator('[data-act="next"]').click();
  await expect(panel.locator('.walk-progress')).toHaveText(/2 \/ \d+/);
  expect(await panel.locator('.walk-body strong').textContent()).not.toBe(firstStop);

  // The walk survives a reload via the URL.
  await expect.poll(() => page.url()).toContain('walk=');
  await page.goto(page.url());
  await expect(page.locator('#loading')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#walkPanel')).toBeVisible();
  await expect(page.locator('#walkPanel .walk-progress')).toHaveText(/2 \/ \d+/);

  await page.locator('#walkPanel [data-act="end"]').click();
  await expect(page.locator('#walkPanel')).toBeHidden();
});

test('keyboard help opens with ?', async ({ page }) => {
  await open(page);
  await page.keyboard.press('?');
  await expect(page.locator('#helpDlg')).toBeVisible();
  await expect(page.locator('#helpDlg')).toContainText('Focus search');
});

test('data age is shown in the sidebar', async ({ page }) => {
  await open(page);
  await expect(page.locator('#dataAge')).toContainText(/data:/);
});

test('the map actually draws pins — worker loads and the source renders', async ({ page }) => {
  await open(page);
  // This must query what MapLibre RENDERED, not what the DOM contains. The
  // failure it guards against: maplibre's separate worker file missing from
  // the production bundle, in which case the whole page works, the list works,
  // search works — and the map itself silently shows zero pins.
  const rendered = await page.evaluate(async () => {
    const m = window.__apia.map;
    const count = () => {
      try {
        return m.queryRenderedFeatures({ layers: ['poi', 'clusters'] }).length;
      } catch { return 0; }
    };
    for (let i = 0; i < 100 && count() === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return { features: count(), sourceLoaded: m.isSourceLoaded('poi') };
  });
  expect(rendered.sourceLoaded).toBe(true);
  expect(rendered.features).toBeGreaterThan(0);
});
