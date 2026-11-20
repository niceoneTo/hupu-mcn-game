-- v4.0 唯一机构名索引 + 封禁字段 + 管理后台动态主播池与配置表

-- 1. 清理历史同厂牌名重名僵尸行（保留每组机构名中战力最高且最新活跃的1条记录）
DELETE FROM players
WHERE id NOT IN (
  SELECT keep_id FROM (
    SELECT id AS keep_id,
           ROW_NUMBER() OVER (PARTITION BY agency_name ORDER BY power_score DESC, streamer_count DESC, updated_at DESC) AS rn
    FROM players
  )
  WHERE rn = 1
);

-- 2. 为 agency_name 增加数据库级 UNIQUE 唯一约束，彻底从根源消灭重名
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_agency_name_unique ON players(agency_name);

-- 3. 玩家账号封禁标记（供管理后端监管全服天梯健康度）
ALTER TABLE players ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0;

-- 4. 管理后台动态主播配置表（支持热更新扩充主播池与微调数值）
CREATE TABLE IF NOT EXISTS admin_streamers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'beauty',
  grade TEXT NOT NULL DEFAULT 'rookie',
  tier TEXT NOT NULL DEFAULT 'B',
  title TEXT NOT NULL DEFAULT '带货达人',
  cost REAL NOT NULL DEFAULT 20,
  sales INTEGER NOT NULL DEFAULT 50,
  stamina INTEGER NOT NULL DEFAULT 90,
  resilience INTEGER NOT NULL DEFAULT 75,
  charm INTEGER NOT NULL DEFAULT 68,
  tag TEXT NOT NULL DEFAULT '潜力新星',
  ult_name TEXT NOT NULL DEFAULT '全屏爆单连击',
  desc TEXT NOT NULL DEFAULT '',
  cg_url TEXT NOT NULL DEFAULT '',
  is_beauty INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- 5. 管理后台全局系统设置表
CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
