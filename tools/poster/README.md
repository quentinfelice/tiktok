# Studia Poster

Sends each day's slideshows to the owner's TikTok inbox as **photo drafts** and reads the account's **post statistics**. It uses TikTok's free official API (Login Kit, Content Posting API in `MEDIA_UPLOAD` mode, Display API `video.list`). Studia never publishes: the owner opens the draft in TikTok, adds a sound and posts.

No dependencies beyond the repo: Node 22 `fetch`, `node:crypto`, `node:fs`, `node:child_process`, and the already-installed Playwright (PNG to JPEG).

## Setup (once)

1. TikTok for Developers app "Studia": products Login Kit, Content Posting API (Direct Post off), Display API; scopes `user.info.basic,video.upload,video.list`; redirect URI `https://quentinfelice.github.io/tiktok/callback.html`; URL prefix `https://quentinfelice.github.io/tiktok/` verified; Sandbox target user = the owner's account.
2. GitHub Pages enabled on `quentinfelice/tiktok` (main, root). Clone it next to this repo: `/home/user/tiktok` (or set `STUDIA_SITE_REPO=/path/to/clone`). Pushes need working git credentials or `GITHUB_TOKEN`.
3. Environment (never in chat, git or logs): `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, optional `TIKTOK_REDIRECT_URI`, optional `TIKTOK_REFRESH_TOKEN` (only needed when there is no token cache), optional `GITHUB_TOKEN`.
4. `node departments/tiktok/poster/cli.mjs doctor` — egress to the three hosts, which variables are set (names only), token cache, `.local/` ignored, site clone, Playwright.

Tokens are cached in `.local/tiktok-token.json` (git-ignored, mode 0600). The cache is the source of truth once the refresh token has rotated.

## One-time OAuth flow

```sh
node departments/tiktok/poster/cli.mjs authorize-url        # prints the consent URL (PKCE S256, hex challenge as TikTok documents)
# The owner opens it, approves; callback.html shows a one-time code (valid a few minutes).
node departments/tiktok/poster/cli.mjs exchange <code>      # or paste the whole callback URL
node departments/tiktok/poster/cli.mjs refresh              # optional check; rotates the refresh token
```

If TikTok rejects the PKCE parameters for a web app, rerun `authorize-url --no-pkce`.

## Hand-off to GitHub Actions (the venue that reaches TikTok)

This container cannot reach TikTok, so the API calls run in GitHub Actions on `quentinfelice/tiktok`:

```sh
node departments/tiktok/poster/cli.mjs export --date 2026-09-30   # JPEGs + queue/<date>.json + tools/poster/ → push
node departments/tiktok/poster/cli.mjs pull-stats                  # next morning: state/stats.json + drafts.json back
```

In the public repo: `.github/workflows/connect.yml` (one-time OAuth, tokens encrypted with `STUDIA_TOKEN_KEY` in `state/token.enc`) and `publish.yml` (on queue push + 3× daily: `queue` → drafts, then `stats`). Owner steps: `tools/poster/README.md` there.

## Phase C: direct posting (after the TikTok audit)

Direct posts go through the Studia web app (`site/app.html`, served with the Worker in `../worker/`): the owner opens each
item, chooses who can view it, the comment, disclosure and AI-content settings, and confirms that one post, as TikTok's
Direct Post rules require. The unattended `queue` never posts directly (`STUDIA_POST_MODE=direct` is refused there), and
there is only one sender at a time: while `worker/wrangler.jsonc` in the public repo sets `POST_MODE` to `"direct"`, the
queue sends nothing and the web app is the sender (its posts are recorded in the owner's browser, not in
`state/drafts.json`). The queue then records every queued item as `HANDED_TO_APP`: back in draft mode it sends only what is
exported afterwards, never an item the owner may already have posted. Switch the mode in that file only, not in the
Cloudflare dashboard (Codex review, PR #13).
Unaudited apps get private-only direct posts; see `../AUDIT_PACK.md` for the audit.

## Daily commands (direct mode, when a machine reaches TikTok)

```sh
node departments/tiktok/poster/cli.mjs media  --date 2026-09-28 [--id 0928-5] [--prune 14] [--no-wait]
node departments/tiktok/poster/cli.mjs drafts --date 2026-09-28 [--id 0928-5] --dry-run   # print payloads only
node departments/tiktok/poster/cli.mjs drafts --check        # re-poll drafts that are not final
node departments/tiktok/poster/cli.mjs stats                 # -> departments/tiktok/poster/state/stats.json
```

- `media`: `out/<date>/<id>/NN.png` (spec slide count) -> JPEG q0.9 -> `media/<date>/<id>/NN.jpg` in the site clone, commit + push `main`, then HEAD-polls the URLs until 200 (up to 6 min).
- `drafts --dry-run`: prints, per post, the `POST /v2/post/publish/content/init/` payload the queue would send (`post_mode: MEDIA_UPLOAD`, `media_type: PHOTO`, `source: PULL_FROM_URL`, title = first caption line, max 90; description = caption + hashtags, max 4000); a post whose fact-check is not `PASS` is refused. A live `drafts` run is refused: the scheduled queue (`export`, then the publish workflow) is the only sender, since a second sender keeps its own state and could deliver a post twice. TikTok allows 5 pending API uploads per 24 h.
- `drafts --check`: re-polls `/v2/post/publish/status/fetch/` for recorded drafts that are not final and updates `state/drafts.json` (SENDING/UNKNOWN locks, hand-overs and released records have no publish id and are skipped).
- `release --id <id> --confirm not_on_tiktok`: after an unclear send (UNKNOWN), the owner says the draft is not in the TikTok inbox; the record becomes RELEASED in the public `state/drafts.json` and the queue sends the item again on its next run (attempts still count toward the limit of 3). Refused within 30 minutes of the send, while a draft could still arrive.
- `withdraw` fast-forwards the site clone first (nothing changes if that fails), refuses an item the queue already sent, and warns if the queue sent it before the withdrawal landed. A publish run already going re-reads the remote manifest just before each send (`stillQueued`), so a withdrawal pushed meanwhile stops it; only the second between that check and TikTok's answer remains.
- `media`/`export` commit only their own paths and refuse to run while something else is staged in the site clone, or while it holds local commits that are not on `origin/main`.
- `stats`: `POST /v2/video/list/?fields=id,create_time,title,video_description,share_url,view_count,like_count,comment_count,share_count`, paginated; matches posts to spec ids by publish record, else by the first caption line; writes `state/stats.json` `{fetchedAt, posts:[{specId, tiktokId, createTime, views, likes, comments, shares, shareUrl}]}`. Claude's daily run merges it into the ledger.

## What the owner still does

Open the TikTok inbox notification, choose a sound, review the caption, pick the visibility and post. Unaudited apps are documented as restricted to private viewing; whether the owner can switch a draft to "Everyone" is the open question of the live test (report it as MEASURED).

## Tests, lint

```sh
node --test departments/tiktok/poster/poster.test.mjs departments/tiktok/poster/e2e.test.mjs
npx eslint departments/tiktok/poster && npx prettier --check departments/tiktok/poster
```

Tests run offline with a mocked `fetch`; the PNG-to-JPEG test is skipped when Chromium cannot start.

`e2e.test.mjs` rehearses the two GitHub Actions workflows with the real CLI: it copies the runtime into a fresh `<base>/tiktok/tools/poster` checkout (no npm packages, no `departments/` folder), answers every call with a TikTok double, and covers `connect` (url, then exchange on a new machine), `publish` in draft mode (payload, idempotence, token refresh and rotation, the 5-pending cap, stats matching), direct mode (creator privacy gate, unaudited creator failing loudly) and running before the connection exists. It proves the code path, not TikTok's real behaviour: the live first run is still the owner's `connect`.
