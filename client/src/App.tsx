import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import "./assets/hatch-maps.js";
import "./assets/hatch-maps.css";
import { mountMap, type PlaceRef } from "./map_helpers.mjs";

type Result = ApiResponse<typeof api, "searchNearbyEvents">;
type EventItem = Result["events"][number];
type WindowSel = "today" | "tomorrow" | "weekend";
type Source =
  | { kind: "geo"; lat: number; lon: number }
  | { kind: "place"; query: string };

const WINDOWS: { key: WindowSel; label: string }[] = [
  { key: "today", label: "今日" },
  { key: "tomorrow", label: "明日" },
  { key: "weekend", label: "今週末" },
];

const WD = ["日", "月", "火", "水", "木", "金", "土"];
function wdOf(dateStr: string): string {
  return WD[new Date(`${dateStr}T12:00:00Z`).getUTCDay()] ?? "";
}
function mdOf(dateStr: string): string {
  const [, m = "1", d = "1"] = dateStr.split("-");
  return `${Number(m)}/${Number(d)}`;
}
function timeOfDay(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function haversineKm(
  center: { lat: number; lon: number },
  ev: EventItem,
): number | null {
  if (ev.lat === null || ev.lon === null) return null;
  const R = 6371;
  const dLat = ((ev.lat - center.lat) * Math.PI) / 180;
  const dLon = ((ev.lon - center.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((center.lat * Math.PI) / 180) *
      Math.cos((ev.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function fmtDist(km: number): string {
  if (km < 0.05) return "50m以内";
  if (km < 1) return `約${Math.round(km * 1000)}m`;
  return `約${km.toFixed(1)}km`;
}

type AccessInfo = {
  straightKm: number;
  roadKm: number;
  walkMin: number;
  headline: string;
  sub: string;
  modeHint: string;
};

/**
 * Walking estimate from straight-line distance.
 * Road distance is estimated as straight × 1.25 (typical city detour),
 * walking speed 80m/min (standard Japanese walking pace). Always
 * labelled 目安 — the real route is one tap away in Google Maps.
 */
function accessInfo(
  center: { lat: number; lon: number },
  ev: EventItem,
): AccessInfo | null {
  const km = haversineKm(center, ev);
  if (km === null) return null;
  const roadKm = km * 1.25;
  const walkMin = Math.max(1, Math.ceil((roadKm * 1000) / 80));
  let headline: string;
  let modeHint: string;
  if (km < 0.05) {
    headline = "すぐ近く・徒歩1分以内";
    modeHint = "歩いてすぐ";
  } else if (walkMin <= 15) {
    headline = `徒歩約${walkMin}分`;
    modeHint = "歩いて行けます";
  } else if (walkMin <= 25) {
    headline = `徒歩約${walkMin}分`;
    modeHint = "少し歩きます";
  } else if (walkMin <= 45) {
    headline = `徒歩約${walkMin}分`;
    modeHint = "電車・バスも便利です";
  } else {
    headline = `徒歩約${walkMin}分`;
    modeHint = "電車・バスがおすすめ";
  }
  return {
    straightKm: km,
    roadKm,
    walkMin,
    headline,
    sub: `直線${fmtDist(km)} ／ 道のり目安${fmtDist(roadKm)}`,
    modeHint,
  };
}

type PriceInfo = {
  isFree: boolean;
  amounts: number[];
  headline: string;
  levelLabel: string;
  detail: string;
};

function parsePrice(ev: EventItem): PriceInfo {
  const text = (ev.priceText ?? "").trim();
  const amounts: number[] = [];
  const re = /([0-9][0-9,]*)\s*円/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number((m[1] ?? "0").replace(/,/g, ""));
    if (Number.isFinite(n)) amounts.push(n);
  }
  const unique = [...new Set(amounts)].sort((a, b) => a - b);
  if (ev.isFree || (text.includes("無料") && unique.every((n) => n === 0))) {
    return {
      isFree: true,
      amounts: unique,
      headline: "無料",
      levelLabel: "お金はかかりません",
      detail: text || "無料",
    };
  }
  if (unique.length > 0) {
    const min = unique[0] ?? 0;
    const max = unique[unique.length - 1] ?? min;
    const headline =
      min === max
        ? `${min.toLocaleString("ja-JP")}円`
        : `${min.toLocaleString("ja-JP")}〜${max.toLocaleString("ja-JP")}円`;
    const levelLabel =
      max <= 500
        ? "ワンコイン以内"
        : max <= 1000
          ? "1,000円以内"
          : max <= 2000
            ? "1,000円台が中心"
            : "2,000円以上";
    return { isFree: false, amounts: unique, headline, levelLabel, detail: text };
  }
  if (text) {
    return {
      isFree: false,
      amounts: [],
      headline: text,
      levelLabel: "料金は左の表記どおり",
      detail: text,
    };
  }
  return {
    isFree: false,
    amounts: [],
    headline: "料金未記載",
    levelLabel: "出典で確認してください",
    detail: "",
  };
}

function priceSortKey(ev: EventItem): number {
  const p = parsePrice(ev);
  if (p.isFree) return 0;
  if (p.amounts.length > 0) return Math.max(...p.amounts);
  return Number.POSITIVE_INFINITY;
}

/* ---------------- free-time fit ---------------- */

// Categories you can wander through and leave at any point — a short
// look-around is a fair stay estimate. Everything else (live shows,
// theatre, classes, timed workshops) runs on a fixed schedule, so the
// stay estimate is the event's own stated duration when known.
const FLEXIBLE_CATEGORIES = new Set([
  "展示・展覧会",
  "マルシェ・食",
  "祭り・伝統",
  "その他",
]);
const FLEXIBLE_STAY_MIN = 30;
const FIXED_STAY_FALLBACK_MIN = 60;

function hmToMin(t: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

type FitInfo = {
  /** One-way walking minutes from the search centre (null = unknown). */
  travelMin: number | null;
  /** Estimated minutes spent at the event. */
  stayMin: number;
  stayLabel: string;
  /** Round trip + stay (null when travel is unknown). */
  neededMin: number | null;
  /** True when the total provably fits the free time. */
  fits: boolean;
  /** True when travel is unknown, so the fit cannot be judged. */
  unknown: boolean;
};

function fitInfo(
  center: { lat: number; lon: number },
  ev: EventItem,
  freeMinutes: number | null,
): FitInfo {
  const access = accessInfo(center, ev);
  const travelMin = access ? access.walkMin : null;

  let stayMin: number;
  let stayLabel: string;
  if (FLEXIBLE_CATEGORIES.has(ev.category)) {
    stayMin = FLEXIBLE_STAY_MIN;
    stayLabel = "滞在目安30分（出入り自由な催しとして計算）";
  } else {
    const s = ev.startTime ? hmToMin(ev.startTime) : null;
    const e = ev.endTime ? hmToMin(ev.endTime) : null;
    if (s !== null && e !== null && e > s) {
      stayMin = e - s;
      stayLabel = `開催時間どおり約${stayMin}分`;
    } else {
      stayMin = FIXED_STAY_FALLBACK_MIN;
      stayLabel = "滞在目安60分（終了時刻の記載がないため）";
    }
  }

  if (travelMin === null) {
    return {
      travelMin,
      stayMin,
      stayLabel,
      neededMin: null,
      fits: false,
      unknown: true,
    };
  }
  const neededMin = travelMin * 2 + stayMin;
  return {
    travelMin,
    stayMin,
    stayLabel,
    neededMin,
    fits: freeMinutes !== null && neededMin <= freeMinutes,
    unknown: false,
  };
}

function fmtMinutes(min: number): string {
  if (min < 60) return `約${min}分`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r === 0 ? `約${h}時間` : `約${h}時間${r}分`;
}

const FREE_TIME_PRESETS: { minutes: number | null; label: string }[] = [
  { minutes: null, label: "指定なし" },
  { minutes: 30, label: "30分" },
  { minutes: 60, label: "1時間" },
  { minutes: 90, label: "1時間30分" },
  { minutes: 120, label: "2時間" },
  { minutes: 180, label: "3時間" },
];

/* ---------------- icons (inline SVG) ---------------- */

function Icon({
  d,
  size = 16,
  className = "",
}: {
  d: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const PATHS = {
  pin: "M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  nav: "M3 11l19-9-9 19-2-8-8-2Z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 6v6l4 2",
  ticket:
    "M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z M13 5v2 M13 11v2 M13 17v2",
  door: "M13 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3 M13 20H4 M13 20V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16",
  refresh: "M21 12a9 9 0 1 1-2.64-6.36 M21 3v6h-6",
  check: "M20 6L9 17l-5-5",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M21 21l-4.3-4.3",
  external: "M15 3h6v6 M10 14L21 3 M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5",
  locate: "M12 2v3 M12 19v3 M2 12h3 M19 12h3 M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
  walk: "M13 4.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z M12.5 8l-2 5 2.5 2 1 5 M10.5 13l-2.5 2 M13 10l2 1.5 2 .5 M12 15l-1 3-2 2",
  train:
    "M5 15.5V7a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 15.5Z M5 11h14 M9 18l-1.5 3 M15 18l1.5 3 M8.5 14.5h.01 M15.5 14.5h.01",
  yen: "M6 4l6 7 6-7 M12 11v9 M7 14h10 M7 17h10",
};

/* ---------------- map ---------------- */

type MapHandle = {
  selectPlace?: (index: number) => void;
  remove?: () => void;
} | null;

function MapView({
  center,
  centerLabel,
  events,
  selectedPlaceIndex,
  onSelectPlace,
}: {
  center: { lat: number; lon: number };
  centerLabel: string;
  /** Events with coordinates, in list order. Place 0 is the centre. */
  events: EventItem[];
  selectedPlaceIndex: number | null;
  onSelectPlace: (placeIndex: number | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<MapHandle>(null);
  const [unavailable, setUnavailable] = useState(false);

  const places: PlaceRef[] = useMemo(() => {
    const list: PlaceRef[] = [
      { label: centerLabel, lat: center.lat, lng: center.lon },
    ];
    for (const ev of events) {
      if (ev.lat !== null && ev.lon !== null) {
        list.push({ label: ev.title, lat: ev.lat, lng: ev.lon });
      }
    }
    return list;
  }, [center, centerLabel, events]);

  const placesKey = useMemo(
    () => places.map((p) => `${p.label}:${p.lat},${p.lng}`).join("|"),
    [places],
  );

  useEffect(() => {
    setUnavailable(false);
    let cancelled = false;
    const g = globalThis as unknown as { HatchMaps?: unknown };
    if (!g.HatchMaps || !containerRef.current) {
      setUnavailable(true);
      return;
    }
    try {
      const handle = mountMap(
        containerRef.current,
        {
          places,
          baseStyle: "light",
          marker: (_place: PlaceRef, index: number, selected: boolean) =>
            index === 0
              ? `<div class="pin pin--center${selected ? " pin--on" : ""}">◎</div>`
              : `<div class="pin${selected ? " pin--on" : ""}">${index}</div>`,
          onSelectPlace: (index: number | null) => {
            if (!cancelled) onSelectPlace(index);
          },
        },
        () => {
          if (!cancelled) setUnavailable(true);
        },
      ) as MapHandle;
      handleRef.current = handle;
      if (!handle) setUnavailable(true);
    } catch {
      setUnavailable(true);
    }
    return () => {
      cancelled = true;
      try {
        handleRef.current?.remove?.();
      } catch {
        // ignore cleanup errors
      }
      handleRef.current = null;
      if (containerRef.current) containerRef.current.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placesKey]);

  useEffect(() => {
    if (selectedPlaceIndex !== null) {
      try {
        handleRef.current?.selectPlace?.(selectedPlaceIndex);
      } catch {
        // ignore
      }
    }
  }, [selectedPlaceIndex]);

  if (unavailable) {
    return (
      <div className="rounded-[20px] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--dim)] shadow-[var(--shadow-card)]">
        地図を表示できませんでした。イベント一覧からご確認ください。
      </div>
    );
  }

  return (
    <div>
      <div
        ref={containerRef}
        className="h-[320px] w-full overflow-hidden rounded-[20px] shadow-[var(--shadow-card)] md:h-[380px]"
        aria-label="検索地点とイベント会場の地図"
      />
      <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
        ◎ が検索地点、番号ピンがイベント会場です。ピンを押すと該当するイベントに移動し、カードを押すとピンが選ばれます。
      </p>
      <p className="mt-0.5 text-right text-[11px] text-[var(--dim)]">
        <a
          href="https://www.facebook.com/maps/attribution_terms"
          target="_blank"
          rel="noopener"
          className="underline"
        >
          © OpenStreetMap contributors, Map Data Legal Notices
        </a>
      </p>
    </div>
  );
}

/* ---------------- event card ---------------- */

function EventCard({
  ev,
  areaLabel,
  center,
  pinNumber,
  highlighted,
  cardId,
  onSelect,
  fit,
  freeMinutes,
}: {
  ev: EventItem;
  areaLabel: string;
  center: { lat: number; lon: number };
  pinNumber: number | null;
  highlighted: boolean;
  cardId: string;
  onSelect?: () => void;
  fit?: FitInfo;
  freeMinutes?: number | null;
}) {
  const [, sm = "1", sd = "1"] = ev.startDate.split("-");
  const multiDay = ev.endDate !== ev.startDate;
  const timeLabel = ev.startTime
    ? `${ev.startTime}${ev.endTime ? `〜${ev.endTime}` : "〜"}`
    : multiDay
      ? "期間中"
      : "終日";
  const mapsQuery = encodeURIComponent(
    `${ev.venue} ${ev.address || areaLabel}`.trim(),
  );
  const origin = encodeURIComponent(`${center.lat},${center.lon}`);
  const walkUrl = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${mapsQuery}&travelmode=walking`;
  const transitUrl = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${mapsQuery}&travelmode=transit`;
  const access = accessInfo(center, ev);
  const price = parsePrice(ev);
  return (
    <article
      id={cardId}
      onClick={onSelect}
      className={`flex gap-3.5 rounded-[20px] bg-[var(--surface)] p-4 shadow-[var(--shadow-card)] sm:p-5 ${
        highlighted ? "map-selected" : ""
      } ${onSelect ? "press cursor-pointer" : ""}`}
    >
      {/* date tile (calendar-style) */}
      <div className="w-14 shrink-0">
        <div className="flex flex-col items-center rounded-2xl bg-[var(--fill)] px-1 py-2">
          <div className="text-[11px] font-bold tracking-wider text-[var(--accent)]">
            {Number(sm)}月
          </div>
          <div className="font-display text-[26px] font-bold leading-tight text-[var(--text)]">
            {Number(sd)}
          </div>
          <div
            className={`text-[11px] font-semibold ${
              wdOf(ev.startDate) === "日"
                ? "text-[var(--accent)]"
                : wdOf(ev.startDate) === "土"
                  ? "text-[#3a6ea5]"
                  : "text-[var(--dim)]"
            }`}
          >
            （{wdOf(ev.startDate)}）
          </div>
        </div>
        <div className="mt-1.5 text-center text-[13px] font-bold leading-tight text-[var(--accent)]">
          {timeLabel}
        </div>
      </div>

      {/* body */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {pinNumber !== null && (
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-bold text-[var(--accent-ink)]"
              aria-label={`地図のピン番号 ${pinNumber}`}
            >
              {pinNumber}
            </span>
          )}
          <span className="rounded-full bg-[var(--fill)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--dim)]">
            {ev.category}
          </span>
          {ev.status === "ongoing" && (
            <span className="rounded-full bg-[var(--accent)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--accent-ink)]">
              開催中
            </span>
          )}
          {ev.isFree && (
            <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--accent)]">
              無料
            </span>
          )}
          {access && (
            <span className="rounded-full bg-[var(--fill)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--text)]">
              {access.headline}
            </span>
          )}
          {!price.isFree && price.amounts.length > 0 && (
            <span className="rounded-full bg-[var(--fill)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--text)]">
              {price.headline}
            </span>
          )}
          {fit && freeMinutes != null && fit.fits && (
            <span className="rounded-full bg-[var(--accent)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--accent-ink)]">
              空き時間に収まる
            </span>
          )}
          {fit && freeMinutes != null && fit.unknown && (
            <span className="rounded-full bg-[var(--fill)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--dim)]">
              所要時間は要確認
            </span>
          )}
        </div>

        <h3 className="font-display mt-2 text-[17px] font-bold leading-snug tracking-[-0.01em] text-[var(--text)]">
          {ev.title}
        </h3>

        {multiDay && (
          <p className="mt-1 text-xs text-[var(--dim)]">
            {mdOf(ev.startDate)}（{wdOf(ev.startDate)}）〜{mdOf(ev.endDate)}（
            {wdOf(ev.endDate)}）
          </p>
        )}

        <p className="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-[var(--text)]">
          <Icon d={PATHS.pin} size={15} className="mt-0.5 shrink-0 text-[var(--dim)]" />
          <span>{ev.venue}</span>
        </p>
        {ev.address && (
          <p className="ml-[22px] text-xs text-[var(--dim)]">{ev.address}</p>
        )}

        {ev.description && (
          <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">
            {ev.description}
          </p>
        )}

        {/* ---- distance & cost: the two things you judge a drop-in by ---- */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          {/* access */}
          <div className="rounded-2xl bg-[var(--fill)] p-3">
            <p className="flex items-center gap-1 text-[11px] font-bold tracking-wide text-[var(--dim)]">
              <Icon d={PATHS.walk} size={13} />
              現在地から
            </p>
            {access ? (
              <>
                <p className="mt-1 text-[15px] font-bold leading-tight text-[var(--text)]">
                  {access.headline}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-[var(--dim)]">
                  {access.sub}
                  <br />
                  {access.modeHint}
                </p>
              </>
            ) : (
              <>
                <p className="mt-1 text-[15px] font-bold leading-tight text-[var(--text)]">
                  距離は不明
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-[var(--dim)]">
                  会場の場所を特定できず
                  <br />
                  下のルートで確認できます
                </p>
              </>
            )}
            {ev.accessNote && (
              <p className="mt-1.5 border-t border-[var(--border)] pt-1.5 text-[11px] leading-snug text-[var(--text)]">
                <span className="font-semibold">最寄り：</span>
                {ev.accessNote}
              </p>
            )}
          </div>

          {/* cost */}
          <div
            className={`rounded-2xl p-3 ${price.isFree ? "bg-[var(--accent-soft)]" : "bg-[var(--fill)]"}`}
          >
            <p className="flex items-center gap-1 text-[11px] font-bold tracking-wide text-[var(--dim)]">
              <Icon d={PATHS.yen} size={13} />
              入場・参加費（1人）
            </p>
            <p
              className={`mt-1 text-[15px] font-bold leading-tight ${price.isFree ? "text-[var(--accent)]" : "text-[var(--text)]"}`}
            >
              {price.headline}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--dim)]">
              {price.levelLabel}
            </p>
            {price.detail && price.detail !== price.headline && (
              <p className="mt-1.5 border-t border-[var(--border)] pt-1.5 text-[11px] leading-snug text-[var(--text)]">
                {price.detail}
              </p>
            )}
            {!price.detail && (
              <p className="mt-1.5 border-t border-[var(--border)] pt-1.5 text-[11px] leading-snug text-[var(--dim)]">
                出典ページでご確認ください
              </p>
            )}
          </div>
        </div>
        {access && (
          <p className="mt-1.5 text-[11px] text-[var(--dim)]">
            ※徒歩時間は道のり目安（直線×1.25、80m/分）からの概算です。正確な時間・乗り換え・運賃は下のルートで確認できます。
          </p>
        )}

        {fit && freeMinutes != null && (
          <div
            className={`mt-2 rounded-2xl p-3 ${
              fit.fits
                ? "bg-[var(--accent-soft)]"
                : "bg-[var(--fill)]"
            }`}
          >
            <p className="flex items-center gap-1 text-[11px] font-bold tracking-wide text-[var(--dim)]">
              <Icon d={PATHS.clock} size={13} />
              空き時間 {fmtMinutes(freeMinutes)} との兼ね合い
            </p>
            {fit.neededMin !== null && fit.travelMin !== null ? (
              <>
                <p
                  className={`mt-1 text-[15px] font-bold leading-tight ${
                    fit.fits ? "text-[var(--accent)]" : "text-[var(--text)]"
                  }`}
                >
                  {fit.fits
                    ? `往復＋滞在で${fmtMinutes(fit.neededMin)} — 収まります`
                    : `往復＋滞在で${fmtMinutes(fit.neededMin)} — この空き時間では超過`}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-[var(--dim)]">
                  内訳：徒歩往復 約{fit.travelMin * 2}分（片道約
                  {fit.travelMin}分）＋ {fit.stayLabel}
                  <br />
                  電車・バスを使えば移動はもっと短くなります。
                </p>
              </>
            ) : (
              <>
                <p className="mt-1 text-[15px] font-bold leading-tight text-[var(--text)]">
                  移動時間が分からず判定できません
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-[var(--dim)]">
                  会場の場所を特定できなかったため、往復時間を含めた計算ができません。{fit.stayLabel}。下のルートで移動時間を確認してください。
                </p>
              </>
            )}
          </div>
        )}

        {ev.dropInNote && (
          <p className="mt-2 flex items-start gap-1.5 text-sm font-medium text-[var(--accent)]">
            <Icon d={PATHS.door} size={15} className="mt-0.5 shrink-0" />
            <span>{ev.dropInNote}</span>
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a
            href={walkUrl}
            target="_blank"
            rel="noopener"
            onClick={(e) => e.stopPropagation()}
            className="press inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--text)] px-3.5 text-[13px] font-semibold text-[var(--bg)]"
          >
            <Icon d={PATHS.walk} size={14} />
            徒歩ルート
          </a>
          <a
            href={transitUrl}
            target="_blank"
            rel="noopener"
            onClick={(e) => e.stopPropagation()}
            className="press inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--surface)] px-3.5 text-[13px] font-semibold text-[var(--text)] shadow-[var(--shadow-card)] ring-1 ring-[var(--border)]"
          >
            <Icon d={PATHS.train} size={14} />
            電車・バスルート
          </a>
          <a
            href={ev.sourceUrl}
            target="_blank"
            rel="noopener"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex min-h-8 items-center gap-1 text-xs text-[var(--dim)] underline decoration-[var(--border)] underline-offset-2"
          >
            出典：{ev.sourceName}
            <Icon d={PATHS.external} size={12} />
          </a>
          <span className="w-full text-[11px] text-[var(--dim)]">
            交通費は含まれません。電車・バスルートを開くと運賃も表示されます。
          </span>
        </div>
      </div>
    </article>
  );
}

/* ---------------- small building blocks ---------------- */

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`press min-h-9 shrink-0 rounded-full px-3.5 text-sm ${
        active
          ? "bg-[var(--text)] font-semibold text-[var(--bg)]"
          : "bg-[var(--surface)] font-medium text-[var(--text)] shadow-[var(--shadow-card)]"
      }`}
    >
      {children}
    </button>
  );
}

/** Apple-style segmented control: one sliding thumb on a spring-like
 *  curve, re-targeting from its current position when tapped mid-slide. */
function SegmentedControl({
  value,
  onChange,
}: {
  value: WindowSel;
  onChange: (w: WindowSel) => void;
}) {
  const idx = Math.max(
    0,
    WINDOWS.findIndex((w) => w.key === value),
  );
  return (
    <div className="seg flex-1" role="tablist" aria-label="期間を選ぶ">
      <div
        className="seg-thumb"
        style={{
          width: `calc((100% - 4px) / ${WINDOWS.length})`,
          transform: `translateX(${idx * 100}%)`,
        }}
        aria-hidden="true"
      />
      {WINDOWS.map((w) => (
        <button
          key={w.key}
          type="button"
          role="tab"
          aria-selected={value === w.key}
          onClick={() => onChange(w.key)}
          className="seg-btn"
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- search progress ---------------- */

// The server pipeline really runs in this order (area lookup -> web
// search -> extraction -> venue geocoding), but it reports no live
// progress, so the display is an honest estimate: the percentage eases
// out towards a 92% plateau and only the arrival of real results shows
// 100%. Stage advances use typical elapsed times for each phase.
const SEARCH_STAGES = [
  "エリアを特定しています",
  "開催情報を検索しています",
  "イベント情報を読み取っています",
  "会場の場所を確認しています",
] as const;
const STAGE_AT_MS = [0, 1800, 7000, 26000];

function SearchProgress() {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const id = window.setInterval(
      () => setElapsedMs(performance.now() - start),
      120,
    );
    return () => window.clearInterval(id);
  }, []);

  const pct = Math.min(92, Math.round(92 * (1 - Math.exp(-elapsedMs / 9000))));
  let stage = 0;
  STAGE_AT_MS.forEach((t, i) => {
    if (elapsedMs >= t) stage = i;
  });
  const secs = Math.floor(elapsedMs / 1000);
  const elapsedLabel =
    secs < 60 ? `約${secs}秒` : `約${Math.floor(secs / 60)}分${secs % 60}秒`;

  return (
    <div className="py-10" role="status" aria-live="polite">
      <div className="content-in mx-auto max-w-sm rounded-[24px] bg-[var(--surface)] p-6 shadow-[var(--shadow-card)]">
        <div className="flex items-end justify-between gap-2">
          <p className="text-sm font-semibold text-[var(--dim)]">
            周辺のイベントを検索中
          </p>
          <p className="shrink-0 text-xs tabular-nums text-[var(--dim)]">
            経過 {elapsedLabel}
          </p>
        </div>
        <p className="font-display mt-2 text-[56px] font-bold leading-none tracking-[-0.02em] text-[var(--text)]">
          {pct}
          <span className="ml-0.5 text-[26px] font-semibold text-[var(--dim)]">
            %
          </span>
        </p>
        <div
          className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--fill)]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="検索の進み具合（目安）"
        >
          <div
            className="h-full rounded-full bg-[var(--accent)]"
            style={{ width: `${pct}%`, transition: "width 0.25s linear" }}
          />
        </div>
        <ul className="mt-5 flex flex-col gap-2.5">
          {SEARCH_STAGES.map((label, i) => (
            <li key={label} className="flex items-center gap-2.5 text-sm">
              {i < stage ? (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
                  <Icon d={PATHS.check} size={12} />
                </span>
              ) : i === stage ? (
                <span
                  className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[var(--fill-strong)] border-t-[var(--accent)]"
                  aria-hidden="true"
                />
              ) : (
                <span
                  className="h-5 w-5 shrink-0 rounded-full border-2 border-[var(--fill)]"
                  aria-hidden="true"
                />
              )}
              <span
                className={
                  i === stage
                    ? "font-semibold text-[var(--text)]"
                    : i < stage
                      ? "text-[var(--dim)]"
                      : "text-[var(--dim)] opacity-60"
                }
              >
                {label}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-5 border-t border-[var(--border)] pt-3 text-xs leading-relaxed text-[var(--dim)]">
          待っている間、他のアプリに切り替えても大丈夫です。検索はサーバー側で最後まで実行され、結果は保存されるので、この画面に戻って同じ条件で探すとすぐ表示されます。
        </p>
      </div>
    </div>
  );
}

/* ---------------- app ---------------- */

export function App() {
  const [windowSel, setWindowSel] = useState<WindowSel>("today");
  const [source, setSource] = useState<Source | null>(null);
  const [placeInput, setPlaceInput] = useState("");
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoNote, setGeoNote] = useState("");
  const [category, setCategory] = useState("すべて");
  const [freeOnly, setFreeOnly] = useState(false);
  const [dropInOnly, setDropInOnly] = useState(false);
  const [sortMode, setSortMode] = useState<
    "recommended" | "near" | "cheap" | "timefit"
  >("recommended");
  const [freeMinutes, setFreeMinutes] = useState<number | null>(null);
  const [freeInput, setFreeInput] = useState("");
  const [fitsOnly, setFitsOnly] = useState(true);
  const [showMap, setShowMap] = useState(true);
  const [selectedVisibleIdx, setSelectedVisibleIdx] = useState<number | null>(
    null,
  );
  const [selectedPlaceIndex, setSelectedPlaceIndex] = useState<number | null>(
    null,
  );

  const search = useMutation({
    mutationFn: async (v: { source: Source; win: WindowSel; force: boolean }) =>
      v.source.kind === "geo"
        ? await api.searchNearbyEvents({
            lat: v.source.lat,
            lon: v.source.lon,
            window: v.win,
            force: v.force,
          })
        : await api.searchByPlace({
            query: v.source.query,
            window: v.win,
            force: v.force,
          }),
  });

  const runSearch = (src: Source, win: WindowSel, force: boolean) => {
    setCategory("すべて");
    setFreeOnly(false);
    setDropInOnly(false);
    setSortMode("recommended");
    search.mutate({ source: src, win, force });
  };

  const locate = () => {
    if (!("geolocation" in navigator)) {
      setGeoNote("この端末では位置情報が使えません。場所名で検索してください。");
      return;
    }
    setGeoBusy(true);
    setGeoNote("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoBusy(false);
        const src: Source = {
          kind: "geo",
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        };
        setSource(src);
        runSearch(src, windowSel, false);
      },
      (err) => {
        setGeoBusy(false);
        setGeoNote(
          err.code === err.PERMISSION_DENIED
            ? "位置情報が許可されませんでした。下の入力欄から場所名・駅名で探せます。"
            : "現在地を取得できませんでした。場所名で検索してみてください。",
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  };

  const submitPlace = (e: FormEvent) => {
    e.preventDefault();
    const q = placeInput.trim();
    if (!q) return;
    const src: Source = { kind: "place", query: q };
    setSource(src);
    runSearch(src, windowSel, false);
  };

  const pickWindow = (w: WindowSel) => {
    setWindowSel(w);
    if (source) runSearch(source, w, false);
  };

  const data = search.data;
  const categories = useMemo(() => {
    if (!data) return [];
    const seen: string[] = [];
    for (const ev of data.events) {
      if (!seen.includes(ev.category)) seen.push(ev.category);
    }
    return seen;
  }, [data]);

  // Fit judgement for every fetched event against the entered free
  // time, computed once per result set. Keyed by event identity so the
  // list, the counts and the cards all agree.
  const fitByKey = useMemo(() => {
    const map = new Map<string, FitInfo>();
    if (!data) return map;
    const center = { lat: data.centerLat, lon: data.centerLon };
    for (const ev of data.events) {
      map.set(`${ev.title}|${ev.venue}`, fitInfo(center, ev, freeMinutes));
    }
    return map;
  }, [data, freeMinutes]);

  const visible = useMemo(() => {
    if (!data) return [];
    const filtered = data.events.filter((ev) => {
      if (category !== "すべて" && ev.category !== category) return false;
      if (freeOnly && !ev.isFree) return false;
      if (dropInOnly && ev.dropInNote === "") return false;
      if (freeMinutes !== null && fitsOnly) {
        // "Pick up everything that fits": fitting events always pass;
        // unjudgeable ones (venue not located) are kept too and clearly
        // labelled 要確認, so a real candidate is never silently dropped.
        const fit = fitByKey.get(`${ev.title}|${ev.venue}`);
        if (fit && !fit.fits && !fit.unknown) return false;
      }
      return true;
    });
    if (sortMode === "recommended") return filtered;
    const center = { lat: data.centerLat, lon: data.centerLon };
    const withIdx = filtered.map((ev, i) => ({ ev, i }));
    if (sortMode === "near") {
      withIdx.sort((a, b) => {
        const da = haversineKm(center, a.ev) ?? Number.POSITIVE_INFINITY;
        const db = haversineKm(center, b.ev) ?? Number.POSITIVE_INFINITY;
        return da - db || a.i - b.i;
      });
    } else if (sortMode === "timefit") {
      withIdx.sort((a, b) => {
        const fa = fitByKey.get(`${a.ev.title}|${a.ev.venue}`);
        const fb = fitByKey.get(`${b.ev.title}|${b.ev.venue}`);
        const rank = (f: FitInfo | undefined) =>
          f?.fits ? 0 : f?.unknown ? 1 : 2;
        const ra = rank(fa);
        const rb = rank(fb);
        if (ra !== rb) return ra - rb;
        const na = fa?.neededMin ?? Number.POSITIVE_INFINITY;
        const nb = fb?.neededMin ?? Number.POSITIVE_INFINITY;
        return na - nb || a.i - b.i;
      });
    } else {
      withIdx.sort((a, b) => {
        const pa = priceSortKey(a.ev);
        const pb = priceSortKey(b.ev);
        return pa - pb || a.i - b.i;
      });
    }
    return withIdx.map((x) => x.ev);
  }, [data, category, freeOnly, dropInOnly, sortMode, freeMinutes, fitsOnly, fitByKey]);

  // Visible events that have trustworthy venue coordinates, in list
  // order. Place index on the map = position here + 1 (0 is the centre).
  const mappedVisibleIdx = useMemo(() => {
    const out: number[] = [];
    visible.forEach((ev, i) => {
      if (ev.lat !== null && ev.lon !== null) out.push(i);
    });
    return out;
  }, [visible]);
  const mappedEvents = useMemo(
    () =>
      mappedVisibleIdx
        .map((i) => visible[i])
        .filter((ev): ev is EventItem => ev !== undefined),
    [mappedVisibleIdx, visible],
  );
  const pinNumberFor = (visibleIdx: number): number | null => {
    const pos = mappedVisibleIdx.indexOf(visibleIdx);
    return pos >= 0 ? pos + 1 : null;
  };

  // Any change to the visible set (new search, filter change) clears the
  // map/list selection so a stale pin number never points at a new row.
  useEffect(() => {
    setSelectedVisibleIdx(null);
    setSelectedPlaceIndex(null);
  }, [visible]);

  const handleSelectPlace = (placeIndex: number | null) => {
    if (placeIndex === null || placeIndex === 0) {
      setSelectedVisibleIdx(null);
      setSelectedPlaceIndex(null);
      return;
    }
    const visibleIdx = mappedVisibleIdx[placeIndex - 1];
    if (visibleIdx === undefined) return;
    setSelectedPlaceIndex(placeIndex);
    setSelectedVisibleIdx(visibleIdx);
    requestAnimationFrame(() => {
      document
        .getElementById(`event-card-${visibleIdx}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  const handleSelectCard = (visibleIdx: number) => {
    const pin = pinNumberFor(visibleIdx);
    if (pin === null) return;
    setSelectedVisibleIdx(visibleIdx);
    setSelectedPlaceIndex(pin);
  };

  const ongoingCount = data
    ? data.events.filter((e) => e.status === "ongoing").length
    : 0;
  const fitsCount =
    freeMinutes !== null
      ? [...fitByKey.values()].filter((f) => f.fits).length
      : 0;
  const unknownFitCount =
    freeMinutes !== null
      ? [...fitByKey.values()].filter((f) => f.unknown).length
      : 0;
  const searching = search.isPending || geoBusy;

  // Brief real 100% flash the moment results actually land, to close
  // out the estimated progress display.
  const [justDone, setJustDone] = useState(false);
  const wasSearching = useRef(false);
  useEffect(() => {
    if (wasSearching.current && !searching && search.isSuccess) {
      setJustDone(true);
      const t = setTimeout(() => setJustDone(false), 1100);
      wasSearching.current = searching;
      return () => clearTimeout(t);
    }
    wasSearching.current = searching;
  }, [searching, search.isSuccess]);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-5 pb-16">
        {/* ---------- board / hero ---------- */}
        {data && data.status === "ok" ? (
          <header className="pt-8">
            <p className="text-[13px] font-semibold text-[var(--accent)]">
              いまここ
            </p>
            <h1 className="font-display mt-1 text-4xl font-bold leading-tight tracking-[-0.02em]">
              {data.areaLabel}
              <span className="ml-2 align-middle text-base font-medium text-[var(--dim)]">
                のイベント
              </span>
            </h1>
            {data.areaDetail && (
              <p className="mt-1 text-sm text-[var(--dim)]">{data.areaDetail}</p>
            )}
            <p className="mt-3 text-sm text-[var(--dim)]">
              {data.rangeLabel} ・ 全{data.events.length}件
              {data.window === "today" && ongoingCount > 0 && (
                <span className="ml-2 font-semibold text-[var(--accent)]">
                  開催中 {ongoingCount}件
                </span>
              )}
            </p>
          </header>
        ) : (
          <header className="pt-10">
            <p className="text-[13px] font-semibold text-[var(--accent)]">
              ふらっと寄れる、近くの催し
            </p>
            <h1 className="font-display mt-2 text-[40px] font-bold leading-[1.18] tracking-[-0.02em]">
              空いた時間に、
              <br />
              近くで何かやってない？
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
              現在地の周辺で今日・明日・今週末に開催されるイベントを、その場で探します。展示、マルシェ、ライブ、お祭り——ふらっと立ち寄れるものを中心に。
            </p>
          </header>
        )}

        {/* ---------- primary actions ---------- */}
        <div className="mt-6">
          <button
            type="button"
            onClick={locate}
            disabled={searching}
            className="press flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-6 text-base font-bold text-[var(--accent-ink)] shadow-[0_8px_20px_rgba(217,72,31,0.28)] disabled:opacity-60"
          >
            <Icon d={PATHS.locate} size={20} />
            {geoBusy ? "現在地を取得中…" : "現在地から探す"}
          </button>
          {geoNote && (
            <p className="mt-2 text-sm text-[var(--accent)]" role="alert">
              {geoNote}
            </p>
          )}

          <form onSubmit={submitPlace} className="mt-3 flex gap-2">
            <label htmlFor="place-input" className="sr-only">
              場所名・駅名・住所で探す
            </label>
            <input
              id="place-input"
              type="text"
              value={placeInput}
              onChange={(e) => setPlaceInput(e.target.value)}
              placeholder="場所名・駅名・住所で探す（例：梅田駅）"
              className="min-h-11 min-w-0 flex-1 rounded-xl bg-[var(--fill)] px-3.5 text-base text-[var(--text)] placeholder:text-[var(--dim)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
            <button
              type="submit"
              disabled={searching || placeInput.trim() === ""}
              className="press flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-[var(--text)] px-4 text-sm font-semibold text-[var(--bg)] disabled:opacity-50"
            >
              <Icon d={PATHS.search} size={16} />
              検索
            </button>
          </form>
        </div>

        {/* ---------- free time ---------- */}
        <div className="mt-5 rounded-[20px] bg-[var(--surface)] p-4 shadow-[var(--shadow-card)]">
          <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--text)]">
            <Icon d={PATHS.clock} size={16} className="text-[var(--accent)]" />
            空き時間はどれくらい？
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
            入れると、徒歩の往復＋滞在の目安がその時間に収まるイベントをすべて拾って表示します（移動は徒歩計算なので、電車・バスならもっと余裕があります）。
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {FREE_TIME_PRESETS.map((p) => (
              <Chip
                key={p.label}
                active={freeMinutes === p.minutes && freeInput === ""}
                onClick={() => {
                  setFreeMinutes(p.minutes);
                  setFreeInput("");
                }}
              >
                {p.label}
              </Chip>
            ))}
          </div>
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(freeInput);
              if (Number.isFinite(n) && n > 0) {
                setFreeMinutes(Math.round(n));
              }
            }}
          >
            <label htmlFor="free-minutes-input" className="text-sm text-[var(--dim)]">
              自由入力
            </label>
            <input
              id="free-minutes-input"
              type="number"
              inputMode="numeric"
              min={5}
              max={720}
              step={5}
              value={freeInput}
              onChange={(e) => {
                setFreeInput(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value !== "" && Number.isFinite(n) && n > 0) {
                  setFreeMinutes(Math.round(n));
                }
              }}
              placeholder="例：45"
              className="min-h-10 w-24 rounded-xl bg-[var(--fill)] px-3 text-base text-[var(--text)] placeholder:text-[var(--dim)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
            <span className="text-sm text-[var(--dim)]">分</span>
            {freeMinutes !== null && (
              <span className="ml-auto text-sm font-semibold text-[var(--accent)]">
                {fmtMinutes(freeMinutes)}で判定中
              </span>
            )}
          </form>
          {freeMinutes !== null && data && data.status === "ok" && (
            <div className="mt-3 border-t border-[var(--border)] pt-3">
              <p className="text-sm leading-relaxed text-[var(--text)]">
                全{data.events.length}件のうち、
                <span className="font-bold text-[var(--accent)]">
                  収まるのは{fitsCount}件
                </span>
                {unknownFitCount > 0 &&
                  `、判定できないものが${unknownFitCount}件（会場の場所が不明）`}
              </p>
              <div className="mt-2">
                <Chip active={fitsOnly} onClick={() => setFitsOnly((v) => !v)}>
                  収まるものだけ表示
                </Chip>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
                判定できないイベントは落とさず「所要時間は要確認」として残しています。滞在の目安は、展示・マルシェ・祭りなど出入り自由な催しは30分、開演・開始時刻が決まっている催しは開催時間どおり（終了時刻の記載がない場合は60分）で計算しています。
              </p>
            </div>
          )}
        </div>

        {/* ---------- sticky translucent chrome: window + filters ---------- */}
        <div className="chrome -mx-5 mt-5 px-5 pb-3 pt-3">
          <div className="flex items-center gap-2">
            <SegmentedControl value={windowSel} onChange={pickWindow} />
            {data && source && (
              <button
                type="button"
                onClick={() => runSearch(source, windowSel, true)}
                disabled={searching}
                className="press flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-[var(--fill)] px-3 text-[13px] font-medium text-[var(--dim)] disabled:opacity-50"
                aria-label="最新の情報に更新する"
              >
                <Icon
                  d={PATHS.refresh}
                  size={15}
                  className={search.isPending ? "animate-spin" : ""}
                />
                {timeOfDay(data.fetchedAt)}取得
                {data.fromCache ? "（キャッシュ）" : ""}
              </button>
            )}
          </div>

          {/* filters (results only) */}
          {!searching && data && data.status === "ok" && data.events.length > 0 && (
            <>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Chip
                  active={category === "すべて"}
                  onClick={() => setCategory("すべて")}
                >
                  すべて
                </Chip>
                {categories.map((c) => (
                  <Chip
                    key={c}
                    active={category === c}
                    onClick={() => setCategory(c)}
                  >
                    {c}
                  </Chip>
                ))}
              </div>
              <div className="mt-2 flex gap-1.5">
                <Chip active={freeOnly} onClick={() => setFreeOnly((v) => !v)}>
                  無料のみ
                </Chip>
                <Chip
                  active={dropInOnly}
                  onClick={() => setDropInOnly((v) => !v)}
                >
                  予約不要・当日OK
                </Chip>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-[var(--dim)]">
                  並び替え：
                </span>
                <Chip
                  active={sortMode === "recommended"}
                  onClick={() => setSortMode("recommended")}
                >
                  おすすめ順
                </Chip>
                <Chip
                  active={sortMode === "near"}
                  onClick={() => setSortMode("near")}
                >
                  近い順（徒歩時間）
                </Chip>
                <Chip
                  active={sortMode === "cheap"}
                  onClick={() => setSortMode("cheap")}
                >
                  費用が安い順
                </Chip>
                {freeMinutes !== null && (
                  <Chip
                    active={sortMode === "timefit"}
                    onClick={() => setSortMode("timefit")}
                  >
                    空き時間に収まる順
                  </Chip>
                )}
              </div>
            </>
          )}
        </div>

        {/* ---------- status area ---------- */}
        {searching && <SearchProgress />}

        {!searching && justDone && data && data.status === "ok" && (
          <div className="py-6" role="status">
            <div className="content-in mx-auto flex max-w-sm items-center gap-3 rounded-[24px] bg-[var(--surface)] p-5 shadow-[var(--shadow-card)]">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)]">
                <Icon d={PATHS.check} size={18} />
              </span>
              <div>
                <p className="font-display text-xl font-bold leading-tight">
                  100% — 完了
                </p>
                <p className="text-sm text-[var(--dim)]">
                  {data.events.length}件のイベントが見つかりました
                </p>
              </div>
            </div>
          </div>
        )}

        {!searching && search.isError && (
          <div className="py-12 text-center">
            <p className="text-sm leading-relaxed">
              通信に失敗しました。接続を確認して、もう一度お試しください。
            </p>
            {source && (
              <button
                type="button"
                onClick={() => runSearch(source, windowSel, true)}
                className="press mt-4 rounded-full bg-[var(--text)] px-5 py-2 text-sm font-semibold text-[var(--bg)]"
              >
                もう一度探す
              </button>
            )}
          </div>
        )}

        {!searching && data && data.status !== "ok" && (
          <div className="py-12 text-center">
            <p className="text-sm leading-relaxed">{data.message}</p>
            {source && data.status === "search_failed" && (
              <button
                type="button"
                onClick={() => runSearch(source, windowSel, true)}
                className="press mt-4 rounded-full bg-[var(--text)] px-5 py-2 text-sm font-semibold text-[var(--bg)]"
              >
                もう一度探す
              </button>
            )}
          </div>
        )}

        {/* ---------- results ---------- */}
        {!searching && data && data.status === "ok" && (
          <>
            {data.events.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-sm leading-relaxed">{data.message}</p>
                <div className="mt-5 flex justify-center gap-2">
                  {WINDOWS.filter((w) => w.key !== windowSel).map((w) => (
                    <button
                      key={w.key}
                      type="button"
                      onClick={() => pickWindow(w.key)}
                      className="press rounded-full bg-[var(--surface)] px-4 py-2 text-sm font-medium shadow-[var(--shadow-card)]"
                    >
                      {w.label}で探す
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {visible.length === 0 ? (
                  <div className="py-10 text-center">
                    <p className="text-sm text-[var(--dim)]">
                      {freeMinutes !== null && fitsOnly
                        ? `${fmtMinutes(freeMinutes)}に収まるイベントは見つかりませんでした。空き時間を長くするか、「収まるものだけ表示」を外すと全件見られます。`
                        : "この条件に合うイベントはありません。条件をゆるめてみてください。"}
                    </p>
                    {freeMinutes !== null && fitsOnly && (
                      <button
                        type="button"
                        onClick={() => setFitsOnly(false)}
                        className="press mt-4 rounded-full bg-[var(--text)] px-5 py-2 text-sm font-semibold text-[var(--bg)]"
                      >
                        全件を表示する
                      </button>
                    )}
                  </div>
                ) : (
                  <div
                    key={`${data.areaLabel}-${data.window}-${data.fetchedAt}`}
                    className="content-in"
                  >
                    {/* map */}
                    <div className="mt-5">
                      <div className="mb-2 flex items-center gap-2">
                        <h2 className="text-sm font-bold text-[var(--text)]">
                          地図
                        </h2>
                        <span className="text-xs text-[var(--dim)]">
                          会場の場所が分かった {mappedEvents.length} 件を表示
                          {mappedEvents.length < visible.length &&
                            `（${visible.length - mappedEvents.length} 件は場所を特定できず一覧のみ）`}
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowMap((v) => !v)}
                          aria-expanded={showMap}
                          className="press ml-auto min-h-8 rounded-full px-2 text-sm font-medium text-[var(--accent)]"
                        >
                          {showMap ? "地図を隠す" : "地図を表示"}
                        </button>
                      </div>
                      {showMap &&
                        (mappedEvents.length > 0 ? (
                          <MapView
                            center={{
                              lat: data.centerLat,
                              lon: data.centerLon,
                            }}
                            centerLabel={data.areaLabel}
                            events={mappedEvents}
                            selectedPlaceIndex={selectedPlaceIndex}
                            onSelectPlace={handleSelectPlace}
                          />
                        ) : (
                          <p className="rounded-[20px] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--dim)] shadow-[var(--shadow-card)]">
                            この条件のイベントは会場の場所を特定できなかったため、地図には表示できません。一覧からご確認ください。
                          </p>
                        ))}
                    </div>

                    <div className="mt-4 flex items-baseline justify-between gap-2 px-0.5">
                      <h2 className="text-sm font-bold text-[var(--text)]">
                        イベント一覧
                        <span className="ml-2 text-xs font-medium text-[var(--dim)]">
                          {sortMode === "near"
                            ? "近い順に表示中"
                            : sortMode === "cheap"
                              ? "費用が安い順に表示中"
                              : sortMode === "timefit"
                                ? "空き時間に収まる順に表示中"
                                : "開催中・開始が近い順"}
                        </span>
                      </h2>
                      <span className="shrink-0 text-xs text-[var(--dim)]">
                        {visible.length}件
                      </span>
                    </div>
                    <div className="mt-2 flex flex-col gap-3">
                      {visible.map((ev, i) => (
                        <EventCard
                          key={`${ev.title}-${ev.venue}-${i}`}
                          ev={ev}
                          areaLabel={data.areaLabel}
                          center={{
                            lat: data.centerLat,
                            lon: data.centerLon,
                          }}
                          pinNumber={pinNumberFor(i)}
                          highlighted={selectedVisibleIdx === i}
                          cardId={`event-card-${i}`}
                          onSelect={
                            pinNumberFor(i) !== null
                              ? () => handleSelectCard(i)
                              : undefined
                          }
                          fit={fitByKey.get(`${ev.title}|${ev.venue}`)}
                          freeMinutes={freeMinutes}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <p className="mt-6 text-xs leading-relaxed text-[var(--dim)]">
                  開催時間や料金は変更されることがあります。出かける前に各イベントの出典ページで最新情報をご確認ください。
                </p>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
