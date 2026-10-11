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
  0002 adds `campaigns` and `campaign_items`; 0003 adds `item_tags`. All additive.

## Roles

- Admin (`ADMIN_EMAILS`): everything, plus create folders, upload, rename files, tag ads, create/edit/delete
  campaigns, resolve comments, manage clients and logins.
- Client (members): view, play, download; favorite (the `likes` table, shown as Favorite),
  approve or request changes, comment, and add or remove any ad (approved or not) in
  campaigns Genvyd created for them. They see tags but cannot change them. No writes to
  the Synology, no creating campaigns.

## Browsing

`mediaBrowser()` in app.js powers folders, Favorites and campaign pages: Videos / Photos /
Other sections, status and tag filters, and a sort menu (remembered per browser).
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
  Larger uploads (chunked, via a helper container) are a planned later step.
- No em-dashes anywhere. Plain language; clients are small business owners.
- Visual tokens match genvyd.com (`src/index.css` there). Accent is #ff2a2a.

## Local dev

`.dev.vars` with DEV_EMAIL, MEDIA_ORIGIN (a local file server that returns nginx-style
JSON listings), MEDIA_CLIENT_ID/SECRET. Then `npm run db:local && npm run dev`.
