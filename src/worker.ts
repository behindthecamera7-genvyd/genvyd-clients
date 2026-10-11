/**
 * Genvyd client review portal (clients.genvyd.com).
 *
 * Login:   Cloudflare Access (email one-time code) sits in front of the whole
 *          hostname. This Worker verifies the Access JWT on every request, then
 *          decides what that email may see from the `members` table.
 * Files:   Live on the Synology. A Cloudflare Tunnel exposes a read-only nginx
 *          file server at MEDIA_ORIGIN, which is itself locked behind an Access
 *          service token, so only this Worker can read it.
 * Data:    Likes, comments, approvals and the activity feed live in D1.
 */

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_EMAILS: string;
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  MEDIA_ORIGIN: string;
  MEDIA_CLIENT_ID?: string;
  MEDIA_CLIENT_SECRET?: string;
  /** Local development only (.dev.vars). Ignored whenever TEAM_DOMAIN is set. */
  DEV_EMAIL?: string;
}

type Client = { slug: string; name: string; folder: string };
type User = { email: string; admin: boolean };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const now = () => Date.now();

// ---------------------------------------------------------------------------
// Authentication (Cloudflare Access JWT)
// ---------------------------------------------------------------------------

type Jwk = JsonWebKey & { kid: string };
let certCache: { keys: Jwk[]; fetched: number } | null = null;

async function accessKeys(teamDomain: string, force = false): Promise<Jwk[]> {
  if (!force && certCache && now() - certCache.fetched < 3600_000) return certCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, "Could not reach the login service.");
  const body = (await res.json()) as { keys: Jwk[] };
  certCache = { keys: body.keys, fetched: now() };
  return body.keys;
}

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function authenticate(req: Request, env: Env): Promise<string> {
  const team = (env.TEAM_DOMAIN || "").trim();
  if (!team) {
    if (env.DEV_EMAIL) return env.DEV_EMAIL.toLowerCase();
    throw new HttpError(500, "Login is not configured yet (TEAM_DOMAIN is empty).");
  }

  const token = req.headers.get("cf-access-jwt-assertion") || readCookie(req, "CF_Authorization");
  if (!token) throw new HttpError(401, "Not signed in.");

  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "Bad login token.");
  const header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));

  let keys = await accessKeys(team);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await accessKeys(team, true); // keys rotate, refetch once
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk || header.alg !== "RS256") throw new HttpError(401, "Unknown login key.");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new HttpError(401, "Login token failed verification.");

  const aud: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.POLICY_AUD)) throw new HttpError(401, "Login token is for another app.");
  if (payload.iss !== `https://${team}`) throw new HttpError(401, "Login token issuer mismatch.");
  if (typeof payload.exp !== "number" || payload.exp * 1000 < now()) throw new HttpError(401, "Login expired.");
  if (!payload.email) throw new HttpError(401, "Login token has no email.");

  return String(payload.email).toLowerCase();
}

function isAdmin(env: Env, email: string) {
  return (env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
}

async function clientsFor(env: Env, user: User): Promise<Client[]> {
  const q = user.admin
    ? env.DB.prepare("SELECT slug, name, folder FROM clients ORDER BY name")
    : env.DB.prepare(
        "SELECT c.slug, c.name, c.folder FROM clients c JOIN members m ON m.client_slug = c.slug WHERE m.email = ? ORDER BY c.name",
      ).bind(user.email);
  return (await q.all<Client>()).results;
}

async function requireClient(env: Env, user: User, slug: string): Promise<Client> {
  const c = await env.DB.prepare("SELECT slug, name, folder FROM clients WHERE slug = ?").bind(slug).first<Client>();
  if (!c) throw new HttpError(404, "No such client.");
  if (user.admin) return c;
  const m = await env.DB.prepare("SELECT 1 FROM members WHERE client_slug = ? AND email = ?")
    .bind(slug, user.email)
    .first();
  if (!m) throw new HttpError(403, "You do not have access to this client.");
  return c;
}

// ---------------------------------------------------------------------------
// Paths and the Synology origin
// ---------------------------------------------------------------------------

/** Validates a path relative to a client folder. Returns clean segments. */
function cleanPath(p: string, allowEmpty = false): string[] {
  if (typeof p !== "string") throw new HttpError(400, "Missing path.");
  if (p.includes("\\") || p.includes("\0")) throw new HttpError(400, "Bad path.");
  const segs = p.split("/").filter((s) => s.length > 0);
  if (!allowEmpty && segs.length === 0) throw new HttpError(400, "Missing path.");
  for (const s of segs) {
    if (s === "." || s === ".." || s.startsWith(".") || s.startsWith("@") || s.startsWith("#")) {
      throw new HttpError(400, "Bad path.");
    }
  }
  return segs;
}

function originUrl(env: Env, folder: string, segs: string[], dir = false) {
  if (!env.MEDIA_ORIGIN) throw new HttpError(503, "File storage is not connected yet (MEDIA_ORIGIN is empty).");
  const base = env.MEDIA_ORIGIN.replace(/\/+$/, "");
  const all = [folder, ...segs].map(encodeURIComponent).join("/");
  return `${base}/${all}${dir ? "/" : ""}`;
}

function originHeaders(env: Env, extra: Record<string, string> = {}) {
  const h: Record<string, string> = { ...extra };
  if (env.MEDIA_CLIENT_ID && env.MEDIA_CLIENT_SECRET) {
    h["CF-Access-Client-Id"] = env.MEDIA_CLIENT_ID;
    h["CF-Access-Client-Secret"] = env.MEDIA_CLIENT_SECRET;
  }
  return h;
}

/** Turns whatever Anthony types into a safe single folder name. */
function folderName(raw: unknown): string {
  const n = String(raw ?? "")
    .replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.@#\s-]+/, "")
    .slice(0, 100)
    .trim();
  if (!n) throw new HttpError(400, "Folder name is empty.");
  return n;
}

// ---------------------------------------------------------------------------
// Writes to the Synology: one choke point, admin only.
// ---------------------------------------------------------------------------

/**
 * The ONLY place this Worker sends a write request to the Synology.
 * Clients are view-only: any non-admin session is refused here with 403
 * before anything leaves the Worker, whatever route or UI it came through.
 * Only PUT (new file) and MKCOL (new folder) exist; nobody can rename, move
 * or delete.
 */
async function nasWrite(
  env: Env,
  user: User,
  method: "PUT" | "MKCOL",
  segs: string[],
  init: { body?: ReadableStream | null; contentType?: string } = {},
): Promise<Response> {
  if (!user.admin) throw new HttpError(403, "Only Genvyd can add files or folders.");
  if (method !== "PUT" && method !== "MKCOL") throw new HttpError(403, "Not allowed.");
  if (!env.MEDIA_ORIGIN) throw new HttpError(503, "File storage is not connected yet (MEDIA_ORIGIN is empty).");
  const base = env.MEDIA_ORIGIN.replace(/\/+$/, "");
  const url = `${base}/${segs.map(encodeURIComponent).join("/")}${method === "MKCOL" ? "/" : ""}`;
  const extra: Record<string, string> = init.contentType ? { "content-type": init.contentType } : {};
  return fetch(url, { method, headers: originHeaders(env, extra), body: init.body ?? undefined });
}

/** Creates a folder on the Synology (admin only). Returns false if it was already there. */
async function makeNasFolder(env: Env, user: User, segs: string[]): Promise<boolean> {
  const res = await nasWrite(env, user, "MKCOL", segs);
  if (res.status === 201) return true;
  if (res.status === 405) return false; // already exists
  if (res.status === 409) throw new HttpError(409, "The parent folder is missing on the Synology.");
  if (res.status === 403) {
    throw new HttpError(502, "The Synology refused to create the folder. Update nginx.conf on the Synology (see synology/SYNOLOGY_UPDATE.md).");
  }
  throw new HttpError(502, `The Synology answered ${res.status} when creating the folder.`);
}

const MAX_UPLOAD = 100 * 1024 * 1024;

/** Never overwrite: "cut.mp4" becomes "cut (2).mp4" if the name is taken. */
async function freeName(env: Env, dirSegs: string[], name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    const base = env.MEDIA_ORIGIN.replace(/\/+$/, "");
    const url = `${base}/${[...dirSegs, candidate].map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, { method: "HEAD", headers: originHeaders(env) });
    if (res.status === 404) return candidate;
  }
  throw new HttpError(409, "Too many files with that name already.");
}

type NasEntry = { name: string; type: "file" | "directory"; mtime?: string; size?: number };

async function listNas(env: Env, folder: string, segs: string[]): Promise<NasEntry[]> {
  const res = await fetch(originUrl(env, folder, segs, true), {
    headers: originHeaders(env, { accept: "application/json" }),
  });
  if (res.status === 404) throw new HttpError(404, "That folder is not on the Synology.");
  if (!res.ok) throw new HttpError(502, `The Synology answered ${res.status}. Is it online?`);
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) {
    throw new HttpError(502, "The Synology did not return a folder listing. Check the tunnel and nginx setup.");
  }
  const entries = (await res.json()) as NasEntry[];
  return entries.filter((e) => !/^[.@#]/.test(e.name) && e.name !== "Thumbs.db");
}

const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
const IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;
const PDF = /\.pdf$/i;
function kindOf(name: string) {
  if (VIDEO.test(name)) return "video";
  if (IMAGE.test(name)) return "image";
  if (PDF.test(name)) return "pdf";
  return "file";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function logActivity(env: Env, slug: string, path: string, email: string, kind: string, detail: string | null) {
  await env.DB.prepare(
    "INSERT INTO activity (client_slug, path, email, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(slug, path, email, kind, detail, now())
    .run();
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Expected JSON.");
  }
}

async function listDir(env: Env, user: User, c: Client, dir: string) {
  const segs = cleanPath(dir, true);
  const entries = await listNas(env, c.folder, segs);
  const prefix = segs.length ? segs.join("/") + "/" : "";

  const folders = entries
    .filter((e) => e.type === "directory")
    .map((e) => ({ name: e.name, path: prefix + e.name, mtime: e.mtime ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const files = entries.filter((e) => e.type === "file");
  const paths = files.map((f) => prefix + f.name);

  // Pull all social data for this folder in one go.
  const like = prefix.replace(/[%_\\]/g, (m) => "\\" + m) + "%";
  const [statusRows, likeRows, commentRows] = await env.DB.batch([
    env.DB.prepare("SELECT path, status FROM item_status WHERE client_slug = ? AND path LIKE ? ESCAPE '\\'").bind(c.slug, like),
    env.DB.prepare(
      "SELECT path, COUNT(*) AS n, SUM(CASE WHEN email = ? THEN 1 ELSE 0 END) AS mine FROM likes WHERE client_slug = ? AND path LIKE ? ESCAPE '\\' GROUP BY path",
    ).bind(user.email, c.slug, like),
    env.DB.prepare(
      "SELECT path, COUNT(*) AS n, SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS open FROM comments WHERE client_slug = ? AND path LIKE ? ESCAPE '\\' GROUP BY path",
    ).bind(c.slug, like),
  ]);
  const status = new Map((statusRows.results as { path: string; status: string }[]).map((r) => [r.path, r.status]));
  const likes = new Map((likeRows.results as { path: string; n: number; mine: number }[]).map((r) => [r.path, r]));
  const comments = new Map((commentRows.results as { path: string; n: number; open: number }[]).map((r) => [r.path, r]));

  const items = files
    .map((f, i) => {
      const p = paths[i];
      return {
        name: f.name,
        path: p,
        kind: kindOf(f.name),
        size: f.size ?? null,
        mtime: f.mtime ?? null,
        status: status.get(p) ?? "pending",
        likes: likes.get(p)?.n ?? 0,
        liked: (likes.get(p)?.mine ?? 0) > 0,
        comments: comments.get(p)?.n ?? 0,
        openComments: comments.get(p)?.open ?? 0,
      };
    })
    .sort((a, b) => (b.mtime ? Date.parse(b.mtime) : 0) - (a.mtime ? Date.parse(a.mtime) : 0));

  return { client: { slug: c.slug, name: c.name }, dir: segs.join("/"), folders, items };
}

/** Ad cards for a list of paths that may span several folders (favorites, campaigns). */
async function itemsFor(env: Env, user: User, c: Client, paths: string[]) {
  // D1 allows 100 bound values per query, so look paths up in chunks.
  const out = [];
  for (let i = 0; i < paths.length; i += 90) out.push(...(await itemsChunk(env, user, c, paths.slice(i, i + 90))));
  return out;
}

async function itemsChunk(env: Env, user: User, c: Client, paths: string[]) {
  if (!paths.length) return [];
  const marks = paths.map(() => "?").join(",");
  const [statusRows, likeRows, commentRows] = await env.DB.batch([
    env.DB.prepare(`SELECT path, status FROM item_status WHERE client_slug = ? AND path IN (${marks})`).bind(c.slug, ...paths),
    env.DB.prepare(
      `SELECT path, COUNT(*) AS n, SUM(CASE WHEN email = ? THEN 1 ELSE 0 END) AS mine FROM likes WHERE client_slug = ? AND path IN (${marks}) GROUP BY path`,
    ).bind(user.email, c.slug, ...paths),
    env.DB.prepare(
      `SELECT path, COUNT(*) AS n, SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS open FROM comments WHERE client_slug = ? AND path IN (${marks}) GROUP BY path`,
    ).bind(c.slug, ...paths),
  ]);
  const status = new Map((statusRows.results as { path: string; status: string }[]).map((r) => [r.path, r.status]));
  const likes = new Map((likeRows.results as { path: string; n: number; mine: number }[]).map((r) => [r.path, r]));
  const comments = new Map((commentRows.results as { path: string; n: number; open: number }[]).map((r) => [r.path, r]));
  return paths.map((p) => {
    const name = p.split("/").pop() || p;
    return {
      name,
      path: p,
      folder: p.split("/").slice(0, -1).join("/"),
      kind: kindOf(name),
      size: null,
      mtime: null,
      status: status.get(p) ?? "pending",
      likes: likes.get(p)?.n ?? 0,
      liked: (likes.get(p)?.mine ?? 0) > 0,
      comments: comments.get(p)?.n ?? 0,
      openComments: comments.get(p)?.open ?? 0,
    };
  });
}

async function itemDetail(env: Env, user: User, c: Client, path: string) {
  const p = cleanPath(path).join("/");
  const [s, l, cm] = await env.DB.batch([
    env.DB.prepare("SELECT status, updated_by, updated_at FROM item_status WHERE client_slug = ? AND path = ?").bind(c.slug, p),
    env.DB.prepare("SELECT email FROM likes WHERE client_slug = ? AND path = ? ORDER BY created_at").bind(c.slug, p),
    env.DB.prepare(
      "SELECT id, email, body, timecode, resolved, created_at FROM comments WHERE client_slug = ? AND path = ? ORDER BY created_at",
    ).bind(c.slug, p),
  ]);
  const st = (s.results[0] as { status: string; updated_by: string; updated_at: number } | undefined) ?? null;
  const likers = (l.results as { email: string }[]).map((r) => r.email);
  return {
    path: p,
    status: st?.status ?? "pending",
    statusBy: st?.updated_by ?? null,
    statusAt: st?.updated_at ?? null,
    likes: likers.length,
    liked: likers.includes(user.email),
    likers,
    comments: (cm.results as Record<string, unknown>[]).map((r) => ({
      ...r,
      resolved: !!r.resolved,
      mine: r.email === user.email,
    })),
  };
}

async function proxyMedia(req: Request, env: Env, c: Client, segs: string[]) {
  const pass: Record<string, string> = {};
  for (const h of ["range", "if-none-match", "if-modified-since", "if-range"]) {
    const v = req.headers.get(h);
    if (v) pass[h] = v;
  }
  const res = await fetch(originUrl(env, c.folder, segs), { headers: originHeaders(env, pass) });
  if (res.status === 404) return new Response("Not found", { status: 404 });

  const out = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set("cache-control", "private, max-age=300");
  out.set("x-content-type-options", "nosniff");
  const url = new URL(req.url);
  if (url.searchParams.has("download")) {
    const name = segs[segs.length - 1];
    out.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const isApi = path.startsWith("/api/");
  const isMedia = path.startsWith("/media/");

  if (!isApi && !isMedia) return env.ASSETS.fetch(req);

  const email = await authenticate(req, env);
  const user: User = { email, admin: isAdmin(env, email) };
  const method = req.method.toUpperCase();

  // Only these methods exist on the portal. Raw WebDAV or write verbs
  // (PUT, MKCOL, MOVE, COPY, PROPPATCH, LOCK, PATCH...) are refused for everyone;
  // admin writes go through POST /api/c/:slug/upload and /folder instead.
  if (!["GET", "HEAD", "POST", "DELETE"].includes(method)) throw new HttpError(403, "Not allowed.");

  // ---- media (read only, for everyone) ------------------------------------
  if (isMedia) {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(403, "Files here are view only.");
    let rest: string[];
    try {
      rest = path.slice("/media/".length).split("/").map((s) => decodeURIComponent(s));
    } catch {
      throw new HttpError(400, "Bad path.");
    }
    const slug = rest.shift() || "";
    const c = await requireClient(env, user, slug);
    return proxyMedia(req, env, c, cleanPath(rest.join("/")));
  }

  // ---- me -----------------------------------------------------------------
  if (path === "/api/me" && method === "GET") {
    return json({ email: user.email, admin: user.admin, clients: await clientsFor(env, user) });
  }

  // ---- favorites and campaigns ------------------------------------------
  const fc = path.match(/^\/api\/c\/([^/]+)\/(favorites|campaigns)(?:\/(\d+)(?:\/(items))?)?$/);
  if (fc) {
    const [, slugRaw, kind, idStr, sub] = fc;
    const c = await requireClient(env, user, decodeURIComponent(slugRaw));

    // Favorites are the ads this person has hearted, across every project.
    if (kind === "favorites" && method === "GET") {
      const rows = (
        await env.DB.prepare("SELECT path FROM likes WHERE client_slug = ? AND email = ? ORDER BY created_at DESC")
          .bind(c.slug, user.email)
          .all<{ path: string }>()
      ).results.map((r) => r.path);
      return json({ client: { slug: c.slug, name: c.name }, items: await itemsFor(env, user, c, rows) });
    }

    if (kind === "campaigns" && !idStr && method === "GET") {
      const forPath = url.searchParams.get("path");
      const p = forPath ? cleanPath(forPath).join("/") : null;
      const rows = (
        await env.DB.prepare(
          "SELECT c.id, c.name, c.notes, c.created_at, COUNT(i.path) AS count, " +
            "MAX(CASE WHEN i.path = ? THEN 1 ELSE 0 END) AS has " +
            "FROM campaigns c LEFT JOIN campaign_items i ON i.campaign_id = c.id " +
            "WHERE c.client_slug = ? GROUP BY c.id ORDER BY c.created_at DESC",
        )
          .bind(p ?? "", c.slug)
          .all<{ id: number; name: string; notes: string | null; created_at: number; count: number; has: number }>()
      ).results.map((r) => ({ ...r, has: !!r.has }));
      return json({ client: { slug: c.slug, name: c.name }, campaigns: rows });
    }

    if (kind === "campaigns" && !idStr && method === "POST") {
      if (!user.admin) throw new HttpError(403, "Only Genvyd can create campaigns.");
      const body = await readBody(req);
      const name = String(body.name ?? "").trim().slice(0, 120);
      if (!name) throw new HttpError(400, "Campaign name is required.");
      const notes = String(body.notes ?? "").trim().slice(0, 2000) || null;
      const r = await env.DB.prepare(
        "INSERT INTO campaigns (client_slug, name, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
        .bind(c.slug, name, notes, user.email, now())
        .first<{ id: number }>();
      return json({ ok: true, id: r!.id });
    }

    if (kind === "campaigns" && idStr) {
      const camp = await env.DB.prepare("SELECT id, name, notes, created_at FROM campaigns WHERE id = ? AND client_slug = ?")
        .bind(Number(idStr), c.slug)
        .first<{ id: number; name: string; notes: string | null; created_at: number }>();
      if (!camp) throw new HttpError(404, "No such campaign.");

      if (!sub && method === "GET") {
        const rows = (
          await env.DB.prepare("SELECT path, added_by, added_at FROM campaign_items WHERE campaign_id = ? ORDER BY added_at DESC")
            .bind(camp.id)
            .all<{ path: string; added_by: string; added_at: number }>()
        ).results;
        const items = await itemsFor(env, user, c, rows.map((r) => r.path));
        const meta = new Map(rows.map((r) => [r.path, r]));
        return json({
          client: { slug: c.slug, name: c.name },
          campaign: camp,
          items: items.map((it) => ({ ...it, addedBy: meta.get(it.path)?.added_by, addedAt: meta.get(it.path)?.added_at })),
        });
      }
      if (!sub && method === "POST") {
        if (!user.admin) throw new HttpError(403, "Only Genvyd can edit campaigns.");
        const body = await readBody(req);
        const name = String(body.name ?? camp.name).trim().slice(0, 120) || camp.name;
        const notes = body.notes === undefined ? camp.notes : String(body.notes).trim().slice(0, 2000) || null;
        await env.DB.prepare("UPDATE campaigns SET name = ?, notes = ? WHERE id = ?").bind(name, notes, camp.id).run();
        return json({ ok: true });
      }
      if (!sub && method === "DELETE") {
        if (!user.admin) throw new HttpError(403, "Only Genvyd can delete campaigns.");
        // Removes the campaign list only. The ads themselves stay on the Synology.
        await env.DB.batch([
          env.DB.prepare("DELETE FROM campaign_items WHERE campaign_id = ?").bind(camp.id),
          env.DB.prepare("DELETE FROM campaigns WHERE id = ?").bind(camp.id),
        ]);
        return json({ ok: true });
      }
      if (sub === "items" && (method === "POST" || method === "DELETE")) {
        // Clients and admin can both pick ads for a campaign, approved or not.
        const p = cleanPath(String((await readBody(req)).path ?? "")).join("/");
        if (method === "POST") {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO campaign_items (campaign_id, path, added_by, added_at) VALUES (?, ?, ?, ?)",
          )
            .bind(camp.id, p, user.email, now())
            .run();
          await logActivity(env, c.slug, p, user.email, "campaign_add", camp.name);
        } else {
          await env.DB.prepare("DELETE FROM campaign_items WHERE campaign_id = ? AND path = ?").bind(camp.id, p).run();
          await logActivity(env, c.slug, p, user.email, "campaign_remove", camp.name);
        }
        return json({ ok: true });
      }
    }
    throw new HttpError(405, "Method not allowed.");
  }

  // ---- client scoped ------------------------------------------------------
  const m = path.match(/^\/api\/c\/([^/]+)\/(list|item|like|status|comments|folder|upload)(?:\/(\d+)(?:\/(resolve))?)?$/);
  if (m) {
    const [, slug, action, idStr, sub] = m;
    const c = await requireClient(env, user, decodeURIComponent(slug));

    if (action === "list" && method === "GET") {
      return json(await listDir(env, user, c, url.searchParams.get("dir") || ""));
    }
    if (action === "upload" && method === "POST") {
      if (!user.admin) throw new HttpError(403, "Only Genvyd can upload.");
      const dir = cleanPath(url.searchParams.get("dir") || "", true);
      const wanted = folderName(url.searchParams.get("name"));
      const size = Number(req.headers.get("content-length") || "0");
      if (size > MAX_UPLOAD) throw new HttpError(413, "That file is over 100 MB. Copy it in with Finder instead.");
      if (!req.body) throw new HttpError(400, "No file was sent.");
      const name = await freeName(env, [c.folder, ...dir], wanted);
      const res = await nasWrite(env, user, "PUT", [c.folder, ...dir, name], {
        body: req.body,
        contentType: req.headers.get("content-type") || "application/octet-stream",
      });
      if (res.status === 403) {
        throw new HttpError(502, "The Synology refused the upload. Update nginx.conf on the Synology (see synology/SYNOLOGY_UPDATE.md).");
      }
      if (res.status === 413) throw new HttpError(413, "The Synology says that file is too large.");
      if (res.status !== 201 && res.status !== 204) throw new HttpError(502, `The Synology answered ${res.status} to the upload.`);
      return json({ ok: true, path: [...dir, name].join("/"), renamed: name !== wanted ? name : null });
    }
    if (action === "folder" && method === "POST") {
      if (!user.admin) throw new HttpError(403, "Only Genvyd can create folders.");
      const body = await readBody(req);
      const parent = cleanPath(String(body.dir ?? ""), true);
      const name = folderName(body.name);
      const created = await makeNasFolder(env, user, [c.folder, ...parent, name]);
      return json({ ok: true, created, path: [...parent, name].join("/") });
    }
    if (action === "item" && method === "GET") {
      return json(await itemDetail(env, user, c, url.searchParams.get("path") || ""));
    }
    if (action === "like" && method === "POST") {
      const p = cleanPath(String((await readBody(req)).path ?? "")).join("/");
      const existing = await env.DB.prepare("SELECT 1 FROM likes WHERE client_slug = ? AND path = ? AND email = ?")
        .bind(c.slug, p, user.email)
        .first();
      if (existing) {
        await env.DB.prepare("DELETE FROM likes WHERE client_slug = ? AND path = ? AND email = ?").bind(c.slug, p, user.email).run();
      } else {
        await env.DB.prepare("INSERT INTO likes (client_slug, path, email, created_at) VALUES (?, ?, ?, ?)")
          .bind(c.slug, p, user.email, now())
          .run();
        await logActivity(env, c.slug, p, user.email, "like", null);
      }
      return json(await itemDetail(env, user, c, p));
    }
    if (action === "status" && method === "POST") {
      const body = await readBody(req);
      const p = cleanPath(String(body.path ?? "")).join("/");
      const status = String(body.status ?? "");
      if (!["pending", "approved", "changes"].includes(status)) throw new HttpError(400, "Bad status.");
      await env.DB.prepare(
        "INSERT INTO item_status (client_slug, path, status, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(client_slug, path) DO UPDATE SET status = excluded.status, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      )
        .bind(c.slug, p, status, user.email, now())
        .run();
      await logActivity(env, c.slug, p, user.email, status, null);
      return json(await itemDetail(env, user, c, p));
    }
    if (action === "comments" && !idStr && method === "POST") {
      const body = await readBody(req);
      const p = cleanPath(String(body.path ?? "")).join("/");
      const text = String(body.body ?? "").trim();
      if (!text) throw new HttpError(400, "Comment is empty.");
      if (text.length > 4000) throw new HttpError(400, "Comment is too long (4,000 characters max).");
      const tc = typeof body.timecode === "number" && isFinite(body.timecode) && body.timecode >= 0 ? body.timecode : null;
      await env.DB.prepare(
        "INSERT INTO comments (client_slug, path, email, body, timecode, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(c.slug, p, user.email, text, tc, now())
        .run();
      await logActivity(env, c.slug, p, user.email, "comment", text.slice(0, 280));
      return json(await itemDetail(env, user, c, p));
    }
    if (action === "comments" && idStr) {
      const row = await env.DB.prepare("SELECT id, email, path, resolved FROM comments WHERE id = ? AND client_slug = ?")
        .bind(Number(idStr), c.slug)
        .first<{ id: number; email: string; path: string; resolved: number }>();
      if (!row) throw new HttpError(404, "No such comment.");
      if (sub === "resolve" && method === "POST") {
        if (!user.admin) throw new HttpError(403, "Only Genvyd can resolve comments.");
        await env.DB.prepare("UPDATE comments SET resolved = ? WHERE id = ?").bind(row.resolved ? 0 : 1, row.id).run();
        return json(await itemDetail(env, user, c, row.path));
      }
      if (!sub && method === "DELETE") {
        if (!user.admin && row.email !== user.email) throw new HttpError(403, "You can only delete your own comments.");
        await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(row.id).run();
        return json(await itemDetail(env, user, c, row.path));
      }
    }
    throw new HttpError(405, "Method not allowed.");
  }

  // ---- admin --------------------------------------------------------------
  if (path.startsWith("/api/admin/")) {
    if (!user.admin) throw new HttpError(403, "Admins only.");

    if (path === "/api/admin/overview" && method === "GET") {
      const [clients, members, activity] = await env.DB.batch([
        env.DB.prepare("SELECT slug, name, folder FROM clients ORDER BY name"),
        env.DB.prepare("SELECT client_slug, email FROM members ORDER BY email"),
        env.DB.prepare(
          "SELECT a.id, a.client_slug, c.name AS client_name, a.path, a.email, a.kind, a.detail, a.created_at " +
            "FROM activity a LEFT JOIN clients c ON c.slug = a.client_slug ORDER BY a.created_at DESC LIMIT 100",
        ),
      ]);
      return json({ clients: clients.results, members: members.results, activity: activity.results });
    }

    if (path === "/api/admin/folders" && method === "GET") {
      if (!env.MEDIA_ORIGIN) return json({ folders: [], error: "MEDIA_ORIGIN is empty." });
      try {
        const res = await fetch(env.MEDIA_ORIGIN.replace(/\/+$/, "") + "/", {
          headers: originHeaders(env, { accept: "application/json" }),
        });
        if (!res.ok) return json({ folders: [], error: `Synology answered ${res.status}.` });
        const entries = (await res.json()) as NasEntry[];
        return json({
          folders: entries.filter((e) => e.type === "directory" && !/^[.@#]/.test(e.name)).map((e) => e.name),
        });
      } catch {
        return json({ folders: [], error: "Could not reach the Synology." });
      }
    }

    if (path === "/api/admin/clients" && method === "POST") {
      const body = await readBody(req);
      const name = String(body.name ?? "").trim();
      if (!name) throw new HttpError(400, "Client name is required.");
      // No folder picked means "make one named after the client".
      const folder = body.folder ? String(body.folder).trim() : folderName(name);
      if (!body.folder) await makeNasFolder(env, user, [folder]);
      const slug = String(body.slug ?? folder)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      cleanPath(folder); // same rules as any path segment
      if (folder.includes("/")) throw new HttpError(400, "Folder must be a single top level folder.");
      if (!SLUG.test(slug)) throw new HttpError(400, "Could not make a URL name from that folder.");
      await env.DB.prepare(
        "INSERT INTO clients (slug, name, folder, created_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(slug) DO UPDATE SET name = excluded.name, folder = excluded.folder",
      )
        .bind(slug, name, folder, now())
        .run();
      return json({ ok: true, slug });
    }

    const dc = path.match(/^\/api\/admin\/clients\/([a-z0-9-]+)$/);
    if (dc && method === "DELETE") {
      // Removes the client and its members from the portal. Files on the Synology are untouched.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM members WHERE client_slug = ?").bind(dc[1]),
        env.DB.prepare("DELETE FROM clients WHERE slug = ?").bind(dc[1]),
      ]);
      return json({ ok: true });
    }

    if (path === "/api/admin/members" && (method === "POST" || method === "DELETE")) {
      const body = await readBody(req);
      const slug = String(body.client ?? "");
      const em = String(body.email ?? "").trim().toLowerCase();
      if (!EMAIL.test(em)) throw new HttpError(400, "That does not look like an email address.");
      const exists = await env.DB.prepare("SELECT 1 FROM clients WHERE slug = ?").bind(slug).first();
      if (!exists) throw new HttpError(404, "No such client.");
      if (method === "POST") {
        await env.DB.prepare("INSERT OR IGNORE INTO members (client_slug, email, created_at) VALUES (?, ?, ?)")
          .bind(slug, em, now())
          .run();
      } else {
        await env.DB.prepare("DELETE FROM members WHERE client_slug = ? AND email = ?").bind(slug, em).run();
      }
      return json({ ok: true });
    }
  }

  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong on our side." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
