import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS?: Fetcher;
  ALLOWED_ORIGINS?: string;
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
const OFFLINE_MAX_SECONDS = 12 * 3600; // 12 小时封顶
const OFFLINE_MIN_SECONDS = 60; // 满 1 分钟即可领
const AI_WINDOW_SECONDS = 600; // 10 分钟窗口
const AI_MAX_PER_WINDOW = 4; // 每玩家每 10 分钟最多 4 次 AI 神评

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
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Player-Id', 'X-Player-Token'],
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
    version: '3.0.0',
    serverTime: nowSec(),
  });
});

// =========================================================================
// 2. 匿名注册与发证 (无需繁琐登录，开箱即连全服)
// =========================================================================
app.post('/api/player/register', async (c) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const agencyName = sanitizeText(body.agencyName, 16, '破晓互娱');
  const playerId = 'jr_' + randomHex(8);
  const authToken = randomHex(24);
  const tokenHash = await sha256Hex(authToken);
  const ts = nowSec();
  const today = getBeijingDateStr();

  await c.env.DB.prepare(
    `INSERT INTO players (
      id, token_hash, agency_name, power_score, cash, fans, pr, week,
      streamer_count, top_streamer_id, top_streamer_name, destiny, scandal_risk,
      reputation_pts, unlocked_endings, unlocked_talents,
      daily_pvp_used, daily_pvp_date, last_claim_ts, pending_raid_loss,
      ai_gen_count, ai_gen_window_ts, updated_at, created_at
    ) VALUES (?, ?, ?, 118.5, 100.0, 20.0, 80.0, 1, 1, 'su', '苏晚晴', 'none', 0, 0, '[]', '[]', 0, ?, ?, 0, 0, 0, ?, ?)`
  )
    .bind(playerId, tokenHash, agencyName, today, ts, ts, ts)
    .run();

  await ensureSeedBroadcasts(c.env.DB);

  return c.json({
    ok: true,
    playerId,
    authToken,
    agencyName,
    serverTime: ts,
  });
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

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  const agencyName = sanitizeText(body.agencyName, 16, player.agency_name);
  const cash = Math.round(clampNum(body.cash, 0, 500000, player.cash) * 10) / 10;
  const fans = Math.round(clampNum(body.fans, 0, 500000, player.fans) * 10) / 10;
  const pr = Math.round(clampNum(body.pr, 0, 150, player.pr));
  const week = Math.floor(clampNum(body.week, 1, 999, player.week));
  const streamerCount = Math.floor(clampNum(body.streamerCount, 1, 24, player.streamer_count));
  const topStreamerId = sanitizeText(body.topStreamerId, 20, player.top_streamer_id);
  const topStreamerName = sanitizeText(body.topStreamerName, 18, player.top_streamer_name);
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
    c.env.DB.prepare('SELECT COUNT(*) + 1 as rank FROM players WHERE power_score > ?')
      .bind(powerScore)
      .first<{ rank: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as total FROM players').first<{ total: number }>(),
    c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM pvp_logs WHERE defender_id = ? AND status = 'unread'"
    )
      .bind(player.id)
      .first<{ cnt: number }>(),
  ]);

  return c.json({
    ok: true,
    agencyName,
    powerScore,
    globalRank: rankRow?.rank ?? 1,
    totalPlayers: totalRow?.total ?? 1,
    unreadPvpCount: unreadRow?.cnt ?? 0,
    serverTime: ts,
  });
});

// =========================================================================
// 4. 全服真实天梯榜 + 异步商战匹配名单
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
     ORDER BY power_score DESC
     LIMIT 50`
  ).all();

  const totalRow = await c.env.DB.prepare('SELECT COUNT(*) as total FROM players').first<{
    total: number;
  }>();

  let selfRank = null;
  let pvpRemaining = DAILY_PVP_LIMIT;
  const today = getBeijingDateStr();

  if (player) {
    const r = await c.env.DB.prepare(
      'SELECT COUNT(*) + 1 as rank FROM players WHERE power_score > ?'
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
  if (!['ssr_pull', 'ending_goat', 'scandal_boom', 'pvp_revenge'].includes(type)) {
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
// 9. 静态前端资源托管兜底 (当绑定自定义域名时实现同源极速访问)
// =========================================================================
app.all('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ ok: true, service: 'hupu-mcn-worker', hint: 'API endpoints live under /api/*' });
});

export default app;
