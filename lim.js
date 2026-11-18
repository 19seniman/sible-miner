#!/usr/bin/env node
/**
 * lim.js — CLI + auto-miner untuk mine.sible.network
 *
 * Zero dependencies. Node >= 18 (global fetch).
 *
 * Kredensial & token disimpan di file .env (default: ./.env, chmod 600):
 *
 *   SIBLE_IDENTIFIER=you@mail.com     # email atau username
 *   SIBLE_PASSWORD=secret
 *   SIBLE_TOKEN=eyJ...                # bearer access token
 *   SIBLE_REFRESH_TOKEN=...           # diisi otomatis
 *   SIBLE_API_BASE=https://prod.sible.network/api/v1
 *   SIBLE_SLOT_HOURS=3                # panjang slot (fallback kalau server tidak kirim)
 *   SIBLE_AUTO_ADS=1                  # 1 = auto accelerate (watch ad)
 *
 * Login bisa lewat salah satu: bearer token, atau identifier+password.
 * `login` menulis ke .env. Token hasil refresh juga ditulis balik ke .env.
 *
 * Command:
 *   login        simpan kredensial/token ke .env
 *   logout       hapus token dari .env (kredensial tetap)
 *   env          tampilkan .env (password/token disamarkan)
 *   me | status | start | claim | ad
 *   tasks | claim-task <id> [--day-key YYYY-MM-DD]
 *   referral | apply-ref <CODE>
 *   auto         auto-mining tiap slot (default 3 jam) + auto accelerate
 *   get <path> | post <path> '<json>'
 *
 * Contoh:
 *   node lim.js login --identifier you@mail.com --password 'secret'
 *   node lim.js login --token 'eyJhbGciOi...'
 *   node lim.js auto
 *   node lim.js auto --slot-hours 3 --max-ads 5
 *   node lim.js auto --once --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Config / .env
// ---------------------------------------------------------------------------

const ENV_FILE = process.env.SIBLE_ENV_FILE ?? path.join(process.cwd(), '.env');
const DEFAULT_API_BASE = 'https://prod.sible.network/api/v1';
const CLIENT_TYPE = 'web'; // web build sends X-Client-Type: web

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m, code = 1) => {
  console.error(C.r(`✖ ${m}`));
  process.exit(code);
};
const log = (m) => console.log(`${C.dim(new Date().toLocaleTimeString())} ${m}`);

/** Parse a .env file into an ordered key/value map (keeps unknown lines). */
function readEnvFile(file = ENV_FILE) {
  const out = { __lines: [], __order: [] };
  if (!fs.existsSync(file)) return out;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      out.__lines.push({ type: 'raw', text: line });
      continue;
    }
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    v = v.replace(/\\n/g, '\n');
    if (!out.__order.includes(m[1])) out.__order.push(m[1]);
    out[m[1]] = v;
    out.__lines.push({ type: 'kv', key: m[1] });
  }
  return out;
}

/** Create or update keys in .env, preserving comments and unrelated keys. */
function writeEnvFile(patch, file = ENV_FILE) {
  const env = readEnvFile(file);
  const seen = new Set();
  const lines = [];

  const render = (k, v) => {
    const needsQuote = /[\s#'"`$]/.test(v) || v === '';
    return `${k}=${needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v}`;
  };

  for (const item of env.__lines) {
    if (item.type === 'raw') {
      // drop trailing blank lines, re-added at the end
      lines.push({ raw: item.text });
      continue;
    }
    const k = item.key;
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      seen.add(k);
      const v = patch[k];
      if (v === null || v === undefined || v === '') continue; // delete key
      lines.push({ raw: render(k, String(v)) });
    } else if (env[k] !== undefined) {
      lines.push({ raw: render(k, env[k]) });
    }
  }

  const missing = Object.keys(patch).filter((k) => !seen.has(k) && patch[k] !== null && patch[k] !== undefined && patch[k] !== '');
  if (missing.length && lines.length && String(lines[lines.length - 1].raw).trim() !== '') lines.push({ raw: '' });
  for (const k of missing) lines.push({ raw: render(k, String(patch[k])) });

  const body = lines
    .map((l) => l.raw)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  fs.writeFileSync(file, body + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return { file, written: Object.keys(patch) };
}

const ENV_TEMPLATE = `# sible-miner — isi salah satu cara login di bawah, lalu simpan.
#
# Cara 1: email/username + password
SIBLE_IDENTIFIER=
SIBLE_PASSWORD=
#
# Cara 2: bearer token (biarkan kosong kalau pakai cara 1)
SIBLE_TOKEN=
SIBLE_REFRESH_TOKEN=
#
# Opsional
SIBLE_API_BASE=https://prod.sible.network/api/v1
SIBLE_SLOT_HOURS=3
SIBLE_AUTO_ADS=1
`;

/** Bikin .env kalau belum ada, supaya `nano .env` langsung berisi template. */
function ensureEnvFile({ quiet = false } = {}) {
  // .env kosong (mis. hasil "simpan" buffer kosong di nano) tetap diisi template,
  // tapi file yang sudah ada isinya tidak pernah ditimpa.
  const exists = fs.existsSync(ENV_FILE);
  let existing = '';
  if (exists) {
    try {
      existing = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
      existing = '';
    }
    if (existing.trim() !== '') return false;
  }
  const verb = exists ? 'diisi template (file kosong)' : 'dibuat dengan template';
  try {
    fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
    fs.writeFileSync(ENV_FILE, ENV_TEMPLATE, { mode: 0o600 });
    try {
      fs.chmodSync(ENV_FILE, 0o600);
    } catch {}
    if (!quiet) {
      console.log(C.dim(`i ${path.basename(ENV_FILE)} ${verb} — edit pakai: nano ${path.basename(ENV_FILE)}`));
    }
    return true;
  } catch (e) {
    if (!quiet) console.error(C.y(`! gagal membuat ${ENV_FILE}: ${e.message}`));
    return false;
  }
}

function envHasCreds() {
  return Boolean(ENV.SIBLE_IDENTIFIER || ENV.SIBLE_TOKEN);
}

let ENV = readEnvFile();

function envGet(key, fallback = null) {
  const fromFile = ENV[key];
  if (fromFile !== undefined && fromFile !== '') return fromFile;
  const fromProc = process.env[key];
  if (fromProc !== undefined && fromProc !== '') return fromProc;
  return fallback;
}

let API_BASE = envGet('SIBLE_API_BASE', DEFAULT_API_BASE);

function setTokens({ accessToken, refreshToken }) {
  const patch = {};
  if (accessToken !== undefined) patch.SIBLE_TOKEN = accessToken ?? '';
  if (refreshToken !== undefined) patch.SIBLE_REFRESH_TOKEN = refreshToken ?? '';
  writeEnvFile(patch);
  ENV = readEnvFile();
  session.accessToken = accessToken !== undefined ? accessToken : session.accessToken;
  session.refreshToken = refreshToken !== undefined ? refreshToken : session.refreshToken;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function ts(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function fmtNum(n, dec = 3) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function hms(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const neg = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const out = `${h > 0 ? h + 'h ' : ''}${m}m ${s}s`;
  return neg ? `-${out}` : out;
}

function fmtHours(h) {
  const v = Number(h);
  if (!Number.isFinite(v) || v <= 0) return '3 jam';
  if (v >= 1) return `${Number(v.toFixed(2))} jam`;
  return `${Math.round(v * 60)} menit`;
}

function mask(v, keep = 4) {
  if (!v) return '—';
  const s = String(v);
  if (s.length <= keep * 2) return '*'.repeat(s.length);
  return `${s.slice(0, keep)}${'*'.repeat(Math.min(16, s.length - keep * 2))}${s.slice(-keep)}`;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { cmd: positional[0], args: positional.slice(1), flags };
}

async function ask(prompt, { mask: masked = false } = {}) {
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const c of stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0].trim();
  }
  if (!masked) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
  }
  stdout.write(prompt);
  return await new Promise((resolve) => {
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (c === '\u0003') {
          stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += c;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor({ code, message, http, path: p, details }) {
    super(`${code ?? 'ERROR'}${http ? ` (HTTP ${http})` : ''}: ${message}`);
    this.code = code;
    this.http = http;
    this.path = p;
    this.details = details;
  }
}

const session = {
  accessToken: envGet('SIBLE_TOKEN'),
  refreshToken: envGet('SIBLE_REFRESH_TOKEN'),
};
let refreshing = null;

// --- pengaman: batas laju, jitter, backoff, kuota harian, kunci proses ------

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

const GUARD = {
  minGapMs: num(envGet('SIBLE_MIN_GAP_MS', '4000'), 4000), // jarak minimal antar request tulis
  jitterPct: num(envGet('SIBLE_JITTER_PCT', '25'), 25), // acak ±25% supaya tidak berpola
  maxRetries: num(envGet('SIBLE_MAX_RETRIES', '4'), 4),
  backoffBaseMs: num(envGet('SIBLE_BACKOFF_MS', '5000'), 5000),
  requestTimeoutMs: num(envGet('SIBLE_TIMEOUT_MS', '20000'), 20000),
  dailyAdCap: num(envGet('SIBLE_DAILY_AD_CAP', '30'), 30),
  dailyClaimCap: num(envGet('SIBLE_DAILY_CLAIM_CAP', '10'), 10),
  dailyStartCap: num(envGet('SIBLE_DAILY_START_CAP', '10'), 10),
};

const STATE_FILE = envGet('SIBLE_STATE_FILE', path.join(path.dirname(ENV_FILE), '.sible-state.json'));
const LOCK_FILE = envGet('SIBLE_LOCK_FILE', path.join(path.dirname(ENV_FILE), '.sible.lock'));

const rand = (a, b) => a + Math.random() * (b - a);
const withJitter = (ms) => {
  const j = (GUARD.jitterPct / 100) * ms;
  return Math.round(Math.max(400, ms + rand(-j, j)));
};

const todayKey = () => new Date().toISOString().slice(0, 10);

function readState() {
  const fresh = { date: todayKey(), ads: 0, claims: 0, starts: 0 };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.date !== todayKey()) return fresh;
    return { ...fresh, ...s };
  } catch {
    return fresh;
  }
}

function bumpState(key, n = 1) {
  const s = readState();
  s.date = todayKey();
  s[key] = Number(s[key] ?? 0) + n;
  s.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch {}
  return s;
}

function checkDailyCap(key, cap) {
  const s = readState();
  const used = Number(s[key] ?? 0);
  if (Number.isFinite(cap) && cap > 0 && used >= cap) {
    throw new ApiError({ code: 'LOCAL_DAILY_CAP', message: `kuota ${key} harian habis (${used}/${cap}) — script berhenti sendiri demi keamanan akun` });
  }
  return used;
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // masih hidup?
          throw new ApiError({ code: 'ALREADY_RUNNING', message: `proses lain masih jalan (pid ${pid}). Hentikan dulu: kill ${pid}` });
        } catch (e) {
          if (e instanceof ApiError) throw e;
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
    const release = () => {
      try {
        if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE);
      } catch {}
    };
    process.on('exit', release);
    process.on('SIGINT', () => {
      release();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      release();
      process.exit(143);
    });
    return true;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return false;
  }
}

// Header disamakan dengan klien web resmi (bukan penyamaran identitas: nilai
// default-nya memang yang dipakai app, dan bisa ditimpa lewat .env).
const BROWSER_HEADERS = {
  'User-Agent': envGet(
    'SIBLE_USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  ),
  'Accept-Language': envGet('SIBLE_ACCEPT_LANGUAGE', 'en-US,en;q=0.9'),
  Origin: 'https://mine.sible.network',
  Referer: 'https://mine.sible.network/',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

function authHeaders() {
  const h = { ...BROWSER_HEADERS, 'X-Client-Type': CLIENT_TYPE, Accept: 'application/json' };
  if (session.accessToken) h.Authorization = `Bearer ${session.accessToken}`;
  return h;
}

// jarak minimal antar request tulis, dengan jitter
let lastWriteAt = 0;
async function paceWrite(p) {
  const since = Date.now() - lastWriteAt;
  const gap = withJitter(GUARD.minGapMs);
  if (since < gap) {
    const wait = gap - since;
    log(C.dim(`  jeda ${Math.round(wait / 1000)}s sebelum ${p}`));
    await sleep(wait);
  }
  lastWriteAt = Date.now();
}

async function rawRequest(method, p, { body, auth = true, timeoutMs = GUARD.requestTimeoutMs } = {}) {
  const url = p.startsWith('http') ? p : `${API_BASE}${p.startsWith('/') ? p : '/' + p}`;
  const isWrite = method !== 'GET';
  const isAuthPath = p.startsWith('/auth/');

  if (isWrite && !isAuthPath) await paceWrite(p);

  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(auth ? authHeaders() : { ...BROWSER_HEADERS, 'X-Client-Type': CLIENT_TYPE, Accept: 'application/json' }),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = new ApiError({
        code: 'NETWORK',
        message: ac.signal.aborted ? 'request timed out' : String(e?.message ?? e),
        path: p,
      });
      if (attempt < GUARD.maxRetries) {
        const wait = withJitter(GUARD.backoffBaseMs * 2 ** attempt);
        log(C.y(`  network error — retry ${attempt + 1}/${GUARD.maxRetries} dalam ${Math.round(wait / 1000)}s`));
        await sleep(wait);
        continue;
      }
      throw err;
    }
    clearTimeout(timer);

    // 429 / 5xx: mundur sopan, hormati Retry-After
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      const base = Number.isFinite(ra) && ra > 0 ? ra * 1000 : GUARD.backoffBaseMs * 2 ** attempt;
      if (attempt < GUARD.maxRetries) {
        const wait = withJitter(Math.min(base, 15 * 60 * 1000));
        log(C.y(`  HTTP ${res.status} — cooldown ${Math.round(wait / 1000)}s (retry ${attempt + 1}/${GUARD.maxRetries})`));
        await sleep(wait);
        continue;
      }
      throw new ApiError({ code: 'RATE_LIMITED', message: `HTTP ${res.status} setelah ${attempt + 1} percobaan`, http: res.status, path: p });
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError({ code: 'BAD_RESPONSE', message: `non-JSON response (${text.slice(0, 120)})`, http: res.status, path: p });
    }
    if (json && json.success === false) {
      const err = json.error ?? {};
      if (isDebug()) {
        console.log(C.dim(`  [debug] ${method} ${p} → HTTP ${res.status} ${err.code ?? ''}`));
        console.log(C.dim(`  [debug] ${JSON.stringify(maskDeep(json))}`));
      }
      throw new ApiError({ code: err.code, message: err.message, http: res.status, path: p, details: err.details });
    }
    if (isDebug()) {
      console.log(C.dim(`  [debug] ${method} ${p} → HTTP ${res.status}`));
      console.log(C.dim(`  [debug] ${JSON.stringify(maskDeep(json))}`));
    }
    return { data: json?.data ?? null, meta: json?.meta ?? null, raw: json, status: res.status };
  }
}

async function doRefresh() {
  if (!session.refreshToken) return false;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const r = await rawRequest('POST', '/auth/refresh', { body: { refreshToken: session.refreshToken }, auth: false });
      const d = r.data ?? {};
      if (!d.accessToken) return false;
      setTokens({ accessToken: d.accessToken, refreshToken: d.refreshToken ?? session.refreshToken });
      log(C.dim('token diperbarui → .env'));
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

const SESSION_DEAD = new Set(['TOKEN_INVALID', 'SESSION_CHANGED', 'ACCOUNT_BANNED']);

async function request(method, p, opts = {}) {
  try {
    return await rawRequest(method, p, opts);
  } catch (e) {
    const retryable = e instanceof ApiError && (e.http === 401 || SESSION_DEAD.has(e.code));
    if (retryable && opts.auth !== false) {
      if (await doRefresh()) return rawRequest(method, p, opts);
      throw new ApiError({ code: 'SESSION_EXPIRED', message: 'token ditolak & refresh gagal — jalankan: node lim.js login', path: p });
    }
    throw e;
  }
}

const api = {
  get: (p, o) => request('GET', p, o),
  post: (p, body, o) => request('POST', p, { body: body ?? {}, ...o }),
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Cari token di respons, apa pun bentuk sarangnya: {accessToken} / {tokens:{...}} / {session:{...}}. */
function extractAuth(payload) {
  const root = payload ?? {};
  const seen = new Set();
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || seen.has(o) || depth > 3) return null;
    seen.add(o);
    const at = o.accessToken ?? o.access_token ?? o.accessTokenJwt ?? o.jwt ?? o.token;
    if (typeof at === 'string' && at.length > 10) {
      return {
        accessToken: at,
        refreshToken: o.refreshToken ?? o.refresh_token ?? null,
        user: o.user ?? root.user ?? null,
      };
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') {
        const hit = walk(v, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root);
}

function adoptAuth(payload) {
  const d = payload ?? {};
  const t = extractAuth(d);
  if (!t) {
    const keys = d && typeof d === 'object' ? Object.keys(d) : [];
    throw new ApiError({
      code: 'NO_TOKEN',
      message: `respons tanpa token (field: ${keys.length ? keys.join(', ') : 'kosong'}) — jalankan: node lim.js login --debug`,
      details: d,
    });
  }
  setTokens({ accessToken: t.accessToken, refreshToken: t.refreshToken ?? session.refreshToken ?? '' });
  return t.user ?? null;
}

/** Sembunyikan nilai sensitif sebelum dicetak. */
function maskDeep(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    if (v.length <= 12) return v;
    return `${v.slice(0, 8)}…(${v.length} char)`;
  }
  if (typeof v !== 'object' || depth > 4) return v;
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => maskDeep(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const sensitive = /token|pass|secret|key|auth|cookie/i.test(k);
    out[k] = sensitive && typeof val === 'string' ? mask(val, 6) : maskDeep(val, depth + 1);
  }
  return out;
}

const isDebug = () => process.env.SIBLE_DEBUG === '1' || ENV.SIBLE_DEBUG === '1';

/** Login pakai identifier+password dari .env (dipakai juga oleh auto). */
async function loginWithPassword({ silent = false } = {}) {
  const identifier = envGet('SIBLE_IDENTIFIER');
  const password = envGet('SIBLE_PASSWORD');
  if (!identifier || !password) return false;
  try {
    const res = await rawRequest('POST', '/auth/login', { body: { identifier, password }, auth: false });
    adoptAuth(res.data);
    if (!silent) log(C.g(`login OK (${identifier}) → token disimpan di .env`));
    return true;
  } catch (e) {
    if (!silent) console.error(C.y(`  login .env gagal: ${e.message}`));
    return false;
  }
}

/** Pastikan punya token valid; kalau tidak, coba refresh lalu login dari .env. */
async function ensureAuth({ silent = false } = {}) {
  if (session.accessToken) {
    try {
      await api.get('/users/me');
      return true;
    } catch (e) {
      if (e.code !== 'SESSION_EXPIRED') throw e;
    }
  }
  if (await loginWithPassword({ silent })) return true;
  return false;
}

function printUser(u) {
  if (!u) return;
  const rows = [
    ['id', u.id],
    ['email', u.email],
    ['username', u.username],
    ['referralCode', u.referralCode],
    ['balance', u.balance],
    ['createdAt', u.createdAt],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  console.log(C.b('— akun —'));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(13)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
}

async function cmdLogin(flags) {
  if (flags.debug === true) process.env.SIBLE_DEBUG = '1';
  // 1) bearer token
  let token = typeof flags.token === 'string' ? flags.token : envGet('SIBLE_TOKEN');
  if (typeof flags.token === 'string' && flags.token) {
    token = flags.token.replace(/^Bearer\s+/i, '').trim();
    const patch = { SIBLE_TOKEN: token };
    if (typeof flags['refresh-token'] === 'string') patch.SIBLE_REFRESH_TOKEN = flags['refresh-token'];
    if (typeof flags['api-base'] === 'string') patch.SIBLE_API_BASE = flags['api-base'];
    writeEnvFile(patch);
    ENV = readEnvFile();
    API_BASE = envGet('SIBLE_API_BASE', DEFAULT_API_BASE);
    session.accessToken = token;
    if (patch.SIBLE_REFRESH_TOKEN) session.refreshToken = patch.SIBLE_REFRESH_TOKEN;
    console.log(C.g(`✔ bearer token disimpan di ${ENV_FILE}`));
    const me = await api.get('/users/me').catch((e) => {
      console.log(C.y(`  token tersimpan, tapi /users/me gagal: ${e.message}`));
      return null;
    });
    if (me) printUser(me.data);
    return;
  }

  // 2) identifier + password
  const identifier = typeof flags.identifier === 'string' ? flags.identifier : typeof flags.email === 'string' ? flags.email : envGet('SIBLE_IDENTIFIER');
  let password = typeof flags.password === 'string' ? flags.password : envGet('SIBLE_PASSWORD');
  if (!identifier) die('pakai --token <bearer>  atau  --identifier <email/username> [--password]');
  if (!password) {
    password = await ask(stdin.isTTY ? 'Password: ' : '', { mask: stdin.isTTY });
    if (!password) die('password kosong: pakai --password, pipe stdin, atau taruh SIBLE_PASSWORD di .env');
  }

  const loginPatch = { SIBLE_IDENTIFIER: identifier, SIBLE_PASSWORD: password };
  if (typeof flags['api-base'] === 'string') loginPatch.SIBLE_API_BASE = flags['api-base'];
  writeEnvFile(loginPatch);
  ENV = readEnvFile();
  API_BASE = envGet('SIBLE_API_BASE', DEFAULT_API_BASE);
  console.log(C.dim(`→ kredensial disimpan di ${ENV_FILE} (chmod 600)`));

  let res;
  try {
    res = await rawRequest('POST', '/auth/login', { body: { identifier, password }, auth: false });
  } catch (e) {
    if (e.code === 'INVALID_CREDENTIALS') die('identifier/password salah (INVALID_CREDENTIALS)');
    if (e.code === 'ACCOUNT_LOCKED' || e.code === 'ACCOUNT_BANNED') die(e.message);
    const otp = typeof flags.otp === 'string' ? flags.otp : null;
    if (!otp) {
      console.log(C.y(`login butuh langkah tambahan: ${e.code ?? '?'} — ${e.message}`));
      console.log(C.dim('kalau akun belum verifikasi e-mail: ulangi dengan --otp <kode>'));
      process.exit(2);
    }
    await rawRequest('POST', '/auth/verify-otp', { body: { email: identifier, code: otp, purpose: 'verify_email' }, auth: false });
    res = await rawRequest('POST', '/auth/login', { body: { identifier, password }, auth: false });
  }

  // login bisa balas 200 tapi minta verifikasi dulu (tanpa token)
  const otpLike = (d) => d && (d.otpSent === true || d.purpose === 'verify_email' || d.verificationRequired === true || d.otpRequired === true);
  let otp = typeof flags.otp === 'string' ? flags.otp : null;
  if (otpLike(res.data) && !otp && stdin.isTTY) {
    console.log(C.y('akun minta verifikasi e-mail — kode OTP dikirim ke emailmu.'));
    otp = await ask('Kode OTP (6 digit, Enter untuk lewati): ');
  }
  if (otpLike(res.data) && otp) {
    console.log(C.dim('→ POST /auth/verify-otp'));
    await rawRequest('POST', '/auth/verify-otp', { body: { email: identifier, code: otp, purpose: 'verify_email' }, auth: false });
    console.log(C.dim('→ POST /auth/login (ulang setelah verifikasi)'));
    res = await rawRequest('POST', '/auth/login', { body: { identifier, password }, auth: false });
  }

  let user = null;
  try {
    user = adoptAuth(res.data);
  } catch (e) {
    if (e.code !== 'NO_TOKEN') throw e;
    console.log(C.r(`✖ ${e.message}`));
    if (otpLike(res.data)) {
      console.log(C.y('  server minta verifikasi e-mail sebelum memberi token.'));
      console.log(C.dim('  kirim kodenya: node lim.js login --otp 123456'));
    }
    console.log(C.dim('  isi respons server (disamarkan):'));
    console.log(C.dim('  ' + JSON.stringify(maskDeep(res.raw), null, 2).split('\n').join('\n  ')));
    process.exit(2);
  }
  console.log(C.g(`✔ login OK — token ditulis ke ${ENV_FILE}`));
  if (user) printUser(user);
}

async function cmdLogout() {
  try {
    if (session.refreshToken) await rawRequest('POST', '/auth/logout', { body: { refreshToken: session.refreshToken } });
  } catch {
    /* ignore */
  }
  writeEnvFile({ SIBLE_TOKEN: '', SIBLE_REFRESH_TOKEN: '' });
  ENV = readEnvFile();
  session.accessToken = null;
  session.refreshToken = null;
  console.log(C.g('✔ token dihapus dari .env (kredensial tetap)'));
}

function cmdEnv() {
  const keys = ['SIBLE_IDENTIFIER', 'SIBLE_PASSWORD', 'SIBLE_TOKEN', 'SIBLE_REFRESH_TOKEN', 'SIBLE_API_BASE', 'SIBLE_SLOT_HOURS', 'SIBLE_AUTO_ADS'];
  console.log(C.b(`— ${ENV_FILE} —`));
  if (!fs.existsSync(ENV_FILE)) return console.log(C.y('  (belum ada) — jalankan: node lim.js'));
  if (!envHasCreds()) {
    const size = fs.statSync(ENV_FILE).size;
    console.log(C.y(`  (belum ada kredensial terisi — ukuran ${size} byte)`));
    console.log(C.dim('  isi pakai: node lim.js setup   |   atau: node lim.js edit'));
    return;
  }
  for (const k of keys) {
    const v = ENV[k];
    if (v === undefined) continue;
    const shown = /PASSWORD|TOKEN/.test(k) ? mask(v, k === 'SIBLE_PASSWORD' ? 1 : 6) : v;
    console.log(`  ${k.padEnd(20)} ${shown}`);
  }
  const extra = Object.keys(ENV).filter((k) => !k.startsWith('__') && !keys.includes(k));
  if (extra.length) console.log(C.dim(`  lain: ${extra.join(', ')}`));
  try {
    const st = fs.statSync(ENV_FILE);
    console.log(C.dim(`  mode ${(st.mode & 0o777).toString(8)}  size ${st.size}B`));
  } catch {}
}

// ---------------------------------------------------------------------------
// Setup / edit .env (tanpa harus paham nano)
// ---------------------------------------------------------------------------

async function cmdSetup(flags) {
  ensureEnvFile({ quiet: true });

  const force = flags.force === true;
  if (fs.existsSync(ENV_FILE) && envHasCreds() && !force) {
    console.log(C.y(`${ENV_FILE} sudah berisi kredensial.`));
    console.log(C.dim('  timpa dengan: node lim.js setup --force'));
    console.log(C.dim('  atau edit manual: node lim.js edit'));
    return;
  }

  let identifier = typeof flags.identifier === 'string' ? flags.identifier : typeof flags.email === 'string' ? flags.email : null;
  let password = typeof flags.password === 'string' ? flags.password : null;
  let token = typeof flags.token === 'string' ? flags.token : null;
  const apiBase = typeof flags['api-base'] === 'string' ? flags['api-base'] : null;

  const interactive = !identifier && !token && stdin.isTTY;
  if (interactive) {
    console.log(C.b('Setup sible-miner'));
    console.log('  1) email/username + password');
    console.log('  2) bearer token');
    const mode = (await ask('Pilih 1 atau 2 [1]: ')) || '1';
    if (mode.trim() === '2') {
      token = await ask('Bearer token: ', { mask: true });
    } else {
      identifier = await ask('Email atau username: ');
      password = await ask('Password: ', { mask: true });
    }
  }

  if (!identifier && !token) {
    console.log(C.y('Tidak ada input. Pakai flag, contoh:'));
    console.log(C.dim("  node lim.js setup --identifier you@mail.com --password 'secret'"));
    console.log(C.dim("  node lim.js setup --token 'eyJhbGciOi...'"));
    process.exit(2);
  }

  const patch = {};
  if (token) {
    patch.SIBLE_TOKEN = String(token).replace(/^Bearer\s+/i, '').trim();
    patch.SIBLE_REFRESH_TOKEN = '';
    patch.SIBLE_IDENTIFIER = '';
    patch.SIBLE_PASSWORD = '';
  } else {
    patch.SIBLE_IDENTIFIER = identifier;
    patch.SIBLE_PASSWORD = password ?? '';
    patch.SIBLE_TOKEN = '';
    patch.SIBLE_REFRESH_TOKEN = '';
  }
  if (apiBase) patch.SIBLE_API_BASE = apiBase.replace(/\/+$/, '');

  // uji dulu, baru simpan — supaya .env yang sudah jalan tidak tertimpa typo
  if (apiBase) API_BASE = apiBase.replace(/\/+$/, '');
  const probe = token
    ? await (async () => {
        const prev = session.accessToken;
        session.accessToken = String(token).replace(/^Bearer\s+/i, '').trim();
        try {
          await api.get('/users/me');
          return true;
        } catch {
          session.accessToken = prev;
          return false;
        }
      })()
    : await rawRequest('POST', '/auth/login', { body: { identifier, password }, auth: false })
        .then(() => true)
        .catch((e) => {
          console.log(C.y(`  ${e.message}`));
          return false;
        });

  if (!probe && !force) {
    console.log(C.y('! tidak disimpan — kredensial belum valid. Ulangi setup atau edit manual.'));
    console.log(C.dim('  paksa simpan (mis. untuk dibetulkan nanti): tambahkan --force'));
    process.exit(2);
  }

  writeEnvFile(patch);
  ENV = readEnvFile();
  API_BASE = envGet('SIBLE_API_BASE', DEFAULT_API_BASE);
  session.accessToken = envGet('SIBLE_TOKEN');
  session.refreshToken = envGet('SIBLE_REFRESH_TOKEN');
  console.log(C.g(`✔ ${ENV_FILE} tersimpan (chmod 600)`));

  if (!probe) {
    console.log(C.y('! kredensial belum terverifikasi (disimpan karena --force)'));
    process.exit(2);
  }
  console.log(C.g('✔ login berhasil — siap jalan: node lim.js auto'));
}

function cmdEdit() {
  ensureEnvFile();
  if (!fs.existsSync(ENV_FILE)) die(`tidak bisa membuat ${ENV_FILE}`);

  if (!stdin.isTTY) {
    console.log(C.y('bukan terminal interaktif — jalankan langsung di Termux/terminal:'));
    console.log(`  nano ${ENV_FILE}`);
    return;
  }

  const editor = String(flags_editor() || 'nano');
  const candidates = editor === 'nano' ? ['nano', 'vim', 'vi'] : [editor];
  for (const ed of candidates) {
    const r = spawnSync(ed, [ENV_FILE], { stdio: 'inherit' });
    if (r.error && r.error.code === 'ENOENT') {
      if (ed === 'nano') {
        console.log(C.y('nano belum terpasang di Termux.'));
        console.log(C.dim('  pasang dulu:  pkg update && pkg install nano -y'));
        console.log(C.dim('  tanpa editor: node lim.js setup'));
      }
      continue;
    }
    // setelah editor keluar, muat ulang isinya
    ENV = readEnvFile();
    API_BASE = envGet('SIBLE_API_BASE', DEFAULT_API_BASE);
    session.accessToken = envGet('SIBLE_TOKEN');
    session.refreshToken = envGet('SIBLE_REFRESH_TOKEN');
    console.log(C.dim(`i ${ENV_FILE} dimuat ulang`));
    return;
  }
  die('tidak ada editor yang bisa dipakai — pakai: node lim.js setup');
}

function flags_editor() {
  return process.env.SIBLE_EDITOR || process.env.EDITOR || null;
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

function runningSessionId(st) {
  const s = st?.session;
  if (!st || !s?.isRunning) return null;
  if (Date.parse(s.endsAt) !== Date.parse(st.slotEndsAt)) return null;
  return s.id;
}

function slotHours(st, flags = {}) {
  const fromFlag = Number(flags['slot-hours']);
  if (Number.isFinite(fromFlag) && fromFlag > 0) return fromFlag;
  const fromStatus = Number(st?.slotLengthHours);
  if (Number.isFinite(fromStatus) && fromStatus > 0) return fromStatus;
  const fromEnv = Number(envGet('SIBLE_SLOT_HOURS', '3'));
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 3;
}

function showStatus(st) {
  if (!st) return console.log(C.y('status kosong'));
  const sid = runningSessionId(st);
  const nowServer = Date.parse(st.serverTime) || Date.now();
  const endMs = Date.parse(st.slotEndsAt);
  const startMs = Date.parse(st.slotStartsAt);
  const perSec = sid ? Number(st.currentSecondReward ?? 0) : 0;
  const cur = Number(st.currentSessionAmount ?? 0);
  const projected = sid ? cur + (perSec * Math.max(0, endMs - nowServer)) / 1000 : 0;

  console.log(C.b('— mining status —'));
  console.log(`  total          ${fmtNum(st.totalAmount)} SIBLE`);
  console.log(`  slot           ${ts(st.slotStartsAt)}  →  ${ts(st.slotEndsAt)}  (${fmtHours(slotHours(st))})`);
  console.log(`  waktu server   ${ts(st.serverTime)}`);
  console.log(`  sisa slot      ${hms(endMs - nowServer)}`);
  console.log(`  session        ${sid ? C.g(sid) : C.dim('idle')}`);
  console.log(`  slot ini       ${fmtNum(cur)} SIBLE${perSec ? C.dim(` (+${fmtNum(perSec, 6)}/s ≈ ${fmtNum(projected)} saat slot habis)`) : ''}`);
  console.log(`  canClaim       ${st.canClaim ? C.g('ya') : 'belum'}`);
  console.log(`  canWatchAd     ${st.canWatchAd ? C.g('ya') : 'belum'}`);
  if (st.session?.nextAdAt) console.log(`  ad berikutnya  ${ts(st.session.nextAdAt)} (${hms(Date.parse(st.session.nextAdAt) - nowServer)})`);
  if (st.session?.adsWatched !== undefined)
    console.log(`  ads watched    ${st.session.adsWatched}/${st.adMaxPerSession ?? '?'}${st.session.adBoostPct ? C.dim(` (+${st.session.adBoostPct}% boost)`) : ''}`);
  if (st.slotsPerDay !== undefined) console.log(`  slot harian    ${st.slotsUsedToday ?? '?'}/${st.slotsPerDay}`);
  if (st.currentHourlyReward !== undefined) console.log(`  rate/jam       ${fmtNum(st.currentHourlyReward, 4)} SIBLE`);
  if (startMs && endMs > startMs) {
    const pct = Math.max(0, Math.min(1, (nowServer - startMs) / (endMs - startMs)));
    const w = 28;
    const f = Math.round(pct * w);
    console.log(`  progress       ${C.c('█'.repeat(f) + '░'.repeat(w - f))} ${(pct * 100).toFixed(1)}%`);
  }
  const known = new Set([
    'totalAmount',
    'currentSessionAmount',
    'currentSecondReward',
    'slotStartsAt',
    'slotEndsAt',
    'serverTime',
    'active',
    'canClaim',
    'canWatchAd',
    'session',
    'slotLengthHours',
    'slotsPerDay',
    'slotsUsedToday',
    'currentHourlyReward',
    'adMaxPerSession',
    'qualifiedReferrals',
    'f1BoostPct',
    'f2BoostPct',
  ]);
  const extra = Object.keys(st).filter((k) => !known.has(k));
  if (extra.length) {
    console.log(C.dim('  field lain:'));
    for (const k of extra) console.log(C.dim(`    ${k}: ${typeof st[k] === 'object' ? JSON.stringify(st[k]) : st[k]}`));
  }
}

async function settleClaim(claim) {
  let cur = claim;
  for (const d of [500, 1000, 2000, 4000]) {
    if (!cur || cur.status !== 'pending' || !cur.claimId) return cur;
    await sleep(d);
    try {
      cur = (await api.get(`/mining/claim/${encodeURIComponent(cur.claimId)}`)).data;
    } catch {
      /* keep */
    }
  }
  return cur;
}

async function doStart() {
  try {
    return (await api.post('/mining/start')).data;
  } catch (e) {
    if (e.code === 'MINING_SLOT_ALREADY_USED') {
      log(C.y('slot sudah dipakai — ambil status terbaru'));
      return (await api.get('/mining/status')).data;
    }
    throw e;
  }
}

async function doClaim({ quiet = false } = {}) {
  const c = await settleClaim((await api.post('/mining/claim')).data);
  if (!quiet) {
    console.log(C.b('— claim —'));
    console.log(`  status    ${c?.status ?? '?'}`);
    if (c?.amount !== undefined) console.log(`  amount    ${fmtNum(c.amount)} SIBLE`);
    if (c?.claimId) console.log(`  claimId   ${c.claimId}`);
    console.log(`  raw       ${JSON.stringify(c)}`);
  }
  return c;
}

async function doAd() {
  return (await api.post('/mining/ad')).data;
}

// ---------------------------------------------------------------------------
// Auto miner: slot 3 jam + auto accelerate
// ---------------------------------------------------------------------------

async function cmdAuto(flags) {
  const once = flags.once === true;
  const dry = flags['dry-run'] === true;
  const autoAds = flags['no-ad'] ? false : String(envGet('SIBLE_AUTO_ADS', '1')) !== '0';
  const maxAdsFlag = Number(flags['max-ads']);

  if (!(await ensureAuth())) die('tidak bisa login: isi SIBLE_TOKEN atau SIBLE_IDENTIFIER/SIBLE_PASSWORD di .env');

  acquireLock();
  const st0 = readState();
  console.log(C.b('auto-miner aktif') + C.dim(` — mode ${dry ? 'DRY-RUN' : 'LIVE'}, ${autoAds ? 'auto-accelerate ON' : 'auto-accelerate OFF'}, Ctrl+C stop`));
  console.log(
    C.dim(
      `  pengaman: jeda ${GUARD.minGapMs}ms ±${GUARD.jitterPct}% · retry ${GUARD.maxRetries}× · ` +
        `ad ${st0.ads}/${GUARD.dailyAdCap} · claim ${st0.claims}/${GUARD.dailyClaimCap} · start ${st0.starts}/${GUARD.dailyStartCap} (hari ini)`,
    ),
  );

  let iteration = 0;
  for (;;) {
    iteration++;
    try {
      let st = (await api.get('/mining/status')).data;
      const hours = slotHours(st, flags);
      let sid = runningSessionId(st);

      // 1) pastikan slot berjalan
      if (!sid) {
        if (st.slotsPerDay !== undefined && st.slotsPerDay !== null && Number(st.slotsUsedToday) >= Number(st.slotsPerDay)) {
          const nextDay = nextUtcMidnightMs();
          const waitMs = Math.max(60000, nextDay - Date.now() + 60000);
          log(C.y(`kuota slot harian habis (${st.slotsUsedToday}/${st.slotsPerDay}) — tunggu ${hms(waitMs)}`));
          await sleep(Math.min(waitMs, 60 * 60 * 1000));
          continue;
        }
        if (dry) {
          log(`[dry] idle → akan start() slot ${fmtHours(hours)}`);
        } else {
          checkDailyCap('starts', GUARD.dailyStartCap);
          log(`idle → start() slot ${fmtHours(hours)}`);
          st = await doStart();
          bumpState('starts');
          sid = runningSessionId(st);
          log(sid ? C.g(`  session ${sid} berjalan`) : C.y('  start() tidak menghasilkan session, cek status'));
        }
      }

      // 2) auto accelerate (watch ad) sampai batas per-session
      if (autoAds && !dry) {
        let guard = 0;
        while (guard++ < 50) {
          st = (await api.get('/mining/status')).data;
          if (!st?.canWatchAd || runningSessionId(st) === null) break;
          const watched = Number(st.session?.adsWatched ?? 0);
          const cap = Number.isFinite(maxAdsFlag) && maxAdsFlag > 0 ? maxAdsFlag : Number(st.adMaxPerSession ?? Infinity);
          if (Number.isFinite(cap) && watched >= cap) break;
          checkDailyCap('ads', GUARD.dailyAdCap);
          try {
            const r = await doAd();
            bumpState('ads');
            log(C.g(`  accelerate ${watched + 1}${Number.isFinite(cap) ? '/' + cap : ''} → boost ${r?.session?.adBoostPct ?? '?'}%`));
          } catch (e) {
            log(C.y(`  accelerate gagal: ${e.message}`));
            break;
          }
          await sleep(withJitter(rand(2200, 4800)));
        }
      }

      // 3) claim kalau slot selesai
      if (st?.canClaim) {
        if (dry) {
          log('[dry] canClaim → akan claim()');
        } else {
          checkDailyCap('claims', GUARD.dailyClaimCap);
          const c = await doClaim({ quiet: true });
          bumpState('claims');
          log(C.g(`  claim ${c?.status ?? '?'}${c?.amount !== undefined ? ` — ${fmtNum(c.amount)} SIBLE` : ''}`));
        }
        if (once) break;
        continue; // langsung mulai slot baru di iterasi berikut
      }

      if (once) {
        showStatus(st);
        break;
      }

      // 4) tidur sampai event berikutnya (ad / slot habis), maksimal 1 jam
      const nowSrv = Date.parse(st.serverTime) || Date.now();
      const endMs = Date.parse(st.slotEndsAt);
      let wakeAt = endMs;
      if (autoAds && st?.canWatchAd && st?.session?.nextAdAt) {
        const adMs = Date.parse(st.session.nextAdAt);
        if (Number.isFinite(adMs)) wakeAt = Math.min(wakeAt, adMs);
      }
      let waitMs = (Number.isFinite(wakeAt) ? wakeAt - nowSrv : 10 * 60 * 1000) + 2000;
      waitMs = Math.max(15000, Math.min(waitMs, 60 * 60 * 1000));
      log(
        `total ${fmtNum(st.totalAmount)} · slot-ini ${fmtNum(st.currentSessionAmount)} · sisa ${hms(endMs - nowSrv)} · ads ${st.session?.adsWatched ?? 0}/${st.adMaxPerSession ?? '?'}`,
      );
      log(C.dim(`  tidur ${hms(waitMs)}`));
      await sleep(waitMs);
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED' || e.code === 'TOKEN_INVALID') die(e.message, 3);
      if (e.code === 'LOCAL_DAILY_CAP') {
        log(C.y(e.message));
        log(C.dim('  (batas lokal ini disengaja: lebih baik berhenti daripada pola request tidak wajar)'));
        process.exit(4);
      }
      log(C.r(`  error: ${e.message} — retry 60s`));
      await sleep(60000);
    }
  }
}

function nextUtcMidnightMs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Other commands
// ---------------------------------------------------------------------------

async function cmdStatus(flags) {
  const st = (await api.get('/mining/status')).data;
  if (flags.json) return console.log(JSON.stringify(st, null, 2));
  showStatus(st);
}

async function cmdStart(flags) {
  const st = await doStart();
  if (flags.json) return console.log(JSON.stringify(st, null, 2));
  console.log(C.g('✔ mining dimulai'));
  showStatus(st);
}

async function cmdClaim(flags) {
  await doClaim({ quiet: flags.json === true });
  if (flags.json) return;
  showStatus((await api.get('/mining/status')).data);
}

async function cmdAd(flags) {
  const r = await doAd();
  console.log(C.g('✔ accelerate (ad) dipakai'));
  console.log(JSON.stringify(r, null, 2));
}

async function cmdMe(flags) {
  const me = (await api.get('/users/me')).data;
  if (flags.json) return console.log(JSON.stringify(me, null, 2));
  printUser(me);
  console.log(JSON.stringify(me, null, 2));
}

async function cmdTasks(flags) {
  const d = (await api.get('/reward-tasks')).data;
  if (flags.json) return console.log(JSON.stringify(d, null, 2));
  const items = Array.isArray(d) ? d : d?.items ?? [];
  if (!items.length) return console.log(C.y('belum ada task'));
  console.log(C.b(`— reward tasks (${items.length}) —`));
  for (const t of items) {
    const done = t.completed ?? t.claimed ?? t.status === 'claimed';
    const id = t.id ?? t.key ?? '?';
    console.log(`  ${done ? C.g('✔') : C.dim('·')} ${String(id).padEnd(28)} ${t.enabled === false ? C.dim('[off] ') : ''}${t.title ?? t.name ?? ''}`);
  }
}

async function cmdClaimTask(flags, args) {
  const id = args[0] ?? flags.id;
  if (!id) die('pakai: claim-task <taskId> [--day-key YYYY-MM-DD]');
  const r = await api.post(`/reward-tasks/${encodeURIComponent(id)}/claim`, flags['day-key'] ? { dayKey: flags['day-key'] } : {});
  console.log(C.g(`✔ claim ${id}`));
  console.log(JSON.stringify(r.data, null, 2));
}

async function cmdReferral(flags) {
  const ov = (await api.get('/referral/overview')).data;
  console.log(JSON.stringify(ov, null, 2));
}

async function cmdApplyRef(flags, args) {
  const code = args[0] ?? flags.code;
  if (!code) die('pakai: apply-ref <CODE>');
  const r = await api.post('/referral/apply', { code });
  console.log(C.g(`✔ referral ${code} diterapkan`));
  console.log(JSON.stringify(r.data, null, 2));
}

async function cmdRaw(method, p, bodyArg) {
  if (!p) die(`pakai: ${method.toLowerCase()} /path [json]`);
  let body;
  if (bodyArg) {
    try {
      body = JSON.parse(bodyArg);
    } catch {
      die('body harus JSON valid');
    }
  }
  const r = method === 'GET' ? await api.get(p) : await api.post(p, body);
  console.log(JSON.stringify(r.raw, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `lim.js — mine.sible.network client (creds in .env)

  setup [--identifier EMAIL [--password P] | --token T] [--force]
  edit            buka .env di editor (nano), otomatis dibuat kalau belum ada
  login [--token T | --identifier EMAIL [--password P] [--otp CODE]]
  logout | env
  me | status | start | claim | ad
  tasks | claim-task <id> [--day-key YYYY-MM-DD]
  referral | apply-ref <CODE>
  auto [--once] [--dry-run] [--slot-hours 3] [--max-ads N] [--no-ad]
  get <path> | post <path> '<json>'

.env keys: SIBLE_IDENTIFIER SIBLE_PASSWORD SIBLE_TOKEN SIBLE_REFRESH_TOKEN
           SIBLE_API_BASE SIBLE_SLOT_HOURS SIBLE_AUTO_ADS
guard    : SIBLE_MIN_GAP_MS SIBLE_JITTER_PCT SIBLE_MAX_RETRIES SIBLE_BACKOFF_MS
           SIBLE_DAILY_AD_CAP SIBLE_DAILY_CLAIM_CAP SIBLE_DAILY_START_CAP
           SIBLE_TIMEOUT_MS SIBLE_USER_AGENT SIBLE_ACCEPT_LANGUAGE
Flags   : --json  --env <file>
Base    : ${API_BASE}
`;

async function main() {
  const { cmd, args, flags } = parseArgs(process.argv.slice(2));

  // .env selalu ada, supaya `nano .env` langsung bisa diisi
  if (ensureEnvFile()) ENV = readEnvFile();

  if (flags.env) {
    process.env.SIBLE_ENV_FILE = String(flags.env);
  }
  if (typeof flags['api-base'] === 'string' && !ENV.SIBLE_API_BASE) {
    API_BASE = flags['api-base'];
  }

  if (!cmd) return console.log(HELP);
  if (cmd === 'help' || flags.help) return console.log(HELP);

  switch (cmd) {
    case 'login':
      return cmdLogin(flags);
    case 'logout':
      return cmdLogout();
    case 'env':
      return cmdEnv();
    case 'setup':
      return cmdSetup(flags);
    case 'edit':
      return cmdEdit();
  }

  const needAuth = ['me', 'status', 'start', 'claim', 'ad', 'tasks', 'claim-task', 'referral', 'apply-ref', 'auto', 'get', 'post'];
  if (!needAuth.includes(cmd)) die(`command tidak dikenal: ${cmd}`);

  if (typeof flags.token === 'string' && flags.token) {
    const t = flags.token.replace(/^Bearer\s+/i, '').trim();
    setTokens({ accessToken: t });
  }

  if (!(await ensureAuth())) die('belum login — isi SIBLE_TOKEN atau SIBLE_IDENTIFIER+SIBLE_PASSWORD di .env, atau jalankan: node lim.js login');

  switch (cmd) {
    case 'me':
      return cmdMe(flags);
    case 'status':
      return cmdStatus(flags);
    case 'start':
      return cmdStart(flags);
    case 'claim':
      return cmdClaim(flags);
    case 'ad':
      return cmdAd(flags);
    case 'tasks':
      return cmdTasks(flags);
    case 'claim-task':
      return cmdClaimTask(flags, args);
    case 'referral':
      return cmdReferral(flags);
    case 'apply-ref':
      return cmdApplyRef(flags, args);
    case 'auto':
      return cmdAuto(flags);
    case 'get':
      return cmdRaw('GET', flags.path ?? args[0]);
    case 'post':
      return cmdRaw('POST', args[0], args[1]);
  }
}

main().catch((e) => {
  if (e instanceof ApiError) {
    console.error(C.r(`✖ ${e.message}`));
    if (e.details) console.error(C.dim(JSON.stringify(e.details, null, 2)));
  } else console.error(C.r(`✖ ${e?.stack ?? e}`));
  process.exit(1);
});
