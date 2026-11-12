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

/** Straight-line distance label from the search centre (not a route). */
function distanceLabel(
  center: { lat: number; lon: number },
  ev: EventItem,
): string | null {
  if (ev.lat === null || ev.lon === null) return null;
  const R = 6371;
  const dLat = ((ev.lat - center.lat) * Math.PI) / 180;
  const dLon = ((ev.lon - center.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((center.lat * Math.PI) / 180) *
      Math.cos((ev.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(s));
  if (km < 0.05) return "すぐ近く";
  if (km < 1) return `直線約${Math.round(km * 1000)}m`;
  return `直線約${km.toFixed(1)}km`;
}

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
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M21 21l-4.3-4.3",
  external: "M15 3h6v6 M10 14L21 3 M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5",
  locate: "M12 2v3 M12 19v3 M2 12h3 M19 12h3 M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
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
      <div className="border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--dim)]">
        地図を表示できませんでした。イベント一覧からご確認ください。
      </div>
    );
  }

  return (
    <div>
      <div
        ref={containerRef}
        className="h-[320px] w-full overflow-hidden border border-[var(--border)] md:h-[380px]"
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
  pinNumber,
  highlighted,
  distance,
  cardId,
  onSelect,
}: {
  ev: EventItem;
  areaLabel: string;
  pinNumber: number | null;
  highlighted: boolean;
  distance: string | null;
  cardId: string;
  onSelect?: () => void;
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
  return (
    <article
      id={cardId}
      onClick={onSelect}
      className={`flex gap-4 border-b border-[var(--border)] px-2 py-5 ${
        highlighted ? "map-selected" : ""
      } ${onSelect ? "cursor-pointer" : ""}`}
    >
      {/* date block */}
      <div className="w-14 shrink-0 text-center">
        <div className="text-xs font-medium tracking-widest text-[var(--dim)]">
          {Number(sm)}月
        </div>
        <div className="font-mincho text-4xl font-bold leading-none text-[var(--text)]">
          {Number(sd)}
        </div>
        <div
          className={`mt-1 text-xs font-semibold ${
            wdOf(ev.startDate) === "日"
              ? "text-[var(--accent)]"
              : wdOf(ev.startDate) === "土"
                ? "text-[#3a6ea5]"
                : "text-[var(--dim)]"
          }`}
        >
          （{wdOf(ev.startDate)}）
        </div>
        <div className="mt-2 text-[13px] font-bold leading-tight text-[var(--accent)]">
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
          <span className="border border-[var(--border)] px-2 py-0.5 text-[11px] font-medium text-[var(--dim)]">
            {ev.category}
          </span>
          {ev.status === "ongoing" && (
            <span className="bg-[var(--accent)] px-2 py-0.5 text-[11px] font-bold text-[var(--accent-ink)]">
              開催中
            </span>
          )}
          {ev.isFree && (
            <span className="bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--accent)]">
              無料
            </span>
          )}
        </div>

        <h3 className="font-mincho mt-2 text-lg font-bold leading-snug text-[var(--text)]">
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
          <span>
            {ev.venue}
            {distance && (
              <span className="ml-2 text-xs font-medium text-[var(--dim)]">
                検索地点から{distance}
              </span>
            )}
          </span>
        </p>
        {ev.address && (
          <p className="ml-[22px] text-xs text-[var(--dim)]">{ev.address}</p>
        )}
        {ev.accessNote && (
          <p className="ml-[22px] mt-0.5 text-xs text-[var(--dim)]">
            {ev.accessNote}
          </p>
        )}

        {ev.description && (
          <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">
            {ev.description}
          </p>
        )}

        <div className="mt-2.5 flex flex-col gap-1.5">
          {ev.priceText && (
            <p className="flex items-center gap-1.5 text-sm text-[var(--text)]">
              <Icon d={PATHS.ticket} size={15} className="shrink-0 text-[var(--dim)]" />
              {ev.priceText}
            </p>
          )}
          {ev.dropInNote && (
            <p className="flex items-start gap-1.5 text-sm font-medium text-[var(--accent)]">
              <Icon d={PATHS.door} size={15} className="mt-0.5 shrink-0" />
              <span>{ev.dropInNote}</span>
            </p>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${mapsQuery}`}
            target="_blank"
            rel="noopener"
            className="inline-flex min-h-8 items-center gap-1 text-sm font-semibold text-[var(--accent)]"
          >
            <Icon d={PATHS.nav} size={14} />
            ここへの行き方
          </a>
          <a
            href={ev.sourceUrl}
            target="_blank"
            rel="noopener"
            className="inline-flex min-h-8 items-center gap-1 text-xs text-[var(--dim)] underline decoration-[var(--border)] underline-offset-2"
          >
            出典：{ev.sourceName}
            <Icon d={PATHS.external} size={12} />
          </a>
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
      className={`min-h-9 shrink-0 border px-3.5 text-sm font-medium transition-colors ${
        active
          ? "border-[var(--text)] bg-[var(--text)] text-[var(--bg)]"
          : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
      }`}
    >
      {children}
    </button>
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

  const visible = useMemo(() => {
    if (!data) return [];
    return data.events.filter(
      (ev) =>
        (category === "すべて" || ev.category === category) &&
        (!freeOnly || ev.isFree) &&
        (!dropInOnly || ev.dropInNote !== ""),
    );
  }, [data, category, freeOnly, dropInOnly]);

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
  const searching = search.isPending || geoBusy;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-5 pb-16">
        {/* ---------- board / hero ---------- */}
        {data && data.status === "ok" ? (
          <header className="pt-8">
            <p className="text-xs font-semibold tracking-[0.2em] text-[var(--accent)]">
              いまここ
            </p>
            <h1 className="font-mincho mt-1 text-4xl font-bold leading-tight">
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
            <p className="text-xs font-semibold tracking-[0.2em] text-[var(--accent)]">
              ふらっと寄れる、近くの催し
            </p>
            <h1 className="font-mincho mt-2 text-4xl font-bold leading-snug">
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
            className="flex min-h-14 w-full items-center justify-center gap-2 bg-[var(--accent)] px-6 text-base font-bold text-[var(--accent-ink)] disabled:opacity-60"
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
              className="min-h-11 min-w-0 flex-1 border border-[var(--border)] bg-[var(--surface)] px-3 text-base text-[var(--text)] placeholder:text-[var(--dim)]"
            />
            <button
              type="submit"
              disabled={searching || placeInput.trim() === ""}
              className="flex min-h-11 shrink-0 items-center gap-1.5 border border-[var(--text)] px-4 text-sm font-semibold disabled:opacity-50"
            >
              <Icon d={PATHS.search} size={16} />
              検索
            </button>
          </form>
        </div>

        {/* ---------- window chips ---------- */}
        <div
          className="mt-6 flex gap-2"
          role="group"
          aria-label="期間を選ぶ"
        >
          {WINDOWS.map((w) => (
            <Chip
              key={w.key}
              active={windowSel === w.key}
              onClick={() => pickWindow(w.key)}
            >
              {w.label}
            </Chip>
          ))}
          {data && source && (
            <button
              type="button"
              onClick={() => runSearch(source, windowSel, true)}
              disabled={searching}
              className="ml-auto flex min-h-9 shrink-0 items-center gap-1.5 px-2 text-sm font-medium text-[var(--dim)] disabled:opacity-50"
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

        {/* ---------- status area ---------- */}
        {searching && (
          <div className="py-14 text-center" role="status">
            <p className="font-mincho text-lg font-bold">
              周辺のイベントを探しています
            </p>
            <p className="mt-2 animate-pulse text-sm text-[var(--dim)]">
              エリアを特定して、開催情報を集めています…
            </p>
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
                className="mt-4 border border-[var(--text)] px-5 py-2 text-sm font-semibold"
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
                className="mt-4 border border-[var(--text)] px-5 py-2 text-sm font-semibold"
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
                      className="border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium"
                    >
                      {w.label}で探す
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {/* filters */}
                <div className="mt-2 flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
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
                <div className="mt-3 flex gap-2">
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

                {visible.length === 0 ? (
                  <p className="py-10 text-center text-sm text-[var(--dim)]">
                    この条件に合うイベントはありません。条件をゆるめてみてください。
                  </p>
                ) : (
                  <>
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
                          className="ml-auto min-h-8 px-2 text-sm font-medium text-[var(--accent)]"
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
                          <p className="border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--dim)]">
                            この条件のイベントは会場の場所を特定できなかったため、地図には表示できません。一覧からご確認ください。
                          </p>
                        ))}
                    </div>

                    <div>
                      {visible.map((ev, i) => (
                        <EventCard
                          key={`${ev.title}-${ev.venue}-${i}`}
                          ev={ev}
                          areaLabel={data.areaLabel}
                          pinNumber={pinNumberFor(i)}
                          highlighted={selectedVisibleIdx === i}
                          distance={distanceLabel(
                            { lat: data.centerLat, lon: data.centerLon },
                            ev,
                          )}
                          cardId={`event-card-${i}`}
                          onSelect={
                            pinNumberFor(i) !== null
                              ? () => handleSelectCard(i)
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </>
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
