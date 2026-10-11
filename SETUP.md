# Setting up clients.genvyd.com

About 30 minutes, all in a browser. Do the steps in order. Anything marked
**Send to Claude** is a value Claude puts into `wrangler.jsonc` for you.

## 1. Make the client share on the Synology

1. DSM: **Control Panel → Shared Folder → Create**. Name it `GenvydClients`, on Volume 1.
2. Inside it, one folder per client, and project folders inside those:

```
GenvydClients/
  WYCOGA/
    Spring Campaign/
      Hero ad v3.mp4
      Lifestyle 01.jpg
      Older cuts/
  BidACar/
    Launch Film/
```

Clients see their project folders and every file inside, newest first.
Export review copies as **H.264 MP4**. ProRes `.mov` files will not play in a browser.

## 2. Turn on Cloudflare Zero Trust

1. Cloudflare dashboard: **Zero Trust**. Pick the Free plan (up to 50 users). Cloudflare may ask for a card to activate it, but the Free plan costs $0.
2. Choose a team name, e.g. `genvyd`. Your team domain is then `genvyd.cloudflareaccess.com`.

**Send to Claude:** the team domain.

## 3. Create the tunnel to the Synology

1. Zero Trust: **Networks → Tunnels → Create a tunnel → Cloudflared**. Name it `genvyd-nas`.
2. On the install screen choose **Docker**. In the command it shows, copy the long value after `--token`.
   Keep it private, it is a password for your tunnel.
3. Next screen, **Public hostname**:
   - Subdomain `nas-media`, Domain `genvyd.com`
   - Service type `HTTP`, URL `files:80`
4. Save.

## 4. Run the containers on the Synology

1. **Package Center**: install **Container Manager** if it is not there.
2. **File Station**: create `docker/genvyd-portal` and upload `synology/nginx.conf` from this repo into it.
3. **Container Manager → Project → Create**
   - Name `genvyd-portal`, Path `/docker/genvyd-portal`
   - Source: **Create docker-compose.yml**, paste `synology/docker-compose.yml`
   - Replace `PASTE_TUNNEL_TOKEN_HERE` with the token from step 3
4. Next, Done. Both containers should show as running, and the tunnel in Zero Trust should turn **Healthy**.

No router ports are opened. The portal can read files, create folders, add new files and rename files (your login only), but it never overwrites or deletes anything.

## 5. Lock the Synology hostname so only the portal can read it

1. Zero Trust: **Access → Service Auth → Service Tokens → Create**. Name `portal-worker`, duration Non-expiring.
   Copy the **Client ID** and **Client Secret** now (the secret is shown once).
2. **Access → Applications → Add → Self-hosted**
   - Name `Genvyd NAS media`, domain `nas-media.genvyd.com`
   - Policy: name `portal only`, Action **Service Auth**, Include **Service Token** `portal-worker`
3. Save. Opening `nas-media.genvyd.com` in your browser should now be refused. That is correct.

## 6. Create the database

1. Cloudflare dashboard: **Storage & Databases → D1 → Create**. Name `genvyd-clients`.
2. Copy the **Database ID**.

**Send to Claude:** the Database ID.

## 7. Put the login in front of clients.genvyd.com

1. Zero Trust: **Access → Applications → Add → Self-hosted**
   - Name `Genvyd Client Review`, domain `clients.genvyd.com`
   - Login method: **One-time PIN** (clients get a code by email, no passwords)
   - Policy: name `anyone with email`, Action **Allow**, Include **Everyone**
     (Anyone can request a code, but the portal only shows a client's work to the
     emails you add on the Admin page. Everyone else sees an empty screen.)
2. Save, open the app again, and copy the **Application Audience (AUD) Tag** from Overview.

**Send to Claude:** the AUD tag.

## 8. Deploy the Worker

Wait until Claude confirms the values from steps 2, 6 and 7 are pushed.

1. **Workers & Pages → Create → Import a repository** → `genvyd-clients`.
2. Deploy command: `npm run deploy` (this also sets up the database tables).
3. Deploy. `clients.genvyd.com` is created automatically from `wrangler.jsonc`.
4. Worker → **Settings → Variables and Secrets → Add**, type **Secret**:
   - `MEDIA_CLIENT_ID` = Client ID from step 5
   - `MEDIA_CLIENT_SECRET` = Client Secret from step 5

## 9. Try it

1. Open `clients.genvyd.com`, enter your Gmail, enter the code.
2. **Admin → Add a client**: type their name. A folder is created for them on the Synology (or pick an existing one).
3. **Add login**: their email. Send them the link. That is the whole onboarding.

## If something is off

| You see | Check |
|---|---|
| "Login is not configured yet" | TEAM_DOMAIN in `wrangler.jsonc` (step 2) |
| "Login token is for another app" | POLICY_AUD in `wrangler.jsonc` (step 7) |
| "The Synology answered 403" | Worker secrets from step 5, or the service token policy |
| "The Synology answered 502/530" | Containers running? Tunnel Healthy in Zero Trust? |
| Folder list empty on Admin | The share path in `docker-compose.yml` is `/volume1/GenvydClients` |
| Video shows but will not play | Re-export as H.264 MP4 |
