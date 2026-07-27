// Local search over the loaded dataset.
//
// Deliberately offline: no geocoding service is called, so search works with no
// network, has no usage policy attached to it, and only ever returns places that
// are actually on this map. Samoan macrons and the ʻokina are folded away so
// "Motootua", "Motoʻotua" and "Motoōtua" all find the same place.

const DIACRITICS = /[̀-ͯ]/g;
const OKINA = /[ʻʼ‘’']/g;

export function fold(s = '') {
  return String(s)
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .replace(OKINA, '')
    .toLowerCase()
    .trim();
}

/** Build a searchable index once per dataset load. */
export function buildIndex(features) {
  return features.map((f) => {
    const p = f.properties;
    const haystack = [p.name, p.name_sm, p.kind, p.operator, p.cuisine, p.addr, p.tags?.brand]
      .filter(Boolean)
      .join(' · ');
    return {
      feature: f,
      id: p.id,
      name: p.name,
      folded: fold(p.name),
      words: fold(haystack).split(/[^a-z0-9]+/).filter(Boolean),
      haystackFolded: fold(haystack),
      rank: p.rank ?? 5,
    };
  });
}

/**
 * Rank matches: whole-name match beats name prefix beats word prefix beats a
 * loose substring anywhere in the record. Ties break on OSM prominence.
 */
export function search(index, rawQuery, limit = 40) {
  const q = fold(rawQuery);
  if (q.length < 1) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const out = [];

  for (const entry of index) {
    let score = 0;
    let matchedAll = true;

    for (const term of terms) {
      let best = 0;
      if (entry.folded === term) best = 100;
      else if (entry.folded.startsWith(term)) best = 80;
      else if (entry.words.some((w) => w === term)) best = 65;
      else if (entry.words.some((w) => w.startsWith(term))) best = 50;
      else if (entry.folded.includes(term)) best = 35;
      else if (entry.haystackFolded.includes(term)) best = 18;
      if (best === 0) { matchedAll = false; break; }
      score += best;
    }
    if (!matchedAll) continue;

    score += Math.max(0, 8 - entry.rank);
    score -= Math.min(10, entry.name.length / 12); // prefer the shorter, more exact name
    out.push({ entry, score });
  }

  out.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return out.slice(0, limit).map((r) => r.entry.feature);
}
