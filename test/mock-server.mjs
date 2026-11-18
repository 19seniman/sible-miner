// mock-server.mjs — tiruan API Sible untuk menguji lim.js
// Jalankan: node mock-server.mjs 8787
import http from 'node:http';

const PORT = Number(process.argv[2] ?? 8787);

const state = {
  tokens: new Map(), // accessToken -> refreshToken
  refresh: new Map(),
  sessions: new Map(), // sessionId -> {adsWatched, adBoostPct}
  active: null,
  currentSessionAmount: 0,
  total: 12.5,
  started: 0,
  slotMs: Number(process.env.SLOT_SEC ?? 0) > 0 ? Number(process.env.SLOT_SEC) * 1000 : 3 * 3600 * 1000,
  slotsUsed: 0,
  log: [],
};

const now = () => new Date();
const iso = (d) => d.toISOString();

function slotStart() {
  if (!state.started) return now();
  return new Date(state.started);
}

function slotEnd() {
  return new Date((state.started || Date.now()) + state.slotMs);
}

function statusBody() {
  const s = state.active;
  const sec = s ? Math.max(0, (Date.now() - state.started) / 1000) : 0;
  return {
    totalAmount: state.total + sec * 0.001,
    currentSessionAmount: sec * 0.001,
    currentSecondReward: s ? 0.001 : 0,
    slotStartsAt: iso(slotStart()),
    slotEndsAt: iso(slotEnd()),
    serverTime: iso(now()),
    active: s ? 1 : 0,
    canClaim: state.started > 0 && Date.now() >= state.started + state.slotMs,
    canWatchAd: !!s && (state.sessions.get(s)?.adsWatched ?? 0) < 3,
    slotLengthHours: state.slotMs / 3600000,
    slotsPerDay: 8,
    slotsUsedToday: state.slotsUsed,
    currentHourlyReward: 3.6,
    adMaxPerSession: 3,
    session: s
      ? {
          id: s,
          isRunning: true,
          endsAt: iso(slotEnd()),
          nextAdAt: iso(new Date(Date.now() + 1000)),
          adsWatched: state.sessions.get(s)?.adsWatched ?? 0,
          adBoostPct: state.sessions.get(s)?.adBoostPct ?? 0,
        }
      : null,
  };
}

function send(res, code, data, extra = {}) {
  const body = JSON.stringify({ success: code < 400, data: code < 400 ? data : null, error: code < 400 ? null : data, requestId: 'mock', timestamp: iso(now()), path: extra.path ?? '' });
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname.replace(/^\/api\/v1/, '');
  let body = '';
  for await (const c of req) body += c;
  const json = body ? JSON.parse(body) : {};
  state.log.push(`${req.method} ${p}`);

  const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const authed = state.tokens.has(auth);

  if (p === '/auth/login' && req.method === 'POST') {
    if (json.identifier !== 'tester@mail.com' || json.password !== 'secret123') {
      return send(res, 400, { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }, { path: p });
    }
    const at = 'acc_' + Math.random().toString(36).slice(2);
    const rt = 'ref_' + Math.random().toString(36).slice(2);
    state.tokens.set(at, rt);
    state.refresh.set(rt, at);
    return send(res, 200, { accessToken: at, refreshToken: rt, user: { id: 'u1', email: 'tester@mail.com', username: 'tester' } });
  }

  if (p === '/auth/refresh' && req.method === 'POST') {
    const at = state.refresh.get(json.refreshToken);
    if (!at) return send(res, 401, { code: 'TOKEN_INVALID', message: 'bad refresh' }, { path: p });
    return send(res, 200, { accessToken: at, refreshToken: json.refreshToken });
  }

  if (p === '/auth/logout') return send(res, 200, {});

  if (!authed) return send(res, 401, { code: 'TOKEN_INVALID', message: 'Authentication required' }, { path: p });

  if (p === '/users/me') return send(res, 200, { id: 'u1', email: 'tester@mail.com', username: 'tester', balance: 42 });

  if (p === '/mining/status') return send(res, 200, statusBody());

  if (p === '/mining/start') {
    if (state.active) return send(res, 409, { code: 'MINING_SLOT_ALREADY_USED', message: 'slot used' }, { path: p });
    state.active = 'sess_' + state.slotsUsed;
    state.sessions.set(state.active, { adsWatched: 0, adBoostPct: 0 });
    state.started = Date.now();
    state.slotsUsed++;
    return send(res, 200, statusBody());
  }

  if (p === '/mining/ad') {
    if (process.env.RATE_LIMIT_AD === '1' && !state.rateLimitedAd) {
      state.rateLimitedAd = true;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
      return res.end(JSON.stringify({ success: false, data: null, error: { code: 'RATE_LIMITED', message: 'slow down' }, requestId: 'mock', timestamp: iso(now()), path: p }));
    }
    const s = state.sessions.get(state.active);
    if (!s) return send(res, 409, { code: 'MINING_NO_SESSION', message: 'no session' }, { path: p });
    s.adsWatched++;
    s.adBoostPct += 5;
    return send(res, 200, { session: { ...s, id: state.active } });
  }

  if (p === '/mining/claim') {
    if (!statusBody().canClaim) return send(res, 409, { code: 'MINING_NOT_CLAIMABLE', message: 'too early' }, { path: p });
    const amount = 10.8;
    state.total += amount;
    state.active = null;
    state.started = 0;
    return send(res, 200, { claimId: 'c1', status: 'completed', amount });
  }

  if (p.startsWith('/mining/claim/')) return send(res, 200, { claimId: p.split('/').pop(), status: 'completed', amount: 10.8 });

  return send(res, 404, { code: 'NOT_FOUND', message: 'nope' }, { path: p });
});

server.listen(PORT, () => console.log(`mock on ${PORT}`));
