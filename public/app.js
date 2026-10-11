/* Genvyd client review portal. Plain JS, no build step. */
(() => {
  "use strict";

  const app = document.getElementById("app");
  const state = { me: null, listCache: new Map() };

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
    for (const kid of kids.flat()) {
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
    const clients = state.me.clients;
    if (!state.me.admin && clients.length === 1) {
      location.replace(`#/c/${enc(clients[0].slug)}`);
      return;
    }
    if (!clients.length) {
      app.replaceChildren(
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
    app.replaceChildren(
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

  async function viewFolder(slug, dir, filter) {
    app.replaceChildren(h("p", { class: "muted" }, "Loading from the studio…"));
    let data;
    try {
      data = await api("GET", `/api/c/${enc(slug)}/list?dir=${enc(dir)}`);
    } catch (err) {
      app.replaceChildren(errorCard(err));
      return;
    }
    state.listCache.set(`${slug}|${dir}`, data);
    filter = filter || "all";

    const counts = { all: data.items.length, pending: 0, approved: 0, changes: 0 };
    data.items.forEach((i) => counts[i.status]++);
    const shown = filter === "all" ? data.items : data.items.filter((i) => i.status === filter);

    const filterBar = h("div", { class: "filters" },
      [["all", "All"], ["pending", "Awaiting review"], ["changes", "Changes requested"], ["approved", "Approved"]].map(([k, label]) =>
        h("button", {
          class: "chip" + (filter === k ? " active" : ""),
          onclick: () => viewFolder(slug, dir, k),
        }, `${label} ${counts[k]}`),
      ),
    );

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
    const parts = [
      crumbs(data.client, dir),
      h("div", { class: "page-head" },
        h("h1", {}, title),
        h("div", { class: "actions" }, data.items.length ? filterBar : null, newFolderBtn),
      ),
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
      if (data.folders.length) parts.push(h("div", { class: "section-label mono muted" }, "FILES"));
      parts.push(
        shown.length
          ? h("div", { class: "grid" }, shown.map((it) => tile(slug, it)))
          : h("div", { class: "card empty muted" }, "Nothing in this filter."),
      );
    }

    if (!data.folders.length && !data.items.length) {
      parts.push(h("div", { class: "card empty" }, h("h2", {}, "Nothing here yet"), h("p", { class: "muted" }, "New work will show up here as soon as it is ready.")));
    }
    app.replaceChildren(...parts);
  }

  function tile(slug, it) {
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
    app.replaceChildren(h("p", { class: "muted" }, "Loading…"));

    let list = state.listCache.get(`${slug}|${dir}`);
    let detail;
    try {
      [detail, list] = await Promise.all([
        api("GET", `/api/c/${enc(slug)}/item?path=${enc(path)}`),
        list ? Promise.resolve(list) : api("GET", `/api/c/${enc(slug)}/list?dir=${enc(dir)}`),
      ]);
    } catch (err) {
      app.replaceChildren(errorCard(err));
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
        h("button", { class: "btn" + (d.liked ? " on-like" : ""), onclick: toggleLike, title: d.likers.join(", ") || "No likes yet" },
          `${d.liked ? "♥" : "♡"} ${d.likes}`),
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
          h("h2", { style: "word-break:break-word" }, it.name),
          h("div", { style: "margin-top:10px" }, h("span", { class: `pill ${d.status}` }, STATUS_LABEL[d.status])),
        ),
        statusBtns,
        statusNote,
        h("div", { class: "mono muted" }, `COMMENTS (${d.comments.length})`),
        list,
        h("div", { class: "composer" },
          box,
          h("div", { class: "composer-row" }, pin ? h("label", { class: "check" }, pin, pinLabel) : h("span"), send),
        ),
      );
      list.scrollTop = list.scrollHeight;
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
    app.replaceChildren(
      crumbs(list.client, dir, it.name),
      h("div", { class: "viewer" }, h("div", {}, stage, navBar), side),
    );
  }

  async function viewAdmin() {
    if (!state.me.admin) {
      location.replace("#/");
      return;
    }
    app.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    let data, folders;
    try {
      [data, folders] = await Promise.all([api("GET", "/api/admin/overview"), api("GET", "/api/admin/folders")]);
    } catch (err) {
      app.replaceChildren(errorCard(err));
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

    const KIND = { comment: "commented on", like: "liked", approved: "approved", changes: "requested changes on", pending: "reset the status of" };
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

    app.replaceChildren(
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
        if (parts[2] === "f" && parts[3]) return viewFolder(slug, decodeURIComponent(parts.slice(3).join("/")));
        return viewFolder(slug, "");
      }
      return viewHome();
    } catch (err) {
      app.replaceChildren(errorCard(err));
    }
  }

  const ICON_FOLDER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const ICON_PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

  window.addEventListener("hashchange", router);
  router();
})();
