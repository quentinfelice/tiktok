# Studia Worker (Cloudflare) — deploy in about 10 minutes

The web app `site/app.html` cannot hold the TikTok client secret and TikTok's API does not allow browser calls. This
Worker does both jobs: it exchanges the login code and relays the few calls the app needs. Its code is
`studia-worker.mjs` (one file, no build step, no dependencies). The browser only ever holds an encrypted session that
just this Worker can open.

## Deploy from GitHub (recommended: later updates deploy by themselves)

1. Cloudflare → Workers & Pages → **Create application** → **Connect GitHub** → authorise Cloudflare on the repository
   `quentinfelice/tiktok` → select it.
2. Project name `tiktok` (it must match `name` in `wrangler.jsonc`), **Root directory** `worker`, branch `main`,
   leave the build command empty and the deploy command at its default (`npx wrangler deploy`) → **Save and deploy**.
3. Worker → **Settings → Variables and Secrets** → add the three **Secrets** only (step 3 below). `POST_MODE` and
   `SCOPES` come from `wrangler.jsonc`; changing them is a commit, not a dashboard edit.
4. Check `/health` (step 6 below).

## Deploy by pasting (owner, in the Cloudflare dashboard)

1. Workers & Pages → **Create** → **Create Worker** → name `tiktok` → **Deploy**.
2. **Edit code**: select everything, paste the content of `studia-worker.mjs`, **Deploy**.
3. **Settings → Variables and Secrets** → add, type **Secret**:
   - `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`: the Sandbox credentials of the app "Studia Drafts" (later the production ones).
   - `SESSION_KEY`: any random string of 32 characters or more (a password manager can generate it).
4. Same page, add **Variables** (type Text):
   - `POST_MODE` = `draft` (inbox drafts, works today) or `direct` (Direct Post, needed for the audit demo).
     Set the same value in `wrangler.jsonc` in the public repo: the scheduled queue reads it there and sends nothing while
     the mode is `direct`, so the app and the queue never both send.
     Direct mode also needs the `SentLock` Durable Object: add the two lines given in the comment of `wrangler.jsonc`
     (a `durable_objects` binding named `SENT_LOCK` and a `new_sqlite_classes` migration) and commit; nothing to create
     in the dashboard (SQLite-backed Durable Objects are on the Free plan). It keeps one record per posted item for
     every browser and device, so an item is never posted twice; without it the Worker refuses direct posts.
     TikTok offers no idempotent post and no way to look up an unanswered one, so an item whose post got no clear answer
     stays locked until the owner checks TikTok and presses "I checked TikTok: it is not there" (an item stuck as
     sending can be unlocked that way after 30 minutes, once any post it made would show on the profile).
   - `SCOPES` = `user.info.basic,video.upload,video.list` for `draft`; `user.info.basic,video.publish,video.list` for `direct`.
5. Copy the Worker address (`https://tiktok.<your-subdomain>.workers.dev`) and give it to the manager. It is public, not a secret. The manager puts it in `site/app-config.js` and publishes the site.
6. Check `https://tiktok.<your-subdomain>.workers.dev/health`: it must answer `{"ok":true,...}` with the mode and scopes.

Never paste a secret into a chat. Secrets live only in the Cloudflare dashboard.

## What it exposes

| Route | Purpose |
| --- | --- |
| `GET /health` | mode and scopes, no secret |
| `GET /auth/url` | the TikTok consent URL (client key, scopes, redirect `…/tiktok/callback.html`, random `state`) |
| `POST /auth/exchange` | trades the one-time code for tokens, answers with a sealed session only |
| `POST /api/creator` | `creator_info/query`: nickname, avatar, privacy options, comment setting |
| `POST /api/post` | validates and sends a photo post (`{images,title,description}`) or a video post (`{video,title}`; the title is the caption, up to 2,200 characters). `PULL_FROM_URL` from the verified prefix only. Photos: `content/init`. Videos: `video/init` in `direct` mode, `inbox/video/init` in `draft` mode |
| `POST /api/status` | `publish/status/fetch` |
| `POST /api/videos` | the account's recent posts and their four public counters |

Only the origin `https://quentinfelice.github.io` may call it. Images must be JPEG or WebP files and a video an MP4 or MOV file under
`https://quentinfelice.github.io/tiktok/`. In direct mode the requested visibility must be one TikTok offers the account,
and branded content cannot be private.

## Tests

```sh
node --test departments/tiktok/worker/worker.test.mjs   # 23 tests, fake TikTok
node --test departments/tiktok/worker/app.test.mjs      # 12 tests, Chromium against the real page, fake Worker
```

Not tested here (this container cannot reach TikTok or Cloudflare): the real TikTok responses, the real deployment, the
Sandbox login. The first live run is the owner's login in the demo recording.
