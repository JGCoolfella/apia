// Maps OpenStreetMap tags onto the map's categories.
//
// Rules are evaluated top to bottom, so the most specific / most urgent
// categories (emergency, health) come first. `rank` drives label priority on the
// map: lower sorts and draws first.

export const CATEGORIES = {
  emergency: { label: 'Emergency', color: '#e11d48', icon: '\u{1F6A8}', blurb: 'Police, fire, ambulance' },
  health: { label: 'Health', color: '#f43f5e', icon: '\u{1F3E5}', blurb: 'Hospitals, clinics, pharmacies' },
  transport: { label: 'Transport', color: '#0284c7', icon: '\u{1F68C}', blurb: 'Airports, ferries, buses, fuel' },
  money: { label: 'Money', color: '#059669', icon: '\u{1F4B5}', blurb: 'Banks, ATMs, money transfer' },
  sights: { label: 'Sights & culture', color: '#7c3aed', icon: '\u{1F5FF}', blurb: 'Museums, monuments, viewpoints' },
  food: { label: 'Eat & drink', color: '#ea580c', icon: '\u{1F374}', blurb: 'Restaurants, cafes, bars' },
  stay: { label: 'Stay', color: '#c026d3', icon: '\u{1F6CF}', blurb: 'Hotels, resorts, guesthouses' },
  shops: { label: 'Shops & markets', color: '#d97706', icon: '\u{1F6D2}', blurb: 'Markets, supermarkets, retail' },
  outdoors: { label: 'Outdoors', color: '#16a34a', icon: '\u{1F334}', blurb: 'Beaches, parks, sport, peaks' },
  worship: { label: 'Churches', color: '#0891b2', icon: '\u{26EA}', blurb: 'Churches and places of worship' },
  gov: { label: 'Government', color: '#475569', icon: '\u{1F3DB}', blurb: 'Ministries, embassies, post, courts' },
  education: { label: 'Education', color: '#2563eb', icon: '\u{1F393}', blurb: 'Schools, colleges, libraries' },
  services: { label: 'Services', color: '#64748b', icon: '\u{1F527}', blurb: 'Offices, utilities, facilities' },
  places: { label: 'Villages & areas', color: '#334155', icon: '\u{1F4CD}', blurb: 'Suburbs, villages, localities' },
};

export const CATEGORY_ORDER = [
  'sights', 'food', 'stay', 'shops', 'transport', 'money', 'health',
  'outdoors', 'worship', 'gov', 'education', 'emergency', 'services', 'places',
];

const has = (t, k, ...vals) => t[k] !== undefined && (vals.length === 0 || vals.includes(t[k]));

/**
 * @returns {{cat:string, kind:string, rank:number, keepUnnamed?:boolean, fallbackName?:string}|null}
 */
export function classify(t) {
  // --- Emergency ------------------------------------------------------------
  if (has(t, 'amenity', 'police')) return { cat: 'emergency', kind: 'Police station', rank: 1 };
  if (has(t, 'amenity', 'fire_station')) return { cat: 'emergency', kind: 'Fire station', rank: 1 };
  if (has(t, 'emergency', 'ambulance_station')) return { cat: 'emergency', kind: 'Ambulance station', rank: 1 };
  if (has(t, 'emergency', 'defibrillator')) return { cat: 'emergency', kind: 'Defibrillator', rank: 6, keepUnnamed: true, fallbackName: 'Defibrillator' };

  // --- Health ---------------------------------------------------------------
  if (has(t, 'amenity', 'hospital')) return { cat: 'health', kind: 'Hospital', rank: 1 };
  if (has(t, 'amenity', 'clinic')) return { cat: 'health', kind: 'Clinic', rank: 2 };
  if (has(t, 'amenity', 'doctors')) return { cat: 'health', kind: 'Doctor', rank: 3 };
  if (has(t, 'amenity', 'pharmacy')) return { cat: 'health', kind: 'Pharmacy', rank: 3 };
  if (has(t, 'amenity', 'dentist')) return { cat: 'health', kind: 'Dentist', rank: 4 };
  if (has(t, 'amenity', 'veterinary')) return { cat: 'health', kind: 'Veterinary', rank: 5 };
  if (has(t, 'healthcare')) return { cat: 'health', kind: titleise(t.healthcare), rank: 4 };

  // --- Transport ------------------------------------------------------------
  if (has(t, 'aeroway', 'aerodrome')) return { cat: 'transport', kind: 'Airport', rank: 0 };
  if (has(t, 'aeroway', 'terminal')) return { cat: 'transport', kind: 'Airport terminal', rank: 2 };
  if (has(t, 'aeroway', 'helipad')) return { cat: 'transport', kind: 'Helipad', rank: 5 };
  if (has(t, 'amenity', 'ferry_terminal')) return { cat: 'transport', kind: 'Ferry terminal', rank: 1 };
  if (has(t, 'amenity', 'bus_station')) return { cat: 'transport', kind: 'Bus terminal', rank: 1 };
  if (has(t, 'highway', 'bus_stop')) return { cat: 'transport', kind: 'Bus stop', rank: 7, keepUnnamed: true, fallbackName: 'Bus stop' };
  if (has(t, 'amenity', 'taxi')) return { cat: 'transport', kind: 'Taxi stand', rank: 5, keepUnnamed: true, fallbackName: 'Taxi stand' };
  if (has(t, 'amenity', 'fuel')) return { cat: 'transport', kind: 'Petrol station', rank: 4, keepUnnamed: true, fallbackName: 'Petrol station' };
  if (has(t, 'amenity', 'car_rental')) return { cat: 'transport', kind: 'Car rental', rank: 4 };
  if (has(t, 'amenity', 'car_wash')) return { cat: 'services', kind: 'Car wash', rank: 6 };
  if (has(t, 'amenity', 'parking')) return { cat: 'transport', kind: 'Parking', rank: 7, keepUnnamed: true, fallbackName: 'Parking' };
  if (has(t, 'amenity', 'bicycle_rental')) return { cat: 'transport', kind: 'Bicycle rental', rank: 5 };
  if (has(t, 'railway', 'station') || has(t, 'public_transport', 'station')) return { cat: 'transport', kind: 'Transport station', rank: 2 };
  if (has(t, 'public_transport')) return { cat: 'transport', kind: 'Public transport stop', rank: 8, keepUnnamed: true, fallbackName: 'Transport stop' };
  if (has(t, 'man_made', 'pier')) return { cat: 'transport', kind: 'Pier', rank: 4 };

  // --- Money ----------------------------------------------------------------
  if (has(t, 'amenity', 'bank')) return { cat: 'money', kind: 'Bank', rank: 2 };
  if (has(t, 'amenity', 'atm')) return { cat: 'money', kind: 'ATM', rank: 5, keepUnnamed: true, fallbackName: 'ATM' };
  if (has(t, 'amenity', 'bureau_de_change')) return { cat: 'money', kind: 'Money exchange', rank: 3 };
  if (has(t, 'office', 'financial') || has(t, 'office', 'insurance')) return { cat: 'money', kind: titleise(t.office), rank: 5 };

  // --- Sights & culture -----------------------------------------------------
  if (has(t, 'tourism', 'museum')) return { cat: 'sights', kind: 'Museum', rank: 0 };
  if (has(t, 'tourism', 'attraction')) return { cat: 'sights', kind: 'Attraction', rank: 1 };
  if (has(t, 'tourism', 'viewpoint')) return { cat: 'sights', kind: 'Viewpoint', rank: 3, keepUnnamed: true, fallbackName: 'Viewpoint' };
  if (has(t, 'tourism', 'artwork')) return { cat: 'sights', kind: 'Artwork', rank: 4 };
  if (has(t, 'tourism', 'gallery')) return { cat: 'sights', kind: 'Gallery', rank: 2 };
  if (has(t, 'tourism', 'information')) return { cat: 'sights', kind: 'Visitor information', rank: 3, keepUnnamed: true, fallbackName: 'Information' };
  if (has(t, 'historic', 'memorial')) return { cat: 'sights', kind: 'Memorial', rank: 3 };
  if (has(t, 'historic', 'monument')) return { cat: 'sights', kind: 'Monument', rank: 2 };
  if (has(t, 'historic')) return { cat: 'sights', kind: titleise(t.historic), rank: 3 };
  if (has(t, 'amenity', 'theatre') || has(t, 'amenity', 'cinema') || has(t, 'amenity', 'arts_centre')) {
    return { cat: 'sights', kind: titleise(t.amenity), rank: 2 };
  }
  if (has(t, 'man_made', 'lighthouse')) return { cat: 'sights', kind: 'Lighthouse', rank: 3 };

  // --- Eat & drink ----------------------------------------------------------
  if (has(t, 'amenity', 'restaurant')) return { cat: 'food', kind: 'Restaurant', rank: 3 };
  if (has(t, 'amenity', 'cafe')) return { cat: 'food', kind: 'Cafe', rank: 3 };
  if (has(t, 'amenity', 'fast_food')) return { cat: 'food', kind: 'Fast food', rank: 4 };
  if (has(t, 'amenity', 'bar') || has(t, 'amenity', 'pub')) return { cat: 'food', kind: titleise(t.amenity), rank: 3 };
  if (has(t, 'amenity', 'nightclub')) return { cat: 'food', kind: 'Nightclub', rank: 3 };
  if (has(t, 'amenity', 'ice_cream')) return { cat: 'food', kind: 'Ice cream', rank: 4 };
  if (has(t, 'amenity', 'food_court')) return { cat: 'food', kind: 'Food court', rank: 3 };
  if (has(t, 'shop', 'bakery')) return { cat: 'food', kind: 'Bakery', rank: 4 };

  // --- Stay -----------------------------------------------------------------
  if (has(t, 'tourism', 'hotel', 'motel', 'resort', 'guest_house', 'hostel', 'chalet', 'apartment', 'alpine_hut')) {
    return { cat: 'stay', kind: titleise(t.tourism), rank: 1 };
  }
  if (has(t, 'tourism', 'camp_site', 'caravan_site')) return { cat: 'stay', kind: titleise(t.tourism), rank: 3 };

  // --- Shops & markets ------------------------------------------------------
  if (has(t, 'amenity', 'marketplace')) return { cat: 'shops', kind: 'Market', rank: 0 };
  if (has(t, 'shop', 'supermarket', 'department_store', 'mall')) return { cat: 'shops', kind: titleise(t.shop), rank: 2 };
  if (has(t, 'shop')) return { cat: 'shops', kind: titleise(t.shop), rank: 5 };
  if (has(t, 'craft')) return { cat: 'shops', kind: titleise(t.craft), rank: 5 };

  // --- Outdoors -------------------------------------------------------------
  if (has(t, 'natural', 'beach')) return { cat: 'outdoors', kind: 'Beach', rank: 1, keepUnnamed: true, fallbackName: 'Beach' };
  if (has(t, 'natural', 'peak')) return { cat: 'outdoors', kind: 'Peak', rank: 2, keepUnnamed: true, fallbackName: 'Peak' };
  if (has(t, 'natural', 'spring')) return { cat: 'outdoors', kind: 'Spring', rank: 3 };
  if (has(t, 'natural', 'cave_entrance')) return { cat: 'outdoors', kind: 'Cave', rank: 3 };
  if (has(t, 'natural', 'reef')) return { cat: 'outdoors', kind: 'Reef', rank: 4, keepUnnamed: true, fallbackName: 'Reef' };
  if (has(t, 'leisure', 'nature_reserve')) return { cat: 'outdoors', kind: 'Nature reserve', rank: 1 };
  if (has(t, 'leisure', 'park', 'garden', 'common')) return { cat: 'outdoors', kind: titleise(t.leisure), rank: 2 };
  if (has(t, 'leisure', 'pitch', 'sports_centre', 'stadium', 'swimming_pool', 'fitness_centre', 'golf_course', 'track')) {
    return { cat: 'outdoors', kind: titleise(t.leisure), rank: 4 };
  }
  if (has(t, 'leisure', 'marina', 'slipway')) return { cat: 'outdoors', kind: titleise(t.leisure), rank: 3 };
  if (has(t, 'tourism', 'picnic_site')) return { cat: 'outdoors', kind: 'Picnic site', rank: 4, keepUnnamed: true, fallbackName: 'Picnic site' };
  if (has(t, 'leisure')) return { cat: 'outdoors', kind: titleise(t.leisure), rank: 5 };

  // --- Churches -------------------------------------------------------------
  if (has(t, 'amenity', 'place_of_worship')) {
    const d = t.denomination || t.religion;
    return { cat: 'worship', kind: d ? `${titleise(d)} church` : 'Place of worship', rank: 3 };
  }

  // --- Government -----------------------------------------------------------
  if (has(t, 'amenity', 'townhall')) return { cat: 'gov', kind: 'Town hall', rank: 1 };
  if (has(t, 'amenity', 'courthouse')) return { cat: 'gov', kind: 'Courthouse', rank: 1 };
  if (has(t, 'amenity', 'prison')) return { cat: 'gov', kind: 'Prison', rank: 4 };
  if (has(t, 'amenity', 'post_office')) return { cat: 'gov', kind: 'Post office', rank: 2 };
  if (has(t, 'amenity', 'embassy') || has(t, 'office', 'diplomatic')) {
    return { cat: 'gov', kind: t.diplomatic ? titleise(t.diplomatic) : 'Diplomatic mission', rank: 1 };
  }
  if (has(t, 'office', 'government')) return { cat: 'gov', kind: 'Government office', rank: 2 };
  if (has(t, 'amenity', 'community_centre')) return { cat: 'gov', kind: 'Community centre', rank: 3 };

  // --- Education ------------------------------------------------------------
  if (has(t, 'amenity', 'university')) return { cat: 'education', kind: 'University', rank: 1 };
  if (has(t, 'amenity', 'college')) return { cat: 'education', kind: 'College', rank: 2 };
  if (has(t, 'amenity', 'school')) return { cat: 'education', kind: 'School', rank: 3 };
  if (has(t, 'amenity', 'kindergarten')) return { cat: 'education', kind: 'Kindergarten', rank: 4 };
  if (has(t, 'amenity', 'library')) return { cat: 'education', kind: 'Library', rank: 2 };
  if (has(t, 'amenity', 'driving_school') || has(t, 'amenity', 'language_school')) {
    return { cat: 'education', kind: titleise(t.amenity), rank: 5 };
  }

  // --- Villages & areas -----------------------------------------------------
  if (has(t, 'place')) {
    const rank = { city: 0, town: 1, island: 1, suburb: 2, village: 2, neighbourhood: 3, hamlet: 3, locality: 4 }[t.place] ?? 4;
    return { cat: 'places', kind: titleise(t.place), rank };
  }

  // --- Everything else that is still useful ---------------------------------
  if (has(t, 'amenity', 'toilets')) return { cat: 'services', kind: 'Toilets', rank: 6, keepUnnamed: true, fallbackName: 'Public toilets' };
  if (has(t, 'amenity', 'drinking_water')) return { cat: 'services', kind: 'Drinking water', rank: 6, keepUnnamed: true, fallbackName: 'Drinking water' };
  if (has(t, 'amenity', 'internet_cafe')) return { cat: 'services', kind: 'Internet cafe', rank: 4 };
  if (has(t, 'amenity')) return { cat: 'services', kind: titleise(t.amenity), rank: 6 };
  if (has(t, 'office')) return { cat: 'services', kind: `${titleise(t.office)} office`, rank: 6 };
  if (has(t, 'man_made')) return { cat: 'services', kind: titleise(t.man_made), rank: 7 };

  return null;
}

function titleise(v = '') {
  return String(v).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
