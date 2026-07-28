// Unit tests for the media pipeline. No network: fetch is stubbed throughout.

import { test, expect } from '@playwright/test';

// localStorage does not exist in Node; the module caches through it.
globalThis.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

const { resolvePhotosBatch, resolveArticle, photosNear, commonsUrls, clearMediaCache } =
  await import('../src/photos.js');

const jsonReply = (body) => ({ ok: true, status: 200, json: async () => body });

test.beforeEach(() => clearMediaCache());

test.describe('Commons URLs', () => {
  test('encodes a file name into thumbnail, full and description URLs', () => {
    const u = commonsUrls('Apia Clock Tower.jpg', 400);
    expect(u.thumb).toBe('https://commons.wikimedia.org/wiki/Special:FilePath/Apia_Clock_Tower.jpg?width=400');
    expect(u.page).toBe('https://commons.wikimedia.org/wiki/File:Apia_Clock_Tower.jpg');
    expect(u.full).toContain('width=1600');
  });

  test('escapes characters that would break the URL', () => {
    const u = commonsUrls('Café & Bar (Apia).jpg');
    expect(u.page).toContain('%26');            // ampersand
    expect(u.page).not.toContain(' ');
  });
});

test.describe('Wikidata photo batch', () => {
  test('resolves many entities in one request', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return jsonReply({
        entities: {
          Q1: { claims: { P18: [{ mainsnak: { datavalue: { value: 'One.jpg' } } }] } },
          Q2: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Two.jpg' } } }] } },
          Q3: { claims: {} },
        },
      });
    };
    const out = await resolvePhotosBatch(['Q1', 'Q2', 'Q3'], fetchImpl);
    expect(calls).toHaveLength(1);              // one call, not three
    expect(calls[0]).toContain('ids=Q1|Q2|Q3');
    expect(out.get('Q1')).toEqual(['One.jpg']);
    expect(out.has('Q3')).toBe(false);          // no image is not an entry
  });

  test('caches results, including the absence of an image', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return jsonReply({ entities: { Q9: { claims: {} } } }); };
    await resolvePhotosBatch(['Q9'], fetchImpl);
    await resolvePhotosBatch(['Q9'], fetchImpl);
    // A place with no picture must not be re-asked on every render.
    expect(calls).toBe(1);
  });

  test('does not cache a transient failure', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: false, status: 503, json: async () => ({}) }; };
    await resolvePhotosBatch(['Q7'], fetchImpl);
    await resolvePhotosBatch(['Q7'], fetchImpl);
    expect(calls).toBe(2);                      // retried, because 503 is not an answer
  });

  test('ignores anything that is not a Q-id', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return jsonReply({ entities: {} }); };
    const out = await resolvePhotosBatch([null, '', 'not-a-qid', 'P18'], fetchImpl);
    expect(out.size).toBe(0);
    expect(called).toBe(false);
  });

  test('survives a network error without throwing', async () => {
    const fetchImpl = async () => { throw new Error('offline'); };
    await expect(resolvePhotosBatch(['Q1'], fetchImpl)).resolves.toBeInstanceOf(Map);
  });
});

test.describe('Wikipedia article', () => {
  test('parses the OSM wikipedia tag and returns the summary', async () => {
    const fetchImpl = async (url) => {
      expect(url).toContain('https://en.wikipedia.org/api/rest_v1/page/summary/Apia');
      return jsonReply({
        extract: 'Apia is the capital of Samoa.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Apia' } },
        thumbnail: { source: 'https://upload.wikimedia.org/x.jpg' },
      });
    };
    const a = await resolveArticle('en:Apia', fetchImpl);
    expect(a.extract).toContain('capital of Samoa');
    expect(a.lang).toBe('en');
    expect(a.thumb).toContain('upload.wikimedia.org');
  });

  test('handles a non-English article, which OSM does carry here', async () => {
    // Saoluafata is tagged de:Saoluafata in the real Apia dataset.
    const fetchImpl = async (url) => {
      expect(url).toContain('https://de.wikipedia.org/');
      return jsonReply({ extract: 'Saoluafata ist ein Dorf.' });
    };
    const a = await resolveArticle('de:Saoluafata', fetchImpl);
    expect(a.lang).toBe('de');
  });

  test('rejects a malformed tag without calling out', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return jsonReply({}); };
    expect(await resolveArticle('Apia', fetchImpl)).toBeNull();
    expect(await resolveArticle('', fetchImpl)).toBeNull();
    expect(called).toBe(false);
  });
});

test.describe('Commons geosearch', () => {
  test('asks for images near the coordinate and normalises them', async () => {
    const fetchImpl = async (url) => {
      expect(url).toContain('generator=geosearch');
      expect(url).toContain('ggscoord=-13.8333|-171.7667');
      expect(url).toContain('ggsradius=350');
      return jsonReply({
        query: {
          pages: {
            1: {
              title: 'File:Apia harbour.jpg',
              imageinfo: [{
                thumburl: 'https://upload.wikimedia.org/t.jpg',
                url: 'https://upload.wikimedia.org/f.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Apia_harbour.jpg',
                extmetadata: {
                  Artist: { value: '<a href="#">A Photographer</a>' },
                  LicenseShortName: { value: 'CC BY-SA 4.0' },
                },
              }],
            },
          },
        },
      });
    };
    const out = await photosNear([-171.7667, -13.8333], { radius: 350, fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Apia harbour.jpg');
    expect(out[0].artist).toBe('A Photographer');   // HTML stripped for safe rendering
    expect(out[0].licence).toBe('CC BY-SA 4.0');
  });

  test('drops entries with no usable thumbnail', async () => {
    const fetchImpl = async () => jsonReply({ query: { pages: { 1: { title: 'File:X.jpg', imageinfo: [{}] } } } });
    expect(await photosNear([-171.7, -13.8], { fetchImpl })).toHaveLength(0);
  });

  test('returns an empty list rather than throwing when offline', async () => {
    const fetchImpl = async () => { throw new Error('offline'); };
    expect(await photosNear([-171.7, -13.8], { fetchImpl })).toEqual([]);
  });
});
