// Studia Poster: paths, endpoints, environment loading and secret redaction.
// Every other module logs through `redact()`; never print a token, secret or one-time code.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POSTER_DIR = dirname(fileURLToPath(import.meta.url));
export const DEPT_DIR = resolve(POSTER_DIR, '..');
export const REPO_ROOT = resolve(DEPT_DIR, '..', '..');

/** Verified URL prefix of the public site (repo quentinfelice/tiktok, GitHub Pages, branch main). */
export const PUBLIC_BASE = 'https://quentinfelice.github.io/tiktok/';
export const DEFAULT_REDIRECT_URI = `${PUBLIC_BASE}callback.html`;
export const SCOPES = Object.freeze(['user.info.basic', 'video.upload', 'video.list']);

/** TikTok endpoints (Login Kit v2, Content Posting API, Display API). */
export const ENDPOINTS = Object.freeze({
  authorize: 'https://www.tiktok.com/v2/auth/authorize/',
  oauthToken: 'https://open.tiktokapis.com/v2/oauth/token/',
  contentInit: 'https://open.tiktokapis.com/v2/post/publish/content/init/',
  videoInboxInit: 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
  creatorInfo: 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
  statusFetch: 'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
  videoList: 'https://open.tiktokapis.com/v2/video/list/',
});

/** Environment variables the module reads. Values are never logged; only presence is reported. */
export const ENV_NAMES = Object.freeze([
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'TIKTOK_REDIRECT_URI',
  'TIKTOK_REFRESH_TOKEN',
  'GITHUB_TOKEN',
  'STUDIA_TOKEN_KEY',
  'STUDIA_POST_MODE',
  'STUDIA_PRIVACY_LEVEL',
]);

/**
 * How posts reach TikTok. `draft` (default): MEDIA_UPLOAD to the owner's inbox; the owner adds a sound and posts.
 * `direct`: DIRECT_POST with auto_add_music, no owner action. Direct posts of an unaudited app are restricted to
 * private viewing by TikTok, so `direct` is only useful once the app has passed TikTok's audit.
 */
export function postMode(env = process.env) {
  const mode = (env.STUDIA_POST_MODE || 'draft').toLowerCase();
  if (!['draft', 'direct'].includes(mode))
    throw new Error(`STUDIA_POST_MODE must be draft or direct, got "${mode}"`);
  return mode;
}

export const PRIVACY_LEVELS = Object.freeze([
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
]);

export function privacyLevel(env = process.env) {
  const level = env.STUDIA_PRIVACY_LEVEL || 'PUBLIC_TO_EVERYONE';
  if (!PRIVACY_LEVELS.includes(level))
    throw new Error(`STUDIA_PRIVACY_LEVEL must be one of ${PRIVACY_LEVELS.join(', ')}`);
  return level;
}

/**
 * File locations. Overrides: STUDIA_SITE_REPO (public site clone; default ../tiktok next to this repo),
 * STUDIA_STATE_DIR (drafts/stats/token.enc; GitHub Actions sets it to <workspace>/state),
 * STUDIA_TOKEN_KEY (when set, tokens live encrypted in <stateDir>/token.enc instead of .local/).
 */
export function defaultPaths(env = process.env) {
  const localDir = join(REPO_ROOT, '.local');
  const stateDir = env.STUDIA_STATE_DIR || join(POSTER_DIR, 'state');
  const siteRepo = env.STUDIA_SITE_REPO || resolve(REPO_ROOT, '..', 'tiktok');
  return {
    daysDir: join(DEPT_DIR, 'days'),
    outDir: join(DEPT_DIR, 'out'),
    stateDir,
    draftsFile: join(stateDir, 'drafts.json'),
    statsFile: join(stateDir, 'stats.json'),
    localDir,
    tokenFile: join(localDir, 'tiktok-token.json'),
    pendingAuthFile: join(localDir, 'tiktok-oauth-pending.json'),
    tokenKey: env.STUDIA_TOKEN_KEY || '',
    encTokenFile: join(stateDir, 'token.enc'),
    siteRepo,
    queueDir: join(siteRepo, 'queue'),
    toolsDir: join(siteRepo, 'tools', 'poster'),
  };
}

/** Where tokens are stored for these paths (for messages). */
export function tokenLocation(paths) {
  return paths.tokenKey ? `${paths.encTokenFile} (encrypted with STUDIA_TOKEN_KEY)` : paths.tokenFile;
}

/** Reads the credentials from the environment and registers the secret ones for redaction. */
export function loadConfig(env = process.env) {
  const config = {
    clientKey: env.TIKTOK_CLIENT_KEY || '',
    clientSecret: env.TIKTOK_CLIENT_SECRET || '',
    redirectUri: env.TIKTOK_REDIRECT_URI || DEFAULT_REDIRECT_URI,
    refreshToken: env.TIKTOK_REFRESH_TOKEN || '',
    githubToken: env.GITHUB_TOKEN || '',
    present: ENV_NAMES.filter((name) => Boolean(env[name])),
  };
  registerSecret(config.clientSecret);
  registerSecret(config.refreshToken);
  registerSecret(config.githubToken);
  registerSecret(env.STUDIA_TOKEN_KEY);
  return config;
}

export function requireCredentials(config) {
  const missing = [];
  if (!config.clientKey) missing.push('TIKTOK_CLIENT_KEY');
  if (!config.clientSecret) missing.push('TIKTOK_CLIENT_SECRET');
  if (missing.length) throw new Error(`Missing environment variable(s): ${missing.join(', ')}`);
  return config;
}

// ---------------------------------------------------------------------------------------------
// Redaction

const knownSecrets = new Set();
const REDACTED = '[REDACTED]';

/** Registers a concrete secret value so `redact()` masks it wherever it appears. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) knownSecrets.add(value);
}

/** Forgets registered values (tests only). */
export function clearSecrets() {
  knownSecrets.clear();
}

const KEY_NAMES =
  'access_token|refresh_token|client_secret|code_verifier|id_token|password|secret|token|code|authorization' +
  '|TIKTOK_CLIENT_SECRET|TIKTOK_REFRESH_TOKEN|GITHUB_TOKEN';

const PATTERNS = [
  // TikTok tokens as shown in the official examples ("act.…" access, "rft.…" refresh, "clt.…" client tokens).
  /\b(?:act|rft|clt)\.[A-Za-z0-9!*_.-]{8,}/g,
  // key=value / "key": "value" / key: value pairs for secret-looking keys.
  new RegExp(`((?<![A-Za-z0-9_])(?:${KEY_NAMES})["']?\\s*[:=]\\s*["']?)([^"'&\\s,}\\]]{4,})`, 'gi'),
  /(Bearer\s+)[A-Za-z0-9._!*-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns `input` as a string with known secrets and secret-looking values masked. */
export function redact(input) {
  let text = typeof input === 'string' ? input : safeStringify(input);
  for (const secret of knownSecrets) text = text.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
  text = text.replace(PATTERNS[0], REDACTED);
  text = text.replace(PATTERNS[1], (_m, prefix, value) => {
    // Do not mask a key name that happens to be a value (e.g. `response_type=code` or `token_type: Bearer`).
    if (/^(?:code|Bearer|bearer|ok)$/.test(value)) return `${prefix}${value}`;
    return `${prefix}${REDACTED}`;
  });
  text = text.replace(PATTERNS[2], `$1${REDACTED}`);
  text = text.replace(PATTERNS[3], REDACTED);
  text = text.replace(PATTERNS[4], REDACTED);
  return text;
}

export function safeStringify(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (value === undefined) return 'undefined';
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A logger whose every line passes through `redact()`. `write` defaults to stdout. */
export function makeLogger(write = (line) => process.stdout.write(`${line}\n`)) {
  const log = (...args) => write(args.map((a) => redact(a)).join(' '));
  log.error = (...args) => write(`ERROR ${args.map((a) => redact(a)).join(' ')}`);
  log.warn = (...args) => write(`WARN ${args.map((a) => redact(a)).join(' ')}`);
  return log;
}

export const defaultLog = makeLogger();

// ---------------------------------------------------------------------------------------------
// JSON files

export function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Writes JSON atomically (tmp + rename). `mode` 0o600 for anything that holds tokens. */
export function writeJson(file, data, { mode } = {}) {
  mkdirSync(dirname(file), { recursive: true, ...(mode ? { mode: 0o700 } : {}) });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, mode ? { mode } : undefined);
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/** Today's date (YYYY-MM-DD) in the department's time zone. */
export function todayBrussels(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(now);
}

export function assertDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error(`--date must be YYYY-MM-DD, got "${date}"`);
  return date;
}

export function assertId(id) {
  if (!/^\d{4}-[VS]?\d+$/.test(id || ''))
    throw new Error(`--id must look like MMDD-N, MMDD-VN or MMDD-SN, got "${id}"`);
  return id;
}
