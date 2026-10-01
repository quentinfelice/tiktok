// Studia Poster: turn a day's rendered PNG slides into public JPEG URLs TikTok can pull.
// out/<date>/<id>/NN.png -> <siteRepo>/media/<date>/<id>/NN.jpg -> git push main -> https://quentinfelice.github.io/tiktok/media/…
// The public site repo is the verified URL prefix; only media/ is touched there.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PUBLIC_BASE, assertDate, defaultLog, defaultPaths, loadConfig, readJson } from './config.mjs';

export const JPEG_QUALITY = 0.9;
const GIT_IDENTITY = ['-c', 'user.name=Studia', '-c', 'user.email=noreply@studia.local'];

/** Loads days/<date>/slideshows.json. */
export function loadDay(date, paths = defaultPaths()) {
  assertDate(date);
  const file = join(paths.daysDir, date, 'slideshows.json');
  const day = readJson(file, null);
  if (!day) throw new Error(`No spec for ${date}: ${file}`);
  return day;
}

/** All posts of the day, or the one with `id`. */
export function selectPosts(day, id) {
  const posts = day.slideshows ?? [];
  if (!id) return posts;
  const post = posts.find((p) => p.id === id);
  if (!post)
    throw new Error(`No slideshow "${id}" in ${day.date} (have: ${posts.map((p) => p.id).join(', ')})`);
  return [post];
}

/**
 * The PNGs of one post, driven by the spec's slide count (a re-render with fewer slides leaves stale files behind).
 * Returns { pngs, stale } where stale lists PNGs beyond the slide count.
 */
export function slidePngs(date, post, paths = defaultPaths()) {
  const dir = join(paths.outDir, date, post.id);
  if (!existsSync(dir)) {
    throw new Error(
      `No rendered slides at ${dir}. Run: node departments/tiktok/render.mjs departments/tiktok/days/${date}/slideshows.json`,
    );
  }
  const count = post.slides?.length ?? 0;
  if (count < 1) throw new Error(`${post.id}: spec has no slides`);
  const pngs = [];
  for (let i = 1; i <= count; i++) {
    const file = join(dir, `${String(i).padStart(2, '0')}.png`);
    if (!existsSync(file)) throw new Error(`${post.id}: missing slide ${basename(file)}; re-render the day`);
    pngs.push(file);
  }
  const stale = readdirSync(dir)
    .filter((f) => /^\d{2}\.png$/.test(f) && Number(f.slice(0, 2)) > count)
    .map((f) => join(dir, f));
  return { pngs, stale };
}

/** Local JPEG paths inside the site clone and the matching public URLs. */
export function mediaTargets(date, id, count, siteRepo) {
  const files = [];
  const urls = [];
  for (let i = 1; i <= count; i++) {
    const name = `${String(i).padStart(2, '0')}.jpg`;
    files.push(join(siteRepo, 'media', date, id, name));
    urls.push(publicUrl(date, id, name));
  }
  return { files, urls };
}

export function publicUrl(date, id, name) {
  return `${PUBLIC_BASE}media/${date}/${id}/${name}`;
}

/**
 * PNG -> JPEG through Playwright's bundled Chromium (canvas.toDataURL). No new dependency.
 * `pairs`: [{ png, jpg }]. Returns [{ jpg, bytes }].
 */
export async function convertPngsToJpegs(pairs, { quality = JPEG_QUALITY, chromium } = {}) {
  if (!pairs.length) return [];
  const pw = chromium ?? (await import('@playwright/test')).chromium;
  const browser = await pw.launch();
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><canvas id="c"></canvas>');
    for (const { png, jpg } of pairs) {
      const b64 = readFileSync(png).toString('base64');
      const dataUrl = await page.evaluate(
        async ([src, q]) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const canvas = document.getElementById('c');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          return canvas.toDataURL('image/jpeg', q);
        },
        [`data:image/png;base64,${b64}`, quality],
      );
      const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
      mkdirSync(join(jpg, '..'), { recursive: true });
      writeFileSync(jpg, bytes);
      results.push({ jpg, bytes: bytes.length });
    }
  } finally {
    await browser.close();
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// git

export function git(args, { cwd, env = process.env, identity = true } = {}) {
  return execFileSync('git', [...(identity ? GIT_IDENTITY : []), ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Extra header auth without putting the token on a command line (`ps`-visible). Used only as a fallback. */
function tokenGitEnv(githubToken, env = process.env) {
  const basic = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export function checkSiteRepo(siteRepo) {
  if (!existsSync(join(siteRepo, '.git'))) {
    throw new Error(
      `Site repo clone not found at ${siteRepo}. Clone quentinfelice/tiktok there or set STUDIA_SITE_REPO.`,
    );
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: siteRepo, identity: false });
  if (branch !== 'main') throw new Error(`Site repo is on "${branch}", expected main`);
  return {
    siteRepo,
    branch,
    remote: git(['remote', 'get-url', 'origin'], { cwd: siteRepo, identity: false }),
  };
}

/** Stages media/, commits when there is a change, pushes main. Retries the push with GITHUB_TOKEN if it fails. */
export function commitAndPush({
  siteRepo,
  message,
  pathspecs = ['media'],
  githubToken = '',
  env = process.env,
  log = defaultLog,
  dryRun = false,
}) {
  checkSiteRepo(siteRepo);
  git(['add', '-A', '--', ...pathspecs], { cwd: siteRepo });
  const changed = git(['status', '--porcelain', '--', ...pathspecs], { cwd: siteRepo });
  let committed = false;
  if (changed) {
    if (dryRun) {
      log(`[dry-run] would commit ${changed.split('\n').length} change(s): ${message}`);
      git(['reset', '-q', '--', ...pathspecs], { cwd: siteRepo });
      return { committed: false, pushed: false };
    }
    git(['commit', '-q', '-m', message], { cwd: siteRepo });
    committed = true;
    log(`Committed: ${message}`);
  } else {
    log('Media unchanged in the site repo; nothing to commit.');
  }
  if (dryRun) return { committed, pushed: false };
  // The publish workflow commits state/ to the same branch, so a push can find main moved on: rebase this commit
  // (media/, queue/, tools/ only) on it once and push again.
  const pushOnce = (pushEnv) => {
    try {
      git(['push', '-q', 'origin', 'main'], { cwd: siteRepo, env: pushEnv });
    } catch (err) {
      if (!/fetch first|non-fast-forward/.test(String(err.stderr || err.message))) throw err;
      log.warn('The public repo moved on (a publish run committed); rebasing on it and pushing again.');
      git(['pull', '-q', '--rebase', 'origin', 'main'], { cwd: siteRepo, env: pushEnv });
      git(['push', '-q', 'origin', 'main'], { cwd: siteRepo, env: pushEnv });
    }
  };
  try {
    pushOnce(env);
  } catch (err) {
    if (!githubToken) {
      throw new Error(
        `git push failed and GITHUB_TOKEN is not set: ${String(err.stderr || err.message).trim()}`,
        { cause: err },
      );
    }
    log.warn('git push failed with the local credentials; retrying with GITHUB_TOKEN.');
    pushOnce(tokenGitEnv(githubToken, env));
  }
  log('Pushed main to origin.');
  return { committed, pushed: true };
}

/** Removes media/<date> folders older than `days` (by folder name). Returns the removed dates. */
export function pruneMedia(days, { siteRepo, today, log = defaultLog, dryRun = false } = {}) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`--prune wants a positive number of days, got "${days}"`);
  const mediaDir = join(siteRepo, 'media');
  if (!existsSync(mediaDir)) return [];
  const cutoff = new Date(`${today}T00:00:00Z`).getTime() - n * 86400000;
  const removed = [];
  for (const name of readdirSync(mediaDir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    if (new Date(`${name}T00:00:00Z`).getTime() >= cutoff) continue;
    removed.push(name);
    if (dryRun) continue;
    git(['rm', '-r', '-q', '--ignore-unmatch', '--', `media/${name}`], { cwd: siteRepo });
  }
  if (removed.length)
    log(`${dryRun ? '[dry-run] would prune' : 'Pruned'} media older than ${n} days: ${removed.join(', ')}`);
  return removed;
}

/** Polls each URL with HEAD until it answers 200 (GitHub Pages deploys take a minute or two). */
export async function waitPublic(
  urls,
  {
    fetch = globalThis.fetch,
    timeoutMs = 6 * 60 * 1000,
    intervalMs = 10 * 1000,
    sleep = defaultSleep,
    log = defaultLog,
    now = Date.now,
  } = {},
) {
  const pending = new Set(urls);
  const started = now();
  let attempt = 0;
  while (pending.size) {
    attempt++;
    for (const url of [...pending]) {
      try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow', cache: 'no-store' });
        if (res.status === 200) pending.delete(url);
      } catch {
        // not reachable yet
      }
    }
    if (!pending.size) break;
    if (now() - started >= timeoutMs) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${pending.size} URL(s): ${[...pending].join(' ')}`,
      );
    }
    log(`Waiting for GitHub Pages (${pending.size} URL(s) not public yet, attempt ${attempt})…`);
    await sleep(intervalMs);
  }
  return { attempts: attempt, elapsedMs: now() - started };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Whole media step for a day (or one id): convert, copy into the site clone, commit, push, wait.
 * Returns [{ id, urls, files }].
 */
export async function publishMedia({
  date,
  id,
  env = process.env,
  paths = defaultPaths(env),
  wait = true,
  prune,
  dryRun = false,
  fetch = globalThis.fetch,
  log = defaultLog,
  convert = convertPngsToJpegs,
  today,
} = {}) {
  const config = loadConfig(env);
  const day = loadDay(date, paths);
  const posts = selectPosts(day, id);
  const results = [];
  const pairs = [];
  for (const post of posts) {
    const { pngs, stale } = slidePngs(date, post, paths);
    if (stale.length)
      log.warn(
        `${post.id}: ignoring ${stale.length} stale PNG(s) beyond the ${pngs.length} slides in the spec`,
      );
    const { files, urls } = mediaTargets(date, post.id, pngs.length, paths.siteRepo);
    pngs.forEach((png, i) => pairs.push({ png, jpg: files[i] }));
    results.push({ id: post.id, urls, files });
  }
  if (dryRun) {
    log(
      `[dry-run] would convert ${pairs.length} PNG(s) to JPEG and push them to ${paths.siteRepo}/media/${date}/`,
    );
    return results;
  }
  const converted = await convert(pairs);
  const total = converted.reduce((s, r) => s + r.bytes, 0);
  log(
    `Converted ${converted.length} slide(s) to JPEG (${Math.round(total / 1024)} KB total, q=${JPEG_QUALITY}).`,
  );
  if (prune) pruneMedia(prune, { siteRepo: paths.siteRepo, today: today ?? date, log });
  commitAndPush({
    siteRepo: paths.siteRepo,
    message: `media ${date}: ${posts.map((p) => p.id).join(', ')}`,
    githubToken: config.githubToken,
    env,
    log,
  });
  if (wait) {
    const { elapsedMs } = await waitPublic(
      results.flatMap((r) => r.urls),
      { fetch, log },
    );
    log(`All ${pairs.length} URL(s) public after ${Math.round(elapsedMs / 1000)}s.`);
  } else {
    log('Skipping the public-URL wait (--no-wait).');
  }
  return results;
}
