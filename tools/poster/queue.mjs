// Studia Poster: the GitHub Actions side. Reads queue/<date>.json manifests exported from the studio,
// creates the TikTok photo drafts that are not created yet (max 5 pending per 24 h), then refreshes stats.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultLog, defaultPaths, postMode, readJson, todayBrussels } from './config.mjs';
import { getAccessToken } from './auth.mjs';
import {
  PENDING_SHARE_CAP,
  assertCreatorAllows,
  buildInitPayload,
  buildVideoInitPayload,
  initDraft,
  initVideoDraft,
  fetchStatus,
  loadDrafts,
  pollStatus,
  queryCreatorInfo,
  saveDrafts,
  upsertDraft,
} from './drafts.mjs';
import { runStats } from './stats.mjs';

const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Drafts that still count against TikTok's pending-upload cap. */
const PENDING_STATUSES = new Set(['INIT', 'PROCESSING_DOWNLOAD', 'SEND_TO_USER_INBOX']);
/** A queue item is done once a record delivered it or one is still on its way; some FAILED ones are retried. */
const DELIVERED = new Set(['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE']);
const IN_FLIGHT = new Set(['INIT', 'PROCESSING_DOWNLOAD', 'PROCESSING_UPLOAD']);
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
      recs.some((d) => DELIVERED.has(d.status) || IN_FLIGHT.has(d.status) || finalFail(d))
    )
      done.add(id);
  return done;
}

/**
 * Re-checks records a past run left in flight (polling timed out): TikTok may have delivered or failed them since.
 * A record still in flight stays in flight however old it is: TikTok gives processing no time limit, so retrying
 * could deliver a duplicate (Codex review round 3). The weekly run reports any that stay stuck.
 */
export async function refreshInFlight(
  state,
  { accessToken, fetch, now = Date.now(), status = fetchStatus, log = defaultLog },
) {
  let changed = 0;
  for (const d of state.drafts.filter((x) => IN_FLIGHT.has(x.status))) {
    try {
      const s = await status(d.publishId, { accessToken, fetch });
      if (s.status && s.status !== d.status) {
        Object.assign(d, {
          status: s.status,
          failReason: s.failReason ?? null,
          lastCheckedAt: new Date(now).toISOString(),
        });
        changed++;
      }
    } catch (err) {
      log.warn(`${d.specId}: status check failed (${err.message})`);
    }
  }
  return changed;
}

/** All manifests in queue/, oldest date first. */
export function loadQueue(paths = defaultPaths()) {
  if (!existsSync(paths.queueDir)) return [];
  return readdirSync(paths.queueDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => readJson(join(paths.queueDir, f), null))
    .filter(Boolean);
}

/**
 * Items to create now: not yet in drafts.json (by specId), released (manifest date ≤ today in Europe/Brussels), oldest
 * first, capped by what TikTok still allows. Items of later dates wait: that is how a stock of pre-built videos is
 * released one day at a time. Returns { selected, skipped, pending, scheduled }.
 */
export function selectQueueItems(
  manifests,
  drafts,
  { max = PENDING_SHARE_CAP, now = Date.now(), today = todayBrussels(new Date(now)) } = {},
) {
  const done = doneSpecIds(drafts);
  const pending = drafts.filter(
    (d) => PENDING_STATUSES.has(d.status) && now - new Date(d.createdAt).getTime() < PENDING_WINDOW_MS,
  ).length;
  const room = Math.max(0, max - pending);
  const open = manifests.flatMap((m) =>
    (m.items ?? []).filter((it) => !done.has(it.id)).map((it) => ({ ...it, date: it.date ?? m.date })),
  );
  const candidates = open.filter((it) => !it.date || it.date <= today);
  const scheduled = open.filter((it) => it.date && it.date > today);
  return { selected: candidates.slice(0, room), skipped: candidates.slice(room), pending, scheduled };
}

const isVideo = (it) => it.kind === 'video';

/** The request body for one queue item: a photo post, or a video sent to the inbox. */
export function payloadFor(it, { mode, level }) {
  return isVideo(it)
    ? buildVideoInitPayload(it)
    : buildInitPayload(it, it.images, { mode, privacyLevel: level });
}

/** Creates the drafts for the selected items and records them; then updates stats.json. */
export async function runQueue({
  env = process.env,
  paths = defaultPaths(env),
  fetch = globalThis.fetch,
  log = defaultLog,
  accessToken,
  sleep,
  dryRun = false,
  now = Date.now,
  stats = true,
} = {}) {
  const mode = postMode(env);
  // TikTok's Direct Post rules ask for the creator's explicit consent to each post, with the metadata in front of them
  // (PLAYBOOK §9). An unattended queue run cannot give that, so it only ever makes inbox drafts; direct posts go
  // through the web app (site/app.html), one confirmation per post.
  if (mode === 'direct')
    throw new Error(
      'STUDIA_POST_MODE=direct is refused for the unattended queue: TikTok requires per-post consent. ' +
        'Use draft mode here and post directly from the Studia web app.',
    );
  const level = undefined; // inbox drafts carry no privacy level
  const manifests = loadQueue(paths);
  const state = loadDrafts(paths);
  let token = accessToken;
  if (!dryRun && state.drafts.some((d) => IN_FLIGHT.has(d.status))) {
    token ??= await getAccessToken({ env, paths, fetch, log });
    if (await refreshInFlight(state, { accessToken: token, fetch, now: now(), log }))
      saveDrafts(paths, state);
  }
  const { selected, skipped, pending, scheduled } = selectQueueItems(manifests, state.drafts, { now: now() });
  log(
    `Queue (${mode}${level ? `, ${level}` : ''}): ${manifests.length} manifest(s), ${selected.length} to create, ${skipped.length} waiting (cap ${PENDING_SHARE_CAP}, ${pending} pending), ${scheduled.length} scheduled for later dates.`,
  );
  const results = [];
  if (dryRun) {
    for (const it of selected) log(`[dry-run] ${it.id}: ${JSON.stringify(payloadFor(it, { mode, level }))}`);
    return { created: [], skipped, pending, scheduled, dryRun: true };
  }
  if (selected.length) {
    token ??= await getAccessToken({ env, paths, fetch, log });
    let creator = null;
    if (mode === 'direct') {
      creator = await queryCreatorInfo({ accessToken: token, fetch });
      log(
        `Creator ${creator.nickname ?? '?'}: privacy options ${creator.privacyLevelOptions.join(', ') || '(none reported)'}`,
      );
    }
    for (const it of selected) {
      if (isVideo(it) && mode === 'direct') {
        log.warn(`${it.id}: video Direct Post is not supported yet; it stays in the queue.`);
        continue;
      }
      let payload;
      try {
        payload = payloadFor(it, { mode, level });
      } catch (err) {
        log.error(`${it.id}: ${err.message}`);
        continue;
      }
      if (creator && !isVideo(it))
        assertCreatorAllows(creator, { privacyLevel: level, photoCount: it.images.length });
      log(
        isVideo(it)
          ? `${it.id}: sending the video to the inbox as a draft…`
          : `${it.id}: ${mode === 'direct' ? 'publishing' : 'creating draft with'} ${it.images.length} photo(s)…`,
      );
      let record;
      try {
        const { publishId, logId } = await (isVideo(it) ? initVideoDraft : initDraft)(payload, {
          accessToken: token,
          fetch,
        });
        record = {
          specId: it.id,
          date: it.date,
          publishId,
          kind: isVideo(it) ? 'video' : 'photos',
          title: isVideo(it) ? it.title : payload.post_info.title,
          urls: isVideo(it) ? [it.video] : it.images,
          mode,
          status: 'INIT',
          failReason: null,
          publicPostIds: [],
          logId: logId ?? null,
        };
      } catch (err) {
        log.error(`${it.id}: ${err.message}`);
        if (err.code === 'spam_risk_too_many_pending_share') {
          log.warn('TikTok pending-upload cap reached; the rest of the queue waits for the next run.');
          break;
        }
        continue;
      }
      upsertDraft(state, record);
      saveDrafts(paths, state);
      const status = await pollStatus(record.publishId, { accessToken: token, fetch, log, sleep });
      Object.assign(record, {
        status: status.status,
        failReason: status.failReason,
        publicPostIds: status.publicPostIds,
        lastCheckedAt: new Date().toISOString(),
      });
      upsertDraft(state, record);
      saveDrafts(paths, state);
      results.push(record);
      log(`${it.id}: ${status.status}${status.failReason ? ` (${status.failReason})` : ''}`);
    }
  }
  if (stats) {
    try {
      await runStats({ env, paths, fetch, log, accessToken });
    } catch (err) {
      log.warn(`stats skipped: ${err.message}`);
    }
  }
  return { created: results, skipped, pending, scheduled };
}
