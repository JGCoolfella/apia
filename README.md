# Apia, Sāmoa — interactive map

A fast, offline-capable interactive map of Apia and the north coast of Upolu,
built on OpenStreetMap. Static site: no backend, no API keys, no tracking.

---

## The one thing to know about accuracy

**Every coordinate on this map comes from OpenStreetMap. None of it is
hand-placed, transcribed, or written from memory.**

That is a deliberate design constraint, not an implementation detail:

- `scripts/fetch-osm.mjs` queries the Overpass API for the Apia area and writes
  `public/data/apia.geojson`. That file is the only source of positions.
- `public/data/curated.json` holds the editorial layer — descriptions, tips,
  practical information. It contains **no coordinates at all**; a test asserts
  this. Entries are attached to OSM objects by name at runtime, so the writing
  adds context to a place OpenStreetMap already located.
- Every place card links to the underlying OSM object and to the OSM editor, so
  a wrong pin can be fixed at the source rather than patched here.
- The data panel (🛰️) always shows how many places are loaded, where they came
  from, and the timestamp of the OSM extract behind them.

Where a fact could not be verified against a source, it is not asserted. The
"Know before you go" panel carries a last-checked date and links out for
anything time-sensitive.

## Getting started

```bash
npm install
npm run fetch:data     # pull the Apia area from OpenStreetMap  (do this first)
npm run dev            # http://localhost:5173
```

`npm run fetch:data` takes 20–90 seconds — it is a large Overpass query over the
whole north coast. Without it the app falls back to querying Overpass live from
the browser, which works but is slow and should not be used for a public site.

```bash
npm run check          # validate the dataset before shipping it
npm run build          # production build into dist/
npm run preview        # serve the production build locally
```

## What it does

**Finding things**
- Instant local search over every place in the dataset — no geocoding service,
  so it works offline and returns only places actually on this map. Samoan
  macrons and the ʻokina are folded, so `Motootua` finds `Motoʻotua`.
- 14 category filters (sights, food, money, health, transport, churches…) with
  live counts.
- A viewport-synced list, sorted nearest-first once you share your location.
- `/` focuses search; arrow keys and Enter drive the results.

**Each place**
- Opening hours with an honest *Open now* / *Closed now* badge. The
  `opening_hours` grammar is only partly parseable; anything outside the ordinary
  forms is reported as unknown rather than guessed at. A wrong "open" sends
  someone across town for nothing.
- Tappable phone numbers, websites, addresses, cuisine, accessibility.
- Distance and a walking-time estimate from your location.
- Hand-off to OpenStreetMap, Google or Apple for turn-by-turn directions — this
  map does not pretend to route.
- Shareable deep links: the URL always encodes the view and the selected place.

**Context**
- A "Know before you go" panel: 911 emergency, UTC+13 year-round, left-hand
  traffic, Sunday and *sā* observance, the 90-day visitor permit, buses, ferries,
  cyclone season — each with source links and a last-checked date.
- Current notices for things a map cannot show, such as the Savalalo bus terminal
  rebuild that started in February 2026 and the Apia Waterfront Plan works.

**Everywhere**
- Works offline after first load (service worker caches the shell, the dataset,
  and tiles you have already viewed).
- Installable as a PWA; light and dark themes; keyboard accessible; respects
  `prefers-reduced-motion`.

## How the pieces fit

```
src/config.js      bounding box, default camera, Overpass mirrors
src/classify.js    OSM tags -> the 14 categories, colours, icons        <- edit to retag
src/overpass.js    query builder + Overpass JSON -> normalised GeoJSON  <- shared by Node and browser
src/data.js        snapshot -> localStorage cache -> live Overpass
src/search.js      local index and ranking
src/format.js      opening hours, distances, OSM links, editorial join
src/basemaps.js    raster and self-hosted vector basemap styles
src/main.js        map, layers, list, detail panel, dialogs, URL state

public/data/curated.json   editorial layer (no coordinates)
scripts/fetch-osm.mjs      builds public/data/apia.geojson
scripts/check-data.mjs     validates it
scripts/fetch-basemap.sh   cuts a Samoa .pmtiles basemap
infra/                     S3 + CloudFront stack and deploy script
```

`src/classify.js` is the file to edit if you want different categories: it is a
single ordered list of tag rules, and both the build script and the running app
read it.

## Basemaps

| Option | Tiles from | Good for |
| --- | --- | --- |
| **Streets** (default) | `tile.openstreetmap.org` | development, personal use |
| **Terrain** | OpenTopoMap | seeing the relief behind Apia |
| **Vector** | your own `.pmtiles` file | **production**, offline, APK |

The OSM Foundation's [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
asks that applications not become heavy users of its tile servers. For anything
public, switch to the vector basemap:

```bash
npm run fetch:basemap      # needs the pmtiles CLI on your PATH
```

That cuts Upolu and Savaiʻi out of the Protomaps global build into
`public/basemap/samoa.pmtiles` — a single file served by ordinary HTTP range
requests. No tile server, no API key, no rate limit, and it works with no
connection at all. The CloudFront stack already has a cache behaviour for it with
compression disabled, which range requests require.

## Deploying to AWS

```bash
export AWS_REGION=ap-southeast-2          # Sydney: closest bulk region to Samoa
npm run fetch:data
npm run deploy
```

`infra/deploy.sh` creates or updates the CloudFormation stack in
`infra/cloudfront.yaml`, uploads `dist/`, and invalidates the distribution. The
stack is:

- a **private** S3 bucket — no public access, no website endpoint
- CloudFront with **Origin Access Control**, HTTP/3, IPv6
- a strict **Content-Security-Policy** listing exactly the tile, font and
  Overpass hosts the app may contact
- three cache behaviours: immutable for hashed assets, uncompressed for
  `.pmtiles` so byte ranges work, short-lived for HTML and data
- TLS-only bucket policy, versioning, and lifecycle cleanup

Optional custom domain:

```bash
DOMAIN=apia.example.com \
CERT_ARN=arn:aws:acm:us-east-1:123456789012:certificate/... \
npm run deploy
```

The certificate **must** be issued in `us-east-1` — CloudFront reads
certificates only from that region, whatever region the stack lives in.

Running cost for a site like this is dominated by the CloudFront free tier;
beyond it, expect single-digit dollars a month at modest traffic. `PriceClass_All`
is the default because it is the only class with Australian and New Zealand edge
locations, which are the nearest points of presence to Samoa.

### Wrapping it as an APK

The build is a self-contained static bundle with relative URLs, so it drops
straight into a WebView:

```bash
npm run fetch:basemap        # bundle the basemap so the app works with no signal
npm run build
npx cap init "Apia Map" ws.apia.map --web-dir dist
npx cap add android
npx cap sync android && npx cap open android
```

With the `.pmtiles` basemap and the dataset both bundled, the app is fully
functional offline — which is the point on an island where mobile data thins out
quickly once you leave town.

## Keeping it current

`.github/workflows/refresh-data.yml` re-runs the Overpass fetch weekly, validates
the result, and commits it only if something changed. Run it on demand from the
Actions tab. Without it the map is accurate as of whenever the snapshot was last
built — which the data panel always shows.

## Tests

```bash
npx playwright test --project=unit      # pipeline, hours, search, editorial join
npx playwright test --project=browser   # the real UI in Chromium
```

Browser tests stub the dataset and every external host, so they never depend on
Overpass or a tile server. If Chromium is already installed somewhere, point at
it with `PLAYWRIGHT_CHROMIUM_PATH`.

## Data, licensing, attribution

Map data © OpenStreetMap contributors, licensed under the
[Open Database License](https://opendatacommons.org/licenses/odbl/). Attribution
is displayed on the map and must stay there. The Terrain basemap additionally
credits OpenTopoMap (CC-BY-SA). The application code is MIT.

If you spot something wrong on the map, the fix belongs in OpenStreetMap — the
"Something wrong? Fix it" link on every place opens that exact object in the OSM
editor, and the correction flows back here on the next refresh.
