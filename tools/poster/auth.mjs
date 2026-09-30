// Studia Poster: TikTok Login Kit (OAuth 2.0, v2 endpoints).
// authorizeUrl() -> owner approves in the browser -> callback.html shows the code -> exchangeCode() -> refresh().
// Tokens live only in the environment and in .local/tiktok-token.json (git-ignored, mode 0600).

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import {
  ENDPOINTS,
  SCOPES,
  defaultLog,
  defaultPaths,
  loadConfig,
  readJson,
  registerSecret,
  requireCredentials,
  tokenLocation,
  writeJson,
} from './config.mjs';
import { readEncrypted, writeEncrypted } from './tokenstore.mjs';

/** Refresh the access token when it expires within this many seconds. */
const REFRESH_MARGIN_S = 300;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * PKCE pair. TikTok documents `code_challenge = hex(SHA256(code_verifier))` (Login Kit for desktop),
 * i.e. hex encoding rather than the RFC 7636 base64url encoding. Only S256 is supported.
 * Verifier: 43–128 chars of [A-Za-z0-9-._~]; 48 random bytes -> 64 base64url chars.
 */
export function pkcePair(bytes = 48) {
  const verifier = base64url(randomBytes(bytes));
  const challenge = createHash('sha256').update(verifier).digest('hex');
  return { verifier, challenge };
}

export function randomState(bytes = 16) {
  return base64url(randomBytes(bytes));
}

/** Pure builder: https://www.tiktok.com/v2/auth/authorize/?client_key=…&scope=…&response_type=code&redirect_uri=…&state=… */
export function buildAuthorizeUrl({ clientKey, redirectUri, state, codeChallenge, scopes = SCOPES }) {
  if (!clientKey) throw new Error('client_key is required');
  const params = new URLSearchParams();
  params.set('client_key', clientKey);
  params.set('scope', scopes.join(','));
  params.set('response_type', 'code');
  params.set('redirect_uri', redirectUri);
  params.set('state', state);
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  // TikTok's examples show the scope list with literal commas.
  return `${ENDPOINTS.authorize}?${params.toString().replace(/%2C/g, ',')}`;
}

/**
 * Builds the authorize URL and stores {state, codeVerifier} in .local/ so `exchange` can send code_verifier.
 * `pkce: false` disables PKCE (Login Kit for web documents PKCE for desktop apps; it is optional for web).
 */
export function authorizeUrl({
  env = process.env,
  paths = defaultPaths(env),
  pkce = true,
  log = defaultLog,
} = {}) {
  const config = requireCredentialsForAuthorize(loadConfig(env));
  const state = randomState();
  const pair = pkce ? pkcePair() : null;
  writeJson(
    paths.pendingAuthFile,
    {
      state,
      codeVerifier: pair?.verifier ?? null,
      redirectUri: config.redirectUri,
      createdAt: new Date().toISOString(),
    },
    { mode: 0o600 },
  );
  if (pair) registerSecret(pair.verifier);
  const url = buildAuthorizeUrl({
    clientKey: config.clientKey,
    redirectUri: config.redirectUri,
    state,
    codeChallenge: pair?.challenge,
  });
  log(`Pending authorization saved to ${paths.pendingAuthFile} (state + PKCE verifier).`);
  return { url, state, pkce: Boolean(pair) };
}

function requireCredentialsForAuthorize(config) {
  if (!config.clientKey) throw new Error('Missing environment variable(s): TIKTOK_CLIENT_KEY');
  return config;
}

/**
 * Accepts the bare code from callback.html, or the full callback URL (…callback.html?code=…&state=…).
 * The token endpoint wants the URL-decoded value.
 */
export function parseCodeInput(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('exchange needs the one-time code shown on callback.html');
  if (/^https?:\/\//i.test(text) || text.includes('code=')) {
    const url = new URL(text.startsWith('http') ? text : `https://x/?${text.replace(/^\?/, '')}`);
    const code = url.searchParams.get('code');
    if (!code) throw new Error('No code parameter found in the pasted URL');
    return { code, state: url.searchParams.get('state') };
  }
  let code = text;
  try {
    if (/%[0-9A-Fa-f]{2}/.test(code)) code = decodeURIComponent(code);
  } catch {
    // keep as pasted
  }
  return { code, state: null };
}

async function postForm(url, fields, { fetch = globalThis.fetch } = {}) {
  const body = new URLSearchParams(fields);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: body.toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint returned HTTP ${res.status} with a non-JSON body`);
  }
  if (!res.ok || !json.access_token) {
    const err = new Error(
      `Token request failed (HTTP ${res.status}): ${json.error ?? 'unknown_error'}${
        json.error_description ? ` — ${json.error_description}` : ''
      }${json.log_id ? ` [log_id ${json.log_id}]` : ''}`,
    );
    err.code = json.error;
    err.logId = json.log_id;
    throw err;
  }
  return json;
}

/** Converts a token response to the cache record (absolute expiry times) and registers its secrets. */
export function toTokenRecord(json, now = Date.now()) {
  registerSecret(json.access_token);
  registerSecret(json.refresh_token);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    open_id: json.open_id,
    scope: json.scope,
    token_type: json.token_type,
    expires_at: new Date(now + Number(json.expires_in ?? 0) * 1000).toISOString(),
    refresh_expires_at: new Date(now + Number(json.refresh_expires_in ?? 0) * 1000).toISOString(),
    obtained_at: new Date(now).toISOString(),
  };
}

export function readTokenCache(paths) {
  const rec = paths.tokenKey
    ? readEncrypted(paths.encTokenFile, paths.tokenKey)
    : readJson(paths.tokenFile, null);
  if (rec) {
    registerSecret(rec.access_token);
    registerSecret(rec.refresh_token);
  }
  return rec;
}

export function writeTokenCache(paths, record) {
  if (paths.tokenKey) writeEncrypted(paths.encTokenFile, record, paths.tokenKey);
  else writeJson(paths.tokenFile, record, { mode: 0o600 });
}

/** Non-secret view of the cache for `doctor` and command output. */
export function tokenSummary(record, now = Date.now()) {
  if (!record) return { cached: false };
  const secs = (iso) => Math.round((new Date(iso).getTime() - now) / 1000);
  return {
    cached: true,
    openId: record.open_id ? `${String(record.open_id).slice(0, 6)}…` : null,
    scope: record.scope ?? null,
    accessExpiresInS: secs(record.expires_at),
    refreshExpiresInS: secs(record.refresh_expires_at),
    obtainedAt: record.obtained_at,
  };
}

/** grant_type=authorization_code. Fast path: one POST, then the cache is written. */
export async function exchangeCode(
  input,
  {
    env = process.env,
    paths = defaultPaths(env),
    fetch = globalThis.fetch,
    now = Date.now,
    log = defaultLog,
  } = {},
) {
  const config = requireCredentials(loadConfig(env));
  const { code, state } = parseCodeInput(input);
  const pending = readJson(paths.pendingAuthFile, null);
  if (pending?.codeVerifier) registerSecret(pending.codeVerifier);
  if (state && pending?.state && state !== pending.state) {
    throw new Error('state mismatch: the pasted callback does not belong to the last authorize-url run');
  }
  const fields = {
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: pending?.redirectUri || config.redirectUri,
  };
  if (pending?.codeVerifier) fields.code_verifier = pending.codeVerifier;
  const json = await postForm(ENDPOINTS.oauthToken, fields, { fetch });
  const record = toTokenRecord(json, now());
  writeTokenCache(paths, record);
  if (existsSync(paths.pendingAuthFile)) unlinkSync(paths.pendingAuthFile);
  const summary = tokenSummary(record, now());
  log(
    `Tokens stored in ${tokenLocation(paths)} (scope: ${summary.scope}; access valid ${summary.accessExpiresInS}s).`,
  );
  return summary;
}

/** grant_type=refresh_token. Persists the (possibly rotated) refresh token. */
export async function refresh({
  env = process.env,
  paths = defaultPaths(env),
  fetch = globalThis.fetch,
  now = Date.now,
  log = defaultLog,
} = {}) {
  const config = requireCredentials(loadConfig(env));
  const cached = readTokenCache(paths);
  const refreshToken = cached?.refresh_token || config.refreshToken;
  if (!refreshToken) {
    throw new Error(
      'No refresh token: run `authorize-url` + `exchange <code>` first, or set TIKTOK_REFRESH_TOKEN',
    );
  }
  const json = await postForm(
    ENDPOINTS.oauthToken,
    {
      client_key: config.clientKey,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    { fetch },
  );
  const record = toTokenRecord(json, now());
  const rotated = record.refresh_token !== refreshToken;
  writeTokenCache(paths, record);
  const summary = tokenSummary(record, now());
  log(
    `Access token refreshed (valid ${summary.accessExpiresInS}s). Refresh token ${
      rotated
        ? 'ROTATED: the cache holds the new one; TIKTOK_REFRESH_TOKEN in the environment is now stale'
        : 'unchanged'
    }.`,
  );
  return { ...summary, rotated };
}

/** Returns a usable access token, refreshing when it is missing or about to expire. */
export async function getAccessToken(options = {}) {
  const env = options.env ?? process.env;
  const paths = options.paths ?? defaultPaths(env);
  const now = options.now ?? Date.now;
  const cached = readTokenCache(paths);
  if (cached?.access_token && new Date(cached.expires_at).getTime() - now() > REFRESH_MARGIN_S * 1000) {
    return cached.access_token;
  }
  await refresh({ ...options, env, paths, now });
  return readTokenCache(paths).access_token;
}
