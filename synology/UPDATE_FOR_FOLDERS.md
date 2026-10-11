# Synology update: let the portal create folders (brief for Muse)

The portal at clients.genvyd.com now creates client and project folders itself.
The Synology container needs two small changes. Do only these steps.

Ground rules: do not touch any other share, folder, file, user or permission.
Do not open ports. Do not change the tunnel token already in the compose file.

## 1. Replace nginx.conf

File Station > `docker/genvyd-portal/nginx.conf`. Replace its entire contents with:

```nginx
# File server for the Genvyd client portal.
# Root is needed only so nginx can read and write the Synology share regardless
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

      # The portal can create folders (MKCOL). It cannot upload, rename,
      # move or delete anything: those methods are simply not enabled.
      dav_methods MKCOL;
      dav_access user:rw group:rw all:rw;   # new folders stay writable from Finder
      limit_except GET HEAD MKCOL { deny all; }
    }
  }
}
```

## 2. Make the share writable for the container

Container Manager > Project > `genvyd-portal` > Stop. Then open the YAML
(Action > Edit, or the YAML tab). In the `files` service, find this line:

```
      - /volume1/GenvydClients:/srv:ro
```

and change it to (remove the `:ro` at the end):

```
      - /volume1/GenvydClients:/srv
```

Leave everything else, including `TUNNEL_TOKEN`, exactly as it is. Save.

## 3. Restart and check

1. Build / Start the project again. Both containers should be **Running**.
2. Open `genvyd-files` > Log. It should show no errors.
3. In Zero Trust > Networks > Tunnels, `genvyd-nas` should still be **Healthy**.
4. Report back to Anthony.

What this allows: nginx can now create new folders inside GenvydClients when the
portal asks. It still cannot upload, rename, move or delete anything; those are
switched off in nginx.conf.
