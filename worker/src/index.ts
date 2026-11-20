import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS?: Fetcher;
  ALLOWED_ORIGINS?: string;
  ADMIN_PASSWORD?: string;
}

interface PlayerRow {
  id: string;
  token_hash: string;
  agency_name: string;
  power_score: number;
  cash: number;
  fans: number;
  pr: number;
  week: number;
  streamer_count: number;
  top_streamer_id: string;
  top_streamer_name: string;
  destiny: string;
  scandal_risk: number;
  reputation_pts: number;
  unlocked_endings: string;
  unlocked_talents: string;
  daily_pvp_used: number;
  daily_pvp_date: string;
  last_claim_ts: number;
  pending_raid_loss: number;
  ai_gen_count: number;
  ai_gen_window_ts: number;
  daily_glowsticks_used?: number;
  daily_glowsticks_date?: string;
  is_banned?: number;
  updated_at: number;
  created_at: number;
}

const DEFAULT_ALLOWED_ORIGINS = [
  'https://niceoneto.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

const DAILY_PVP_LIMIT = 5;
const DAILY_GLOWSTICKS_LIMIT = 10;
const OFFLINE_MAX_SECONDS = 12 * 3600; // 12 小时封顶
const OFFLINE_MIN_SECONDS = 60; // 满 1 分钟即可领
const AI_WINDOW_SECONDS = 600; // 10 分钟窗口
const AI_MAX_PER_WINDOW = 8; // 每玩家每 10 分钟最多 8 次 AI 文案/神评

const app = new Hono<{ Bindings: Env }>();

// 1. 严格 CORS 白名单 + 全局安全响应头
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin') || '';
  const extraOrigins = (c.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const reqHostOrigin = new URL(c.req.url).origin;

  const isAllowed =
    !origin ||
    origin === reqHostOrigin ||
    DEFAULT_ALLOWED_ORIGINS.includes(origin) ||
    extraOrigins.includes(origin) ||
    /^https:\/\/[a-z0-9-]+\.workers\.dev$/i.test(origin) ||
    /^https:\/\/[a-z0-9-]+\.pages\.dev$/i.test(origin);

  const corsMiddleware = cors({
    origin: isAllowed && origin ? origin : reqHostOrigin,
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Player-Id', 'X-Player-Token', 'Authorization'],
    maxAge: 86400,
  });

  await corsMiddleware(c, next);

  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  c.header('Vary', 'Origin');
});

// =========================================================================
// 工具函数：清洗、密码学哈希、时间与防作弊边界
// =========================================================================
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function getBeijingDateStr(): string {
  const ms = Date.now() + 8 * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function sanitizeText(raw: unknown, maxLen: number, fallback = ''): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/[<>&"'`]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  return cleaned ? cleaned.slice(0, maxLen) : fallback;
}

function clampNum(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function randomHex(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function authenticatePlayer(
  db: D1Database,
  playerId: string | undefined,
  token: string | undefined
): Promise<PlayerRow | null> {
  if (!playerId || !token || playerId.length > 64 || token.length > 128) return null;
  const row = await db
    .prepare('SELECT * FROM players WHERE id = ?')
    .bind(playerId)
    .first<PlayerRow>();
  if (!row) return null;
  const expected = await sha256Hex(token);
  if (!timingSafeEqual(row.token_hash, expected)) return null;
  return row;
}

async function ensureSeedBroadcasts(db: D1Database): Promise<void> {
  const existing = await db.prepare('SELECT COUNT(*) as cnt FROM broadcasts').first<{ cnt: number }>();
  if (existing && existing.cnt > 0) return;

  const ts = nowSec();
  const seeds = [
    {
      type: 'ssr_pull',
      player_id: 'npc_seed_1',
      agency_name: '步行街严选MCN',
      message: '在人才盲盒一发入魂，豪揽 SSR 顶流【董先生】，直播间文采直接拉爆！',
      likes: 1842,
      created_at: ts - 1800,
    },
    {
      type: 'pvp_revenge',
      player_id: 'npc_seed_2',
      agency_name: '紫金湖密互娱',
      message: '连夜甩出第三方质检报告，将同行水军黑通稿按在地上摩擦，反赚 18.5w！',
      likes: 1290,
      created_at: ts - 1200,
    },
    {
      type: 'ending_goat',
      player_id: 'npc_seed_3',
      agency_name: '五棵松带货战舰',
      message: '12周登顶行业之巅，喜提虎扑 JRs 9.9 分【商业 GOAT】封神评级！',
      likes: 2560,
      created_at: ts - 600,
    },
  ];

  const stmts = seeds.map((s) =>
    db
      .prepare(
        'INSERT INTO broadcasts (type, player_id, agency_name, message, likes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(s.type, s.player_id, s.agency_name, s.message, s.likes, s.created_at)
  );
  await db.batch(stmts);
}

// =========================================================================
// 1. 健康检查
// =========================================================================
app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    service: 'hupu-mcn-worker',
    version: '3.1.0',
    serverTime: nowSec(),
  });
});

// =========================================================================
// 2. 匿名注册与发证 (自动生成全服不重复推荐机构名，拒绝千篇一律撞名)
// =========================================================================
const AGENCY_PREFIXES = [
  '星河', '霓虹', '橘子', '破晓', '山海', '云霄', '琥珀', '炽焰', '苍穹', '白昼',
  '落樱', '极光', '星辰', '流光', '繁星', '量子', '银河', '拾光', '追风', '潮汐',
  '暮光', '锦鲤', '青柠', '微醺', '曜石', '天际', '绯红', '翡翠', '千禧', '热浪'
];
const AGENCY_CORES = [
  '造物', '造星', '严选', '星梦', '奇点', '风暴', '幻影', '棱镜', '次元', '引力',
  '浪潮', '风向', '美学', '先锋', '宇宙', '星图', '新锐', '奇迹', '无限', '光年'
];
const AGENCY_SUFFIXES = ['互娱', '传媒', '社', '工坊', '矩阵', 'MCN', '工作室', '文化'];

const RESERVED_NPC_NAMES = new Set<string>([
  '破晓互娱', '星海圣殿互娱', '魅影壹号工坊', '狂飙三兄弟网络', '九州文脉严选',
  '瀚海源头集团', '星霸互娱', '无极星芒', '天娱星耀', '步行街严选MCN', '紫金湖密互娱', '五棵松带货战舰'
]);

async function isAgencyNameAvailable(
  db: D1Database,
  name: string,
  excludePlayerId?: string
): Promise<{ available: boolean; reason?: string }> {
  const cleaned = sanitizeText(name, 16, '');
  if (!cleaned || cleaned.length < 2) {
    return { available: false, reason: 'INVALID_LENGTH' };
  }
  if (RESERVED_NPC_NAMES.has(cleaned)) {
    return { available: false, reason: 'RESERVED_NPC_NAME' };
  }
  const dup = excludePlayerId
    ? await db
        .prepare('SELECT id FROM players WHERE agency_name = ? AND id != ? LIMIT 1')
        .bind(cleaned, excludePlayerId)
        .first<{ id: string }>()
    : await db
        .prepare('SELECT id FROM players WHERE agency_name = ? LIMIT 1')
        .bind(cleaned)
        .first<{ id: string }>();
  if (dup) return { available: false, reason: 'ALREADY_EXISTS' };
  return { available: true };
}

async function generateUniqueAgencyName(db: D1Database, preferred?: string): Promise<string> {
  const candidate = sanitizeText(preferred, 16, '');
  if (candidate && candidate.length >= 2) {
    const chk = await isAgencyNameAvailable(db, candidate);
    if (chk.available) return candidate;
    for (let k = 0; k < 6; k++) {
      const tag = Math.floor(10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 890));
      const alt = (candidate.slice(0, 10) + '#' + tag).slice(0, 14);
      const chkAlt = await isAgencyNameAvailable(db, alt);
      if (chkAlt.available) return alt;
    }
  }

  for (let attempt = 0; attempt < 24; attempt++) {
    const r = crypto.getRandomValues(new Uint32Array(3));
    const name =
      AGENCY_PREFIXES[r[0] % AGENCY_PREFIXES.length] +
      AGENCY_CORES[r[1] % AGENCY_CORES.length] +
      AGENCY_SUFFIXES[r[2] % AGENCY_SUFFIXES.length];
    const chk = await isAgencyNameAvailable(db, name);
    if (chk.available) return name.slice(0, 14);
  }
  return '星芒互娱#' + (100 + (crypto.getRandomValues(new Uint32Array(1))[0] % 899));
}

app.get('/api/player/suggest-name', async (c) => {
  const name = await generateUniqueAgencyName(c.env.DB);
  return c.json({ ok: true, agencyName: name });
});

app.get('/api/player/check-name', async (c) => {
  const raw = c.req.query('name') || '';
  const excludeId = c.req.query('playerId') || undefined;
  const chk = await isAgencyNameAvailable(c.env.DB, raw, excludeId);
  return c.json({ ok: true, name: sanitizeText(raw, 16, ''), ...chk });
});

app.post('/api/player/register', async (c) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const preferred = typeof body.agencyName === 'string' ? sanitizeText(body.agencyName, 16, '') : '';
  const strictName = Boolean(body.strictName);
  if (strictName && preferred) {
    const chk = await isAgencyNameAvailable(c.env.DB, preferred);
    if (!chk.available) {
      return c.json({ ok: false, error: 'AGENCY_NAME_TAKEN', reason: chk.reason }, 409);
    }
  }

  let agencyName = await generateUniqueAgencyName(c.env.DB, preferred);
  const playerId = 'jr_' + randomHex(8);
  const authToken = randomHex(24);
  const tokenHash = await sha256Hex(authToken);
  const ts = nowSec();
  const today = getBeijingDateStr();

  for (let retry = 0; retry < 3; retry++) {
    try {
      await c.env.DB.prepare(
        `INSERT INTO players (
          id, token_hash, agency_name, power_score, cash, fans, pr, week,
          streamer_count, top_streamer_id, top_streamer_name, destiny, scandal_risk,
          reputation_pts, unlocked_endings, unlocked_talents,
          daily_pvp_used, daily_pvp_date, last_claim_ts, pending_raid_loss,
          ai_gen_count, ai_gen_window_ts, is_banned, updated_at, created_at
        ) VALUES (?, ?, ?, 45.0, 100.0, 20.0, 80.0, 1, 0, '', '虚位以待', 'none', 0, 0, '[]', '[]', 0, ?, ?, 0, 0, 0, 0, ?, ?)`
      )
        .bind(playerId, tokenHash, agencyName, today, ts, ts, ts)
        .run();
      break;
    } catch (err) {
      if (retry === 2) throw err;
      agencyName = await generateUniqueAgencyName(c.env.DB);
    }
  }

  await ensureSeedBroadcasts(c.env.DB);

  return c.json({
    ok: true,
    playerId,
    authToken,
    agencyName,
    serverTime: ts,
  });
});

app.post('/api/player/rename', async (c) => {
  const player = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );
  if (!player) return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  if (player.is_banned) return c.json({ ok: false, error: 'ACCOUNT_BANNED' }, 403);

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }
  const nextName = sanitizeText(body.agencyName, 16, '');
  const chk = await isAgencyNameAvailable(c.env.DB, nextName, player.id);
  if (!chk.available) {
    return c.json({ ok: false, error: 'AGENCY_NAME_TAKEN', reason: chk.reason }, 409);
  }

  const ts = nowSec();
  await c.env.DB.prepare('UPDATE players SET agency_name = ?, updated_at = ? WHERE id = ?')
    .bind(nextName, ts, player.id)
    .run();

  return c.json({ ok: true, agencyName: nextName, serverTime: ts });
});

// =========================================================================
// 3. 玩家核心战力与局外传承云同步 (带防作弊数值校验)
// =========================================================================
app.post('/api/player/sync', async (c) => {
  const player = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );
  if (!player) {
    return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  if (player.is_banned) {
    return c.json({ ok: false, error: 'ACCOUNT_BANNED' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  const requestedName = sanitizeText(body.agencyName, 16, player.agency_name);
  let agencyName = player.agency_name;
  let nameConflict = false;
  if (requestedName && requestedName !== player.agency_name) {
    const chk = await isAgencyNameAvailable(c.env.DB, requestedName, player.id);
    if (chk.available) {
      agencyName = requestedName;
    } else {
      nameConflict = true;
    }
  }
  const cash = Math.round(clampNum(body.cash, 0, 500000, player.cash) * 10) / 10;
  const fans = Math.round(clampNum(body.fans, 0, 500000, player.fans) * 10) / 10;
  const pr = Math.round(clampNum(body.pr, 0, 150, player.pr));
  const week = Math.floor(clampNum(body.week, 1, 999, player.week));
  const streamerCount = Math.floor(clampNum(body.streamerCount, 0, 200, player.streamer_count));
  const topStreamerId = typeof body.topStreamerId === 'string' && body.topStreamerId.trim() === ''
    ? ''
    : sanitizeText(body.topStreamerId, 20, player.top_streamer_id);
  const topStreamerName = sanitizeText(body.topStreamerName, 18, streamerCount === 0 ? '虚位以待' : player.top_streamer_name);
  const destiny = sanitizeText(body.destiny, 16, player.destiny);
  const scandalRisk = Math.floor(clampNum(body.scandalRisk, 0, 100, player.scandal_risk));
  const reputationPts = Math.floor(
    clampNum(body.reputationPts, player.reputation_pts, 999999, player.reputation_pts)
  );

  // 防作弊：服务端按核心公式复算合理战力上限，拒绝前端硬改无限战力
  const maxReasonablePower =
    cash * 0.4 + fans * 0.5 + pr * 0.3 + streamerCount * 65 + 450;
  const clientPower = clampNum(body.powerScore, 10, 99999, player.power_score);
  const powerScore = Math.round(Math.min(clientPower, maxReasonablePower) * 10) / 10;

  let unlockedEndings = player.unlocked_endings;
  if (Array.isArray(body.unlockedEndings)) {
    const cleanArr = body.unlockedEndings
      .filter((x): x is string => typeof x === 'string' && x.length <= 32)
      .slice(0, 30);
    unlockedEndings = JSON.stringify(Array.from(new Set(cleanArr)));
  }

  let unlockedTalents = player.unlocked_talents;
  if (Array.isArray(body.unlockedTalents)) {
    const cleanArr = body.unlockedTalents
      .filter((x): x is string => typeof x === 'string' && x.length <= 32)
      .slice(0, 30);
    unlockedTalents = JSON.stringify(Array.from(new Set(cleanArr)));
  }

  const ts = nowSec();
  await c.env.DB.prepare(
    `UPDATE players SET
      agency_name = ?, power_score = ?, cash = ?, fans = ?, pr = ?, week = ?,
      streamer_count = ?, top_streamer_id = ?, top_streamer_name = ?,
      destiny = ?, scandal_risk = ?, reputation_pts = ?,
      unlocked_endings = ?, unlocked_talents = ?, updated_at = ?
    WHERE id = ?`
  )
    .bind(
      agencyName,
      powerScore,
      cash,
      fans,
      pr,
      week,
      streamerCount,
      topStreamerId,
      topStreamerName,
      destiny,
      scandalRisk,
      reputationPts,
      unlockedEndings,
      unlockedTalents,
      ts,
      player.id
    )
    .run();

  const [rankRow, totalRow, unreadRow] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) + 1 as rank FROM players WHERE is_banned = 0 AND power_score > ?')
      .bind(powerScore)
      .first<{ rank: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as total FROM players WHERE is_banned = 0').first<{ total: number }>(),
    c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM pvp_logs WHERE defender_id = ? AND status = 'unread'"
    )
      .bind(player.id)
      .first<{ cnt: number }>(),
  ]);

  return c.json({
    ok: true,
    agencyName,
    nameConflict,
    powerScore,
    globalRank: rankRow?.rank ?? 1,
    totalPlayers: totalRow?.total ?? 1,
    unreadPvpCount: unreadRow?.cnt ?? 0,
    serverTime: ts,
  });
});

// =========================================================================
// 4. 全服统一天梯榜数据 + 异步商战匹配名单
// =========================================================================
app.get('/api/leaderboard', async (c) => {
  const player = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );

  const { results } = await c.env.DB.prepare(
    `SELECT id, agency_name, power_score, fans, pr, week, streamer_count,
            top_streamer_name, destiny, scandal_risk, updated_at
     FROM players
     WHERE is_banned = 0
     ORDER BY power_score DESC
     LIMIT 100`
  ).all();

  const totalRow = await c.env.DB.prepare('SELECT COUNT(*) as total FROM players WHERE is_banned = 0').first<{
    total: number;
  }>();

  let selfRank = null;
  let pvpRemaining = DAILY_PVP_LIMIT;
  const today = getBeijingDateStr();

  if (player) {
    const r = await c.env.DB.prepare(
      'SELECT COUNT(*) + 1 as rank FROM players WHERE is_banned = 0 AND power_score > ?'
    )
      .bind(player.power_score)
      .first<{ rank: number }>();
    selfRank = r?.rank ?? 1;
    const usedToday = player.daily_pvp_date === today ? player.daily_pvp_used : 0;
    pvpRemaining = Math.max(0, DAILY_PVP_LIMIT - usedToday);
  }

  return c.json({
    ok: true,
    totalPlayers: totalRow?.total ?? results.length,
    selfId: player?.id ?? null,
    selfRank,
    pvpRemaining,
    dailyPvpLimit: DAILY_PVP_LIMIT,
    leaders: results,
    serverTime: nowSec(),
  });
});

// =========================================================================
// 5. 服务端权威防作弊离线收益 (绝不信任前端时间差)
// =========================================================================
app.post('/api/offline/claim', async (c) => {
  const player = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );
  if (!player) {
    return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const previewOnly = Boolean(body.preview);
  const synergyBonus = clampNum(body.synergyBonus, 1.0, 1.6, 1.0);
  const ts = nowSec();
  const rawDelta = Math.max(0, ts - player.last_claim_ts);
  const cappedDelta = Math.min(rawDelta, OFFLINE_MAX_SECONDS);

  // 查询离线期间收到的真实商战未读记录
  const { results: unreadEvents } = await c.env.DB.prepare(
    `SELECT id, attacker_id, attacker_name, action_type, amount, taunt_msg, created_at
     FROM pvp_logs
     WHERE defender_id = ? AND status = 'unread'
     ORDER BY created_at DESC
     LIMIT 10`
  )
    .bind(player.id)
    .all();

  if (cappedDelta < OFFLINE_MIN_SECONDS) {
    return c.json({
      ok: true,
      claimable: false,
      elapsedSeconds: cappedDelta,
      minSeconds: OFFLINE_MIN_SECONDS,
      cashGain: 0,
      fansGain: 0,
      unreadEvents,
      serverTime: ts,
    });
  }

  const hours = cappedDelta / 3600;
  const hourlyCash = Math.min(90, Math.max(6, player.power_score * 0.08 + player.streamer_count * 2.5));
  const hourlyFans = Math.min(40, Math.max(1.5, player.streamer_count * 1.2 + player.power_score * 0.015));

  const cashGain = Math.round(hourlyCash * hours * synergyBonus * 10) / 10;
  const fansGain = Math.round(hourlyFans * hours * synergyBonus * 10) / 10;

  if (!previewOnly) {
    // 乐观锁防并发双领
    const res = await c.env.DB.prepare(
      'UPDATE players SET last_claim_ts = ?, updated_at = ? WHERE id = ? AND last_claim_ts = ?'
    )
      .bind(ts, ts, player.id, player.last_claim_ts)
      .run();

    if (!res.meta.changes) {
      return c.json({ ok: false, error: 'ALREADY_CLAIMED' }, 409);
    }
  }

  return c.json({
    ok: true,
    claimable: true,
    claimed: !previewOnly,
    elapsedSeconds: cappedDelta,
    maxSeconds: OFFLINE_MAX_SECONDS,
    cashGain,
    fansGain,
    unreadEvents,
    serverTime: ts,
  });
});

// =========================================================================
// 6. 异步商战互动 (发黑通稿 / 商业联名 / 试探挖角) + 一键反杀
// =========================================================================
app.post('/api/pvp/action', async (c) => {
  const attacker = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );
  if (!attacker) {
    return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  const defenderId = sanitizeText(body.defenderId, 64);
  const actionType = sanitizeText(body.actionType, 16);
  if (!defenderId || defenderId === attacker.id) {
    return c.json({ ok: false, error: 'INVALID_TARGET' }, 400);
  }
  if (!['smear', 'collab', 'poach'].includes(actionType)) {
    return c.json({ ok: false, error: 'INVALID_ACTION' }, 400);
  }

  const today = getBeijingDateStr();
  const usedToday = attacker.daily_pvp_date === today ? attacker.daily_pvp_used : 0;
  if (usedToday >= DAILY_PVP_LIMIT) {
    return c.json({ ok: false, error: 'DAILY_LIMIT_REACHED', pvpRemaining: 0 }, 429);
  }

  const defender = await c.env.DB.prepare('SELECT * FROM players WHERE id = ?')
    .bind(defenderId)
    .first<PlayerRow>();
  if (!defender) {
    return c.json({ ok: false, error: 'TARGET_NOT_FOUND' }, 404);
  }

  const ts = nowSec();
  let cashGain = 0;
  let fansGain = 0;
  let prDelta = 0;
  let scandalDelta = 0;
  let amount = 0;
  let tauntMsg = '';
  let resultSummary = '';

  if (actionType === 'smear') {
    amount = Math.round(Math.min(25, Math.max(6, defender.power_score * 0.035)) * 10) / 10;
    cashGain = amount;
    scandalDelta = 8;
    tauntMsg = `深夜在步行街发了篇《扒一扒${defender.agency_name}的贴牌货》，顺走 ${amount}w 流量红利！`;
    resultSummary = `💣 黑通稿引爆热搜！趁乱收割【${defender.agency_name}】转化流水 +${amount}w（黑红度+8）`;
  } else if (actionType === 'collab') {
    amount = 8.0;
    fansGain = 8.0;
    prDelta = 3;
    tauntMsg = `向【${defender.agency_name}】发起“JRs双厨狂喜”联合专场，互送 +8.0w 流量红利！`;
    resultSummary = `🤝 商业联名大获成功！双方各获 +8.0w 粉丝、口碑 +3，格局拉满！`;
  } else {
    // poach 试探挖角：65% 成功
    const roll = (crypto.getRandomValues(new Uint32Array(1))[0] % 100);
    if (roll < 65) {
      amount = Math.round(Math.min(20, Math.max(8, defender.power_score * 0.03)) * 10) / 10;
      cashGain = amount;
      fansGain = 5.0;
      scandalDelta = 10;
      tauntMsg = `私信高薪试探【${defender.agency_name}】旗下主播，撬走商业机密入账 ${amount}w！`;
      resultSummary = `🕵️ 暗度陈仓成功！从【${defender.agency_name}】撬走商单 +${amount}w、粉丝 +5.0w（黑红度+10）`;
    } else {
      amount = 0;
      prDelta = -3;
      tauntMsg = `试图挖角【${defender.agency_name}】的主播，反被对方截图挂到步行街群嘲！`;
      resultSummary = `😅 挖角惨遭截图曝光！被【${defender.agency_name}】主播当场拒绝，口碑 -3`;
    }
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE players SET daily_pvp_used = ?, daily_pvp_date = ?, updated_at = ? WHERE id = ?'
    ).bind(usedToday + 1, today, ts, attacker.id),
    c.env.DB.prepare(
      `INSERT INTO pvp_logs (
        attacker_id, attacker_name, defender_id, defender_name,
        action_type, amount, taunt_msg, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unread', ?)`
    ).bind(
      attacker.id,
      attacker.agency_name,
      defender.id,
      defender.agency_name,
      actionType,
      amount,
      tauntMsg,
      ts
    ),
  ]);

  return c.json({
    ok: true,
    actionType,
    cashGain,
    fansGain,
    prDelta,
    scandalDelta,
    resultSummary,
    pvpRemaining: Math.max(0, DAILY_PVP_LIMIT - (usedToday + 1)),
  });
});

app.get('/api/pvp/inbox', async (c) => {
  const player = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );
  if (!player) {
    return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  const today = getBeijingDateStr();
  const usedToday = player.daily_pvp_date === today ? player.daily_pvp_used : 0;

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM pvp_logs
     WHERE defender_id = ? OR attacker_id = ?
     ORDER BY created_at DESC
     LIMIT 20`
  )
    .bind(player.id, player.id)
    .all();

  return c.json({
    ok: true,
    pvpRemaining: Math.max(0, DAILY_PVP_LIMIT - usedToday),
    dailyPvpLimit: DAILY_PVP_LIMIT,
    logs: results,
  });
});

app.post('/api/pvp/counter', async (c) => {
  const defender = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );
  if (!defender) {
    return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  const logId = Math.floor(clampNum(body.logId, 1, 999999999, 0));
  if (!logId) return c.json({ ok: false, error: 'INVALID_LOG_ID' }, 400);

  const row = await c.env.DB.prepare(
    "SELECT * FROM pvp_logs WHERE id = ? AND defender_id = ? AND status = 'unread'"
  )
    .bind(logId, defender.id)
    .first<{
      id: number;
      attacker_name: string;
      action_type: string;
      amount: number;
    }>();

  if (!row) {
    return c.json({ ok: false, error: 'LOG_NOT_FOUND_OR_HANDLED' }, 404);
  }

  const ts = nowSec();
  if (row.action_type === 'collab') {
    await c.env.DB.prepare("UPDATE pvp_logs SET status = 'read' WHERE id = ?")
      .bind(logId)
      .run();
    return c.json({
      ok: true,
      mode: 'collab_claim',
      cashGain: 0,
      fansGain: 8.0,
      prGain: 3,
      message: `🤝 收下【${row.attacker_name}】的商业联名红利：粉丝 +8.0w、口碑 +3！`,
    });
  }

  // 反杀恶意商战！1.5 倍赔偿 + 全服吃瓜通告
  const revengeCash = Math.round(Math.max(10, row.amount * 1.5) * 10) / 10;
  const broadcastMsg = `连夜甩出铁证与质检报告，将【${row.attacker_name}】的水军抹黑按在地上摩擦，反杀入账 ${revengeCash}w！`;

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE pvp_logs SET status = 'countered' WHERE id = ?").bind(logId),
    c.env.DB.prepare(
      "INSERT INTO broadcasts (type, player_id, agency_name, message, likes, created_at) VALUES ('pvp_revenge', ?, ?, ?, 1, ?)"
    ).bind(defender.id, defender.agency_name, broadcastMsg, ts),
  ]);

  return c.json({
    ok: true,
    mode: 'counter_win',
    cashGain: revengeCash,
    fansGain: 6.0,
    prGain: 5,
    message: `🛡️ 绝地反杀成功！公开质检报告反噬【${row.attacker_name}】，追回并索赔 +${revengeCash}w、涨粉 +6.0w！`,
  });
});

// =========================================================================
// 7. 全服实时大喇叭 & 步行街热搜流
// =========================================================================
app.get('/api/feed', async (c) => {
  await ensureSeedBroadcasts(c.env.DB);

  const { results } = await c.env.DB.prepare(
    'SELECT id, type, player_id, agency_name, message, likes, created_at FROM broadcasts ORDER BY created_at DESC LIMIT 15'
  ).all();

  return c.json({
    ok: true,
    items: results,
    serverTime: nowSec(),
  });
});

app.post('/api/broadcast', async (c) => {
  const player = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );
  if (!player) {
    return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  const type = sanitizeText(body.type, 24, 'ssr_pull');
  if (
    ![
      'ssr_pull',
      'ending_goat',
      'scandal_boom',
      'pvp_revenge',
      'debut_group',
      'fandom_diamond',
      'beauty_glowup',
    ].includes(type)
  ) {
    return c.json({ ok: false, error: 'INVALID_TYPE' }, 400);
  }

  const message = sanitizeText(body.message, 120);
  if (!message) {
    return c.json({ ok: false, error: 'EMPTY_MESSAGE' }, 400);
  }

  const ts = nowSec();
  // 防刷屏：同一玩家 10 秒内限 1 条
  const recent = await c.env.DB.prepare(
    'SELECT created_at FROM broadcasts WHERE player_id = ? ORDER BY created_at DESC LIMIT 1'
  )
    .bind(player.id)
    .first<{ created_at: number }>();
  if (recent && ts - recent.created_at < 10) {
    return c.json({ ok: false, error: 'RATE_LIMITED' }, 429);
  }

  const res = await c.env.DB.prepare(
    'INSERT INTO broadcasts (type, player_id, agency_name, message, likes, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  )
    .bind(type, player.id, player.agency_name, message, ts)
    .run();

  return c.json({
    ok: true,
    id: res.meta.last_row_id,
    createdAt: ts,
  });
});

app.post('/api/broadcast/:id/like', async (c) => {
  const id = Math.floor(clampNum(c.req.param('id'), 1, 999999999, 0));
  if (!id) return c.json({ ok: false, error: 'INVALID_ID' }, 400);

  await c.env.DB.prepare('UPDATE broadcasts SET likes = likes + 1 WHERE id = ?')
    .bind(id)
    .run();

  const row = await c.env.DB.prepare('SELECT likes FROM broadcasts WHERE id = ?')
    .bind(id)
    .first<{ likes: number }>();

  return c.json({ ok: true, id, likes: row?.likes ?? 1 });
});

// =========================================================================
// 8. Cloudflare Workers AI：虎扑步行街实时神评生成器 (带额度保护与优雅降级)
// =========================================================================
interface AiComment {
  user: string;
  text: string;
  likes: number;
  tag: string;
}

function buildFallbackHupuComments(summary: {
  agencyName: string;
  week: number;
  cash: number;
  fans: number;
  pr: number;
  scandalRisk: number;
  topStreamer: string;
  endingTitle: string;
}): AiComment[] {
  const comments: AiComment[] = [];
  if (summary.scandalRisk >= 55) {
    comments.push({
      user: '步行街法外狂徒',
      text: `兄弟们别吵了，${summary.agencyName}黑红度都飙到${summary.scandalRisk}%了还能狂揽${summary.cash}w，这波属于刀尖舔血，建议315直接安排VIP席位！`,
      likes: 2840 + Math.floor(summary.cash),
      tag: '毒舌神评',
    });
  } else {
    comments.push({
      user: '洛杉矶凌晨四点半',
      text: `${summary.agencyName}第${summary.week}周就带着${summary.topStreamer}冲到${summary.fans}w粉丝，口碑还稳在${summary.pr}分，前东家老板今晚估计得连夜吃速效救心丸。`,
      likes: 1920 + Math.floor(summary.fans * 3),
      tag: '高赞亮评',
    });
  }
  comments.push({
    user: '铁血科密不请自来',
    text: `实话实说，这波商业操作我给9.8分，扣0.2分怕主理人骄傲。手握${summary.cash}w现金流，${summary.endingTitle || '这赛季绝对总冠军级别'}！`,
    likes: 1530 + summary.week * 47,
    tag: '理性看球',
  });
  comments.push({
    user: '虎扑老哥在线吃瓜',
    text: `家人们谁懂啊，本来是来蹲${summary.topStreamer}翻车的，结果越看越上头直接下单三件，这MCN确实有点东西！`,
    likes: 988 + Math.floor(summary.pr * 6),
    tag: '真香现场',
  });
  return comments;
}

function parseAiCommentsJson(rawText: string): AiComment[] | null {
  // 去掉 Qwen3 可能输出的 <think>...</think> 思考段
  const stripped = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const match = stripped.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const valid: AiComment[] = [];
    for (const item of parsed.slice(0, 3)) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const user = sanitizeText(obj.user, 14, '虎扑热心JR');
        const text = sanitizeText(obj.text, 90);
        const tag = sanitizeText(obj.tag, 8, '步行街热评');
        const likes = Math.floor(clampNum(obj.likes, 100, 99999, 1688));
        if (text.length >= 8) {
          valid.push({ user, text, likes, tag });
        }
      }
    }
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

app.post('/api/ai/hupu-comments', async (c) => {
  const player = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );
  if (!player) {
    return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const summary = {
    agencyName: sanitizeText(body.agencyName, 16, player.agency_name),
    week: Math.floor(clampNum(body.week, 1, 999, player.week)),
    cash: Math.round(clampNum(body.cash, 0, 500000, player.cash) * 10) / 10,
    fans: Math.round(clampNum(body.fans, 0, 500000, player.fans) * 10) / 10,
    pr: Math.round(clampNum(body.pr, 0, 150, player.pr)),
    scandalRisk: Math.floor(clampNum(body.scandalRisk, 0, 100, player.scandal_risk)),
    topStreamer: sanitizeText(body.topStreamer, 16, player.top_streamer_name),
    endingTitle: sanitizeText(body.endingTitle, 28, ''),
    recentHighlights: sanitizeText(body.recentHighlights, 140, '稳步扩张直播带货版图'),
  };

  const ts = nowSec();
  const inWindow = ts - player.ai_gen_window_ts < AI_WINDOW_SECONDS;
  const countInWindow = inWindow ? player.ai_gen_count : 0;

  // 保护 10,000 Neurons/天 免费额度：超出频控时直接走高质量上下文降级
  if (countInWindow >= AI_MAX_PER_WINDOW || !c.env.AI) {
    return c.json({
      ok: true,
      source: 'fallback_ratelimit',
      comments: buildFallbackHupuComments(summary),
    });
  }

  await c.env.DB.prepare(
    'UPDATE players SET ai_gen_count = ?, ai_gen_window_ts = ? WHERE id = ?'
  )
    .bind(countInWindow + 1, inWindow ? player.ai_gen_window_ts : ts, player.id)
    .run();

  const systemPrompt =
    '你是虎扑步行街资深JR网友模拟器。请根据玩家经营MCN公司的真实战绩，生成3条风格地道、幽默毒舌或吹爆的步行街神评（融入“这波什么水平”“家人们”“打几分”“前东家破防”等社区风格，不要粗口低俗）。严格只输出一个JSON数组，不要输出任何额外文字或markdown代码块。格式：[{"user":"网名","tag":"4字标签","text":"30到65字评语","likes":1800}]';

  const userPrompt = `/no_think\n机构名：${summary.agencyName}；当前第${summary.week}周；现金${summary.cash}万；粉丝${summary.fans}万；口碑${summary.pr}分；黑红塌房风险${summary.scandalRisk}%；王牌主播：${summary.topStreamer}；称号：${summary.endingTitle || '创业逆袭中'}；近期骚操作：${summary.recentHighlights}。请直接输出3条虎扑神评JSON数组。`;

  const modelCandidates = [
    '@cf/qwen/qwen3-30b-a3b-fp8',
    '@cf/google/gemma-4-26b-a4b-it',
    '@cf/meta/llama-3.1-8b-instruct-fp8',
  ];

  for (const model of modelCandidates) {
    try {
      const aiRes = (await c.env.AI.run(model as Parameters<Ai['run']>[0], {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.85,
        max_tokens: 550,
      })) as {
        response?: string | unknown;
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };

      const textOut =
        (typeof aiRes?.response === 'string' && aiRes.response) ||
        (aiRes?.response && typeof aiRes.response === 'object' ? JSON.stringify(aiRes.response) : '') ||
        aiRes?.choices?.[0]?.message?.content ||
        '';

      const parsed = parseAiCommentsJson(textOut);
      if (parsed && parsed.length > 0) {
        return c.json({
          ok: true,
          source: 'workers-ai',
          model,
          comments: parsed,
        });
      }
    } catch (err) {
      console.warn(`Workers AI fallback triggered on ${model}:`, err);
    }
  }

  return c.json({
    ok: true,
    source: 'fallback_model',
    comments: buildFallbackHupuComments(summary),
  });
});

// =========================================================================
// 8.5 饭圈超话人气榜 + 《破晓101》选秀出道投票成团 + Qwen3 双画风彩虹屁×虎扑对线
// =========================================================================
async function ensureSeedFandomData(db: D1Database): Promise<void> {
  const ts = nowSec();
  const stCnt = await db
    .prepare('SELECT COUNT(*) as cnt FROM idol_supertopics')
    .first<{ cnt: number }>();

  if (!stCnt || stCnt.cnt === 0) {
    const seedIdols = [
      { id: 'su', name: '苏晚晴', isBeauty: 1, heat: 26800, votes: 18400, agency: '星耀少女工坊', agencyVotes: 4200 },
      { id: 'meina', name: '步行街小美', isBeauty: 1, heat: 24200, votes: 16900, agency: '虎扑严选MCN', agencyVotes: 3800 },
      { id: 'zhao', name: '国风小昭', isBeauty: 1, heat: 18600, votes: 12500, agency: '长安星梦传媒', agencyVotes: 2900 },
      { id: 'ling', name: '治愈兔兔', isBeauty: 1, heat: 14900, votes: 9800, agency: '元气次元互娱', agencyVotes: 2400 },
      { id: 'daxue', name: '校园练习生', isBeauty: 1, heat: 11200, votes: 7600, agency: '破晓练习生基地', agencyVotes: 1900 },
      { id: 'dong', name: '董先生', isBeauty: 0, heat: 19800, votes: 13200, agency: '文人墨客严选', agencyVotes: 3100 },
      { id: 'yang', name: '疯狂小阳', isBeauty: 0, heat: 17500, votes: 11800, agency: '合肥狂飙传媒', agencyVotes: 2600 },
      { id: 'kun', name: '街球坤哥', isBeauty: 0, heat: 13400, votes: 8900, agency: '五棵松篮球社', agencyVotes: 2100 },
    ];
    await db.batch(
      seedIdols.map((s) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO idol_supertopics (
              streamer_id, streamer_name, is_beauty, supertopic_heat, debut_votes,
              top_agency_name, top_agency_votes, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(s.id, s.name, s.isBeauty, s.heat, s.votes, s.agency, s.agencyVotes, ts)
      )
    );
  }

  const grpCnt = await db
    .prepare('SELECT COUNT(*) as cnt FROM debut_groups')
    .first<{ cnt: number }>();

  if (!grpCnt || grpCnt.cnt === 0) {
    const seedGroups = [
      {
        player_id: 'npc_group_1',
        agency_name: '虎扑严选MCN',
        group_name: '步行街神颜101',
        center_id: 'su',
        center_name: '苏晚晴',
        member_ids: JSON.stringify(['su', 'meina', 'zhao', 'ling']),
        member_names: JSON.stringify(['苏晚晴', '步行街小美', '国风小昭', '治愈兔兔']),
        avg_charm: 94,
        total_votes: 58600,
        cheers: 1688,
        created_at: ts - 7200,
      },
      {
        player_id: 'npc_group_2',
        agency_name: '五棵松星工场',
        group_name: '破晓顶流女团',
        center_id: 'meina',
        center_name: '步行街小美',
        member_ids: JSON.stringify(['meina', 'zhao', 'daxue']),
        member_names: JSON.stringify(['步行街小美', '国风小昭', '校园练习生']),
        avg_charm: 88,
        total_votes: 36200,
        cheers: 942,
        created_at: ts - 3600,
      },
    ];
    await db.batch(
      seedGroups.map((g) =>
        db
          .prepare(
            `INSERT INTO debut_groups (
              player_id, agency_name, group_name, center_id, center_name,
              member_ids, member_names, avg_charm, total_votes, cheers, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            g.player_id,
            g.agency_name,
            g.group_name,
            g.center_id,
            g.center_name,
            g.member_ids,
            g.member_names,
            g.avg_charm,
            g.total_votes,
            g.cheers,
            g.created_at
          )
      )
    );
  }
}

function getSupertopicTierLabel(heat: number): string {
  if (heat >= 30000) return '钻超';
  if (heat >= 10000) return '金超';
  return '银超';
}

app.get('/api/fandom/supertopics', async (c) => {
  await ensureSeedFandomData(c.env.DB);
  const player = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );

  const { results } = await c.env.DB.prepare(
    `SELECT streamer_id, streamer_name, is_beauty, supertopic_heat, debut_votes,
            top_agency_name, top_agency_votes, updated_at
     FROM idol_supertopics
     ORDER BY debut_votes DESC, supertopic_heat DESC
     LIMIT 24`
  ).all();

  const today = getBeijingDateStr();
  let glowsticksRemaining = DAILY_GLOWSTICKS_LIMIT;
  if (player) {
    const usedToday = player.daily_glowsticks_date === today ? Number(player.daily_glowsticks_used || 0) : 0;
    glowsticksRemaining = Math.max(0, DAILY_GLOWSTICKS_LIMIT - usedToday);
  }

  return c.json({
    ok: true,
    items: results,
    glowsticksRemaining,
    dailyGlowsticksLimit: DAILY_GLOWSTICKS_LIMIT,
    serverTime: nowSec(),
  });
});

app.post('/api/fandom/vote', async (c) => {
  const player = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );
  if (!player) {
    return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  await ensureSeedFandomData(c.env.DB);

  const streamerId = sanitizeText(body.streamerId, 24);
  const streamerName = sanitizeText(body.streamerName, 18);
  const isBeauty = body.isBeauty ? 1 : 0;
  const mode = sanitizeText(body.mode, 24, 'free_glowstick');

  if (!streamerId || !streamerName) {
    return c.json({ ok: false, error: 'INVALID_STREAMER' }, 400);
  }
  if (!['free_glowstick', 'cash_milk_ticket', 'station_sister'].includes(mode)) {
    return c.json({ ok: false, error: 'INVALID_MODE' }, 400);
  }

  const ts = nowSec();
  const today = getBeijingDateStr();
  const usedToday = player.daily_glowsticks_date === today ? Number(player.daily_glowsticks_used || 0) : 0;
  let glowsticksRemaining = Math.max(0, DAILY_GLOWSTICKS_LIMIT - usedToday);

  let addedVotes = 0;
  let addedHeat = 0;

  if (mode === 'free_glowstick') {
    const reqUnits = Math.floor(clampNum(body.votes, 1, DAILY_GLOWSTICKS_LIMIT, 1));
    if (glowsticksRemaining <= 0) {
      return c.json(
        { ok: false, error: 'NO_GLOWSTICKS_LEFT', glowsticksRemaining: 0 },
        429
      );
    }
    const useUnits = Math.min(reqUnits, glowsticksRemaining);
    addedVotes = useUnits * 120;
    addedHeat = Math.round(addedVotes * (isBeauty ? 1.35 : 1.1));
    glowsticksRemaining = Math.max(0, glowsticksRemaining - useUnits);

    await c.env.DB.prepare(
      'UPDATE players SET daily_glowsticks_used = ?, daily_glowsticks_date = ?, updated_at = ? WHERE id = ?'
    )
      .bind(usedToday + useUnits, today, ts, player.id)
      .run();
  } else if (mode === 'cash_milk_ticket') {
    addedVotes = Math.floor(clampNum(body.votes, 100, 5000, 800));
    addedHeat = Math.round(addedVotes * (isBeauty ? 1.3 : 1.0));
  } else {
    // station_sister 站姐出神图 / 高定妆造升咖
    addedVotes = Math.floor(clampNum(body.votes, 150, 1500, 450));
    addedHeat = Math.round(addedVotes * (isBeauty ? 1.8 : 1.4));
  }

  const existing = await c.env.DB.prepare(
    'SELECT * FROM idol_supertopics WHERE streamer_id = ?'
  )
    .bind(streamerId)
    .first<{
      streamer_id: string;
      supertopic_heat: number;
      debut_votes: number;
      top_agency_name: string;
      top_agency_votes: number;
    }>();

  const prevHeat = existing ? existing.supertopic_heat : 0;
  const newHeat = prevHeat + addedHeat;
  const newVotes = (existing ? existing.debut_votes : 0) + addedVotes;

  let nextTopAgency = existing?.top_agency_name || player.agency_name;
  let nextTopVotes = existing?.top_agency_votes || 0;
  const candidateAgencyVotes =
    nextTopAgency === player.agency_name ? nextTopVotes + addedVotes : addedVotes;
  if (!existing || nextTopAgency === player.agency_name || candidateAgencyVotes >= nextTopVotes) {
    nextTopAgency = player.agency_name;
    nextTopVotes = Math.max(nextTopVotes, candidateAgencyVotes);
  }

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE idol_supertopics
       SET streamer_name = ?, is_beauty = ?, supertopic_heat = ?, debut_votes = ?,
           top_agency_name = ?, top_agency_votes = ?, updated_at = ?
       WHERE streamer_id = ?`
    )
      .bind(streamerName, isBeauty, newHeat, newVotes, nextTopAgency, nextTopVotes, ts, streamerId)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO idol_supertopics (
        streamer_id, streamer_name, is_beauty, supertopic_heat, debut_votes,
        top_agency_name, top_agency_votes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(streamerId, streamerName, isBeauty, newHeat, newVotes, nextTopAgency, nextTopVotes, ts)
      .run();
  }

  // 突破 30,000 钻超门槛时自动全服喇叭播报
  let crossedDiamond = false;
  if (prevHeat < 30000 && newHeat >= 30000) {
    crossedDiamond = true;
    const msg = `顶流加冕！【${streamerName}】超话热度冲破3万正式登顶【钻超】！站姐生图刷屏全网！`;
    await c.env.DB.prepare(
      "INSERT INTO broadcasts (type, player_id, agency_name, message, likes, created_at) VALUES ('fandom_diamond', ?, ?, ?, 1, ?)"
    )
      .bind(player.id, player.agency_name, msg, ts)
      .run();
  }

  return c.json({
    ok: true,
    streamerId,
    streamerName,
    addedVotes,
    addedHeat,
    totalVotes: newVotes,
    supertopicHeat: newHeat,
    tier: getSupertopicTierLabel(newHeat),
    crossedDiamond,
    glowsticksRemaining,
    dailyGlowsticksLimit: DAILY_GLOWSTICKS_LIMIT,
    serverTime: ts,
  });
});

app.get('/api/fandom/groups', async (c) => {
  await ensureSeedFandomData(c.env.DB);

  const { results } = await c.env.DB.prepare(
    `SELECT id, player_id, agency_name, group_name, center_id, center_name,
            member_ids, member_names, avg_charm, total_votes, cheers, created_at
     FROM debut_groups
     ORDER BY total_votes DESC, created_at DESC
     LIMIT 30`
  ).all();

  return c.json({
    ok: true,
    groups: results,
    serverTime: nowSec(),
  });
});

app.post('/api/fandom/debut', async (c) => {
  const player = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );
  if (!player) {
    return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  const groupName = sanitizeText(body.groupName, 14);
  const centerId = sanitizeText(body.centerId, 24);
  const centerName = sanitizeText(body.centerName, 18);
  if (groupName.length < 2 || !centerId || !centerName) {
    return c.json({ ok: false, error: 'INVALID_GROUP_PARAMS' }, 400);
  }

  const rawIds = Array.isArray(body.memberIds) ? body.memberIds : [];
  const rawNames = Array.isArray(body.memberNames) ? body.memberNames : [];
  const memberIds = Array.from(
    new Set(
      rawIds
        .map((x) => sanitizeText(x, 24))
        .filter(Boolean)
    )
  ).slice(0, 5);
  const memberNames = rawNames
    .map((x) => sanitizeText(x, 18))
    .filter(Boolean)
    .slice(0, 5);

  if (memberIds.length < 3 || memberNames.length < 3) {
    return c.json({ ok: false, error: 'NEED_AT_LEAST_3_MEMBERS' }, 400);
  }

  const avgCharm = Math.floor(clampNum(body.avgCharm, 45, 100, 82));
  const totalVotes = Math.floor(clampNum(body.totalVotes, 500, 999999, 6000));
  const ts = nowSec();

  // 每家机构在出道殿堂保持其最新旗舰成团阵容，防刷重复行
  const existing = await c.env.DB.prepare(
    'SELECT id, cheers FROM debut_groups WHERE player_id = ? LIMIT 1'
  )
    .bind(player.id)
    .first<{ id: number; cheers: number }>();

  let groupId = 0;
  if (existing) {
    groupId = existing.id;
    await c.env.DB.prepare(
      `UPDATE debut_groups
       SET agency_name = ?, group_name = ?, center_id = ?, center_name = ?,
           member_ids = ?, member_names = ?, avg_charm = ?, total_votes = ?, created_at = ?
       WHERE id = ?`
    )
      .bind(
        player.agency_name,
        groupName,
        centerId,
        centerName,
        JSON.stringify(memberIds),
        JSON.stringify(memberNames),
        avgCharm,
        totalVotes,
        ts,
        existing.id
      )
      .run();
  } else {
    const res = await c.env.DB.prepare(
      `INSERT INTO debut_groups (
        player_id, agency_name, group_name, center_id, center_name,
        member_ids, member_names, avg_charm, total_votes, cheers, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
      .bind(
        player.id,
        player.agency_name,
        groupName,
        centerId,
        centerName,
        JSON.stringify(memberIds),
        JSON.stringify(memberNames),
        avgCharm,
        totalVotes,
        ts
      )
      .run();
    groupId = Number(res.meta.last_row_id || 0);
  }

  const broadcastMsg = `重磅官宣！旗下天团【${groupName}】（C位：${centerName}，均颜${avgCharm}分）在《破晓101》荣耀成团出道！`;
  await c.env.DB.prepare(
    "INSERT INTO broadcasts (type, player_id, agency_name, message, likes, created_at) VALUES ('debut_group', ?, ?, ?, 1, ?)"
  )
    .bind(player.id, player.agency_name, broadcastMsg, ts)
    .run();

  return c.json({
    ok: true,
    groupId,
    groupName,
    centerName,
    avgCharm,
    totalVotes,
    serverTime: ts,
  });
});

app.post('/api/fandom/groups/:id/cheer', async (c) => {
  const id = Math.floor(clampNum(c.req.param('id'), 1, 999999999, 0));
  if (!id) return c.json({ ok: false, error: 'INVALID_ID' }, 400);

  await c.env.DB.prepare('UPDATE debut_groups SET cheers = cheers + 1 WHERE id = ?')
    .bind(id)
    .run();

  const row = await c.env.DB.prepare('SELECT cheers FROM debut_groups WHERE id = ?')
    .bind(id)
    .first<{ cheers: number }>();

  return c.json({ ok: true, id, cheers: row?.cheers ?? 1 });
});

interface FandomCopyResult {
  fandomPost: { author: string; text: string; reposts: number };
  hupuCrossPost: { user: string; text: string; likes: number };
}

function buildFallbackFandomCopy(ctx: {
  agencyName: string;
  streamerName: string;
  fanClub: string;
  stageTitle: string;
  charm: number;
  isBeauty: boolean;
  actionType: string;
  groupName: string;
  cpPartner: string;
}): FandomCopyResult {
  if (ctx.actionType === 'debut' && ctx.groupName) {
    return {
      fandomPost: {
        author: `${ctx.streamerName}全球后援会`,
        text: `#${ctx.groupName}成团夜# 哭晕在应援海里！从素颜海选到今夜C位加冕，${ctx.streamerName}和队友终于走花路了！${ctx.fanClub}永远做你们的底气，明晚时代广场大屏安排！`,
        reposts: 28600 + ctx.charm * 120,
      },
      hupuCrossPost: {
        user: '步行街嘴硬老哥',
        text: `原本我不看选秀的，但${ctx.agencyName}这个【${ctx.groupName}】均颜实在太顶了，${ctx.streamerName}这波C位直拍我给9.9分，兄弟们别劝了，我去买箱牛奶打投了！`,
        likes: 4120 + ctx.charm * 25,
      },
    };
  }
  if (ctx.actionType === 'cp' && ctx.cpPartner) {
    return {
      fandomPost: {
        author: '磕学家首席产粮站',
        text: `救命！${ctx.streamerName}×${ctx.cpPartner}今晚双人同框甜度超标！一个眼神拉丝直接把超话磕瘫痪，唯粉别吵了，这对双顶流营业就是内娱教科书！`,
        reposts: 16400 + ctx.charm * 85,
      },
      hupuCrossPost: {
        user: '理性分析帝JR',
        text: `虽然知道是${ctx.agencyName}安排的商业CP营业，但这俩人站一起节目效果确实拉满，直播间弹幕都在刷“结婚”，这运营鬼才有点东西。`,
        likes: 2680 + ctx.charm * 18,
      },
    };
  }
  return {
    fandomPost: {
      author: `${ctx.streamerName}神图出圈站姐`,
      text: ctx.isBeauty
        ? `【精修直拍万转】内娱审美救星驾到！${ctx.streamerName}晋升「${ctx.stageTitle}」颜值飙到${ctx.charm}，生图抗住死亡顶光，从素人逆袭女神的养成系痛感谁懂啊！${ctx.fanClub}冲钻超！`
        : `【站姐前线速报】${ctx.streamerName}进阶「${ctx.stageTitle}」！业务能力与气场双杀，${ctx.fanClub}全员做数据控评，这波出圈神图必须锁死热搜前排！`,
      reposts: 14200 + ctx.charm * 95,
    },
    hupuCrossPost: {
      user: '虎扑颜值评分员',
      text: ctx.isBeauty
        ? `家人们实话实说，当年海选戴黑框眼镜我真没认出来，现在${ctx.streamerName}这造型一换，颜值即正义直接把我黑转粉了，这波蜕变打9.8分不过分吧？`
        : `有一说一，${ctx.agencyName}这养成系包装确实离谱，连${ctx.streamerName}都能有站姐拍出大片感，步行街老哥集体表示服气！`,
      likes: 2350 + ctx.charm * 22,
    },
  };
}

function parseAiFandomCopyJson(rawText: string): FandomCopyResult | null {
  const stripped = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const fp = parsed.fandomPost as Record<string, unknown> | undefined;
    const hp = parsed.hupuCrossPost as Record<string, unknown> | undefined;
    if (!fp || !hp) return null;
    const fText = sanitizeText(fp.text, 110);
    const hText = sanitizeText(hp.text, 100);
    if (fText.length < 10 || hText.length < 10) return null;
    return {
      fandomPost: {
        author: sanitizeText(fp.author, 16, '神图前线站姐'),
        text: fText,
        reposts: Math.floor(clampNum(fp.reposts, 500, 999999, 15800)),
      },
      hupuCrossPost: {
        user: sanitizeText(hp.user, 16, '步行街嘴硬JR'),
        text: hText,
        likes: Math.floor(clampNum(hp.likes, 200, 99999, 2580)),
      },
    };
  } catch {
    return null;
  }
}

app.post('/api/ai/fandom-copy', async (c) => {
  const player = await authenticatePlayer(
    c.env.DB,
    c.req.header('X-Player-Id'),
    c.req.header('X-Player-Token')
  );
  if (!player) {
    return c.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const ctx = {
    agencyName: sanitizeText(body.agencyName, 16, player.agency_name),
    streamerName: sanitizeText(body.streamerName, 16, player.top_streamer_name),
    fanClub: sanitizeText(body.fanClub, 12, '星光后援会'),
    stageTitle: sanitizeText(body.stageTitle, 18, '万转神图偶像'),
    charm: Math.floor(clampNum(body.charm, 40, 100, 82)),
    isBeauty: Boolean(body.isBeauty),
    actionType: sanitizeText(body.actionType, 16, 'glowup'),
    groupName: sanitizeText(body.groupName, 16, ''),
    cpPartner: sanitizeText(body.cpPartner, 16, ''),
  };

  const ts = nowSec();
  const inWindow = ts - player.ai_gen_window_ts < AI_WINDOW_SECONDS;
  const countInWindow = inWindow ? player.ai_gen_count : 0;

  if (countInWindow >= AI_MAX_PER_WINDOW || !c.env.AI) {
    return c.json({
      ok: true,
      source: 'fallback_ratelimit',
      ...buildFallbackFandomCopy(ctx),
    });
  }

  await c.env.DB.prepare(
    'UPDATE players SET ai_gen_count = ?, ai_gen_window_ts = ? WHERE id = ?'
  )
    .bind(countInWindow + 1, inWindow ? player.ai_gen_window_ts : ts, player.id)
    .run();

  const actionLabelMap: Record<string, string> = {
    glowup: '高定妆造升咖与站姐神图出圈',
    debut: '《破晓101》选秀成团夜C位出道',
    cp: '双人顶流神仙CP商业营业',
    vote: '粉丝超话冲刺钻超打榜',
  };
  const actionLabel = actionLabelMap[ctx.actionType] || '偶像养成高光时刻';

  const systemPrompt =
    '你同时精通内娱饭圈站姐彩虹屁文化与虎扑步行街老哥幽默点评文化。根据主播养成动态，生成1条饭圈站姐万转神图小作文和1条虎扑步行街跨圈热评（纯正地道中文，不要夹杂英文词汇，突出从素人逆袭女神的成就感与颜值即正义的真香反差，健康幽默无低俗）。严格只输出一个JSON对象，不要markdown代码块或多余文字。格式：{"fandomPost":{"author":"站姐名","text":"40到75字饭圈热帖","reposts":16800},"hupuCrossPost":{"user":"虎扑JR名","text":"35到65字步行街跨圈热评","likes":2680}}';

  const userPrompt = `/no_think\n机构：${ctx.agencyName}；主播：${ctx.streamerName}（${ctx.isBeauty ? '颜值赛道王牌' : '实力人气主播'}）；当前阶段：${ctx.stageTitle}；颜值分：${ctx.charm}/100；粉丝名：${ctx.fanClub}；动态主题：${actionLabel}；成团名：${ctx.groupName || '暂无'}；CP搭档：${ctx.cpPartner || '无'}。请用纯中文直接输出JSON。`;

  const modelCandidates = [
    '@cf/qwen/qwen3-30b-a3b-fp8',
    '@cf/google/gemma-4-26b-a4b-it',
    '@cf/meta/llama-3.1-8b-instruct-fp8',
  ];

  for (const model of modelCandidates) {
    try {
      const aiRes = (await c.env.AI.run(model as Parameters<Ai['run']>[0], {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.85,
        max_tokens: 550,
      })) as {
        response?: string | unknown;
        choices?: Array<{ message?: { content?: string } }>;
      };

      const textOut =
        (typeof aiRes?.response === 'string' && aiRes.response) ||
        (aiRes?.response && typeof aiRes.response === 'object' ? JSON.stringify(aiRes.response) : '') ||
        aiRes?.choices?.[0]?.message?.content ||
        '';

      const parsed = parseAiFandomCopyJson(textOut);
      if (parsed) {
        return c.json({
          ok: true,
          source: 'workers-ai',
          model,
          ...parsed,
        });
      }
    } catch (err) {
      console.warn(`Workers AI fandom-copy fallback on ${model}:`, err);
    }
  }

  return c.json({
    ok: true,
    source: 'fallback_model',
    ...buildFallbackFandomCopy(ctx),
  });
});

// =========================================================================
// 9. 管理后端 API (HMAC-SHA256 鉴权) & 动态主播配置热更新 (/api/admin/*)
// =========================================================================
async function signAdminToken(secret: string, expTs: number): Promise<string> {
  const payload = String(expTs) + '.' + randomHex(8);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sigHex = Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${payload}.${sigHex}`;
}

async function verifyAdminToken(secret: string, token: string): Promise<boolean> {
  if (!secret || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const expTs = Number(parts[0]);
  if (!Number.isFinite(expTs) || expTs <= nowSec()) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expectedHex = Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(parts[2], expectedHex);
}

async function requireAdmin(c: { env: Env; req: { header: (name: string) => string | undefined } }): Promise<string | null> {
  const secret = (c.env.ADMIN_PASSWORD || '').trim();
  if (!secret) return 'ADMIN_NOT_CONFIGURED';
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const ok = await verifyAdminToken(secret, token);
  return ok ? null : 'UNAUTHORIZED';
}

app.get('/api/config/streamers', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM admin_streamers WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 200'
    ).all();
    return c.json({ ok: true, items: results || [], serverTime: nowSec() });
  } catch {
    return c.json({ ok: true, items: [], serverTime: nowSec() });
  }
});

app.post('/api/admin/login', async (c) => {
  const secret = (c.env.ADMIN_PASSWORD || '').trim();
  if (!secret) {
    return c.json({ ok: false, error: 'ADMIN_NOT_CONFIGURED' }, 503);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }
  const inputPw = typeof body.password === 'string' ? body.password : '';
  const [inHash, secHash] = await Promise.all([sha256Hex(inputPw), sha256Hex(secret)]);
  if (!timingSafeEqual(inHash, secHash)) {
    return c.json({ ok: false, error: 'INVALID_PASSWORD' }, 401);
  }
  const expiresAt = nowSec() + 12 * 3600;
  const token = await signAdminToken(secret, expiresAt);
  return c.json({ ok: true, token, expiresAt });
});

app.get('/api/admin/overview', async (c) => {
  const err = await requireAdmin(c);
  if (err) return c.json({ ok: false, error: err }, err === 'ADMIN_NOT_CONFIGURED' ? 503 : 401);

  const dayAgo = nowSec() - 86400;
  const [totalRow, bannedRow, activeRow, bcRow, pvpRow, stRow, dupRows] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM players').first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM players WHERE is_banned = 1').first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM players WHERE updated_at >= ?').bind(dayAgo).first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM broadcasts').first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM pvp_logs').first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM admin_streamers').first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT agency_name, COUNT(*) as c FROM players GROUP BY agency_name HAVING c > 1').all(),
  ]);

  return c.json({
    ok: true,
    totalPlayers: totalRow?.cnt ?? 0,
    bannedPlayers: bannedRow?.cnt ?? 0,
    active24h: activeRow?.cnt ?? 0,
    totalBroadcasts: bcRow?.cnt ?? 0,
    totalPvpLogs: pvpRow?.cnt ?? 0,
    customStreamersCount: stRow?.cnt ?? 0,
    duplicateNamesCount: dupRows.results?.length ?? 0,
    serverTime: nowSec(),
  });
});

app.get('/api/admin/players', async (c) => {
  const err = await requireAdmin(c);
  if (err) return c.json({ ok: false, error: err }, err === 'ADMIN_NOT_CONFIGURED' ? 503 : 401);

  const q = sanitizeText(c.req.query('q'), 32, '');
  const { results } = q
    ? await c.env.DB.prepare(
        `SELECT id, agency_name, power_score, cash, fans, pr, week, streamer_count,
                top_streamer_name, scandal_risk, is_banned, updated_at, created_at
         FROM players
         WHERE agency_name LIKE ? OR id LIKE ?
         ORDER BY power_score DESC LIMIT 120`
      )
        .bind(`%${q}%`, `%${q}%`)
        .all()
    : await c.env.DB.prepare(
        `SELECT id, agency_name, power_score, cash, fans, pr, week, streamer_count,
                top_streamer_name, scandal_risk, is_banned, updated_at, created_at
         FROM players
         ORDER BY power_score DESC LIMIT 120`
      ).all();

  return c.json({ ok: true, items: results || [], serverTime: nowSec() });
});

app.post('/api/admin/players/cleanup-zombies', async (c) => {
  const err = await requireAdmin(c);
  if (err) return c.json({ ok: false, error: err }, err === 'ADMIN_NOT_CONFIGURED' ? 503 : 401);

  // 清理超过 1 小时未活跃且 0 主播的初始僵尸号
  const cutoff = nowSec() - 3600;
  const res = await c.env.DB.prepare(
    'DELETE FROM players WHERE streamer_count = 0 AND week = 1 AND power_score <= 90 AND updated_at < ?'
  )
    .bind(cutoff)
    .run();

  return c.json({ ok: true, deletedCount: res.meta.changes ?? 0 });
});

app.post('/api/admin/players/:id/action', async (c) => {
  const err = await requireAdmin(c);
  if (err) return c.json({ ok: false, error: err }, err === 'ADMIN_NOT_CONFIGURED' ? 503 : 401);

  const id = sanitizeText(c.req.param('id'), 64, '');
  if (!id) return c.json({ ok: false, error: 'INVALID_ID' }, 400);

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }
  const action = sanitizeText(body.action, 24, '');
  const ts = nowSec();

  if (action === 'ban' || action === 'unban') {
    await c.env.DB.prepare('UPDATE players SET is_banned = ?, updated_at = ? WHERE id = ?')
      .bind(action === 'ban' ? 1 : 0, ts, id)
      .run();
    return c.json({ ok: true, action });
  }
  if (action === 'delete') {
    await c.env.DB.prepare('DELETE FROM players WHERE id = ?').bind(id).run();
    return c.json({ ok: true, action });
  }
  if (action === 'rename') {
    const nextName = sanitizeText(body.agencyName, 16, '');
    const chk = await isAgencyNameAvailable(c.env.DB, nextName, id);
    if (!chk.available) return c.json({ ok: false, error: 'AGENCY_NAME_TAKEN', reason: chk.reason }, 409);
    await c.env.DB.prepare('UPDATE players SET agency_name = ?, updated_at = ? WHERE id = ?')
      .bind(nextName, ts, id)
      .run();
    return c.json({ ok: true, action, agencyName: nextName });
  }
  if (action === 'set_power') {
    const pw = Math.round(clampNum(body.powerScore, 10, 99999, 100) * 10) / 10;
    await c.env.DB.prepare('UPDATE players SET power_score = ?, updated_at = ? WHERE id = ?')
      .bind(pw, ts, id)
      .run();
    return c.json({ ok: true, action, powerScore: pw });
  }
  return c.json({ ok: false, error: 'UNSUPPORTED_ACTION' }, 400);
});

app.get('/api/admin/broadcasts', async (c) => {
  const err = await requireAdmin(c);
  if (err) return c.json({ ok: false, error: err }, err === 'ADMIN_NOT_CONFIGURED' ? 503 : 401);
  const { results } = await c.env.DB.prepare(
    'SELECT id, type, player_id, agency_name, message, likes, created_at FROM broadcasts ORDER BY created_at DESC LIMIT 50'
  ).all();
  return c.json({ ok: true, items: results || [] });
});

app.post('/api/admin/broadcast', async (c) => {
  const err = await requireAdmin(c);
  if (err) return c.json({ ok: false, error: err }, err === 'ADMIN_NOT_CONFIGURED' ? 503 : 401);

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }
  const message = sanitizeText(body.message, 120, '');
  const senderName = sanitizeText(body.agencyName, 16, '全服运营中心');
  if (!message) return c.json({ ok: false, error: 'EMPTY_MESSAGE' }, 400);
  const ts = nowSec();
  const res = await c.env.DB.prepare(
    "INSERT INTO broadcasts (type, player_id, agency_name, message, likes, created_at) VALUES ('system_notice', 'admin_system', ?, ?, 888, ?)"
  )
    .bind(senderName, message, ts)
    .run();
  return c.json({ ok: true, id: res.meta.last_row_id, createdAt: ts });
});

app.delete('/api/admin/broadcasts/:id', async (c) => {
  const err = await requireAdmin(c);
  if (err) return c.json({ ok: false, error: err }, err === 'ADMIN_NOT_CONFIGURED' ? 503 : 401);
  const id = Math.floor(clampNum(c.req.param('id'), 1, 999999999, 0));
  if (!id) return c.json({ ok: false, error: 'INVALID_ID' }, 400);
  await c.env.DB.prepare('DELETE FROM broadcasts WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

app.get('/api/admin/streamers', async (c) => {
  const err = await requireAdmin(c);
  if (err) return c.json({ ok: false, error: err }, err === 'ADMIN_NOT_CONFIGURED' ? 503 : 401);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM admin_streamers ORDER BY updated_at DESC LIMIT 200'
  ).all();
  return c.json({ ok: true, items: results || [] });
});

app.post('/api/admin/streamers', async (c) => {
  const err = await requireAdmin(c);
  if (err) return c.json({ ok: false, error: err }, err === 'ADMIN_NOT_CONFIGURED' ? 503 : 401);

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }
  const id = sanitizeText(body.id, 32, '') || ('adm_' + randomHex(4));
  const name = sanitizeText(body.name, 16, '');
  if (!name) return c.json({ ok: false, error: 'NAME_REQUIRED' }, 400);
  const category = sanitizeText(body.category, 20, 'beauty');
  const grade = sanitizeText(body.grade, 20, 'rookie');
  const tier = sanitizeText(body.tier, 8, 'A');
  const title = sanitizeText(body.title, 16, '带货红人');
  const cost = Math.round(clampNum(body.cost, 1, 500, 20));
  const sales = Math.floor(clampNum(body.sales, 20, 120, 55));
  const stamina = Math.floor(clampNum(body.stamina, 50, 100, 90));
  const resilience = Math.floor(clampNum(body.resilience, 30, 100, 75));
  const charm = Math.floor(clampNum(body.charm, 40, 100, 72));
  const tag = sanitizeText(body.tag, 16, '严选达人');
  const ultName = sanitizeText(body.ult_name, 40, '高能清屏带货');
  const desc = sanitizeText(body.desc, 100, '运营后端直签高潜力主播');
  const cgUrl = sanitizeText(body.cg_url, 120, '');
  const isBeauty = body.is_beauty ? 1 : 0;
  const enabled = body.enabled === false || body.enabled === 0 ? 0 : 1;
  const ts = nowSec();

  await c.env.DB.prepare(
    `INSERT INTO admin_streamers (
      id, name, category, grade, tier, title, cost, sales, stamina, resilience,
      charm, tag, ult_name, desc, cg_url, is_beauty, enabled, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, category = excluded.category, grade = excluded.grade,
      tier = excluded.tier, title = excluded.title, cost = excluded.cost,
      sales = excluded.sales, stamina = excluded.stamina, resilience = excluded.resilience,
      charm = excluded.charm, tag = excluded.tag, ult_name = excluded.ult_name,
      desc = excluded.desc, cg_url = excluded.cg_url, is_beauty = excluded.is_beauty,
      enabled = excluded.enabled, updated_at = excluded.updated_at`
  )
    .bind(id, name, category, grade, tier, title, cost, sales, stamina, resilience, charm, tag, ultName, desc, cgUrl, isBeauty, enabled, ts)
    .run();

  return c.json({ ok: true, id, updatedAt: ts });
});

app.delete('/api/admin/streamers/:id', async (c) => {
  const err = await requireAdmin(c);
  if (err) return c.json({ ok: false, error: err }, err === 'ADMIN_NOT_CONFIGURED' ? 503 : 401);
  const id = sanitizeText(c.req.param('id'), 32, '');
  if (!id) return c.json({ ok: false, error: 'INVALID_ID' }, 400);
  await c.env.DB.prepare('DELETE FROM admin_streamers WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// =========================================================================
// 10. 静态前端资源与 /admin 页面路由托管兜底
// =========================================================================
app.get('/admin', async (c) => {
  if (c.env.ASSETS) {
    const u = new URL(c.req.url);
    u.pathname = '/admin.html';
    return c.env.ASSETS.fetch(new Request(u.toString(), c.req.raw));
  }
  return c.text('Admin page unavailable without ASSETS binding', 404);
});

app.all('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ ok: true, service: 'hupu-mcn-worker', hint: 'API endpoints live under /api/*' });
});

export default app;
