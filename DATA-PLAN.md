# Data Plan

## Context provenance
- `現在地を取得して周辺のイベントをリアルタイムで取得するアプリ` (verbatim user request; the app must use the device's current location and fetch events live at open)
- `外出先で少し時間が余ったりした時に近くにふらっと立ち寄れるイベントが開催されていないか調べるために使う` (verbatim user request; the design centers on drop-in friendliness: events on today, walk-in / no-reservation info and price surfaced on every card, sorted so what is on *now* comes first)
- No external context applied beyond the verbatim request.

## Tested sources
### OpenStreetMap Nominatim reverse geocoding (plain fetch in server action)
**Used by**: `searchNearbyEvents` / `searchByPlace` — turns GPS coordinates into the Japanese area label (prefecture / city / ward / neighbourhood) used both as the page headline and as the place terms in the event search queries; the forward `/search` endpoint (countrycodes=jp, limit=1) resolves a typed place name when geolocation is unavailable or denied.
**Test command**: `curl -s "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=34.9858&lon=135.7585&zoom=16&accept-language=ja" -H "User-Agent: muse-nearby-events-probe/1.0"`
**Sample output**: `display_name: "東塩小路釜殿町, 下京区, 京都市, 京都府, 600-8555, 日本"`, `address: {neighbourhood: 東塩小路釜殿町, suburb: 下京区, city: 京都市, province: 京都府}` for coordinates beside Kyoto Station.
**Processing**: read `address.province / city / suburb(ward) / neighbourhood`; headline = ward + city + neighbourhood; search terms = city + ward (and the neighbourhood when present). Coordinates are rounded to a ~1 km grid before any storage, and the user's precise position is never persisted.

### Web search for nearby events (ctx.tool.web_search)
**Used by**: `searchNearbyEvents` — 2–3 Japanese queries per lookup combining the resolved area, the target date and drop-in angles (e.g. `〈市区町村・区〉 イベント 今日 〈YYYY年M月D日〉 開催`, `〈エリア〉 開催中 イベント 今週末`, `〈エリア〉 展示 マルシェ ライブ 今週`).
**Test command**: probe-ctx snippet `ctx.tool.web_search("京都駅周辺 今日 開催中 イベント 2026年11月12日")`
**Sample output**: 7 results with title / url / source / snippet, including real same-day events near Kyoto Station with venue, address, dates and access in the snippet — e.g. EventBank press "WAGYU（和牛） FAIR 2026" at ダブルツリーbyヒルトン京都駅, 2026-11-01〜12-23, 京都市南区…, JR京都駅八条口より徒歩5分; a digital stamp rally across Kyoto City 2026-11-02〜12-14, 参加費無料; a character-goods pop-up store at 京都駅 2026-11-04〜11-17.
**Processing**: snippets are the raw material only; nothing is rendered from snippets directly.

### Structured extraction (ctx.inference.complete with a Zod schema)
**Used by**: `searchNearbyEvents` — distills the search results into typed event rows: title, venue, address/area note, start/end datetimes, category (fixed enum), price text, free flag, drop-in note (当日券・予約不要・入場自由 etc., only when the source states it), short description, and the index of the search result it came from.
**Test command**: probe-ctx snippet calling `ctx.inference.complete` with `z.object({events: z.array(z.object({title, venue, price}))})` on a sample Japanese event sentence.
**Sample output**: `{"events":[{"title":"秋の特別展「京の工芸」","venue":"京都文化博物館","price":"一般800円"}]}` — extraction works; the schema must be a Zod schema (the probe runner passes `z`), not raw JSON Schema.
**Processing**: the model returns a result *index*, never a URL; code maps the index back to the verbatim `url` from the web_search response, so every card links to the exact source page returned by search. Code then filters to events whose period overlaps the requested window (今日 / 明日 / 今週末 JST), dedupes by title+venue, drops rows with no verifiable date overlap, and sorts ongoing-now first, then by start time. Rows whose dates cannot be parsed are excluded rather than guessed.

### Venue geocoding for the map (Photon + Nominatim, in server action)
**Used by**: `searchNearbyEvents` / `searchByPlace` — after extraction, each event's venue is geocoded so the result list can be plotted. Added 2026-11-12 at the user's request (「地図表示を追加して」).
**Test command**: `curl -s "https://photon.komoot.io/api/?q=京都文化博物館&limit=5&lat=34.9858&lon=135.7585"` and the equivalent Nominatim `/search` call.
**Sample output**: Photon is fuzzy — for 京都文化博物館 it returned 京都国立博物館 (a different museum); Nominatim returned the exact 京都府京都文化博物館 at 35.0095, 135.7623. A hotel venue not in OSM (ダブルツリーbyヒルトン京都駅) returned no candidates from either.
**Processing**: Phase A: Photon (OpenStreetMap data, tolerates parallel calls, centre-biased) for all events. Phase B: Nominatim sequentially (bounded budget of 8 lookups, ~1s spacing) for misses — first venue + address/area context, then the venue's own street address alone when the source stated one. A candidate is plotted only when its name resembles the venue name (character-bigram Dice ≥ 0.6 or containment; address-only lookups are exempt because the query is the venue's own address) **and** it is within 20 km of the search centre. Events that fail both phases keep `lat/lon = null` and are list-only — coordinates are never guessed from the area centre. Coordinates are stored inside the existing `event_cache` payload (schema gained nullable `lat`/`lon`; pre-map cache rows fail validation and are simply refetched).

### Interactive map (Meta HatchMaps, bundled runtime)
**Used by**: the client renders the search centre (◎ pin) and numbered venue pins above the event list, using the bundled `hatch-maps.js` / `hatch-maps.css` copied into `client/src/assets/` and `map_helpers.mjs` imported from `client/src/`. Pin ↔ card selection is two-way (pin tap scrolls to and highlights the card; card tap selects the pin). Cards also show the straight-line distance from the search centre (labelled 直線約○km — derived from the two coordinate pairs, never presented as a route or walking time). When the map control cannot run, the section shows a short "map unavailable" note and the list remains fully usable; venues are dynamic per search, so no build-time static map image exists for them. Outbound directions still use the per-card Google Maps link.

## Long-term data behavior
- **Refresh policy**: fetch-on-open. The page asks for location, then calls the action; the action serves the `event_cache` row for the grid cell + date + window when it is under 20 minutes old, otherwise re-runs search + extraction and overwrites it. A visible 「更新」 button forces a fresh fetch. `fetched_at` (取得時刻) is always shown.
- **Growth**: cache only — one row per ~1 km grid cell per date/window; old rows pruned (keep newest 300 / 7 days). No user-owned records are created; bookmarks and history are out of scope.
- **Ordering**: 開催中 (already started, incl. multi-day exhibitions in period) first, then upcoming by start time.
- **Time semantics**: all event times are Japan time (Asia/Tokyo); "today/tomorrow/weekend" are computed in JST regardless of the viewer's clock. Walking/route times are not fabricated: cards show the venue, a Google Maps directions link (per maps.md navigation-link rules, query = venue name + address, no origin so the maps app uses device location), and — only when the venue was geocoded under the strict rules above — a clearly-labelled straight-line distance from the search centre. Coordinates from search snippets are never trusted directly; only geocoder results that pass the name + distance checks are plotted.

## Rejected approaches
- **Tried**: connpass API v1 `https://connpass.com/api/v1/event/?keyword=京都&count=3`
  **Why rejected**: HTTP 403 (CloudFront "Request blocked") on two attempts with different user agents; the endpoint is not openly reachable from this runtime, and it only covers tech/community meetups anyway.
- **Tried**: Ticketmaster (connector CLI exists in the sandbox)
  **Why rejected**: the CLI is a builder-seat tool, not callable from a server action; the Discovery API needs an API key the artifact does not have, and its Japan coverage is thin for casual local events (fairs, exhibitions, markets) that this use case is about.
- **Tried**: Doorkeeper / Peatix public APIs
  **Why rejected**: both require an account API token; no keyless public search endpoint exists.
- **Imagery**: not needed — event cards are typographic (poster-style date/time blocks). Stock or generated photos would misrepresent real events, and source-page images cannot be owned reliably; the design carries the page without them.
