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
  0002 campaigns, 0003 item_tags, 0004 notify_state, 0005 files/views/email_alerts, 0006 members.welcomed_at, 0007 hidden, 0008 copy_items/copy_campaigns, 0009 rebuilds item_status to allow the 'rejected' (No) status, 0010 copy_items.ad_path/source + copy_imports, 0011 file_ids/file_renames + comments.parent_id, 0012 copy_items.card. All keep existing data.

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

The dashboard opens with **Changes to make** (`renderChanges()` in viewDashboard): one row per
ad, sizes and versions folded by `groupAds()`, newest request first, with a preview, client,
folder, who asked and when, every comment on any size written out (timecodes, replies, done ones
dimmed), and Open the ad / "↑ Upload vN" (opens the ad page, where admin uploads the new
version) / Reply. Copy lines with changes requested are rows too (link to Ad review). Data:
`changeComments`, `changeSiblings` (files in those clients) and `copyChanges` from
`/api/admin/dashboard`. An ad whose folder already has a newer version (same `adInfo()` key,
higher version) moves to "Sent back to the client, waiting on them" and stops counting; files no
longer in the `files` table (renamed or deleted in Finder) are skipped. The count on the stat,
the heading and the client cards is ads, not files.

Top bar (`setupNav()` / `markNav()`): the logo always goes home (on the dashboard it
refreshes and scrolls to top, since the hash does not change). Admin also gets Dashboard, a
Clients menu that jumps into any client, and Admin, with the current one highlighted. The
dashboard opens with client cards showing what each is waiting on (new, change requests,
comments, approved) plus quick links to Projects, Campaigns, Ad copy and Favorites.

## Client home: Waiting on you

The top of a client's Projects page (`todoPanel()` in app.js, data from `GET /api/c/:slug/todo`)
shows what is waiting on them across every project: ads still Awaiting review (from the `files`
table plus status, hidden, views, likes and comment counts in one batch; folded by `groupAds()`, so
a v2 shows once and an older approved version does not count), new ones first, 8 tiles on a
computer and 4 on a phone with "See all N". Links to Ad review for final ads (`finalAdGroups()`
on the `Final ads/` files) and pending ad copy, a note about ads with changes requested, and the
last 3 replies from Genvyd to their comments (21 days). Admin sees the same box as "Waiting on
<client>". Files that are hidden, copy files and `_`/`.`/`@`/`#` paths are left out.

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

## Carousels

One ad made of several cards: files in the same folder named "<Ad name> card 1", "card 2"...
("slide 1" also works), each card optionally in several sizes and versions ("... card 2 4x5 v2.png").
`foldCarousels()` (called at the end of `groupAds()`, `CARD_RE`) folds two or more cards into one
entry: `_carousel` [{ n, path, item }] in card order, `_title` (name without card/size/extension),
`_paths` (every file) and `_approvePaths` (newest file of every size of every card). Tiles show a
"Carousel · N cards" chip and small card previews along the bottom of the picture (tap one to
open that card). The ad page shows "CAROUSEL · CARD 2 OF 5" and a strip of every card under the
preview (green or amber underline for approved or changes requested). Approve, Favorite, campaign
picks and Trash cover the whole carousel (`also` is capped at 60 paths in `alsoPaths()`); comments
stay on each card. `copyKey()` ignores the card number, so "<Ad name>.copy.txt" covers every card.
Rename's "All versions and sizes" works per card, not across the carousel.
Final ads carousel previews are named "<Ad name> card 2 - <Placement>.png": `finalAdGroups()` strips
the card number, keeps the newest version per placement and card, labels each shot
"Instagram Feed · card 2" and shows a "Carousel · N cards" chip.

## Rename (admin)

"Rename (admin)" in the tile "..." menu and Rename on the ad page open `openRename()` in
app.js: current name, new name with the extension locked, a choice of "All versions and sizes"
(the whole stack from `adInfo()`; each file keeps its size, placement words and version via
`stackName()`) or "Just this file", and matching thumbnails ("<video name> thumbnail ...",
`thumbsOf()`) renamed along with a video. Names already taken in the folder block the save;
`renameWarnings()` warns per `_Claude feed/file-naming-rules.md` (stops stacking, joins
another ad, size or version dropped, "final"/"edit" words, "1080p" as a size, size+version clash).

`POST /api/c/:slug/rename` takes `{ renames: [{ path, name }] }` (old `{ path, name }` still
works). All or nothing: HEAD checks every source and target, MOVEs one by one and MOVEs back
any already done if one fails, then one D1 batch moves every row in `RENAME_TABLES`
(item_status, likes, comments and replies, item_tags, activity, files, views, hidden) plus
campaign_items (added_at kept, so campaign order holds) and typed-in copy; if that batch fails
the files are moved back. Afterwards it counts rows left under the old names (`leftBehind`,
should be empty) and rewrites the Claude feed. Each file logs an admin activity row
"Renamed X to Y" (never emailed; `files.notified` moves with the file, so no new-work alert).

Stable IDs (migration 0011): `file_ids` gives every file a permanent id (filled from `files`
and `item_status`, kept up to date by `registerFiles()`); a rename moves the id to the new
path and records `file_renames(old_path -> file_id)`. `GET /api/c/:slug/where?path=` returns
where an old path lives now, and `viewItem()` redirects old links through it. The other tables
stay keyed by path (decided with Anthony): an id cannot survive a Finder rename anyway, so
renames should go through the portal.

## Comment replies

`comments.parent_id` (migration 0011). Admin "↩ Reply" on a comment (ad page and dashboard)
posts `{ path, body, parentId, resolve? }`; "Reply + mark done" also resolves the comment.
Replies always attach to the first comment of the thread, have no timecode, and are deleted
with it. Clients see replies under the comment, labelled "Genvyd" (`genvyd` flag from
`itemDetail()`), and cannot reply. The dashboard lists open comments with their replies; the
Claude feed nests them as "Reply from Genvyd" and marks answered comments "OPEN (Genvyd replied)".

## Hide and delete

Anyone on a client can Hide an ad ("..." menu or the ad page): a row in `hidden` (migration
0007), shared by the whole client, covering every size and version (`also`). Hidden ads drop
out of every list, folder previews and the dashboard; "Hidden (N)" in the toolbar shows them
with Unhide. Hides go in the email digest. Admin only: Delete a hidden ad (`POST
/api/c/:slug/delete`, refuses anything not hidden) MOVEs the file to
`_Deleted files/<client folder>/<subfolders>/` on the Synology (Worker-built destination,
`freeName`, never erased) and removes its D1 rows. Anthony empties that folder in Finder.

## No and Trash

Ads have a fourth status, `rejected`, shown as "No, not using": a No button next to Approve /
Request changes on the ad page, the "..." menu and Final ads. It is loud on purpose: solid red
pill, red outline, dimmed preview, a big NO stamp and a struck-through name on tiles, and a red
banner on the ad page with "Move to trash". Ad copy keeps its three statuses (copy_items CHECK
unchanged). In the UI, Hide is called **Trash** ("Move to trash", "Trash (N)", "Restore");
the code and the `hidden` table keep their names. Admin "Delete for good" is the old Delete.

Admin comment tools (dashboard and ad page): "Mark done" and "Mark done + move to trash".
The second (`noAndTrash()` in app.js) resolves the comment, marks the whole ad No and trashes
it, finding every size and version through `groupAds()` on the folder listing. The digest
reports "Said no", the Claude feed has a "Said no, do not use" section per client.

## Ad copy

Copy (taglines, headlines, primary text, CTAs, captions) belongs to an ad: `copy_items.ad_path`
(migration 0010). It shows under the preview on the ad page (`renderCopy()` in `viewItem`,
cards from `copyCard()`), and as a short "AD COPY" block under each tile (`tileCopy()`, data
from `copy` in the folder listing). `copyKey()` matches copy to every size and version of an
ad, the same way `groupAds()` folds them, so copy carries over to v2, v3. Routes:
`/api/c/:slug/copy[/:id/(status|edit|hide|comments|campaign|delete)]`; POST takes `adPath`.
Clients Approve / Request changes / comment / Hide and put copy in campaigns; only admin adds,
edits and deletes (hidden only). Edit keeps earlier wordings in `history`, bumps `version`,
resets to Awaiting review. Comments use path `copy:<id>`. A link to an ad path that is not a
file (a copy file's name without extension) opens the matching ad.

On the **Ad review** tab each final ad card shows its copy right under the screenshots
(`copyFor()` in `viewCopy`, with "+ Add copy" for admin, saving `adPath` "Final ads/<Ad name>").
A final ad takes copy whose `copyKey()` matches its folder and name, or failing that any copy
with the same ad name (so one copy file next to the video ad covers its screenshots too). In
`Final ads/`, `copyKey()` ignores the " - <Placement>" part. What is not shown under an ad is
listed below as "Other ad copy".

Carousel copy (migration 0012, `copy_items.card`): in a copy file, a line "Card 2" (or "## Card 2",
"Slide 2") starts that card's section and "Shared" / "All cards" ends it. Headline, Description
and Link lines get the card number; Primary text and Button (cta) always belong to the whole ad.
Kinds now include `description` and `link`. On Ad review each card's lines show as compact
`copyLine()`s under that card's first screenshot (`copyFor()` returns `{ el, perCard }`), and the
whole-ad lines below; the ad page shows the current card's lines plus the whole-ad ones. Admin
"+ Add copy" has a Card picker for carousels. Metadata lines such as "Placement shown: ..." are
ignored (`COPY_META`). The import signature is prefixed "r2|" so every copy file is read again
once with this reader; lines that already existed keep their approvals and get their card.

Copy files (how Claude and Muse import copy): save `<ad name>.copy.txt` (or `.copy.md`) in the
same folder as the ad. The name is the ad's name with or without size, version and extension
("Ponytail cap motion ad.copy.txt" covers the 9x16 and 4x5 and every version; in `Final ads/`
it is "<Ad name>.copy.txt", e.g. "Golf Polo.copy.txt", no placement). One option per
labelled line: `Headline:`, `Primary text:`, `Tagline:`, `CTA:`, `Caption:`, `Other:`; lines
without a label continue the line above (long primary text, hashtags); `Note:` adds a note to
the line above; `# headings` are ignored. `syncCopyFiles()` reads new or changed files when the
folder is opened (4 per listing) and on the 15 minute scan (2 per run); `copy_imports` keeps
size|mtime so unchanged files are not read again. `importCopyFile()`: unchanged lines keep
their approvals; a rewritten line replaces the one it rewrites (changes requested first),
keeping history and going back to Awaiting review; removed lines go unless approved or
commented. Copy files never show as files and never trigger NEW alerts. The Claude feed lists
each line with "For ad" and "From copy file" Mac paths.

## Ad review: final ads

The Ad copy tab is labelled **Ad review** (route still `#/c/:slug/copy`). Above the copy it
shows **Final ads**: screenshots of each finished ad as it will look on Facebook and
Instagram, which Muse takes from Meta Ads Manager's preview (`synology/MUSE_FINAL_ADS.md`).
They are plain files on the Synology in `<client folder>/Final ads/` (plus one level of
subfolders, shown as sections, max 12), named `<Ad name> - <Placement>.png`, versions as
`<Ad name> v2 - <Placement>.png`. `finalAdGroups()` in app.js groups by ad name, shows the
newest version's placements side by side (swipe on phones), and Approve / Request changes
post to the normal `/status` with `also`, so every placement shares one status and the
dashboard, digest and Claude feed pick them up as ordinary files. Request changes opens
the first placement's ad page for the comment. Admin gets Add screenshots (creates the
folder if needed, uploads there) and Open folder. No D1 changes.

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
  original extension kept, several at once all or nothing; see Rename), plus admin Delete, which MOVEs a hidden file into `_Deleted files/`. Admin only. A rename moves every D1 row keyed by the old
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
