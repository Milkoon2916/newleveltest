'use strict';

/**
 * ARAXDNA level test server
 *
 *  - GET  /                          학생용 시험 페이지 (index.html)
 *  - GET  /admin                     관리자 페이지 (같은 index.html, 오디오/이미지만 뺀 경량 버전)
 *  - POST /api/submissions           시험 제출 결과 저장 (학생, 공개)
 *  - POST /api/admin/login|logout    관리자 로그인/로그아웃
 *  - GET  /api/admin/me              로그인 여부 확인
 *  - GET  /api/admin/submissions     결과 목록 (검색/학년 필터/페이지)
 *  - GET  /api/admin/submissions/:id 결과 상세 (리포트 재현용 데이터)
 *
 * 환경변수
 *   DATABASE_URL    Neon 연결 문자열 (필수: 없으면 저장/조회 API만 503)
 *   ADMIN_PASSWORD  관리자 비밀번호 (필수: 없으면 관리자 로그인 비활성)
 *   SESSION_SECRET  세션 서명 키 (선택, 없으면 ADMIN_PASSWORD 사용)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { Pool } = require('pg');

const gzip = promisify(zlib.gzip);

const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

const COOKIE_NAME = 'araxdna_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12시간

// ---------------------------------------------------------------------------
// Database (Neon = 표준 Postgres)
// ---------------------------------------------------------------------------
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000, // Neon 콜드스타트 여유
    })
  : null;

if (pool) {
  // Neon이 유휴 연결을 끊으면 여기로 들어온다. 죽지 않고 로그만 남김.
  pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id     TEXT        NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  student_name  TEXT        NOT NULL,
  grade_id      TEXT        NOT NULL,
  grade_label   TEXT        NOT NULL,
  score         INTEGER     NOT NULL,
  level         TEXT        NOT NULL,
  correct_count INTEGER     NOT NULL,
  total_count   INTEGER     NOT NULL,
  report        JSONB       NOT NULL,
  answers       JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_created_at_idx ON submissions (created_at DESC);
`;

let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = pool.query(SCHEMA_SQL).catch((err) => {
      schemaPromise = null; // 다음 요청에서 재시도
      throw err;
    });
  }
  return schemaPromise;
}

async function db() {
  if (!pool) {
    const e = new Error('DATABASE_URL is not configured');
    e.status = 503;
    throw e;
  }
  await ensureSchema();
  return pool;
}

// ---------------------------------------------------------------------------
// HTML (학생용 / 관리자용) — 시작 시 한 번만 읽고 gzip 해서 메모리에 보관
// ---------------------------------------------------------------------------
const INDEX_PATH = path.join(__dirname, 'index.html');
const pages = {}; // name -> { raw, gz, etag }

/** <script>const NAME = ...</script> 블록을 빈 객체로 교체 (indexOf 기반: 15MB 문자열에서도 빠름) */
function stubScript(html, constName) {
  const open = `<script>const ${constName} = `;
  const start = html.indexOf(open);
  if (start === -1) return html;
  const end = html.indexOf('</script>', start);
  if (end === -1) return html;
  return html.slice(0, start) + `<script>const ${constName} = {};</script>` + html.slice(end + '</script>'.length);
}

async function buildPage(html) {
  const raw = Buffer.from(html, 'utf8');
  const gz = await gzip(raw, { level: 9 });
  const etag = '"' + crypto.createHash('sha1').update(raw).digest('hex') + '"';
  return { raw, gz, etag };
}

async function loadPages() {
  const student = fs.readFileSync(INDEX_PATH, 'utf8');
  // 관리자 화면은 리포트 "재현"만 하므로 오디오(약 15MB)·문항 이미지는 필요 없다.
  const admin = stubScript(stubScript(student, 'AUDIO_TRACKS'), 'IMAGES');
  pages.student = await buildPage(student);
  pages.admin = await buildPage(admin);
  console.log(
    `[pages] student ${(pages.student.raw.length / 1e6).toFixed(1)}MB (gz ${(pages.student.gz.length / 1e6).toFixed(1)}MB), ` +
      `admin ${(pages.admin.raw.length / 1e6).toFixed(2)}MB (gz ${(pages.admin.gz.length / 1e6).toFixed(2)}MB)`
  );
}

function sendPage(name) {
  return (req, res) => {
    const page = pages[name];
    if (!page) return res.status(503).type('text').send('Starting up, please retry.');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache'); // 항상 ETag로 재검증 (예전 정적 사이트 설정과 동일한 의도)
    res.set('Vary', 'Accept-Encoding');
    res.set('ETag', page.etag);
    if (name === 'admin') res.set('X-Robots-Tag', 'noindex, nofollow');
    if (req.fresh) return res.status(304).end();
    if (req.acceptsEncodings('gzip')) {
      res.set('Content-Encoding', 'gzip');
      return res.send(page.gz);
    }
    return res.send(page.raw);
  };
}

// ---------------------------------------------------------------------------
// Admin auth (HMAC 서명 쿠키, HttpOnly + SameSite=Strict)
// ---------------------------------------------------------------------------
function hmac(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}
function makeToken() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return exp + '.' + hmac(exp);
}
function verifyToken(token) {
  if (!token || !SESSION_SECRET) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(exp));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return false;
  return Number(exp) > Date.now();
}
function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i < 1) return;
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch (_) {
        /* 깨진 쿠키는 무시 */
      }
    });
  return out;
}
function setSessionCookie(res, token, maxAgeMs) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (IS_PROD) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function requireAdmin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'admin_disabled' });
  if (!verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME])) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// 아주 단순한 메모리 rate limiter
// ---------------------------------------------------------------------------
function makeLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, 60_000).unref();
  return {
    /** 횟수를 1 올리고, 한도를 넘었으면 true */
    hit(key) {
      const now = Date.now();
      let e = hits.get(key);
      if (!e || e.resetAt <= now) {
        e = { count: 0, resetAt: now + windowMs };
        hits.set(key, e);
      }
      e.count += 1;
      return e.count > max;
    },
    isLimited(key) {
      const e = hits.get(key);
      return !!e && e.resetAt > Date.now() && e.count >= max;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
const loginFailLimiter = makeLimiter({ windowMs: 15 * 60_000, max: 8 });
// 학원 전산실처럼 같은 공인 IP에서 많은 학생이 제출할 수 있으니 넉넉하게.
const submitLimiter = makeLimiter({ windowMs: 60 * 60_000, max: 600 });

// ---------------------------------------------------------------------------
// 제출 데이터 검증
// ---------------------------------------------------------------------------
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateSubmission(b) {
  if (!isPlainObject(b)) return 'invalid body';
  const { clientId, report, answers } = b;
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(clientId)) return 'invalid clientId';
  if (!isPlainObject(answers)) return 'invalid answers';
  if (!isPlainObject(report)) return 'invalid report';

  if (!isStr(report.studentName, 1, 100)) return 'invalid studentName';
  if (!isStr(report.gradeId, 1, 50)) return 'invalid gradeId';
  if (!isStr(report.gradeLabel, 1, 100)) return 'invalid gradeLabel';
  if (!isInt(report.score, 0, 100)) return 'invalid score';
  if (!isInt(report.totalCorrect, 0, 10000)) return 'invalid totalCorrect';
  if (!isInt(report.totalCount, 1, 10000)) return 'invalid totalCount';
  if (!isPlainObject(report.band) || !isStr(report.band.label, 1, 60) || !/^#[0-9a-fA-F]{3,8}$/.test(report.band.color || '')) {
    return 'invalid band';
  }
  if (!Array.isArray(report.cats) || report.cats.length > 30) return 'invalid cats';
  if (!Array.isArray(report.items) || report.items.length < 1 || report.items.length > 500) return 'invalid items';
  return null;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render 프록시 뒤: req.ip / secure 판단

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get(['/', '/index.html'], sendPage('student'));
app.get(['/admin', '/admin/'], sendPage('admin'));

app.use('/api', express.json({ limit: '512kb' }));

// Neon 일시 중단/콜드스타트 타임아웃/연결 끊김 등 "DB에 못 닿는" 오류 → 503 (클라이언트가 재시도 가능)
const DB_DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08006']);
const isDbUnavailable = (err) =>
  DB_DOWN_CODES.has(err.code) || /timeout|terminated|ECONN/i.test(err.message || '');

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err.status || (isDbUnavailable(err) ? 503 : 500);
    if (status >= 500) console.error('[api]', req.method, req.path, err.message);
    if (!res.headersSent) res.status(status).json({ error: status === 503 ? 'db_unavailable' : 'server_error' });
  });

// ---- 학생: 결과 저장 ------------------------------------------------------
app.post(
  '/api/submissions',
  wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (submitLimiter.hit(req.ip)) return res.status(429).json({ error: 'too_many_requests' });

    const problem = validateSubmission(req.body);
    if (problem) return res.status(400).json({ error: 'bad_request', detail: problem });

    const { clientId, report, answers } = req.body;
    const client = await db();
    const { rows } = await client.query(
      `INSERT INTO submissions
         (client_id, student_name, grade_id, grade_label, score, level, correct_count, total_count, report, answers)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
       ON CONFLICT (client_id) DO NOTHING
       RETURNING id`,
      [
        clientId,
        report.studentName.trim(),
        report.gradeId,
        report.gradeLabel,
        report.score,
        report.band.label,
        report.totalCorrect,
        report.totalCount,
        JSON.stringify(report),
        JSON.stringify(answers),
      ]
    );
    // 같은 clientId로 재전송되면(재시도 등) 중복 저장하지 않고 성공으로 응답
    res.json({ ok: true, duplicate: rows.length === 0 });
  })
);

// ---- 관리자 ---------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'admin_disabled' });
  if (loginFailLimiter.isLimited(req.ip)) return res.status(429).json({ error: 'too_many_attempts' });

  const pw = req.body && req.body.password;
  if (typeof pw !== 'string' || !passwordMatches(pw)) {
    loginFailLimiter.hit(req.ip);
    return res.status(401).json({ error: 'wrong_password' });
  }
  loginFailLimiter.reset(req.ip);
  setSessionCookie(res, makeToken(), SESSION_TTL_MS);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

app.get(
  '/api/admin/submissions',
  requireAdmin,
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const grade = String(req.query.grade || '').trim().slice(0, 50);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const like = q.replace(/[\\%_]/g, '\\$&');

    const where = `($1::text = '' OR student_name ILIKE '%' || $1 || '%') AND ($2::text = '' OR grade_id = $2)`;
    const client = await db();
    const [list, count] = await Promise.all([
      client.query(
        `SELECT id, created_at, student_name, grade_id, grade_label, score, level, correct_count, total_count
           FROM submissions WHERE ${where}
          ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
        [like, grade, limit, offset]
      ),
      client.query(`SELECT count(*)::int AS n FROM submissions WHERE ${where}`, [like, grade]),
    ]);
    res.json({ total: count.rows[0].n, items: list.rows });
  })
);

app.get(
  '/api/admin/submissions/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad_request' });
    const client = await db();
    const { rows } = await client.query(
      'SELECT id, created_at, report, answers FROM submissions WHERE id = $1',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
// 그 외 경로는 (render.yaml, server.js 등이 노출되지 않도록) 전부 404
app.use((req, res) => res.status(404).type('text').send('Not found'));

// JSON 파싱 오류 등
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[server]', err.message);
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: status === 413 ? 'payload_too_large' : 'bad_request' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  if (!DATABASE_URL) console.warn('[warn] DATABASE_URL 이 설정되지 않았습니다. 시험은 가능하지만 결과 저장/조회는 동작하지 않습니다.');
  if (!ADMIN_PASSWORD) console.warn('[warn] ADMIN_PASSWORD 가 설정되지 않았습니다. 관리자 로그인이 비활성화됩니다.');

  await loadPages();
  const server = app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));

  if (pool) {
    // 미리 테이블 생성 시도 (실패해도 서버는 유지, 첫 요청 때 재시도)
    ensureSchema().then(
      () => console.log('[db] schema ready'),
      (err) => console.error('[db] schema init failed (will retry on demand):', err.message)
    );
  }

  const shutdown = () => {
    server.close(() => {
      (pool ? pool.end() : Promise.resolve()).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[fatal]', err);
    process.exit(1);
  });
}

module.exports = { app, loadPages, validateSubmission };
