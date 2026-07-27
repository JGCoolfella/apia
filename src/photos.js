// Photographs for places, resolved through the place's own authority record.
//
// Many OSM objects carry a `wikidata` tag. That Wikidata entity's P18 claim is
// the community-chosen photograph of the place on Wikimedia Commons. Resolving
// pictures this way keeps the accuracy rule intact: a photo appears only when
// the place's own linked record has one — nothing is looked up by name, so a
// photo can never belong to the wrong place. No API keys, CORS-open endpoints,
// and every image links back to its Commons page for attribution.
//
// Results (including "no image") are cached in localStorage so a place is
// looked up at most once a week per browser.

const CACHE_KEY = 'apia-map:wd-photos:v1';
const CACHE_TTL = 7 * 24 * 3600 * 1000;
const THUMB_WIDTH = 640;

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
}

function writeCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* nicety only */ }
}

/**
 * @param {string} qid e.g. "Q106913447"
 * @returns {Promise<{thumbUrl: string, pageUrl: string}|null>} null when the
 *   entity has no image — a common and perfectly fine outcome.
 */
export async function resolvePhoto(qid) {
  if (!/^Q\d+$/.test(qid || '')) return null;

  const cache = readCache();
  const hit = cache[qid];
  if (hit && Date.now() - hit.t < CACHE_TTL) {
    return hit.file ? urlsFor(hit.file) : null;
  }

  let file = null;
  try {
    const res = await fetch(
      `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P18&format=json&origin=*`,
      { mode: 'cors' },
    );
    if (!res.ok) return null; // do not cache transient failures
    const json = await res.json();
    file = json?.claims?.P18?.[0]?.mainsnak?.datavalue?.value || null;
  } catch {
    return null;
  }

  cache[qid] = { file, t: Date.now() };
  writeCache(cache);
  return file ? urlsFor(file) : null;
}

function urlsFor(file) {
  const encoded = encodeURIComponent(file.replace(/ /g, '_'));
  return {
    // Special:FilePath serves a resized thumbnail and redirects to the actual
    // image host; both hosts are allowed in the deployed CSP.
    thumbUrl: `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=${THUMB_WIDTH}`,
    pageUrl: `https://commons.wikimedia.org/wiki/File:${encoded}`,
  };
}
