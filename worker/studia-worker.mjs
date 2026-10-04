// Studia API: a tiny Cloudflare Worker that keeps the TikTok client secret off the website.
// Paste this single file into a Worker (Cloudflare dashboard > Workers & Pages > Create > Edit code).
//
// Secrets (Settings > Variables and Secrets, type "Secret"): TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET,
// SESSION_KEY (random, 32+ characters). Optional plain variables: POST_MODE (draft | direct, default draft),
// SCOPES (default user.info.basic,video.upload,video.list), ALLOWED_ORIGIN (default https://quentinfelice.github.io).
//
// The browser never sees a TikTok token: after login the Worker returns an AES-GCM sealed session that only this
// Worker can open. Only the fixed TikTok endpoints below are reachable; this is not an open proxy.

const PUBLIC_BASE = 'https://quentinfelice.github.io/tiktok/';
const REDIRECT_URI = `${PUBLIC_BASE}callback.html`;
const TT = {
  authorize: 'https://www.tiktok.com/v2/auth/authorize/',
  token: 'https://open.tiktokapis.com/v2/oauth/token/',
  creator: 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
  init: 'https://open.tiktokapis.com/v2/post/publish/content/init/',
  videoInit: 'https://open.tiktokapis.com/v2/post/publish/video/init/',
  videoInbox: 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
  status: 'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
  videos: 'https://open.tiktokapis.com/v2/video/list/',
  userInfo: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name',
};
const VIDEO_FIELDS = 'id,create_time,title,video_description,view_count,like_count,comment_count,share_count';
const PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];
const TITLE_MAX = 90;
const VIDEO_CAPTION_MAX = 2200;
const DESCRIPTION_MAX = 4000;
const MAX_PHOTOS = 35;
const REFRESH_MARGIN_MS = 60_000;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

const enc = new TextEncoder();
const b64u = {
  enc: (bytes) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};

async function aesKey(env) {
  if (!env.SESSION_KEY || env.SESSION_KEY.length < 32)
    throw new HttpError(500, 'server_not_configured', 'SESSION_KEY missing or too short');
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(env.SESSION_KEY));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(obj, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await aesKey(env),
    enc.encode(JSON.stringify(obj)),
  );
  return `${b64u.enc(iv)}.${b64u.enc(ct)}`;
}

export async function unseal(token, env) {
  try {
    const [iv, ct] = String(token).split('.');
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64u.dec(iv) },
      await aesKey(env),
      b64u.dec(ct),
    );
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, 'session_invalid', 'Log in again');
  }
}

const settings = (env) => ({
  mode: (env.POST_MODE || 'draft').toLowerCase() === 'direct' ? 'direct' : 'draft',
  scopes: env.SCOPES || 'user.info.basic,video.upload,video.list',
  origin: env.ALLOWED_ORIGIN || 'https://quentinfelice.github.io',
});

function requireCredentials(env) {
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET)
    throw new HttpError(500, 'server_not_configured', 'TikTok credentials are not set on the server');
}

async function tokenRequest(fields, env) {
  requireCredentials(env);
  const res = await fetch(TT.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      ...fields,
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token)
    throw new HttpError(
      400,
      json.error || 'token_error',
      json.error_description || 'TikTok refused the login',
    );
  const now = Date.now();
  return {
    a: json.access_token,
    r: json.refresh_token,
    e: now + Number(json.expires_in ?? 0) * 1000,
    re: now + Number(json.refresh_expires_in ?? 0) * 1000,
    o: json.open_id,
    s: json.scope,
  };
}

/** Opens the session from the Authorization header; refreshes it when the access token is about to expire. */
async function openSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new HttpError(401, 'not_logged_in', 'Log in with TikTok first');
  let session = await unseal(auth.slice(7), env);
  let refreshed = null;
  if (session.e - Date.now() < REFRESH_MARGIN_MS) {
    if (!session.r || session.re < Date.now()) throw new HttpError(401, 'session_expired', 'Log in again');
    const next = await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.r }, env);
    session = { ...next, o: next.o || session.o };
    refreshed = await seal(session, env);
  }
  return { session, refreshed };
}

async function tiktok(url, session, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.a}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => null);
  const err = json?.error ?? {};
  if (!json || !res.ok || (err.code && err.code !== 'ok'))
    throw Object.assign(
      new HttpError(
        res.ok ? 400 : 502,
        err.code || `http_${res.status}`,
        err.message || 'TikTok request failed',
      ),
      // TikTok answered with its own error code: a definite refusal, nothing was created.
      { refused: Boolean(json && err.code && err.code !== 'ok') },
    );
  return json.data ?? {};
}

/**
 * Draft mode has only video.upload (+ user.info.basic): creator_info/query needs video.publish, so the account bar
 * comes from user/info and no privacy options exist (the user picks them in TikTok). Direct mode asks creator_info.
 */
const creatorFor = async (session, mode) => {
  if (mode !== 'draft') return creatorInfo(session);
  const res = await fetch(TT.userInfo, { headers: { Authorization: `Bearer ${session.a}` } });
  const json = await res.json().catch(() => null);
  const err = json?.error ?? {};
  if (!json || !res.ok || (err.code && err.code !== 'ok'))
    throw new HttpError(
      res.ok ? 400 : 502,
      err.code || `http_${res.status}`,
      err.message || 'TikTok request failed',
    );
  const u = json.data?.user ?? {};
  return {
    nickname: u.display_name ?? null,
    username: null,
    avatarUrl: u.avatar_url ?? null,
    privacyLevelOptions: [],
    commentDisabled: false,
    maxPhotoCount: null,
  };
};

const creatorInfo = async (session) => {
  const d = await tiktok(TT.creator, session, {});
  return {
    nickname: d.creator_nickname ?? null,
    username: d.creator_username ?? null,
    avatarUrl: d.creator_avatar_url ?? null,
    privacyLevelOptions: d.privacy_level_options ?? [],
    commentDisabled: Boolean(d.comment_disabled),
    duetDisabled: Boolean(d.duet_disabled),
    stitchDisabled: Boolean(d.stitch_disabled),
    maxPhotoCount: d.max_photo_count ?? null,
    maxVideoPostDurationSec: d.max_video_post_duration_sec ?? null,
  };
};

const utf16 = (s) => String(s ?? '').length;

/** Validates the browser's post request and builds the exact TikTok content/init body. */
export function buildPost(input, creator, mode) {
  const images = input?.images;
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_PHOTOS)
    throw new HttpError(400, 'bad_images', `Between 1 and ${MAX_PHOTOS} images are required`);
  for (const u of images)
    if (typeof u !== 'string' || !u.startsWith(PUBLIC_BASE) || !/\.(jpe?g|webp)$/i.test(u))
      throw new HttpError(400, 'bad_images', 'Images must be JPEG or WebP files on the verified Studia site');
  if (creator.maxPhotoCount && images.length > creator.maxPhotoCount)
    throw new HttpError(
      400,
      'too_many_photos',
      `This account accepts at most ${creator.maxPhotoCount} photos`,
    );
  const title = String(input.title ?? '').trim();
  const description = String(input.description ?? '').trim();
  if (!title || utf16(title) > TITLE_MAX)
    throw new HttpError(400, 'bad_title', `Title is required, ${TITLE_MAX} characters at most`);
  if (utf16(description) > DESCRIPTION_MAX)
    throw new HttpError(400, 'bad_description', `Description is ${DESCRIPTION_MAX} characters at most`);
  const source_info = { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: images };
  if (mode === 'draft')
    return { post_info: { title, description }, source_info, post_mode: 'MEDIA_UPLOAD', media_type: 'PHOTO' };

  const privacy = input.privacyLevel;
  if (!PRIVACY_LEVELS.includes(privacy))
    throw new HttpError(400, 'privacy_required', 'Choose who can view this post');
  if (!creator.privacyLevelOptions.includes(privacy))
    throw new HttpError(400, 'privacy_not_allowed', 'This visibility is not available for your account');
  const brandContent = Boolean(input.brandContent);
  const brandOrganic = Boolean(input.brandOrganic);
  if (brandContent && privacy === 'SELF_ONLY')
    throw new HttpError(400, 'branded_private', 'Branded content visibility cannot be set to private');
  return {
    post_info: {
      title,
      description,
      privacy_level: privacy,
      disable_comment: creator.commentDisabled || Boolean(input.disableComment),
      auto_add_music: true,
      brand_content_toggle: brandContent,
      brand_organic_toggle: brandOrganic,
    },
    source_info,
    post_mode: 'DIRECT_POST',
    media_type: 'PHOTO',
  };
}

/**
 * Validates a video post request and returns { url, body } for TikTok: Direct Post (video/init) or the inbox
 * (inbox/video/init, no post_info). The file must be an MP4 or MOV under the verified Studia site prefix.
 */
export function buildVideoPost(input, creator, mode) {
  const video = input?.video;
  // MP4, MOV or WebM (TikTok's supported formats; the renderer falls back to WebM without an H.264 encoder).
  if (typeof video !== 'string' || !video.startsWith(PUBLIC_BASE) || !/\.(mp4|mov|webm)$/i.test(video))
    throw new HttpError(
      400,
      'bad_video',
      'The video must be an MP4, MOV or WebM file on the verified Studia site',
    );
  const source_info = { source: 'PULL_FROM_URL', video_url: video };
  if (mode === 'draft') return { url: TT.videoInbox, body: { source_info } };

  const caption = String(input.title ?? '').trim();
  if (!caption || utf16(caption) > VIDEO_CAPTION_MAX)
    throw new HttpError(400, 'bad_title', `A caption is required, ${VIDEO_CAPTION_MAX} characters at most`);
  const privacy = input.privacyLevel;
  if (!PRIVACY_LEVELS.includes(privacy))
    throw new HttpError(400, 'privacy_required', 'Choose who can view this post');
  if (!creator.privacyLevelOptions.includes(privacy))
    throw new HttpError(400, 'privacy_not_allowed', 'This visibility is not available for your account');
  const brandContent = Boolean(input.brandContent);
  const brandOrganic = Boolean(input.brandOrganic);
  if (brandContent && privacy === 'SELF_ONLY')
    throw new HttpError(400, 'branded_private', 'Branded content visibility cannot be set to private');
  const seconds = Number(input.durationSec);
  if (creator.maxVideoPostDurationSec && !(Number.isFinite(seconds) && seconds > 0))
    throw new HttpError(400, 'duration_required', 'The video length is needed to check your account limit');
  if (creator.maxVideoPostDurationSec && seconds > creator.maxVideoPostDurationSec)
    throw new HttpError(
      400,
      'video_too_long',
      `This account can post videos up to ${creator.maxVideoPostDurationSec} seconds`,
    );
  return {
    url: TT.videoInit,
    body: {
      post_info: {
        title: caption,
        privacy_level: privacy,
        disable_comment: creator.commentDisabled || Boolean(input.disableComment),
        // Duet and Stitch follow the creator's own choice (off unless ticked), and stay off when the account forbids them.
        disable_duet: Boolean(creator.duetDisabled) || !input.allowDuet,
        disable_stitch: Boolean(creator.stitchDisabled) || !input.allowStitch,
        brand_content_toggle: brandContent,
        brand_organic_toggle: brandOrganic,
        // AI-generated content label (synthetic narration). The field name follows TikTok's Direct Post reference as
        // cited in the Codex review of 2026-10-04; it could not be read from here (egress-blocked).
        is_aigc: Boolean(input.isAigc),
      },
      source_info,
    },
  };
}

async function route(request, env, cfg) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (method === 'GET' && pathname === '/health')
    return { body: { ok: true, mode: cfg.mode, scopes: cfg.scopes } };

  if (method === 'GET' && pathname === '/auth/url') {
    requireCredentials(env);
    const state = b64u.enc(crypto.getRandomValues(new Uint8Array(16)));
    const url = new URL(TT.authorize);
    url.searchParams.set('client_key', env.TIKTOK_CLIENT_KEY);
    url.searchParams.set('scope', cfg.scopes);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('state', state);
    return { body: { url: url.toString(), state, mode: cfg.mode } };
  }

  if (method === 'POST' && pathname === '/auth/exchange') {
    const { code } = await request.json().catch(() => ({}));
    if (typeof code !== 'string' || code.length < 8 || code.length > 2048)
      throw new HttpError(400, 'bad_code', 'Missing authorization code');
    const session = await tokenRequest(
      { grant_type: 'authorization_code', code: decodeURIComponent(code), redirect_uri: REDIRECT_URI },
      env,
    );
    return { body: { session: await seal(session, env), scope: session.s ?? null, mode: cfg.mode } };
  }

  if (method === 'POST' && pathname.startsWith('/api/')) {
    const { session, refreshed } = await openSession(request, env);
    try {
      return { body: await apiRoute(request, pathname, session, cfg, env), refreshed };
    } catch (err) {
      // TikTok may rotate the refresh token: a refreshed session goes back even when the call itself fails, or the
      // browser would keep a token that can no longer refresh (Codex review, PR #13).
      if (refreshed && err && typeof err === 'object') err.session = refreshed;
      throw err;
    }
  }
  throw new HttpError(404, 'not_found');
}

/**
 * Direct mode: one record per queue item, shared by every browser and device, so an item is posted once even when
 * another browser has no local record of it (Codex review, PR #13). The record lives in a Durable Object (one
 * instance per item): it is strongly consistent and handles one request at a time, so two browsers cannot both take
 * the lock (Workers KV could not promise that, nor two writes to one key within a second). Taken before TikTok is
 * asked (SENDING); a definite TikTok refusal releases it; an unclear outcome keeps it (UNKNOWN) until the owner checks
 * TikTok and unlocks it; an accepted post keeps its publish id until TikTok reports it FAILED.
 */
const STALE_SENDING_MS = 2 * 60 * 1000;
export class SentLock {
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const { op, rec, publishId } = await request.json();
    // One operation at a time per item: read-then-write cannot interleave with another browser's request.
    const out = await this.state.blockConcurrencyWhile(async () => {
      const storage = this.state.storage;
      const cur = (await storage.get('rec')) ?? null;
      if (op === 'acquire') {
        if (cur) return { acquired: false, rec: cur };
        await storage.put('rec', { status: 'SENDING', at: new Date().toISOString() });
        return { acquired: true };
      }
      if (op === 'settle') {
        await storage.put('rec', { ...rec, at: new Date().toISOString() });
        return { ok: true };
      }
      if (op === 'release') {
        let mine = false;
        if (cur) {
          if (publishId)
            mine = cur.publishId === publishId; // TikTok reported this very post FAILED
          else if (cur.publishId)
            mine = false; // an accepted post is never released otherwise
          else if (rec?.status === 'SENDING')
            mine = cur.status === 'SENDING'; // the holder's own lock, refused by TikTok
          // The owner's unlock: an unclear outcome, or a SENDING lock whose request died long ago.
          else mine = cur.status === 'UNKNOWN' || Date.now() - Date.parse(cur.at) > STALE_SENDING_MS;
        }
        if (mine) await storage.delete('rec');
        return { released: mine, rec: mine ? null : cur };
      }
      return { rec: cur };
    });
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
  }
}

const ITEM_ID = /^\d{4}-[VS]?\d+$/;
const itemIdOf = (input) => {
  if (typeof input?.itemId !== 'string' || !ITEM_ID.test(input.itemId))
    throw new HttpError(400, 'bad_item', 'The queue item id is required');
  return input.itemId;
};
/** The item's lock: `lock(op, extra)` → the Durable Object's answer. Refused when the binding is missing. */
function itemLock(env, itemId) {
  if (!env.SENT_LOCK)
    throw new HttpError(
      500,
      'server_not_configured',
      'Direct mode needs the SENT_LOCK Durable Object (one record per posted item); see worker/README.md',
    );
  const stub = env.SENT_LOCK.get(env.SENT_LOCK.idFromName(itemId));
  return async (op, extra = {}) =>
    (
      await stub.fetch('https://sent-lock/', { method: 'POST', body: JSON.stringify({ op, ...extra }) })
    ).json();
}

async function postDirect(input, session, cfg, env) {
  const itemId = itemIdOf(input);
  const lock = itemLock(env, itemId);
  const creator = await creatorFor(session, cfg.mode);
  const target = input?.video
    ? buildVideoPost(input, creator, cfg.mode)
    : { url: TT.init, body: buildPost(input, creator, cfg.mode) };
  const taken = await lock('acquire');
  if (!taken.acquired && taken.rec?.publishId)
    throw new HttpError(
      409,
      'already_posted',
      'This item was already posted from the app (here or on another device).',
    );
  if (!taken.acquired)
    throw new HttpError(
      409,
      'post_uncertain',
      'An earlier post of this item is in progress or got no clear answer. Check TikTok; if it is not there, unlock it and post again.',
    );
  let d;
  try {
    d = await tiktok(target.url, session, target.body);
  } catch (err) {
    if (err?.refused) await lock('release', { rec: { status: 'SENDING' } });
    else await lock('settle', { rec: { status: 'UNKNOWN' } });
    throw err;
  }
  if (!d.publish_id) {
    await lock('settle', { rec: { status: 'UNKNOWN' } });
    throw new HttpError(502, 'no_publish_id', 'TikTok did not return a publish id');
  }
  await lock('settle', { rec: { status: 'INIT', publishId: d.publish_id } });
  return { publishId: d.publish_id, mode: cfg.mode };
}

async function apiRoute(request, pathname, session, cfg, env) {
  let body;
  if (pathname === '/api/creator') {
    body = { creator: await creatorFor(session, cfg.mode), mode: cfg.mode };
  } else if (pathname === '/api/post') {
    // Draft mode: the scheduled queue is the only sender (it shares no lock with this Worker), so the app is a
    // viewer and this route refuses, even for an old tab or a direct caller (Codex review, PR #13).
    if (cfg.mode !== 'direct')
      throw new HttpError(
        409,
        'draft_mode_viewer',
        'In draft mode the daily run sends every item to your TikTok inbox; the app does not post.',
      );
    body = await postDirect(await request.json().catch(() => null), session, cfg, env);
  } else if (pathname === '/api/unlock') {
    // The owner checked TikTok after an unclear outcome: the item is not there, so it may be posted again.
    if (cfg.mode !== 'direct')
      throw new HttpError(409, 'draft_mode_viewer', 'Nothing to unlock in draft mode.');
    const r = await itemLock(env, itemIdOf(await request.json().catch(() => null)))('release');
    if (r.rec?.publishId)
      throw new HttpError(409, 'already_posted', 'TikTok accepted this item; it cannot be unlocked.');
    if (r.rec)
      throw new HttpError(
        409,
        'post_in_progress',
        'This item is being posted right now (here or on another device).',
      );
    body = { unlocked: true };
  } else if (pathname === '/api/status') {
    const { publishId, itemId } = (await request.json().catch(() => ({}))) ?? {};
    if (typeof publishId !== 'string' || !/^[\w.~-]{4,200}$/.test(publishId))
      throw new HttpError(400, 'bad_publish_id');
    const d = await tiktok(TT.status, session, { publish_id: publishId });
    // TikTok itself reports this post FAILED: its item may be posted again, from any browser (only the record that
    // holds this publish id is released).
    if (cfg.mode === 'direct' && d.status === 'FAILED' && typeof itemId === 'string' && ITEM_ID.test(itemId))
      await itemLock(env, itemId)('release', { publishId });
    body = {
      status: d.status ?? null,
      failReason: d.fail_reason ?? null,
      publicPostIds: d.publicaly_available_post_id ?? [],
    };
  } else if (pathname === '/api/videos') {
    const d = await tiktok(`${TT.videos}?fields=${VIDEO_FIELDS}`, session, { max_count: 20 });
    body = {
      videos: (d.videos ?? []).map((v) => ({
        id: v.id,
        createTime: v.create_time ?? null,
        title: v.title ?? '',
        description: v.video_description ?? '',
        views: v.view_count ?? null,
        likes: v.like_count ?? null,
        comments: v.comment_count ?? null,
        shares: v.share_count ?? null,
      })),
    };
  } else {
    throw new HttpError(404, 'not_found');
  }
  return body;
}

/** Secrets pasted into a dashboard often carry a stray space or newline: trim every text value. */
export function cleanEnv(env) {
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]),
  );
}

export default {
  async fetch(request, rawEnv) {
    const env = cleanEnv(rawEnv);
    const cfg = settings(env);
    const origin = request.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': cfg.origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    if (origin && origin !== cfg.origin) return reply({ error: { code: 'origin_not_allowed' } }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const { body, refreshed } = await route(request, env, cfg);
      return reply(refreshed ? { ...body, session: refreshed } : body);
    } catch (err) {
      const session = typeof err?.session === 'string' ? { session: err.session } : {};
      if (err instanceof HttpError)
        return reply({ error: { code: err.code, message: err.message }, ...session }, err.status);
      return reply({ error: { code: 'internal_error', message: 'Unexpected error' }, ...session }, 500);
    }
  },
};
