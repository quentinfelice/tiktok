// Studia Poster: hand a day's slideshows to the public repo, where GitHub Actions talks to TikTok.
// export: out/<date>/<id>/NN.png -> JPEG in <site>/media/, manifest <site>/queue/<date>.json, runtime copy in
// <site>/tools/poster/, one commit, one push. No TikTok call happens here (this container cannot reach TikTok).
// pull-stats: git pull the site repo and copy state/stats.json + state/drafts.json back for the Analyst.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  POSTER_DIR,
  assertDate,
  defaultLog,
  defaultPaths,
  loadConfig,
  readJson,
  writeJson,
} from './config.mjs';
import {
  HANDED_TO_APP,
  RELEASED,
  RELEASE_AFTER_MS,
  UNCERTAIN,
  buildDescription,
  buildTitle,
} from './drafts.mjs';
import {
  checkSiteRepo,
  commitAndPush,
  convertPngsToJpegs,
  git,
  refreshSiteRepo,
  loadDay,
  mediaTargets,
  publicUrl,
  selectPosts,
  slidePngs,
} from './media.mjs';

/** Files the Actions runtime needs (everything but the tests). */
export function runtimeFiles(dir = POSTER_DIR) {
  return readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
}

/** One queue item per post: what the `queue` command needs to create the draft, plus experiment metadata. */
export function buildManifestItem(post, urls, { date }) {
  return {
    id: post.id,
    date,
    series: post.series ?? null,
    variant: post.variant ?? null,
    hypothesis: post.hypothesis ?? null,
    caption: post.caption ?? '',
    hashtags: post.hashtags ?? [],
    title: buildTitle(post),
    description: buildDescription(post),
    images: urls,
    coverIndex: 0,
    slides: urls.length,
    exportedAt: new Date().toISOString(),
  };
}

/** Queue item for an animated video: the file is pulled by TikTok from the verified prefix, the caption is for the owner. */
export function buildVideoManifestItem(video, url, { date, seconds = null, bytes = null }) {
  return {
    id: video.id,
    date,
    kind: 'video',
    series: video.series ?? null,
    variant: video.variant ?? null,
    hypothesis: video.hypothesis ?? null,
    derivedFrom: video.derivedFrom ?? null,
    // Synthetic narration (Kokoro) is realistic AI audio: TikTok wants it labelled.
    aigc: Boolean(video.aigc ?? (video.voice && video.voice !== 'none')),
    caption: video.caption ?? '',
    hashtags: video.hashtags ?? [],
    title: buildTitle(video),
    description: buildDescription(video),
    video: url,
    images: [],
    slides: 0,
    seconds,
    bytes,
    exportedAt: new Date().toISOString(),
  };
}

/**
 * The rendered file of a video (out/<date>/<id>/video.mp4, .mov or .webm). A render removes the other containers; if
 * an older folder still holds several, the most recently written one is the latest render (Codex review, PR #13).
 */
export function renderedVideoFile(date, id, paths) {
  const found = ['mp4', 'mov', 'webm']
    .map((ext) => ({ file: join(paths.outDir, date, id, `video.${ext}`), ext }))
    .filter((r) => existsSync(r.file))
    .map((r) => ({ ...r, mtime: statSync(r.file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return found.length ? { file: found[0].file, ext: found[0].ext } : null;
}

/** queue/index.json: the dates that have a manifest, so the static web app can list them. */
export function writeQueueIndex(paths) {
  const dates = readdirSync(paths.queueDir)
    .map((f) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1])
    .filter(Boolean)
    .sort();
  writeJson(join(paths.queueDir, 'index.json'), { dates });
  return dates;
}

/** Writes queue/<date>.json, replacing items with the same id and keeping the others. */
export function writeManifest(paths, date, items) {
  const file = join(paths.queueDir, `${date}.json`);
  const existing = readJson(file, { date, items: [] });
  const byId = new Map(existing.items.map((it) => [it.id, it]));
  for (const it of items) byId.set(it.id, it);
  const manifest = { date, items: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  writeJson(file, manifest);
  writeQueueIndex(paths);
  return { file, manifest };
}

/**
 * True once the public state/drafts.json holds a send attempt for this item (the queue sent it or tried to). A
 * HANDED_TO_APP record is a hand-over, not a send: the item can still be withdrawn (Codex review, PR #13).
 */
export function sentFromSite(paths, id) {
  if (!paths.siteRepo) return false;
  const drafts = readJson(join(paths.siteRepo, 'state', 'drafts.json'), { drafts: [] }).drafts ?? [];
  return drafts.some((d) => d.specId === id && d.status !== HANDED_TO_APP && d.status !== RELEASED);
}

/**
 * The owner checked the TikTok inbox: the draft of an unclear send (UNKNOWN, or SENDING left by a run that died) is
 * not there. Its records become RELEASED in the public state/drafts.json, so the queue sends the item again on its next
 * run; they still count toward MAX_ATTEMPTS. Refused before RELEASE_AFTER_MS, while a draft could still arrive
 * (Codex review, PR #13).
 */
export function releaseUncertain(
  paths,
  id,
  { confirm, now = Date.now(), refresh = false, dryRun = false, env = process.env } = {},
) {
  if (confirm !== 'not_on_tiktok')
    throw new Error('release needs --confirm not_on_tiktok: check the TikTok inbox first');
  if (refresh) refreshSiteRepo(paths.siteRepo, { env });
  const file = join(paths.siteRepo, 'state', 'drafts.json');
  const state = readJson(file, { drafts: [] });
  const recs = (state.drafts ?? []).filter((d) => d.specId === id && UNCERTAIN.has(d.status));
  if (!recs.length) return { released: 0 };
  const last = Math.max(...recs.map((d) => Date.parse(d.updatedAt ?? d.createdAt ?? 0) || 0));
  if (now - last < RELEASE_AFTER_MS)
    throw new Error(
      `${id}: a draft from that send may still arrive; check the inbox again after ${new Date(last + RELEASE_AFTER_MS).toISOString().slice(11, 16)} UTC`,
    );
  if (dryRun) return { released: recs.length, dryRun: true };
  const at = new Date(now).toISOString();
  for (const d of recs) Object.assign(d, { status: RELEASED, releasedAt: at, updatedAt: at });
  writeJson(file, state);
  return { released: recs.length };
}

/**
 * Takes a not-yet-sent item out of queue/<date>.json (the owner dropped it on the review desk) and marks the video or
 * slideshow "withdrawn" in days/<date>/videos.json or slideshows.json so a later export skips it. An item whose draft was already created (it is
 * in the site's state/drafts.json) cannot be withdrawn: { sent: true } and nothing changes.
 */
export function withdrawItem(
  paths,
  date,
  id,
  {
    reason = 'dropped on the review desk',
    at = new Date(),
    dryRun = false,
    refresh = false,
    env = process.env,
  } = {},
) {
  assertDate(date);
  // The CLI refreshes first: Actions may have sent the item since the last pull (Codex review, PR #13).
  if (refresh) refreshSiteRepo(paths.siteRepo, { env });
  const file = join(paths.queueDir, `${date}.json`);
  const manifest = readJson(file, { date, items: [] });
  if (sentFromSite(paths, id)) return { sent: true, removed: false, marked: false };
  const items = manifest.items.filter((it) => it.id !== id);
  const removed = items.length !== manifest.items.length;
  if (removed && !dryRun) writeJson(file, { ...manifest, items });
  let v = null;
  for (const [name, key] of [
    ['videos.json', 'videos'],
    ['slideshows.json', 'slideshows'],
  ]) {
    const specFile = join(paths.daysDir, date, name);
    const spec = readJson(specFile, null);
    v = spec?.[key]?.find((x) => x.id === id) ?? null;
    if (!v) continue;
    if (!dryRun) {
      v.withdrawn = { reason, at: at.toISOString() };
      writeJson(specFile, spec);
    }
    break;
  }
  return { sent: false, removed, marked: Boolean(v) };
}

export function copyRuntime(paths, { dryRun = false, log = defaultLog } = {}) {
  const files = runtimeFiles();
  if (!dryRun) {
    mkdirSync(paths.toolsDir, { recursive: true });
    for (const f of files) copyFileSync(join(POSTER_DIR, f), join(paths.toolsDir, f));
  }
  log(`${dryRun ? '[dry-run] would copy' : 'Copied'} ${files.length} runtime file(s) to ${paths.toolsDir}`);
  return files;
}

/**
 * Export a day (or one id) of slideshows. With `until`, every date from `date` to `until` that has a slideshows.json
 * is exported in one commit; the queue releases each on its own date. Withdrawn posts (`withdrawn` set in the spec,
 * e.g. a paused formula) are skipped. Returns { manifest, urls } and pushes media/, queue/ and tools/ to the site repo.
 */
export async function exportDay({
  date,
  until,
  id,
  env = process.env,
  paths = defaultPaths(env),
  dryRun = false,
  log = defaultLog,
  convert = convertPngsToJpegs,
} = {}) {
  assertDate(date);
  const config = loadConfig(env);
  const dates = until ? datesBetween(date, until) : [date];
  const pairs = [];
  const byDate = new Map();
  for (const d of dates) {
    if (until && !existsSync(join(paths.daysDir, d, 'slideshows.json'))) continue;
    const day = loadDay(d, paths);
    const posts = (
      until && id ? (day.slideshows ?? []).filter((p) => p.id === id) : selectPosts(day, id)
    ).filter((p) => !p.withdrawn);
    const items = [];
    for (const post of posts) {
      if (post.factCheck?.status !== 'PASS') throw new Error(`${post.id}: fact-check is not PASS`);
      const { pngs, stale } = slidePngs(d, post, paths);
      if (stale.length)
        log.warn(`${post.id}: ignoring ${stale.length} stale PNG(s) beyond the spec's slides`);
      const { files, urls } = mediaTargets(d, post.id, pngs.length, paths.siteRepo);
      pngs.forEach((png, i) => pairs.push({ png, jpg: files[i] }));
      items.push(buildManifestItem(post, urls, { date: d }));
    }
    if (items.length) byDate.set(d, items);
  }
  const items = [...byDate.values()].flat();
  if (!items.length) throw new Error(`No slideshows to export in ${until ? `${date}..${until}` : date}`);
  if (dryRun) {
    log(
      `[dry-run] would convert ${pairs.length} PNG(s), write ${[...byDate.keys()].map((d) => `${paths.queueDir}/${d}.json`).join(', ')} with ${items.length} item(s)`,
    );
    copyRuntime(paths, { dryRun, log });
    for (const it of items) log(`  ${it.date} ${it.id}: ${it.slides} image(s), title "${it.title}"`);
    return { manifest: { date, items }, pushed: false };
  }
  checkSiteRepo(paths.siteRepo);
  const converted = await convert(pairs);
  const total = converted.reduce((s, r) => s + r.bytes, 0);
  log(`Converted ${converted.length} slide(s) to JPEG (${Math.round(total / 1024)} KB).`);
  let manifest = { date, items: [] };
  for (const [d, its] of byDate) {
    const r = writeManifest(paths, d, its);
    if (d === date) manifest = r.manifest;
    log(`Queue manifest: ${r.file} (${r.manifest.items.length} item(s) for ${d}).`);
  }
  copyRuntime(paths, { log });
  const result = commitAndPush({
    siteRepo: paths.siteRepo,
    pathspecs: ['media', 'queue', 'tools'],
    message: until
      ? `export ${date}..${until}: ${items.map((i) => i.id).join(', ')}`
      : `export ${date}: ${items.map((i) => i.id).join(', ')}`,
    githubToken: config.githubToken,
    env,
    log,
  });
  return { manifest: until ? { date, items } : manifest, ...result };
}

/** Every YYYY-MM-DD from `from` to `until` inclusive (UTC calendar arithmetic, no time zone involved). */
export function datesBetween(from, until) {
  assertDate(from);
  assertDate(until);
  const out = [];
  for (
    let d = new Date(`${from}T00:00:00Z`);
    d <= new Date(`${until}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  )
    out.push(d.toISOString().slice(0, 10));
  return out;
}

/**
 * Same hand-off as exportDay, for the animated videos of days/<date>/videos.json. With `until`, every date from `date`
 * to `until` that has a videos.json is exported in one commit; the queue releases each on its own date.
 */
export async function exportVideos({
  date,
  until,
  id,
  env = process.env,
  paths = defaultPaths(env),
  dryRun = false,
  log = defaultLog,
} = {}) {
  assertDate(date);
  const config = loadConfig(env);
  const dates = until ? datesBetween(date, until) : [date];
  const byDate = new Map();
  for (const d of dates) {
    const spec = readJson(join(paths.daysDir, d, 'videos.json'), null);
    if (!spec) continue;
    const vids = (spec.videos ?? []).filter((v) => (!id || v.id === id) && !v.withdrawn);
    if (vids.length) byDate.set(d, vids);
  }
  if (!byDate.size)
    throw new Error(
      id ? `No video ${id} in ${dates[0]}..${dates.at(-1)}` : `No videos in ${dates[0]}..${dates.at(-1)}`,
    );
  const items = [];
  const copies = [];
  for (const [d, videos] of byDate)
    for (const v of videos) {
      const date = d;
      if (v.factCheck?.status !== 'PASS') throw new Error(`${v.id}: fact-check is not PASS`);
      const rendered = renderedVideoFile(date, v.id, paths);
      if (!rendered) throw new Error(`${v.id}: no rendered video; run video/render-video.mjs first`);
      const size = statSync(rendered.file).size;
      if (size > 50 * 1024 * 1024)
        throw new Error(`${v.id}: ${Math.round(size / 1048576)} MB is over the 50 MB limit`);
      const name = `video.${rendered.ext}`;
      const seconds = (v.scenes ?? []).reduce((a, s) => a + s.dur, 0) || null;
      copies.push({ from: rendered.file, to: join(paths.siteRepo, 'media', date, v.id, name) });
      items.push(buildVideoManifestItem(v, publicUrl(date, v.id, name), { date, seconds, bytes: size }));
    }
  if (dryRun) {
    log(
      `[dry-run] would copy ${copies.length} video(s) and write ${paths.queueDir}/${date}.json with ${items.length} item(s)`,
    );
    for (const it of items)
      log(`  ${it.id}: ${it.video} (${Math.round(it.bytes / 1024)} KB, ${it.seconds}s)`);
    return { manifest: { date, items }, pushed: false };
  }
  checkSiteRepo(paths.siteRepo);
  for (const c of copies) {
    mkdirSync(join(c.to, '..'), { recursive: true });
    copyFileSync(c.from, c.to);
  }
  let manifest = null;
  for (const d of byDate.keys()) {
    const res = writeManifest(
      paths,
      d,
      items.filter((it) => it.date === d),
    );
    manifest = res.manifest;
    log(`Queue manifest: ${res.file} (${res.manifest.items.length} item(s) for ${d}).`);
  }
  copyRuntime(paths, { log });
  const span = byDate.size > 1 ? `${[...byDate.keys()][0]}..${[...byDate.keys()].at(-1)}` : date;
  const result = commitAndPush({
    siteRepo: paths.siteRepo,
    pathspecs: ['media', 'queue', 'tools'],
    message: `export ${span}: ${items.map((i) => i.id).join(', ')} (video)`,
    githubToken: config.githubToken,
    env,
    log,
  });
  return { manifest: byDate.size > 1 ? { date: span, items } : manifest, ...result };
}

/** git pull the site repo, then copy its state/*.json next to the poster for the Analyst step. */
export function pullStats({ env = process.env, paths = defaultPaths(env), log = defaultLog } = {}) {
  checkSiteRepo(paths.siteRepo);
  git(['pull', '-q', '--ff-only', 'origin', 'main'], { cwd: paths.siteRepo, env, identity: false });
  const copied = [];
  for (const name of ['stats.json', 'drafts.json']) {
    const src = join(paths.siteRepo, 'state', name);
    if (!existsSync(src)) continue;
    mkdirSync(paths.stateDir, { recursive: true });
    copyFileSync(src, join(paths.stateDir, name));
    copied.push(name);
  }
  const tokenPresent = existsSync(join(paths.siteRepo, 'state', 'token.enc'));
  log(
    `Pulled site repo. Copied ${copied.length ? copied.join(', ') : 'nothing (no state yet)'} to ${paths.stateDir}. Connected to TikTok: ${tokenPresent ? 'yes (state/token.enc present)' : 'no (run the connect workflow)'}.`,
  );
  return { copied, connected: tokenPresent };
}
