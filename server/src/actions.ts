// Actions for 周辺イベント検索アプリ (nearby events finder).
//
// Flow for both actions:
//   coordinates -> Nominatim reverse geocode (area label + search terms)
//   -> ctx.tool.web_search (2-3 Japanese queries for the area + date window)
//   -> ctx.inference.complete (structured extraction; the model returns a
//      search-result *index*, code maps it back to the verbatim source URL)
//   -> code-side date-overlap filter, dedupe, sort -> cache in event_cache.
//
// Results are cached per ~1 km grid cell + window + start date for 20
// minutes; a forced refresh bypasses the cache. All date math is JST.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { eq, lt } from "drizzle-orm";
import * as schema from "./schema";

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

const windowEnum = z.enum(["today", "tomorrow", "weekend"]);

const CATEGORIES = [
  "展示・展覧会",
  "音楽・ライブ",
  "マルシェ・食",
  "祭り・伝統",
  "体験・ワークショップ",
  "演劇・映画",
  "スポーツ",
  "セミナー・講座",
  "その他",
] as const;

const storedEvent = z.object({
  title: z.string(),
  venue: z.string(),
  address: z.string(),
  accessNote: z.string(),
  startDate: z.string(), // YYYY-MM-DD (JST)
  endDate: z.string(), // YYYY-MM-DD (JST)
  startTime: z.string(), // "HH:MM" or ""
  endTime: z.string(), // "HH:MM" or ""
  category: z.string(),
  priceText: z.string(),
  isFree: z.boolean(),
  dropInNote: z.string(),
  description: z.string(),
  sourceUrl: z.string(),
  sourceName: z.string(),
  // Venue coordinates from geocoding (Photon / Nominatim, name-checked and
  // distance-checked against the search centre). Null when no trustworthy
  // coordinates were found — the event is then list-only, never plotted at
  // a guessed position.
  lat: z.number().nullable(),
  lon: z.number().nullable(),
});
type StoredEvent = z.infer<typeof storedEvent>;

const eventOut = storedEvent.extend({
  status: z.enum(["ongoing", "scheduled"]),
});

const searchResponse = z.object({
  status: z.enum(["ok", "no_area", "search_failed"]),
  areaLabel: z.string(),
  areaDetail: z.string(),
  centerLat: z.number(),
  centerLon: z.number(),
  window: windowEnum,
  windowLabel: z.string(),
  rangeLabel: z.string(),
  fetchedAt: z.string(), // ISO instant
  fromCache: z.boolean(),
  events: z.array(eventOut),
  message: z.string(),
});
type SearchResponse = z.infer<typeof searchResponse>;

/* ------------------------------------------------------------------ */
/* JST date helpers                                                    */
/* ------------------------------------------------------------------ */

const JST = "Asia/Tokyo";
const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

function jstNow(): { date: string; time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: wdMap[get("weekday")] ?? 0,
  };
}

/** Calendar arithmetic on a YYYY-MM-DD string (timezone-free). */
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

/** "2026-11-12" -> "11月12日（木）" */
function jpDateLabel(dateStr: string): string {
  const [, m = "1", d = "1"] = dateStr.split("-");
  return `${Number(m)}月${Number(d)}日（${WEEKDAY_JA[weekdayOf(dateStr)] ?? ""}）`;
}

interface WindowRange {
  start: string;
  end: string;
  label: string;
  rangeLabel: string;
}

function windowRange(
  window: z.infer<typeof windowEnum>,
  today: string,
  weekday: number,
): WindowRange {
  if (window === "today") {
    return {
      start: today,
      end: today,
      label: "今日",
      rangeLabel: jpDateLabel(today),
    };
  }
  if (window === "tomorrow") {
    const t = addDays(today, 1);
    return { start: t, end: t, label: "明日", rangeLabel: jpDateLabel(t) };
  }
  // weekend: the coming Saturday-Sunday (today counts when it is the weekend)
  const untilSat = (6 - weekday + 7) % 7;
  const sat = addDays(today, untilSat);
  const sun = addDays(sat, 1);
  return {
    start: sat,
    end: sun,
    label: "今週末",
    rangeLabel: `${jpDateLabel(sat)}〜${jpDateLabel(sun)}`,
  };
}

/* ------------------------------------------------------------------ */
/* Nominatim geocoding                                                 */
/* ------------------------------------------------------------------ */

interface AreaInfo {
  label: string;
  detail: string;
  terms: string;
}

interface NominatimReverse {
  display_name?: string;
  address?: {
    province?: string;
    prefecture?: string;
    city?: string;
    town?: string;
    village?: string;
    county?: string;
    suburb?: string;
    neighbourhood?: string;
    quarter?: string;
  };
}

async function reverseGeocode(lat: number, lon: number): Promise<AreaInfo | null> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
      `&lat=${lat}&lon=${lon}&zoom=16&accept-language=ja`;
    const res = await fetch(url, {
      headers: { "User-Agent": "muse-nearby-events/1.0 (personal event finder)" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NominatimReverse;
    const a = data.address ?? {};
    const prefecture = a.province ?? a.prefecture ?? "";
    const city = a.city ?? a.town ?? a.village ?? a.county ?? "";
    const ward = a.suburb ?? "";
    const hood = a.neighbourhood ?? a.quarter ?? "";
    const label =
      [city, ward].filter(Boolean).join("") ||
      prefecture ||
      (data.display_name ?? "").split(",")[0]?.trim() ||
      "";
    if (!label) return null;
    const detail = hood ? `${hood}周辺` : (data.display_name ?? "").split(",")[0]?.trim() ?? "";
    const terms = [prefecture, city, ward].filter(Boolean).join(" ");
    return { label, detail, terms: terms || label };
  } catch {
    return null;
  }
}

async function forwardGeocode(
  query: string,
): Promise<{ lat: number; lon: number } | null> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1` +
      `&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "muse-nearby-events/1.0 (personal event finder)" },
    });
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ lat?: string; lon?: string }>;
    const first = arr[0];
    if (!first?.lat || !first?.lon) return null;
    const lat = Number.parseFloat(first.lat);
    const lon = Number.parseFloat(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Venue geocoding for the map                                         */
/* ------------------------------------------------------------------ */

// A venue pin is only useful when it is the *right* place: Photon and
// Nominatim both return fuzzy matches (e.g. 京都文化博物館 -> 京都国立博物館),
// so a candidate is accepted only when its name genuinely resembles the
// venue name (or, for an address-only lookup, the query was the venue's
// own street address) and it sits within a plausible distance of the
// search centre. Otherwise the event stays list-only.

const GEO_MAX_KM = 20;

function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s　・,、()（）「」]/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
  if (out.size === 0 && t.length > 0) out.add(t);
  return out;
}

/** Dice coefficient over character bigrams, 0..1. */
function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

interface GeoCandidate {
  lat: number;
  lon: number;
  name: string;
}

async function photonCandidates(
  query: string,
  bias: { lat: number; lon: number },
): Promise<GeoCandidate[]> {
  try {
    const params = new URLSearchParams({
      q: query,
      limit: "5",
      lat: String(bias.lat),
      lon: String(bias.lon),
    });
    const res = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, {
      headers: { "User-Agent": "muse-nearby-events/1.0 (personal event finder)" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: { name?: string };
      }>;
    };
    const out: GeoCandidate[] = [];
    for (const f of data.features ?? []) {
      const coords = f?.geometry?.coordinates;
      if (!coords) continue;
      const [lon, lat] = coords;
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push({ lat, lon, name: f?.properties?.name ?? "" });
    }
    return out;
  } catch {
    return [];
  }
}

async function nominatimCandidates(query: string): Promise<GeoCandidate[]> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3` +
      `&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "muse-nearby-events/1.0 (personal event finder)" },
    });
    if (!res.ok) return [];
    const arr = (await res.json()) as Array<{
      lat?: string;
      lon?: string;
      name?: string;
      display_name?: string;
    }>;
    const out: GeoCandidate[] = [];
    for (const r of arr) {
      if (!r.lat || !r.lon) continue;
      const lat = Number.parseFloat(r.lat);
      const lon = Number.parseFloat(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push({ lat, lon, name: r.name ?? "" });
    }
    return out;
  } catch {
    return [];
  }
}

function pickNamed(
  candidates: GeoCandidate[],
  venue: string,
  center: { lat: number; lon: number },
): { lat: number; lon: number } | null {
  let best: GeoCandidate | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    if (nameSimilarity(venue, c.name) < 0.6) continue;
    const d = haversineKm(center, c);
    if (d <= GEO_MAX_KM && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best ? { lat: best.lat, lon: best.lon } : null;
}

function pickNearest(
  candidates: GeoCandidate[],
  center: { lat: number; lon: number },
): { lat: number; lon: number } | null {
  let best: GeoCandidate | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = haversineKm(center, c);
    if (d <= GEO_MAX_KM && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best ? { lat: best.lat, lon: best.lon } : null;
}

/**
 * Resolve venue coordinates for every event. Phase A runs Photon in
 * parallel (it tolerates it and accepts a centre bias); phase B falls
 * back to Nominatim sequentially for a bounded number of misses, to
 * respect its ~1 req/s policy. Unresolved venues keep null coordinates.
 */
async function geocodeEvents(
  events: StoredEvent[],
  area: AreaInfo,
  center: { lat: number; lon: number },
): Promise<StoredEvent[]> {
  const resolved = new Map<number, { lat: number; lon: number } | null>();
  await Promise.all(
    events.map(async (ev, i) => {
      const hit = pickNamed(await photonCandidates(ev.venue, center), ev.venue, center);
      resolved.set(i, hit);
    }),
  );

  let budget = 8;
  for (let i = 0; i < events.length && budget > 0; i++) {
    if (resolved.get(i)) continue;
    const ev = events[i];
    if (!ev) continue;
    budget -= 1;
    const context = ev.address || area.terms;
    let hit = pickNamed(
      await nominatimCandidates(context ? `${ev.venue} ${context}` : ev.venue),
      ev.venue,
      center,
    );
    if (!hit && ev.address) {
      // The query is the venue's own street address from the source, so a
      // distance-checked hit is trustworthy without a name match.
      await sleep(1050);
      hit = pickNearest(await nominatimCandidates(ev.address), center);
    }
    if (hit) resolved.set(i, hit);
    if (budget > 0) await sleep(1050);
  }

  return events.map((ev, i) => {
    const g = resolved.get(i) ?? null;
    return { ...ev, lat: g?.lat ?? null, lon: g?.lon ?? null };
  });
}

/* ------------------------------------------------------------------ */
/* Event search + extraction                                           */
/* ------------------------------------------------------------------ */

interface SearchHit {
  title: string;
  url: string;
  source: string;
  snippet: string;
}

const extractionSchema = z.object({
  events: z.array(
    z.object({
      title: z.string(),
      venue: z.string(),
      address: z.string().nullable(),
      accessNote: z.string().nullable(),
      startDate: z.string(),
      endDate: z.string().nullable(),
      startTime: z.string().nullable(),
      endTime: z.string().nullable(),
      category: z.enum(CATEGORIES),
      priceText: z.string().nullable(),
      isFree: z.boolean(),
      dropInNote: z.string().nullable(),
      description: z.string(),
      sourceIndex: z.number().int(),
    }),
  ),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function fetchEvents(
  ctx: Ctx,
  area: AreaInfo,
  range: WindowRange,
  center: { lat: number; lon: number },
): Promise<StoredEvent[]> {
  const year = range.start.slice(0, 4);
  // Broad net: the user asked for every worthwhile event in the area to
  // be picked up, so the search runs more, category-spanning queries
  // than the original three (general, ongoing, category mix, hands-on /
  // free, and drop-in angles). Quality is unchanged — extraction still
  // requires verifiable dates in the target window and a real venue.
  const queries = [
    `${area.terms} イベント ${range.rangeLabel} 開催`,
    `${area.terms} 開催中 イベント ${range.label}`,
    `${area.terms} ${range.rangeLabel} 展示会 マルシェ ライブ 祭り`,
    `${area.terms} ${range.rangeLabel} 体験 ワークショップ 無料 イベント`,
    `${area.terms} イベント ${range.label} 当日参加 予約不要`,
  ];
  const responses = await Promise.all(
    queries.map((q) =>
      ctx.tool.web_search(q, { language_code: "ja" }).catch(() => null),
    ),
  );

  const hits: SearchHit[] = [];
  const seenUrls = new Set<string>();
  for (const res of responses) {
    if (!res) continue;
    for (const r of res.content.results) {
      if (!r.url || seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      hits.push({
        title: r.title,
        url: r.url,
        source: r.source ?? "",
        snippet: (r.snippet ?? "").slice(0, 1200),
      });
    }
  }
  if (hits.length === 0) return [];

  const listing = hits
    .map(
      (h, i) =>
        `[${i}] ${h.title}\nURL: ${h.url}\n抜粋: ${h.snippet || "（抜粋なし）"}`,
    )
    .join("\n\n");

  const prompt = [
    `あなたはイベント情報の抽出器です。以下は「${area.terms}」周辺で「${range.label}（${range.rangeLabel}）」の期間に開催されるイベントを探したWeb検索結果です。`,
    ``,
    `次の条件をすべて満たすイベントだけを抽出してください：`,
    `- 開催期間が ${range.start} から ${range.end} の期間と重なること。開始日と終了日が抜粋から読み取れるものだけを対象とし、読み取れないものは含めないこと。`,
    `- 会場が「${area.terms}」の周辺にある実在のイベントであること。オンライン開催のみのイベントは除くこと。`,
    `- まとめ記事や一覧ページ自体ではなく、個別のイベントであること。`,
    ``,
    `各項目は抜粋に書かれている情報だけを使ってください。書かれていない項目は null にし、日時・料金・会場を推測で補わないでください。`,
    `- startDate / endDate は YYYY-MM-DD 形式。単日開催なら endDate は startDate と同じ値にすること。年が明記されていない場合は ${year} 年としてください。`,
    `- startTime / endTime は HH:MM 形式（24時間表記）。書かれていなければ null。`,
    `- priceText は料金表記そのまま（例： 一般 800円）。無料と明記されている場合のみ isFree を true にすること。`,
    `- dropInNote は、当日参加可・予約不要・当日券あり・入場自由など「ふらっと立ち寄れる」ことが抜粋に明記されている場合のみ、その根拠を短く要約すること。なければ null。`,
    `- accessNote は最寄り駅・徒歩分数など抜粋にあるアクセス情報。なければ null。`,
    `- address は抜粋にある住所。なければ null。`,
    `- description は40文字以内の日本語の要約。`,
    `- sourceIndex は、そのイベントの情報源となった検索結果の番号。`,
    ``,
    `検索結果:`,
    listing,
  ].join("\n");

  const extracted = await ctx.inference.complete(prompt, {
    schema: extractionSchema,
    timeout_secs: 120,
  });

  const events: StoredEvent[] = [];
  const seenKeys = new Set<string>();
  for (const ev of extracted.events) {
    const hit = hits[ev.sourceIndex];
    if (!hit) continue;
    if (!DATE_RE.test(ev.startDate)) continue;
    const endDate =
      ev.endDate && DATE_RE.test(ev.endDate) ? ev.endDate : ev.startDate;
    // The event's period must overlap the requested window.
    if (ev.startDate > range.end || endDate < range.start) continue;
    const key = `${ev.title.trim()}|${ev.venue.trim()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const priceText = (ev.priceText ?? "").trim();
    events.push({
      title: ev.title.trim(),
      venue: ev.venue.trim(),
      address: (ev.address ?? "").trim(),
      accessNote: (ev.accessNote ?? "").trim(),
      startDate: ev.startDate,
      endDate,
      startTime: ev.startTime && TIME_RE.test(ev.startTime) ? ev.startTime : "",
      endTime: ev.endTime && TIME_RE.test(ev.endTime) ? ev.endTime : "",
      category: ev.category,
      priceText: ev.isFree && !priceText ? "無料" : priceText,
      isFree: ev.isFree || priceText.includes("無料"),
      dropInNote: (ev.dropInNote ?? "").trim(),
      description: ev.description.trim(),
      sourceUrl: hit.url,
      sourceName: hit.source || hit.title,
      lat: null,
      lon: null,
    });
  }

  events.sort((a, b) => {
    const ka = `${a.startDate}T${a.startTime || "00:00"}`;
    const kb = `${b.startDate}T${b.startTime || "00:00"}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const top = events.slice(0, 50);
  // Best-effort venue coordinates for the map; failures leave nulls and
  // never fail the search itself.
  try {
    return await geocodeEvents(top, area, center);
  } catch {
    return top;
  }
}

/* ------------------------------------------------------------------ */
/* Cache + response assembly                                           */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 20 * 60 * 1000;
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

function withStatus(
  events: StoredEvent[],
  window: z.infer<typeof windowEnum>,
  now: { date: string; time: string },
): z.infer<typeof eventOut>[] {
  const out: z.infer<typeof eventOut>[] = [];
  for (const ev of events) {
    if (window === "today") {
      // Already over today -> not something you can still drop in on.
      if (ev.endDate < now.date) continue;
      if (ev.endDate === now.date && ev.endTime && ev.endTime <= now.time) {
        continue;
      }
      const started =
        ev.startDate < now.date ||
        (ev.startDate === now.date &&
          (ev.startTime === "" || ev.startTime <= now.time));
      out.push({ ...ev, status: started ? "ongoing" : "scheduled" });
    } else {
      out.push({ ...ev, status: "scheduled" });
    }
  }
  // Ongoing first, then chronological (stored order is already chronological).
  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === "ongoing" ? -1 : 1;
    return 0;
  });
  return out;
}

async function runSearch(
  ctx: Ctx,
  lat: number,
  lon: number,
  window: z.infer<typeof windowEnum>,
  force: boolean,
): Promise<SearchResponse> {
  const now = jstNow();
  const range = windowRange(window, now.date, now.weekday);
  const cellLat = Math.round(lat * 100) / 100;
  const cellLon = Math.round(lon * 100) / 100;
  const cacheKey = `${cellLat},${cellLon}|${window}|${range.start}`;
  const db = ctx.db<typeof schema>();

  const base = {
    window,
    windowLabel: range.label,
    rangeLabel: range.rangeLabel,
    centerLat: lat,
    centerLon: lon,
  };

  if (!force) {
    const rows = await db
      .select()
      .from(schema.eventCache)
      .where(eq(schema.eventCache.cacheKey, cacheKey))
      .limit(1);
    const row = rows[0];
    if (row && Date.now() - row.fetchedAt.getTime() < CACHE_TTL_MS) {
      const parsed = z.array(storedEvent).safeParse(JSON.parse(row.payload));
      if (parsed.success) {
        return {
          ...base,
          status: "ok",
          areaLabel: row.areaLabel,
          areaDetail: row.areaDetail,
          fetchedAt: row.fetchedAt.toISOString(),
          fromCache: true,
          events: withStatus(parsed.data, window, now),
          message: "",
        };
      }
    }
  }

  const area = await reverseGeocode(lat, lon);
  if (!area) {
    return {
      ...base,
      status: "no_area",
      areaLabel: "",
      areaDetail: "",
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      events: [],
      message:
        "現在地のエリア名を取得できませんでした。場所名で検索してみてください。",
    };
  }

  let events: StoredEvent[];
  try {
    events = await fetchEvents(ctx, area, range, { lat, lon });
  } catch {
    return {
      ...base,
      status: "search_failed",
      areaLabel: area.label,
      areaDetail: area.detail,
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      events: [],
      message:
        "イベント情報の取得に失敗しました。少し時間をおいて、もう一度お試しください。",
    };
  }

  const fetchedAt = new Date();
  await db
    .insert(schema.eventCache)
    .values({
      cacheKey,
      areaLabel: area.label,
      areaDetail: area.detail,
      payload: JSON.stringify(events),
      fetchedAt,
    })
    .onConflictDoUpdate({
      target: schema.eventCache.cacheKey,
      set: {
        areaLabel: area.label,
        areaDetail: area.detail,
        payload: JSON.stringify(events),
        fetchedAt,
      },
    });
  // Best-effort prune of week-old cache rows.
  await db
    .delete(schema.eventCache)
    .where(lt(schema.eventCache.fetchedAt, new Date(Date.now() - PRUNE_MS)))
    .catch(() => undefined);

  return {
    ...base,
    status: "ok",
    areaLabel: area.label,
    areaDetail: area.detail,
    fetchedAt: fetchedAt.toISOString(),
    fromCache: false,
    events: withStatus(events, window, now),
    message:
      events.length === 0
        ? `${range.rangeLabel}に、この周辺で見つかるイベントはありませんでした。期間を変えて探してみてください。`
        : "",
  };
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export const Actions = {
  searchNearbyEvents: defineAction({
    description:
      "現在地の緯度・経度から周辺エリアを特定し、指定した期間（今日/明日/今週末）にふらっと立ち寄れる近くのイベントをリアルタイム検索して返す。",
    request: z.object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      window: windowEnum.default("today"),
      force: z.boolean().default(false),
    }),
    response: searchResponse,
    async handler(ctx, args): Promise<SearchResponse> {
      return runSearch(ctx, args.lat, args.lon, args.window, args.force);
    },
  }),

  searchByPlace: defineAction({
    description:
      "場所名・住所・駅名から座標を解決し、その周辺で指定した期間に開催されるイベントを検索して返す（現在地が使えない場合の代替）。",
    request: z.object({
      query: z.string().min(1).max(100),
      window: windowEnum.default("today"),
      force: z.boolean().default(false),
    }),
    response: searchResponse,
    async handler(ctx, args): Promise<SearchResponse> {
      const now = jstNow();
      const range = windowRange(args.window, now.date, now.weekday);
      const coords = await forwardGeocode(args.query);
      if (!coords) {
        return {
          status: "no_area",
          areaLabel: "",
          areaDetail: "",
          centerLat: 0,
          centerLon: 0,
          window: args.window,
          windowLabel: range.label,
          rangeLabel: range.rangeLabel,
          fetchedAt: new Date().toISOString(),
          fromCache: false,
          events: [],
          message: `「${args.query}」の場所が見つかりませんでした。駅名や住所で試してみてください。`,
        };
      }
      return runSearch(ctx, coords.lat, coords.lon, args.window, args.force);
    },
  }),
} satisfies ActionsModule;
