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
 * Commons images whose own geotag falls within `radius` metres of the point,
 * each with its geotag coordinates, distance, mime type and subject categories
 * — everything the relevance engine needs to decide what a picture shows.
 *
 * @returns {Promise<Array<{title, thumb, full, page, artist?, licence?,
 *   metres:number, coords?:[lng,lat], mime?:string, categories:string[]}>>}
 */
export async function photosNear([lng, lat], { radius = 400, limit = 30, fetchImpl = fetch } = {}) {
  const key = `geo2:${lat.toFixed(4)},${lng.toFixed(4)},${radius}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;

  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*'
    + '&generator=geosearch&ggsnamespace=6'
    + `&ggscoord=${lat}|${lng}&ggsradius=${radius}&ggslimit=${limit}`
    + '&prop=imageinfo|coordinates|categories&coprimary=primary&cllimit=max&clshow=!hidden'
    + '&iiprop=url|mime|extmetadata&iiurlwidth=400'
    + '&iiextmetadatafilter=Artist|LicenseShortName';

  try {
    const res = await fetchImpl(url);
    if (!res.ok) return [];
    const json = await res.json();
    const pages = Object.values(json?.query?.pages || {});
    const out = pages.map((p) => {
      const info = p.imageinfo?.[0] || {};
      const meta = info.extmetadata || {};
      const co = p.coordinates?.[0];
      return {
        title: String(p.title || '').replace(/^File:/, ''),
        thumb: info.thumburl,
        full: info.url,
        page: info.descriptionurl,
        artist: stripHtml(meta.Artist?.value),
        licence: meta.LicenseShortName?.value,
        mime: info.mime,
        categories: (p.categories || []).map((c) => String(c.title || '').replace(/^Category:/, '')),
        coords: co ? [co.lon, co.lat] : undefined,
        metres: co ? Math.round(haversine([lng, lat], [co.lon, co.lat])) : radius,
      };
    }).filter((p) => p.thumb);
    out.sort((a, b) => a.metres - b.metres);
    store(key, out);
    return out;
  } catch {
    return [];
  }
}

function haversine([lng1, lat1], [lng2, lat2]) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(lat2 - lat1) / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function stripHtml(s) {
  if (!s) return undefined;
  const t = String(s).replace(/<[^>]*>/g, '').trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t || undefined;
}

// ---------------------------------------------------------------------------
// 4. Relevance: which nearby photographs actually show THIS place?
// ---------------------------------------------------------------------------

/** Files that are cartography or insignia, not photography. */
const JUNK_TITLE = /\b(map|maps|logo|flag|coat of arms|locator|diagram|plan|chart|stamp|seal|emblem|banknote|coin)\b/i;
const JUNK_MIME = new Set(['image/svg+xml', 'application/pdf', 'image/gif']);

/** Words too common around Samoa to indicate a subject on their own. */
const WEAK_TOKENS = new Set([
  'the', 'of', 'and', 'in', 'at', 'a', 'la', 'le', 'de', 'du', 'des',
  'samoa', 'samoan', 'upolu', 'savaii', 'apia', 'island', 'islands',
  'new', 'old', 'view', 'street', 'road', 'building', 'photo', 'img', 'image', 'file', 'jpg',
]);

function tokens(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[ʻʼ‘’']/g, '')
    .toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !WEAK_TOKENS.has(t) && !/^\d+$/.test(t));
}

/**
 * How strongly a photo's own metadata (title + subject categories) names the
 * place. This runs ONLY on photos already inside the place's geofence — the
 * geotag establishes "here"; the name similarity establishes "of", never the
 * other way round. Returns the count of significant matched tokens.
 */
export function photoNameScore(placeNames, photo) {
  const placeTokens = new Set(placeNames.flatMap(tokens));
  if (!placeTokens.size) return 0;
  const photoTokens = new Set([...tokens(photo.title), ...(photo.categories || []).flatMap(tokens)]);
  let hits = 0;
  for (const t of placeTokens) if (photoTokens.has(t)) hits++;
  return hits;
}

/**
 * Split geofenced photos into pictures OF the place and pictures AROUND it.
 *
 * "Of" needs both legs: inside the tight radius AND named for the place (or
 * practically on top of it — within `hugMetres`, where whatever the camera
 * pointed at, this place fills the frame or frames the shot). Junk files are
 * dropped entirely.
 *
 * @param {string[]} placeNames the place's name and known aliases
 */
export function classifyPhotos(placeNames, photos, { radius = 90, hugMetres = 35 } = {}) {
  const of = [];
  const around = [];
  for (const p of photos) {
    if (JUNK_MIME.has(p.mime) || JUNK_TITLE.test(p.title)) continue;
    const score = photoNameScore(placeNames, p);
    if (p.metres <= radius && (score >= 1 || p.metres <= hugMetres)) {
      of.push({ ...p, score });
    } else {
      around.push({ ...p, score });
    }
  }
  // Best-named first, closest breaking ties.
  of.sort((a, b) => (b.score - a.score) || (a.metres - b.metres));
  return { of, around };
}
