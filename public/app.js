/* Genvyd client review portal. Plain JS, no build step. */
(() => {
  "use strict";

  const app = document.getElementById("app");
  const state = { me: null, listCache: new Map(), curHash: null, backTo: null, scroll: new Map() };
  const clean = (kids) => kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false);
  // Replace an element's contents, skipping empty slots (null, false) so they never print as text.
  const fill = (el, ...kids) => el.replaceChildren(...clean(kids));
  const show = (...kids) => fill(app, ...kids);

  // ---- tiny helpers -------------------------------------------------------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v; // only ever used with static strings
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  const enc = encodeURIComponent;
  const mediaUrl = (slug, path) => `/media/${enc(slug)}/${path.split("/").map(enc).join("/")}`;
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60), r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  };
  const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtSize = (b) => (b == null ? "" : b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
  const who = (email) => (state.me && email === state.me.email ? "You" : email);
  const STATUS_LABEL = { pending: "Awaiting review", approved: "Approved", changes: "Changes requested" };
  const parentOf = (p) => p.split("/").slice(0, -1).join("/");
  const baseName = (p) => p.split("/").pop();

  function errorCard(err) {
    return h("div", { class: "card error" }, err.message || String(err));
  }

  function crumbs(client, dir, extra) {
    const out = [h("a", { href: "#/" }, "Home"), h("span", { class: "sep" }, "/")];
    out.push(h("a", { href: `#/c/${enc(client.slug)}` }, client.name));
    const segs = dir ? dir.split("/") : [];
    segs.forEach((s, i) => {
      out.push(h("span", { class: "sep" }, "/"));
      out.push(h("a", { href: `#/c/${enc(client.slug)}/f/${enc(segs.slice(0, i + 1).join("/"))}` }, s));
    });
    if (extra) out.push(h("span", { class: "sep" }, "/"), h("span", {}, extra));
    return h("div", { class: "crumbs" }, out);
  }

  // Projects / Favorites / Campaigns switcher at the top of each client.
  function clientTabs(slug, active) {
    const tab = (key, label, href) => h("a", { class: "tab" + (active === key ? " active" : ""), href }, label);
    return h("nav", { class: "tabs" },
      tab("projects", "Projects", `#/c/${enc(slug)}`),
      tab("favorites", "♥ Favorites", `#/c/${enc(slug)}/favorites`),
      tab("campaigns", "Campaigns", `#/c/${enc(slug)}/campaigns`),
    );
  }

  // Lazy-load thumbnails so a big folder does not hammer the Synology at once.
  const lazy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      el.src = el.dataset.src;
      lazy.unobserve(el);
    }
  }, { rootMargin: "300px" });

  // ---- views --------------------------------------------------------------

  async function viewHome() {
    if (state.me.admin) return viewDashboard();
    const clients = state.me.clients;
    if (!state.me.admin && clients.length === 1) {
      location.replace(`#/c/${enc(clients[0].slug)}`);
      return;
    }
    if (!clients.length) {
      show(
        h("div", { class: "card empty" },
          h("h2", {}, "Nothing to review yet"),
          h("p", { class: "muted" },
            state.me.admin
              ? "Add your first client on the Admin page."
              : `You are signed in as ${state.me.email}, but this email is not linked to a project yet. Ask Genvyd to add it.`),
          state.me.admin ? h("a", { class: "btn primary", href: "#/admin" }, "Open Admin") : null,
        ),
      );
      return;
    }
    show(
      h("div", { class: "page-head" }, h("h1", {}, "Your projects")),
      h("div", { class: "grid" },
        clients.map((c) =>
          h("a", { class: "card folder-card", href: `#/c/${enc(c.slug)}` },
            h("div", { class: "folder-icon", html: ICON_FOLDER }),
            h("div", {}, h("h3", {}, c.name), h("div", { class: "mono muted" }, "Open")),
          ),
        ),
      ),
    );
  }

  // ---- studio dashboard (admin home) -----------------------------------
  const SEEN_KEY = "gv-last-seen";
  async function viewDashboard() {
    show(h("p", { class: "muted" }, "Loading your dashboard…"));
    let dash, overview;
    try {
      [dash, overview] = await Promise.all([api("GET", "/api/admin/dashboard"), api("GET", "/api/admin/overview")]);
    } catch (err) {
      show(errorCard(err));
      return;
    }
    let lastSeen = 0;
    try { lastSeen = Number(localStorage.getItem(SEEN_KEY) || 0); localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* private window */ }
    const fromClients = overview.activity.filter((a) => a.email !== state.me.email);
    const fresh = fromClients.filter((a) => a.created_at > lastSeen);

    const where = (it) => it.clientName + (it.folder ? ` / ${it.folder}` : "");
    const dashTile = (it) => tile(it.clientSlug, { ...it, folder: where(it) }, true);

    const stat = (n, label, target, tone) =>
      h("a", { class: "card stat" + (tone ? " " + tone : ""), href: target ? `#/` : null, onclick: (e) => { e.preventDefault(); document.getElementById(target)?.scrollIntoView({ behavior: "smooth" }); } },
        h("div", { class: "stat-n" }, String(n)), h("div", { class: "mono muted" }, label));

    // Unanswered client comments, newest first, with one-click "Mark done".
    const commentRows = dash.openComments.map((cm) => {
      const row = h("div", { class: "feed-item" },
        h("div", { class: "mono muted" }, `${cm.clientName} · ${fmtDate(cm.created_at)}`),
        h("div", {},
          h("span", { style: "color:var(--bone)" }, cm.email), " on ",
          h("a", { href: `#/c/${enc(cm.client_slug)}/i/${enc(cm.path)}` }, baseName(cm.path)),
        ),
        h("div", { class: "detail" }, cm.timecode != null ? h("span", { class: "tc" }, fmtTime(cm.timecode)) : null, cm.body),
        h("div", { class: "comment-tools" },
          h("a", { class: "linkish", href: `#/c/${enc(cm.client_slug)}/i/${enc(cm.path)}` }, "Open"),
          h("button", {
            class: "linkish",
            onclick: async () => {
              try { await api("POST", `/api/c/${enc(cm.client_slug)}/comments/${cm.id}/resolve`); row.remove(); toast("Marked done."); } catch (err) { toast(err.message); }
            },
          }, "Mark done"),
        ),
      );
      return row;
    });

    // Approved work, filterable by client, with the usual sort and type tabs.
    const clientsWithApproved = [...new Map(dash.approved.map((it) => [it.clientSlug, it.clientName])).entries()];
    const approvedHolder = h("div");
    function renderApproved(slug) {
      const list = slug ? dash.approved.filter((it) => it.clientSlug === slug) : dash.approved;
      fill(approvedHolder, 
        clientsWithApproved.length > 1
          ? h("div", { class: "filters", style: "margin-bottom:12px" },
              h("button", { class: "chip small-chip" + (!slug ? " active" : ""), onclick: () => renderApproved(null) }, "All clients"),
              clientsWithApproved.map(([s, n]) => h("button", { class: "chip small-chip" + (slug === s ? " active" : ""), onclick: () => renderApproved(s) }, n)))
          : "",
        list.length
          ? mediaBrowser(list, { tileFn: dashTile })
          : h("div", { class: "card empty muted" }, "Nothing approved yet."),
      );
    }
    renderApproved(null);

    const KIND = { comment: "commented on", like: "favorited", approved: "approved", changes: "requested changes on", pending: "reset the status of", campaign_add: "added to a campaign:", campaign_remove: "took out of a campaign:", renamed: "renamed a file to" };
    const feed = fromClients.slice(0, 15).map((a) =>
      h("div", { class: "feed-item" + (a.created_at > lastSeen ? " fresh" : "") },
        h("div", { class: "mono muted" }, `${a.client_name || a.client_slug} · ${fmtDate(a.created_at)}${a.created_at > lastSeen ? " · NEW" : ""}`),
        h("div", {},
          h("span", { style: "color:var(--bone)" }, a.email), ` ${KIND[a.kind] || a.kind} `,
          h("a", { href: `#/c/${enc(a.client_slug)}/i/${enc(a.path)}` }, baseName(a.path)),
          a.kind.startsWith("campaign") && a.detail ? ` (${a.detail})` : "",
        ),
        a.kind === "comment" && a.detail ? h("div", { class: "detail" }, a.detail) : null,
      ),
    );

    show(
      h("div", { class: "page-head" }, h("h1", {}, "Studio dashboard"), h("a", { class: "btn small", href: "#/admin" }, "Clients and logins")),
      h("div", { class: "stats" },
        stat(fresh.length, "NEW SINCE LAST VISIT", "dash-activity", fresh.length ? "hot" : ""),
        stat(dash.changes.length, "CHANGES REQUESTED", "dash-changes", dash.changes.length ? "warn" : ""),
        stat(dash.openComments.length, "UNANSWERED COMMENTS", "dash-comments", ""),
        stat(dash.approved.length, "APPROVED, READY TO USE", "dash-approved", "ok"),
      ),
      h("div", { class: "dash-cols" },
        h("div", {},
          h("h2", { id: "dash-changes", class: "dash-h" }, "Changes requested"),
          dash.changes.length
            ? h("div", { class: "grid" }, dash.changes.map(dashTile))
            : h("div", { class: "card empty muted" }, "No open change requests."),
          h("h2", { id: "dash-approved", class: "dash-h", style: "margin-top:36px" }, "Approved and ready to use"),
          h("p", { class: "muted", style: "margin:-6px 0 14px" }, "Sort by Most favorited or In campaigns to see what the client likes best."),
          approvedHolder,
        ),
        h("div", {},
          h("div", { class: "card", id: "dash-comments" },
            h("div", { class: "pad", style: "padding-bottom:8px" }, h("h2", {}, "Unanswered comments")),
            h("div", { class: "feed" }, commentRows.length ? commentRows : h("div", { class: "feed-item muted" }, "All caught up.")),
          ),
          h("div", { class: "card", id: "dash-activity", style: "margin-top:20px" },
            h("div", { class: "pad", style: "padding-bottom:8px" }, h("h2", {}, "Latest from clients")),
            h("div", { class: "feed" }, feed.length ? feed : h("div", { class: "feed-item muted" }, "No client activity yet.")),
          ),
        ),
      ),
      h("h2", { class: "dash-h", style: "margin-top:40px" }, "Clients"),
      h("div", { class: "grid" },
        state.me.clients.map((c) =>
          h("a", { class: "card folder-card", href: `#/c/${enc(c.slug)}` },
            h("div", { class: "folder-icon", html: ICON_FOLDER }),
            h("div", {}, h("h3", {}, c.name), h("div", { class: "mono muted" }, "Open")),
          ),
        ),
      ),
    );
  }

  async function viewFolder(slug, dir) {
    show(h("p", { class: "muted" }, "Loading from the studio…"));
    let data;
    try {
      data = await api("GET", `/api/c/${enc(slug)}/list?dir=${enc(dir)}`);
    } catch (err) {
      show(errorCard(err));
      return;
    }
    state.listCache.set(`${slug}|${dir}`, data);

    const title = dir ? baseName(dir) : data.client.name;
    const newFolderBtn = state.me.admin
      ? h("button", {
          class: "btn small",
          onclick: async () => {
            const name = prompt(dir ? "New folder name:" : "New project name (e.g. Spring Campaign):");
            if (!name || !name.trim()) return;
            try {
              const r = await api("POST", `/api/c/${enc(slug)}/folder`, { dir, name });
              toast(r.created ? "Folder created." : "That folder already exists.");
              location.hash = `#/c/${enc(slug)}/f/${enc(r.path)}`;
            } catch (err) { toast(err.message); }
          },
        }, dir ? "+ New folder" : "+ New project")
      : null;
    let uploadBtn = null, uploadPanel = null;
    if (state.me.admin) {
      const picker = h("input", { type: "file", multiple: true, hidden: true, onchange: () => { uploadFiles([...picker.files]); picker.value = ""; } });
      uploadBtn = h("span", {}, picker, h("button", { class: "btn small primary", onclick: () => picker.click() }, "Upload"));
      uploadPanel = h("div", { class: "upload-panel", hidden: true });
      // Drag files anywhere on the page to upload into this folder.
      app.ondragover = (e) => { e.preventDefault(); app.classList.add("dragging"); };
      app.ondragleave = (e) => { if (e.target === app) app.classList.remove("dragging"); };
      app.ondrop = (e) => { e.preventDefault(); app.classList.remove("dragging"); uploadFiles([...e.dataTransfer.files]); };
    }

    async function uploadFiles(files) {
      if (!files.length) return;
      uploadPanel.hidden = false;
      fill(uploadPanel);
      let done = 0;
      for (const f of files) {
        const bar = h("div", { class: "upload-bar" }, h("span"));
        const status = h("span", { class: "mono muted" }, "waiting");
        uploadPanel.append(h("div", { class: "upload-row" }, h("span", { class: "tile-name" }, f.name), bar, status));
        if (f.size > 100 * 1024 * 1024) {
          status.textContent = "over 100 MB, use Finder";
          status.style.color = "var(--warn)";
          continue;
        }
        try {
          const r = await sendFile(f, (pct) => {
            bar.firstChild.style.width = pct + "%";
            status.textContent = pct + "%";
          });
          status.textContent = r.renamed ? `saved as ${r.renamed}` : "done";
          status.style.color = "var(--ok)";
          done++;
        } catch (err) {
          status.textContent = err.message;
          status.style.color = "var(--accent)";
        }
      }
      if (done) {
        toast(`${done} file${done === 1 ? "" : "s"} uploaded.`);
        setTimeout(() => viewFolder(slug, dir), 900);
      }
    }

    function sendFile(file, onProgress) {
      return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open("POST", `/api/c/${enc(slug)}/upload?dir=${enc(dir)}&name=${enc(file.name)}`);
        x.setRequestHeader("content-type", file.type || "application/octet-stream");
        x.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
        x.onload = () => {
          let d = null;
          try { d = JSON.parse(x.responseText); } catch {}
          x.status < 300 ? resolve(d || {}) : reject(new Error((d && d.error) || `Upload failed (${x.status}).`));
        };
        x.onerror = () => reject(new Error("Upload failed. Check your connection."));
        x.send(file);
      });
    }

    const parts = [
      crumbs(data.client, dir),
      dir ? null : clientTabs(slug, "projects"),
      h("div", { class: "page-head" },
        h("h1", {}, title),
        h("div", { class: "actions" }, newFolderBtn, uploadBtn),
      ),
      uploadPanel,
    ];

    if (data.folders.length) {
      if (data.items.length) parts.push(h("div", { class: "section-label mono muted" }, `FOLDERS · TAP TO OPEN`));
      parts.push(h("div", { class: "grid" }, data.folders.map((f) => projectCard(slug, f))));
    }

    if (data.items.length) {
      if (data.folders.length) parts.push(h("div", { class: "section-label mono muted" }, "ALSO IN THIS FOLDER"));
      parts.push(mediaBrowser(data.items, { tileFn: (it) => tile(slug, it), slug }));
    }

    if (!dir && !state.me.admin && state.me.clientAlertsEnabled && slug in (state.me.alerts || {})) {
      const box = h("input", {
        type: "checkbox",
        checked: state.me.alerts[slug],
        onchange: async () => {
          try {
            const r = await api("POST", "/api/me/alerts", { client: slug, on: box.checked });
            state.me.alerts[slug] = r.on;
            toast(r.on ? "You will get an email when there is new work." : "New-work emails are off.");
          } catch (err) { toast(err.message); box.checked = !box.checked; }
        },
      });
      parts.push(h("label", { class: "check alerts-toggle" }, box, "Email me when there is new work"));
    }

    if (!data.folders.length && !data.items.length) {
      parts.push(h("div", { class: "card empty" }, h("h2", {}, "Nothing here yet"), h("p", { class: "muted" }, state.me.admin ? "Click Upload, or drag files onto this page." : "New work will show up here as soon as it is ready.")));
    }
    show(...parts.filter(Boolean));
  }

  // A project folder: previews of what is inside, how many files, and a clear Open button,
  // so nobody mistakes it for a label and misses the work in it.
  function projectCard(slug, f) {
    const previews = (f.previews || []).map((pv) => {
      const src = mediaUrl(slug, pv.path);
      const el = pv.kind === "image"
        ? h("img", { "data-src": src, alt: "", loading: "lazy", onload: (e) => e.target.classList.add("loaded") })
        : h("video", { "data-src": src + "#t=0.5", preload: "metadata", muted: true, playsinline: true, onloadeddata: (e) => e.target.classList.add("loaded") });
      lazy.observe(el);
      return h("div", { class: "pc-cell" }, el);
    });
    const count = f.fileCount ? `${f.fileCount} file${f.fileCount === 1 ? "" : "s"}` : "Open to see what is inside";
    return h("a", { class: "card project-card", href: `#/c/${enc(slug)}/f/${enc(f.path)}` },
      h("div", { class: "pc-mosaic pc-n" + Math.max(1, previews.length) },
        previews.length ? previews : h("div", { class: "pc-cell pc-empty", html: ICON_FOLDER }),
        f.newCount ? h("span", { class: "pill new pc-new" }, `${f.newCount} NEW`) : null,
      ),
      h("div", { class: "pc-meta" },
        h("div", { style: "min-width:0" },
          h("h3", { class: "pc-name" }, f.name),
          h("div", { class: "mono muted" }, count),
        ),
        h("span", { class: "btn small primary pc-open" }, "Open"),
      ),
    );
  }

  // Shared grid for folders, favorites and campaigns: photos and videos in their
  // own sections, filters for type, status and tag, and a sort menu.
  // Sizes of the same ad. Files in one folder whose names differ only by an aspect ratio
  // (9x16, 4x5, 1x1, 16:9...) and words like "feed" or "stories" show as one ad with a size
  // switcher, so the grid is not flooded with copies.
  const SIZE_RE = /(?:^|[\s_\-.(\[])(\d{1,2})\s*[x×:]\s*(\d{1,2})(?=$|[\s_\-.)\]])/i;
  const PLACEMENT_RE = /\b(feed|stories|story|reels?|post|square|vertical|portrait|landscape|horizontal)\b/gi;
  const SIZE_ORDER = ["9:16", "4:5", "1:1", "16:9"];
  const kindOf = (it) => (it.kind === "video" ? "video" : it.kind === "image" ? "image" : "other");
  function sizeInfo(it) {
    const dot = it.name.lastIndexOf(".");
    const stem = dot > 0 ? it.name.slice(0, dot) : it.name;
    const m = stem.match(SIZE_RE);
    if (!m) return null;
    const base = stem.replace(m[0], " ").replace(PLACEMENT_RE, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!base) return null;
    return {
      label: `${Number(m[1])}:${Number(m[2])}`,
      key: [it.clientSlug || "", parentOf(it.path), kindOf(it), base].join("|"),
    };
  }
  const sizeRank = (label) => { const i = SIZE_ORDER.indexOf(label); return i < 0 ? 99 : i; };
  // Returns the list with sizes folded together. A folded entry is the first size
  // (9:16 first) with combined counts and `_versions` [{ label, path, item }].
  function groupSizes(items) {
    const byKey = new Map();
    const out = [];
    for (const it of items) {
      const si = sizeInfo(it);
      if (!si) { out.push(it); continue; }
      let g = byKey.get(si.key);
      if (!g) { g = { versions: [] }; byKey.set(si.key, g); out.push(g); }
      g.versions.push({ label: si.label, path: it.path, item: it });
    }
    return out.map((g) => {
      if (!g.versions) return g;
      if (g.versions.length === 1) return g.versions[0].item;
      const vs = g.versions.sort((a, b) => sizeRank(a.label) - sizeRank(b.label) || a.label.localeCompare(b.label));
      const all = vs.map((v) => v.item);
      const statuses = new Set(all.map((x) => x.status));
      const latest = all.map((x) => (x.mtime ? Date.parse(x.mtime) : 0)).reduce((a, b) => Math.max(a, b), 0);
      return {
        ...all[0],
        _versions: vs,
        status: statuses.size === 1 ? all[0].status : statuses.has("changes") ? "changes" : "pending",
        likes: Math.max(...all.map((x) => x.likes || 0)),
        comments: all.reduce((n, x) => n + (x.comments || 0), 0),
        openComments: all.reduce((n, x) => n + (x.openComments || 0), 0),
        seen: all.every((x) => x.seen !== false),
        tags: [...new Set(all.flatMap((x) => x.tags || []))],
        campaigns: [...new Set(all.flatMap((x) => x.campaigns || []))],
        mtime: latest ? new Date(latest).toISOString() : all[0].mtime,
      };
    });
  }
  // The other sizes of one file, in the same folder listing.
  function sizeSiblings(items, path) {
    const me = items.find((i) => i.path === path);
    const si = me && sizeInfo(me);
    if (!si) return [];
    return items
      .map((i) => ({ i, s: sizeInfo(i) }))
      .filter((x) => x.s && x.s.key === si.key)
      .map((x) => ({ label: x.s.label, path: x.i.path }))
      .sort((a, b) => sizeRank(a.label) - sizeRank(b.label) || a.label.localeCompare(b.label));
  }

  const PREFS_KEY = "gv-browse";
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; }
  }
  function savePrefs(p) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private window */ }
  }
  const SORTS = [
    ["newest", "Newest first"],
    ["oldest", "Oldest first"],
    ["name", "Name A to Z"],
    ["favorites", "Most favorited"],
    ["comments", "Most comments"],
    ["status", "Needs review first"],
    ["campaigns", "In most campaigns"],
  ];
  const STATUS_ORDER = { pending: 0, changes: 1, approved: 2 };

  function mediaBrowser(items, { tileFn, emptyText, slug }) {
    const prefs = loadPrefs();
    const st = { type: prefs.type || "all", sort: prefs.sort || "newest", status: "all", tag: null, seen: "all", fit: prefs.fit || "fit" };
    const root = h("div", { class: "browser" });
    items.forEach((it, i) => (it._i = i));

    const kindOfItem = kindOf;
    const allTags = [...new Set(items.flatMap((it) => it.tags || []))].sort();

    function sorted(list) {
      const t = (it) => (it.mtime ? Date.parse(it.mtime) : -it._i);
      const by = {
        newest: (a, b) => t(b) - t(a),
        oldest: (a, b) => t(a) - t(b),
        name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
        favorites: (a, b) => b.likes - a.likes || t(b) - t(a),
        comments: (a, b) => b.comments - a.comments || t(b) - t(a),
        status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || t(b) - t(a),
        campaigns: (a, b) => (b.campaigns?.length || 0) - (a.campaigns?.length || 0) || b.likes - a.likes || t(b) - t(a),
      }[st.sort];
      return [...list].sort(by);
    }

    function render() {
      savePrefs({ type: st.type, sort: st.sort, fit: st.fit });
      // Fit = whole image with black bars; Fill = cropped to fill the box.
      root.classList.toggle("thumbs-fit", st.fit === "fit");
      const ads = groupSizes(items);
      const base = ads.filter((it) =>
        (st.status === "all" || it.status === st.status) &&
        (!st.tag || (it.tags || []).includes(st.tag)) &&
        (st.seen === "all" || (st.seen === "new" ? !it.seen : it.seen)));
      const unseenCount = ads.filter((it) => !it.seen).length;
      const count = (k) => base.filter((it) => k === "all" || kindOfItem(it) === k).length;

      const typeTabs = h("div", { class: "seg" },
        [["all", "All"], ["video", "Videos"], ["image", "Photos"], ["other", "Other"]]
          .filter(([k]) => k === "all" || ads.some((it) => kindOfItem(it) === k))
          .map(([k, label]) => h("button", { class: "seg-btn" + (st.type === k ? " active" : ""), onclick: () => { st.type = k; render(); } }, `${label} ${count(k)}`)),
      );
      const statusSel = h("select", { class: "mini-select", "aria-label": "Status", onchange: (e) => { st.status = e.target.value; render(); } },
        [["all", "Any status"], ["pending", "Awaiting review"], ["changes", "Changes requested"], ["approved", "Approved"]].map(([v, l]) =>
          h("option", { value: v, selected: st.status === v }, l)),
      );
      const seenSel = h("select", { class: "mini-select", "aria-label": "Viewed", onchange: (e) => { st.seen = e.target.value; render(); } },
        [["all", "Viewed and new"], ["new", `New to you (${unseenCount})`], ["seen", `Viewed (${ads.length - unseenCount})`]].map(([v, l]) =>
          h("option", { value: v, selected: st.seen === v }, l)),
      );
      const markAll = unseenCount
        ? h("button", {
            class: "btn small",
            title: "Mark everything here as viewed",
            onclick: async () => {
              const todo = items.filter((it) => !it.seen);
              const groups = new Map();
              for (const it of todo) {
                const s = it.clientSlug || slug;
                groups.set(s, [...(groups.get(s) || []), it.path]);
              }
              try {
                for (const [s, paths] of groups) await api("POST", `/api/c/${enc(s)}/view`, { paths });
                todo.forEach((it) => (it.seen = true));
                state.listCache.clear();
                toast("Marked as viewed.");
                render();
              } catch (err) { toast(err.message); }
            },
          }, "Mark all viewed")
        : null;
      const fitSeg = h("div", { class: "seg fit-seg", title: "How previews are shown" },
        [["fit", "Fit"], ["fill", "Fill"]].map(([k, label]) =>
          h("button", { class: "seg-btn" + (st.fit === k ? " active" : ""), "aria-pressed": st.fit === k ? "true" : "false", onclick: () => { st.fit = k; render(); } }, label)),
      );
      const sortSel = h("select", { class: "mini-select", "aria-label": "Sort", onchange: (e) => { st.sort = e.target.value; render(); } },
        SORTS.map(([v, l]) => h("option", { value: v, selected: st.sort === v }, l)),
      );
      const tagRow = allTags.length
        ? h("div", { class: "filters tag-filters" },
            h("span", { class: "mono muted", style: "align-self:center" }, "TAGS"),
            allTags.map((tg) => h("button", { class: "chip small-chip" + (st.tag === tg ? " active" : ""), onclick: () => { st.tag = st.tag === tg ? null : tg; render(); } }, `#${tg}`)),
          )
        : null;

      const shown = sorted(base.filter((it) => st.type === "all" || kindOfItem(it) === st.type));
      const grid = (list) => h("div", { class: "grid" }, list.map(tileFn));
      let body;
      if (!shown.length) {
        body = h("div", { class: "card empty muted" }, items.length ? "Nothing matches these filters." : emptyText || "Nothing here yet.");
      } else if (st.type === "all") {
        const groups = [["video", "VIDEOS"], ["image", "PHOTOS"], ["other", "OTHER FILES"]]
          .map(([k, label]) => [label, shown.filter((it) => kindOfItem(it) === k)])
          .filter(([, list]) => list.length);
        body = h("div", {}, groups.map(([label, list]) => [h("div", { class: "section-label mono muted" }, `${label} · ${list.length}`), grid(list)]));
      } else {
        body = grid(shown);
      }

      fill(root, 
        ...[h("div", { class: "toolbar" }, typeTabs, h("div", { class: "toolbar-right" }, seenSel, statusSel, sortSel, fitSeg, markAll)), tagRow, body].filter(Boolean),
      );
    }
    render();
    return root;
  }

  // One inline video plays at a time.
  let playingVideo = null;

  // A grid tile. Videos show their length and play right in the grid (tap the play
  // button); the Open button (and the name) go to the full-size page with comments.
  function tile(slug, it, showFolder) {
    const src = mediaUrl(slug, it.path);
    const href = `#/c/${enc(slug)}/i/${enc(it.path)}`;
    const isVideo = it.kind === "video";
    let media;
    let thumb;
    const pills = [
      h("span", { class: `pill ${it.status}` }, STATUS_LABEL[it.status]),
      it.seen === false ? h("span", { class: "pill new" }, "NEW") : null,
    ];
    const expand = h("a", { class: "expand", href, title: "Open full size, with comments", "aria-label": "Open full size" },
      h("span", { html: ICON_EXPAND }), "Open");

    if (isVideo) {
      const dur = h("span", { class: "dur mono" });
      media = h("video", {
        "data-src": src + "#t=0.5", preload: "metadata", muted: true, playsinline: true,
        onloadeddata: (e) => e.target.classList.add("loaded"),
        onloadedmetadata: (e) => { if (isFinite(e.target.duration)) dur.textContent = fmtTime(e.target.duration); },
      });
      lazy.observe(media);
      const playBtn = h("button", { class: "play", type: "button", title: "Play here", "aria-label": "Play here" }, h("span", { html: ICON_PLAY }));
      thumb = h("div", { class: "thumb" }, media, playBtn, ...pills, dur, expand);
      const start = () => {
        if (thumb.classList.contains("playing")) return;
        if (!media.getAttribute("src")) { media.src = media.dataset.src; lazy.unobserve(media); }
        if (playingVideo && playingVideo !== media) playingVideo.pause();
        playingVideo = media;
        thumb.classList.add("playing");
        media.muted = false;
        media.controls = true;
        if (media.currentTime > 0.4 && media.currentTime < 0.6) media.currentTime = 0;
        media.play().catch(() => {});
        if (it.seen === false) {
          api("POST", `/api/c/${enc(it.clientSlug || slug)}/view`, { path: it.path }).catch(() => {});
          it.seen = true;
          state.listCache.clear();
        }
      };
      playBtn.onclick = (e) => { e.preventDefault(); start(); };
      media.addEventListener("click", (e) => { if (!thumb.classList.contains("playing")) { e.preventDefault(); start(); } });
      media.addEventListener("play", () => {
        if (playingVideo && playingVideo !== media) playingVideo.pause();
        playingVideo = media;
      });
    } else {
      if (it.kind === "image") {
        media = h("img", { "data-src": src, alt: "", loading: "lazy", onload: (e) => e.target.classList.add("loaded") });
        lazy.observe(media);
      } else {
        media = h("div", { class: "ftype" }, it.name.split(".").pop());
      }
      thumb = h("a", { class: "thumb", href }, media, ...pills, expand);
    }

    const pill = pills[0];
    const likesEl = h("span", {}, `♥ ${it.likes}`);
    const campLine = h("div", { class: "mono tile-folder tile-camps" }, it.campaigns && it.campaigns.length ? `In ${it.campaigns.join(", ")}` : "");
    const more = h("button", {
      class: "more-btn", type: "button", title: "More: add to a campaign, favorite, approve", "aria-label": "More options", "aria-haspopup": "menu",
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); openTileMenu(e.currentTarget, slug, it, { pill, likesEl, campLine, href, src }); },
    }, h("span", { html: ICON_DOTS }));
    return h("div", { class: "card tile" },
      thumb,
      h("div", { class: "meta-wrap" }, more, h("a", { class: "tile-meta", href },
        h("div", { class: "tile-name", title: it.name }, it.name),
        it._versions ? h("div", { class: "tile-sizes" }, it._versions.map((v) => h("span", { class: "size-chip" }, v.label))) : null,
        showFolder && it.folder ? h("div", { class: "mono muted tile-folder" }, it.folder) : null,
        campLine,
        it.tags && it.tags.length ? h("div", { class: "tile-tags" }, it.tags.map((tg) => h("span", { class: "tag" }, `#${tg}`))) : null,
        h("div", { class: "tile-stats mono muted" },
          likesEl,
          h("span", {}, `${it.comments} comment${it.comments === 1 ? "" : "s"}`),
          state.me.admin && it.openComments ? h("span", { style: "color:var(--accent)" }, `${it.openComments} open`) : null,
        ),
      )),
    );
  }

  // The "..." menu on a tile: add to or take out of campaigns (or start a new one),
  // favorite, approve, open, download. Works on every size of the ad at once.
  let openMenu = null;
  function closeTileMenu() {
    if (!openMenu) return;
    openMenu.remove();
    document.removeEventListener("keydown", openMenu._esc);
    openMenu = null;
  }
  function openTileMenu(anchor, slug, it, refs) {
    closeTileMenu();
    const cs = it.clientSlug || slug;
    const also = (it._versions || []).map((v) => v.path).filter((p) => p !== it.path);
    const sizesNote = also.length ? h("div", { class: "menu-note mono muted" }, `Covers all ${also.length + 1} sizes`) : null;
    const campList = h("div", { class: "menu-camps" }, h("div", { class: "muted menu-loading" }, "Loading campaigns…"));
    let detail = { status: it.status, liked: !!it.liked, likes: it.likes };

    const favBtn = h("button", { class: "menu-item", type: "button" });
    const okBtn = h("button", { class: "menu-item", type: "button" });
    const paintActions = () => {
      fill(favBtn, h("span", { class: "mi-icon" }, detail.liked ? "♥" : "♡"), detail.liked ? "Favorited (tap to undo)" : "Add to favorites");
      fill(okBtn, h("span", { class: "mi-icon" }, "✓"), detail.status === "approved" ? "Approved (tap to undo)" : "Approve");
      favBtn.classList.toggle("on-like", detail.liked);
      okBtn.classList.toggle("on-ok", detail.status === "approved");
    };
    const after = (d) => {
      detail = d;
      it.status = d.status; it.liked = d.liked; it.likes = d.likes;
      refs.pill.className = `pill ${d.status}`;
      refs.pill.textContent = STATUS_LABEL[d.status];
      refs.likesEl.textContent = `♥ ${d.likes}`;
      state.listCache.clear();
      paintActions();
    };
    favBtn.onclick = async () => {
      try { after(await api("POST", `/api/c/${enc(cs)}/like`, { path: it.path, also })); toast(detail.liked ? "Added to favorites." : "Removed from favorites."); }
      catch (err) { toast(err.message); }
    };
    okBtn.onclick = async () => {
      try { after(await api("POST", `/api/c/${enc(cs)}/status`, { path: it.path, status: detail.status === "approved" ? "pending" : "approved", also })); toast(detail.status === "approved" ? "Approved." : "Approval taken back."); }
      catch (err) { toast(err.message); }
    };
    paintActions();

    async function loadCamps() {
      try {
        const r = await api("GET", `/api/c/${enc(cs)}/campaigns?path=${enc(it.path)}`);
        const names = r.campaigns.filter((c) => c.has).map((c) => c.name);
        it.campaigns = names;
        refs.campLine.textContent = names.length ? `In ${names.join(", ")}` : "";
        const rows = r.campaigns.map((cp) =>
          h("button", {
            class: "menu-item camp-row" + (cp.has ? " on" : ""), type: "button", "aria-pressed": cp.has ? "true" : "false",
            onclick: async () => {
              try {
                await api(cp.has ? "DELETE" : "POST", `/api/c/${enc(cs)}/campaigns/${cp.id}/items`, { path: it.path, also });
                toast(cp.has ? `Taken out of ${cp.name}.` : `Added to ${cp.name}.`);
                state.listCache.clear();
                loadCamps();
              } catch (err) { toast(err.message); }
            },
          }, h("span", { class: "camp-check" }, cp.has ? "✓" : "+"), h("span", { class: "camp-name" }, cp.name)));
        let creator = null;
        if (state.me.admin) {
          const input = h("input", { class: "menu-input", placeholder: "New campaign name", maxlength: "120",
            onkeydown: (e) => { if (e.key === "Enter") create(); } });
          const create = async () => {
            const name = input.value.trim();
            if (!name) return input.focus();
            try {
              const c = await api("POST", `/api/c/${enc(cs)}/campaigns`, { name });
              await api("POST", `/api/c/${enc(cs)}/campaigns/${c.id}/items`, { path: it.path, also });
              toast(`Made "${name}" and added this ad.`);
              state.listCache.clear();
              loadCamps();
            } catch (err) { toast(err.message); }
          };
          creator = h("div", { class: "menu-create" }, input, h("button", { class: "btn small primary", type: "button", onclick: create }, "Create"));
        }
        fill(campList,
          rows.length ? rows : h("div", { class: "muted menu-loading" }, state.me.admin ? "No campaigns yet. Name one below." : "No campaigns set up yet."),
          creator);
      } catch (err) {
        fill(campList, h("div", { class: "muted menu-loading" }, err.message));
      }
      place();
    }
    loadCamps();

    const panel = h("div", { class: "tile-menu", role: "menu" },
      h("div", { class: "menu-head" },
        h("div", { class: "menu-title", title: it.name }, it.name),
        h("button", { class: "menu-x", type: "button", "aria-label": "Close", onclick: closeTileMenu }, "×"),
      ),
      h("div", { class: "menu-label mono muted" }, "ADD TO CAMPAIGN"),
      sizesNote,
      campList,
      h("div", { class: "menu-sep" }),
      favBtn,
      okBtn,
      h("a", { class: "menu-item", href: refs.href, onclick: closeTileMenu }, h("span", { class: "mi-icon", html: ICON_EXPAND }), "Open full size and comments"),
      h("a", { class: "menu-item", href: refs.src + "?download", onclick: closeTileMenu }, h("span", { class: "mi-icon" }, "↓"), "Download"),
    );
    const layer = h("div", { class: "menu-layer", onclick: (e) => { if (e.target === layer) closeTileMenu(); } }, panel);
    layer._esc = (e) => { if (e.key === "Escape") closeTileMenu(); };
    document.addEventListener("keydown", layer._esc);
    document.body.append(layer);
    openMenu = layer;

    // Desktop: next to the button, kept on screen (re-run once campaigns load).
    // Phones: a sheet from the bottom (CSS).
    function place() {
      if (!panel.isConnected || window.innerWidth <= 640) return;
      const r = anchor.getBoundingClientRect();
      const w = panel.offsetWidth, hgt = panel.offsetHeight;
      const left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12));
      let top = r.bottom + 6;
      if (top + hgt > window.innerHeight - 12) top = r.top - hgt - 6;
      if (top < 12) top = Math.max(12, window.innerHeight - hgt - 12);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    }
    place();
  }
  window.addEventListener("hashchange", closeTileMenu);

  async function viewItem(slug, path) {
    const dir = parentOf(path);
    show(h("p", { class: "muted" }, "Loading…"));

    let list = state.listCache.get(`${slug}|${dir}`);
    let detail;
    try {
      [detail, list] = await Promise.all([
        api("GET", `/api/c/${enc(slug)}/item?path=${enc(path)}`),
        list ? Promise.resolve(list) : api("GET", `/api/c/${enc(slug)}/list?dir=${enc(dir)}`),
      ]);
    } catch (err) {
      show(errorCard(err));
      return;
    }
    state.listCache.set(`${slug}|${dir}`, list);

    // Opening an ad marks it as viewed for this person.
    const cached = list.items.find((i) => i.path === path);
    if (!cached || !cached.seen) {
      api("POST", `/api/c/${enc(slug)}/view`, { path }).catch(() => {});
      if (cached) cached.seen = true;
    }

    const items = list.items;
    const it = items.find((i) => i.path === path) || { name: baseName(path), path, kind: "file" };
    // Previous / Next step through ads, not through every size of the same ad.
    const ads = groupSizes(items);
    const idx = ads.findIndex((a) => a.path === path || (a._versions || []).some((v) => v.path === path));
    const prev = idx > 0 ? ads[idx - 1] : null;
    const next = idx >= 0 && idx < ads.length - 1 ? ads[idx + 1] : null;
    const sizes = sizeSiblings(items, path);
    const also = sizes.map((v) => v.path).filter((p) => p !== path);
    const thisSize = (sizes.find((v) => v.path === path) || {}).label;
    const src = mediaUrl(slug, path);

    let video = null;
    let stageInner;
    if (it.kind === "video") {
      video = h("video", { src, controls: true, playsinline: true, preload: "metadata" });
      stageInner = video;
    } else if (it.kind === "image") {
      stageInner = h("img", { src, alt: it.name });
    } else if (it.kind === "pdf") {
      stageInner = h("iframe", { src, title: it.name });
    } else {
      stageInner = h("div", { class: "empty" }, h("p", {}, "This file type does not preview in the browser."), h("a", { class: "btn", href: src + "?download" }, "Download"));
    }

    const stage = h("div", { class: "card stage" }, stageInner);
    const sizeSeg = sizes.length > 1
      ? h("div", { class: "seg size-seg", title: "Sizes of this ad" },
          sizes.map((v) => h("button", {
            class: "seg-btn" + (v.path === path ? " active" : ""),
            "aria-pressed": v.path === path ? "true" : "false",
            onclick: () => { if (v.path !== path) location.replace(`#/c/${enc(slug)}/i/${enc(v.path)}`); },
          }, v.label)))
      : null;
    const navBar = h("div", { class: "stage-bar" },
      h("div", { class: "actions" },
        h("a", { class: "btn small", href: prev ? `#/c/${enc(slug)}/i/${enc(prev.path)}` : null, "aria-disabled": !prev, style: prev ? null : "opacity:.4;pointer-events:none" }, "← Previous"),
        h("a", { class: "btn small", href: next ? `#/c/${enc(slug)}/i/${enc(next.path)}` : null, "aria-disabled": !next, style: next ? null : "opacity:.4;pointer-events:none" }, "Next →"),
      ),
      h("div", { class: "actions" },
        sizeSeg,
        it.size ? h("span", { class: "mono muted", style: "align-self:center" }, fmtSize(it.size)) : null,
        h("a", { class: "btn small", href: src + "?download" }, "Download"),
      ),
    );

    const side = h("div", { class: "card side" });

    // "Use in campaign" picker. Lives outside renderSide so it keeps its state.
    const campBox = h("div", { class: "camp-box" });

    // Tags: Genvyd adds and removes them, clients see them.
    const tagBox = h("div", { class: "tag-box" });
    let tagSuggestions = null;
    function renderTags(tags) {
      if (!state.me.admin && !tags.length) { fill(tagBox); return; }
      const chips = tags.map((tg) =>
        h("span", { class: "tag tag-lg" }, `#${tg}`,
          state.me.admin ? h("button", { class: "tag-x", title: `Remove #${tg}`, onclick: () => tagAct("DELETE", tg) }, "×") : null));
      let adder = null;
      if (state.me.admin) {
        const listId = "tag-suggest";
        const input = h("input", { class: "tag-input", placeholder: "Add tag, e.g. instagram", list: listId, maxlength: "40",
          onkeydown: (e) => { if (e.key === "Enter" && input.value.trim()) { e.preventDefault(); tagAct("POST", input.value); } } });
        tagSuggestions = tagSuggestions || h("datalist", { id: listId });
        adder = h("div", { class: "tag-add" }, input, tagSuggestions,
          h("button", { class: "btn small", onclick: () => input.value.trim() && tagAct("POST", input.value) }, "Add"));
      }
      fill(tagBox, h("div", { class: "mono muted" }, "TAGS"), h("div", { class: "tile-tags", style: "margin-top:8px" }, chips), adder);
    }
    async function tagAct(method, tag) {
      try {
        const d = await api(method, `/api/c/${enc(slug)}/tags`, { path, tag });
        renderTags(d.tags);
        state.listCache.delete(`${slug}|${dir}`);
        loadTagSuggestions();
      } catch (err) { toast(err.message); }
    }
    async function loadTagSuggestions() {
      if (!state.me.admin) return;
      try {
        const r = await api("GET", `/api/c/${enc(slug)}/tags`);
        if (tagSuggestions) fill(tagSuggestions, ...r.tags.map((t) => h("option", { value: t.tag })));
      } catch { /* suggestions are optional */ }
    }
    async function loadCampaigns() {
      try {
        const r = await api("GET", `/api/c/${enc(slug)}/campaigns?path=${enc(path)}`);
        if (!r.campaigns.length) {
          fill(campBox, 
            h("div", { class: "mono muted" }, "USE IN CAMPAIGN"),
            h("p", { class: "muted", style: "margin:6px 0 0;font-size:13px" },
              state.me.admin ? "No campaigns yet. " : "No campaigns set up yet.",
              state.me.admin ? h("a", { href: `#/c/${enc(slug)}/campaigns` }, "Create one") : null),
          );
          return;
        }
        fill(campBox, 
          h("div", { class: "mono muted" }, "USE IN CAMPAIGN"),
          h("div", { class: "filters", style: "margin-top:8px" },
            r.campaigns.map((cp) =>
              h("button", {
                class: "chip" + (cp.has ? " active" : ""),
                title: cp.has ? "In this campaign. Click to take it out." : "Add to this campaign",
                onclick: async () => {
                  try {
                    await api(cp.has ? "DELETE" : "POST", `/api/c/${enc(slug)}/campaigns/${cp.id}/items`, { path, also });
                    toast(cp.has ? `Removed from ${cp.name}.` : `Added to ${cp.name}.`);
                    loadCampaigns();
                  } catch (err) { toast(err.message); }
                },
              }, `${cp.has ? "✓ " : "+ "}${cp.name}`),
            ),
          ),
        );
      } catch (err) {
        fill(campBox, h("div", { class: "muted" }, err.message));
      }
    }
    loadCampaigns();

    function renderSide(d) {
      const statusBtns = h("div", { class: "actions" },
        h("button", {
          class: "btn" + (d.status === "approved" ? " on-ok" : ""),
          onclick: () => setStatus(d.status === "approved" ? "pending" : "approved"),
        }, d.status === "approved" ? "✓ Approved" : "Approve"),
        h("button", {
          class: "btn" + (d.status === "changes" ? " on-warn" : ""),
          onclick: () => setStatus(d.status === "changes" ? "pending" : "changes"),
        }, d.status === "changes" ? "Changes requested" : "Request changes"),
        h("button", { class: "btn" + (d.liked ? " on-like" : ""), onclick: toggleLike, title: d.likers.length ? "Favorited by " + d.likers.map(who).join(", ") : "Save to your favorites" },
          d.liked ? `♥ Favorited${d.likes > 1 ? " · " + d.likes : ""}` : `♡ Favorite${d.likes ? " · " + d.likes : ""}`),
      );

      const statusNote = d.statusBy
        ? h("div", { class: "status-note muted" }, `${STATUS_LABEL[d.status]} by ${who(d.statusBy)}, ${fmtDate(d.statusAt)}`)
        : h("div", { class: "status-note muted" }, "Approve it, or request changes and say what in a comment.");
      const sizesNote = also.length
        ? h("div", { class: "status-note muted" }, `Approve, Favorite and campaign picks cover all ${sizes.length} sizes.`)
        : null;

      const list = h("div", { class: "comments" },
        d.comments.length
          ? d.comments.map((c) =>
              h("div", { class: "comment" + (c.resolved ? " resolved" : "") },
                h("div", { class: "comment-head" },
                  h("span", { class: "mono", style: "color:var(--bone)" }, who(c.email)),
                  h("span", { class: "mono muted" }, fmtDate(c.created_at)),
                ),
                h("div", { class: "comment-body" },
                  c.timecode != null && video
                    ? h("button", { class: "tc", onclick: () => { video.currentTime = c.timecode; video.play(); } }, fmtTime(c.timecode))
                    : c.timecode != null ? h("span", { class: "tc" }, fmtTime(c.timecode)) : null,
                  c.body,
                ),
                (c.mine || state.me.admin)
                  ? h("div", { class: "comment-tools" },
                      state.me.admin ? h("button", { class: "linkish", onclick: () => resolve(c.id) }, c.resolved ? "Reopen" : "Mark done") : null,
                      h("button", { class: "linkish", onclick: () => removeComment(c.id) }, "Delete"),
                    )
                  : null,
              ),
            )
          : h("p", { class: "muted", style: "margin:0" }, "No comments yet."),
      );

      const box = h("textarea", { placeholder: video ? "What should change? Pause the video where you mean and your note pins to that moment." : "Leave a note for the studio…", maxlength: "4000" });
      let pin = null;
      let pinLabel = null;
      if (video) {
        pin = h("input", { type: "checkbox", checked: true });
        pinLabel = h("span", {}, `Pin to ${fmtTime(video.currentTime)}`);
        const update = () => (pinLabel.textContent = `Pin to ${fmtTime(video.currentTime)}`);
        video.ontimeupdate = update;
        video.onseeked = update;
        box.addEventListener("focus", () => video.pause());
      }
      const send = h("button", { class: "btn primary", onclick: postComment }, "Post comment");
      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) postComment();
      });

      async function postComment() {
        const text = box.value.trim();
        if (!text) return box.focus();
        send.disabled = true;
        try {
          const body = { path, body: text };
          if (video && pin.checked) body.timecode = video.currentTime;
          renderSide(await api("POST", `/api/c/${enc(slug)}/comments`, body));
          state.listCache.delete(`${slug}|${dir}`);
        } catch (err) {
          toast(err.message);
          send.disabled = false;
        }
      }

      fill(side, 
        h("div", {},
          h("div", { class: "title-row" },
            h("h2", { style: "word-break:break-word" }, it.name),
            state.me.admin ? h("button", { class: "linkish", onclick: renameFile, title: "Rename the file on the Synology too" }, "Rename") : null,
          ),
          h("div", { style: "margin-top:10px" }, h("span", { class: `pill ${d.status}` }, STATUS_LABEL[d.status])),
        ),
        statusBtns,
        statusNote,
        sizesNote,
        tagBox,
        campBox,
        h("div", { class: "mono muted" }, `COMMENTS (${d.comments.length})`, also.length ? ` · ON THE ${thisSize} SIZE` : ""),
        list,
        h("div", { class: "composer" },
          box,
          h("div", { class: "composer-row" }, pin ? h("label", { class: "check" }, pin, pinLabel) : h("span"), send),
        ),
      );
      list.scrollTop = list.scrollHeight;
    }

    async function renameFile() {
      const dot = it.name.lastIndexOf(".");
      const stem = dot > 0 ? it.name.slice(0, dot) : it.name;
      const name = prompt(`New name for this file (the ${dot > 0 ? it.name.slice(dot) : ""} ending is kept):`, stem);
      if (!name || !name.trim() || name.trim() === stem) return;
      try {
        const r = await api("POST", `/api/c/${enc(slug)}/rename`, { path, name });
        state.listCache.delete(`${slug}|${dir}`);
        toast(`Renamed to ${r.name}.`);
        location.replace(`#/c/${enc(slug)}/i/${enc(r.path)}`);
      } catch (err) { toast(err.message); }
    }

    async function act(p) {
      try {
        renderSide(await p);
        state.listCache.delete(`${slug}|${dir}`);
      } catch (err) {
        toast(err.message);
      }
    }
    const setStatus = (status) => act(api("POST", `/api/c/${enc(slug)}/status`, { path, status, also }));
    const toggleLike = () => act(api("POST", `/api/c/${enc(slug)}/like`, { path, also }));
    const resolve = (id) => act(api("POST", `/api/c/${enc(slug)}/comments/${id}/resolve`));
    const removeComment = (id) => {
      if (confirm("Delete this comment?")) act(api("DELETE", `/api/c/${enc(slug)}/comments/${id}`));
    };

    renderSide(detail);
    renderTags(detail.tags || []);
    loadTagSuggestions();
    const back = state.backTo && state.backTo.slug === slug
      ? state.backTo
      : { hash: dir ? `#/c/${enc(slug)}/f/${enc(dir)}` : `#/c/${enc(slug)}`, label: dir ? baseName(dir) : list.client.name };
    show(
      h("div", { class: "back-row" },
        h("a", { class: "btn back-btn", href: back.hash }, h("span", { "aria-hidden": "true" }, "←"), `Back to ${back.label}`),
        crumbs(list.client, dir, it.name),
      ),
      h("div", { class: "viewer" }, h("div", {}, stage, navBar), side),
    );
  }

  async function viewFavorites(slug) {
    show(h("p", { class: "muted" }, "Loading…"));
    let data;
    try {
      data = await api("GET", `/api/c/${enc(slug)}/favorites`);
    } catch (err) {
      show(errorCard(err));
      return;
    }
    show(
      crumbs(data.client, "", "Favorites"),
      clientTabs(slug, "favorites"),
      h("div", { class: "page-head" }, h("h1", {}, "Your favorites")),
      data.items.length
        ? mediaBrowser(data.items, { tileFn: (it) => tile(slug, it, true), slug })
        : h("div", { class: "card empty" }, h("h2", {}, "No favorites yet"),
            h("p", { class: "muted" }, "Open any ad and tap ♡ Favorite to keep it here.")),
    );
  }

  async function viewCampaigns(slug) {
    show(h("p", { class: "muted" }, "Loading…"));
    let data;
    try {
      data = await api("GET", `/api/c/${enc(slug)}/campaigns`);
    } catch (err) {
      show(errorCard(err));
      return;
    }
    let creator = null;
    if (state.me.admin) {
      const nameIn = h("input", { placeholder: "Campaign name, e.g. Holiday 2026" });
      const notesIn = h("input", { placeholder: "Notes for the client (optional), e.g. pick 3 to 5 ads" });
      creator = h("form", {
        class: "card pad camp-new",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const r = await api("POST", `/api/c/${enc(slug)}/campaigns`, { name: nameIn.value, notes: notesIn.value });
            location.hash = `#/c/${enc(slug)}/campaign/${r.id}`;
          } catch (err) { toast(err.message); }
        },
      }, nameIn, notesIn, h("button", { class: "btn primary", type: "submit" }, "Create campaign"));
    }
    show(
      crumbs(data.client, "", "Campaigns"),
      clientTabs(slug, "campaigns"),
      h("div", { class: "page-head" }, h("h1", {}, "Campaigns")),
      creator,
      data.campaigns.length
        ? h("div", { class: "grid" },
            data.campaigns.map((cp) =>
              h("a", { class: "card folder-card", href: `#/c/${enc(slug)}/campaign/${cp.id}` },
                h("div", { class: "folder-icon", html: ICON_FLAG }),
                h("div", {},
                  h("h3", {}, cp.name),
                  h("div", { class: "mono muted" }, `${cp.count} ad${cp.count === 1 ? "" : "s"} picked`),
                ),
              ),
            ),
          )
        : h("div", { class: "card empty" }, h("h2", {}, "No campaigns yet"),
            h("p", { class: "muted" }, state.me.admin
              ? "Create one above. Your client then picks which ads go into it."
              : "Genvyd will set up campaigns here. You will pick which ads go into each one.")),
    );
  }

  async function viewCampaign(slug, id) {
    show(h("p", { class: "muted" }, "Loading…"));
    let data;
    try {
      data = await api("GET", `/api/c/${enc(slug)}/campaigns/${id}`);
    } catch (err) {
      show(errorCard(err));
      return;
    }
    const cp = data.campaign;
    const adminTools = state.me.admin
      ? h("div", { class: "actions" },
          h("button", {
            class: "btn small",
            onclick: async () => {
              const name = prompt("Campaign name:", cp.name);
              if (name === null) return;
              const notes = prompt("Notes for the client:", cp.notes || "");
              if (notes === null) return;
              try { await api("POST", `/api/c/${enc(slug)}/campaigns/${cp.id}`, { name, notes }); viewCampaign(slug, id); } catch (err) { toast(err.message); }
            },
          }, "Edit"),
          h("button", {
            class: "btn small",
            onclick: async () => {
              if (!confirm(`Delete the "${cp.name}" campaign? The ads themselves are not touched.`)) return;
              try { await api("DELETE", `/api/c/${enc(slug)}/campaigns/${cp.id}`); location.hash = `#/c/${enc(slug)}/campaigns`; } catch (err) { toast(err.message); }
            },
          }, "Delete"),
        )
      : null;

    const campTile = (it) =>
      h("div", { class: "tile-wrap" },
        tile(slug, it, true),
        h("button", {
          class: "btn small tile-remove",
          title: "Take this ad out of the campaign",
          onclick: async () => {
            try {
              await api("DELETE", `/api/c/${enc(slug)}/campaigns/${cp.id}/items`, { path: it.path });
              toast(`Removed from ${cp.name}.`);
              viewCampaign(slug, id);
            } catch (err) { toast(err.message); }
          },
        }, "Remove"),
      );

    show(
      crumbs(data.client, "", cp.name),
      clientTabs(slug, "campaigns"),
      h("div", { class: "page-head" },
        h("div", {},
          h("h1", {}, cp.name),
          cp.notes ? h("p", { class: "muted", style: "margin:8px 0 0;white-space:pre-wrap" }, cp.notes) : null,
        ),
        adminTools,
      ),
      data.items.length
        ? mediaBrowser(data.items, { tileFn: campTile, slug })
        : h("div", { class: "card empty" }, h("h2", {}, "No ads picked yet"),
            h("p", { class: "muted" }, "Open any ad and choose this campaign under “Use in campaign”.")),
    );
  }

  async function viewAdmin() {
    if (!state.me.admin) {
      location.replace("#/");
      return;
    }
    show(h("p", { class: "muted" }, "Loading…"));
    let data, folders;
    try {
      [data, folders] = await Promise.all([api("GET", "/api/admin/overview"), api("GET", "/api/admin/folders")]);
    } catch (err) {
      show(errorCard(err));
      return;
    }

    const refresh = async () => {
      state.me = await api("GET", "/api/me");
      viewAdmin();
    };

    // New client form. Folder is picked from what is actually on the Synology.
    const nameIn = h("input", { placeholder: "Client name, e.g. WYCOGA" });
    const used = new Set(data.clients.map((c) => c.folder));
    const free = folders.folders.filter((f) => !used.has(f));
    // Default is a brand new folder named after the client; existing unused folders are listed too.
    const folderIn = h("select", {},
      h("option", { value: "" }, "Create a new folder for them"),
      free.length ? h("optgroup", { label: "Or use an existing folder" }, free.map((f) => h("option", { value: f }, f))) : null,
    );
    const addClient = h("form", {
      class: "form-row",
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api("POST", "/api/admin/clients", { name: nameIn.value, folder: folderIn.value });
          toast(folderIn.value ? "Client added." : `Client added, with a new "${nameIn.value.trim()}" folder on the Synology.`);
          refresh();
        } catch (err) { toast(err.message); }
      },
    }, nameIn, folderIn, h("button", { class: "btn primary", type: "submit" }, "Add client"));

    const clientBlocks = data.clients.map((c) => {
      const members = data.members.filter((m) => m.client_slug === c.slug);
      const emailIn = h("input", { type: "email", placeholder: "client@company.com" });
      return h("div", { class: "client-block" },
        h("div", { class: "page-head", style: "margin-bottom:8px" },
          h("div", {}, h("h3", {}, c.name), h("div", { class: "mono muted" }, `Synology folder: ${c.folder}`)),
          h("div", { class: "actions" },
            h("a", { class: "btn small", href: `#/c/${enc(c.slug)}` }, "View"),
            h("button", {
              class: "btn small",
              onclick: async () => {
                if (!confirm(`Remove ${c.name} from the portal? Their files on the Synology are not touched.`)) return;
                try { await api("DELETE", `/api/admin/clients/${enc(c.slug)}`); refresh(); } catch (err) { toast(err.message); }
              },
            }, "Remove"),
          ),
        ),
        members.length
          ? members.map((m) =>
              h("div", { class: "member" },
                h("div", { style: "min-width:0" },
                  h("div", { style: "word-break:break-all" }, m.email),
                  h("div", { class: "mono muted", style: "font-size:11px" }, m.welcomed_at ? `Welcome sent ${fmtDate(m.welcomed_at)}` : "Welcome email not sent"),
                ),
                h("div", { class: "member-tools" },
                  h("button", { class: "linkish", onclick: () => sendWelcomeTo(c, m.email, true) }, m.welcomed_at ? "Resend welcome" : "Send welcome"),
                  h("button", { class: "linkish", onclick: () => copyInvite(c, m.email) }, "Copy invite"),
                  h("button", {
                    class: "linkish",
                    onclick: async () => {
                      if (!confirm(`Remove ${m.email} from ${c.name}? They will no longer be able to sign in to it.`)) return;
                      try { await api("DELETE", "/api/admin/members", { client: c.slug, email: m.email }); refresh(); } catch (err) { toast(err.message); }
                    },
                  }, "Remove"),
                ),
              ),
            )
          : h("div", { class: "muted", style: "font-size:14px" }, "No one can log in to this client yet."),
        h("form", {
          class: "add-member",
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const r = await api("POST", "/api/admin/members", { client: c.slug, email: emailIn.value });
              if (!r.added) toast("That email already has access.");
              else if (r.welcome.sent) toast(`Added, and a welcome email with setup steps went to ${emailIn.value.trim()}.`);
              else {
                toast(`Added. Welcome email not sent: ${r.welcome.reason} Use "Copy invite" to send it yourself.`);
              }
              refresh();
            } catch (err) { toast(err.message); }
          },
        }, emailIn, h("button", { class: "btn small", type: "submit" }, "Add login")),
      );
    });

    async function sendWelcomeTo(c, email, resend) {
      try {
        const r = await api("POST", "/api/admin/members", { client: c.slug, email, resend });
        if (r.welcome.sent) { toast(`Welcome email sent to ${email}.`); refresh(); }
        else toast(`Not sent: ${r.welcome.reason} Use "Copy invite" instead.`);
      } catch (err) { toast(err.message); }
    }
    async function copyInvite(c, email) {
      try {
        const r = await api("GET", `/api/admin/welcome-text?client=${enc(c.slug)}&email=${enc(email)}`);
        const all = `Subject: ${r.subject}\n\n${r.text}`;
        try { await navigator.clipboard.writeText(all); toast("Invite copied. Paste it into an email to them."); }
        catch { prompt("Copy this invite:", all); }
      } catch (err) { toast(err.message); }
    }

    // Import from links: paste Higgsfield file links (one per line) and they are
    // copied straight onto the Synology into the client's folder.
    // Line format: link | folder | file name | tags   (only the link is required)
    const impClient = h("select", {}, data.clients.map((c) => h("option", { value: c.slug }, c.name)));
    const impText = h("textarea", { rows: "6", placeholder: "https://d8j0...cloudfront.net/....mp4 | October Ads | Ponytail hat hero | video, 9x16\nOne file per line. Folder, name and tags are optional." });
    const impLog = h("div", { class: "upload-panel", hidden: true });
    const impBtn = h("button", { class: "btn primary", onclick: runImport }, "Import");
    const importCard = data.clients.length
      ? h("div", { class: "card pad", style: "margin-bottom:20px" },
          h("h2", { style: "margin-bottom:8px" }, "Import from links"),
          h("p", { class: "muted", style: "margin:0 0 12px;font-size:14px" }, "Paste Higgsfield file links. Each one is copied onto the Synology into the client's folder. Nothing is ever overwritten."),
          h("div", { style: "display:grid;gap:10px" }, impClient, impText, h("div", {}, impBtn)),
          impLog)
      : "";
    async function runImport() {
      const lines = impText.value.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      if (!lines.length) return toast("Paste at least one link.");
      const slug = impClient.value;
      impBtn.disabled = true;
      impLog.hidden = false;
      fill(impLog);
      let ok = 0;
      for (const line of lines) {
        const [url, dir = "", name = "", tags = ""] = line.split("|").map((x) => x.trim());
        const status = h("span", { class: "mono muted" }, "copying…");
        impLog.append(h("div", { class: "upload-row" }, h("span", { class: "tile-name" }, name || url.split("/").pop()), h("span", { class: "mono muted" }, dir || "(top)"), status));
        try {
          const r = await api("POST", `/api/c/${enc(slug)}/import`, { url, dir, name, tags });
          status.textContent = r.renamed ? `saved as ${r.renamed}` : "done";
          status.style.color = "var(--ok)";
          ok++;
        } catch (err) {
          status.textContent = err.message;
          status.style.color = "var(--accent)";
        }
      }
      impBtn.disabled = false;
      toast(`${ok} of ${lines.length} imported.`);
    }

    // Email alerts: shows whether the digest is switched on, with a test button.
    const emailCard = h("div", { class: "card pad", style: "margin-bottom:20px" }, h("h2", {}, "Email alerts"), h("p", { class: "muted" }, "Checking…"));
    api("GET", "/api/admin/notify-status").then((st) => {
      const testBtn = h("button", {
        class: "btn small",
        onclick: async () => {
          testBtn.disabled = true;
          try { const r = await api("POST", "/api/admin/notify-test"); toast(`Test email sent to ${r.to}.`); } catch (err) { toast(err.message); }
          testBtn.disabled = false;
        },
      }, "Send test email");
      fill(emailCard, 
        h("h2", { style: "margin-bottom:8px" }, "Email alerts"),
        st.configured
          ? h("p", { class: "muted", style: "margin:0 0 12px" }, `On. A summary goes to ${st.to} when clients approve, request changes, comment, favorite or pick campaign ads (at most every 15 minutes).`)
          : h("p", { class: "muted", style: "margin:0 0 12px" }, "Off. Add the RESEND_API_KEY secret to the genvyd-clients Worker in Cloudflare to switch it on (see SETUP.md)."),
        st.configured ? testBtn : "",
        st.configured
          ? h("button", {
              class: "btn small", style: "margin-left:8px",
              onclick: async () => {
                try { const r = await api("POST", "/api/admin/welcome-preview", { client: data.clients[0]?.slug || "" }); toast(`Preview of the client welcome email sent to ${r.to}.`); }
                catch (err) { toast(err.message); }
              },
            }, "Preview welcome email")
          : "",
        h("p", { class: "muted", style: "margin:12px 0 0;font-size:13px" },
          st.clientEmail
            ? "Client emails are on: new logins get a welcome email with setup steps, and clients hear about new work."
            : "Client emails are off until the sending address is verified (EMAIL_SETUP.md step 5). Until then, use Copy invite next to each login."),
      );
    }).catch(() => {});

    const KIND = { comment: "commented on", like: "liked", approved: "approved", changes: "requested changes on", pending: "reset the status of", campaign_add: "added to a campaign:", campaign_remove: "took out of a campaign:", renamed: "renamed a file to" };
    const feed = data.activity.length
      ? data.activity.map((a) =>
          h("div", { class: "feed-item" },
            h("div", { class: "mono muted" }, `${a.client_name || a.client_slug} · ${fmtDate(a.created_at)}`),
            h("div", {},
              h("span", { style: "color:var(--bone)" }, a.email), ` ${KIND[a.kind] || a.kind} `,
              h("a", { href: `#/c/${enc(a.client_slug)}/i/${enc(a.path)}` }, baseName(a.path)),
            ),
            a.detail ? h("div", { class: "detail" }, a.detail) : null,
          ),
        )
      : [h("div", { class: "feed-item muted" }, "No client activity yet.")];

    show(
      h("div", { class: "page-head" }, h("h1", {}, "Admin")),
      folders.error ? h("div", { class: "card error", style: "margin-bottom:20px" }, `Synology: ${folders.error}`) : "",
      h("div", { class: "admin" },
        h("div", {},
          h("div", { class: "card pad", style: "margin-bottom:20px" }, h("h2", { style: "margin-bottom:14px" }, "Add a client"), addClient),
          importCard,
          emailCard,
          h("div", { class: "card" },
            clientBlocks.length ? clientBlocks : h("div", { class: "pad muted" }, "No clients yet."),
          ),
        ),
        h("div", { class: "card" },
          h("div", { class: "pad", style: "padding-bottom:8px" }, h("h2", {}, "Latest client activity")),
          h("div", { class: "feed" }, feed),
        ),
      ),
    );
  }

  // ---- router ---------------------------------------------------------------

  const isItemHash = (hs) => /^\/c\/[^/]+\/i\//.test(hs || "");
  // Where the Back button on an ad page goes: the list the person came from.
  function backLabel(parts) {
    if (parts[0] !== "c") return parts[0] === "admin" ? "Admin" : "Home";
    const slug = decodeURIComponent(parts[1] || "");
    const name = ((state.me && state.me.clients) || []).find((c) => c.slug === slug)?.name || "projects";
    if (parts[2] === "f" && parts[3]) return baseName(decodeURIComponent(parts.slice(3).join("/")));
    if (parts[2] === "favorites") return "Favorites";
    if (parts[2] === "campaigns") return "Campaigns";
    if (parts[2] === "campaign") return "the campaign";
    return name;
  }

  async function router() {
    const hash = location.hash.replace(/^#/, "") || "/";
    const parts = hash.split("/").filter(Boolean);
    const prev = state.curHash;
    // Remember how far down a list someone was, so Back lands them in the same spot.
    if (prev && !isItemHash(prev)) state.scroll.set(prev, window.scrollY);
    state.curHash = hash;
    window.scrollTo(0, 0);
    try {
      await route(hash, parts);
      if (!isItemHash(hash)) {
        state.backTo = { hash: "#" + hash, label: backLabel(parts), slug: parts[0] === "c" ? decodeURIComponent(parts[1] || "") : null };
        const y = state.scroll.get(hash);
        if (y && isItemHash(prev)) {
          // Try a few times while previews lay out, so the page is tall enough to scroll.
          let tries = 0;
          const go = () => { window.scrollTo(0, y); if (Math.abs(window.scrollY - y) > 2 && ++tries < 15) setTimeout(go, 60); };
          requestAnimationFrame(go);
        }
      }
    } catch (err) {
      show(errorCard(err));
    }
  }

  async function route(hash, parts) {
    {
      if (!state.me) {
        state.me = await api("GET", "/api/me");
        document.getElementById("nav-email").textContent = state.me.email;
        document.getElementById("nav-admin").hidden = !state.me.admin;
      }
      if (parts[0] === "admin") return viewAdmin();
      if (parts[0] === "c" && parts[1]) {
        const slug = decodeURIComponent(parts[1]);
        if (parts[2] === "i" && parts[3]) return viewItem(slug, decodeURIComponent(parts.slice(3).join("/")));
        if (parts[2] === "favorites") return viewFavorites(slug);
        if (parts[2] === "campaigns") return viewCampaigns(slug);
        if (parts[2] === "campaign" && /^\d+$/.test(parts[3] || "")) return viewCampaign(slug, parts[3]);
        if (parts[2] === "f" && parts[3]) return viewFolder(slug, decodeURIComponent(parts.slice(3).join("/")));
        return viewFolder(slug, "");
      }
      return viewHome();
    }
  }

  const ICON_FOLDER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const ICON_FLAG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/></svg>';
  const ICON_EXPAND = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  const ICON_DOTS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  const ICON_PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

  window.addEventListener("hashchange", router);
  router();
})();
