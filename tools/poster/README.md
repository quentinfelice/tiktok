# Studia Poster (GitHub Actions runtime)

This folder is a copy of `departments/tiktok/poster/` from the studio repository, refreshed on every export.
Do not edit here; edit the source in the studio repo.

## How the loop works

1. The studio exports a day: JPEG slides in `media/<date>/<id>/`, a manifest in `queue/<date>.json`, this runtime in `tools/poster/`.
2. The `publish` workflow (on each queue push, and at 06:20 / 12:20 / 18:20 UTC) creates the TikTok **photo drafts** for queued items not created yet (at most 5 pending per 24 h, TikTok's cap), then reads the account's post statistics. It commits `state/drafts.json` and `state/stats.json`.
3. The owner opens the draft notification in TikTok, adds a sound and posts. Nothing is published by Studia.
4. The studio pulls `state/` back each morning to learn from the numbers.

## Owner setup (once)

1. Repository → Settings → Secrets and variables → Actions → New repository secret, three times:
   - `TIKTOK_CLIENT_KEY` — from the TikTok for Developers app "Studia"
   - `TIKTOK_CLIENT_SECRET` — same page
   - `STUDIA_TOKEN_KEY` — any long random passphrase (≥ 16 characters). It encrypts the TikTok tokens stored in `state/token.enc`.
2. Actions → **connect** → Run workflow → mode `url`. Open the printed link as the account owner and approve.
3. `callback.html` shows a one-time code. Within a few minutes: Actions → **connect** → Run workflow → mode `exchange`, paste the code. The workflow commits `state/token.enc`.
4. Done. From now on the `publish` workflow runs on its own.

Prerequisites in the TikTok portal: URL prefix `https://quentinfelice.github.io/tiktok/` verified; Sandbox with Login Kit, Content Posting API (Direct Post off), Display API; scopes `user.info.basic,video.upload,video.list`; redirect URI `https://quentinfelice.github.io/tiktok/callback.html`; the owner's account as target user.

## Switching to fully automatic publishing (after TikTok's app audit)

Settings → Secrets and variables → Actions → **Variables** → `STUDIA_POST_MODE` = `direct`. From then on `publish` posts directly
(`DIRECT_POST`, `auto_add_music`, comments on, privacy from `STUDIA_PRIVACY_LEVEL`, default public). Before the audit,
TikTok restricts direct posts of the app to private viewing, so keep `draft` until the audit passes.

Secrets never appear in logs (`::add-mask::` plus the module's own redaction). Tokens are only ever stored encrypted.
