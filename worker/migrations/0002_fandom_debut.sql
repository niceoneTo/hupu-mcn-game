-- MCN王牌经纪人 3.1 饭圈养成 + 颜值进化 + 选秀出道成团 D1 增量迁移

ALTER TABLE players ADD COLUMN daily_glowsticks_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN daily_glowsticks_date TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS idol_supertopics (
  streamer_id TEXT PRIMARY KEY,
  streamer_name TEXT NOT NULL,
  is_beauty INTEGER NOT NULL DEFAULT 0,
  supertopic_heat INTEGER NOT NULL DEFAULT 0,
  debut_votes INTEGER NOT NULL DEFAULT 0,
  top_agency_name TEXT NOT NULL DEFAULT '',
  top_agency_votes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supertopics_heat ON idol_supertopics(supertopic_heat DESC);
CREATE INDEX IF NOT EXISTS idx_supertopics_votes ON idol_supertopics(debut_votes DESC);

CREATE TABLE IF NOT EXISTS debut_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  agency_name TEXT NOT NULL,
  group_name TEXT NOT NULL,
  center_id TEXT NOT NULL,
  center_name TEXT NOT NULL,
  member_ids TEXT NOT NULL DEFAULT '[]',
  member_names TEXT NOT NULL DEFAULT '[]',
  avg_charm INTEGER NOT NULL DEFAULT 75,
  total_votes INTEGER NOT NULL DEFAULT 0,
  cheers INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_debut_groups_rank ON debut_groups(total_votes DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_debut_groups_player ON debut_groups(player_id, created_at DESC);
