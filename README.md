# Genvyd Client Review

`clients.genvyd.com`: where Genvyd clients log in to watch cuts, look at stills,
like them, leave comments (pinned to a moment in the video), and approve or
request changes.

- Files stay on Anthony's Synology. Drop a file in the client's folder and it is live.
- Logins are email codes through Cloudflare Access. No passwords.
- Likes, comments and approvals live in Cloudflare D1.
- Hosting, login, database and tunnel all fit Cloudflare's free tiers.

Setup: see [SETUP.md](SETUP.md).
