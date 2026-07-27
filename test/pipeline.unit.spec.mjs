// Unit tests for the data pipeline and the pure helpers. No browser involved.

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify } from '../src/classify.js';
import { toGeoJSON, buildQuery, runOverpass } from '../src/overpass.js';
import { evaluateHours, distanceMeters, formatDistance, joinHighlights, matchesWords } from '../src/format.js';
import { buildIndex, search, fold } from '../src/search.js';
import { BBOX } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(await readFile(resolve(HERE, 'fixtures/overpass-sample.json'), 'utf8'));
const curated = JSON.parse(await readFile(resolve(HERE, '../public/data/curated.json'), 'utf8'));

test.describe('Overpass query', () => {
  test('uses (south,west,north,east) ordering, which is what Overpass expects', () => {
    const q = buildQuery(BBOX);
    expect(q).toContain(`(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})`);
    // Apia is south of the equator and west of Greenwich.
    expect(BBOX.south).toBeLessThan(0);
    expect(BBOX.west).toBeLessThan(0);
    expect(BBOX.south).toBeLessThan(BBOX.north);
    expect(BBOX.west).toBeLessThan(BBOX.east);
  });

  test('asks for nodes, ways and relations with representative centres', () => {
    const q = buildQuery(BBOX);
    expect(q).toContain('nwr[amenity]');
    expect(q).toContain('out center tags;');
  });
});

test.describe('Overpass mirror failover', () => {
  const ok = { elements: [{ type: 'node', id: 1, lat: -13.83, lon: -171.76, tags: { amenity: 'bank', name: 'A bank' } }] };
  const reply = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

  // Two attempts per endpoint with a 3s backoff would make these tests crawl.
  const fast = ['a', 'b', 'c'];

  test('falls through to the next mirror on an HTTP error', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return url === 'c' ? reply(ok) : reply('gateway timeout', 504);
    };
    const res = await runOverpass('q', fast, fetchImpl);
    expect(res.endpoint).toBe('c');
    expect(seen.filter((u) => u === 'a')).toHaveLength(2); // retried before moving on
  });

  test('rejects a mirror that answers 200 with zero elements', async () => {
    // This is the failure that shipped an empty map: an instance that is up and
    // returns valid JSON, but has no data loaded for the area.
    const fetchImpl = async (url) => (url === 'c' ? reply(ok) : reply({ elements: [] }));
    const res = await runOverpass('q', fast, fetchImpl);
    expect(res.endpoint).toBe('c');
    expect(res.json.elements).toHaveLength(1);
  });

  test('rejects a mirror that reports a runtime error in a remark', async () => {
    const fetchImpl = async (url) =>
      (url === 'c' ? reply(ok) : reply({ remark: 'runtime error: query timed out', elements: [] }));
    const res = await runOverpass('q', fast, fetchImpl);
    expect(res.endpoint).toBe('c');
  });

  test('rejects an HTML error page served with a 200', async () => {
    const fetchImpl = async (url) => (url === 'c' ? reply(ok) : reply('<html>502 Bad Gateway</html>'));
    const res = await runOverpass('q', fast, fetchImpl);
    expect(res.endpoint).toBe('c');
  });

  test('reports every endpoint and reason when all of them fail', async () => {
    const fetchImpl = async () => reply({ elements: [] });
    await expect(runOverpass('q', fast, fetchImpl)).rejects.toThrow(/Every Overpass endpoint failed/);
    await expect(runOverpass('q', fast, fetchImpl)).rejects.toThrow(/zero elements/);
  });

  test('never writes an empty dataset even if a mirror slips through', () => {
    // toGeoJSON is the last line of defence; fetch-osm.mjs refuses to write when
    // it returns nothing.
    expect(toGeoJSON({ elements: [] }).features).toHaveLength(0);
  });
});

test.describe('classify', () => {
  test('routes emergency services ahead of generic amenities', () => {
    expect(classify({ amenity: 'police' }).cat).toBe('emergency');
    expect(classify({ amenity: 'fire_station' }).cat).toBe('emergency');
    expect(classify({ amenity: 'hospital' }).cat).toBe('health');
  });

  test('keeps useful unnamed features and drops the rest', () => {
    expect(classify({ amenity: 'atm' }).keepUnnamed).toBe(true);
    expect(classify({ highway: 'bus_stop' }).keepUnnamed).toBe(true);
    expect(classify({ amenity: 'restaurant' }).keepUnnamed).toBeUndefined();
    expect(classify({ barrier: 'gate' })).toBeNull();
  });

  test('describes a place of worship by its denomination', () => {
    expect(classify({ amenity: 'place_of_worship', denomination: 'roman_catholic' }).kind)
      .toBe('Roman catholic church');
  });
});

test.describe('toGeoJSON', () => {
  const fc = toGeoJSON(sample);

  test('produces point features for both nodes and ways', () => {
    const names = fc.features.map((f) => f.properties.name);
    expect(names).toContain('Robert Louis Stevenson Museum'); // a way, via center
    expect(names).toContain('Apia Clock Tower');              // a node
    expect(fc.features.every((f) => f.geometry.type === 'Point')).toBe(true);
  });

  test('drops untagged noise but keeps unnamed ATMs', () => {
    const names = fc.features.map((f) => f.properties.name);
    expect(names).not.toContain(undefined);
    expect(names).toContain('ATM');            // unnamed amenity=atm, kept with a fallback name
    expect(fc.features.find((f) => f.properties.osm_id === 9001)).toBeUndefined(); // barrier=gate
    expect(fc.features.find((f) => f.properties.osm_id === 9002)).toBeUndefined(); // amenity=bench
  });

  test('gives every feature a unique id prefixed by OSM type', () => {
    const ids = fc.features.map((f) => f.properties.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('n1001');
    expect(ids).toContain('w2002');
  });

  test('never flips the hemisphere', () => {
    for (const f of fc.features) {
      const [lng, lat] = f.geometry.coordinates;
      expect(lat).toBeLessThan(0);
      expect(lng).toBeLessThan(0);
    }
  });

  test('preserves contact details and the Samoan name', () => {
    const cafe = fc.features.find((f) => f.properties.name === 'Amanaki Café');
    expect(cafe.properties.name_sm).toBe('Fale Kofe Amanaki');
    expect(cafe.properties.cat).toBe('food');
    const museum = fc.features.find((f) => f.properties.name.startsWith('Robert Louis'));
    expect(museum.properties.website).toBe('https://www.rlsmuseum.org/');
    expect(museum.properties.phone).toBe('+685 20798');
  });
});

test.describe('opening hours', () => {
  // Fixed instants, expressed in UTC. Apia is UTC+13, so 2026-07-21T22:00Z is
  // Wednesday 11:00 local.
  const wedMorning = new Date('2026-07-21T22:00:00Z');
  const wedNight = new Date('2026-07-22T09:00:00Z');   // Wed 22:00 local
  const sunday = new Date('2026-07-25T22:00:00Z');     // Sunday 11:00 local

  test('reports open during a weekday window', () => {
    expect(evaluateHours('Mo-Fr 09:00-16:00', wedMorning).state).toBe('open');
  });

  test('reports closed outside it', () => {
    expect(evaluateHours('Mo-Fr 09:00-16:00', wedNight).state).toBe('closed');
  });

  test('treats a day the rule does not list as closed', () => {
    expect(evaluateHours('Mo-Fr 09:00-16:00', sunday).state).toBe('closed');
  });

  test('picks the rule that covers today out of several', () => {
    const satMorning = new Date('2026-07-24T22:00:00Z'); // Saturday 11:00 local
    expect(evaluateHours('Mo-Fr 09:00-16:00; Sa 09:00-12:00', satMorning).state).toBe('open');
    expect(evaluateHours('Mo-Fr 09:00-16:00; Sa 09:00-12:00', wedNight).state).toBe('closed');
  });

  test('honours an explicit closure', () => {
    expect(evaluateHours('Mo-Sa 09:00-16:00; Su off', sunday).state).toBe('closed');
  });

  test('says unknown rather than guessing at grammar it cannot parse', () => {
    expect(evaluateHours('24/7', wedNight).state).toBe('open');
    // A wrong "closed" here would send someone away from an open pharmacy.
    expect(evaluateHours('Mo-Su 10:00-14:00 open "by appointment"', wedMorning).state).toBe('unknown');
    expect(evaluateHours('Mo-Fr 08:00-16:00; PH off', wedMorning).state).toBe('unknown');
    expect(evaluateHours('Apr-Oct 09:00-17:00', wedMorning).state).toBe('unknown');
    expect(evaluateHours('sunrise-sunset', wedMorning).state).toBe('unknown');
    expect(evaluateHours(undefined, wedNight).state).toBe('unknown');
  });
});

test.describe('distance', () => {
  test('measures a known short hop across central Apia', () => {
    // Two fixture points about 300 m apart; assert the order of magnitude only.
    const d = distanceMeters([-171.7640, -13.8340], [-171.7668, -13.8352]);
    expect(d).toBeGreaterThan(200);
    expect(d).toBeLessThan(500);
  });

  test('formats sensibly at each scale', () => {
    expect(formatDistance(120)).toBe('120 m');
    expect(formatDistance(2400)).toBe('2.4 km');
    expect(formatDistance(35000)).toBe('35 km');
  });
});

test.describe('search', () => {
  const fc = toGeoJSON(sample);
  const index = buildIndex(fc.features);

  test('folds macrons and the okina', () => {
    expect(fold('Motoʻotua')).toBe('motootua');
    expect(fold('Sāmoa')).toBe('samoa');
  });

  test('finds a place by a prefix of its name', () => {
    const r = search(index, 'stev');
    expect(r[0].properties.name).toBe('Robert Louis Stevenson Museum');
  });

  test('finds a place by a later word', () => {
    const r = search(index, 'clock');
    expect(r[0].properties.name).toBe('Apia Clock Tower');
  });

  test('matches on category words too', () => {
    const r = search(index, 'hospital');
    expect(r[0].properties.name).toContain('Hospital');
  });

  test('returns nothing for a term that is not in the data', () => {
    expect(search(index, 'zzzznotathing')).toHaveLength(0);
  });
});

test.describe('editorial join', () => {
  const fc = toGeoJSON(sample);
  const joined = joinHighlights(fc.features, curated.highlights);

  test('attaches blurbs to the OSM object they describe', () => {
    const museum = fc.features.find((f) => f.properties.name.startsWith('Robert Louis'));
    expect(joined.get(museum.properties.id)?.id).toBe('rls-museum');

    const cathedral = fc.features.find((f) => f.properties.name.includes('Immaculate'));
    expect(joined.get(cathedral.properties.id)?.id).toBe('mulivai-cathedral');
  });

  test('prefers a real destination over a bus stop named after it', () => {
    const fleaMarket = fc.features.find((f) => f.properties.name === 'Savalalo Flea Market');
    const busStop = fc.features.find((f) => f.properties.name === 'Savalalo Terminal');
    expect(joined.has(fleaMarket.properties.id)).toBe(true);
    expect(joined.has(busStop.properties.id)).toBe(false);
  });

  test('matches whole words, not syllables inside other names', () => {
    // The bug this prevents: "vaea" matching the suburb "Lalovaea", which put the
    // Mount Vaea / Stevenson's tomb blurb on an unrelated place.
    expect(matchesWords('lalovaea', 'vaea')).toBe(false);
    expect(matchesWords('mount vaea', 'vaea')).toBe(true);
    expect(matchesWords('cathedral of the immaculate conception', 'immaculate conception')).toBe(true);

    const lalovaea = fc.features.find((f) => f.properties.name === 'Lalovaea');
    const mtVaea = fc.features.find((f) => f.properties.name === 'Mount Vaea');
    expect(joined.get(lalovaea.properties.id)).toBeUndefined();
    expect(joined.get(mtVaea.properties.id)?.id).toBe('mt-vaea');
  });

  test('will not put a blurb on a village that shares the place name', () => {
    // Motoʻotua is both the hospital's suburb and a place node; Faleolo is both
    // the airport and a village. The blurbs belong on the facility, not the area.
    const hospital = fc.features.find((f) => f.properties.cat === 'health');
    const suburb = fc.features.find((f) => f.properties.name === 'Motoʻotua');
    expect(joined.get(hospital.properties.id)?.id).toBe('hospital');
    expect(joined.get(suburb.properties.id)).toBeUndefined();

    const airport = fc.features.find((f) => f.properties.kind === 'Airport');
    const village = fc.features.find((f) => f.properties.name === 'Faleolo' && f.properties.cat === 'places');
    expect(joined.get(airport.properties.id)?.id).toBe('faleolo');
    expect(joined.get(village.properties.id)).toBeUndefined();
  });

  test('every highlight declares the categories it may attach to', () => {
    // Without this, a highlight falls back to loose matching across all 2,400+
    // features and can land anywhere.
    for (const h of curated.highlights) {
      expect(Array.isArray(h.cat), `${h.id} has no cat`).toBe(true);
      expect(h.cat.length).toBeGreaterThan(0);
    }
  });

  test('carries no coordinates of its own', () => {
    const text = JSON.stringify(curated);
    expect(text).not.toMatch(/"(lat|lon|lng|latitude|longitude|coordinates)"\s*:/);
  });
});
