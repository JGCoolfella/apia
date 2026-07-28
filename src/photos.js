// Imagery and encyclopaedic context for places, resolved from open sources.
//
// Three distinct pipelines, kept separate because they make different claims:
//
//   1. resolvePhotos(qid)     - the place's OWN photographs. From its Wikidata
//                               entity's P18 (image) and P5252 claims. This is
//                               a picture OF this place, chosen by the Wikidata
//                               community.
//   2. resolveArticle(tag)    - the opening paragraph of the place's Wikipedia
//                               article, plus that article's lead image.
//   3. photosNear(coords)     - photographs GEOTAGGED near a point, via Commons
//                               geosearch. These are pictures taken nearby, NOT
//                               necessarily of the place, and the UI must say so.
//
// Everything is keyed off the place's own linked identifiers or its coordinates
// — never its name — so an image can never be attached to the wrong place by a
// fuzzy title match. No API keys; all endpoints are CORS-open and free.

const CACHE_KEY = 'apia-map:media:v2';
const CACHE_TTL = 7 * 24 * 3600 * 1000;

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
}
let cache = readCache();
let writeTimer = null;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* nicety */ }
  }, 400);
}
function cached(key) {
  const hit = cache[key];
  return hit && Date.now() - hit.t < CACHE_TTL ? hit.v : undefined;
}
function store(key, v) { cache[key] = { v, t: Date.now() }; persist(); }

export function clearMediaCache() {
  cache = {};
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}

/** Commons file name -> the URLs we need. */
export function commonsUrls(file, width = 800) {
  const enc = encodeURIComponent(String(file).replace(/ /g, '_'));
  return {
    file,
    thumb: `https://commons.wikimedia.org/wiki/Special:FilePath/${enc}?width=${width}`,
    full: `https://commons.wikimedia.org/wiki/Special:FilePath/${enc}?width=1600`,
    page: `https://commons.wikimedia.org/wiki/File:${enc}`,
  };
}

// ---------------------------------------------------------------------------
// 1. The place's own photographs, from Wikidata
// ---------------------------------------------------------------------------

const PHOTO_PROPS = ['P18', 'P5252', 'P3451', 'P8592']; // image, winter/aerial variants

/**
 * Batch-resolve many Wikidata entities at once. wbgetentities takes up to 50
 * ids per call, so a whole map's worth of landmarks costs one request rather
 * than one per place — which is what makes list thumbnails affordable.
 *
 * @param {string[]} qids
 * @returns {Promise<Map<string, string[]>>} qid -> Commons file names
 */
export async function resolvePhotosBatch(qids, fetchImpl = fetch) {
  const out = new Map();
  const need = [];
  for (const q of [...new Set(qids)].filter((q) => /^Q\d+$/.test(q || ''))) {
    const hit = cached(`wd:${q}`);
    if (hit !== undefined) { if (hit.length) out.set(q, hit); } else need.push(q);
  }
  if (!need.length) return out;

  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    try {
      const url = 'https://www.wikidata.org/w/api.php?action=wbgetentities'
        + `&ids=${chunk.join('|')}&props=claims&format=json&origin=*`;
      const res = await fetchImpl(url);
      if (!res.ok) continue;              // transient: do not cache a failure
      const json = await res.json();
      for (const q of chunk) {
        const claims = json?.entities?.[q]?.claims || {};
        const files = PHOTO_PROPS
          .flatMap((p) => (claims[p] || []).map((c) => c?.mainsnak?.datavalue?.value))
          .filter((v) => typeof v === 'string');
        const unique = [...new Set(files)];
        store(`wd:${q}`, unique);
        if (unique.length) out.set(q, unique);
      }
    } catch { /* offline or blocked - photos are an enhancement, never required */ }
  }
  return out;
}

/** Single-entity convenience wrapper. */
export async function resolvePhotos(qid, fetchImpl = fetch) {
  const m = await resolvePhotosBatch([qid], fetchImpl);
  return (m.get(qid) || []).map((f) => commonsUrls(f));
}

// ---------------------------------------------------------------------------
// 2. Wikipedia article summary
// ---------------------------------------------------------------------------

/**
 * @param {string} tag OSM `wikipedia` tag, e.g. "en:Apia" or "de:Saoluafata"
 * @returns {Promise<{extract:string, url:string, lang:string, thumb?:string}|null>}
 */
export async function resolveArticle(tag, fetchImpl = fetch) {
  const m = /^([a-z-]{2,10}):(.+)$/.exec(tag || '');
  if (!m) return null;
  const [, lang, title] = m;

  const key = `wp:${lang}:${title}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;

  try {
    const res = await fetchImpl(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.extract) return null;
    const value = {
      extract: json.extract,
      url: json.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      lang,
      thumb: json.thumbnail?.source,
    };
    store(key, value);
    return value;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. Photographs geotagged near a point, from Commons
// ---------------------------------------------------------------------------

/**
 * Commons images whose own geotag falls within `radius` metres of the point.
 *
 * These are pictures taken NEAR the place, not pictures OF it — a distinction
 * the interface has to keep, because a photo of the harbour taken from a café
 * terrace is not a photo of the café.
 *
 * @returns {Promise<Array<{thumb:string, full:string, page:string, title:string,
 *   artist?:string, licence?:string, metres:number}>>}
 */
export async function photosNear([lng, lat], { radius = 400, limit = 12, fetchImpl = fetch } = {}) {
  const key = `geo:${lat.toFixed(4)},${lng.toFixed(4)},${radius}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;

  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*'
    + '&generator=geosearch&ggsnamespace=6'
    + `&ggscoord=${lat}|${lng}&ggsradius=${radius}&ggslimit=${limit}`
    + '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=400'
    + '&iiextmetadatafilter=Artist|LicenseShortName';

  try {
    const res = await fetchImpl(url);
    if (!res.ok) return [];
    const json = await res.json();
    const pages = Object.values(json?.query?.pages || {});
    const out = pages.map((p) => {
      const info = p.imageinfo?.[0] || {};
      const meta = info.extmetadata || {};
      return {
        title: String(p.title || '').replace(/^File:/, ''),
        thumb: info.thumburl,
        full: info.url,
        page: info.descriptionurl,
        artist: stripHtml(meta.Artist?.value),
        licence: meta.LicenseShortName?.value,
        metres: Math.round(p.index != null ? 0 : 0),
      };
    }).filter((p) => p.thumb);
    store(key, out);
    return out;
  } catch {
    return [];
  }
}

function stripHtml(s) {
  if (!s) return undefined;
  const t = String(s).replace(/<[^>]*>/g, '').trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t || undefined;
}
