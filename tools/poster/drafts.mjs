// Studia Poster: send slideshows to the owner's TikTok inbox as photo drafts (Content Posting API).
// POST /v2/post/publish/content/init/ with post_mode MEDIA_UPLOAD + media_type PHOTO + source PULL_FROM_URL,
// then poll /v2/post/publish/status/fetch/. Studia never publishes directly.

import { ENDPOINTS, PUBLIC_BASE, defaultLog, defaultPaths, readJson, writeJson } from './config.mjs';
import { getAccessToken } from './auth.mjs';
import { loadDay, mediaTargets, selectPosts, slidePngs } from './media.mjs';

/** Limits from the photo post reference (UTF-16 code units). */
export const TITLE_MAX = 90;
export const DESCRIPTION_MAX = 4000;
export const MAX_PHOTOS = 35;
/** TikTok caps API uploads the creator has not yet handled at 5 per rolling 24 h (spam_risk_too_many_pending_share). */
export const PENDING_SHARE_CAP = 5;
/** status/fetch: 30 requests per minute per user access token. */
export const TERMINAL_STATUSES = new Set(['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE', 'FAILED']);

/**
 * SENDING is written before the init call; UNKNOWN replaces it when the answer was lost or unclear (TikTok may have
 * the post). Both block a resend: only a person who checked the TikTok inbox clears an UNKNOWN record.
 */
export const UNCERTAIN = new Set(['SENDING', 'UNKNOWN']);
/** A post is done once a record delivered it or one is still on its way; some FAILED ones are retried. */
export const DELIVERED = new Set(['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE']);
/**
 * Written by the queue for every queued item while the web app posts directly: those items belong to the app, so they
 * are not sent again when draft mode resumes (direct posts are recorded only in the owner's browser).
 */
export const HANDED_TO_APP = 'HANDED_TO_APP';
export const IN_FLIGHT = new Set(['INIT', 'PROCESSING_DOWNLOAD', 'PROCESSING_UPLOAD']);
export const MAX_ATTEMPTS = 3;
/** Fail reasons TikTok's status reference treats as transient; any other FAILED record is final (no resend). */
export const RETRYABLE_FAILS = new Set(['internal', 'video_pull_failed', 'photo_pull_failed']);
const finalFail = (d) => d.status === 'FAILED' && !RETRYABLE_FAILS.has(d.failReason);

/** Spec ids that must not be sent again: delivered, in flight, or out of attempts (MAX_ATTEMPTS records). */
export function doneSpecIds(drafts) {
  const bySpec = new Map();
  for (const d of drafts) bySpec.set(d.specId, [...(bySpec.get(d.specId) ?? []), d]);
  const done = new Set();
  for (const [id, recs] of bySpec)
    if (
      recs.length >= MAX_ATTEMPTS ||
      recs.some(
        (d) =>
          DELIVERED.has(d.status) ||
          IN_FLIGHT.has(d.status) ||
          UNCERTAIN.has(d.status) ||
          d.status === HANDED_TO_APP ||
          finalFail(d),
      )
    )
      done.add(id);
  return done;
}

/** Cuts to `max` UTF-16 units without splitting a surrogate pair; adds an ellipsis when cut. */
export function utf16Truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Title: first line of the caption, highlight markers removed. */
export function buildTitle(post) {
  const first = String(post.caption ?? '')
    .split('\n')[0]
    .replace(/\*\*/g, '')
    .trim();
  return utf16Truncate(first || post.id, TITLE_MAX);
}

/** Description: caption + blank line + hashtags (the department convention). */
export function buildDescription(post) {
  const tags = (post.hashtags ?? []).join(' ');
  const text = tags ? `${post.caption ?? ''}\n\n${tags}` : String(post.caption ?? '');
  return utf16Truncate(text, DESCRIPTION_MAX);
}

/**
 * Exact request body of /v2/post/publish/content/init/ for a photo post.
 * mode `draft` -> MEDIA_UPLOAD (inbox draft; the owner adds a sound and posts).
 * mode `direct` -> DIRECT_POST with privacy_level, auto_add_music and the disclosure fields TikTok requires
 * (comments on, no branded content by default). Direct posts need the app audit to be publicly visible.
 */
export function buildInitPayload(post, urls, { privacyLevel, mode = 'draft', autoAddMusic = true } = {}) {
  if (!Array.isArray(urls) || urls.length < 1) throw new Error(`${post.id}: no photo URLs`);
  if (urls.length > MAX_PHOTOS)
    throw new Error(`${post.id}: ${urls.length} photos exceed the limit of ${MAX_PHOTOS}`);
  for (const u of urls) {
    if (!u.startsWith(PUBLIC_BASE))
      throw new Error(`${post.id}: ${u} is outside the verified prefix ${PUBLIC_BASE}`);
  }
  const post_info = { title: buildTitle(post), description: buildDescription(post) };
  if (mode === 'direct') {
    if (!privacyLevel) throw new Error(`${post.id}: direct posting needs a privacy_level`);
    Object.assign(post_info, {
      privacy_level: privacyLevel,
      disable_comment: false,
      auto_add_music: Boolean(autoAddMusic),
      brand_content_toggle: false,
      brand_organic_toggle: false,
    });
  } else if (privacyLevel) {
    post_info.privacy_level = privacyLevel;
  }
  return {
    post_info,
    source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: urls },
    post_mode: mode === 'direct' ? 'DIRECT_POST' : 'MEDIA_UPLOAD',
    media_type: 'PHOTO',
  };
}

/**
 * Body of /v2/post/publish/inbox/video/init/: a video sent to the owner's inbox as a draft, pulled from the verified
 * URL prefix. The inbox flow takes no post_info: the owner sets the caption and sound in TikTok.
 */
export function buildVideoInitPayload(item) {
  const url = item.video;
  if (typeof url !== 'string' || !url.startsWith(PUBLIC_BASE))
    throw new Error(`${item.id}: video URL is outside the verified prefix ${PUBLIC_BASE}`);
  if (!/\.(mp4|mov|webm)$/i.test(url)) throw new Error(`${item.id}: video must be an MP4, MOV or WebM file`);
  return { source_info: { source: 'PULL_FROM_URL', video_url: url } };
}

/**
 * POST /v2/post/publish/creator_info/query/ — required before a direct post: tells which privacy levels the
 * creator may use, whether posting is allowed right now, and the photo limit.
 */
export async function queryCreatorInfo({ accessToken, fetch = globalThis.fetch }) {
  const { data } = await tiktokPost(ENDPOINTS.creatorInfo, {}, { accessToken, fetch });
  return {
    nickname: data.creator_nickname ?? null,
    privacyLevelOptions: data.privacy_level_options ?? [],
    commentDisabled: Boolean(data.comment_disabled),
    maxPhotoCount: data.max_photo_count ?? null,
  };
}

/** Throws when the creator cannot be posted to with the requested settings (per the Content Sharing Guidelines). */
export function assertCreatorAllows(info, { privacyLevel, photoCount }) {
  if (info.privacyLevelOptions.length && !info.privacyLevelOptions.includes(privacyLevel)) {
    throw new Error(
      `privacy_level ${privacyLevel} not offered for this creator (allowed: ${info.privacyLevelOptions.join(', ')})`,
    );
  }
  if (info.maxPhotoCount && photoCount > info.maxPhotoCount) {
    throw new Error(`${photoCount} photos exceed the creator's limit of ${info.maxPhotoCount}`);
  }
  return true;
}

export class TikTokApiError extends Error {
  constructor(message, { code, logId, httpStatus } = {}) {
    super(message);
    this.name = 'TikTokApiError';
    this.code = code;
    this.logId = logId;
    this.httpStatus = httpStatus;
  }
}

/** POST JSON with the bearer token; resolves the `data` object or throws TikTokApiError when error.code != "ok". */
export async function tiktokPost(url, body, { accessToken, fetch = globalThis.fetch }) {
  if (!accessToken) throw new Error('No access token');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TikTokApiError(`TikTok returned HTTP ${res.status} with a non-JSON body`, {
      httpStatus: res.status,
    });
  }
  const error = json.error ?? {};
  if (!res.ok || (error.code && error.code !== 'ok')) {
    throw new TikTokApiError(
      `TikTok error ${error.code ?? `http_${res.status}`}: ${error.message ?? ''}${error.log_id ? ` [log_id ${error.log_id}]` : ''}`,
      { code: error.code, logId: error.log_id, httpStatus: res.status },
    );
  }
  return { data: json.data ?? {}, logId: error.log_id };
}

export async function initDraft(payload, options) {
  const { data, logId } = await tiktokPost(ENDPOINTS.contentInit, payload, options);
  if (!data.publish_id) throw new TikTokApiError('content/init answered without publish_id', { logId });
  return { publishId: data.publish_id, logId };
}

export async function initVideoDraft(payload, options) {
  const { data, logId } = await tiktokPost(ENDPOINTS.videoInboxInit, payload, options);
  if (!data.publish_id) throw new TikTokApiError('inbox/video/init answered without publish_id', { logId });
  return { publishId: data.publish_id, logId };
}

export async function fetchStatus(publishId, options) {
  const { data } = await tiktokPost(ENDPOINTS.statusFetch, { publish_id: publishId }, options);
  return {
    status: data.status,
    failReason: data.fail_reason ?? null,
    publicPostIds: data.publicaly_available_post_id ?? [],
    uploadedBytes: data.uploaded_bytes ?? null,
  };
}

/** Polls until SEND_TO_USER_INBOX / PUBLISH_COMPLETE / FAILED or the timeout; returns the last status. */
export async function pollStatus(
  publishId,
  {
    accessToken,
    fetch = globalThis.fetch,
    sleep = defaultSleep,
    timeoutMs = 3 * 60 * 1000,
    intervalMs = 5000,
    log = defaultLog,
    now = Date.now,
  },
) {
  const started = now();
  for (;;) {
    const last = await fetchStatus(publishId, { accessToken, fetch });
    log(`  ${publishId}: ${last.status}${last.failReason ? ` (${last.failReason})` : ''}`);
    if (TERMINAL_STATUSES.has(last.status)) return { ...last, timedOut: false };
    if (now() - started >= timeoutMs) return { ...last, timedOut: true };
    await sleep(intervalMs);
  }
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------------------------
// state/drafts.json

export function loadDrafts(paths = defaultPaths()) {
  return readJson(paths.draftsFile, { drafts: [] });
}

export function saveDrafts(paths, state) {
  writeJson(paths.draftsFile, state);
}

/** Inserts or updates by publishId. */
export function upsertDraft(state, record) {
  const i = state.drafts.findIndex((d) => d.publishId === record.publishId);
  const now = new Date().toISOString();
  if (i === -1) state.drafts.push({ createdAt: now, ...record, updatedAt: now });
  else state.drafts[i] = { ...state.drafts[i], ...record, updatedAt: now };
  return state;
}

/** Why a live standalone send is refused (the scheduled queue is the only sender). */
export const ONE_SENDER =
  'The scheduled queue is the only sender: export the day (cli.mjs export --date …) and the publish workflow sends ' +
  'each item on its date. drafts --date only prints the payloads (--dry-run).';

/**
 * Prints the draft payload of each post of the day (or one id) and calls nothing. Sending is the scheduled queue's
 * job alone: a second sender keeps its own state and could deliver a post twice, whatever lock it takes (Codex
 * review, PR #13), so a live run is refused.
 */
export async function runDrafts({
  date,
  id,
  dryRun = false,
  env = process.env,
  paths = defaultPaths(env),
  log = defaultLog,
  privacyLevel,
} = {}) {
  if (!dryRun) throw new Error(ONE_SENDER);
  const posts = selectPosts(loadDay(date, paths), id);
  const unchecked = posts.filter((p) => p.factCheck?.status !== 'PASS');
  if (unchecked.length)
    throw new Error(
      `${unchecked.map((p) => p.id).join(', ')}: fact-check is not PASS; fix or drop the post before sending it`,
    );
  return posts.map((post) => {
    const { pngs } = slidePngs(date, post, paths);
    const { urls } = mediaTargets(date, post.id, pngs.length, paths.siteRepo);
    const payload = buildInitPayload(post, urls, { privacyLevel });
    log(`[dry-run] ${post.id} -> POST ${ENDPOINTS.contentInit}\n${JSON.stringify(payload, null, 2)}`);
    return { specId: post.id, payload, dryRun: true };
  });
}

/** Re-polls every recorded draft that is not terminal yet and updates drafts.json. */
export async function checkDrafts({
  env = process.env,
  paths = defaultPaths(env),
  fetch = globalThis.fetch,
  log = defaultLog,
  accessToken,
} = {}) {
  const state = loadDrafts(paths);
  // A SENDING/UNKNOWN lock or a hand-over to the web app has no TikTok publish id to poll.
  const open = state.drafts.filter(
    (d) =>
      !UNCERTAIN.has(d.status) &&
      d.status !== HANDED_TO_APP &&
      (!TERMINAL_STATUSES.has(d.status) || d.status === 'SEND_TO_USER_INBOX'),
  );
  if (!open.length) {
    log('No drafts to check.');
    return [];
  }
  const token = accessToken ?? (await getAccessToken({ env, paths, fetch, log }));
  const results = [];
  for (const d of open) {
    const s = await fetchStatus(d.publishId, { accessToken: token, fetch });
    upsertDraft(state, {
      publishId: d.publishId,
      status: s.status,
      failReason: s.failReason,
      publicPostIds: s.publicPostIds,
      lastCheckedAt: new Date().toISOString(),
    });
    log(`${d.specId} ${d.publishId}: ${s.status}${s.failReason ? ` (${s.failReason})` : ''}`);
    results.push({ specId: d.specId, publishId: d.publishId, ...s });
  }
  saveDrafts(paths, state);
  return results;
}
