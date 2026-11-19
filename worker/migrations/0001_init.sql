-- MCN王牌经纪人 3.0 破晓帝国 D1 数据库初始化架构
-- 严格遵守索引设计，避免全表扫描消耗 D1 免费行读配额

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  agency_name TEXT NOT NULL DEFAULT '破晓互娱',
  power_score REAL NOT NULL DEFAULT 118.5,
  cash REAL NOT NULL DEFAULT 100.0,
  fans REAL NOT NULL DEFAULT 20.0,
  pr REAL NOT NULL DEFAULT 80.0,
  week INTEGER NOT NULL DEFAULT 1,
  streamer_count INTEGER NOT NULL DEFAULT 1,
  top_streamer_id TEXT NOT NULL DEFAULT 'su',
  top_streamer_name TEXT NOT NULL DEFAULT '苏晚晴',
  destiny TEXT NOT NULL DEFAULT 'none',
  scandal_risk INTEGER NOT NULL DEFAULT 0,
  reputation_pts INTEGER NOT NULL DEFAULT 0,
  unlocked_endings TEXT NOT NULL DEFAULT '[]',
  unlocked_talents TEXT NOT NULL DEFAULT '[]',
  daily_pvp_used INTEGER NOT NULL DEFAULT 0,
  daily_pvp_date TEXT NOT NULL DEFAULT '',
  last_claim_ts INTEGER NOT NULL,
  pending_raid_loss REAL NOT NULL DEFAULT 0,
  ai_gen_count INTEGER NOT NULL DEFAULT 0,
  ai_gen_window_ts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_power ON players(power_score DESC);
CREATE INDEX IF NOT EXISTS idx_players_updated ON players(updated_at DESC);

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  player_id TEXT NOT NULL,
  agency_name TEXT NOT NULL,
  message TEXT NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_created ON broadcasts(created_at DESC);

CREATE TABLE IF NOT EXISTS pvp_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attacker_id TEXT NOT NULL,
  attacker_name TEXT NOT NULL,
  defender_id TEXT NOT NULL,
  defender_name TEXT NOT NULL,
  action_type TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  taunt_msg TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pvp_defender ON pvp_logs(defender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvp_attacker ON pvp_logs(attacker_id, created_at DESC);
