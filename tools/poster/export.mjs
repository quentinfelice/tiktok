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
import { buildDescription, buildTitle } from './drafts.mjs';
import {
  checkSiteRepo,
  commitAndPush,
  convertPngsToJpegs,
  git,
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

/** The rendered file of a video (out/<date>/<id>/video.mp4 or .webm). */
export function renderedVideoFile(date, id, paths) {
  for (const ext of ['mp4', 'mov', 'webm']) {
    const f = join(paths.outDir, date, id, `video.${ext}`);
    if (existsSync(f)) return { file: f, ext };
  }
  return null;
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
 * Export a day (or one id). Returns { manifest, urls } and pushes media/, queue/ and tools/ to the site repo.
 */
export async function exportDay({
  date,
  id,
  env = process.env,
  paths = defaultPaths(env),
  dryRun = false,
  log = defaultLog,
  convert = convertPngsToJpegs,
} = {}) {
  assertDate(date);
  const config = loadConfig(env);
  const day = loadDay(date, paths);
  const posts = selectPosts(day, id);
  const pairs = [];
  const items = [];
  for (const post of posts) {
    const { pngs, stale } = slidePngs(date, post, paths);
    if (stale.length) log.warn(`${post.id}: ignoring ${stale.length} stale PNG(s) beyond the spec's slides`);
    const { files, urls } = mediaTargets(date, post.id, pngs.length, paths.siteRepo);
    pngs.forEach((png, i) => pairs.push({ png, jpg: files[i] }));
    items.push(buildManifestItem(post, urls, { date }));
  }
  if (dryRun) {
    log(
      `[dry-run] would convert ${pairs.length} PNG(s), write ${paths.queueDir}/${date}.json with ${items.length} item(s)`,
    );
    copyRuntime(paths, { dryRun, log });
    for (const it of items) log(`  ${it.id}: ${it.slides} image(s), title "${it.title}"`);
    return { manifest: { date, items }, pushed: false };
  }
  checkSiteRepo(paths.siteRepo);
  const converted = await convert(pairs);
  const total = converted.reduce((s, r) => s + r.bytes, 0);
  log(`Converted ${converted.length} slide(s) to JPEG (${Math.round(total / 1024)} KB).`);
  const { file, manifest } = writeManifest(paths, date, items);
  log(`Queue manifest: ${file} (${manifest.items.length} item(s) for ${date}).`);
  copyRuntime(paths, { log });
  const result = commitAndPush({
    siteRepo: paths.siteRepo,
    pathspecs: ['media', 'queue', 'tools'],
    message: `export ${date}: ${items.map((i) => i.id).join(', ')}`,
    githubToken: config.githubToken,
    env,
    log,
  });
  return { manifest, ...result };
}

/** Same hand-off as exportDay, for the animated videos of days/<date>/videos.json. */
export async function exportVideos({
  date,
  id,
  env = process.env,
  paths = defaultPaths(env),
  dryRun = false,
  log = defaultLog,
} = {}) {
  assertDate(date);
  const config = loadConfig(env);
  const spec = readJson(join(paths.daysDir, date, 'videos.json'), null);
  if (!spec) throw new Error(`No ${join(paths.daysDir, date, 'videos.json')}`);
  const videos = (spec.videos ?? []).filter((v) => !id || v.id === id);
  if (!videos.length) throw new Error(id ? `No video ${id} on ${date}` : `No videos on ${date}`);
  const items = [];
  const copies = [];
  for (const v of videos) {
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
  const { file, manifest } = writeManifest(paths, date, items);
  log(`Queue manifest: ${file} (${manifest.items.length} item(s) for ${date}).`);
  copyRuntime(paths, { log });
  const result = commitAndPush({
    siteRepo: paths.siteRepo,
    pathspecs: ['media', 'queue', 'tools'],
    message: `export ${date}: ${items.map((i) => i.id).join(', ')} (video)`,
    githubToken: config.githubToken,
    env,
    log,
  });
  return { manifest, ...result };
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
