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

import { makePdf, type PdfBlock } from "./pdf";

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
  CLIENT_REPLY_TO?: string;
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
  init: { body?: ReadableStream | string | null; contentType?: string; destination?: string[] } = {},
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
    // Sent as a path, not a full URL: nginx refuses a full-URL Destination whose host differs
    // from the Host it received, and the tunnel can change that host (live renames got a 400).
    const prefix = new URL(base).pathname.replace(/\/+$/, "");
    extra["Destination"] = `${prefix}/${init.destination.map(encodeURIComponent).join("/")}`;
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

const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");

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
// Backups of the portal's own data (approvals, comments, favorites, campaigns,
// tags, logins). The videos and photos live on the Synology and are protected by
// its own snapshots (synology/BACKUP_SETUP.md). Cloudflare also keeps 7 days of
// D1 Time Travel, but that needs a terminal; these copies sit on the Synology and
// can be restored from the Admin page.
// ---------------------------------------------------------------------------

const BACKUP_DIR = "_Portal backups";
const DELETED_DIR = "_Deleted files";
const BACKUP_CRON = "17 10 * * *"; // 3:17 AM Phoenix
const BACKUP_TABLES = [
  "clients", "members", "item_status", "likes", "comments", "activity",
  "campaigns", "campaign_items", "item_tags", "notify_state", "files", "views", "hidden",
  "copy_items", "copy_campaigns", "copy_imports", "file_ids", "file_renames",
  "campaign_summaries", "campaign_events",
];
// Approval records are append only (the database refuses to change or delete them), so a restore
// only adds back records that are missing and never replaces the ones there.
const APPEND_ONLY = new Set(["campaign_events"]);
const BACKUP_NAME_RE = /^portal-backup-\d{4}-\d{2}-\d{2}-\d{4}(-[a-z-]{1,20})?\.json$/;
const SYSTEM_USER: User = { email: "backup@portal", admin: true };

async function exportDb(env: Env) {
  const results = await env.DB.batch(BACKUP_TABLES.map((t) => env.DB.prepare(`SELECT * FROM ${t}`)));
  const tables: Record<string, unknown[]> = {};
  BACKUP_TABLES.forEach((t, i) => (tables[t] = results[i].results as unknown[]));
  return { app: "genvyd-clients", version: 1, created_at: now(), tables };
}

async function writeBackup(env: Env, label = "") {
  const data = await exportDb(env);
  const d = new Date(data.created_at);
  const pad = (n: number) => String(n).padStart(2, "0");
  // Names use Phoenix time so they match what Anthony sees.
  const az = new Date(d.getTime() - 7 * 3600 * 1000);
  const stamp = `${az.getUTCFullYear()}-${pad(az.getUTCMonth() + 1)}-${pad(az.getUTCDate())}-${pad(az.getUTCHours())}${pad(az.getUTCMinutes())}`;
  const wanted = `portal-backup-${stamp}${label ? "-" + label : ""}.json`;
  const mk = await nasWrite(env, SYSTEM_USER, "MKCOL", [BACKUP_DIR]);
  if (![201, 405].includes(mk.status)) throw new HttpError(502, `The Synology answered ${mk.status} when making the backup folder.`);
  const name = await freeName(env, [BACKUP_DIR], wanted);
  const body = JSON.stringify(data);
  const res = await nasWrite(env, SYSTEM_USER, "PUT", [BACKUP_DIR, name], { body, contentType: "application/json" });
  if (res.status !== 201 && res.status !== 204) throw new HttpError(502, `The Synology answered ${res.status} to the backup.`);
  const rows = Object.values(data.tables).reduce((n, r) => n + r.length, 0);
  const info = { at: data.created_at, name, bytes: body.length, rows };
  await env.DB.prepare("INSERT OR REPLACE INTO notify_state (key, value) VALUES ('backup_last', ?)").bind(JSON.stringify(info)).run();
  return info;
}

async function listBackups(env: Env) {
  const res = await fetch(env.MEDIA_ORIGIN.replace(/\/+$/, "") + "/" + encodeURIComponent(BACKUP_DIR) + "/", {
    headers: originHeaders(env, { accept: "application/json" }),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new HttpError(502, `The Synology answered ${res.status}.`);
  const entries = (await res.json()) as NasEntry[];
  return entries
    .filter((e) => e.type === "file" && BACKUP_NAME_RE.test(e.name))
    .map((e) => ({ name: e.name, size: e.size ?? null, mtime: e.mtime ?? null }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

async function readBackup(env: Env, name: string) {
  if (!BACKUP_NAME_RE.test(name)) throw new HttpError(400, "That is not a portal backup.");
  const res = await fetch(env.MEDIA_ORIGIN.replace(/\/+$/, "") + "/" + [BACKUP_DIR, name].map(encodeURIComponent).join("/"), {
    headers: originHeaders(env),
  });
  if (res.status === 404) throw new HttpError(404, "That backup is not on the Synology.");
  if (!res.ok) throw new HttpError(502, `The Synology answered ${res.status}.`);
  return res;
}

/** Puts every table back the way it was in the backup, in one transaction. */
async function restoreBackup(env: Env, name: string) {
  const data = (await (await readBackup(env, name)).json()) as { app?: string; version?: number; tables?: Record<string, Record<string, unknown>[]> };
  if (data.app !== "genvyd-clients" || data.version !== 1 || !data.tables) throw new HttpError(400, "That file is not a portal backup.");
  const safe = await writeBackup(env, "before-restore");
  const stmts: D1PreparedStatement[] = [];
  for (const t of BACKUP_TABLES) {
    const rows = data.tables[t];
    if (!Array.isArray(rows)) continue; // tables added after this backup was made are left alone
    if (!APPEND_ONLY.has(t)) stmts.push(env.DB.prepare(`DELETE FROM ${t}`));
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    if (!cols.every((c) => /^[a-z_]+$/.test(c))) throw new HttpError(400, "That backup has unexpected columns.");
    const select = cols.map((c) => `json_extract(value, '$.${c}')`).join(", ");
    // Rows go in as JSON in chunks, so even a big backup is only a few statements.
    let chunk: unknown[] = [];
    let size = 0;
    const flush = () => {
      if (!chunk.length) return;
      stmts.push(env.DB.prepare(`INSERT ${APPEND_ONLY.has(t) ? "OR IGNORE " : ""}INTO ${t} (${cols.join(", ")}) SELECT ${select} FROM json_each(?)`).bind(JSON.stringify(chunk)));
      chunk = []; size = 0;
    };
    for (const r of rows) {
      const len = JSON.stringify(r).length;
      if (size + len > 800_000) flush();
      chunk.push(r); size += len;
    }
    flush();
  }
  if (stmts.length > 40) throw new HttpError(413, "That backup is too big to restore from here. Ask Claude to restore it.");
  await env.DB.batch(stmts);
  await env.DB.prepare("INSERT OR REPLACE INTO notify_state (key, value) VALUES ('backup_last', ?)").bind(JSON.stringify(safe)).run();
  return { restored: name, safetyCopy: safe.name };
}

// ---------------------------------------------------------------------------
// Claude feed: a plain report of what clients said, written to the Synology so
// Claude (in a chat linked to Anthony's Mac, where the share is mounted) can read
// it and open the actual files. Rewritten every 30 minutes when something changed,
// or from Admin. The only files the portal overwrites, and only in this folder
// (client-feedback.md, client-feedback.json and approvals-log.md).
// ---------------------------------------------------------------------------

const FEED_DIR = "_Claude feed";
const FEED_CRON = "7,37 * * * *";
const MAC_SHARE = "/Volumes/GenvydClients";

function azTime(ms: number) {
  const d = new Date(ms - 7 * 3600 * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let hr = d.getUTCHours();
  const ap = hr >= 12 ? "PM" : "AM";
  hr = hr % 12 || 12;
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${hr}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ap}`;
}
const tc = (t: number | null) => (t == null ? "" : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")} `);

async function buildFeed(env: Env) {
  const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const isAdmin = (e: string) => admins.includes(e.toLowerCase());
  const weekAgo = now() - 7 * 86400 * 1000;
  const [clientsR, statusR, commentsR, campsR, hiddenR, actR, copyR, copyCampR, sumR, evR] = await env.DB.batch([
    env.DB.prepare("SELECT slug, name, folder FROM clients ORDER BY name"),
    env.DB.prepare("SELECT client_slug, path, status, updated_by, updated_at FROM item_status WHERE status IN ('approved','changes','rejected') ORDER BY updated_at DESC"),
    env.DB.prepare("SELECT id, parent_id, client_slug, path, email, body, timecode, resolved, created_at FROM comments ORDER BY created_at"),
    env.DB.prepare("SELECT c.id, c.client_slug, c.name, c.notes, i.path FROM campaigns c LEFT JOIN campaign_items i ON i.campaign_id = c.id ORDER BY c.created_at DESC, i.added_at"),
    env.DB.prepare("SELECT client_slug, path, hidden_by, hidden_at FROM hidden ORDER BY hidden_at DESC"),
    env.DB.prepare("SELECT client_slug, path, email, kind, detail, created_at FROM activity WHERE created_at > ? ORDER BY created_at DESC LIMIT 300").bind(weekAgo),
    env.DB.prepare("SELECT * FROM copy_items ORDER BY created_at DESC"),
    env.DB.prepare("SELECT l.copy_id, c.name FROM copy_campaigns l JOIN campaigns c ON c.id = l.campaign_id"),
    env.DB.prepare("SELECT client_slug, path, last_sig, gone FROM campaign_summaries ORDER BY first_seen"),
    env.DB.prepare("SELECT id, client_slug, summary_path, campaign, kind, email, typed_name, comment, at, at_utc, at_phoenix, ip, summary_sha256, sig, detail FROM campaign_events ORDER BY id"),
  ]);
  const sums = sumR.results as { client_slug: string; path: string; last_sig: string | null; gone: number }[];
  const evs = evR.results as CampaignEvent[];
  const copies = copyR.results as Record<string, any>[];
  const copyCamps = new Map<number, string[]>();
  for (const r of copyCampR.results as { copy_id: number; name: string }[]) copyCamps.set(r.copy_id, [...(copyCamps.get(r.copy_id) ?? []), r.name]);
  type Row = Record<string, any>;
  const clients = clientsR.results as Row[];
  const status = statusR.results as Row[];
  const comments = commentsR.results as Row[];
  const camps = campsR.results as Row[];
  const hidden = hiddenR.results as Row[];
  const acts = (actR.results as Row[]).filter((a) => !isAdmin(a.email));
  const hiddenSet = new Set(hidden.map((r) => `${r.client_slug}|${r.path}`));
  const portal = (env.PORTAL_URL || "https://clients.genvyd.com").replace(/\/+$/, "");

  const out: Record<string, unknown> = { generated_at: now(), generated_at_phoenix: azTime(now()), mac_share: MAC_SHARE, clients: [] };
  let md = `# Client feedback from clients.genvyd.com\n\nUpdated ${azTime(now())} (Phoenix). Written by the portal every 30 minutes when something changes.\n` +
    `Files are on the Synology share, mounted on Anthony's Mac at ${MAC_SHARE}. Comments marked OPEN have not been answered or marked done.\n` +
    `Timecodes (m:ss) are where the client paused the video when commenting.\n`;

  for (const c of clients) {
    const key = (p: string) => `${c.slug}|${p}`;
    const fileInfo = (p: string) => ({ path: p, mac_path: `${MAC_SHARE}/${c.folder}/${p}`, link: `${portal}/#/c/${encodeURIComponent(c.slug)}/i/${encodeURIComponent(p)}` });
    // Each comment with its replies right after it (replies carry reply_to).
    const commentsOn = (p: string) => {
      const here = comments.filter((m) => m.client_slug === c.slug && m.path === p);
      const one = (m: Row) => ({
        id: m.id as number, reply_to: (m.parent_id as number | null) ?? null, by: m.email, from: isAdmin(m.email) ? "Genvyd" : "client",
        at: azTime(m.created_at), timecode: m.timecode, text: m.body, open: !m.parent_id && !m.resolved && !isAdmin(m.email),
        answered: !m.parent_id && here.some((r) => r.parent_id === m.id && isAdmin(r.email)),
      });
      return here.filter((m) => !m.parent_id || !here.some((r) => r.id === m.parent_id))
        .flatMap((m) => [one(m), ...here.filter((r) => r.parent_id === m.id).map(one)]);
    };
    const mine = status.filter((r) => r.client_slug === c.slug && !hiddenSet.has(key(r.path)));
    const changes = mine.filter((r) => r.status === "changes").map((r) => ({ ...fileInfo(r.path), requested_by: r.updated_by, at: azTime(r.updated_at), comments: commentsOn(r.path) }));
    const changePaths = new Set(changes.map((x) => x.path));
    const campsByPath = new Map<string, string[]>();
    const campaigns: { name: string; notes: string | null; files: string[] }[] = [];
    for (const r of camps.filter((r) => r.client_slug === c.slug)) {
      let cp = campaigns.find((x) => x.name === r.name);
      if (!cp) { cp = { name: r.name, notes: r.notes, files: [] }; campaigns.push(cp); }
      if (r.path && !hiddenSet.has(key(r.path))) {
        cp.files.push(r.path);
        campsByPath.set(r.path, [...(campsByPath.get(r.path) ?? []), r.name]);
      }
    }
    const saidNo = mine.filter((r) => r.status === "rejected").map((r) => ({ ...fileInfo(r.path), by: r.updated_by, at: azTime(r.updated_at), comments: commentsOn(r.path) }));
    const noPaths = new Set(saidNo.map((x) => x.path));
    const approved = mine.filter((r) => r.status === "approved").map((r) => ({ ...fileInfo(r.path), approved_by: r.updated_by, at: azTime(r.updated_at), campaigns: campsByPath.get(r.path) ?? [], comments: commentsOn(r.path) }));
    const openElsewhere = [...new Set(comments.filter((m) => m.client_slug === c.slug && !m.resolved && !isAdmin(m.email) && !String(m.path).startsWith("copy:") && !changePaths.has(m.path) && !noPaths.has(m.path) && !hiddenSet.has(key(m.path))).map((m) => m.path))]
      .map((p) => ({ ...fileInfo(p), comments: commentsOn(p) }));
    const hid = hidden.filter((r) => r.client_slug === c.slug).map((r) => ({ ...fileInfo(r.path), hidden_by: r.hidden_by, at: azTime(r.hidden_at) }));
    const recent = acts.filter((a) => a.client_slug === c.slug).slice(0, 60).map((a) => ({ at: azTime(a.created_at), by: a.email, did: a.kind, path: a.path, detail: a.detail }));
    const KIND_LABEL: Record<string, string> = { tagline: "Tagline", headline: "Headline", primary: "Primary text", description: "Description", link: "Link", cta: "Call to action", caption: "Caption", other: "Other" };
    const copy = copies.filter((r) => r.client_slug === c.slug).map((r) => ({
      id: r.id, type: (r.card ? `Card ${r.card} ` : "") + (KIND_LABEL[r.kind] || r.kind), card: r.card ?? null, text: r.text, note: r.note, status: r.status, status_by: r.status_by,
      at: r.status_at ? azTime(r.status_at) : null, version: r.version, hidden: !!r.hidden,
      campaigns: copyCamps.get(r.id) ?? [], comments: commentsOn(`copy:${r.id}`),
      for_ad: r.ad_path ? fileInfo(r.ad_path) : null,
      copy_file: r.source ? `${MAC_SHARE}/${c.folder}/${r.source}` : null,
      earlier_wordings: (JSON.parse(r.history || "[]") as { text: string }[]).map((h) => h.text),
    }));
    // Campaign approvals: status from the newest event (a change after approval is recorded as a reset).
    const campaignApprovals = sums.filter((x) => x.client_slug === c.slug && (!x.gone || evs.some((e) => e.client_slug === c.slug && e.summary_path === x.path))).map((x) => {
      const mine = evs.filter((e) => e.client_slug === c.slug && e.summary_path === x.path);
      const last = mine[mine.length - 1];
      const st = !last ? "needs" : last.kind === "approved" ? "approved" : last.kind === "reset" ? "changed" : x.last_sig && x.last_sig !== last.sig ? "needs" : "changes";
      const lastChange = [...mine].reverse().find((e) => e.kind === "changes");
      return {
        campaign: last?.campaign || (x.path.split("/").pop() || x.path).replace(SUMMARY_FILE, ""), ...fileInfo(x.path),
        link: itemLink(env, c.slug, x.path), removed: !!x.gone,
        status: STATUS_TEXT[st] + (st === "needs" && last?.kind === "changes" ? " (updated after the change request)" : ""),
        who: last ? (last.kind === "approved" ? `${last.typed_name} (${last.email})` : last.kind === "changes" ? last.email : "portal") : null,
        when: last ? last.at_phoenix : null,
        comment: lastChange?.comment ?? null,
        reset_reason: last?.kind === "reset" ? last.detail : null,
        record_id: last?.kind === "approved" ? last.id : null,
      };
    });
    (out.clients as unknown[]).push({ name: c.name, slug: c.slug, folder: c.folder, campaign_approvals: campaignApprovals, changes_requested: changes, said_no: saidNo, open_comments: openElsewhere, approved, campaigns, hidden: hid, ad_copy: copy, recent_activity: recent });

    const cm = (list: ReturnType<typeof commentsOn>) =>
      list.map((m) => m.reply_to
        ? `      - Reply from ${m.from === "Genvyd" ? "Genvyd" : m.by} (${m.at}): ${m.text.replace(/\s+/g, " ")}`
        : `    - ${m.open ? (m.answered ? "OPEN (Genvyd replied) " : "OPEN ") : ""}${m.from === "Genvyd" ? "Genvyd" : m.by} (${m.at}): ${tc(m.timecode)}${m.text.replace(/\s+/g, " ")}`).join("\n");
    const file = (f: { path: string; mac_path: string; link: string }) => `**${f.path}**\n  - Mac: \`${f.mac_path}\`\n  - Portal: ${f.link}`;
    md += `\n---\n\n## ${c.name}\n\nSynology folder: \`${c.folder}\` (Mac: \`${MAC_SHARE}/${c.folder}\`)\n`;
    md += `\n### Campaign approvals (${campaignApprovals.length})\n`;
    md += campaignApprovals.length ? campaignApprovals.map((a) =>
      `\n- **${a.campaign}**: ${a.status.toUpperCase()}${a.removed ? " (summary file removed)" : ""}\n  - Summary: \`${a.mac_path}\`\n  - Portal: ${a.link}` +
      (a.who ? `\n  - ${a.status.startsWith("Approved") ? "Signed by" : a.status.startsWith("Changes") ? "Asked by" : "Last change by"} ${a.who}, ${a.when}` : "") +
      (a.reset_reason ? `\n  - Why: ${a.reset_reason}` : "") +
      (a.comment ? `\n  - Change request: ${a.comment.replace(/\s+/g, " ")}` : "") +
      (a.record_id ? `\n  - Approval record #${a.record_id} (download the PDF from the portal's Approval history)` : "")).join("\n") + "\n" : "\nNone.\n";
    md += `\n### Changes requested (${changes.length})\n`;
    md += changes.length ? changes.map((f) => `\n- ${file(f)}\n  - Requested by ${f.requested_by}, ${f.at}${f.comments.length ? "\n  - Comments:\n" + cm(f.comments) : "\n  - No comment left. Ask what to change."}`).join("\n") + "\n" : "\nNone.\n";
    md += `\n### Said no, do not use (${saidNo.length})\n`;
    md += saidNo.length ? saidNo.map((f) => `\n- ${file(f)}\n  - Marked No by ${f.by}, ${f.at}${f.comments.length ? "\n  - Comments:\n" + cm(f.comments) : ""}`).join("\n") + "\n" : "\nNone.\n";
    md += `\n### Unanswered comments on other ads (${openElsewhere.length})\n`;
    md += openElsewhere.length ? openElsewhere.map((f) => `\n- ${file(f)}\n  - Comments:\n${cm(f.comments)}`).join("\n") + "\n" : "\nNone.\n";
    md += `\n### Approved (${approved.length})\n`;
    md += approved.length ? approved.map((f) => `\n- ${file(f)}\n  - Approved by ${f.approved_by}, ${f.at}${f.campaigns.length ? `\n  - In campaigns: ${f.campaigns.join(", ")}` : ""}${f.comments.length ? "\n  - Comments:\n" + cm(f.comments) : ""}`).join("\n") + "\n" : "\nNone yet.\n";
    const live = copy.filter((x) => !x.hidden);
    const copyLine = (x: (typeof copy)[number]) =>
      `\n- ${x.type} #${x.id}${x.version > 1 ? ` (v${x.version})` : ""}: "${x.text.replace(/\s+/g, " ")}"` +
      (x.status !== "pending" && x.status_by ? `\n  - ${x.status === "approved" ? "Approved" : "Changes requested"} by ${x.status_by}, ${x.at}` : "") +
      (x.for_ad ? `\n  - For ad: \`${x.for_ad.mac_path}\` (any size or version)` : "\n  - Not tied to an ad") +
      (x.copy_file ? `\n  - From copy file: \`${x.copy_file}\` (change the wording there)` : "") +
      (x.campaigns.length ? `\n  - In campaigns: ${x.campaigns.join(", ")}` : "") +
      (x.note ? `\n  - Note: ${x.note.replace(/\s+/g, " ")}` : "") +
      (x.comments.length ? "\n  - Comments:\n" + cm(x.comments) : "") +
      (x.earlier_wordings.length ? `\n  - Earlier wordings: ${x.earlier_wordings.map((t) => `"${t.replace(/\s+/g, " ")}"`).join(" / ")}` : "");
    md += `\n### Ad copy (taglines, headlines, text)\n`;
    if (!live.length) md += "\nNone yet.\n";
    for (const [label, st] of [["Changes requested", "changes"], ["Awaiting review", "pending"], ["Approved", "approved"]] as const) {
      const list = live.filter((x) => x.status === st);
      if (list.length) md += `\n**${label} (${list.length})**\n` + list.map(copyLine).join("") + "\n";
    }
    const hidCopy = copy.filter((x) => x.hidden);
    if (hidCopy.length) md += `\n**In the trash, they don't want these (${hidCopy.length})**\n` + hidCopy.map((x) => `\n- ${x.type} #${x.id}: "${x.text.replace(/\s+/g, " ")}"`).join("") + "\n";
    md += `\n### Campaigns (${campaigns.length})\n`;
    md += campaigns.length ? campaigns.map((cp) => {
      const cc = live.filter((x) => x.campaigns.includes(cp.name)).map((x) => `${x.type} #${x.id} "${x.text.replace(/\s+/g, " ")}"`);
      return `\n- **${cp.name}**${cp.notes ? ` (${cp.notes.replace(/\s+/g, " ")})` : ""}: ${cp.files.length ? cp.files.join(", ") : "no ads"}${cc.length ? `\n  - Copy: ${cc.join("; ")}` : ""}`;
    }).join("\n") + "\n" : "\nNone.\n";
    md += `\n### In the trash, they don't want these (${hid.length})\n`;
    md += hid.length ? hid.map((f) => `\n- ${f.path} (trashed by ${f.hidden_by}, ${f.at})`).join("") + "\n" : "\nNone.\n";
    md += `\n### Client activity, last 7 days\n`;
    md += recent.length ? recent.map((a) => `\n- ${a.at}: ${a.by} ${a.did} ${String(a.path).startsWith("copy:") ? `ad copy #${String(a.path).slice(5)}` : a.path}${a.detail && a.did !== "comment" ? ` (${a.detail})` : ""}`).join("") + "\n" : "\nNothing.\n";
  }
  // approvals-log.md: one line per approval, oldest first. Rebuilt from the append-only records,
  // so it only ever grows.
  const names = new Map(clients.map((c) => [c.slug, c.name]));
  const approvals = evs.filter((e) => e.kind === "approved");
  let log = `# Campaign approvals log\n\nOne line per client approval on clients.genvyd.com, oldest first. Written by the portal from its approval records, which cannot be edited. The full record (frozen summary, file hashes, signature) is a PDF from Approval history in the portal.\n\n`;
  log += approvals.length ? approvals.map((e) =>
    `- ${e.at_utc.replace("T", " ").replace(/\.\d+Z$/, " UTC")} (${e.at_phoenix}) | ${names.get(e.client_slug) || e.client_slug} | ${e.campaign} | APPROVED | signed "${e.typed_name}" | ${e.email} | IP ${e.ip ?? "unknown"} | summary sha256 ${e.summary_sha256} | ${e.summary_path} | record #${e.id}`).join("\n") + "\n" : "No approvals yet.\n";
  return { md, json: out, log };
}

/** Writes the feed if anything changed since the last one (or always, when forced). */
async function writeFeed(env: Env, force = false) {
  const sig = await env.DB.prepare(
    "SELECT (SELECT IFNULL(MAX(id),0) FROM activity) || '-' || (SELECT COUNT(*) FROM comments) || '-' || (SELECT IFNULL(SUM(resolved),0) FROM comments) || '-' || (SELECT COUNT(*) FROM hidden) || '-' || (SELECT COUNT(*) FROM campaign_items) || '-' || (SELECT IFNULL(MAX(updated_at),0) || COUNT(*) FROM copy_items) || '-' || (SELECT COUNT(*) FROM copy_campaigns) || '-' || (SELECT IFNULL(MAX(id),0) FROM campaign_events) || '-' || (SELECT COUNT(*) || IFNULL(SUM(gone),0) || IFNULL(MAX(last_sig),'') FROM campaign_summaries) AS s",
  ).first<{ s: string }>();
  const last = await env.DB.prepare("SELECT value FROM notify_state WHERE key = 'feed_sig'").first<{ value: string }>();
  if (!force && last && sig && last.value === sig.s) return { written: false };
  const { md, json: data, log } = await buildFeed(env);
  const mk = await nasWrite(env, SYSTEM_USER, "MKCOL", [FEED_DIR]);
  if (![201, 405].includes(mk.status)) throw new HttpError(502, `The Synology answered ${mk.status} when making the feed folder.`);
  for (const [name, body, type] of [
    ["client-feedback.md", md, "text/markdown; charset=utf-8"],
    ["client-feedback.json", JSON.stringify(data, null, 1), "application/json"],
    ["approvals-log.md", log, "text/markdown; charset=utf-8"],
  ] as const) {
    const res = await nasWrite(env, SYSTEM_USER, "PUT", [FEED_DIR, name], { body, contentType: type });
    if (![200, 201, 204].includes(res.status)) throw new HttpError(502, `The Synology answered ${res.status} to the feed.`);
  }
  await env.DB.prepare("INSERT OR REPLACE INTO notify_state (key, value) VALUES ('feed_sig', ?)").bind(sig?.s ?? "").run();
  await env.DB.prepare("INSERT OR REPLACE INTO notify_state (key, value) VALUES ('feed_last', ?)").bind(String(now())).run();
  return { written: true, at: now(), bytes: md.length };
}

// ---------------------------------------------------------------------------
// Ad copy
// ---------------------------------------------------------------------------

// Every table that stores a file by its path (besides campaign_items, scoped by campaign).
const RENAME_TABLES = ["item_status", "likes", "comments", "item_tags", "activity", "files", "views", "hidden"];

const COPY_KINDS = ["tagline", "headline", "primary", "description", "link", "cta", "caption", "other"];

// Copy files: Claude or Muse saves "<ad name>.copy.txt" next to the ad on the Synology,
// one line per option:
//   Headline: Built for the back nine
//   Primary text: Our ponytail cap...
//     (lines without a label carry on the one above, so primary text can run long)
//   Note: shown under the line above
// The portal reads them when the folder is opened (and on the 15 minute scan), never shows
// them as files, and only reads one again when it changes.
const COPY_FILE = /\.copy\.(txt|md)$/i;
const COPY_LABELS: [RegExp, string][] = [
  [/^tag ?lines?$/, "tagline"],
  [/^(headlines?|titles?)$/, "headline"],
  [/^(primary( text)?|primary copy|body( text)?|ad text|text)$/, "primary"],
  [/^(description|desc|link description)$/, "description"],
  [/^(link|url|website|destination|landing page)$/, "link"],
  [/^(cta|ctas|call to action|button( text)?)$/, "cta"],
  [/^(captions?|post caption|video caption)$/, "caption"],
  [/^other$/, "other"],
];

// Carousels: a line "Card 2" (or "## Card 2", "Card 2:", "Slide 2") starts that card's section;
// lines after it belong to card 2 until the next card or a "Shared"/"All cards" line.
const CARD_HEAD = /^\s*(?:#{1,6}\s*)?\**\s*(?:card|slide)\s*#?\s*(\d{1,2})\s*\**\s*:?\s*$/i;
const SHARED_HEAD = /^\s*(?:#{1,6}\s*)?\**\s*(?:shared|all cards|whole ad|every card)\s*\**\s*:?\s*$/i;
// Labels that describe the file rather than being ad text ("Placement shown: Facebook Feed").
const COPY_META = /^(placement( shown)?|placements|ad name|ad|format|size|sizes|campaign|client|date|version)$/;

function parseCopyFile(text: string) {
  type Line = { kind: string; text: string; note: string | null; card: number | null };
  const out: Line[] = [];
  let cur: Line | null = null;
  let card: number | null = null;
  let inNote = false;
  for (const raw of text.replace(/\r/g, "").replace(/^\uFEFF/, "").split("\n")) {
    const ch = raw.match(CARD_HEAD);
    if (ch) { card = Number(ch[1]) || null; cur = null; inNote = false; continue; }
    if (SHARED_HEAD.test(raw)) { card = null; cur = null; inNote = false; continue; }
    // Markdown headings ("# Ponytail cap") and rules are for people; hashtags ("#golf") are not headings.
    if (/^\s*#{1,6}\s/.test(raw) || /^\s*(-{3,}|\*{3,})\s*$/.test(raw)) { if (cur) inNote = false; continue; }
    const m = raw.match(/^\s*(?:[-*]\s+)?\**\s*([A-Za-z][A-Za-z ]{0,24}?)\s*(?:\d{1,2}|\(\d{1,2}\)|option \d{1,2})?\s*\**\s*:\s*\**\s*(.*)$/i);
    const label = m ? m[1].trim().toLowerCase() : "";
    const kind = m ? COPY_LABELS.find(([re]) => re.test(label))?.[1] : undefined;
    if (m && kind) {
      // Primary text and the button belong to the whole ad even inside a card section, unless
      // the file clearly gives each card its own.
      cur = { kind, text: m[2], note: null, card: kind === "primary" || kind === "cta" ? null : card };
      out.push(cur);
      inNote = false;
    } else if (m && /^notes?$/.test(label) && cur) {
      cur.note = m[2].trim();
      inNote = true;
    } else if (m && COPY_META.test(label)) {
      cur = null; inNote = false;
    } else if (cur) {
      if (inNote) { if (raw.trim()) cur.note = `${cur.note ?? ""}\n${raw.trim()}`.trim(); else inNote = false; }
      else cur.text += "\n" + raw;
    }
  }
  const seen = new Set<string>();
  const key = (l: Line) => `${l.card ?? ""}|${l.kind}|${l.text}`;
  return out
    .map((l) => ({ ...l, text: l.text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 3000), note: l.note ? l.note.slice(0, 1000) : null }))
    .filter((l) => l.text && !seen.has(key(l)) && seen.add(key(l)))
    .slice(0, 80);
}

/**
 * Brings one copy file into the portal. Lines already there are left alone (with their
 * approvals). A changed line replaces the one it most likely rewrites (changes requested
 * first), keeping the old wording in history and going back to Awaiting review. Lines taken
 * out of the file go too, unless the client already approved or commented on them.
 */
async function importCopyFile(env: Env, slug: string, filePath: string, content: string) {
  const adPath = filePath.replace(COPY_FILE, "");
  const want = parseCopyFile(content);
  const have = (await env.DB.prepare(
    "SELECT i.id, i.kind, i.card, i.text, i.note, i.status, i.version, i.history, i.hidden, i.updated_at, " +
      "(SELECT COUNT(*) FROM comments m WHERE m.client_slug = i.client_slug AND m.path = 'copy:' || i.id) AS ncomments " +
      "FROM copy_items i WHERE i.client_slug = ? AND i.source = ? ORDER BY i.id",
  ).bind(slug, filePath).all<Record<string, any>>()).results;
  const rank: Record<string, number> = { changes: 0, pending: 1, approved: 2 };
  const stmts: D1PreparedStatement[] = [];
  const t = now();
  // A line that used to be read without its card (older files) keeps its approval and gets its card.
  for (const x of want) {
    if (x.card == null) continue;
    const old = have.find((y) => y.kind === x.kind && y.text === x.text && y.card == null && !want.some((z) => z.card == null && z.kind === y.kind && z.text === y.text));
    if (old) { old.card = x.card; stmts.push(env.DB.prepare("UPDATE copy_items SET card = ? WHERE id = ?").bind(x.card, old.id)); }
  }
  // Each kind on each card (or the whole ad) is matched on its own.
  const gk = (kind: string, card: number | null) => `${kind}|${card ?? ""}`;
  const groups = new Set([...want.map((x) => gk(x.kind, x.card)), ...have.map((y) => gk(y.kind, y.card ?? null))]);
  for (const g of groups) {
    const w = want.filter((x) => gk(x.kind, x.card) === g);
    const hv = have.filter((y) => gk(y.kind, y.card ?? null) === g);
    const kind = g.split("|")[0];
    const card = g.split("|")[1] ? Number(g.split("|")[1]) : null;
    for (const x of w) {
      const same = hv.find((y) => y.text === x.text);
      if (same && x.note !== null && x.note !== same.note) stmts.push(env.DB.prepare("UPDATE copy_items SET note = ? WHERE id = ?").bind(x.note, same.id));
    }
    const fresh = w.filter((x) => !hv.some((y) => y.text === x.text));
    const stale = hv.filter((y) => !w.some((x) => x.text === y.text) && !y.hidden).sort((a, b) => rank[a.status] - rank[b.status] || a.id - b.id);
    fresh.forEach((x, i) => {
      const old = stale[i];
      if (old) {
        const history = JSON.parse(old.history || "[]");
        history.push({ text: old.text, version: old.version, status: old.status, at: old.updated_at });
        stmts.push(env.DB.prepare(
          "UPDATE copy_items SET text = ?, note = ?, ad_path = ?, version = version + 1, history = ?, status = 'pending', status_by = NULL, status_at = NULL, updated_at = ? WHERE id = ?",
        ).bind(x.text, x.note ?? old.note, adPath, JSON.stringify(history.slice(-20)), t, old.id));
      } else {
        stmts.push(env.DB.prepare(
          "INSERT INTO copy_items (client_slug, kind, card, text, note, ad_path, source, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'copy file', ?, ?)",
        ).bind(slug, kind, card, x.text, x.note, adPath, filePath, t, t));
      }
    });
    for (const old of stale.slice(fresh.length)) {
      if (old.status === "pending" && !old.ncomments) {
        stmts.push(env.DB.prepare("DELETE FROM copy_items WHERE id = ?").bind(old.id));
        stmts.push(env.DB.prepare("DELETE FROM copy_campaigns WHERE copy_id = ?").bind(old.id));
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts.slice(0, 200));
  return { lines: want.length, changes: stmts.length };
}

/** Reads copy files that are new or changed since last time (at most `limit` per call). */
async function syncCopyFiles(env: Env, c: Client, files: { path: string; size?: number; mtime?: string }[], limit: number) {
  if (!files.length || limit < 1) return 0;
  const list = files.slice(0, 90);
  const known = new Map(
    (await env.DB.prepare(`SELECT path, sig FROM copy_imports WHERE client_slug = ? AND path IN (${list.map(() => "?").join(",")})`)
      .bind(c.slug, ...list.map((f) => f.path)).all<{ path: string; sig: string }>()).results.map((r) => [r.path, r.sig]),
  );
  let done = 0;
  for (const f of list) {
    const sig = `r2|${f.size ?? ""}|${f.mtime ?? ""}`; // r2: reader that understands carousel cards
    if (known.get(f.path) === sig) continue;
    if (done >= limit) break;
    done++;
    try {
      const res = await fetch(originUrl(env, c.folder, f.path.split("/")), { headers: originHeaders(env) });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 200_000) continue; // not a copy file
      const r = await importCopyFile(env, c.slug, f.path, new TextDecoder().decode(buf));
      await env.DB.prepare("INSERT OR REPLACE INTO copy_imports (client_slug, path, sig, lines, imported_at) VALUES (?, ?, ?, ?, ?)")
        .bind(c.slug, f.path, sig, r.lines, now()).run();
    } catch { /* try again next time */ }
  }
  return done;
}

async function copyList(env: Env, user: User, c: Client) {
  const [items, links, camps, comments] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM copy_items WHERE client_slug = ? ORDER BY created_at DESC, id DESC").bind(c.slug),
    env.DB.prepare("SELECT l.copy_id, l.campaign_id FROM copy_campaigns l JOIN copy_items i ON i.id = l.copy_id WHERE i.client_slug = ?").bind(c.slug),
    env.DB.prepare("SELECT id, name FROM campaigns WHERE client_slug = ? ORDER BY created_at DESC").bind(c.slug),
    env.DB.prepare("SELECT id, path, email, body, resolved, created_at FROM comments WHERE client_slug = ? AND path LIKE 'copy:%' ORDER BY created_at").bind(c.slug),
  ]);
  const byCopy = new Map<number, number[]>();
  for (const l of links.results as { copy_id: number; campaign_id: number }[]) byCopy.set(l.copy_id, [...(byCopy.get(l.copy_id) ?? []), l.campaign_id]);
  const cmts = new Map<string, unknown[]>();
  for (const m of comments.results as Record<string, any>[]) {
    cmts.set(m.path, [...(cmts.get(m.path) ?? []), { id: m.id, email: m.email, body: m.body, resolved: !!m.resolved, created_at: m.created_at, mine: m.email === user.email }]);
  }
  return {
    client: { slug: c.slug, name: c.name },
    campaigns: camps.results,
    kinds: COPY_KINDS,
    items: (items.results as Record<string, any>[]).map((r) => ({
      id: r.id, kind: r.kind, text: r.text, note: r.note, status: r.status, statusBy: r.status_by, statusAt: r.status_at,
      version: r.version, history: JSON.parse(r.history || "[]"), hidden: !!r.hidden, createdAt: r.created_at, updatedAt: r.updated_at,
      adPath: r.ad_path ?? null, source: r.source ?? null, card: r.card ?? null,
      campaigns: byCopy.get(r.id) ?? [], comments: cmts.get(`copy:${r.id}`) ?? [],
    })),
  };
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
      ).concat(paths.slice(i, i + 50).map((p) =>
        env.DB.prepare("INSERT OR IGNORE INTO file_ids (client_slug, path, created_at) VALUES (?, ?, ?)").bind(slug, p, t),
      )),
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

  // Copy files (".copy.txt") are read into the ad's copy, not shown as files.
  const copyFiles = entries.filter((e) => e.type === "file" && COPY_FILE.test(e.name));
  await syncCopyFiles(env, c, copyFiles.map((f) => ({ path: prefix + f.name, size: f.size, mtime: f.mtime })), 4);
  // Campaign summaries (".summary.md") show as a pinned approval card, not as files.
  const summaryNames = entries.filter((e) => e.type === "file" && SUMMARY_FILE.test(e.name)).map((e) => e.name);
  await noteSummaries(env, c.slug, segs.join("/"), summaryNames, true);
  const files = entries.filter((e) => e.type === "file" && !COPY_FILE.test(e.name) && !SUMMARY_FILE.test(e.name));
  const paths = files.map((f) => prefix + f.name);
  await registerFiles(env, c.slug, paths);

  // Pull all social data for this folder in one go.
  const like = prefix.replace(/[%_\\]/g, (m) => "\\" + m) + "%";
  const [statusRows, likeRows, commentRows, tagRows, hiddenRows, copyAll] = await env.DB.batch([
    env.DB.prepare("SELECT path, status FROM item_status WHERE client_slug = ? AND path LIKE ? ESCAPE '\\'").bind(c.slug, like),
    env.DB.prepare(
      "SELECT path, COUNT(*) AS n, SUM(CASE WHEN email = ? THEN 1 ELSE 0 END) AS mine FROM likes WHERE client_slug = ? AND path LIKE ? ESCAPE '\\' GROUP BY path",
    ).bind(user.email, c.slug, like),
    env.DB.prepare(
      "SELECT path, COUNT(*) AS n, SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS open FROM comments WHERE client_slug = ? AND path LIKE ? ESCAPE '\\' GROUP BY path",
    ).bind(c.slug, like),
    env.DB.prepare("SELECT path, tag FROM item_tags WHERE client_slug = ? AND path LIKE ? ESCAPE '\\' ORDER BY tag").bind(c.slug, like),
    env.DB.prepare("SELECT path FROM hidden WHERE client_slug = ? AND path LIKE ? ESCAPE '\\'").bind(c.slug, like),
    // Copy for the ads in this folder (shown under each ad), plus a count of copy not tied to any ad.
    env.DB.prepare("SELECT id, ad_path, kind, card, text, status FROM copy_items WHERE client_slug = ? AND hidden = 0 AND (ad_path LIKE ? ESCAPE '\\' OR ad_path IS NULL) ORDER BY id").bind(c.slug, like),
  ]);
  const copyRows = (copyAll.results as { id: number; ad_path: string | null; kind: string; card: number | null; text: string; status: string }[]);
  const copy = copyRows.filter((r) => r.ad_path && !r.ad_path.slice(prefix.length).includes("/"))
    .map((r) => ({ id: r.id, adPath: r.ad_path, kind: r.kind, card: r.card ?? null, text: r.text.slice(0, 300), status: r.status }));
  const looseCopy = copyRows.filter((r) => !r.ad_path).length;
  const hidden = new Set((hiddenRows.results as { path: string }[]).map((r) => r.path));
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
  // Folder cards show how much is inside and a few previews, so clients see there is
  // something to open. Taken from the files the portal already knows (no extra Synology calls).
  const known = (knownRows.results as { path: string }[]).map((r) => r.path).filter((p) => !gone.includes(p));
  const isImg = (p: string) => /\.(jpe?g|png|webp|gif|avif)$/i.test(p);
  const isVid = (p: string) => /\.(mp4|mov|m4v|webm)$/i.test(p);
  for (const f of folders as { path: string; newCount?: number; fileCount?: number; previews?: { path: string; kind: string }[] }[]) {
    const pre = f.path + "/";
    f.newCount = [...unseen].filter((p) => p.startsWith(pre) && !hidden.has(p)).length;
    const inside = known.filter((p) => p.startsWith(pre) && !hidden.has(p) && !/(^|\/)[.@#]/.test(p.slice(pre.length))).sort();
    f.fileCount = inside.length;
    f.previews = [...inside.filter(isImg), ...inside.filter(isVid)]
      .slice(0, 3)
      .map((p) => ({ path: p, kind: isImg(p) ? "image" : "video" }));
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
        hidden: hidden.has(p),
      };
    })
    .sort((a, b) => (b.mtime ? Date.parse(b.mtime) : 0) - (a.mtime ? Date.parse(a.mtime) : 0));

  const summaries = summaryNames.map((n) => ({ path: prefix + n, name: n }));
  return { client: { slug: c.slug, name: c.name }, dir: segs.join("/"), folders, items, copy, looseCopy, summaries };
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
  const [viewRows, hiddenRows] = await env.DB.batch([
    env.DB.prepare(`SELECT path FROM views WHERE client_slug = ? AND email = ? AND path IN (${marks})`).bind(c.slug, user.email, ...paths),
    env.DB.prepare(`SELECT path FROM hidden WHERE client_slug = ? AND path IN (${marks})`).bind(c.slug, ...paths),
  ]);
  const viewed = new Set((viewRows.results as { path: string }[]).map((r) => r.path));
  const hidden = new Set((hiddenRows.results as { path: string }[]).map((r) => r.path));
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
      hidden: hidden.has(p),
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
  const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const [s, l, cm, tg] = await env.DB.batch([
    env.DB.prepare("SELECT status, updated_by, updated_at FROM item_status WHERE client_slug = ? AND path = ?").bind(c.slug, p),
    env.DB.prepare("SELECT email FROM likes WHERE client_slug = ? AND path = ? ORDER BY created_at").bind(c.slug, p),
    env.DB.prepare(
      "SELECT id, parent_id, email, body, timecode, resolved, created_at FROM comments WHERE client_slug = ? AND path = ? ORDER BY created_at",
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
      genvyd: admins.includes(String(r.email).toLowerCase()),
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

  // ---- ad copy (taglines, headlines, primary text, CTAs) --------------------
  const cm = path.match(/^\/api\/c\/([^/]+)\/copy(?:\/(\d+)(?:\/(status|edit|hide|comments|campaign|delete))?)?$/);
  if (cm) {
    const [, slugRaw, idStr, sub] = cm;
    const c = await requireClient(env, user, decodeURIComponent(slugRaw));
    if (!idStr && method === "GET") return json(await copyList(env, user, c));
    if (!idStr && method === "POST") {
      if (!user.admin) throw new HttpError(403, "Only Genvyd can add copy.");
      const body = await readBody(req);
      const kind = COPY_KINDS.includes(String(body.kind)) ? String(body.kind) : "other";
      const raw = String(body.text ?? "").replace(/\r/g, "").trim();
      if (!raw) throw new HttpError(400, "Type the copy first.");
      const texts = body.lines ? raw.split("\n").map((t) => t.trim()).filter(Boolean) : [raw];
      if (texts.length > 50) throw new HttpError(400, "That is a lot of lines. Add 50 or fewer at a time.");
      if (texts.some((t) => t.length > 3000)) throw new HttpError(400, "One of those is too long (3,000 characters max).");
      const note = String(body.note ?? "").trim().slice(0, 1000) || null;
      const adPath = body.adPath ? cleanPath(String(body.adPath)).join("/") : null;
      const card = Number.isInteger(Number(body.card)) && Number(body.card) > 0 && Number(body.card) < 100 ? Number(body.card) : null;
      const camps = (Array.isArray(body.campaigns) ? body.campaigns : []).map(Number).filter((n) => Number.isInteger(n)).slice(0, 10);
      const valid = camps.length
        ? new Set((await env.DB.prepare(`SELECT id FROM campaigns WHERE client_slug = ? AND id IN (${camps.map(() => "?").join(",")})`).bind(c.slug, ...camps).all<{ id: number }>()).results.map((r) => r.id))
        : new Set<number>();
      for (const t of texts) {
        const r = await env.DB.prepare(
          "INSERT INTO copy_items (client_slug, kind, card, text, note, ad_path, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        ).bind(c.slug, kind, card, t, note, adPath, user.email, now(), now()).first<{ id: number }>();
        if (valid.size) {
          await env.DB.batch([...valid].map((cid) =>
            env.DB.prepare("INSERT OR IGNORE INTO copy_campaigns (copy_id, campaign_id, added_by, added_at) VALUES (?, ?, ?, ?)").bind(r!.id, cid, user.email, now())));
        }
      }
      return json(await copyList(env, user, c));
    }
    if (idStr) {
      const item = await env.DB.prepare("SELECT * FROM copy_items WHERE id = ? AND client_slug = ?").bind(Number(idStr), c.slug).first<Record<string, any>>();
      if (!item) throw new HttpError(404, "That copy is gone.");
      const cpath = `copy:${item.id}`;
      const snippet = String(item.text).replace(/\s+/g, " ").slice(0, 120);
      if (sub === "status" && method === "POST") {
        const status = String((await readBody(req)).status ?? "");
        if (!["pending", "approved", "changes"].includes(status)) throw new HttpError(400, "Bad status.");
        await env.DB.prepare("UPDATE copy_items SET status = ?, status_by = ?, status_at = ? WHERE id = ?").bind(status, user.email, now(), item.id).run();
        await logActivity(env, c.slug, cpath, user.email, status, snippet);
        return json(await copyList(env, user, c));
      }
      if (sub === "edit" && method === "POST") {
        // New wording keeps the old one in history and goes back to Awaiting review.
        if (!user.admin) throw new HttpError(403, "Only Genvyd can edit copy.");
        const body = await readBody(req);
        const text = String(body.text ?? "").replace(/\r/g, "").trim();
        if (!text) throw new HttpError(400, "Copy is empty.");
        if (text.length > 3000) throw new HttpError(400, "That is too long (3,000 characters max).");
        const kind = COPY_KINDS.includes(String(body.kind)) ? String(body.kind) : item.kind;
        const note = body.note === undefined ? item.note : String(body.note ?? "").trim().slice(0, 1000) || null;
        if (text === item.text) {
          await env.DB.prepare("UPDATE copy_items SET kind = ?, note = ?, updated_at = ? WHERE id = ?").bind(kind, note, now(), item.id).run();
        } else {
          const history = JSON.parse(item.history || "[]");
          history.push({ text: item.text, version: item.version, status: item.status, at: item.updated_at });
          await env.DB.prepare(
            "UPDATE copy_items SET text = ?, kind = ?, note = ?, version = version + 1, history = ?, status = 'pending', status_by = NULL, status_at = NULL, updated_at = ? WHERE id = ?",
          ).bind(text, kind, note, JSON.stringify(history.slice(-20)), now(), item.id).run();
        }
        return json(await copyList(env, user, c));
      }
      if (sub === "hide" && method === "POST") {
        const hide = (await readBody(req)).hidden !== false;
        await env.DB.prepare("UPDATE copy_items SET hidden = ? WHERE id = ?").bind(hide ? 1 : 0, item.id).run();
        await logActivity(env, c.slug, cpath, user.email, hide ? "hidden" : "unhidden", snippet);
        return json(await copyList(env, user, c));
      }
      if (sub === "comments" && method === "POST") {
        const text = String((await readBody(req)).body ?? "").trim();
        if (!text) throw new HttpError(400, "Comment is empty.");
        if (text.length > 4000) throw new HttpError(400, "Comment is too long (4,000 characters max).");
        await env.DB.prepare("INSERT INTO comments (client_slug, path, email, body, timecode, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
          .bind(c.slug, cpath, user.email, text, now()).run();
        await logActivity(env, c.slug, cpath, user.email, "comment", text.slice(0, 280));
        return json(await copyList(env, user, c));
      }
      if (sub === "campaign" && method === "POST") {
        // Anyone on the client can put copy in a campaign, like ads.
        const body = await readBody(req);
        const camp = await env.DB.prepare("SELECT id, name FROM campaigns WHERE id = ? AND client_slug = ?").bind(Number(body.campaign), c.slug).first<{ id: number; name: string }>();
        if (!camp) throw new HttpError(404, "No such campaign.");
        if (body.on === false) {
          await env.DB.prepare("DELETE FROM copy_campaigns WHERE copy_id = ? AND campaign_id = ?").bind(item.id, camp.id).run();
          await logActivity(env, c.slug, cpath, user.email, "campaign_remove", camp.name);
        } else {
          await env.DB.prepare("INSERT OR IGNORE INTO copy_campaigns (copy_id, campaign_id, added_by, added_at) VALUES (?, ?, ?, ?)").bind(item.id, camp.id, user.email, now()).run();
          await logActivity(env, c.slug, cpath, user.email, "campaign_add", camp.name);
        }
        return json(await copyList(env, user, c));
      }
      if (sub === "delete" && method === "POST") {
        if (!user.admin) throw new HttpError(403, "Only Genvyd can delete copy.");
        if (!item.hidden) throw new HttpError(409, "Hide it first. Only hidden copy can be deleted.");
        await env.DB.batch([
          env.DB.prepare("DELETE FROM copy_items WHERE id = ?").bind(item.id),
          env.DB.prepare("DELETE FROM copy_campaigns WHERE copy_id = ?").bind(item.id),
          env.DB.prepare("DELETE FROM comments WHERE client_slug = ? AND path = ?").bind(c.slug, cpath),
        ]);
        return json(await copyList(env, user, c));
      }
    }
    throw new HttpError(405, "Method not allowed.");
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
        const body = await readBody(req);
        const p = cleanPath(String(body.path ?? "")).join("/");
        const paths = [p, ...alsoPaths(body, p)];
        if (method === "POST") {
          for (const q of paths) {
            await env.DB.prepare(
              "INSERT OR IGNORE INTO campaign_items (campaign_id, path, added_by, added_at) VALUES (?, ?, ?, ?)",
            )
              .bind(camp.id, q, user.email, now())
              .run();
          }
          await logActivity(env, c.slug, p, user.email, "campaign_add", camp.name);
        } else {
          for (const q of paths) {
            await env.DB.prepare("DELETE FROM campaign_items WHERE campaign_id = ? AND path = ?").bind(camp.id, q).run();
          }
          await logActivity(env, c.slug, p, user.email, "campaign_remove", camp.name);
        }
        return json({ ok: true });
      }
    }
    throw new HttpError(405, "Method not allowed.");
  }

  // ---- campaign summaries and approvals ------------------------------------
  const sm = path.match(/^\/api\/c\/([^/]+)\/(summaries|summary)(?:\/(approve|changes|record))?$/);
  if (sm) {
    const [, slugRaw, what, sub] = sm;
    const c = await requireClient(env, user, decodeURIComponent(slugRaw));
    if (what === "summaries" && !sub && method === "GET") return json({ summaries: await summariesList(env, c) });
    if (what !== "summary") throw new HttpError(404, "Not found.");
    if (!sub && method === "GET") return json(await summaryView(env, user, c, url.searchParams.get("path") || ""));
    if (sub === "record" && method === "GET") {
      if (!user.admin) throw new HttpError(403, "Only Genvyd can download approval records.");
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id)) throw new HttpError(400, "Which record?");
      const pdf = await approvalRecordPdf(env, c, id);
      const e = await env.DB.prepare("SELECT campaign, at FROM campaign_events WHERE id = ?").bind(id).first<{ campaign: string; at: number }>();
      const day = new Date((e?.at ?? now()) - 7 * 3600 * 1000).toISOString().slice(0, 10);
      const fname = `${(e?.campaign || "Campaign").replace(/[^\w .()-]+/g, "-")} approval record ${day} #${id}.pdf`;
      return new Response(pdf, { headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${fname.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        "cache-control": "no-store",
      } });
    }
    if ((sub === "approve" || sub === "changes") && method === "POST") {
      // The approval is the client's own record that they accepted the campaign, so only a client
      // login can give it. Genvyd cannot approve on a client's behalf.
      if (user.admin) throw new HttpError(403, "Only the client can approve or ask for changes here. Genvyd can't sign on their behalf.");
      const body = await readBody(req);
      const p = cleanPath(String(body.path ?? "")).join("/");
      const t = now();
      const ip = req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For") || null;
      const ua = (req.headers.get("User-Agent") || "").slice(0, 500) || null;
      if (sub === "approve") {
        const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
        if (body.agreed !== true) throw new HttpError(400, "Tick the box to confirm you reviewed everything.");
        if (body.confirmed !== true) throw new HttpError(400, "Please confirm in the final step.");
        if (name.length < 2 || name.length > 120 || !/\p{L}/u.test(name)) throw new HttpError(400, "Type your full name to sign.");
        const cur = await loadSummary(env, c, p, true);
        if (!cur) throw new HttpError(404, "This campaign summary was removed or renamed.");
        // They approve exactly what they were shown: if anything changed since the page loaded, show it again.
        if (cur.ads.some((a) => !a.exists)) throw new HttpError(409, "One of the ads in this campaign is missing, so it can't be approved yet. Genvyd has to fix that first.");
        if (String(body.sig ?? "") !== cur.sig) throw new HttpError(409, "This campaign was updated while you were reading it. The page now shows the latest version. Please review it again before approving.");
        const before = await summaryStatus(env, c, p, cur);
        if (before.status === "approved" && before.approval?.sig === cur.sig) return json(await summaryView(env, user, c, p));
        await env.DB.prepare(
          "INSERT INTO campaign_events (client_slug, summary_path, campaign, kind, email, typed_name, at, at_utc, at_phoenix, ip, user_agent, summary_sha256, sig, files_json, frozen_text, agreement_text) " +
            "VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(c.slug, p, cur.campaign, user.email, name, t, new Date(t).toISOString(), phxTime(t), ip, ua, cur.sha, cur.sig,
          JSON.stringify(cur.files), cur.text, `${AGREE_TEXT}\n\n${CONFIRM_TEXT}`).run();
        await logActivity(env, c.slug, p, user.email, "campaign_approved", `${cur.campaign}, signed ${name}`);
      } else {
        const comment = String(body.comment ?? "").replace(/\r/g, "").trim();
        if (!comment) throw new HttpError(400, "Say what you would like changed.");
        if (comment.length > 4000) throw new HttpError(400, "That is too long (4,000 characters max).");
        const cur = await loadSummary(env, c, p, false);
        if (!cur) throw new HttpError(404, "This campaign summary was removed or renamed.");
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO campaign_events (client_slug, summary_path, campaign, kind, email, comment, at, at_utc, at_phoenix, ip, user_agent, summary_sha256, sig, files_json) " +
              "VALUES (?, ?, ?, 'changes', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(c.slug, p, cur.campaign, user.email, comment, t, new Date(t).toISOString(), phxTime(t), ip, ua, cur.sha, cur.sig, JSON.stringify(cur.files)),
          // Also a normal comment, so it shows with the other comments on the dashboard and in the feed.
          env.DB.prepare("INSERT INTO comments (client_slug, path, email, body, timecode, resolved, created_at) VALUES (?, ?, ?, ?, NULL, 0, ?)").bind(c.slug, p, user.email, comment, t),
        ]);
        await logActivity(env, c.slug, p, user.email, "campaign_changes", comment.slice(0, 300));
      }
      try { await writeFeed(env); } catch { /* the 30 minute run picks it up */ }
      return json(await summaryView(env, user, c, p));
    }
    throw new HttpError(405, "Method not allowed.");
  }

  // ---- client scoped ------------------------------------------------------
  const m = path.match(/^\/api\/c\/([^/]+)\/(list|item|like|status|comments|folder|upload|tags|rename|import|view|hide|delete|where|todo)(?:\/(\d+)(?:\/(resolve))?)?$/);
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
      const newPath = [...dir, name].join("/");
      await registerFiles(env, c.slug, [newPath]);
      await markViewed(env, c.slug, user.email, [newPath]);
      // A new version of an existing ad: it keeps the old one's tags and takes its place in
      // campaigns. Status and comments start fresh (the new version still needs review).
      const versionOf = url.searchParams.get("versionOf");
      if (versionOf) {
        const old = cleanPath(versionOf).join("/");
        if (parentOf(old) === dir.join("/") && old !== newPath) {
          await env.DB.batch([
            env.DB.prepare(
              "INSERT OR IGNORE INTO item_tags (client_slug, path, tag, created_by, created_at) " +
                "SELECT client_slug, ?, tag, ?, ? FROM item_tags WHERE client_slug = ? AND path = ?",
            ).bind(newPath, user.email, now(), c.slug, old),
            env.DB.prepare(
              "UPDATE OR IGNORE campaign_items SET path = ? WHERE path = ? AND campaign_id IN (SELECT id FROM campaigns WHERE client_slug = ?)",
            ).bind(newPath, old, c.slug),
            env.DB.prepare(
              "DELETE FROM campaign_items WHERE path = ? AND campaign_id IN (SELECT id FROM campaigns WHERE client_slug = ?)",
            ).bind(old, c.slug),
          ]);
        }
      }
      return json({ ok: true, path: newPath, renamed: name !== wanted ? name : null });
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
    if (action === "todo" && method === "GET") {
      // The client's home: every file the portal knows for this client with its status, so the
      // page can fold sizes and versions and show what is still waiting for review, plus counts
      // for ad copy and Genvyd's recent replies to the client's comments. A few queries in total.
      const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
      const since = now() - 21 * 86400 * 1000;
      const [filesR, statusR, hiddenR, viewsR, likesR, cmtR, copyR, repliesR] = await env.DB.batch([
        env.DB.prepare("SELECT path, first_seen FROM files WHERE client_slug = ? ORDER BY first_seen DESC LIMIT 600").bind(c.slug),
        env.DB.prepare("SELECT path, status, updated_by, updated_at FROM item_status WHERE client_slug = ?").bind(c.slug),
        env.DB.prepare("SELECT path FROM hidden WHERE client_slug = ?").bind(c.slug),
        env.DB.prepare("SELECT path FROM views WHERE client_slug = ? AND email = ?").bind(c.slug, user.email),
        env.DB.prepare("SELECT path, COUNT(*) AS n, SUM(CASE WHEN email = ? THEN 1 ELSE 0 END) AS mine FROM likes WHERE client_slug = ? GROUP BY path").bind(user.email, c.slug),
        env.DB.prepare("SELECT path, COUNT(*) AS n, SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS open FROM comments WHERE client_slug = ? AND path NOT LIKE 'copy:%' GROUP BY path").bind(c.slug),
        env.DB.prepare("SELECT status, COUNT(*) AS n FROM copy_items WHERE client_slug = ? AND hidden = 0 GROUP BY status").bind(c.slug),
        env.DB.prepare(
          "SELECT r.id, r.path, r.email, r.body, r.created_at, p.body AS parent_body, p.email AS parent_email FROM comments r LEFT JOIN comments p ON p.id = r.parent_id " +
            "WHERE r.client_slug = ? AND r.created_at > ? AND r.path NOT LIKE 'copy:%' ORDER BY r.created_at DESC LIMIT 30",
        ).bind(c.slug, since),
      ]);
      const st = new Map((statusR.results as { path: string; status: string; updated_by: string; updated_at: number }[]).map((r) => [r.path, r]));
      const hid = new Set((hiddenR.results as { path: string }[]).map((r) => r.path));
      const seen = new Set((viewsR.results as { path: string }[]).map((r) => r.path));
      const lk = new Map((likesR.results as { path: string; n: number; mine: number }[]).map((r) => [r.path, r]));
      const cm = new Map((cmtR.results as { path: string; n: number; open: number }[]).map((r) => [r.path, r]));
      const items = (filesR.results as { path: string; first_seen: number }[])
        .filter((f) => !hid.has(f.path) && !COPY_FILE.test(f.path) && !SUMMARY_FILE.test(f.path) && !/(^|\/)[.@#_]/.test(f.path))
        .map((f) => {
          const name = f.path.split("/").pop() || f.path;
          const s0 = st.get(f.path);
          return {
            name, path: f.path, folder: f.path.split("/").slice(0, -1).join("/"), kind: kindOf(name),
            size: null, mtime: new Date(f.first_seen).toISOString(),
            status: s0?.status ?? "pending", statusBy: s0?.updated_by ?? null, statusAt: s0?.updated_at ?? null,
            likes: lk.get(f.path)?.n ?? 0, liked: (lk.get(f.path)?.mine ?? 0) > 0,
            comments: cm.get(f.path)?.n ?? 0, openComments: cm.get(f.path)?.open ?? 0,
            tags: [], seen: seen.has(f.path), hidden: false,
          };
        });
      const copy = Object.fromEntries((copyR.results as { status: string; n: number }[]).map((r) => [r.status, r.n]));
      const replies = (repliesR.results as Record<string, any>[])
        // Genvyd's replies to the client's comments, and Genvyd's own new comments on an ad (a question).
        .filter((r) => admins.includes(String(r.email).toLowerCase()) && (r.parent_email == null || !admins.includes(String(r.parent_email).toLowerCase())))
        .slice(0, 12)
        .map((r) => ({ id: r.id, path: r.path, body: r.body, at: r.created_at, yourComment: r.parent_body }));
      return json({ client: { slug: c.slug, name: c.name }, items, copy, replies });
    }
    if (action === "where" && method === "GET") {
      // Old links: where does a file that was renamed in the portal live now?
      const p = cleanPath(url.searchParams.get("path") ?? "").join("/");
      const r = await env.DB.prepare(
        "SELECT f.path FROM file_renames r JOIN file_ids f ON f.id = r.file_id WHERE r.client_slug = ? AND r.old_path = ?",
      ).bind(c.slug, p).first<{ path: string }>();
      return json({ path: r && r.path !== p ? r.path : null });
    }
    if (action === "rename" && method === "POST") {
      // Admin only. Renames one file or several together (every size and version of an ad,
      // plus its thumbnails). All or nothing: if any Synology rename or the database update
      // fails, every file already renamed is put back and nothing in the database changes.
      if (!user.admin) throw new HttpError(403, "Only Genvyd can rename files.");
      const body = await readBody(req);
      const asked = Array.isArray(body.renames) ? (body.renames as Record<string, unknown>[]) : [{ path: body.path, name: body.name }];
      if (!asked.length) throw new HttpError(400, "Nothing to rename.");
      if (asked.length > 30) throw new HttpError(400, "That is a lot of files. Rename 30 or fewer at a time.");
      const plan = asked.map((r) => {
        const segs = cleanPath(String(r.path ?? ""));
        const oldName = segs[segs.length - 1];
        const dir = segs.slice(0, -1);
        // The file type never changes: whatever is typed, the original extension is kept.
        const dot = oldName.lastIndexOf(".");
        const ext = dot > 0 ? oldName.slice(dot) : "";
        let stem = folderName(r.name);
        if (ext && stem.toLowerCase().endsWith(ext.toLowerCase())) stem = stem.slice(0, -ext.length).trim();
        if (!stem) throw new HttpError(400, "The new name is empty.");
        const newName = stem + ext;
        return { dir, oldName, newName, oldPath: segs.join("/"), newPath: [...dir, newName].join("/") };
      }).filter((p) => p.oldName !== p.newName);
      if (!plan.length) return json({ ok: true, renamed: [] });
      const lower = (x: string) => x.toLowerCase();
      const sources = new Set(plan.map((p) => lower(p.oldPath)));
      const targets = new Set<string>();
      for (const p of plan) {
        if (sources.has(lower(p.newPath))) throw new HttpError(409, `"${p.newName}" is one of the files being renamed. Rename in two steps.`);
        if (targets.has(lower(p.newPath))) throw new HttpError(409, `Two files would both be called "${p.newName}".`);
        targets.add(lower(p.newPath));
      }
      // Every file must be there, and every new name must be free in its folder.
      for (const p of plan) {
        const src = await fetch(originUrl(env, c.folder, [...p.dir, p.oldName]), { method: "HEAD", headers: originHeaders(env) });
        if (src.status === 404) throw new HttpError(404, `"${p.oldName}" is no longer on the Synology.`);
        const dst = await fetch(originUrl(env, c.folder, [...p.dir, p.newName]), { method: "HEAD", headers: originHeaders(env) });
        if (dst.status !== 404) throw new HttpError(409, `There is already a file called "${p.newName}" in this folder. Nothing was renamed.`);
      }

      const done: typeof plan = [];
      const putBack = async () => {
        for (const p of done.slice().reverse()) {
          try { await nasWrite(env, user, "MOVE", [c.folder, ...p.dir, p.newName], { destination: [c.folder, ...p.dir, p.oldName] }); }
          catch (err) { console.error("rename rollback failed", p.newPath, err); }
        }
      };
      for (const p of plan) {
        let res: Response;
        try { res = await nasWrite(env, user, "MOVE", [c.folder, ...p.dir, p.oldName], { destination: [c.folder, ...p.dir, p.newName] }); }
        catch (err) { await putBack(); throw err; }
        if (res.status !== 201 && res.status !== 204) {
          await putBack();
          if (res.status === 412) throw new HttpError(409, `There is already a file called "${p.newName}" in this folder. Nothing was renamed.`);
          if (res.status === 403 || res.status === 405) throw new HttpError(502, "The Synology refused the rename. Update nginx.conf on the Synology (see synology/SYNOLOGY_UPDATE.md).");
          throw new HttpError(502, `The Synology answered ${res.status} to the rename of "${p.oldName}". Nothing was renamed.`);
        }
        done.push(p);
      }

      // Move everything attached to each old name onto the new one, in one database
      // transaction: approvals, comments and replies, favorites, tags, trash, views, campaign
      // spots (added_at is kept, so the order in a campaign stays), activity, typed-in copy.
      const t = now();
      const stmts: D1PreparedStatement[] = [];
      for (const p of plan) {
        for (const tb of RENAME_TABLES) {
          stmts.push(env.DB.prepare(`DELETE FROM ${tb} WHERE client_slug = ? AND path = ?`).bind(c.slug, p.newPath));
          stmts.push(env.DB.prepare(`UPDATE ${tb} SET path = ? WHERE client_slug = ? AND path = ?`).bind(p.newPath, c.slug, p.oldPath));
        }
        stmts.push(env.DB.prepare("DELETE FROM campaign_items WHERE path = ? AND campaign_id IN (SELECT id FROM campaigns WHERE client_slug = ?)").bind(p.newPath, c.slug));
        stmts.push(env.DB.prepare("UPDATE campaign_items SET path = ? WHERE path = ? AND campaign_id IN (SELECT id FROM campaigns WHERE client_slug = ?)").bind(p.newPath, p.oldPath, c.slug));
        stmts.push(env.DB.prepare("UPDATE copy_items SET ad_path = ? WHERE client_slug = ? AND ad_path = ? AND source IS NULL").bind(p.newPath, c.slug, p.oldPath));
        // The stable ID follows the file; the old name is remembered so old links redirect.
        stmts.push(env.DB.prepare("DELETE FROM file_ids WHERE client_slug = ? AND path = ?").bind(c.slug, p.newPath));
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO file_ids (client_slug, path, created_at) VALUES (?, ?, ?)").bind(c.slug, p.oldPath, t));
        stmts.push(env.DB.prepare("UPDATE file_ids SET path = ? WHERE client_slug = ? AND path = ?").bind(p.newPath, c.slug, p.oldPath));
        stmts.push(env.DB.prepare("DELETE FROM file_renames WHERE client_slug = ? AND old_path = ?").bind(c.slug, p.newPath));
        stmts.push(env.DB.prepare("UPDATE file_renames SET new_path = ? WHERE client_slug = ? AND new_path = ?").bind(p.newPath, c.slug, p.oldPath));
        stmts.push(env.DB.prepare(
          "INSERT OR REPLACE INTO file_renames (client_slug, old_path, file_id, new_path, renamed_by, renamed_at) SELECT ?, ?, id, ?, ?, ? FROM file_ids WHERE client_slug = ? AND path = ?",
        ).bind(c.slug, p.oldPath, p.newPath, user.email, t, c.slug, p.newPath));
        // Admin activity: shows on the dashboard and in the Claude feed, never emailed to clients.
        stmts.push(env.DB.prepare("INSERT INTO activity (client_slug, path, email, kind, detail, created_at) VALUES (?, ?, ?, 'renamed', ?, ?)")
          .bind(c.slug, p.newPath, user.email, `Renamed ${p.oldName} to ${p.newName}`, t));
      }
      const countSql = (paths: string[]) => [
        ...RENAME_TABLES.map((tb) => env.DB.prepare(`SELECT '${tb}' AS t, COUNT(*) AS n FROM ${tb} WHERE client_slug = ? AND path IN (${paths.map(() => "?").join(",")})`).bind(c.slug, ...paths)),
        env.DB.prepare(`SELECT 'campaign_items' AS t, COUNT(*) AS n FROM campaign_items WHERE path IN (${paths.map(() => "?").join(",")}) AND campaign_id IN (SELECT id FROM campaigns WHERE client_slug = ?)`).bind(...paths, c.slug),
      ];
      const tally = (rs: D1Result[]) => Object.fromEntries(rs.map((r) => { const x = r.results[0] as { t: string; n: number }; return [x.t, x.n]; }));
      let before: Record<string, number>;
      try {
        before = tally(await env.DB.batch(countSql(plan.map((p) => p.oldPath))));
        await env.DB.batch(stmts);
      } catch (err) {
        await putBack();
        console.error("rename db update failed", err);
        throw new HttpError(500, "The database update failed, so the files were put back under their old names. Nothing changed.");
      }
      // Check: nothing left behind under the old names.
      const left = tally(await env.DB.batch(countSql(plan.map((p) => p.oldPath))));
      const strays = Object.entries(left).filter(([, n]) => n > 0);
      if (strays.length) console.error("rename left rows behind", strays);
      try { await writeFeed(env); } catch { /* the 30 minute run picks it up */ }
      return json({
        ok: true,
        renamed: plan.map((p) => ({ from: p.oldPath, to: p.newPath, name: p.newName })),
        moved: before,
        leftBehind: Object.fromEntries(strays),
        path: plan[0].newPath, name: plan[0].newName,
      });
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
      const body = await readBody(req);
      const p = cleanPath(String(body.path ?? "")).join("/");
      const also = alsoPaths(body, p);
      const existing = await env.DB.prepare("SELECT 1 FROM likes WHERE client_slug = ? AND path = ? AND email = ?")
        .bind(c.slug, p, user.email)
        .first();
      // Toggle the main file; other sizes follow it. `liked: true/false` sets it instead (Select mode).
      const want = typeof body.liked === "boolean" ? body.liked : !existing;
      for (const q of [p, ...also]) {
        if (!want) {
          await env.DB.prepare("DELETE FROM likes WHERE client_slug = ? AND path = ? AND email = ?").bind(c.slug, q, user.email).run();
        } else {
          await env.DB.prepare(
            "INSERT INTO likes (client_slug, path, email, created_at) SELECT ?, ?, ?, ? " +
              "WHERE NOT EXISTS (SELECT 1 FROM likes WHERE client_slug = ? AND path = ? AND email = ?)",
          )
            .bind(c.slug, q, user.email, now(), c.slug, q, user.email)
            .run();
        }
      }
      if (want && !existing) await logActivity(env, c.slug, p, user.email, "like", null);
      return json(await itemDetail(env, user, c, p));
    }
    if (action === "hide" && method === "POST") {
      // Anyone on the client (and Genvyd) can hide or unhide an ad. Covers every size and
      // version sent in `also`. Nothing on the Synology changes.
      const body = await readBody(req);
      const p = cleanPath(String(body.path ?? "")).join("/");
      const paths = [p, ...alsoPaths(body, p)];
      const hide = body.hidden !== false;
      await env.DB.batch(paths.map((q) =>
        hide
          ? env.DB.prepare("INSERT OR IGNORE INTO hidden (client_slug, path, hidden_by, hidden_at) VALUES (?, ?, ?, ?)").bind(c.slug, q, user.email, now())
          : env.DB.prepare("DELETE FROM hidden WHERE client_slug = ? AND path = ?").bind(c.slug, q)));
      await logActivity(env, c.slug, p, user.email, hide ? "hidden" : "unhidden", null);
      return json({ ok: true, hidden: hide, count: paths.length });
    }
    if (action === "delete" && method === "POST") {
      // Genvyd only, and only for ads that are already hidden. The file is moved into
      // "_Deleted files/<client>/<folders>" on the Synology (nothing is erased; empty that
      // folder in Finder), and the portal forgets it.
      if (!user.admin) throw new HttpError(403, "Only Genvyd can delete files.");
      const body = await readBody(req);
      const segs = cleanPath(String(body.path ?? ""));
      const p = segs.join("/");
      const isHidden = await env.DB.prepare("SELECT 1 FROM hidden WHERE client_slug = ? AND path = ?").bind(c.slug, p).first();
      if (!isHidden) throw new HttpError(409, "Hide this ad first. Only hidden ads can be deleted.");
      const dest = [DELETED_DIR, c.folder, ...segs.slice(0, -1)];
      for (let i = 1; i <= dest.length; i++) {
        const r = await nasWrite(env, user, "MKCOL", dest.slice(0, i));
        if (![201, 405].includes(r.status)) throw new HttpError(502, `The Synology answered ${r.status} when making the deleted-files folder.`);
      }
      const name = await freeName(env, dest, segs[segs.length - 1]);
      const res = await nasWrite(env, user, "MOVE", [c.folder, ...segs], { destination: [...dest, name] });
      if (res.status === 404) {
        // Already gone from the Synology (moved in Finder): just forget it.
      } else if (res.status !== 201 && res.status !== 204) {
        throw new HttpError(502, `The Synology answered ${res.status} to the delete.`);
      }
      await env.DB.batch(
        ["item_status", "likes", "comments", "item_tags", "files", "views", "hidden"].map((t) =>
          env.DB.prepare(`DELETE FROM ${t} WHERE client_slug = ? AND path = ?`).bind(c.slug, p)).concat([
          env.DB.prepare("DELETE FROM campaign_items WHERE path = ? AND campaign_id IN (SELECT id FROM campaigns WHERE client_slug = ?)").bind(p, c.slug),
        ]),
      );
      await logActivity(env, c.slug, p, user.email, "deleted", [DELETED_DIR, c.folder, ...segs.slice(0, -1), name].join("/"));
      return json({ ok: true, movedTo: [...dest, name].join("/") });
    }
    if (action === "status" && method === "POST") {
      const body = await readBody(req);
      const p = cleanPath(String(body.path ?? "")).join("/");
      const status = String(body.status ?? "");
      if (!["pending", "approved", "changes", "rejected"].includes(status)) throw new HttpError(400, "Bad status.");
      for (const q of [p, ...alsoPaths(body, p)]) {
        await env.DB.prepare(
          "INSERT INTO item_status (client_slug, path, status, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(client_slug, path) DO UPDATE SET status = excluded.status, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
        )
          .bind(c.slug, q, status, user.email, now())
          .run();
      }
      await logActivity(env, c.slug, p, user.email, status, null);
      return json(await itemDetail(env, user, c, p));
    }
    if (action === "comments" && !idStr && method === "POST") {
      const body = await readBody(req);
      const p = cleanPath(String(body.path ?? "")).join("/");
      const text = String(body.body ?? "").trim();
      if (!text) throw new HttpError(400, "Comment is empty.");
      if (text.length > 4000) throw new HttpError(400, "Comment is too long (4,000 characters max).");
      // A reply (Genvyd only) joins the thread of the comment it answers.
      if (body.parentId != null) {
        if (!user.admin) throw new HttpError(403, "Only Genvyd can reply to comments.");
        const parent = await env.DB.prepare("SELECT id, parent_id, path FROM comments WHERE id = ? AND client_slug = ?")
          .bind(Number(body.parentId), c.slug).first<{ id: number; parent_id: number | null; path: string }>();
        if (!parent) throw new HttpError(404, "That comment is gone.");
        const root = parent.parent_id ?? parent.id;
        const stmts = [env.DB.prepare("INSERT INTO comments (client_slug, path, email, body, timecode, parent_id, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)")
          .bind(c.slug, parent.path, user.email, text, root, now())];
        if (body.resolve === true) stmts.push(env.DB.prepare("UPDATE comments SET resolved = 1 WHERE id = ?").bind(root));
        await env.DB.batch(stmts);
        await logActivity(env, c.slug, parent.path, user.email, "comment", text.slice(0, 280));
        return json(await itemDetail(env, user, c, parent.path));
      }
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
        // Deleting the first comment of a thread takes its replies with it.
        await env.DB.batch([
          env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(row.id),
          env.DB.prepare("DELETE FROM comments WHERE parent_id = ? AND client_slug = ?").bind(row.id, c.slug),
        ]);
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

      const [changes, approved, openComments, picks, chgComments, chgSiblings, copyChg, copyChgComments] = await env.DB.batch([
        env.DB.prepare("SELECT client_slug, path, updated_by, updated_at FROM item_status s WHERE status = 'changes' AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.client_slug = s.client_slug AND h.path = s.path) ORDER BY updated_at DESC LIMIT 200"),
        env.DB.prepare("SELECT client_slug, path, updated_by, updated_at FROM item_status s WHERE status = 'approved' AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.client_slug = s.client_slug AND h.path = s.path) ORDER BY updated_at DESC LIMIT 300"),
        env.DB.prepare(
          `SELECT id, client_slug, path, email, body, timecode, created_at, ` +
            `(SELECT json_group_array(json_object('email', r.email, 'body', r.body, 'created_at', r.created_at)) FROM (SELECT * FROM comments r WHERE r.parent_id = comments.id ORDER BY r.created_at) r) AS replies ` +
            `FROM comments WHERE resolved = 0 AND parent_id IS NULL AND email NOT IN (${adminMarks}) ORDER BY created_at DESC LIMIT 100`,
        ).bind(...admins),
        env.DB.prepare(
          "SELECT c.client_slug, i.path, c.name FROM campaign_items i JOIN campaigns c ON c.id = i.campaign_id ORDER BY c.name",
        ),
        // Change requests, readable on the dashboard: every comment on a file marked "changes".
        env.DB.prepare(
          "SELECT m.id, m.client_slug, m.path, m.email, m.body, m.timecode, m.resolved, m.parent_id, m.created_at FROM comments m " +
            "JOIN item_status s ON s.client_slug = m.client_slug AND s.path = m.path WHERE s.status = 'changes' ORDER BY m.created_at",
        ),
        // Files in the clients that have change requests, so the page can tell when a newer version is already up.
        env.DB.prepare("SELECT client_slug, path FROM files WHERE client_slug IN (SELECT DISTINCT client_slug FROM item_status WHERE status = 'changes')"),
        env.DB.prepare("SELECT id, client_slug, kind, card, text, ad_path, status_by, status_at, version FROM copy_items WHERE status = 'changes' AND hidden = 0 ORDER BY status_at DESC LIMIT 100"),
        env.DB.prepare(
          "SELECT m.id, m.client_slug, m.path, m.email, m.body, m.resolved, m.parent_id, m.created_at FROM comments m " +
            "JOIN copy_items i ON m.path = 'copy:' || i.id AND m.client_slug = i.client_slug WHERE i.status = 'changes' AND i.hidden = 0 ORDER BY m.created_at",
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
          .map((r) => ({ ...r, replies: JSON.parse(String((r as { replies?: string }).replies || "[]")), clientName: byClient.get(r.client_slug)!.name })),
        changeComments: (chgComments.results as Record<string, unknown>[]).map((m) => ({ ...m, resolved: !!m.resolved, genvyd: admins.includes(String(m.email).toLowerCase()) })),
        changeSiblings: (chgSiblings.results as { client_slug: string; path: string }[]).map((r) => [r.client_slug, r.path]),
        copyChanges: (copyChg.results as Record<string, any>[]).filter((r) => byClient.has(r.client_slug)).map((r) => ({
          ...r, clientName: byClient.get(r.client_slug)!.name,
          comments: (copyChgComments.results as Record<string, any>[]).filter((m) => m.path === `copy:${r.id}`)
            .map((m) => ({ ...m, resolved: !!m.resolved, genvyd: admins.includes(String(m.email).toLowerCase()) })),
        })),
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

    if (path === "/api/admin/feed" && method === "POST") {
      return json({ ok: true, folder: FEED_DIR, ...(await writeFeed(env, true)) });
    }
    if (path === "/api/admin/feed" && method === "GET") {
      const last = await env.DB.prepare("SELECT value FROM notify_state WHERE key = 'feed_last'").first<{ value: string }>();
      return json({ folder: FEED_DIR, last: last ? Number(last.value) : null });
    }
    if (path === "/api/admin/backups" && method === "GET") {
      const last = await env.DB.prepare("SELECT value FROM notify_state WHERE key = 'backup_last'").first<{ value: string }>();
      let list: Awaited<ReturnType<typeof listBackups>> = [];
      let error: string | null = null;
      try { list = (await listBackups(env)).slice(0, 30); } catch (e) { error = e instanceof Error ? e.message : "Could not list backups."; }
      return json({ last: last ? JSON.parse(last.value) : null, backups: list, folder: BACKUP_DIR, error });
    }
    if (path === "/api/admin/backups" && method === "POST") {
      return json({ ok: true, ...(await writeBackup(env, "manual")) });
    }
    if (path === "/api/admin/backups/file" && method === "GET") {
      const name = url.searchParams.get("name") || "";
      const res = await readBackup(env, name);
      return new Response(res.body, {
        headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
      });
    }
    if (path === "/api/admin/backups/restore" && method === "POST") {
      const body = await readBody(req);
      return json({ ok: true, ...(await restoreBackup(env, String(body.name ?? ""))) });
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
          folders: entries.filter((e) => e.type === "directory" && !/^[.@#]/.test(e.name) && ![BACKUP_DIR, DELETED_DIR, FEED_DIR].includes(e.name)).map((e) => e.name),
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
  await sendEmail(env, w.subject, w.html, w.text, { to: [email], from: env.CLIENT_NOTIFY_FROM, replyTo: clientReplyTo(env) });
  await env.DB.prepare("UPDATE members SET welcomed_at = ? WHERE client_slug = ? AND email = ?").bind(now(), slug, email).run();
  return { sent: true };
}

// ---------------------------------------------------------------------------
// Email digest: what clients did since the last email, sent every 15 minutes
// at most, and only when there is something to report.
// ---------------------------------------------------------------------------

type ActivityRow = { id: number; client_slug: string; path: string; email: string; kind: string; detail: string | null; created_at: number };
const DIGEST_KINDS = ["campaign_approved", "campaign_changes", "approved", "changes", "rejected", "comment", "campaign_add", "like", "hidden"];

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function itemLink(env: Env, slug: string, path: string) {
  const base = (env.PORTAL_URL || "https://clients.genvyd.com").replace(/\/+$/, "");
  if (path.startsWith("copy:")) return `${base}/#/c/${encodeURIComponent(slug)}/copy`;
  if (SUMMARY_FILE.test(path)) {
    const dir = path.split("/").slice(0, -1).join("/");
    return `${base}/#/c/${encodeURIComponent(slug)}${dir ? "/f/" + encodeURIComponent(dir) : ""}`;
  }
  return `${base}/#/c/${encodeURIComponent(slug)}/i/${encodeURIComponent(path)}`;
}

// Other sizes of the same ad (e.g. the 4x5 next to a 9x16). The portal shows them as one
// ad, so approving, favoriting or picking it for a campaign covers every size. Capped and
// cleaned like any path; only the main path is logged, so the digest lists the ad once.
function alsoPaths(body: Record<string, unknown>, main: string): string[] {
  const raw = Array.isArray(body.also) ? body.also.slice(0, 60) : []; // a carousel: up to 10 cards in several sizes
  const out = new Set<string>();
  for (const a of raw) {
    const q = cleanPath(String(a ?? "")).join("/");
    if (q && q !== main) out.add(q);
  }
  return [...out];
}

// Where client replies go (welcome and new-work emails). Falls back to NOTIFY_TO.
function clientReplyTo(env: Env) {
  return (env.CLIENT_REPLY_TO || env.NOTIFY_TO || env.ADMIN_EMAILS || "").split(",")[0]?.trim() || undefined;
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
    count("campaign_approved") && `${count("campaign_approved")} campaign${count("campaign_approved") === 1 ? "" : "s"} approved`,
    count("campaign_changes") && `${count("campaign_changes")} campaign change request${count("campaign_changes") === 1 ? "" : "s"}`,
    count("approved") && `${count("approved")} approved`,
    count("changes") && `${count("changes")} change request${count("changes") === 1 ? "" : "s"}`,
    count("rejected") && `${count("rejected")} said no`,
    count("comment") && `${count("comment")} comment${count("comment") === 1 ? "" : "s"}`,
    count("campaign_add") && `${count("campaign_add")} campaign pick${count("campaign_add") === 1 ? "" : "s"}`,
    count("like") && `${count("like")} favorite${count("like") === 1 ? "" : "s"}`,
    count("hidden") && `${count("hidden")} moved to trash`,
  ].filter(Boolean);
  const clientList = [...new Set(rows.map((r) => names.get(r.client_slug) || r.client_slug))];
  const subject = `${clientList.join(", ")}: ${bits.join(", ")}`;

  const LABEL: Record<string, string> = {
    campaign_approved: "Campaign approved and signed (ready to launch)",
    campaign_changes: "Campaign summary: changes requested",
    changes: "Changes requested",
    rejected: "Said no (don't use these)",
    comment: "New comments",
    approved: "Approved",
    campaign_add: "Added to campaigns",
    like: "Favorited",
    hidden: "Moved to trash (they don't want these)",
  };
  const order = ["campaign_approved", "campaign_changes", "changes", "rejected", "comment", "approved", "campaign_add", "like", "hidden"];
  let html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:620px">`;
  let text = "";
  for (const slug of [...new Set(rows.map((r) => r.client_slug))]) {
    const name = names.get(slug) || slug;
    html += `<h2 style="margin:24px 0 8px;font-size:18px">${esc(name)}</h2>`;
    text += `\n${name}\n`;
    for (const kind of order) {
      const list = rows.filter((r) => r.client_slug === slug && r.kind === kind);
      if (!list.length) continue;
      html += `<p style="margin:14px 0 6px;font-weight:bold;color:${kind === "changes" || kind === "campaign_changes" ? "#b26a00" : kind === "rejected" ? "#c4161c" : kind === "approved" || kind === "campaign_approved" ? "#127a3f" : "#111"}">${LABEL[kind]}</p><ul style="margin:0;padding-left:18px">`;
      text += `  ${LABEL[kind]}:\n`;
      for (const r of list) {
        const file = r.path.startsWith("copy:") ? (kind === "comment" ? "Ad copy" : `Ad copy "${r.detail ?? ""}"`) : r.path.split("/").pop() || r.path;
        const link = itemLink(env, slug, r.path);
        const extra = (kind === "comment" || kind === "campaign_changes" || kind === "campaign_approved") && r.detail ? `: "${r.detail}"` : kind === "campaign_add" && r.detail && !r.path.startsWith("copy:") ? ` (${r.detail})` : "";
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
    const copyFiles: { path: string; size?: number; mtime?: string }[] = [];
    const summaries: string[] = [];
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
          if (e.type === "file" && COPY_FILE.test(e.name)) copyFiles.push({ path: [...segs, e.name].join("/"), size: e.size, mtime: e.mtime });
          else if (e.type === "file" && SUMMARY_FILE.test(e.name)) summaries.push([...segs, e.name].join("/"));
          else if (e.type === "file") found.push([...segs, e.name].join("/"));
          else if (segs.length < 3) next.push([...segs, e.name]);
        }
      }
      if (!complete) break;
      queue = next;
    }
    await registerFiles(env, c.slug, found);
    if (summaries.length) await noteSummaries(env, c.slug, "", summaries, false);
    if (copyFiles.length && budget >= 3) budget -= await syncCopyFiles(env, c, copyFiles, 2);
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
        await sendEmail(env, subject, html, text, { to, from: env.CLIENT_NOTIFY_FROM, replyTo: clientReplyTo(env) });
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

// ---------------------------------------------------------------------------
// Campaign summaries and approvals.
//
// Anthony (or Claude) saves "<Campaign name>.summary.md" in a client folder: the ads, copy,
// price, budget, dates and audience, written out. Optional front matter lists the ads:
//   ---
//   ads: [Final ads/Golf Polo - Instagram Feed.png, October Ads/golf 4x5.png]
//   budget: "$500 lifetime"
//   start: "On approval"
//   end: "2026-11-06"
//   ---
// The client reads it on a pinned card and approves it in two steps (tick + typed name, then a
// final confirmation). Every approval is stored with who, when, IP, device, a SHA-256 of the
// summary, the name, size and modified time of each listed ad and copy file (copy files are
// hashed too) and a frozen copy of the text. If any of that changes later the approval no
// longer applies: a "reset" is recorded and the client is asked again. campaign_events is
// append only (database triggers refuse UPDATE and DELETE). Nothing is written in client folders.
// ---------------------------------------------------------------------------

const SUMMARY_FILE = /\.summary\.md$/i;
const AGREE_TEXT =
  "I have reviewed every ad, image, video and line of copy in this campaign, including the price, links, budget, dates and audience, and everything is correct.";
const CONFIRM_TEXT =
  "By approving, I confirm on behalf of my business that I have reviewed and accept the ads, images, videos, copy, pricing, links, budget and schedule exactly as shown in this summary. Genvyd will publish the campaign as approved. Genvyd is not responsible for errors in content I approved, for advertising results or sales, or for decisions made by the ad platform (such as ad review, delivery, or how quickly the approved budget is spent). Any change after approval requires a new approval.";
const MAX_SUMMARY_ADS = 40;

async function sha256Hex(data: string | ArrayBuffer) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "Oct 21, 2026, 2:15 PM MST". Phoenix has no daylight saving, so it is always UTC-7. */
function phxTime(ms: number) {
  const d = new Date(ms - 7 * 3600 * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let hr = d.getUTCHours();
  const ap = hr >= 12 ? "PM" : "AM";
  hr = hr % 12 || 12;
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hr}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ap} MST`;
}

/** Splits optional front matter ("---" lines at the very top) from the Markdown body. */
function parseFrontMatter(text: string) {
  const src = text.replace(/^﻿/, "").replace(/\r/g, "");
  const meta: Record<string, string | string[]> = {};
  const m = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { meta, body: src };
  const unq = (s: string) => s.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/^'([\s\S]*)'$/, "$1").trim();
  let listKey: string | null = null;
  for (const raw of m[1].split("\n")) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const item = raw.match(/^\s+-\s+(.*)$/) || (listKey ? raw.match(/^-\s+(.*)$/) : null);
    if (item && listKey) { (meta[listKey] as string[]).push(unq(item[1])); continue; }
    const kv = raw.match(/^([A-Za-z][\w -]{0,30}):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const val = kv[2].trim();
    listKey = null;
    if (!val) { meta[key] = []; listKey = key; continue; }
    if (val.startsWith("[") && val.endsWith("]")) {
      const parts: string[] = [];
      const re = /"([^"]*)"|'([^']*)'|([^,]+)/g;
      let x: RegExpExecArray | null;
      while ((x = re.exec(val.slice(1, -1)))) { const v = (x[1] ?? x[2] ?? x[3] ?? "").trim(); if (v) parts.push(v); }
      meta[key] = parts;
    } else meta[key] = unq(val);
  }
  return { meta, body: src.slice(m[0].length) };
}

// The copy file that belongs to an ad: same name once size, version, card, placement and
// extension are taken off (the same idea as the portal's copyKey()).
function adKeyOf(name: string, inFinal: boolean) {
  let s = name.replace(COPY_FILE, "").replace(/\.[^.]+$/, "");
  if (inFinal) s = s.replace(/\s+-\s+[^-]+$/, "");
  return s
    .replace(/(?:^|[\s_\-.(\[])(?:card|slide)\s*#?\s*\d{1,2}(?=$|[\s_\-.)\]])/gi, " ")
    .replace(/(?:^|[\s_\-.(\[])\d{1,2}\s*[x×:]\s*\d{1,2}(?=$|[\s_\-.)\]])/gi, " ")
    .replace(/(?:^|[\s_\-.(\[])(?:v|ver|version|rev)\s*\.?\s*\d{1,3}(?=$|[\s_\-.)\]])/gi, " ")
    .replace(/\s*\(\d{1,2}\)\s*$/, "")
    .replace(/\b(feed|stories|story|reels?|post|square|vertical|portrait|landscape|horizontal)\b/gi, " ")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

type SummaryFile = { role: "summary" | "ad" | "copy"; path: string; name: string; mtime: string | null; size: number | null; exists: boolean; sha256?: string };
type LoadedSummary = {
  path: string; name: string; dir: string; campaign: string; exists: boolean;
  text: string; body: string; sha: string; mtime: string | null; size: number | null;
  meta: { budget: string | null; start: string | null; end: string | null };
  ads: { raw: string; path: string; name: string; kind: string; exists: boolean; mtime: string | null; size: number | null; copy: { path: string; text?: string; sha256?: string; mtime: string | null; size: number | null } | null }[];
  files: SummaryFile[]; sig: string;
};

/** Reads a summary and everything it lists. `full` also reads (and hashes) each copy file. */
async function loadSummary(env: Env, c: Client, path: string, full: boolean): Promise<LoadedSummary | null> {
  const segs = cleanPath(path);
  const name = segs[segs.length - 1];
  if (!SUMMARY_FILE.test(name)) throw new HttpError(400, "That is not a campaign summary.");
  const dir = segs.slice(0, -1).join("/");
  const listings = new Map<string, NasEntry[] | null>();
  const ls = async (d: string) => {
    if (listings.has(d)) return listings.get(d)!;
    if (listings.size >= 8) return null; // keep each check to a handful of Synology calls
    let e: NasEntry[] | null = null;
    try { e = await listNas(env, c.folder, d ? d.split("/") : []); } catch (err) { if (!(err instanceof HttpError && err.status === 404)) throw err; }
    listings.set(d, e);
    return e;
  };
  const here = await ls(dir);
  const entry = here?.find((e) => e.type === "file" && e.name === name);
  if (!entry) return null;
  const res = await fetch(originUrl(env, c.folder, segs), { headers: originHeaders(env) });
  if (!res.ok) throw new HttpError(502, `The Synology answered ${res.status} for the summary.`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 300_000) throw new HttpError(413, "That summary file is too big (300 KB max).");
  const text = new TextDecoder().decode(buf);
  const sha = await sha256Hex(buf);
  const { meta, body } = parseFrontMatter(text);
  const str = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v ? String(v) : null);
  const rawAds = (Array.isArray(meta.ads) ? meta.ads : meta.ads ? [String(meta.ads)] : []).slice(0, MAX_SUMMARY_ADS);

  const ads: LoadedSummary["ads"] = [];
  for (const raw of rawAds) {
    const clean = raw.replace(/^\.?\/+/, "").replace(/^\/Volumes\/GenvydClients\/[^/]+\//, "");
    // A path is relative to the client folder; a bare name is looked for next to the summary first.
    const tries = [...new Set([clean.includes("/") ? clean : (dir ? `${dir}/${clean}` : clean), clean, dir ? `${dir}/${clean}` : clean])];
    let found: { path: string; e: NasEntry } | null = null;
    for (const t of tries) {
      let s: string[];
      try { s = cleanPath(t); } catch { continue; }
      const list = await ls(s.slice(0, -1).join("/"));
      const e = list?.find((x) => x.type === "file" && x.name === s[s.length - 1]);
      if (e) { found = { path: s.join("/"), e }; break; }
    }
    const p = found?.path ?? (tries[0] || clean);
    const nm = p.split("/").pop() || p;
    let copy: LoadedSummary["ads"][number]["copy"] = null;
    if (found) {
      const fdir = p.split("/").slice(0, -1).join("/");
      const inFinal = fdir === "Final ads" || fdir.startsWith("Final ads/");
      const key = adKeyOf(nm, inFinal);
      const cf = (listings.get(fdir) ?? []).find((x) => x.type === "file" && COPY_FILE.test(x.name) && adKeyOf(x.name, inFinal) === key);
      if (cf) copy = { path: fdir ? `${fdir}/${cf.name}` : cf.name, mtime: cf.mtime ?? null, size: cf.size ?? null };
    }
    ads.push({ raw, path: p, name: nm, kind: kindOf(nm), exists: !!found, mtime: found?.e.mtime ?? null, size: found?.e.size ?? null, copy });
  }
  if (full) {
    const texts = new Map<string, { text: string; sha256: string }>();
    for (const a of ads) {
      if (!a.copy) continue;
      if (!texts.has(a.copy.path)) {
        try {
          const r = await fetch(originUrl(env, c.folder, a.copy.path.split("/")), { headers: originHeaders(env) });
          if (r.ok) { const b = await r.arrayBuffer(); texts.set(a.copy.path, { text: new TextDecoder().decode(b).slice(0, 20000), sha256: await sha256Hex(b) }); }
        } catch { /* shown without its text */ }
      }
      Object.assign(a.copy, texts.get(a.copy.path) ?? {});
    }
  }
  const files: SummaryFile[] = [
    { role: "summary", path: segs.join("/"), name, mtime: entry.mtime ?? null, size: entry.size ?? null, exists: true, sha256: sha },
    ...ads.map((a) => ({ role: "ad" as const, path: a.path, name: a.name, mtime: a.mtime, size: a.size, exists: a.exists })),
  ];
  for (const a of ads) {
    if (a.copy && !files.some((f) => f.path === a.copy!.path)) {
      files.push({ role: "copy", path: a.copy.path, name: a.copy.path.split("/").pop()!, mtime: a.copy.mtime, size: a.copy.size, exists: true, ...(a.copy.sha256 ? { sha256: a.copy.sha256 } : {}) });
    }
  }
  // What an approval is tied to: the summary's exact text, and each listed file's name, size and date.
  const sig = await sha256Hex(JSON.stringify([sha, files.filter((f) => f.role !== "summary").map((f) => [f.role, f.path, f.mtime ?? "", f.size ?? "", f.exists])]));
  return {
    path: segs.join("/"), name, dir, campaign: str(meta.campaign) || str(meta.name) || name.replace(SUMMARY_FILE, ""), exists: true,
    text, body, sha, mtime: entry.mtime ?? null, size: entry.size ?? null,
    meta: { budget: str(meta.budget), start: str(meta.start), end: str(meta.end) },
    ads, files, sig,
  };
}

type CampaignEvent = {
  id: number; client_slug: string; summary_path: string; campaign: string | null; kind: "approved" | "changes" | "reset";
  email: string | null; typed_name: string | null; comment: string | null; at: number; at_utc: string; at_phoenix: string;
  ip: string | null; user_agent: string | null; summary_sha256: string | null; sig: string | null; files_json: string | null;
  frozen_text: string | null; agreement_text: string | null; detail: string | null;
};

const STATUS_TEXT: Record<string, string> = {
  needs: "Needs approval",
  approved: "Approved",
  changes: "Changes requested",
  changed: "Changed since approval, needs re-approval",
};

/** What changed between the files an approval covered and the files now. */
function describeChanges(before: SummaryFile[], cur: LoadedSummary | null) {
  if (!cur) return "The summary file was removed or renamed.";
  const out: string[] = [];
  const b0 = before.find((f) => f.role === "summary");
  if (b0 && b0.sha256 !== cur.sha) out.push("The summary text changed.");
  const now0 = new Map(cur.files.map((f) => [f.path, f]));
  for (const f of before.filter((x) => x.role !== "summary")) {
    const n = now0.get(f.path);
    if (!n) out.push(`${f.name} is no longer listed.`);
    else if (!n.exists && f.exists) out.push(`${f.name} is missing.`);
    else if (n.mtime !== f.mtime || n.size !== f.size) out.push(`${f.name} changed.`);
  }
  for (const f of cur.files.filter((x) => x.role !== "summary")) if (!before.some((b) => b.path === f.path)) out.push(`${f.name} was added.`);
  return out.join(" ") || "Something in the campaign changed.";
}

/**
 * The campaign's current status. When `cur` (the files as they are now) is given and the
 * campaign was approved for different files, records a reset first (once).
 */
async function summaryStatus(env: Env, c: Client, path: string, cur?: LoadedSummary | null): Promise<{ status: string; statusText: string; updatedAfterChanges: boolean; approval: CampaignEvent | null; lastChange: CampaignEvent | null; lastReset: CampaignEvent | null; events: CampaignEvent[] }> {
  const events = (await env.DB.prepare("SELECT * FROM campaign_events WHERE client_slug = ? AND summary_path = ? ORDER BY id")
    .bind(c.slug, path).all<CampaignEvent>()).results;
  const last = events[events.length - 1];
  if (last && last.kind === "approved" && cur !== undefined && (!cur || cur.sig !== last.sig)) {
    const t = now();
    const detail = describeChanges(JSON.parse(last.files_json || "[]"), cur);
    // Only if nothing was recorded since we read the list (two page loads at once record one reset).
    await env.DB.prepare(
      "INSERT INTO campaign_events (client_slug, summary_path, campaign, kind, email, at, at_utc, at_phoenix, summary_sha256, sig, files_json, detail) " +
        "SELECT ?, ?, ?, 'reset', 'portal', ?, ?, ?, ?, ?, ?, ? WHERE (SELECT MAX(id) FROM campaign_events WHERE client_slug = ? AND summary_path = ?) = ?",
    ).bind(c.slug, path, cur?.campaign ?? last.campaign, t, new Date(t).toISOString(), phxTime(t), cur?.sha ?? null, cur?.sig ?? null,
      cur ? JSON.stringify(cur.files) : null, detail, c.slug, path, last.id).run();
    return summaryStatus(env, c, path);
  }
  let status = "needs";
  let updatedAfterChanges = false;
  if (last?.kind === "approved") status = "approved";
  else if (last?.kind === "reset") status = "changed";
  else if (last?.kind === "changes") {
    if (cur && cur.sig !== last.sig) { status = "needs"; updatedAfterChanges = true; } else status = "changes";
  }
  const approval = status === "approved" ? last : null;
  const lastChange = [...events].reverse().find((e) => e.kind === "changes") ?? null;
  return { status, statusText: STATUS_TEXT[status], updatedAfterChanges, approval, lastChange, lastReset: last?.kind === "reset" ? last : null, events };
}

/** Remembers summary files the portal has come across, and forgets ones gone from a folder. */
async function noteSummaries(env: Env, slug: string, dir: string, names: string[], prune: boolean) {
  const prefix = dir ? dir + "/" : "";
  const t = now();
  const stmts = names.map((n) =>
    env.DB.prepare("INSERT INTO campaign_summaries (client_slug, path, first_seen, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT (client_slug, path) DO UPDATE SET last_seen = excluded.last_seen, gone = 0")
      .bind(slug, prefix + n, t, t));
  // Summaries were plain files before this feature: take them out of the file list.
  for (const n of names) stmts.push(env.DB.prepare("DELETE FROM files WHERE client_slug = ? AND path = ?").bind(slug, prefix + n));
  if (prune) {
    const like = prefix.replace(/[%_\\]/g, (x) => "\\" + x) + "%";
    const known = (await env.DB.prepare("SELECT path FROM campaign_summaries WHERE client_slug = ? AND gone = 0 AND path LIKE ? ESCAPE '\\'").bind(slug, like).all<{ path: string }>()).results;
    for (const k of known) {
      const rest = k.path.slice(prefix.length);
      if (!rest.includes("/") && !names.includes(rest)) stmts.push(env.DB.prepare("UPDATE campaign_summaries SET gone = 1 WHERE client_slug = ? AND path = ?").bind(slug, k.path));
    }
  }
  if (stmts.length) await env.DB.batch(stmts.slice(0, 90));
}

const eventView = (e: CampaignEvent, admin: boolean) => ({
  id: e.id, kind: e.kind, email: e.email, name: e.typed_name, comment: e.comment, at: e.at, atPhoenix: e.at_phoenix, atUtc: e.at_utc,
  detail: e.detail, campaign: e.campaign,
  ...(admin ? { ip: e.ip, userAgent: e.user_agent, summarySha256: e.summary_sha256 } : {}),
});

/** Everything the summary card needs. */
async function summaryView(env: Env, user: User, c: Client, path: string) {
  const cur = await loadSummary(env, c, path, true);
  const p = cleanPath(path).join("/");
  if (!cur) {
    await env.DB.prepare("UPDATE campaign_summaries SET gone = 1 WHERE client_slug = ? AND path = ?").bind(c.slug, p).run();
    const st = await summaryStatus(env, c, p, null);
    throw new HttpError(404, st.events.length ? "This campaign summary was removed or renamed." : "That campaign summary is not on the Synology.");
  }
  await noteSummaries(env, c.slug, cur.dir, [cur.name], false);
  await env.DB.prepare("UPDATE campaign_summaries SET last_sig = ?, last_checked = ? WHERE client_slug = ? AND path = ?").bind(cur.sig, now(), c.slug, p).run();
  const st = await summaryStatus(env, c, p, cur);
  const comments = (await itemDetail(env, user, c, p)).comments;
  return {
    path: p, name: cur.name, dir: cur.dir, campaign: cur.campaign, body: cur.body, meta: cur.meta, sig: cur.sig, sha256: cur.sha,
    ads: cur.ads.map((a) => ({ raw: a.raw, path: a.path, name: a.name, kind: a.kind, exists: a.exists, copy: a.copy ? { path: a.copy.path, text: a.copy.text ?? null } : null })),
    status: st.status, statusText: st.statusText, updatedAfterChanges: st.updatedAfterChanges,
    approval: st.approval ? eventView(st.approval, user.admin) : null,
    lastChange: st.lastChange ? eventView(st.lastChange, user.admin) : null,
    lastReset: st.lastReset ? eventView(st.lastReset, user.admin) : null,
    history: user.admin ? st.events.map((e) => eventView(e, true)).reverse() : [],
    comments,
    agreeText: AGREE_TEXT, confirmText: CONFIRM_TEXT,
    canApprove: !user.admin,
  };
}

/** The client's campaigns and their status, for the banner on their home page. */
async function summariesList(env: Env, c: Client) {
  const rows = (await env.DB.prepare("SELECT path FROM campaign_summaries WHERE client_slug = ? AND gone = 0 ORDER BY first_seen DESC LIMIT 8").bind(c.slug).all<{ path: string }>()).results;
  const out = await Promise.all(rows.map(async (r) => {
    try {
      const cur = await loadSummary(env, c, r.path, false);
      if (!cur) {
        await env.DB.prepare("UPDATE campaign_summaries SET gone = 1 WHERE client_slug = ? AND path = ?").bind(c.slug, r.path).run();
        await summaryStatus(env, c, r.path, null); // an approval of a removed summary no longer stands
        return null;
      }
      await env.DB.prepare("UPDATE campaign_summaries SET last_sig = ?, last_checked = ? WHERE client_slug = ? AND path = ?").bind(cur.sig, now(), c.slug, r.path).run();
      const st = await summaryStatus(env, c, r.path, cur);
      return { path: r.path, dir: cur.dir, campaign: cur.campaign, status: st.status, statusText: st.statusText, approval: st.approval ? { name: st.approval.typed_name, atPhoenix: st.approval.at_phoenix } : null };
    } catch { return null; }
  }));
  return out.filter(Boolean);
}

/** The 15 minute run: re-check a few approved campaigns so a changed file resets them even if nobody looks. */
async function checkApprovals(env: Env) {
  const rows = (await env.DB.prepare(
    "SELECT s.client_slug, s.path, c.name, c.folder FROM campaign_summaries s JOIN clients c ON c.slug = s.client_slug " +
      "WHERE s.gone = 0 AND EXISTS (SELECT 1 FROM campaign_events e WHERE e.client_slug = s.client_slug AND e.summary_path = s.path) " +
      "ORDER BY IFNULL(s.last_checked, 0) LIMIT 3",
  ).all<{ client_slug: string; path: string; name: string; folder: string }>()).results;
  for (const r of rows) {
    const c: Client = { slug: r.client_slug, name: r.name, folder: r.folder };
    try {
      const cur = await loadSummary(env, c, r.path, false);
      if (!cur) await env.DB.prepare("UPDATE campaign_summaries SET gone = 1 WHERE client_slug = ? AND path = ?").bind(c.slug, r.path).run();
      await env.DB.prepare("UPDATE campaign_summaries SET last_sig = ?, last_checked = ? WHERE client_slug = ? AND path = ?").bind(cur?.sig ?? null, now(), c.slug, r.path).run();
      await summaryStatus(env, c, r.path, cur);
    } catch (err) { console.error("approval check failed", r.path, err); }
  }
}

/** The approval record as a PDF: signature, what was agreed, every file with hashes, the frozen summary. */
async function approvalRecordPdf(env: Env, c: Client, id: number) {
  const e = await env.DB.prepare("SELECT * FROM campaign_events WHERE id = ? AND client_slug = ?").bind(id, c.slug).first<CampaignEvent>();
  if (!e || e.kind !== "approved") throw new HttpError(404, "That approval record is not here.");
  const history = (await env.DB.prepare("SELECT * FROM campaign_events WHERE client_slug = ? AND summary_path = ? ORDER BY id").bind(c.slug, e.summary_path).all<CampaignEvent>()).results;
  const files = JSON.parse(e.files_json || "[]") as SummaryFile[];
  const frozenSha = await sha256Hex(e.frozen_text ?? "");
  const blocks: PdfBlock[] = [
    { kind: "title", text: "Campaign approval record" },
    { kind: "text", text: `Record #${e.id} from clients.genvyd.com (Genvyd). This record was stored when the client approved and cannot be edited.` },
    { kind: "heading", text: "Campaign" },
    { kind: "field", label: "Client", value: c.name },
    { kind: "field", label: "Campaign", value: e.campaign ?? "" },
    { kind: "field", label: "Summary file", value: e.summary_path },
    { kind: "field", label: "On the Synology", value: `${MAC_SHARE}/${c.folder}/${e.summary_path}` },
    { kind: "heading", text: "Signature" },
    { kind: "field", label: "Typed name", value: e.typed_name ?? "" },
    { kind: "field", label: "Login email", value: e.email ?? "" },
    { kind: "field", label: "Approved (UTC)", value: e.at_utc },
    { kind: "field", label: "Approved (Phoenix)", value: e.at_phoenix },
    { kind: "field", label: "IP address", value: e.ip ?? "not recorded" },
    { kind: "field", label: "Device", value: e.user_agent ?? "not recorded" },
    { kind: "field", label: "Login", value: "Cloudflare Access one-time code sent to the login email" },
    { kind: "heading", text: "What the client agreed to" },
    { kind: "text", text: "Step 1. Ticked the box:", bold: true },
    { kind: "text", text: `"${AGREE_TEXT}"` },
    { kind: "space", size: 4 },
    { kind: "text", text: 'Step 2. In the "Final confirmation" dialog, pressed "Yes, approve and launch" after this text:', bold: true },
    { kind: "text", text: `"${CONFIRM_TEXT}"` },
    ...(e.agreement_text && e.agreement_text !== `${AGREE_TEXT}\n\n${CONFIRM_TEXT}` ? [{ kind: "text" as const, text: `Text shown at the time: ${e.agreement_text}` }] : []),
    { kind: "heading", text: "Files at the moment of approval" },
    { kind: "text", text: "The summary and copy files are identified by a SHA-256 hash of their exact contents. Ads (images and videos) are identified by file name, size and modified time on the Synology. If any of these change, the approval no longer applies and the client is asked again." },
    { kind: "space", size: 4 },
  ];
  for (const f of files) {
    blocks.push({ kind: "text", text: `${f.role === "summary" ? "Summary" : f.role === "copy" ? "Ad copy" : "Ad"}: ${f.path}`, bold: true });
    blocks.push({ kind: "mono", text: `  modified ${f.mtime ?? "unknown"}   size ${f.size ?? "unknown"} bytes${f.exists ? "" : "   (MISSING when approved)"}${f.sha256 ? `\n  sha256 ${f.sha256}` : ""}` });
  }
  blocks.push({ kind: "heading", text: "History of this campaign" });
  for (const h of history) {
    const what = h.kind === "approved" ? `Approved by ${h.typed_name} (${h.email})` : h.kind === "changes" ? `Changes requested by ${h.email}` : "Reset: changed since approval, needs re-approval";
    blocks.push({ kind: "text", text: `#${h.id}  ${h.at_phoenix}: ${what}${h.id === e.id ? "  (this record)" : ""}` });
    if (h.comment) blocks.push({ kind: "text", text: `     Comment: ${h.comment}` });
    if (h.detail) blocks.push({ kind: "text", text: `     ${h.detail}` });
  }
  blocks.push({ kind: "heading", text: "The summary exactly as approved" });
  blocks.push({ kind: "text", text: `SHA-256 of the text below: ${frozenSha}${e.summary_sha256 && e.summary_sha256 !== frozenSha ? ` (file hash recorded: ${e.summary_sha256})` : ""}` });
  blocks.push({ kind: "space", size: 6 });
  blocks.push({ kind: "mono", text: e.frozen_text ?? "" });
  return makePdf(blocks, `Genvyd campaign approval record #${e.id} · ${c.name} · ${e.campaign ?? ""} · generated ${phxTime(now())}`);
}

export default {
  async scheduled(ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (ctrl.cron === FEED_CRON) {
      ctx.waitUntil(writeFeed(env).catch((err) => console.error("feed failed", err)));
      return;
    }
    if (ctrl.cron === BACKUP_CRON) {
      ctx.waitUntil(writeBackup(env, "nightly").then((i) => console.log("backup saved", i.name)).catch((err) => console.error("backup failed", err)));
      return;
    }
    ctx.waitUntil(
      (async () => {
        await runDigest(env).catch((err) => console.error("digest failed", err));
        await runClientAlerts(env).catch((err) => console.error("client alerts failed", err));
        await checkApprovals(env).catch((err) => console.error("approval checks failed", err));
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
