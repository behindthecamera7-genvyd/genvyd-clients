/* Genvyd client review portal. Plain JS, no build step. */
(() => {
  "use strict";

  const app = document.getElementById("app");
  const state = { me: null, listCache: new Map() };
  // Replace the page, skipping empty slots (null, false) so they never print as text.
  const show = (...kids) => app.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));

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
      approvedHolder.replaceChildren(
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
      uploadPanel.replaceChildren();
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
      parts.push(
        h("div", { class: "grid" },
          data.folders.map((f) =>
            h("a", { class: "card folder-card", href: `#/c/${enc(slug)}/f/${enc(f.path)}` },
              h("div", { class: "folder-icon", html: ICON_FOLDER }),
              h("div", {}, h("h3", {}, f.name)),
            ),
          ),
        ),
      );
    }

    if (data.items.length) {
      if (data.folders.length) parts.push(h("div", { style: "height:28px" }));
      parts.push(mediaBrowser(data.items, { tileFn: (it) => tile(slug, it) }));
    }

    if (!data.folders.length && !data.items.length) {
      parts.push(h("div", { class: "card empty" }, h("h2", {}, "Nothing here yet"), h("p", { class: "muted" }, state.me.admin ? "Click Upload, or drag files onto this page." : "New work will show up here as soon as it is ready.")));
    }
    show(...parts.filter(Boolean));
  }

  // Shared grid for folders, favorites and campaigns: photos and videos in their
  // own sections, filters for type, status and tag, and a sort menu.
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

  function mediaBrowser(items, { tileFn, emptyText }) {
    const prefs = loadPrefs();
    const st = { type: prefs.type || "all", sort: prefs.sort || "newest", status: "all", tag: null };
    const root = h("div", { class: "browser" });
    items.forEach((it, i) => (it._i = i));

    const kindOfItem = (it) => (it.kind === "video" ? "video" : it.kind === "image" ? "image" : "other");
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
      savePrefs({ type: st.type, sort: st.sort });
      const base = items.filter((it) => (st.status === "all" || it.status === st.status) && (!st.tag || (it.tags || []).includes(st.tag)));
      const count = (k) => base.filter((it) => k === "all" || kindOfItem(it) === k).length;

      const typeTabs = h("div", { class: "seg" },
        [["all", "All"], ["video", "Videos"], ["image", "Photos"], ["other", "Other"]]
          .filter(([k]) => k === "all" || items.some((it) => kindOfItem(it) === k))
          .map(([k, label]) => h("button", { class: "seg-btn" + (st.type === k ? " active" : ""), onclick: () => { st.type = k; render(); } }, `${label} ${count(k)}`)),
      );
      const statusSel = h("select", { class: "mini-select", "aria-label": "Status", onchange: (e) => { st.status = e.target.value; render(); } },
        [["all", "Any status"], ["pending", "Awaiting review"], ["changes", "Changes requested"], ["approved", "Approved"]].map(([v, l]) =>
          h("option", { value: v, selected: st.status === v }, l)),
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

      root.replaceChildren(
        ...[h("div", { class: "toolbar" }, typeTabs, h("div", { class: "toolbar-right" }, statusSel, sortSel)), tagRow, body].filter(Boolean),
      );
    }
    render();
    return root;
  }

  function tile(slug, it, showFolder) {
    const src = mediaUrl(slug, it.path);
    let media;
    if (it.kind === "image") {
      media = h("img", { "data-src": src, alt: it.name, loading: "lazy" });
      lazy.observe(media);
    } else if (it.kind === "video") {
      media = h("video", { "data-src": src + "#t=0.5", preload: "metadata", muted: true, playsinline: true });
      lazy.observe(media);
    } else {
      media = h("div", { class: "ftype" }, it.name.split(".").pop());
    }
    return h("a", { class: "card tile", href: `#/c/${enc(slug)}/i/${enc(it.path)}` },
      h("div", { class: "thumb" },
        media,
        it.kind === "video" ? h("div", { class: "play" }, h("span", { html: ICON_PLAY })) : null,
        h("span", { class: `pill ${it.status}` }, STATUS_LABEL[it.status]),
      ),
      h("div", { class: "tile-meta" },
        h("div", { class: "tile-name", title: it.name }, it.name),
        showFolder && it.folder ? h("div", { class: "mono muted tile-folder" }, it.folder) : null,
        it.campaigns && it.campaigns.length ? h("div", { class: "mono tile-folder", style: "color:var(--ok)" }, `In ${it.campaigns.join(", ")}`) : null,
        it.tags && it.tags.length ? h("div", { class: "tile-tags" }, it.tags.map((tg) => h("span", { class: "tag" }, `#${tg}`))) : null,
        h("div", { class: "tile-stats mono muted" },
          h("span", {}, `♥ ${it.likes}`),
          h("span", {}, `${it.comments} comment${it.comments === 1 ? "" : "s"}`),
          state.me.admin && it.openComments ? h("span", { style: "color:var(--accent)" }, `${it.openComments} open`) : null,
        ),
      ),
    );
  }

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

    const items = list.items;
    const idx = items.findIndex((i) => i.path === path);
    const it = items[idx] || { name: baseName(path), path, kind: "file" };
    const prev = idx > 0 ? items[idx - 1] : null;
    const next = idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null;
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
    const navBar = h("div", { class: "stage-bar" },
      h("div", { class: "actions" },
        h("a", { class: "btn small", href: prev ? `#/c/${enc(slug)}/i/${enc(prev.path)}` : null, "aria-disabled": !prev, style: prev ? null : "opacity:.4;pointer-events:none" }, "← Previous"),
        h("a", { class: "btn small", href: next ? `#/c/${enc(slug)}/i/${enc(next.path)}` : null, "aria-disabled": !next, style: next ? null : "opacity:.4;pointer-events:none" }, "Next →"),
      ),
      h("div", { class: "actions" },
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
      if (!state.me.admin && !tags.length) { tagBox.replaceChildren(); return; }
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
      tagBox.replaceChildren(h("div", { class: "mono muted" }, "TAGS"), h("div", { class: "tile-tags", style: "margin-top:8px" }, chips), adder);
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
        if (tagSuggestions) tagSuggestions.replaceChildren(...r.tags.map((t) => h("option", { value: t.tag })));
      } catch { /* suggestions are optional */ }
    }
    async function loadCampaigns() {
      try {
        const r = await api("GET", `/api/c/${enc(slug)}/campaigns?path=${enc(path)}`);
        if (!r.campaigns.length) {
          campBox.replaceChildren(
            h("div", { class: "mono muted" }, "USE IN CAMPAIGN"),
            h("p", { class: "muted", style: "margin:6px 0 0;font-size:13px" },
              state.me.admin ? "No campaigns yet. " : "No campaigns set up yet.",
              state.me.admin ? h("a", { href: `#/c/${enc(slug)}/campaigns` }, "Create one") : null),
          );
          return;
        }
        campBox.replaceChildren(
          h("div", { class: "mono muted" }, "USE IN CAMPAIGN"),
          h("div", { class: "filters", style: "margin-top:8px" },
            r.campaigns.map((cp) =>
              h("button", {
                class: "chip" + (cp.has ? " active" : ""),
                title: cp.has ? "In this campaign. Click to take it out." : "Add to this campaign",
                onclick: async () => {
                  try {
                    await api(cp.has ? "DELETE" : "POST", `/api/c/${enc(slug)}/campaigns/${cp.id}/items`, { path });
                    toast(cp.has ? `Removed from ${cp.name}.` : `Added to ${cp.name}.`);
                    loadCampaigns();
                  } catch (err) { toast(err.message); }
                },
              }, `${cp.has ? "✓ " : "+ "}${cp.name}`),
            ),
          ),
        );
      } catch (err) {
        campBox.replaceChildren(h("div", { class: "muted" }, err.message));
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

      side.replaceChildren(
        h("div", {},
          h("div", { class: "title-row" },
            h("h2", { style: "word-break:break-word" }, it.name),
            state.me.admin ? h("button", { class: "linkish", onclick: renameFile, title: "Rename the file on the Synology too" }, "Rename") : null,
          ),
          h("div", { style: "margin-top:10px" }, h("span", { class: `pill ${d.status}` }, STATUS_LABEL[d.status])),
        ),
        statusBtns,
        statusNote,
        tagBox,
        campBox,
        h("div", { class: "mono muted" }, `COMMENTS (${d.comments.length})`),
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
    const setStatus = (status) => act(api("POST", `/api/c/${enc(slug)}/status`, { path, status }));
    const toggleLike = () => act(api("POST", `/api/c/${enc(slug)}/like`, { path }));
    const resolve = (id) => act(api("POST", `/api/c/${enc(slug)}/comments/${id}/resolve`));
    const removeComment = (id) => {
      if (confirm("Delete this comment?")) act(api("DELETE", `/api/c/${enc(slug)}/comments/${id}`));
    };

    renderSide(detail);
    renderTags(detail.tags || []);
    loadTagSuggestions();
    show(
      crumbs(list.client, dir, it.name),
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
        ? mediaBrowser(data.items, { tileFn: (it) => tile(slug, it, true) })
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
        ? mediaBrowser(data.items, { tileFn: campTile })
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
                h("span", {}, m.email),
                h("button", {
                  class: "linkish",
                  onclick: async () => {
                    try { await api("DELETE", "/api/admin/members", { client: c.slug, email: m.email }); refresh(); } catch (err) { toast(err.message); }
                  },
                }, "Remove"),
              ),
            )
          : h("div", { class: "muted", style: "font-size:14px" }, "No one can log in to this client yet."),
        h("form", {
          class: "add-member",
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api("POST", "/api/admin/members", { client: c.slug, email: emailIn.value });
              toast("Added. They sign in at clients.genvyd.com with that email.");
              refresh();
            } catch (err) { toast(err.message); }
          },
        }, emailIn, h("button", { class: "btn small", type: "submit" }, "Add login")),
      );
    });

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

  async function router() {
    window.scrollTo(0, 0);
    const hash = location.hash.replace(/^#/, "") || "/";
    const parts = hash.split("/").filter(Boolean);
    try {
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
    } catch (err) {
      show(errorCard(err));
    }
  }

  const ICON_FOLDER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const ICON_FLAG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/></svg>';
  const ICON_PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

  window.addEventListener("hashchange", router);
  router();
})();
