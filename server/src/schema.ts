// Drizzle schema for this space.
//
// One table: a short-lived cache of nearby-event search results, keyed by
// rounded (~1 km) grid cell + date window. It holds no user-owned records —
// rows are overwritten as they go stale and pruned after a week.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const eventCache = sqliteTable("event_cache", {
  cacheKey: text("cache_key").primaryKey(),
  areaLabel: text("area_label").notNull(),
  areaDetail: text("area_detail").notNull().default(""),
  // JSON array of extracted event rows (see server/src/actions.ts).
  payload: text("payload").notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
});
