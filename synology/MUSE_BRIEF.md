# Genvyd client portal setup (brief for Muse)

You are setting up clients.genvyd.com for Anthony, working from his Mac mini,
which is already signed in to the Synology (DS920+, DSM 7.2.2) and can sign in
to Cloudflare. The code is already written and lives in the GitHub repo
`behindthecamera7-genvyd/genvyd-clients`. Your job is the clicking: Synology,
Cloudflare dashboard, and the final deploy.

Work through Part A, stop at the checkpoint, then do Part B once Anthony says go.

## Ground rules

- Do only what is listed. If a screen asks for something not covered here, stop and ask Anthony.
- Never enter payment details or approve a charge. If Cloudflare asks for a card to
  activate the Free Zero Trust plan, stop and ask Anthony to do that screen himself.
- On the Synology: do NOT change, move, rename or delete any existing shared folder,
  file, user, permission or package setting. Do NOT open router ports, enable
  QuickConnect, DDNS, or the DSM reverse proxy for this. Do NOT add a `ports:`
  section to the compose file. Mount the share exactly as written in the compose file.
- In Cloudflare: do NOT change or delete any existing DNS record, Worker, or
  Access application. Only create the new items below. The genvyd.com marketing
  site (Worker `genvyd-website`) must not be touched.
- Secrets: the **tunnel token** and the **service token Client Secret** are passwords.
  Paste them only into the exact places named below. Never put them in a chat
  message, a file, GitHub, or your report.

## Part A

### A1. Create the client share (Synology)

1. DSM > Control Panel > Shared Folder > Create.
2. Name `GenvydClients`, Volume 1. Encryption off. Recycle bin on. Anthony's DSM
   user gets Read/Write. No guest access.
3. Inside it create `_Example Client/Sample Project/` (empty is fine).
4. Confirm the path is `/volume1/GenvydClients`.

### A2. Turn on Cloudflare Zero Trust

1. dash.cloudflare.com > **Zero Trust**. If it is not set up yet, choose the **Free** plan.
2. Team name: `genvyd` (if taken, `genvyd-studio`).
3. Note the **team domain**: `<team name>.cloudflareaccess.com`.
4. Settings > Authentication: make sure **One-time PIN** is listed as a login method. Add it if not.

### A3. Create the tunnel

1. Zero Trust > Networks > Tunnels > **Create a tunnel** > **Cloudflared**. Name `genvyd-nas`.
2. On the install screen choose **Docker**. Copy the long value after `--token`.
   Hold it for A5 only.
3. Next, **Public hostname**: Subdomain `nas-media`, Domain `genvyd.com`,
   Service type `HTTP`, URL `files:80`. Save.

### A4. Stage the Synology config

1. Package Center: install **Container Manager** if missing.
2. File Station: in the `docker` shared folder, create `genvyd-portal`.
3. In `docker/genvyd-portal` create `nginx.conf` with exactly:

```nginx
# File server for the Genvyd client portal.
# Root is needed only so nginx can read and add to the Synology share regardless
# of its folder permissions. No port is published; only the tunnel reaches it,
# and the tunnel hostname only accepts the portal's service token.
user root;
worker_processes 2;
error_log /dev/stderr warn;
pid /tmp/nginx.pid;

events { worker_connections 256; }

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log off;
  sendfile on;
  tcp_nopush on;
  charset utf-8;
  server_tokens off;

  server {
    listen 80 default_server;
    root /srv;
    disable_symlinks on;

    # Synology and macOS housekeeping folders never leave the NAS.
    location ~ /[.@#] { return 404; }

    location / {
      autoindex on;
      autoindex_format json;   # the portal reads folder contents from this
      autoindex_exact_size on;
      add_header Cache-Control "no-cache";

      # The portal (admin login only) can create folders (MKCOL), add new files
      # (PUT, up to 100 MB) and rename files (MOVE, same folder, never
      # overwriting). It cannot delete anything: DELETE is not enabled.
      dav_methods PUT MKCOL MOVE;
      dav_access user:rw group:rw all:rw;   # new files and folders stay editable from Finder
      client_max_body_size 110m;
      limit_except GET HEAD PUT MKCOL MOVE { deny all; }
    }
  }
}
```

### A5. Run the containers (Synology)

1. Container Manager > Project > Create. Name `genvyd-portal`, Path `/docker/genvyd-portal`.
2. Source **Create docker-compose.yml**, paste exactly this, replacing
   `PASTE_TUNNEL_TOKEN_HERE` with the token from A3:

```yaml
# Genvyd client portal: Synology side.
# Container Manager > Project > Create, path /volume1/docker/genvyd-portal,
# then paste this file. See SETUP.md, step 4.
#
# Nothing here opens a port on your router. nginx is only reachable by the
# cloudflared container, and cloudflared dials out to Cloudflare.

services:
  files:
    image: nginx:1.27-alpine
    container_name: genvyd-files
    restart: unless-stopped
    volumes:
      # Your client share. Writable only so the portal can create folders;
      # nginx allows nothing but reading and making new folders.
      - /volume1/GenvydClients:/srv
      - ./nginx.conf:/etc/nginx/nginx.conf:ro

  tunnel:
    image: cloudflare/cloudflared:latest
    container_name: genvyd-tunnel
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      # Paste the token from Cloudflare Zero Trust > Networks > Tunnels.
      - TUNNEL_TOKEN=PASTE_TUNNEL_TOKEN_HERE
    depends_on:
      - files
```

3. Skip Web Station. Next, Done.
4. Check: containers `genvyd-files` and `genvyd-tunnel` are **Running**, and in
   Zero Trust > Networks > Tunnels, `genvyd-nas` shows **Healthy**.

### A6. Lock the Synology hostname to the portal

1. Zero Trust > Access > Service Auth > Service Tokens > **Create**. Name
   `portal-worker`, duration Non-expiring.
2. The Client ID and Client Secret are shown once. Keep this tab open, or keep
   them somewhere private, until B3. Do not report them.
3. Access > Applications > **Add an application** > **Self-hosted**:
   name `Genvyd NAS media`, domain `nas-media.genvyd.com`, policy name
   `portal only`, Action **Service Auth**, Include **Service Token** = `portal-worker`. Save.
4. Check: opening `https://nas-media.genvyd.com` in a browser is now refused. That is correct.

### A7. Create the database

1. Cloudflare > Storage & Databases > D1 > **Create**. Name `genvyd-clients`.
2. Note the **Database ID**.

### A8. Put the login in front of clients.genvyd.com

1. Zero Trust > Access > Applications > Add > **Self-hosted**:
   - Name `Genvyd Client Review`, domain `clients.genvyd.com`
   - Login methods: **One-time PIN** only
   - Policy name `anyone with email`, Action **Allow**, Include **Everyone**
     (The portal itself decides which client each email can see.)
2. Save, reopen it, and note the **Application Audience (AUD) Tag**.

## CHECKPOINT: report to Anthony and stop

Report exactly these three values (they are not secrets):

- Team domain (A2)
- D1 Database ID (A7)
- AUD tag (A8)

Plus: container states, tunnel status (Healthy or not), and anything that did not
go as written. Then wait. Anthony will pass the values to Claude, who updates the
code, and Anthony will tell you to continue.

## Part B (only after Anthony says go)

### B1. Connect the repo

1. Cloudflare > Workers & Pages > **Create** > **Import a repository**.
2. Pick GitHub account `behindthecamera7-genvyd`, repo `genvyd-clients`.
3. Project name `genvyd-clients`. Build command: leave empty.
   Deploy command: `npm run deploy`. Root directory: `/`.
4. Deploy. The custom domain clients.genvyd.com is created automatically.
   If the build log shows an error, copy the last 30 lines of the log for Anthony and stop.

### B2. Check the domain

Worker `genvyd-clients` > Settings > Domains & Routes should list `clients.genvyd.com`.

### B3. Add the two secrets

Worker `genvyd-clients` > Settings > Variables and Secrets > Add, type **Secret**:

- `MEDIA_CLIENT_ID` = Client ID from A6
- `MEDIA_CLIENT_SECRET` = Client Secret from A6

Save and deploy.

### B4. Test

1. Open `https://clients.genvyd.com`. Enter `behindthecamera7@gmail.com`. Anthony
   gets the code by email; ask him for it or let him finish the login.
2. Click **Admin**. The "Pick their Synology folder" list should show `_Example Client`.
   If a red Synology error shows instead, report the exact message.
3. Report back to Anthony. Do not add real clients; Anthony does that.
