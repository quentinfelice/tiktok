// Studia Poster: the GitHub Actions side. Reads queue/<date>.json manifests exported from the studio,
// creates the TikTok photo drafts that are not created yet (max 5 pending per 24 h), then refreshes stats.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultLog, defaultPaths, postMode, readJson, todayBrussels } from './config.mjs';
import { getAccessToken } from './auth.mjs';
import { git } from './media.mjs';
import {
  HANDED_TO_APP,
  IN_FLIGHT,
  PENDING_SHARE_CAP,
  TikTokApiError,
  assertCreatorAllows,
  buildInitPayload,
  buildVideoInitPayload,
  doneSpecIds,
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
/** Drafts that still count against TikTok's pending-upload cap (an UNKNOWN send may have reached TikTok). */
const PENDING_STATUSES = new Set(['INIT', 'PROCESSING_DOWNLOAD', 'SEND_TO_USER_INBOX', 'UNKNOWN']);
export { MAX_ATTEMPTS, RETRYABLE_FAILS, doneSpecIds } from './drafts.mjs';

/**
 * True when the item is still in its manifest on the remote main. A run loads the queue once, then sends for minutes;
 * a withdrawal pushed meanwhile must stop the send. A site repo that is not a git clone (tests) has no remote: true.
 * A failed fetch is false: the item waits for the next run (fail closed).
 */
export function stillQueued(paths, item, { env = process.env, log = defaultLog } = {}) {
  // No site repo given (unit tests pass partial paths): nothing to resolve against the working directory.
  if (!paths.siteRepo || !existsSync(join(paths.siteRepo, '.git'))) return true;
  try {
    git(['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], {
      cwd: paths.siteRepo,
      env,
      identity: false,
    });
    const text = git(['show', `origin/main:queue/${item.date}.json`], {
      cwd: paths.siteRepo,
      identity: false,
    });
    if (JSON.parse(text).items?.some((x) => x.id === item.id)) return true;
    log.warn(`${item.id}: withdrawn from queue/${item.date}.json since this run started; not sent.`);
    return false;
  } catch (err) {
    log.warn(
      `${item.id}: could not confirm it is still queued (${String(err.message).slice(0, 120)}); not sent now.`,
    );
    return false;
  }
}

/**
 * The posting mode the Worker deploys with: POST_MODE in worker/wrangler.jsonc of the public repo (the file Cloudflare
 * builds from). No file means no web app is deployed from this repo: draft.
 */
export function workerMode(paths) {
  if (!paths.siteRepo) return 'draft';
  const file = join(paths.siteRepo, 'worker', 'wrangler.jsonc');
  if (!existsSync(file)) return 'draft';
  const text = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return /"POST_MODE"\s*:\s*"direct"/.test(text) ? 'direct' : 'draft';
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
  const {
    selected: due,
    skipped,
    pending,
    scheduled,
  } = selectQueueItems(manifests, state.drafts, { now: now() });
  // Phase C: when the Worker posts directly, the web app is the only sender; its posts live in the owner's browser,
  // not in state/drafts.json, so the queue stands down instead of sending the same items again (Codex review, PR #13).
  const appDirect = workerMode(paths) === 'direct';
  if (appDirect && due.length)
    log.warn(
      `The web app posts directly (worker/wrangler.jsonc POST_MODE "direct"): it is the only sender, so the queue sends none of the ${due.length} due item(s).`,
    );
  // Every queued item is handed to the app while it posts directly: back in draft mode, the queue sends only what is
  // exported afterwards, never an item the owner may already have posted (Codex review, PR #13).
  if (appDirect && !dryRun) {
    const owned = doneSpecIds(state.drafts);
    const handed = manifests.flatMap((m) =>
      (m.items ?? []).map((it) => ({ ...it, date: it.date ?? m.date })),
    );
    let n = 0;
    for (const it of handed.filter((x) => !owned.has(x.id))) {
      upsertDraft(state, {
        specId: it.id,
        date: it.date,
        publishId: `app:${it.id}`,
        status: HANDED_TO_APP,
        failReason: null,
        publicPostIds: [],
        logId: null,
      });
      n++;
    }
    if (n) {
      saveDrafts(paths, state);
      log(`${n} queued item(s) handed to the web app (${HANDED_TO_APP}).`);
    }
  }
  const selected = appDirect ? [] : due;
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
      // A withdrawal pushed while this run was going is honoured up to the moment of sending (Codex review, PR #13).
      if (!stillQueued(paths, it, { env, log })) continue;
      // Lock first: if TikTok accepts the init but its answer is lost, the next run must not send the item again.
      const record = {
        specId: it.id,
        date: it.date,
        publishId: `pending:${it.id}:${now()}`,
        kind: isVideo(it) ? 'video' : 'photos',
        title: isVideo(it) ? it.title : payload.post_info.title,
        urls: isVideo(it) ? [it.video] : it.images,
        mode,
        status: 'SENDING',
        failReason: null,
        publicPostIds: [],
        logId: null,
      };
      upsertDraft(state, record);
      // upsertDraft stores a copy: work on the stored entry from here on.
      const entry = state.drafts.find((d) => d.publishId === record.publishId);
      saveDrafts(paths, state);
      try {
        const { publishId, logId } = await (isVideo(it) ? initVideoDraft : initDraft)(payload, {
          accessToken: token,
          fetch,
        });
        Object.assign(entry, {
          publishId,
          logId: logId ?? null,
          status: 'INIT',
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        // TikTok's own error code is a definite refusal: nothing was created, so the item may be sent later.
        // Anything else (network failure, a non-JSON answer, no publish_id) leaves the post's fate UNKNOWN.
        if (err instanceof TikTokApiError && err.code && err.code !== 'ok')
          state.drafts.splice(state.drafts.indexOf(entry), 1);
        else Object.assign(entry, { status: 'UNKNOWN', failReason: err.message.slice(0, 200) });
        saveDrafts(paths, state);
        log.error(`${it.id}: ${err.message}`);
        if (err.code === 'spam_risk_too_many_pending_share') {
          log.warn('TikTok pending-upload cap reached; the rest of the queue waits for the next run.');
          break;
        }
        continue;
      }
      saveDrafts(paths, state);
      let status;
      try {
        status = await pollStatus(entry.publishId, { accessToken: token, fetch, log, sleep });
      } catch (err) {
        // TikTok accepted the init: the entry stays in flight (refreshInFlight checks it next run); go on.
        log.warn(`${it.id}: status check failed (${err.message}); it stays in flight`);
        results.push(entry);
        continue;
      }
      Object.assign(entry, {
        status: status.status,
        failReason: status.failReason,
        publicPostIds: status.publicPostIds,
        lastCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      saveDrafts(paths, state);
      results.push(entry);
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
