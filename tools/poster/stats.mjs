// Studia Poster: read the owner's post statistics (Display API, video.list) into state/stats.json.
// Claude's daily run merges that file into the department ledger; this module never edits the ledger.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ENDPOINTS, defaultLog, defaultPaths, readJson, writeJson } from './config.mjs';
import { getAccessToken } from './auth.mjs';
import { loadDrafts, tiktokPost } from './drafts.mjs';

/** Fields of the Display API video object we request (metadata + the four public metrics). */
export const VIDEO_FIELDS = Object.freeze([
  'id',
  'create_time',
  'title',
  'video_description',
  'share_url',
  'view_count',
  'like_count',
  'comment_count',
  'share_count',
  'duration',
]);
export const MAX_COUNT = 20; // page size cap of /v2/video/list/

/** Paginates POST /v2/video/list/?fields=… with {cursor, max_count} until has_more is false or maxPages. */
export async function fetchVideoList({
  accessToken,
  fetch = globalThis.fetch,
  maxPages = 10,
  maxCount = MAX_COUNT,
  log = defaultLog,
}) {
  const url = `${ENDPOINTS.videoList}?fields=${VIDEO_FIELDS.join(',')}`;
  const videos = [];
  let cursor;
  for (let page = 1; page <= maxPages; page++) {
    const body = cursor === undefined ? { max_count: maxCount } : { cursor, max_count: maxCount };
    const { data } = await tiktokPost(url, body, { accessToken, fetch });
    const batch = data.videos ?? [];
    videos.push(...batch);
    log(`video.list page ${page}: ${batch.length} post(s)${data.has_more ? ', more available' : ''}`);
    if (!data.has_more || !batch.length) break;
    cursor = data.cursor;
  }
  return videos;
}

/** Lowercase, no highlight markers, single spaces, no trailing punctuation: for prefix matching. */
export function normalizeLine(text) {
  return String(text ?? '')
    .split('\n')[0]
    .replace(/\*\*/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?…:;,]+$/g, '')
    .trim();
}

/** Every caption line worth matching: normalised, hashtag-only lines dropped. */
export function captionLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => normalizeLine(l))
    .filter((l) => l && !l.startsWith('#'));
}

/** Index of every spec post and video: { id, date, firstLine, lines }. */
export function loadSpecIndex(paths = defaultPaths()) {
  if (!existsSync(paths.daysDir)) return [];
  const out = [];
  for (const date of readdirSync(paths.daysDir).sort()) {
    const day = readJson(join(paths.daysDir, date, 'slideshows.json'), null);
    const vids = readJson(join(paths.daysDir, date, 'videos.json'), null);
    for (const post of [...(day?.slideshows ?? []), ...(vids?.videos ?? [])])
      out.push({
        id: post.id,
        date,
        kind: post.scenes ? 'video' : 'photos',
        firstLine: normalizeLine(post.caption),
        lines: captionLines(post.caption),
      });
  }
  return out;
}

/** Same index from the queue manifests (GitHub Actions has no days/ folder). */
export function loadQueueIndex(paths = defaultPaths()) {
  if (!existsSync(paths.queueDir)) return [];
  const out = [];
  for (const f of readdirSync(paths.queueDir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
    const m = readJson(join(paths.queueDir, f), null);
    for (const it of m?.items ?? [])
      out.push({
        id: it.id,
        date: m.date,
        kind: it.kind === 'video' ? 'video' : 'photos',
        firstLine: normalizeLine(it.caption),
        lines: captionLines(it.caption),
      });
  }
  return out;
}

const MIN_PREFIX = 20;

/**
 * Matches TikTok posts to spec ids: first through drafts.json publish records (publicaly_available_post_id),
 * then by the first line of the description. Returns posts sorted by create_time descending.
 */
export function matchVideos(videos, { drafts = [], specs: allSpecs = [] } = {}) {
  const byPostId = new Map();
  for (const d of drafts) for (const pid of d.publicPostIds ?? []) byPostId.set(String(pid), d.specId);
  const posts = videos.map((v) => {
    // A video post has a duration; a photo post has none. When a slideshow and a video share a caption, prefer the
    // spec of the same kind.
    const kind = Number(v.duration) > 0 ? 'video' : 'photos';
    const specs = [...allSpecs].sort((a, b) => (b.kind === kind) - (a.kind === kind));
    let specId = byPostId.get(String(v.id)) ?? null;
    let matchedBy = specId ? 'publish_record' : null;
    if (!specId) {
      const line = normalizeLine(v.video_description ?? v.title);
      const hit =
        specs.find((s) => s.firstLine && s.firstLine === line) ??
        specs.find((s) => s.firstLine.length >= MIN_PREFIX && line.startsWith(s.firstLine)) ??
        specs.find((s) => line.length >= MIN_PREFIX && s.firstLine.startsWith(line));
      if (hit) {
        specId = hit.id;
        matchedBy = 'description_prefix';
      } else {
        // Posted by hand: TikTok's title or description may start with any caption line, sometimes cut short.
        const texts = [v.video_description, v.title].map((t) => normalizeLine(t)).filter(Boolean);
        const byLine = specs.find((s) =>
          (s.lines ?? []).some(
            (l) =>
              l.length >= MIN_PREFIX &&
              texts.some((t) => t === l || t.startsWith(l) || (t.length >= MIN_PREFIX && l.startsWith(t))),
          ),
        );
        if (byLine) {
          specId = byLine.id;
          matchedBy = 'caption_line';
        }
      }
    }
    return {
      specId,
      tiktokId: String(v.id),
      createTime: v.create_time ? new Date(Number(v.create_time) * 1000).toISOString() : null,
      createTimeUnix: v.create_time ?? null,
      title: v.title ?? null,
      views: numberOrNull(v.view_count),
      likes: numberOrNull(v.like_count),
      comments: numberOrNull(v.comment_count),
      shares: numberOrNull(v.share_count),
      shareUrl: v.share_url ?? null,
      duration: numberOrNull(v.duration),
      matchedBy,
    };
  });
  posts.sort((a, b) => (b.createTimeUnix ?? 0) - (a.createTimeUnix ?? 0));
  return posts;
}

function numberOrNull(v) {
  return typeof v === 'number' ? v : v == null ? null : Number(v);
}

/** Fetches, matches and writes state/stats.json. */
export async function runStats({
  env = process.env,
  paths = defaultPaths(env),
  fetch = globalThis.fetch,
  log = defaultLog,
  accessToken,
  now = () => new Date(),
  maxPages,
} = {}) {
  const token = accessToken ?? (await getAccessToken({ env, paths, fetch, log }));
  const videos = await fetchVideoList({ accessToken: token, fetch, log, maxPages });
  const specs = [...loadSpecIndex(paths), ...loadQueueIndex(paths)];
  const posts = matchVideos(videos, { drafts: loadDrafts(paths).drafts, specs });
  const fieldsSeen = [...new Set(videos.flatMap((v) => Object.keys(v)))].sort();
  const stats = {
    fetchedAt: now().toISOString(),
    source: 'TikTok Display API /v2/video/list/ (public posts of the connected account)',
    label: 'MEASURED',
    fieldsRequested: [...VIDEO_FIELDS],
    fieldsReturned: fieldsSeen,
    posts,
  };
  writeJson(paths.statsFile, stats);
  const matched = posts.filter((p) => p.specId).length;
  log(`stats.json: ${posts.length} post(s), ${matched} matched to spec ids -> ${paths.statsFile}`);
  return stats;
}
