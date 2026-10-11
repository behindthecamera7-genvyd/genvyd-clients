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
  NOTIFY_TO?: string;
  NOTIFY_FROM?: string;
  PORTAL_URL?: string;
  RESEND_API_KEY?: string;
  /** Sender for "new work" emails to clients. Must be on a domain verified in Resend. Empty = off. */
  CLIENT_NOTIFY_FROM?: string;
  /** Hosts the admin "Import from links" tool may download from (comma separated). */
  IMPORT_HOSTS?: string;
  /** Local testing only: point the digest at a fake email API. */
  RESEND_API_URL?: string;
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
  method: "PUT" | "MKCOL" | "MOVE",
  segs: string[],
  init: { body?: ReadableStream | null; contentType?: string; destination?: string[] } = {},
): Promise<Response> {
  if (!user.admin) throw new HttpError(403, "Only Genvyd can add, rename or organize files.");
  if (method !== "PUT" && method !== "MKCOL" && method !== "MOVE") throw new HttpError(403, "Not allowed.");
  if (!env.MEDIA_ORIGIN) throw new HttpError(503, "File storage is not connected yet (MEDIA_ORIGIN is empty).");
  const base = env.MEDIA_ORIGIN.replace(/\/+$/, "");
  const url = `${base}/${segs.map(encodeURIComponent).join("/")}${method === "MKCOL" ? "/" : ""}`;
  const extra: Record<string, string> = init.contentType ? { "content-type": init.contentType } : {};
  if (method === "MOVE") {
    // Rename only: the destination is built by the Worker, never taken from the browser,
    // and Overwrite: F makes nginx refuse to replace an existing file.
    if (!init.destination) throw new HttpError(400, "Missing new name.");
    extra["Destination"] = `${base}/${init.destination.map(encodeURIComponent).join("/")}`;
    extra["Overwrite"] = "F";
  }
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

// ---------------------------------------------------------------------------
// New / viewed tracking
// ---------------------------------------------------------------------------

async function baselineDone(env: Env, slug: string) {
  return !!(await env.DB.prepare("SELECT 1 FROM notify_state WHERE key = ?").bind(`files_baseline:${slug}`).first());
}

/** Remember files the portal has seen. Files found before a client's first scan count as old. */
async function registerFiles(env: Env, slug: string, paths: string[]) {
  if (!paths.length) return;
  const notified = (await baselineDone(env, slug)) ? 0 : 1;
  const t = now();
  for (let i = 0; i < paths.length; i += 50) {
    await env.DB.batch(
      paths.slice(i, i + 50).map((p) =>
        env.DB.prepare("INSERT OR IGNORE INTO files (client_slug, path, first_seen, notified) VALUES (?, ?, ?, ?)").bind(slug, p, t, notified),
      ),
    );
  }
}

async function markViewed(env: Env, slug: string, email: string, paths: string[]) {
  const t = now();
  for (let i = 0; i < paths.length; i += 50) {
    await env.DB.batch(
      paths.slice(i, i + 50).map((p) =>
        env.DB.prepare("INSERT OR IGNORE INTO views (client_slug, path, email, viewed_at) VALUES (?, ?, ?, ?)").bind(slug, p, email, t),
      ),
    );
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
  await registerFiles(env, c.slug, paths);

  // Pull all social data for this folder in one go.
  const like = prefix.replace(/[%_\\]/g, (m) => "\\" + m) + "%";
  const [statusRows, likeRows, commentRows, tagRows] = await env.DB.batch([
    env.DB.prepare("SELECT path, status FROM item_status WHERE client_slug = ? AND path LIKE ? ESCAPE '\\'").bind(c.slug, like),
    env.DB.prepare(
      "SELECT path, COUNT(*) AS n, SUM(CASE WHEN email = ? THEN 1 ELSE 0 END) AS mine FROM likes WHERE client_slug = ? AND path LIKE ? ESCAPE '\\' GROUP BY path",
    ).bind(user.email, c.slug, like),
    env.DB.prepare(
      "SELECT path, COUNT(*) AS n, SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS open FROM comments WHERE client_slug = ? AND path LIKE ? ESCAPE '\\' GROUP BY path",
    ).bind(c.slug, like),
    env.DB.prepare("SELECT path, tag FROM item_tags WHERE client_slug = ? AND path LIKE ? ESCAPE '\\' ORDER BY tag").bind(c.slug, like),
  ]);
  // Unviewed files under this folder (any depth), for "NEW" badges and folder counts.
  const [unseenRows, knownRows] = await env.DB.batch([
    env.DB.prepare(
      "SELECT f.path FROM files f WHERE f.client_slug = ? AND f.path LIKE ? ESCAPE '\\' " +
        "AND NOT EXISTS (SELECT 1 FROM views v WHERE v.client_slug = f.client_slug AND v.path = f.path AND v.email = ?)",
    ).bind(c.slug, like, user.email),
    env.DB.prepare("SELECT path FROM files WHERE client_slug = ? AND path LIKE ? ESCAPE '\\'").bind(c.slug, like),
  ]);
  const unseen = new Set((unseenRows.results as { path: string }[]).map((r) => r.path));
  // Forget direct children that are no longer on the Synology (deleted or renamed in Finder).
  const here = new Set(paths);
  const gone = (knownRows.results as { path: string }[])
    .map((r) => r.path)
    .filter((p) => !p.slice(prefix.length).includes("/") && !here.has(p));
  if (gone.length) {
    await env.DB.batch(gone.slice(0, 90).map((p) => env.DB.prepare("DELETE FROM files WHERE client_slug = ? AND path = ?").bind(c.slug, p)));
    gone.forEach((p) => unseen.delete(p));
  }
  for (const f of folders as { path: string; newCount?: number }[]) {
    const pre = f.path + "/";
    f.newCount = [...unseen].filter((p) => p.startsWith(pre)).length;
  }
  const tags = groupTags(tagRows.results as { path: string; tag: string }[]);
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
        tags: tags.get(p) ?? [],
        seen: !unseen.has(p),
      };
    })
    .sort((a, b) => (b.mtime ? Date.parse(b.mtime) : 0) - (a.mtime ? Date.parse(a.mtime) : 0));

  return { client: { slug: c.slug, name: c.name }, dir: segs.join("/"), folders, items };
}

/** Ad cards for a list of paths that may span several folders (favorites, campaigns). */
async function itemsFor(env: Env, user: User, c: Client, paths: string[]) {
  // D1 allows 100 bound values per query, so look paths up in chunks.
  const out = [];
  for (let i = 0; i < paths.length; i += 45) out.push(...(await itemsChunk(env, user, c, paths.slice(i, i + 45))));
  return out;
}

async function itemsChunk(env: Env, user: User, c: Client, paths: string[]) {
  if (!paths.length) return [];
  const marks = paths.map(() => "?").join(",");
  const [statusRows, likeRows, commentRows, tagRows] = await env.DB.batch([
    env.DB.prepare(`SELECT path, status FROM item_status WHERE client_slug = ? AND path IN (${marks})`).bind(c.slug, ...paths),
    env.DB.prepare(
      `SELECT path, COUNT(*) AS n, SUM(CASE WHEN email = ? THEN 1 ELSE 0 END) AS mine FROM likes WHERE client_slug = ? AND path IN (${marks}) GROUP BY path`,
    ).bind(user.email, c.slug, ...paths),
    env.DB.prepare(
      `SELECT path, COUNT(*) AS n, SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS open FROM comments WHERE client_slug = ? AND path IN (${marks}) GROUP BY path`,
    ).bind(c.slug, ...paths),
    env.DB.prepare(`SELECT path, tag FROM item_tags WHERE client_slug = ? AND path IN (${marks}) ORDER BY tag`).bind(c.slug, ...paths),
  ]);
  const viewRows = await env.DB.prepare(`SELECT path FROM views WHERE client_slug = ? AND email = ? AND path IN (${marks})`)
    .bind(c.slug, user.email, ...paths)
    .all<{ path: string }>();
  const viewed = new Set(viewRows.results.map((r) => r.path));
  const tags = groupTags(tagRows.results as { path: string; tag: string }[]);
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
      tags: tags.get(p) ?? [],
      seen: viewed.has(p),
    };
  });
}

function groupTags(rows: { path: string; tag: string }[]) {
  const m = new Map<string, string[]>();
  for (const r of rows) m.set(r.path, [...(m.get(r.path) ?? []), r.tag]);
  return m;
}

/** Tags are short, lowercase labels: "instagram", "15s", "vertical 9x16". */
function cleanTag(raw: unknown): string {
  const t = String(raw ?? "").toLowerCase().replace(/[^\p{L}\p{N} :x._+-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!t) throw new HttpError(400, "Tag is empty.");
  return t;
}

async function itemDetail(env: Env, user: User, c: Client, path: string) {
  const p = cleanPath(path).join("/");
  const [s, l, cm, tg] = await env.DB.batch([
    env.DB.prepare("SELECT status, updated_by, updated_at FROM item_status WHERE client_slug = ? AND path = ?").bind(c.slug, p),
    env.DB.prepare("SELECT email FROM likes WHERE client_slug = ? AND path = ? ORDER BY created_at").bind(c.slug, p),
    env.DB.prepare(
      "SELECT id, email, body, timecode, resolved, created_at FROM comments WHERE client_slug = ? AND path = ? ORDER BY created_at",
    ).bind(c.slug, p),
    env.DB.prepare("SELECT tag FROM item_tags WHERE client_slug = ? AND path = ? ORDER BY tag").bind(c.slug, p),
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
    tags: (tg.results as { tag: string }[]).map((r) => r.tag),
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
    const alerts = (
      await env.DB.prepare("SELECT client_slug, email_alerts FROM members WHERE email = ?").bind(user.email).all<{ client_slug: string; email_alerts: number }>()
    ).results;
    return json({
      email: user.email,
      admin: user.admin,
      clients: await clientsFor(env, user),
      alerts: Object.fromEntries(alerts.map((a) => [a.client_slug, !!a.email_alerts])),
      clientAlertsEnabled: !!(env.CLIENT_NOTIFY_FROM && env.RESEND_API_KEY),
    });
  }
  if (path === "/api/me/alerts" && method === "POST") {
    const body = await readBody(req);
    const slug = String(body.client ?? "");
    const r = await env.DB.prepare("UPDATE members SET email_alerts = ? WHERE client_slug = ? AND email = ?")
      .bind(body.on ? 1 : 0, slug, user.email)
      .run();
    if (!r.meta.changes) throw new HttpError(404, "You are not on that client's list.");
    return json({ ok: true, on: !!body.on });
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
  const m = path.match(/^\/api\/c\/([^/]+)\/(list|item|like|status|comments|folder|upload|tags|rename|import|view)(?:\/(\d+)(?:\/(resolve))?)?$/);
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
      await registerFiles(env, c.slug, [[...dir, name].join("/")]);
      await markViewed(env, c.slug, user.email, [[...dir, name].join("/")]);
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
    if (action === "view" && method === "POST") {
      // Record that this person opened these files ("New to you" turns into "Viewed").
      const body = await readBody(req);
      const list = (Array.isArray(body.paths) ? body.paths : [body.path]).slice(0, 500).map((p: unknown) => cleanPath(String(p ?? "")).join("/"));
      await markViewed(env, c.slug, user.email, list);
      return json({ ok: true, count: list.length });
    }
    if (action === "import" && method === "POST") {
      // Admin only: copy one finished file from Higgsfield's CDN straight onto the Synology.
      if (!user.admin) throw new HttpError(403, "Only Genvyd can import files.");
      const body = await readBody(req);
      let src: URL;
      try { src = new URL(String(body.url ?? "")); } catch { throw new HttpError(400, "That is not a link."); }
      const allowed = (env.IMPORT_HOSTS || "d8j0ntlcm91z4.cloudfront.net").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      const devHttp = !env.TEAM_DOMAIN && env.DEV_EMAIL && src.protocol === "http:"; // local testing only
      if ((src.protocol !== "https:" && !devHttp) || !allowed.includes(src.hostname.toLowerCase())) {
        throw new HttpError(400, `Only Higgsfield file links can be imported (${allowed.join(", ")}).`);
      }
      const dir = String(body.dir ?? "").split("/").map((x) => x.trim()).filter(Boolean).map(folderName);
      const srcName = decodeURIComponent(src.pathname.split("/").pop() || "file");
      const dot = srcName.lastIndexOf(".");
      const ext = dot > 0 ? srcName.slice(dot).toLowerCase() : "";
      let wanted = folderName(body.name || srcName);
      if (ext && !wanted.toLowerCase().endsWith(ext)) wanted += ext;

      const dl = await fetch(src.toString(), { redirect: "manual" }); // never follow a redirect off Higgsfield
      if (!dl.ok || !dl.body) throw new HttpError(502, `Higgsfield answered ${dl.status} for that link. It may have expired.`);
      const size = Number(dl.headers.get("content-length") || "0");
      if (size > MAX_UPLOAD) throw new HttpError(413, `That file is ${Math.round(size / 1e6)} MB, over the 100 MB limit. Copy it in with Finder.`);

      for (let i = 1; i <= dir.length; i++) await makeNasFolder(env, user, [c.folder, ...dir.slice(0, i)]);
      const name = await freeName(env, [c.folder, ...dir], wanted);
      const res = await nasWrite(env, user, "PUT", [c.folder, ...dir, name], {
        body: dl.body,
        contentType: dl.headers.get("content-type") || "application/octet-stream",
      });
      if (res.status === 403) {
        throw new HttpError(502, "The Synology refused the file. Update nginx.conf on the Synology (see synology/SYNOLOGY_UPDATE.md).");
      }
      if (res.status !== 201 && res.status !== 204) throw new HttpError(502, `The Synology answered ${res.status}.`);

      const path = [...dir, name].join("/");
      await registerFiles(env, c.slug, [path]);
      await markViewed(env, c.slug, user.email, [path]);
      const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags ?? "").split(","))
        .map((t: unknown) => String(t).trim())
        .filter(Boolean)
        .slice(0, 12);
      if (tags.length) {
        await env.DB.batch(
          tags.map((t: string) =>
            env.DB.prepare("INSERT OR IGNORE INTO item_tags (client_slug, path, tag, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
              .bind(c.slug, path, cleanTag(t), user.email, now()),
          ),
        );
      }
      return json({ ok: true, path, renamed: name !== wanted ? name : null });
    }
    if (action === "rename" && method === "POST") {
      if (!user.admin) throw new HttpError(403, "Only Genvyd can rename files.");
      const body = await readBody(req);
      const segs = cleanPath(String(body.path ?? ""));
      const oldName = segs[segs.length - 1];
      const dir = segs.slice(0, -1);
      // Keep the file type: "Hero cut" for "Hero ad v3.mp4" becomes "Hero cut.mp4".
      const dot = oldName.lastIndexOf(".");
      const ext = dot > 0 ? oldName.slice(dot) : "";
      let newName = folderName(body.name);
      if (ext && !newName.toLowerCase().endsWith(ext.toLowerCase())) newName += ext;
      if (newName === oldName) return json({ ok: true, path: segs.join("/") });

      const oldPath = segs.join("/");
      const newPath = [...dir, newName].join("/");
      const head = await fetch(originUrl(env, c.folder, [...dir, newName]), { method: "HEAD", headers: originHeaders(env) });
      if (head.status !== 404) throw new HttpError(409, `There is already a file called "${newName}" in this folder.`);

      const res = await nasWrite(env, user, "MOVE", [c.folder, ...segs], { destination: [c.folder, ...dir, newName] });
      if (res.status === 412) throw new HttpError(409, `There is already a file called "${newName}" in this folder.`);
      if (res.status === 404) throw new HttpError(404, "That file is no longer on the Synology.");
      if (res.status === 403 || res.status === 405) {
        throw new HttpError(502, "The Synology refused the rename. Update nginx.conf on the Synology (see synology/SYNOLOGY_UPDATE.md).");
      }
      if (res.status !== 201 && res.status !== 204) throw new HttpError(502, `The Synology answered ${res.status} to the rename.`);

      // Carry favorites, approvals, comments, tags, campaign picks and history over to the new name.
      const tables = ["item_status", "likes", "comments", "item_tags", "activity", "files", "views"];
      await env.DB.batch([
        ...tables.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE client_slug = ? AND path = ?`).bind(c.slug, newPath)),
        env.DB.prepare(
          "DELETE FROM campaign_items WHERE path = ? AND campaign_id IN (SELECT id FROM campaigns WHERE client_slug = ?)",
        ).bind(newPath, c.slug),
        ...tables.map((t) => env.DB.prepare(`UPDATE ${t} SET path = ? WHERE client_slug = ? AND path = ?`).bind(newPath, c.slug, oldPath)),
        env.DB.prepare(
          "UPDATE campaign_items SET path = ? WHERE path = ? AND campaign_id IN (SELECT id FROM campaigns WHERE client_slug = ?)",
        ).bind(newPath, oldPath, c.slug),
      ]);
      await logActivity(env, c.slug, newPath, user.email, "renamed", oldName);
      return json({ ok: true, path: newPath, name: newName });
    }
    if (action === "tags" && method === "GET") {
      // Every tag used for this client, for suggestions and filters.
      const rows = (
        await env.DB.prepare("SELECT tag, COUNT(*) AS n FROM item_tags WHERE client_slug = ? GROUP BY tag ORDER BY n DESC, tag")
          .bind(c.slug)
          .all<{ tag: string; n: number }>()
      ).results;
      return json({ tags: rows });
    }
    if (action === "tags" && (method === "POST" || method === "DELETE")) {
      if (!user.admin) throw new HttpError(403, "Only Genvyd can tag ads.");
      const body = await readBody(req);
      const p = cleanPath(String(body.path ?? "")).join("/");
      const tag = cleanTag(body.tag);
      if (method === "POST") {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO item_tags (client_slug, path, tag, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
        )
          .bind(c.slug, p, tag, user.email, now())
          .run();
      } else {
        await env.DB.prepare("DELETE FROM item_tags WHERE client_slug = ? AND path = ? AND tag = ?").bind(c.slug, p, tag).run();
      }
      return json(await itemDetail(env, user, c, p));
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

    if (path === "/api/admin/notify-test" && method === "POST") {
      await sendEmail(
        env,
        "Test from clients.genvyd.com",
        `<div style="font-family:Arial,Helvetica,sans-serif"><p>Email from your client portal is working.</p><p>You will get a short summary here whenever clients approve, request changes, comment, favorite or pick ads for a campaign, at most every 15 minutes.</p></div>`,
        "Email from your client portal is working.",
      );
      return json({ ok: true, to: env.NOTIFY_TO || env.ADMIN_EMAILS });
    }
    if (path === "/api/admin/welcome-preview" && method === "POST") {
      // Sends a sample welcome email to Anthony (works before client email is switched on).
      const body = await readBody(req);
      const c = await env.DB.prepare("SELECT name FROM clients WHERE slug = ?").bind(String(body.client ?? "")).first<{ name: string }>();
      const w = welcomeEmail(env, c?.name || "Your Company", "client@theircompany.com");
      await sendEmail(env, `[Preview] ${w.subject}`, w.html, w.text);
      return json({ ok: true, to: env.NOTIFY_TO || env.ADMIN_EMAILS });
    }
    if (path === "/api/admin/welcome-text" && method === "GET") {
      // Plain-text version Anthony can paste into his own email.
      const slug = url.searchParams.get("client") || "";
      const em = (url.searchParams.get("email") || "").toLowerCase();
      const c = await env.DB.prepare("SELECT name FROM clients WHERE slug = ?").bind(slug).first<{ name: string }>();
      if (!c) throw new HttpError(404, "No such client.");
      const w = welcomeEmail(env, c.name, em || "your email");
      return json({ subject: w.subject, text: w.text });
    }
    if (path === "/api/admin/notify-status" && method === "GET") {
      return json({
        configured: !!env.RESEND_API_KEY,
        clientEmail: !!(env.RESEND_API_KEY && env.CLIENT_NOTIFY_FROM),
        to: env.NOTIFY_TO || env.ADMIN_EMAILS,
        from: env.NOTIFY_FROM || "Genvyd <alerts@notify.genvyd.com>",
      });
    }

    if (path === "/api/admin/dashboard" && method === "GET") {
      // Everything Anthony needs to act on, across all clients.
      const clients = (await env.DB.prepare("SELECT slug, name, folder FROM clients").all<Client>()).results;
      const byClient = new Map(clients.map((c) => [c.slug, c]));
      const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
      const adminMarks = admins.map(() => "?").join(",") || "''";

      const [changes, approved, openComments, picks] = await env.DB.batch([
        env.DB.prepare("SELECT client_slug, path, updated_by, updated_at FROM item_status WHERE status = 'changes' ORDER BY updated_at DESC LIMIT 200"),
        env.DB.prepare("SELECT client_slug, path, updated_by, updated_at FROM item_status WHERE status = 'approved' ORDER BY updated_at DESC LIMIT 300"),
        env.DB.prepare(
          `SELECT id, client_slug, path, email, body, timecode, created_at FROM comments WHERE resolved = 0 AND email NOT IN (${adminMarks}) ORDER BY created_at DESC LIMIT 100`,
        ).bind(...admins),
        env.DB.prepare(
          "SELECT c.client_slug, i.path, c.name FROM campaign_items i JOIN campaigns c ON c.id = i.campaign_id ORDER BY c.name",
        ),
      ]);

      const pickMap = new Map<string, string[]>();
      for (const r of picks.results as { client_slug: string; path: string; name: string }[]) {
        const k = `${r.client_slug}|${r.path}`;
        pickMap.set(k, [...(pickMap.get(k) ?? []), r.name]);
      }

      // Turn status rows into full ad cards (favorites, comments, tags), per client.
      async function cards(rows: { client_slug: string; path: string; updated_by: string; updated_at: number }[]) {
        const out = [];
        const groups = new Map<string, typeof rows>();
        for (const r of rows) if (byClient.has(r.client_slug)) groups.set(r.client_slug, [...(groups.get(r.client_slug) ?? []), r]);
        for (const [slug, list] of groups) {
          const c = byClient.get(slug)!;
          const items = await itemsFor(env, user, c, list.map((r) => r.path));
          const meta = new Map(list.map((r) => [r.path, r]));
          for (const it of items) {
            out.push({
              ...it,
              clientSlug: slug,
              clientName: c.name,
              statusBy: meta.get(it.path)?.updated_by,
              statusAt: meta.get(it.path)?.updated_at,
              campaigns: pickMap.get(`${slug}|${it.path}`) ?? [],
            });
          }
        }
        return out.sort((a, b) => (b.statusAt ?? 0) - (a.statusAt ?? 0));
      }

      return json({
        changes: await cards(changes.results as never),
        approved: await cards(approved.results as never),
        openComments: (openComments.results as { client_slug: string }[])
          .filter((r) => byClient.has(r.client_slug))
          .map((r) => ({ ...r, clientName: byClient.get(r.client_slug)!.name })),
      });
    }

    if (path === "/api/admin/overview" && method === "GET") {
      const [clients, members, activity] = await env.DB.batch([
        env.DB.prepare("SELECT slug, name, folder FROM clients ORDER BY name"),
        env.DB.prepare("SELECT client_slug, email, welcomed_at FROM members ORDER BY email"),
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
        const r = await env.DB.prepare("INSERT OR IGNORE INTO members (client_slug, email, created_at) VALUES (?, ?, ?)")
          .bind(slug, em, now())
          .run();
        const isNew = r.meta.changes > 0;
        let welcome: { sent: boolean; reason?: string } = { sent: false, reason: "Not requested." };
        if (body.welcome !== false && (isNew || body.resend)) {
          try { welcome = await sendWelcome(env, slug, em); } catch (err) {
            welcome = { sent: false, reason: err instanceof HttpError ? err.message : "The email service failed." };
          }
        }
        return json({ ok: true, added: isNew, welcome });
      } else {
        await env.DB.prepare("DELETE FROM members WHERE client_slug = ? AND email = ?").bind(slug, em).run();
      }
      return json({ ok: true });
    }
  }

  throw new HttpError(404, "Not found.");
}

// ---------------------------------------------------------------------------
// Welcome email for a new client login
// ---------------------------------------------------------------------------

function welcomeEmail(env: Env, clientName: string, email: string) {
  const portal = (env.PORTAL_URL || "https://clients.genvyd.com").replace(/\/+$/, "");
  const host = portal.replace(/^https?:\/\//, "");
  const subject = `Your ${clientName} review space at Genvyd is ready`;
  const steps = [
    ["Open the portal", `Go to <a href="${esc(portal)}" style="color:#d4141a">${esc(host)}</a> on your phone or computer.`, `Go to ${portal}`],
    ["Enter your email", `Type <b>${esc(email)}</b> (this exact address) and tap <b>Send me a code</b>.`, `Type ${email} (this exact address) and tap "Send me a code".`],
    ["Check your inbox", `You will get a short sign-in code within a minute. It comes from Cloudflare, the service that keeps the portal private. Not there? Check spam.`, "You will get a short sign-in code within a minute. It comes from Cloudflare, the service that keeps the portal private. Not there? Check spam."],
    ["Enter the code", `Type the code on the sign-in page and you are in. There is no password to create or remember.`, "Type the code on the sign-in page and you are in. No password to create or remember."],
  ];
  const can = [
    ["Watch and look", "every video and image we make for you, full quality, on any device."],
    ["Approve or request changes", "with one tap on each piece."],
    ["Leave comments", "on videos, pause where you mean and your note is pinned to that exact moment."],
    ["Favorite", "the ones you love so they are easy to find later."],
    ["Pick ads for each campaign", "when we set one up, so we know exactly what to run."],
    ["See what is new", "new work is marked NEW, and you can download anything you need."],
  ];

  const stepHtml = steps
    .map(
      ([t, d], i) =>
        `<tr><td valign="top" style="padding:0 14px 18px 0"><div style="width:30px;height:30px;border-radius:15px;background:#ff2a2a;color:#fff;font-weight:bold;text-align:center;line-height:30px">${i + 1}</div></td>` +
        `<td valign="top" style="padding:0 0 18px"><div style="font-weight:bold;font-size:16px;margin:4px 0 4px">${t}</div><div style="color:#444;line-height:1.5">${d}</div></td></tr>`,
    )
    .join("");
  const canHtml = can.map(([t, d]) => `<li style="margin:6px 0;line-height:1.5"><b>${t}:</b> ${d}</li>`).join("");

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:600px;margin:0 auto">` +
    `<div style="background:#000;color:#fff;padding:22px 24px;border-radius:16px 16px 0 0"><div style="font-size:22px;font-weight:bold">genvyd</div><div style="color:#bbb;font-size:12px;letter-spacing:2px;margin-top:4px">CLIENT REVIEW</div></div>` +
    `<div style="border:1px solid #eee;border-top:0;border-radius:0 0 16px 16px;padding:26px 24px">` +
    `<p style="font-size:17px;margin:0 0 12px">Hi,</p>` +
    `<p style="line-height:1.6;margin:0 0 12px">Your private review space for <b>${esc(clientName)}</b> is ready. This is where we share every video and image we make for you, and where you tell us what you like, what to change, and what to use.</p>` +
    `<p style="line-height:1.6;margin:0 0 22px">Getting in takes about a minute:</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">${stepHtml}</table>` +
    `<p style="text-align:center;margin:6px 0 28px"><a href="${esc(portal)}" style="display:inline-block;background:#ff2a2a;color:#fff;padding:14px 26px;border-radius:999px;text-decoration:none;font-weight:bold">Open my review space</a></p>` +
    `<div style="font-weight:bold;font-size:16px;margin:0 0 6px">What you can do there</div><ul style="padding-left:18px;margin:0 0 22px">${canHtml}</ul>` +
    `<div style="background:#f6f6f6;border-radius:12px;padding:14px 16px;line-height:1.55;color:#333;font-size:14px">` +
    `<b>Good to know</b><ul style="margin:6px 0 0;padding-left:18px">` +
    `<li style="margin:4px 0">On your phone, add the portal to your home screen so it opens like an app.</li>` +
    `<li style="margin:4px 0">Only the emails we add can see your space. If someone else on your team needs access, just reply and tell us their email.</li>` +
    `<li style="margin:4px 0">Now and then the portal may ask for a fresh code. Same steps, a few seconds.</li></ul></div>` +
    `<p style="line-height:1.6;margin:22px 0 0">Questions or stuck? Just reply to this email.</p>` +
    `<p style="line-height:1.6;margin:8px 0 0">Talk soon,<br>Anthony<br><span style="color:#777">Genvyd</span></p>` +
    `</div></div>`;

  const text =
    `Hi,\n\nYour private review space for ${clientName} is ready. This is where we share every video and image we make for you, and where you tell us what you like, what to change, and what to use.\n\n` +
    `Getting in takes about a minute:\n\n` +
    steps.map(([t, , txt], i) => `${i + 1}. ${t}: ${txt}`).join("\n") +
    `\n\nWhat you can do there:\n` +
    can.map(([t, d]) => `- ${t}: ${d}`).join("\n") +
    `\n\nGood to know:\n- On your phone, add the portal to your home screen so it opens like an app.\n- Only the emails we add can see your space. Reply with a teammate's email to add them.\n- Now and then the portal may ask for a fresh code. Same steps.\n\nQuestions or stuck? Just reply to this email.\n\nTalk soon,\nAnthony\nGenvyd\n`;
  return { subject, html, text };
}

/** Sends the welcome email if client email is switched on. Returns whether it went out. */
async function sendWelcome(env: Env, slug: string, email: string): Promise<{ sent: boolean; reason?: string }> {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "Email is not set up yet (RESEND_API_KEY)." };
  if (!env.CLIENT_NOTIFY_FROM) return { sent: false, reason: "Client email is not switched on yet (needs the verified sending address)." };
  const c = await env.DB.prepare("SELECT name FROM clients WHERE slug = ?").bind(slug).first<{ name: string }>();
  if (!c) throw new HttpError(404, "No such client.");
  const w = welcomeEmail(env, c.name, email);
  const replyTo = (env.NOTIFY_TO || env.ADMIN_EMAILS || "").split(",")[0]?.trim() || undefined;
  await sendEmail(env, w.subject, w.html, w.text, { to: [email], from: env.CLIENT_NOTIFY_FROM, replyTo });
  await env.DB.prepare("UPDATE members SET welcomed_at = ? WHERE client_slug = ? AND email = ?").bind(now(), slug, email).run();
  return { sent: true };
}

// ---------------------------------------------------------------------------
// Email digest: what clients did since the last email, sent every 15 minutes
// at most, and only when there is something to report.
// ---------------------------------------------------------------------------

type ActivityRow = { id: number; client_slug: string; path: string; email: string; kind: string; detail: string | null; created_at: number };
const DIGEST_KINDS = ["approved", "changes", "comment", "campaign_add", "like"];

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function itemLink(env: Env, slug: string, path: string) {
  const base = (env.PORTAL_URL || "https://clients.genvyd.com").replace(/\/+$/, "");
  return `${base}/#/c/${encodeURIComponent(slug)}/i/${encodeURIComponent(path)}`;
}

async function sendEmail(env: Env, subject: string, html: string, text: string, opts: { to?: string[]; from?: string; replyTo?: string } = {}) {
  if (!env.RESEND_API_KEY) throw new HttpError(503, "Email is not set up yet (RESEND_API_KEY secret is missing).");
  const to = opts.to ?? (env.NOTIFY_TO || env.ADMIN_EMAILS || "").split(",").map((e) => e.trim()).filter(Boolean);
  if (!to.length) throw new HttpError(503, "No NOTIFY_TO address is set.");
  const res = await fetch(env.RESEND_API_URL || "https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: opts.from || env.NOTIFY_FROM || "Genvyd <alerts@notify.genvyd.com>",
      to,
      subject,
      html,
      text,
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    }),
  });
  if (!res.ok) throw new HttpError(502, `The email service answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

function buildDigest(env: Env, rows: ActivityRow[], names: Map<string, string>) {
  const count = (k: string) => rows.filter((r) => r.kind === k).length;
  const bits = [
    count("approved") && `${count("approved")} approved`,
    count("changes") && `${count("changes")} change request${count("changes") === 1 ? "" : "s"}`,
    count("comment") && `${count("comment")} comment${count("comment") === 1 ? "" : "s"}`,
    count("campaign_add") && `${count("campaign_add")} campaign pick${count("campaign_add") === 1 ? "" : "s"}`,
    count("like") && `${count("like")} favorite${count("like") === 1 ? "" : "s"}`,
  ].filter(Boolean);
  const clientList = [...new Set(rows.map((r) => names.get(r.client_slug) || r.client_slug))];
  const subject = `${clientList.join(", ")}: ${bits.join(", ")}`;

  const LABEL: Record<string, string> = {
    changes: "Changes requested",
    comment: "New comments",
    approved: "Approved",
    campaign_add: "Added to campaigns",
    like: "Favorited",
  };
  const order = ["changes", "comment", "approved", "campaign_add", "like"];
  let html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:620px">`;
  let text = "";
  for (const slug of [...new Set(rows.map((r) => r.client_slug))]) {
    const name = names.get(slug) || slug;
    html += `<h2 style="margin:24px 0 8px;font-size:18px">${esc(name)}</h2>`;
    text += `\n${name}\n`;
    for (const kind of order) {
      const list = rows.filter((r) => r.client_slug === slug && r.kind === kind);
      if (!list.length) continue;
      html += `<p style="margin:14px 0 6px;font-weight:bold;color:${kind === "changes" ? "#b26a00" : kind === "approved" ? "#127a3f" : "#111"}">${LABEL[kind]}</p><ul style="margin:0;padding-left:18px">`;
      text += `  ${LABEL[kind]}:\n`;
      for (const r of list) {
        const file = r.path.split("/").pop() || r.path;
        const link = itemLink(env, slug, r.path);
        const extra = kind === "comment" && r.detail ? `: "${r.detail}"` : kind === "campaign_add" && r.detail ? ` (${r.detail})` : "";
        html += `<li style="margin:4px 0"><a href="${esc(link)}" style="color:#d4141a">${esc(file)}</a> <span style="color:#555">by ${esc(r.email)}${esc(extra)}</span></li>`;
        text += `   - ${file} by ${r.email}${extra}\n     ${link}\n`;
      }
      html += `</ul>`;
    }
  }
  const dash = (env.PORTAL_URL || "https://clients.genvyd.com").replace(/\/+$/, "") + "/#/";
  html += `<p style="margin-top:28px"><a href="${esc(dash)}" style="background:#ff2a2a;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none">Open the studio dashboard</a></p>`;
  html += `<p style="color:#888;font-size:12px;margin-top:24px">Sent by clients.genvyd.com. You get at most one of these every 15 minutes, only when clients do something.</p></div>`;
  text += `\nOpen the studio dashboard: ${dash}\n`;
  return { subject, html, text };
}

async function runDigest(env: Env) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "no RESEND_API_KEY" };
  const state = await env.DB.prepare("SELECT value FROM notify_state WHERE key = 'last_activity_id'").first<{ value: string }>();
  const max = (await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM activity").first<{ m: number }>())!.m;
  if (!state) {
    // First run after email is switched on: start from now, do not send old history.
    await env.DB.prepare("INSERT OR REPLACE INTO notify_state (key, value) VALUES ('last_activity_id', ?)").bind(String(max)).run();
    return { sent: false, reason: "initialized" };
  }
  const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const rows = (
    await env.DB.prepare(
      `SELECT id, client_slug, path, email, kind, detail, created_at FROM activity WHERE id > ? AND kind IN (${DIGEST_KINDS.map(() => "?").join(",")}) ORDER BY id LIMIT 300`,
    )
      .bind(Number(state.value), ...DIGEST_KINDS)
      .all<ActivityRow>()
  ).results.filter((r) => !admins.includes(r.email));

  if (rows.length) {
    const names = new Map(
      (await env.DB.prepare("SELECT slug, name FROM clients").all<{ slug: string; name: string }>()).results.map((c) => [c.slug, c.name]),
    );
    const d = buildDigest(env, rows, names);
    await sendEmail(env, d.subject, d.html, d.text); // throws on failure, so the pointer is not advanced
  }
  await env.DB.prepare("INSERT OR REPLACE INTO notify_state (key, value) VALUES ('last_activity_id', ?)").bind(String(max)).run();
  return { sent: rows.length > 0, count: rows.length };
}

// ---------------------------------------------------------------------------
// "New work" alerts to clients. Each run scans client folders on a small budget
// (the free Workers plan allows about 50 outgoing requests and 50 database queries
// per run, so it scans a slice per run and rotates through clients), records files it has not seen,
// and emails each client's logins once a batch has settled for 10 minutes.
// ---------------------------------------------------------------------------

const SCAN_BUDGET = 20;
const ALERT_CLIENTS_PER_RUN = 4;
const SETTLE_MS = 10 * 60 * 1000;

async function scanClients(env: Env) {
  const clients = (
    await env.DB.prepare(
      "SELECT DISTINCT c.slug, c.name, c.folder FROM clients c JOIN members m ON m.client_slug = c.slug ORDER BY c.slug",
    ).all<Client>()
  ).results;
  if (!clients.length || !env.MEDIA_ORIGIN) return;
  const cur = await env.DB.prepare("SELECT value FROM notify_state WHERE key = 'scan_cursor'").first<{ value: string }>();
  const start = Math.max(0, clients.findIndex((c) => c.slug > (cur?.value ?? "")));
  const order = [...clients.slice(start), ...clients.slice(0, start)];
  let budget = SCAN_BUDGET;
  let last = cur?.value ?? "";
  for (const c of order) {
    if (budget < 2) break;
    // Breadth first: client folder, its projects, then one more level, until the budget runs out.
    const found: string[] = [];
    let queue: string[][] = [[]];
    let complete = true;
    while (queue.length) {
      const next: string[][] = [];
      for (const segs of queue) {
        if (budget <= 0) { complete = false; break; }
        budget--;
        let entries: NasEntry[];
        try { entries = await listNas(env, c.folder, segs); } catch { complete = false; continue; }
        for (const e of entries) {
          if (e.type === "file") found.push([...segs, e.name].join("/"));
          else if (segs.length < 3) next.push([...segs, e.name]);
        }
      }
      if (!complete) break;
      queue = next;
    }
    await registerFiles(env, c.slug, found);
    if (complete && !(await baselineDone(env, c.slug))) {
      // First full scan of this client: everything already there is old news.
      await env.DB.batch([
        env.DB.prepare("UPDATE files SET notified = 1 WHERE client_slug = ?").bind(c.slug),
        env.DB.prepare("INSERT OR REPLACE INTO notify_state (key, value) VALUES (?, ?)").bind(`files_baseline:${c.slug}`, String(now())),
      ]);
    }
    last = c.slug;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO notify_state (key, value) VALUES ('scan_cursor', ?)").bind(last).run();
}

async function runClientAlerts(env: Env) {
  await scanClients(env);
  if (!env.CLIENT_NOTIFY_FROM || !env.RESEND_API_KEY) {
    // Alerts are off: keep the backlog empty so switching them on later starts fresh.
    await env.DB.prepare("UPDATE files SET notified = 1 WHERE notified = 0").run();
    return;
  }
  const settled = now() - SETTLE_MS;
  const pending = (
    await env.DB.prepare(
      "SELECT f.client_slug, f.path, f.first_seen FROM files f WHERE f.notified = 0 ORDER BY f.client_slug, f.path",
    ).all<{ client_slug: string; path: string; first_seen: number }>()
  ).results;
  const bySlug = new Map<string, typeof pending>();
  for (const r of pending) bySlug.set(r.client_slug, [...(bySlug.get(r.client_slug) ?? []), r]);
  const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase());

  let handled = 0;
  for (const [slug, rows] of bySlug) {
    if (handled >= ALERT_CLIENTS_PER_RUN) break;
    // Wait until uploads have stopped for a while so one batch makes one email.
    if (rows.some((r) => r.first_seen > settled)) continue;
    handled++;
    const c = await env.DB.prepare("SELECT slug, name, folder FROM clients WHERE slug = ?").bind(slug).first<Client>();
    const to = c
      ? (
          await env.DB.prepare("SELECT email FROM members WHERE client_slug = ? AND email_alerts = 1").bind(slug).all<{ email: string }>()
        ).results.map((r) => r.email).filter((e) => !admins.includes(e))
      : [];
    if (c && to.length) {
      const base = (env.PORTAL_URL || "https://clients.genvyd.com").replace(/\/+$/, "");
      const n = rows.length;
      const byFolder = new Map<string, string[]>();
      for (const r of rows) {
        const folder = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
        byFolder.set(folder, [...(byFolder.get(folder) ?? []), r.path]);
      }
      const subject = `New from Genvyd: ${n} new file${n === 1 ? "" : "s"} for ${c.name}`;
      let html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:620px"><p style="font-size:16px">Hi! There ${n === 1 ? "is 1 new file" : `are ${n} new files`} for <b>${esc(c.name)}</b> ready for you to look at.</p>`;
      let text = `There ${n === 1 ? "is 1 new file" : `are ${n} new files`} for ${c.name} ready for you to look at.\n`;
      let listed = 0;
      for (const [folder, paths] of byFolder) {
        const fl = `${base}/#/c/${encodeURIComponent(slug)}${folder ? "/f/" + encodeURIComponent(folder) : ""}`;
        html += `<p style="margin:18px 0 6px;font-weight:bold"><a href="${esc(fl)}" style="color:#111">${esc(folder || c.name)}</a></p><ul style="margin:0;padding-left:18px">`;
        text += `\n${folder || c.name}: ${fl}\n`;
        for (const p of paths) {
          if (listed >= 25) break;
          listed++;
          const name = p.split("/").pop() || p;
          html += `<li style="margin:4px 0"><a href="${esc(itemLink(env, slug, p))}" style="color:#d4141a">${esc(name)}</a></li>`;
          text += `  - ${name}\n`;
        }
        html += `</ul>`;
      }
      if (n > listed) {
        html += `<p style="color:#555">And ${n - listed} more.</p>`;
        text += `  ...and ${n - listed} more\n`;
      }
      const open = `${base}/#/c/${encodeURIComponent(slug)}`;
      html += `<p style="margin-top:24px"><a href="${esc(open)}" style="background:#ff2a2a;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none">See what's new</a></p>`;
      html += `<p style="color:#888;font-size:12px;margin-top:24px">You get this because you have access to ${esc(c.name)} on clients.genvyd.com. To stop these emails, open the portal and switch off "Email me when there is new work".</p></div>`;
      text += `\nSee what's new: ${open}\nTo stop these emails, switch off "Email me when there is new work" in the portal.\n`;
      try {
        await sendEmail(env, subject, html, text, { to, from: env.CLIENT_NOTIFY_FROM });
      } catch (err) {
        console.error("client alert failed", slug, err);
        continue; // leave them pending, retry next run
      }
    }
    // Sent, or nobody to tell: either way these files are no longer pending.
    for (let i = 0; i < rows.length; i += 50) {
      await env.DB.batch(
        rows.slice(i, i + 50).map((r) => env.DB.prepare("UPDATE files SET notified = 1 WHERE client_slug = ? AND path = ?").bind(slug, r.path)),
      );
    }
  }
}

export default {
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await runDigest(env).catch((err) => console.error("digest failed", err));
        await runClientAlerts(env).catch((err) => console.error("client alerts failed", err));
      })(),
    );
  },

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
