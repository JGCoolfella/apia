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
    // English possessives are dropped whole, so "Robert Louis Stevenson's
    // Museum" folds to "...stevenson museum" and matches a search for
    // "stevenson museum". Stripping only the apostrophe would leave
    // "stevensons", which then fails whole-word matching. Samoan's okina is
    // always followed by a vowel, so this never touches names like Papase'ea.
    .replace(/[ʻʼ‘’']s(?![a-z])/gi, '')
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
    const folded = fold(p.name);
    return {
      feature: f,
      id: p.id,
      name: p.name,
      folded,
      // Words of the name proper. Kept separate from the haystack: the haystack
      // includes the category label, so treating them alike made searching
      // "hospital" rank a clinic called "Emergency Department" above every
      // building actually named Hospital.
      nameWords: folded.split(/[^a-z0-9]+/).filter(Boolean),
      haystackFolded: fold(haystack),
      haystackWords: fold(haystack).split(/[^a-z0-9]+/).filter(Boolean),
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
      // A term that is a whole word of the name beats one that merely starts a
      // longer word: searching "stevenson" wants Robert Louis Stevenson's
      // Museum, not Stevensons Law Office.
      else if (entry.nameWords.includes(term)) best = 80;
      else if (entry.folded.startsWith(term)) best = 70;
      else if (entry.nameWords.some((w) => w.startsWith(term))) best = 55;
      else if (entry.folded.includes(term)) best = 35;
      // Category, operator, cuisine and address only - a much weaker signal.
      else if (entry.haystackWords.includes(term)) best = 25;
      else if (entry.haystackFolded.includes(term)) best = 18;
      if (best === 0) { matchedAll = false; break; }
      score += best;
    }
    if (!matchedAll) continue;

    // Prominence matters on a map: a museum outranks an office when both match.
    score += Math.max(0, 8 - entry.rank) * 3;
    score -= Math.min(10, entry.name.length / 12); // prefer the shorter, more exact name
    out.push({ entry, score });
  }

  out.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return out.slice(0, limit).map((r) => r.entry.feature);
}
