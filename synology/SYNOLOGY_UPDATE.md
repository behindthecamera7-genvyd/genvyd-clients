# Synology update: folders, uploads and renaming from the portal (brief for Muse)

The portal at clients.genvyd.com can now create folders, upload files (up to
100 MB each) and rename files straight on the Synology (Anthony's login only). The Synology container needs two small
changes. Do only these steps. If you already applied an earlier version of this update, just do step 1 again
with the new nginx.conf below, then step 3. Skip step 2 if it is already done.

Ground rules: do not touch any other share, folder, file, user or permission.
Do not open ports. Do not change the tunnel token already in the compose file.

## 1. Replace nginx.conf

File Station > `docker/genvyd-portal/nginx.conf`. Replace its entire contents with:

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

## 2. Make the share writable for the container

Container Manager > Project > `genvyd-portal` > Stop. Open the YAML (Action > Edit,
or the YAML tab). In the `files` service, if you see this line:

```
      - /volume1/GenvydClients:/srv:ro
```

change it to (remove the `:ro` at the end):

```
      - /volume1/GenvydClients:/srv
```

Leave everything else, including `TUNNEL_TOKEN`, exactly as it is. Save.

## 3. Restart and check

1. Build / Start the project again. Both containers should be **Running**.
2. Open `genvyd-files` > Log. It should show no errors.
3. In Zero Trust > Networks > Tunnels, `genvyd-nas` should still be **Healthy**.
4. Report back to Anthony.

What this allows: nginx can create new folders, add new files and rename files
inside GenvydClients when the portal asks. The portal never overwrites an existing
file (uploads save "name (2).mp4"; a rename onto a taken name is refused), only
renames within the same folder, and only for Anthony's admin login. Deleting is
still switched off in nginx.conf.
