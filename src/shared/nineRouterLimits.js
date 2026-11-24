'use strict';

const { createOutboundFetch } = require('./outboundFetch');
const { hashKey } = require('./hashKey');
const { normalizeLimitProvider, normalizeLimitWindow } = require('./limits');

const NINEROUTER_ENV_ACCOUNT_NAME = 'environment';

function cleanSecret(v) { let r = typeof v === 'string' ? v.trim() : ''; if ((r.startsWith('"') && r.endsWith('"')) || (r.startsWith("'") && r.endsWith("'"))) r = r.slice(1, -1).trim(); return r; }
function creds(env) {
  const pw = cleanSecret(env.TOKEN_MONITOR_NINEROUTER_PASSWORD) || cleanSecret(env.NINEROUTER_DASHBOARD_PASSWORD);
  const ak = cleanSecret(env.TOKEN_MONITOR_NINEROUTER_API_KEY) || cleanSecret(env.NINEROUTER_API_KEY);
  const url = cleanSecret(env.TOKEN_MONITOR_NINEROUTER_URL) || cleanSecret(env.NINEROUTER_DASHBOARD_URL) || 'http://localhost:20128';
  return { password: pw, apiKey: ak, baseUrl: url };
}
function fn(v) { if (v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function sfh(c) { if (c === 401 || c === 403) return 'unauthorized'; if (c === 429) return 'sourceRateLimited'; return 'unavailable'; }

async function login(url, pw, fetchFn) {
  const r = await fetchFn(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }), signal: AbortSignal.timeout(8000) });
  if (!r.ok) { const e = new Error(`9Router login failed (${r.status})`); e.status = sfh(Number(r.status)); throw e; }
  const c = r.headers.get('set-cookie'); if (!c) { const e = new Error('9Router login: no cookie'); e.status = 'error'; throw e; }
  return c.split(';')[0];
}
async function fetchStats(url, auth, fetchFn) {
  const r = await fetchFn(`${url}/api/usage/stats`, { headers: { ...auth, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) { const e = new Error(`9Router stats failed (${r.status})`); e.status = sfh(Number(r.status)); throw e; }
  return r.json();
}

function shortProv(pk) {
  const m = {
    'antigravity': 'Antigravity', 'opencode': 'OpenCode Free', 'openrouter': 'OpenRouter',
    'kiro': 'Kiro AI', 'codex': 'Codex', 'claude': 'Claude', 'cursor': 'Cursor', 'kimi': 'Kimi'
  };
  if (m[pk]) return m[pk];
  if (pk.startsWith('openai-compatible-chat-')) return 'Custom ' + pk.replace('openai-compatible-chat-', '').slice(0, 8);
  return pk.length > 20 ? pk.slice(0, 18) + '..' : pk;
}

async function fetchNineRouterAccount(name, creds, deps = {}) {
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const fetchFn = createOutboundFetch(deps.env || process.env, deps);
  let auth;

  if (creds.apiKey) auth = { Authorization: `Bearer ${creds.apiKey}` };
  else if (creds.password) {
    try { auth = { Cookie: await login(creds.baseUrl, creds.password, fetchFn) }; }
    catch (err) {
      return [normalizeLimitProvider({ provider: 'ninerouter', accountKey: hashKey('ninerouter', name), accountName: name, accountLabel: name, source: 'api', status: err.status || 'unauthorized', updatedAt, windows: [] })];
    }
  } else return [normalizeLimitProvider({ provider: 'ninerouter', accountKey: hashKey('ninerouter', name), accountName: name, accountLabel: name, source: 'api', status: 'notConfigured', updatedAt, windows: [] })];

  try {
    const stats = await fetchStats(creds.baseUrl, auth, fetchFn);
    const results = [];
    const bp = stats?.byProvider || {};
    const bm = stats?.byModel || {};

    // byModel keys look like "modelName (provider-group-id)".
    // Extract the modelName part; provider-group-id rarely matches byProvider keys.
    // Strategy: show ALL models as separate windows on the AGGREGATE card;
    // per-upstream cards show only the count + total tokens.

    // Per-upstream cards
    for (const [pk, pd] of Object.entries(bp)) {
      const cost = fn(pd?.cost) || 0;
      const req = fn(pd?.requests) || 0;
      const pT = fn(pd?.promptTokens) || 0;
      const cT = fn(pd?.completionTokens) || 0;
      const totalTokens = pT + cT;
      const label = shortProv(pk);

      const windows = [];
      const totWin = normalizeLimitWindow({
        kind: 'session',
        label: `${req} req · ${totalTokens.toLocaleString()} tokens`,
        used: cost > 0 ? cost : totalTokens,
        limit: null,
        showMeter: false,
      });
      if (totWin) windows.push(totWin);

      results.push(normalizeLimitProvider({
        provider: 'ninerouter',
        accountKey: hashKey('ninerouter', `${name}:${pk}`),
        accountName: label,
        accountLabel: label,
        planLabel: cost > 0 ? `$${cost.toFixed(2)}` : `${req} req`,
        source: 'api',
        status: 'ok',
        updatedAt,
        windows,
        balance: { amount: cost > 0 ? cost : null, currency: 'USD', todayTokenTotal: totalTokens }
      }));
    }

    // Aggregate card with full model breakdown
    const tCost = fn(stats?.totalCost) || 0;
    const tPT = fn(stats?.totalPromptTokens) || 0;
    const tCT = fn(stats?.totalCompletionTokens) || 0;
    const totalTokens = tPT + tCT;
    const upstreamCount = Object.keys(bp).length;

    // Build per-model windows, sorted by cost desc, top 15
    const modelList = Object.entries(bm)
      .map(([k, v]) => ({
        key: k,
        name: v?.rawModel || (k.match(/^(.+?)\s*\(/) || [, k])[1]?.trim() || k.slice(0, 36),
        requests: fn(v?.requests) || 0,
        tokens: (fn(v?.promptTokens) || 0) + (fn(v?.completionTokens) || 0),
        cost: fn(v?.cost) || 0
      }))
      .filter(m => m.requests > 0)
      .sort((a, b) => b.cost - a.cost);

    const aggWindows = [];
    // Top header window
    const hdrWin = normalizeLimitWindow({
      kind: 'session',
      label: `Total · ${modelList.length} models · ${modelList.reduce((s, m) => s + m.requests, 0)} requests`,
      used: tCost > 0 ? tCost : totalTokens,
      limit: null,
      showMeter: false,
    });
    if (hdrWin) aggWindows.push(hdrWin);

    for (const m of modelList.slice(0, 15)) {
      const useCost = m.cost > 0;
      const win = normalizeLimitWindow({
        kind: 'session',
        label: m.name,
        used: useCost ? m.cost : m.tokens,
        limit: null,
        showMeter: false,
      });
      if (win) {
        if (useCost) win.detail = `${m.requests} req · ${m.tokens.toLocaleString()} tokens`;
        else win.detail = `${m.requests} requests`;
        aggWindows.push(win);
      }
    }

    results.push(normalizeLimitProvider({
      provider: 'ninerouter',
      accountKey: hashKey('ninerouter', `${name}:__total__`),
      accountName: name,
      accountLabel: name,
      planLabel: upstreamCount > 0 ? `${upstreamCount} upstreams` : '9Router',
      source: 'api',
      status: 'ok',
      updatedAt,
      windows: aggWindows,
      balance: { amount: tCost > 0 ? tCost : null, currency: 'USD', todayTokenTotal: totalTokens }
    }));

    return results;
  } catch (err) {
    return [normalizeLimitProvider({ provider: 'ninerouter', accountKey: hashKey('ninerouter', name), accountName: name, accountLabel: name, source: 'api', status: err.status || 'unavailable', updatedAt, windows: [] })];
  }
}

function configuredAccounts(options = {}, deps = {}) {
  const seen = new Set(); const accs = [];
  for (const [name, prof] of Object.entries(options.ninerouterProfiles || {})) {
    const pw = cleanSecret(prof?.password), ak = cleanSecret(prof?.apiKey), url = cleanSecret(prof?.baseUrl) || 'http://localhost:20128';
    if (prof?.enabled !== false && (pw || ak) && !seen.has(url)) { accs.push({ name, baseUrl: url, password: pw, apiKey: ak }); seen.add(url); }
  }
  const env = creds(deps.env || process.env);
  if ((env.password || env.apiKey) && !seen.has(env.baseUrl)) accs.push({ name: 'environment', ...env });
  return accs;
}

async function fetchNineRouterLimits(options = {}, deps = {}) {
  let accs = configuredAccounts(options, deps);
  const sc = options.limitRefreshScope?.provider === 'ninerouter' ? options.limitRefreshScope : null;
  if (sc) { const n = String(sc.accountName || sc.accountLabel || '').trim(); accs = n ? accs.filter(a => a.name === n) : []; }
  if (accs.length === 0) return [normalizeLimitProvider({ provider: 'ninerouter', source: 'api', status: 'notConfigured', updatedAt: new Date((deps.now || Date.now)()).toISOString(), windows: [] })];
  return (await Promise.all(accs.map(a => fetchNineRouterAccount(a.name, a, deps)))).flat();
}

module.exports = { NINEROUTER_ENV_ACCOUNT_NAME, configuredAccounts, fetchNineRouterAccount, fetchNineRouterLimits, nineRouterCredentials: creds, nineRouterLogin: login, fetchStats };
