# Synology setup for the Genvyd client portal (brief for Muse)

You are setting up the Synology side of clients.genvyd.com on Anthony's DS920+
(DSM 7.2.2). Do only what is listed here. Stop and ask Anthony before doing
anything not on this list.

## Ground rules

- Do NOT change, move, rename or delete any existing shared folder, file, user,
  permission, or package setting.
- Do NOT open or forward any router ports, and do NOT enable QuickConnect,
  DDNS, or the DSM reverse proxy for this. The Cloudflare Tunnel replaces all of that.
- Do NOT publish any container ports (no `ports:` section in the compose file).
- The client share is mounted READ ONLY into the containers. Keep `:ro`.
- The tunnel token is a password. Do not paste it anywhere except the compose file
  in step 3, and do not echo it back in your reply.

## Needed from Anthony before step 3

The **Cloudflare Tunnel token** (Cloudflare Zero Trust > Networks > Tunnels >
genvyd-nas, the long value after `--token`). If you do not have it, do steps 1
and 2, then stop and ask for it.

## Step 1. Create the client share

1. Control Panel > Shared Folder > Create.
2. Name `GenvydClients`, location Volume 1. Leave encryption off. Leave the
   recycle bin on. Give Anthony's own DSM user Read/Write. Do not give guests access.
3. Inside it create one example folder so the portal has something to list:
   `GenvydClients/_Example Client/Sample Project/` (empty is fine).

Confirm the path is exactly `/volume1/GenvydClients`.

## Step 2. Install Container Manager and stage the config

1. Package Center: install **Container Manager** if it is not already installed.
2. File Station: in the `docker` shared folder (Container Manager creates it),
   create the folder `genvyd-portal`.
3. In `docker/genvyd-portal`, create a file named `nginx.conf` with exactly this content:

```nginx
# Read-only file server for the Genvyd client portal.
# Root is needed only so nginx can read the Synology share regardless of its
# folder permissions. The share is mounted read only and no port is published.
user root;
worker_processes 2;
error_log /dev/stderr warn;
pid /tmp/nginx.pid;

events { worker_connections 256; }

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  types { video/mp4 m4v; }
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
    }
  }
}
```

## Step 3. Create the Container Manager project

1. Container Manager > Project > Create.
2. Project name `genvyd-portal`. Path: `/docker/genvyd-portal`.
3. Source: **Create docker-compose.yml**. Paste exactly this, then replace
   `PASTE_TUNNEL_TOKEN_HERE` with the tunnel token from Anthony:

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
      # Your client share, read only. The portal can never change or delete files.
      - /volume1/GenvydClients:/srv:ro
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

4. Skip the web portal settings (no Web Station). Next, Done. Let it pull both images and start.

## Step 4. Check it worked

1. Container Manager > Container: `genvyd-files` and `genvyd-tunnel` both **Running**.
2. Open `genvyd-tunnel` > Log. Look for a line saying it registered a tunnel
   connection. Errors mentioning an invalid token mean the token was pasted wrong.
3. Open `genvyd-files` > Log. It should be quiet. "Permission denied" means the
   share path is wrong.
4. Report back to Anthony: both container states, and the last few tunnel log
   lines with the token removed.

## Not your job

Everything in the Cloudflare dashboard (Zero Trust, tunnel hostname, Access apps,
D1, Worker deploy) is handled by Anthony and Claude. Do not log in to Cloudflare.
