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

## Rules

- Fail closed. Never let `DEV_EMAIL` apply when `TEAM_DOMAIN` is set.
- Paths: anything starting with `.`, `@` or `#` is hidden and rejected (`@eaDir` etc).
- The portal's only writes to the Synology are creating folders (MKCOL) and adding new
  files up to 100 MB (PUT, never overwriting; `freeName` picks "x (2).ext"). Admin only.
  nginx allows GET, HEAD, PUT and MKCOL; renames, moves and deletes are disabled there.
  Larger uploads (chunked, via a helper container) are a planned later step.
- No em-dashes anywhere. Plain language; clients are small business owners.
- Visual tokens match genvyd.com (`src/index.css` there). Accent is #ff2a2a.

## Local dev

`.dev.vars` with DEV_EMAIL, MEDIA_ORIGIN (a local file server that returns nginx-style
JSON listings), MEDIA_CLIENT_ID/SECRET. Then `npm run db:local && npm run dev`.
