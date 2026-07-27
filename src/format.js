// Presentation helpers: opening hours, distances, phone links, OSM links and the
// name-based join between the editorial layer and OpenStreetMap features.

import { fold } from './search.js';
import { IANA_TZ } from './config.js';

export function escapeHTML(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Great-circle distance in metres. */
export function distanceMeters(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function formatDistance(m) {
  if (!isFinite(m)) return '';
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/** Rough walking time at 4.5 km/h, which is generous for Apia in the middle of the day. */
export function walkingTime(m) {
  const mins = Math.round(m / 75);
  if (mins < 1) return 'under a minute on foot';
  if (mins < 60) return `about ${mins} min walk`;
  const h = Math.floor(mins / 60);
  return `about ${h} h ${mins % 60} min walk`;
}

export function currentApiaTime() {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: IANA_TZ,
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
  } catch {
    return '';
  }
}

const DAY_KEYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/**
 * A pragmatic reading of the opening_hours tag.
 *
 * The full opening_hours grammar is large (public holidays, month ranges, week
 * numbers, "sunset", comments). Rather than half-parse it and risk telling
 * someone a pharmacy is open when it is not, anything outside the ordinary
 * "Mo-Fr 08:00-17:00; Sa 08:00-12:00" / "24/7" forms is reported as unknown and
 * the raw tag value is shown instead. A wrong "Open now" is worse than none.
 *
 * @returns {{state:'open'|'closed'|'unknown', label:string}}
 */
export function evaluateHours(value, now = new Date()) {
  if (!value) return { state: 'unknown', label: '' };
  const v = value.trim();
  const unknown = { state: 'unknown', label: '' };

  if (/^24\/7$/i.test(v)) return { state: 'open', label: 'Open 24 hours' };
  // Anything with holidays, months, week numbers, comments or open-ended times.
  if (/\b(PH|SH|easter|week|sunrise|sunset|dawn|dusk)\b/i.test(v)) return unknown;
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(v)) return unknown;
  if (/["[\]]|\d{1,2}:\d{2}\+/.test(v)) return unknown;

  let dayIdx, minutes;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: IANA_TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    dayIdx = DAY_KEYS.indexOf((get('weekday') || '').slice(0, 2));
    minutes = Number(get('hour')) * 60 + Number(get('minute'));
  } catch {
    return unknown;
  }
  if (dayIdx < 0 || !Number.isFinite(minutes)) return unknown;

  let openLabel = null;

  for (const raw of v.split(';')) {
    const rule = raw.trim();
    if (!rule) continue;

    const m = rule.match(/^((?:[A-Za-z]{2}(?:\s*-\s*[A-Za-z]{2})?)(?:\s*,\s*[A-Za-z]{2}(?:\s*-\s*[A-Za-z]{2})?)*)?\s*(.*)$/);
    if (!m) return unknown;
    const daySpec = m[1] || '';
    const timeSpec = (m[2] || '').trim();

    if (/^(off|closed)$/i.test(timeSpec)) continue;      // an explicit closure; nothing to open
    if (!timeSpec) return unknown;

    // Every remaining rule must be a clean comma-separated list of HH:MM-HH:MM.
    const spans = timeSpec.split(',').map((s) => s.trim());
    const parsed = spans.map((s) => s.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/));
    if (parsed.some((p) => !p)) return unknown;
    if (daySpec && !isValidDaySpec(daySpec)) return unknown;

    if (daySpec && !matchesDay(daySpec, dayIdx)) continue;

    for (const t of parsed) {
      const start = Number(t[1]) * 60 + Number(t[2]);
      let end = Number(t[3]) * 60 + Number(t[4]);
      if (end <= start) end += 24 * 60; // spans midnight
      if (minutes >= start && minutes < end) {
        openLabel = `Open now · until ${t[3].padStart(2, '0')}:${t[4]}`;
      }
    }
  }

  if (openLabel) return { state: 'open', label: openLabel };
  // Every rule parsed cleanly and none of them covers right now. In
  // opening_hours semantics, days that are not listed are closed.
  return { state: 'closed', label: 'Closed now' };
}

function isValidDaySpec(spec) {
  return spec.split(',').every((part) => {
    const p = part.trim();
    const range = p.match(/^([A-Za-z]{2})\s*-\s*([A-Za-z]{2})$/);
    if (range) return DAY_KEYS.includes(cap(range[1])) && DAY_KEYS.includes(cap(range[2]));
    return DAY_KEYS.includes(cap(p));
  });
}

function matchesDay(spec, dayIdx) {
  for (const part of spec.split(',')) {
    const range = part.trim().match(/^([A-Za-z]{2})\s*-\s*([A-Za-z]{2})$/);
    if (range) {
      const a = DAY_KEYS.indexOf(cap(range[1]));
      const b = DAY_KEYS.indexOf(cap(range[2]));
      if (a < 0 || b < 0) continue;
      if (a <= b ? dayIdx >= a && dayIdx <= b : dayIdx >= a || dayIdx <= b) return true;
    } else {
      const i = DAY_KEYS.indexOf(cap(part.trim()));
      if (i >= 0 && i === dayIdx) return true;
    }
  }
  return false;
}

const cap = (s) => s.slice(0, 1).toUpperCase() + s.slice(1, 2).toLowerCase();

export function telHref(phone) {
  const cleaned = String(phone).split(';')[0].replace(/[^\d+]/g, '');
  return cleaned ? `tel:${cleaned}` : null;
}

export function osmLink(p) {
  return `https://www.openstreetmap.org/${p.osm_type}/${p.osm_id}`;
}

export function osmEditLink(p, zoom = 19) {
  return `https://www.openstreetmap.org/edit?${p.osm_type}=${p.osm_id}#map=${zoom}`;
}

/** Directions handed off to a routing provider — this map does not route itself. */
export function directionsLinks(coords, name) {
  const [lng, lat] = coords;
  return [
    { label: 'OpenStreetMap', url: `https://www.openstreetmap.org/directions?to=${lat}%2C${lng}` },
    { label: 'Google Maps', url: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` },
    { label: 'Apple Maps', url: `https://maps.apple.com/?daddr=${lat},${lng}&q=${encodeURIComponent(name || '')}` },
  ];
}

/**
 * Attach editorial blurbs to OSM features by name. Positions always come from
 * OSM; this only decides which feature a piece of writing belongs to. The most
 * prominent matching feature wins so a blurb lands on the cathedral itself
 * rather than on a bus stop named after it.
 */
export function joinHighlights(features, highlights = []) {
  const byId = new Map();
  for (const h of highlights) {
    const patterns = (h.match || []).map(fold).filter(Boolean);
    let best = null;
    let bestScore = -Infinity;
    for (const f of features) {
      const name = fold(f.properties.name);
      if (!name) continue;
      const hit = patterns.some((p) => name.includes(p));
      if (!hit) continue;
      // Prefer prominent, real destinations over stops and stubs named after them.
      let score = 10 - (f.properties.rank ?? 5);
      if (f.properties.cat === 'transport' && f.properties.kind === 'Bus stop') score -= 20;
      if (f.properties.unnamed) score -= 15;
      if (patterns.some((p) => name === p)) score += 8;
      if (score > bestScore) { bestScore = score; best = f; }
    }
    if (best) byId.set(best.properties.id, h);
  }
  return byId;
}
