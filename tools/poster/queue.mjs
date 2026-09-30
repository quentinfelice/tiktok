// Studia Poster: the GitHub Actions side. Reads queue/<date>.json manifests exported from the studio,
// creates the TikTok photo drafts that are not created yet (max 5 pending per 24 h), then refreshes stats.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultLog, defaultPaths, readJson } from './config.mjs';
import { getAccessToken } from './auth.mjs';
import {
  PENDING_SHARE_CAP,
  buildInitPayload,
  initDraft,
  loadDrafts,
  pollStatus,
  saveDrafts,
  upsertDraft,
} from './drafts.mjs';
import { runStats } from './stats.mjs';

const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Drafts that still count against TikTok's pending-upload cap. */
const PENDING_STATUSES = new Set(['INIT', 'PROCESSING_DOWNLOAD', 'SEND_TO_USER_INBOX']);

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
 * Items to create now: not yet in drafts.json (by specId), oldest first, capped by what TikTok still allows.
 * Returns { selected, skipped, pending }.
 */
export function selectQueueItems(manifests, drafts, { max = PENDING_SHARE_CAP, now = Date.now() } = {}) {
  const done = new Set(drafts.map((d) => d.specId));
  const pending = drafts.filter(
    (d) => PENDING_STATUSES.has(d.status) && now - new Date(d.createdAt).getTime() < PENDING_WINDOW_MS,
  ).length;
  const room = Math.max(0, max - pending);
  const candidates = manifests.flatMap((m) => (m.items ?? []).filter((it) => !done.has(it.id)));
  return { selected: candidates.slice(0, room), skipped: candidates.slice(room), pending };
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
  const manifests = loadQueue(paths);
  const state = loadDrafts(paths);
  const { selected, skipped, pending } = selectQueueItems(manifests, state.drafts, { now: now() });
  log(
    `Queue: ${manifests.length} manifest(s), ${selected.length} to create, ${skipped.length} waiting (cap ${PENDING_SHARE_CAP}, ${pending} pending).`,
  );
  const results = [];
  if (dryRun) {
    for (const it of selected) log(`[dry-run] ${it.id}: ${JSON.stringify(buildInitPayload(it, it.images))}`);
    return { created: [], skipped, pending, dryRun: true };
  }
  if (selected.length) {
    const token = accessToken ?? (await getAccessToken({ env, paths, fetch, log }));
    for (const it of selected) {
      const payload = buildInitPayload(it, it.images);
      log(`${it.id}: creating draft with ${it.images.length} photo(s)…`);
      let record;
      try {
        const { publishId, logId } = await initDraft(payload, { accessToken: token, fetch });
        record = {
          specId: it.id,
          date: it.date,
          publishId,
          title: payload.post_info.title,
          urls: it.images,
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
  return { created: results, skipped, pending };
}
