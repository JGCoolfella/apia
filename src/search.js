// Local search over the loaded dataset.
//
// Deliberately offline: no geocoding service is called, so search works with no
// network, has no usage policy attached to it, and only ever returns places that
// are actually on this map. Samoan macrons and the ʻokina are folded away so
// "Motootua", "Motoʻotua" and "Motoōtua" all find the same place.

const DIACRITICS = /[̀-ͯ]/g;
const OKINA = /[ʻʼ‘’']/g;

/**
 * Travel-vocabulary synonyms, expanded at query time. A visitor types the word
 * they think in, not the OSM tag: "gas" should find petrol stations, "cash"
 * should find ATMs. Expansions score lower than a direct hit so a place
 * literally named "Gas" would still win over a synonym match.
 */
export const SYNONYMS = {
  gas: ['petrol', 'fuel'], gasoline: ['petrol', 'fuel'], servo: ['petrol', 'fuel'],
  cash: ['atm', 'bank'], money: ['atm', 'bank'],
  grocery: ['supermarket'], groceries: ['supermarket'],
  food: ['restaurant', 'cafe'], eat: ['restaurant', 'cafe'], dinner: ['restaurant'],
  breakfast: ['cafe'], coffee: ['cafe'],
  beer: ['bar', 'pub'], drink: ['bar', 'pub'],
  doctor: ['clinic', 'hospital', 'doctors'], medical: ['clinic', 'hospital', 'pharmacy'],
  chemist: ['pharmacy'], drugstore: ['pharmacy'],
  boat: ['ferry', 'wharf'], ship: ['ferry'],
  plane: ['airport'], flight: ['airport'], flights: ['airport'],
  bus: ['bus stop', 'bus terminal'],
  sleep: ['hotel', 'guest house', 'resort'], accommodation: ['hotel', 'guest house', 'resort'],
  swim: ['beach', 'swimming pool'], snorkel: ['reef', 'beach', 'marine'],
  souvenir: ['market', 'handicraft', 'gift'], souvenirs: ['market', 'handicraft', 'gift'],
  police: ['police station'], embassy: ['embassy', 'high commission'],
  wifi: ['internet'], sim: ['mobile phone', 'telecommunication'],
};

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
 * True when two words are within Damerau-Levenshtein distance 1 of each other
 * (one substitution, insertion, deletion, or adjacent transposition). Cheap
 * closed-form check - no DP matrix needed for distance <= 1.
 */
export function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    // One substitution, or one adjacent transposition.
    let i = 0;
    while (i < la && a[i] === b[i]) i++;
    if (i === la) return true;
    if (a.slice(i + 1) === b.slice(i + 1)) return true;                       // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // transposition
  }
  // One insertion/deletion: align the longer against the shorter.
  const [sh, lo] = la < lb ? [a, b] : [b, a];
  let i = 0;
  while (i < sh.length && sh[i] === lo[i]) i++;
  return sh.slice(i) === lo.slice(i + 1);
}

/** Score one term against one folded name. */
function scoreTermAgainstName(term, n) {
  if (n.folded === term) return 100;
  // A term that is a whole word of the name beats one that merely starts a
  // longer word: searching "stevenson" wants Robert Louis Stevenson's Museum,
  // not Stevensons Law Office.
  if (n.words.includes(term)) return 80;
  if (n.folded.startsWith(term)) return 70;
  if (n.words.some((w) => w.startsWith(term))) return 55;
  if (n.folded.includes(term)) return 35;
  return 0;
}

/**
 * Rank matches: whole-name match beats name prefix beats word prefix beats a
 * loose substring anywhere in the record; synonyms and one-typo fuzzy matches
 * trail exact matches. Ties break on OSM prominence.
 */
export function search(index, rawQuery, limit = 40) {
  const q = fold(rawQuery);
  if (q.length < 1) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const out = [];

  // Pre-expand synonyms once per query, not once per entry. The key lookup
  // itself tolerates one typo ("flighht" still means flight) - keys are long
  // English words, so a one-edit collision is vanishingly unlikely.
  const expansions = terms.map((t) => {
    let syns = SYNONYMS[t];
    if (!syns && t.length >= 5) {
      const near = Object.keys(SYNONYMS).find((k) => k.length >= 5 && withinOneEdit(t, k));
      if (near) syns = SYNONYMS[near];
    }
    return (syns || []).flatMap((x) => fold(x).split(/\s+/));
  });

  for (const entry of index) {
    let score = 0;
    let matchedAll = true;

    for (let ti = 0; ti < terms.length; ti++) {
      const term = terms[ti];
      let best = 0;

      for (const n of entry.names) {
        const sc = scoreTermAgainstName(term, n);
        if (sc > best) best = sc;
      }

      // Synonyms: the word the visitor typed, mapped to what the data calls
      // it. Scored at 70% so a literal match always outranks an interpretation.
      if (best < 50) {
        for (const syn of expansions[ti]) {
          for (const n of entry.names) {
            const sc = scoreTermAgainstName(syn, n) * 0.7;
            if (sc > best) best = sc;
          }
          if (best < 20 && entry.haystackWords.includes(syn)) best = 18;
        }
      }

      // Typo tolerance: one edit, only for words long enough that a single
      // slip is overwhelmingly a typo rather than a different word. Short
      // Samoan words are one edit from each other constantly - never fuzzy
      // them.
      if (best === 0 && term.length >= 5) {
        for (const n of entry.names) {
          if (n.words.some((w) => w.length >= 5 && withinOneEdit(term, w))) { best = 40; break; }
        }
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

/**
 * Split a display name into segments, flagging the parts the query matched, so
 * the UI can highlight them. Works on the ORIGINAL string: folding changes
 * character offsets (the okina and possessives are dropped), so a per-character
 * map from folded position back to original position is kept while folding.
 * Returns [{ text, hit }] covering the whole name, in order.
 */
export function matchSegments(name, rawQuery) {
  const terms = fold(rawQuery).split(/\s+/).filter(Boolean);
  if (!terms.length) return [{ text: name, hit: false }];

  const map = [];
  let folded = '';
  for (let i = 0; i < name.length; i++) {
    const f = fold(name[i]);
    for (const ch of f) { folded += ch; map.push(i); }
  }

  const hits = new Array(name.length).fill(false);
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at === -1) break;
      for (let i = map[at]; i <= map[at + term.length - 1]; i++) hits[i] = true;
      from = at + 1;
    }
  }

  const segments = [];
  for (let i = 0; i < name.length; i++) {
    const last = segments[segments.length - 1];
    if (last && last.hit === hits[i]) last.text += name[i];
    else segments.push({ text: name[i], hit: hits[i] });
  }
  return segments;
}
