#!/usr/bin/env node
// Late views: do a post's views keep coming after its first days? A For You push is usually over in 1-3 days (the
// account's plateau froze after day 1); a post that answers a search query should keep being found. The Display API
// only gives total views, so late views are a proxy: their source (Search, For You, profile) stays UNKNOWN unless the
// owner reads the traffic-source panel in TikTok Studio. Every publish run commits state/stats.json to the public
// repo, so its git history is a time series of the Display API's cumulative views.
//   node departments/tiktok/poster/tail.mjs [--site /home/user/tiktok] [--json out.json]
// For each post: views at about 1, 3, 7 and 14 days old (first snapshot at or after that age), and late = latest views
// minus views at 3 days. MEASURED (Display API); a missing age is null, never 0.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DAY = 86400000;
export const AGES = [1, 3, 7, 14];

/** snapshots: [{ at: ISO, posts: [{ tiktokId, createTime, views, specId, title }] }] -> one row per post. */
export function tailRows(snapshots, now = Date.now()) {
  const byPost = new Map();
  for (const s of [...snapshots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    for (const p of s.posts ?? []) {
      if (!p.tiktokId || typeof p.views !== 'number') continue;
      const row = byPost.get(p.tiktokId) ?? {
        tiktokId: p.tiktokId,
        specId: p.specId ?? null,
        createTime: p.createTime,
        title: String(p.title ?? '').slice(0, 60),
        points: [],
      };
      if (p.specId) row.specId = p.specId; // the latest match wins
      row.points.push({ at: Date.parse(s.at), views: p.views });
      byPost.set(p.tiktokId, row);
    }
  }
  return [...byPost.values()]
    .map((r) => {
      const born = Date.parse(r.createTime);
      const at = (days) => r.points.find((x) => x.at - born >= days * DAY)?.views ?? null;
      const last = r.points.at(-1);
      const views = Object.fromEntries(AGES.map((d) => [`d${d}`, at(d)]));
      return {
        tiktokId: r.tiktokId,
        specId: r.specId,
        createTime: r.createTime,
        title: r.title,
        ageDays: Math.round(((now - born) / DAY) * 10) / 10,
        latest: last.views,
        ...views,
        late: views.d3 == null ? null : last.views - views.d3,
      };
    })
    .sort((a, b) => Date.parse(b.createTime) - Date.parse(a.createTime));
}

/** Every committed version of state/stats.json in the site clone. */
export function readSnapshots(site) {
  const git = (...args) =>
    execFileSync('git', ['-C', site, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const shas = git('log', '--format=%H', '--', 'state/stats.json').split('\n').filter(Boolean);
  const out = [];
  for (const sha of shas) {
    try {
      const s = JSON.parse(git('show', `${sha}:state/stats.json`));
      if (s.fetchedAt) out.push({ at: s.fetchedAt, posts: s.posts });
    } catch {
      // a commit that deleted or broke the file: skip it
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const site = resolve(opt('--site', process.env.STUDIA_SITE_REPO || '/home/user/tiktok'));
  const snaps = readSnapshots(site);
  const rows = tailRows(snaps);
  const cell = (v) => String(v ?? '-').padStart(6);
  console.log(
    `${snaps.length} snapshots of state/stats.json (MEASURED, Display API, cumulative views; source of late views UNKNOWN)`,
  );
  console.log(`${'posted'.padEnd(17)} ${'spec'.padEnd(8)}   age     d1     d3     d7    d14 latest   late`);
  for (const r of rows.filter((x) => x.createTime > '2026-09-25'))
    console.log(
      `${r.createTime.slice(0, 16)} ${String(r.specId ?? '-').padEnd(8)} ${cell(r.ageDays)} ${AGES.map((d) => cell(r[`d${d}`])).join(' ')} ${cell(r.latest)} ${cell(r.late)}`,
    );
  const json = opt('--json');
  if (json) writeFileSync(json, `${JSON.stringify({ label: 'MEASURED (Display API)', rows }, null, 2)}\n`);
}
