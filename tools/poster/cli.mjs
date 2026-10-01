#!/usr/bin/env node
// Studia Poster CLI.
// node departments/tiktok/poster/cli.mjs <authorize-url|exchange <code>|refresh|media|drafts|stats|doctor>
//   [--date YYYY-MM-DD] [--id MMDD-N] [--dry-run] [--no-wait] [--prune <days>] [--no-pkce] [--check]
//   plus export | queue | pull-stats (studio <-> GitHub Actions hand-off, see README)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  ENDPOINTS,
  ENV_NAMES,
  PUBLIC_BASE,
  REPO_ROOT,
  assertDate,
  assertId,
  defaultLog,
  defaultPaths,
  loadConfig,
  postMode,
  privacyLevel,
  redact,
  todayBrussels,
  tokenLocation,
} from './config.mjs';
import { authorizeUrl, exchangeCode, readTokenCache, refresh, tokenSummary } from './auth.mjs';
import { checkSiteRepo, publishMedia } from './media.mjs';
import { checkDrafts, runDrafts } from './drafts.mjs';
import { runStats } from './stats.mjs';
import { exportDay, exportVideos, pullStats } from './export.mjs';
import { runQueue } from './queue.mjs';

const USAGE = `Studia Poster — TikTok drafts and stats for the slideshow department

Usage: node departments/tiktok/poster/cli.mjs <command> [options]

Commands
  authorize-url        Print the TikTok consent URL (one-time setup). Options: --no-pkce
  exchange <code>      Exchange the code shown on callback.html for tokens (run within minutes)
  refresh              Refresh the access token; stores the rotated refresh token
  media                Convert the day's PNGs to JPEG, push them to the public site, wait until public
  drafts               Send the day's posts to the owner's TikTok inbox as photo drafts (runs media first)
  drafts --check       Re-poll the recorded drafts that are not final yet
  stats                Read the account's public post metrics into poster/state/stats.json
  export               Studio side: JPEGs + queue/<date>.json + runtime copy pushed to the public repo (no TikTok call)
  export --videos      Same for the rendered animated videos of days/<date>/videos.json
                       (--until YYYY-MM-DD: every date up to that day, one commit; each releases on its date)
  queue                Actions side: create the drafts for queued items not created yet (max 5 pending), then stats
  pull-stats           Studio side: git pull the public repo and copy state/stats.json + drafts.json back
  doctor               Egress, credentials, token store and repo checks (names only, never values)

Options
  --date YYYY-MM-DD    Day to process (default: today, Europe/Brussels)
  --id MMDD-N          One slideshow only (default: the whole day); videos are MMDD-VN
  --dry-run            Print payloads / planned git actions, call nothing
  --no-wait            Do not wait until the media URLs answer 200
  --prune <days>       With media: delete media/<date> folders older than <days> in the site repo
  --no-pkce            With authorize-url: plain OAuth without code_challenge
  --pages <n>          With stats: max pages of 20 posts (default 10)
`;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      date: { type: 'string' },
      id: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'no-wait': { type: 'boolean', default: false },
      prune: { type: 'string' },
      'no-pkce': { type: 'boolean', default: false },
      videos: { type: 'boolean', default: false },
      until: { type: 'string' },
      check: { type: 'boolean', default: false },
      pages: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return { values, command: positionals[0], rest: positionals.slice(1) };
}

/** GET with a short timeout; tells a proxy denial ("Host not in allowlist") apart from a server answer. */
async function probe(url, fetch = globalThis.fetch) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'Studia-Poster/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.text()).slice(0, 300);
    if (res.status === 403 && /not in allowlist|egress|proxy/i.test(body)) {
      return `BLOCKED by egress proxy (HTTP 403)`;
    }
    return `REACHABLE (HTTP ${res.status}${res.status >= 400 ? ', server answered' : ''})`;
  } catch (err) {
    const cause = err.cause?.code || err.cause?.message || err.name || 'error';
    return `UNREACHABLE (${cause})`;
  }
}

export async function doctor({
  env = process.env,
  paths = defaultPaths(env),
  fetch = globalThis.fetch,
  log = defaultLog,
} = {}) {
  const report = {
    node: process.version,
    egress: {},
    env: {},
    token: null,
    localIgnored: null,
    siteRepo: null,
    playwright: null,
  };
  log(`Node ${process.version} (need >= 22)`);
  log('Egress (MEASURED now):');
  for (const [name, url] of [
    ['open.tiktokapis.com', ENDPOINTS.oauthToken],
    ['www.tiktok.com', ENDPOINTS.authorize],
    ['quentinfelice.github.io', PUBLIC_BASE],
    ['api.github.com', 'https://api.github.com/'],
  ]) {
    report.egress[name] = await probe(url, fetch);
    log(`  ${name.padEnd(26)} ${report.egress[name]}`);
  }
  log('Environment variables (presence only):');
  for (const name of ENV_NAMES) {
    report.env[name] = Boolean(env[name]);
    log(`  ${name.padEnd(26)} ${report.env[name] ? 'set' : 'not set'}`);
  }
  const mode = postMode(env);
  log(
    `Post mode: ${mode}${mode === 'direct' ? ` (${privacyLevel(env)}, auto_add_music)` : ' (inbox drafts; set STUDIA_POST_MODE=direct after TikTok audits the app)'}`,
  );
  report.postMode = mode;
  report.token = tokenSummary(readTokenCache(paths));
  log(
    `Token store ${tokenLocation(paths)}: ${report.token.cached ? `present (access ${report.token.accessExpiresInS}s, refresh ${report.token.refreshExpiresInS}s, scope ${report.token.scope})` : 'absent'}`,
  );
  try {
    execFileSync('git', ['check-ignore', '-q', paths.tokenFile], { cwd: REPO_ROOT, stdio: 'ignore' });
    report.localIgnored = true;
  } catch {
    report.localIgnored = false;
  }
  log(
    `.local/ git-ignored: ${report.localIgnored ? 'yes' : 'NO — do not run exchange until .local/ is ignored'}`,
  );
  try {
    report.siteRepo = checkSiteRepo(paths.siteRepo);
    log(`Site repo: ${paths.siteRepo} on ${report.siteRepo.branch} -> ${report.siteRepo.remote}`);
  } catch (err) {
    report.siteRepo = { error: err.message };
    log(`Site repo: ${err.message}`);
  }
  try {
    await import('@playwright/test');
    report.playwright = true;
  } catch {
    report.playwright = false;
  }
  log(`Playwright (PNG -> JPEG): ${report.playwright ? 'available' : 'missing (npm ci)'}`);
  log(`Spec days: ${existsSync(paths.daysDir) ? 'found' : 'missing'} at ${paths.daysDir}`);
  return report;
}

export async function main(argv = process.argv.slice(2), { env = process.env, log = defaultLog } = {}) {
  const { values, command, rest } = parse(argv);
  if (values.help || !command || command === 'help') {
    log(USAGE);
    return 0;
  }
  const paths = defaultPaths(env);
  const date = values.date ? assertDate(values.date) : todayBrussels();
  const id = values.id ? assertId(values.id) : undefined;
  const wait = !values['no-wait'];
  const dryRun = values['dry-run'];
  switch (command) {
    case 'authorize-url': {
      const { url, pkce } = authorizeUrl({ env, paths, pkce: !values['no-pkce'], log });
      log(
        `Open this URL as the owner, approve, then run: node departments/tiktok/poster/cli.mjs exchange <code>${pkce ? '' : '  (PKCE off)'}`,
      );
      process.stdout.write(`${url}\n`);
      return 0;
    }
    case 'exchange': {
      const summary = await exchangeCode(rest[0], { env, paths, log });
      log(JSON.stringify(summary));
      return 0;
    }
    case 'refresh': {
      const summary = await refresh({ env, paths, log });
      log(JSON.stringify(summary));
      return 0;
    }
    case 'media': {
      const results = await publishMedia({ date, id, env, paths, wait, prune: values.prune, dryRun, log });
      for (const r of results) log(`${r.id}: ${r.urls.length} URL(s) — ${r.urls[0]} …`);
      return 0;
    }
    case 'drafts': {
      if (values.check) {
        await checkDrafts({ env, paths, log });
        return 0;
      }
      const results = await runDrafts({ date, id, dryRun, wait, env, paths, log });
      if (!dryRun) {
        for (const r of results)
          log(
            `${r.specId}: publish_id ${r.publishId} -> ${r.status}${r.failReason ? ` (${r.failReason})` : ''}`,
          );
        log(`Recorded in ${paths.draftsFile}. The owner now opens the TikTok inbox, adds a sound and posts.`);
      }
      return 0;
    }
    case 'stats': {
      const stats = await runStats({
        env,
        paths,
        log,
        maxPages: values.pages ? Number(values.pages) : undefined,
      });
      for (const p of stats.posts.slice(0, 10)) {
        log(
          `  ${(p.specId ?? '(unmatched)').padEnd(12)} ${p.createTime?.slice(0, 10) ?? '?'} views ${p.views ?? '?'} likes ${p.likes ?? '?'} comments ${p.comments ?? '?'} shares ${p.shares ?? '?'}`,
        );
      }
      return 0;
    }
    case 'export': {
      const run = values.videos ? exportVideos : exportDay;
      const until = values.until ? assertDate(values.until) : undefined;
      const { manifest, pushed } = await run({ date, until, id, env, paths, dryRun, log });
      log(`export ${date}: ${manifest.items.length} item(s)${pushed ? ', pushed to the public repo' : ''}.`);
      return 0;
    }
    case 'queue': {
      const { created, skipped, pending, scheduled } = await runQueue({ env, paths, log, dryRun });
      log(
        `queue: ${created.length} created, ${skipped.length} waiting, ${pending} pending before this run, ${scheduled.length} scheduled.`,
      );
      return 0;
    }
    case 'pull-stats': {
      pullStats({ env, paths, log });
      return 0;
    }
    case 'doctor': {
      loadConfig(env);
      await doctor({ env, paths, log });
      return 0;
    }
    default:
      log.error(`Unknown command "${command}".\n${USAGE}`);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`ERROR ${redact(err?.message ?? String(err))}\n`);
      if (process.env.STUDIA_DEBUG) process.stderr.write(`${redact(err?.stack ?? '')}\n`);
      process.exit(1);
    },
  );
}
