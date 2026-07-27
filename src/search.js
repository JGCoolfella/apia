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

/**
 * Build a searchable index once per dataset load.
 *
 * @param {object[]} features
 * @param {Map<string, string[]>} [extraAliases] feature id -> alternative names.
 *   Used to feed in the local names from the editorial layer: OpenStreetMap
 *   calls the main produce market "Fugalei Fresh Produce Market", but everyone
 *   in Apia calls it Maketi Fou, and a search for the name people actually use
 *   must find it.
 */
export function buildIndex(features, extraAliases) {
  return features.map((f) => {
    const p = f.properties;
    const t = p.tags || {};

    // Alternative names carry the same weight as the primary name. OSM's own
    // alt_name/old_name are included, so "Aggie Grey's" still finds a hotel
    // that has since been renamed.
    const aliases = [
      p.name_sm, t.alt_name, t.old_name, t.official_name, t.brand,
      ...(extraAliases?.get(p.id) || []),
    ].filter(Boolean);

    const haystack = [p.kind, p.operator, p.cuisine, p.addr].filter(Boolean).join(' · ');
    const names = [fold(p.name), ...aliases.map(fold)].filter(Boolean);

    return {
      feature: f,
      id: p.id,
      name: p.name,
      // Each name is matched independently and the best score wins.
      names: [...new Set(names)].map((n) => ({ folded: n, words: n.split(/[^a-z0-9]+/).filter(Boolean) })),
      // Category label, operator, cuisine, address. Kept separate from names:
      // treating them alike made searching "hospital" rank a clinic called
      // "Emergency Department" above every building actually named Hospital.
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
      for (const n of entry.names) {
        let s = 0;
        if (n.folded === term) s = 100;
        // A term that is a whole word of the name beats one that merely starts
        // a longer word: searching "stevenson" wants Robert Louis Stevenson's
        // Museum, not Stevensons Law Office.
        else if (n.words.includes(term)) s = 80;
        else if (n.folded.startsWith(term)) s = 70;
        else if (n.words.some((w) => w.startsWith(term))) s = 55;
        else if (n.folded.includes(term)) s = 35;
        if (s > best) best = s;
      }
      // Category, operator, cuisine and address only - a much weaker signal.
      if (best === 0 && entry.haystackWords.includes(term)) best = 25;
      else if (best === 0 && entry.haystackFolded.includes(term)) best = 18;
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
