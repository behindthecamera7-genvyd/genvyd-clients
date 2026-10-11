# Genvyd client portal (clients.genvyd.com)

Client review portal for Genvyd. Separate from the marketing site (`genvyd-website`) on purpose.

## How it fits together

- `src/worker.ts`: Cloudflare Worker. Verifies the Cloudflare Access JWT on every
  `/api/*` and `/media/*` request (RS256 against the team certs, checks aud, iss, exp),
  then authorizes by email against the `members` table. `ADMIN_EMAILS` see everything.
- Files live on a Synology DS920+ (DSM 7.2) in the `GenvydClients` share. `synology/`
  holds the Container Manager project: nginx (read, folder creation, uploads) with `autoindex_format json`,
  plus cloudflared. The tunnel hostname (`MEDIA_ORIGIN`) is behind an Access service
  token, so only the Worker can read it. The Worker proxies media with Range support.
- `public/`: plain HTML, CSS, JS. No build step. Hash routing.
- `migrations/`: D1 schema. `npm run deploy` applies migrations then deploys.
  0002 campaigns, 0003 item_tags, 0004 notify_state, 0005 files/views/email_alerts. All additive.

## Roles

- Admin (`ADMIN_EMAILS`): everything, plus create folders, upload, rename files, tag ads, create/edit/delete
  campaigns, resolve comments, manage clients and logins.
- Client (members): view, play, download; favorite (the `likes` table, shown as Favorite),
  approve or request changes, comment, and add or remove any ad (approved or not) in
  campaigns Genvyd created for them. They see tags but cannot change them. No writes to
  the Synology, no creating campaigns.

## Studio dashboard

Admin home (`#/`) is `viewDashboard()`: counts for new client activity since the last
visit (per browser, `gv-last-seen`), changes requested, unanswered client comments (with
Mark done) and approved work (filter by client; sort by Most favorited / In most
campaigns). Data from `GET /api/admin/dashboard` plus `/api/admin/overview`. Clients
never see it (403, and their home goes straight to their projects).

## Email digest

Cron every 15 min (`scheduled()` in worker.ts, `runDigest`): emails client activity
(approved, changes, comment, campaign_add, like; admin actions excluded) since the last
emailed `activity.id` (stored in `notify_state`, migration 0004) via Resend
(`RESEND_API_KEY` secret, `NOTIFY_TO`, `NOTIFY_FROM`). First run only initializes, so
old history is never sent. A failed send does not advance the pointer. Comment text is
HTML-escaped. Admin page has Send test email (`POST /api/admin/notify-test`).

## New work: badges and client alerts

Migration 0005: `files` (every file seen, `notified`), `views` (who opened what),
`members.email_alerts`. Folder listings register files and prune vanished direct
children; opening an ad posts `/view`. Tiles show NEW, folder cards show "N new",
browser has a New to you / Viewed filter and Mark all viewed. Uploads and imports count
as viewed for the uploader. Cron `runClientAlerts` scans client folders on a small
budget (free plan: about 50 fetches and 50 D1 queries per run), first full scan is a
baseline (no email), waits 10 min after the last new file, then emails each client's
logins with alerts on (from `CLIENT_NOTIFY_FROM`, needs a Resend-verified domain; empty
= off, and pending files are cleared so turning it on starts fresh). Clients can switch
it off on their projects page.

## Browsing

`mediaBrowser()` in app.js powers folders, Favorites and campaign pages: Videos / Photos /
Other sections, status and tag filters, a sort menu, and a Fit / Fill preview switch
(Fit = whole image, black bars, default; Fill = cropped). Choices remembered per browser.
Always render pages through `show()`, which drops null/false so they never print as text.

## Rules

- Fail closed. Never let `DEV_EMAIL` apply when `TEAM_DOMAIN` is set.
- Paths: anything starting with `.`, `@` or `#` is hidden and rejected (`@eaDir` etc).
- The portal's only writes to the Synology are creating folders (MKCOL), adding new
  files up to 100 MB (PUT, never overwriting; `freeName` picks "x (2).ext") and renaming
  files in place (MOVE, same folder, Destination built by the Worker, `Overwrite: F`,
  original extension kept). Admin only. A rename moves every D1 row keyed by the old
  path (status, likes, comments, tags, activity, campaign picks) to the new path.
  nginx allows GET, HEAD, PUT, MKCOL and MOVE; DELETE is disabled there.
  Every Synology write goes through `nasWrite()` in worker.ts, which refuses non-admin
  sessions with 403. The router refuses any verb other than GET/HEAD/POST/DELETE (DELETE is
  only used for D1 rows like comments), and /media/* is GET/HEAD only. Clients are view-only on files.
  Admin "Import from links" (`POST /api/c/:slug/import`) streams a file from an allowed host
  (`IMPORT_HOSTS`, default Higgsfield's CDN d8j0ntlcm91z4.cloudfront.net, https only, no
  redirects followed) onto the Synology via `nasWrite` PUT, creating folders, never
  overwriting, optional tags. Same 100 MB cap.
  Larger uploads (chunked, via a helper container) are a planned later step.
- No em-dashes anywhere. Plain language; clients are small business owners.
- Visual tokens match genvyd.com (`src/index.css` there). Accent is #ff2a2a.

## Local dev

`.dev.vars` with DEV_EMAIL, MEDIA_ORIGIN (a local file server that returns nginx-style
JSON listings), MEDIA_CLIENT_ID/SECRET. Then `npm run db:local && npm run dev`.
