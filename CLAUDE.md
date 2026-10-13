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
  0002 campaigns, 0003 item_tags, 0004 notify_state, 0005 files/views/email_alerts, 0006 members.welcomed_at, 0007 hidden, 0008 copy_items/copy_campaigns. All additive.

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

Top bar (`setupNav()` / `markNav()`): the logo always goes home (on the dashboard it
refreshes and scrolls to top, since the hash does not change). Admin also gets Dashboard, a
Clients menu that jumps into any client, and Admin, with the current one highlighted. The
dashboard opens with client cards showing what each is waiting on (new, change requests,
comments, approved) plus quick links to Projects, Campaigns, Ad copy and Favorites.

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

## Welcome email

`welcomeEmail()` / `sendWelcome()` in worker.ts. Adding a new login (`POST /api/admin/members`)
sends it automatically when client email is on (`CLIENT_NOTIFY_FROM` + `RESEND_API_KEY`),
reply-to is CLIENT_REPLY_TO (anthony@genvyd.com; new-work alerts use it too), and stamps `members.welcomed_at` (migration 0006). Admin page:
Send/Resend welcome, Copy invite (`GET /api/admin/welcome-text`, for pasting into his own
email while client email is off), and Preview welcome email (sent to NOTIFY_TO via
NOTIFY_FROM, which is `Genvyd <alerts@notify.genvyd.com>` on the Resend-verified subdomain). Steps reference Cloudflare Access's
"Send me a code" one-time PIN screen.

## Browsing

`mediaBrowser()` in app.js powers folders, Favorites and campaign pages: Videos / Photos /
Other sections, status and tag filters, a sort menu, and a Fit / Fill preview switch
(Fit = whole image, black bars, default; Fill = cropped). Choices remembered per browser.
Always render pages through `show()`, which drops null/false so they never print as text.

Project folders render as `projectCard()`: up to 3 previews, file count, NEW badge and an
Open button (from the `files` table in `listDir`, no extra Synology calls). When a folder
also has loose files, sections read "FOLDERS · TAP TO OPEN" and "ALSO IN THIS FOLDER".

Tiles (`tile()`): videos show their length (from metadata), play in place via the
play button (one at a time, with sound and native controls; counts as viewed), and every
tile has an Open button top right for the full page. The ad page has a big "Back to
<folder>" button; the router remembers list scroll positions and restores them on return.

Saving a file never navigates (that stranded the home screen app): `saveFile()` fetches it,
then uses the share sheet on phones (Photos, Files, Messages) or a blob download on computers.

Every list (folders, Favorites, campaigns, the dashboard's approved list) has "Download all N"
in its toolbar: everything currently shown after filters, all sizes of each ad, newest
versions. `saveMany()` fetches the files in the browser; phones get the share sheet with all
files (Save N Items to Photos), computers get one zip built by the small stored-zip writer
in app.js (`makeZip`, CRC32, no compression). Nothing zips on the Worker (CPU limits).

Every tile has a "..." button (`openTileMenu()`): add to or take out of any campaign (admin
can name a new campaign right there, it is created and the ad added), Favorite, Approve,
Open, Download. All of it covers every size of the ad. Popover on desktop, bottom sheet on phones.

Sizes and versions of one ad: files in the same folder whose names differ only by an aspect
ratio (9x16, 4x5, 1x1, 16:9), words like feed/stories, or a version mark (v2, rev 3, or the
"(2)" freeName adds) fold into one tile (`groupAds()` in app.js). The tile shows the newest
version with size chips and "v3 · 3 versions"; the ad page has size and version switchers and
an older-version notice. Admin "New version" on the ad page uploads "<name> vN.ext" with
`versionOf`, and the server copies tags and moves campaign picks to it (status and comments
start fresh). Files that clash (same size and version) are left apart. Approve, Favorite and
campaign picks send `also` (the other sizes) so the server applies them to every size,
logging activity once. Comments and tags stay per file. Previous/Next skip sibling sizes.

## Hide and delete

Anyone on a client can Hide an ad ("..." menu or the ad page): a row in `hidden` (migration
0007), shared by the whole client, covering every size and version (`also`). Hidden ads drop
out of every list, folder previews and the dashboard; "Hidden (N)" in the toolbar shows them
with Unhide. Hides go in the email digest. Admin only: Delete a hidden ad (`POST
/api/c/:slug/delete`, refuses anything not hidden) MOVEs the file to
`_Deleted files/<client folder>/<subfolders>/` on the Synology (Worker-built destination,
`freeName`, never erased) and removes its D1 rows. Anthony empties that folder in Finder.

## Ad copy

The "Ad copy" tab (`viewCopy()`, routes `/api/c/:slug/copy[/:id/(status|edit|hide|comments|campaign|delete)]`)
holds taglines, headlines, primary text, CTAs and captions for approval. Admin adds copy (one
line, or "each line is its own option" for up to 50) with an optional note and campaigns;
admin Edit keeps earlier wordings in `history`, bumps `version` and resets to Awaiting review.
Clients Approve / Request changes / comment / Hide and put copy in campaigns; only admin
adds, edits and deletes (hidden only). Comments live in `comments` with path `copy:<id>` so
the dashboard, resolve and digest work (`itemHref()` / `itemLink()` send those to the Copy
tab). Campaign pages list their copy with "Copy approved copy". "Copy all approved" puts
every approved line on the clipboard grouped by type, for Ads Manager. It is in the Claude feed.

## Claude feed

`writeFeed()` writes `_Claude feed/client-feedback.md` (and `.json`) on the Synology: per
client, changes requested with every comment and timecode, unanswered comments, approved ads
with campaigns, campaigns, hidden ads, last 7 days of client activity, each file with its Mac
path (`/Volumes/GenvydClients/<folder>/<path>`) and portal link. Cron `7,37 * * * *`, only
when a signature (activity id, comment counts, hidden, campaign picks) changed; Admin >
Claude feed > Update now forces it. These two files are the only ones the portal overwrites.
A Claude chat linked to the Mac reads them ("check the client feedback") and can open files.

## Backups

Portal data: `writeBackup()` exports every D1 table to JSON on the Synology in
`_Portal backups/` (cron `17 10 * * *` = 3:17 AM Phoenix, plus Admin > Backups > Back up now).
Admin can Download or Restore any backup; restore saves a "before-restore" copy first, then
replaces all tables in one batch (rows sent as JSON through `json_each`, so it stays a few
statements). The folder is hidden from the client folder picker. Cloudflare D1 Time Travel
(7 days on the free plan, wrangler only) is the second net. Files on the Synology are
protected by Snapshot Replication and Hyper Backup per `synology/BACKUP_SETUP.md`.

## Rules

- Fail closed. Never let `DEV_EMAIL` apply when `TEAM_DOMAIN` is set.
- Paths: anything starting with `.`, `@` or `#` is hidden and rejected (`@eaDir` etc).
- The portal's only writes to the Synology are creating folders (MKCOL), adding new
  files up to 100 MB (PUT, never overwriting; `freeName` picks "x (2).ext") and renaming
  files in place (MOVE, same folder, Destination built by the Worker, `Overwrite: F`,
  original extension kept), plus admin Delete, which MOVEs a hidden file into `_Deleted files/`. Admin only. A rename moves every D1 row keyed by the old
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
