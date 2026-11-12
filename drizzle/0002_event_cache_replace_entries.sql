DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE event_cache (
  cache_key TEXT PRIMARY KEY,
  area_label TEXT NOT NULL,
  area_detail TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
