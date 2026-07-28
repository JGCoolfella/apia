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
  // Arrive as a returning visitor: the one-time intro flyover and welcome card
  // have been seen, so the viewport is still and nothing overlays the map.
  await page.addInitScript(() => {
    localStorage.setItem('apia-map:seen-intro', '1');
    localStorage.setItem('apia-map:welcomed', '1');
  });
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

test('search highlights the matched part of a result and forgives typos', async ({ page }) => {
  await open(page);
  await page.locator('#searchInput').fill('stevensen');   // one-letter typo
  const first = page.locator('#searchResults [role="option"]').first();
  await expect(first).toContainText('Robert Louis Stevenson Museum');

  await page.locator('#searchInput').fill('clock');
  await expect(page.locator('#searchResults [role="option"] mark').first()).toHaveText(/clock/i);
});

test('recent searches reappear on the next empty focus', async ({ page }) => {
  await open(page);
  const input = page.locator('#searchInput');
  await input.fill('cathedral');
  await page.locator('#searchResults [role="option"] button').first().click();

  // The picked query stays in the box; clearing it is what returns you to the
  // quicks-and-recents view.
  await input.click();
  await page.locator('#searchClear').click();
  const recent = page.locator('.search-quicks.recents .chip').first();
  await expect(recent).toContainText('cathedral');
  await recent.click();
  await expect(input).toHaveValue('cathedral');
  await expect(page.locator('#searchResults [role="option"]').first()).toContainText('Immaculate');
});

test('right-click answers "what is near this point"', async ({ page }) => {
  await open(page);
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });

  const detail = page.locator('#detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('h2')).toHaveText('Near this point');
  const rows = detail.locator('.result');
  expect(await rows.count()).toBeGreaterThan(2);
  // Every row shows a distance from the clicked point.
  await expect(rows.first().locator('.res-dist')).toContainText(/m|km/);

  await rows.first().click();
  await expect(detail.locator('h2')).not.toHaveText('Near this point');
});

/** Stub the whole media pipeline: entity claims, article, geosearch, images. */
async function stubMedia(page, { photos = ['RLS Museum.jpg'], nearby = 3 } = {}) {
  await page.route(/www\.wikidata\.org\/w\/api\.php/, (route) => {
    const ids = new URL(route.request().url()).searchParams.get('ids')?.split('|') || [];
    const entities = {};
    for (const id of ids) {
      entities[id] = { claims: photos.length
        ? { P18: photos.map((f) => ({ mainsnak: { datavalue: { value: f } } })) }
        : {} };
    }
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entities }) });
  });

  await page.route(/wikipedia\.org\/api\/rest_v1/, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        extract: 'A test summary of the place from Wikipedia.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Test' } },
      }),
    }));

  await page.route(/commons\.wikimedia\.org\/w\/api\.php/, (route) => {
    const pages = {};
    for (let i = 0; i < nearby; i++) {
      pages[i] = {
        title: `File:Nearby ${i}.jpg`,
        imageinfo: [{
          thumburl: 'https://upload.wikimedia.org/thumb.png',
          url: 'https://upload.wikimedia.org/full.png',
          descriptionurl: `https://commons.wikimedia.org/wiki/File:Nearby_${i}.jpg`,
          extmetadata: { Artist: { value: 'Someone' }, LicenseShortName: { value: 'CC BY 4.0' } },
        }],
      };
    }
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ query: { pages } }) });
  });

  // Every image origin the app can pull from.
  await page.route(/commons\.wikimedia\.org\/wiki\/Special:FilePath|upload\.wikimedia\.org/, (route) =>
    route.fulfill({ contentType: 'image/png', body: BLANK_PNG }));
}

test('a linked place shows its own photo, its article and nearby photographs', async ({ page }) => {
  await stubMedia(page);
  await open(page);
  await page.locator('#searchInput').fill('stevenson museum');
  await page.locator('#searchResults [role="option"] button').first().click();

  // 1. The place's own picture leads the card, credited.
  const hero = page.locator('#detailHero');
  await expect(hero).toBeVisible();
  await expect(hero.locator('img')).toHaveAttribute('alt', /Robert Louis Stevenson/);
  await expect(hero.locator('a.photo-credit')).toHaveAttribute('href', /commons\.wikimedia\.org\/wiki\/File:/);

  // 2. The Wikipedia opening paragraph.
  await expect(page.locator('#detailArticle')).toContainText('A test summary');

  // 3. Nearby photographs, labelled as *near*, not *of*.
  const strip = page.locator('.nearby-photos');
  await expect(strip).toBeVisible();
  await expect(strip.locator('h3')).toContainText(/near here/i);
  expect(await strip.locator('.photo-tile').count()).toBeGreaterThan(0);
});

test('the lightbox opens, navigates and closes', async ({ page }) => {
  await stubMedia(page, { photos: ['A.jpg', 'B.jpg'] });
  await open(page);
  await page.locator('#searchInput').fill('stevenson museum');
  await page.locator('#searchResults [role="option"] button').first().click();
  await expect(page.locator('#detailHero')).toBeVisible();

  await page.locator('.hero-expand').click();
  const lb = page.locator('#lightbox');
  await expect(lb).toBeVisible();
  await expect(lb.locator('figcaption')).toContainText('1 of 2');
  await expect(lb.locator('figcaption a')).toContainText('Wikimedia Commons');

  await page.keyboard.press('ArrowRight');
  await expect(lb.locator('figcaption')).toContainText('2 of 2');
  await page.keyboard.press('ArrowLeft');
  await expect(lb.locator('figcaption')).toContainText('1 of 2');

  await page.keyboard.press('Escape');
  await expect(lb).toBeHidden();
});

test('a place with no linked record shows no photo and is never looked up', async ({ page }) => {
  const askedFor = [];
  await page.route(/www\.wikidata\.org/, (route) => {
    const ids = new URL(route.request().url()).searchParams.get('ids') || '';
    askedFor.push(...ids.split('|').filter(Boolean));
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entities: {} }) });
  });
  await page.route(/commons\.wikimedia\.org|wikipedia\.org|upload\.wikimedia\.org/, (r) => r.abort());

  await open(page);
  await page.locator('#searchInput').fill('amanaki');
  await page.locator('#searchResults [role="option"] button').first().click();
  await expect(page.locator('#detail h2')).toHaveText('Amanaki Café');
  await expect(page.locator('#detailHero')).toBeHidden();

  // The batch may run for other, linked places — but this café contributes no
  // identifier to it, which is exactly why it can never receive a photo.
  const cafeQid = await page.evaluate(() =>
    window.__apia.all.find((f) => f.properties.name.startsWith('Amanaki'))?.properties.wikidata);
  expect(cafeQid).toBeUndefined();
  expect(askedFor).not.toContain(undefined);
});

test('list rows show a thumbnail for places that have one', async ({ page }) => {
  await stubMedia(page);
  await open(page);
  // The batch prefetch runs after boot, then re-renders the list.
  await expect(page.locator('#results .result.has-thumb img').first()).toBeVisible({ timeout: 15_000 });
});

test('the 3D tilt control pitches the map and back', async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => window.__apia.map.getPitch())).toBe(0);
  await page.locator('#pitchBtn').click();
  await expect.poll(() => page.evaluate(() => window.__apia.map.getPitch())).toBeGreaterThan(30);
  await page.locator('#pitchBtn').click();
  await expect.poll(() => page.evaluate(() => window.__apia.map.getPitch())).toBe(0);
});

test.describe('intro flyover', () => {
  /** A genuinely first-time visitor: no seen-intro flag. */
  const openFresh = async (page) => {
    await page.goto('/');
    await expect(page.locator('#loading')).toBeHidden({ timeout: 20_000 });
  };

  test('plays on a first visit and settles level at the default view', async ({ page }) => {
    await openFresh(page);
    // It starts pitched and zoomed out...
    const early = await page.evaluate(() => ({
      pitch: window.__apia.map.getPitch(), zoom: window.__apia.map.getZoom(),
    }));
    expect(early.pitch).toBeGreaterThan(10);
    // ...and ends level, at the intended view.
    await expect.poll(() => page.evaluate(() => window.__apia.map.getPitch()), { timeout: 8000 }).toBe(0);
    const zoom = await page.evaluate(() => window.__apia.map.getZoom());
    expect(Math.abs(zoom - 13.5)).toBeLessThan(0.2);
  });

  test('aborts the moment the user touches the map', async ({ page }) => {
    // An animation you cannot interrupt is an obstacle. Scrolling must win
    // immediately, not after three seconds of being flown somewhere.
    await openFresh(page);
    const box = await page.locator('#map').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);
    await expect.poll(() => page.evaluate(() => window.__apia.map.getPitch()), { timeout: 3000 }).toBe(0);
  });

  test('plays only once per browser, never again', async ({ page }) => {
    await openFresh(page);
    await expect.poll(() => page.evaluate(() => window.__apia.map.getPitch()), { timeout: 8000 }).toBe(0);
    // Second visit in the same browser: straight to the map, no animation.
    await page.reload();
    await expect(page.locator('#loading')).toBeHidden({ timeout: 20_000 });
    expect(await page.evaluate(() => window.__apia.map.getPitch())).toBe(0);
  });

  test('a deep link suppresses it entirely', async ({ page }) => {
    // The flourish must not fight a user who arrived somewhere specific.
    await page.goto('/#map=16.00/-13.83300/-171.76500');
    await expect(page.locator('#loading')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(600);
    const z = await page.evaluate(() => window.__apia.map.getZoom());
    expect(Math.abs(z - 16)).toBeLessThan(0.4);   // still where the link asked for
    expect(await page.evaluate(() => window.__apia.map.getPitch())).toBe(0);
  });
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

test('the measuring tape measures, freezes, and clears', async ({ page }) => {
  await open(page);
  const box = await page.locator('#map').boundingBox();

  await page.locator('#measureBtn').click();
  await expect(page.locator('#measureChip')).toContainText('Click the map');

  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height * 0.5);
  // Two points a third of a viewport apart must yield a real distance.
  await expect(page.locator('#measureChip strong')).toContainText(/(m|km)$/);
  const reading = await page.locator('#measureChip strong').textContent();
  expect(parseFloat(reading)).toBeGreaterThan(0);

  // While measuring, clicking a pin must not open a detail panel.
  await expect(page.locator('#detail')).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(page.locator('#measureChip')).toBeHidden();
  await expect(page.locator('#measureBtn')).toHaveAttribute('aria-pressed', 'false');
});

test('the welcome card appears once and can start a walk', async ({ page }) => {
  // A genuinely first visit: no flags set.
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden({ timeout: 20_000 });

  const card = page.locator('#welcome');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Tālofa');
  await expect(card).toContainText(/OpenStreetMap/);

  await card.locator('[data-w="walk"]').click();
  await expect(card).toBeHidden();
  await expect(page.locator('#walkPanel')).toBeVisible();   // straight into the walk

  // Never again in this browser.
  await page.reload();
  await expect(page.locator('#loading')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#welcome')).toBeHidden();
});

test('with the archive present the map upgrades itself to vector', async ({ page }) => {
  // The checkout now carries the real samoa.pmtiles; the boot probe must find
  // it and choose the self-hosted vector basemap without being asked.
  await open(page);
  const info = await page.evaluate(() => ({
    basemap: window.__apia.basemap,
    sources: Object.keys(window.__apia.map.getStyle().sources),
  }));
  expect(info.basemap).toBe('vector');
  expect(info.sources).toContain('protomaps');
});

test('without the vector archive the map falls back to raster tiles', async ({ page }) => {
  // A deployment without the archive (or an offline probe) must fall back
  // cleanly to raster — never a vector style pointed at nothing.
  await page.route('**/basemap/samoa.pmtiles', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'not here' }));
  await open(page);
  const info = await page.evaluate(() => ({
    basemap: window.__apia.basemap,
    sources: Object.keys(window.__apia.map.getStyle().sources),
  }));
  expect(info.basemap).not.toBe('vector');
  expect(info.sources).toContain('basemap');       // raster source
  expect(info.sources).not.toContain('protomaps'); // no phantom vector source
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
