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
  const STATUS_LABEL = { pending: "Awaiting review", approved: "Approved", changes: "Changes requested", rejected: "No, not using" };

  // Mark an ad No and move it to the trash: every size and version of it, plus the
  // comment (if any) marked done. Used by the dashboard and the ad page.
  async function noAndTrash(slug, path, commentId) {
    let paths = [path];
    try {
      const l = await api("GET", `/api/c/${enc(slug)}/list?dir=${enc(parentOf(path))}`);
      const ad = groupAds(l.items).find((a) => a.path === path || (a._paths || []).includes(path));
      if (ad && ad._paths && ad._paths.length) paths = ad._paths;
    } catch {}
    const also = paths.filter((p) => p !== path);
    if (commentId != null) await api("POST", `/api/c/${enc(slug)}/comments/${commentId}/resolve`);
    await api("POST", `/api/c/${enc(slug)}/status`, { path, status: "rejected", also });
    await api("POST", `/api/c/${enc(slug)}/hide`, { path, also, hidden: true });
    state.listCache.clear();
  }
  const parentOf = (p) => p.split("/").slice(0, -1).join("/");
  // Comments and activity can point at an ad file or at a line of ad copy ("copy:12").
  const itemHref = (slug, p) => (String(p).startsWith("copy:") ? `#/c/${enc(slug)}/copy` : `#/c/${enc(slug)}/i/${enc(p)}`);
  const itemLabel = (p, detail) => (String(p).startsWith("copy:") ? `ad copy${detail ? ` "${String(detail).slice(0, 60)}"` : ""}` : baseName(p));
  const baseName = (p) => p.split("/").pop();

  // Comment text with web links made clickable. A link to an ad in this portal shows the ad's
  // name ("wycoga_golf_ad_4x5 v2.png") instead of the long address and opens in place.
  function linkify(text) {
    const out = [];
    const re = /https?:\/\/[^\s<>"]+/g;
    let last = 0, m;
    while ((m = re.exec(String(text)))) {
      let url = m[0].replace(/[.,;:!?)\]]+$/, "");
      if (m.index > last) out.push(String(text).slice(last, m.index));
      let label = url, inPortal = false, adLink = false;
      try {
        const u = new URL(url);
        if (u.origin === location.origin) {
          inPortal = true;
          const parts = u.hash.replace(/^#\/?/, "").split("/");
          if (parts[0] === "c" && parts[2] === "i" && parts[3]) { label = "Open " + baseName(decodeURIComponent(parts.slice(3).join("/"))) + " →"; adLink = true; }
          else label = "Open in the portal →";
        }
      } catch { /* not a URL after all */ }
      out.push(h("a", inPortal ? { class: "comment-link" + (adLink ? " ad-link" : ""), href: url.includes("#") ? url.slice(url.indexOf("#")) : "#/" } : { class: "comment-link", href: url, target: "_blank", rel: "noopener noreferrer" }, label));
      last = m.index + url.length;
      re.lastIndex = last;
    }
    if (last < String(text).length) out.push(String(text).slice(last));
    return out;
  }

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
      tab("copy", "Ad review", `#/c/${enc(slug)}/copy`),
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
    const commentRows = dash.openComments.map((cm) => makeRow(cm));
    function makeRow(cm) {
      const replyHolder = h("div");
      const row = h("div", { class: "feed-item" },
        h("div", { class: "mono muted" }, `${cm.clientName} · ${fmtDate(cm.created_at)}`),
        h("div", {},
          h("span", { style: "color:var(--bone)" }, cm.email), " on ",
          h("a", { href: itemHref(cm.client_slug, cm.path) }, itemLabel(cm.path)),
        ),
        h("div", { class: "detail" }, cm.timecode != null ? h("span", { class: "tc" }, fmtTime(cm.timecode)) : null, ...linkify(cm.body)),
        (cm.replies || []).map((r) => h("div", { class: "detail dash-reply" }, h("span", { class: "mono muted" }, `↳ ${who(r.email)}, ${fmtDate(r.created_at)}: `), ...linkify(r.body))),
        replyHolder,
        h("div", { class: "comment-tools" },
          String(cm.path).startsWith("copy:") ? null : h("button", { class: "btn small", type: "button", onclick: () => {
            if (replyHolder.firstChild) { fill(replyHolder); return; }
            const tb = h("textarea", { class: "reply-box", placeholder: `Reply to ${cm.email}…`, maxlength: "4000", rows: 2 });
            const go = async (andResolve) => {
              if (!tb.value.trim()) return tb.focus();
              try {
                await api("POST", `/api/c/${enc(cm.client_slug)}/comments`, { path: cm.path, body: tb.value.trim(), parentId: cm.id, resolve: andResolve });
                if (andResolve) { row.remove(); toast("Replied and marked done."); return; }
                cm.replies = [...(cm.replies || []), { email: state.me.email, body: tb.value.trim(), created_at: Date.now() }];
                const fresh = makeRow(cm); row.replaceWith(fresh); toast("Replied.");
              } catch (err) { toast(err.message); }
            };
            fill(replyHolder, h("div", { class: "reply-composer" }, tb, h("div", { class: "composer-row" }, h("span"),
              h("div", { class: "actions" },
                h("button", { class: "btn small", type: "button", onclick: () => go(true) }, "Reply + mark done"),
                h("button", { class: "btn small primary", type: "button", onclick: () => go(false) }, "Post reply")))));
            tb.focus();
          } }, "↩ Reply"),
          h("button", {
            class: "btn small", type: "button",
            onclick: async () => {
              try { await api("POST", `/api/c/${enc(cm.client_slug)}/comments/${cm.id}/resolve`); row.remove(); toast("Marked done."); } catch (err) { toast(err.message); }
            },
          }, "✓ Mark done"),
          String(cm.path).startsWith("copy:") ? null : h("button", {
            class: "btn small no-btn", type: "button", title: "Mark the comment done, mark the ad No, and move it to the trash (every size)",
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              try { await noAndTrash(cm.client_slug, cm.path, cm.id); row.remove(); toast("Done. Marked No and moved to the trash."); }
              catch (err) { toast(err.message); e.currentTarget.disabled = false; }
            },
          }, "🗑 Mark done + move to trash"),
          h("a", { class: "linkish", href: itemHref(cm.client_slug, cm.path) }, "Open"),
        ),
      );
      return row;
    }

    // ---- Changes to make: one row per ad (sizes and versions folded), with the client's words
    // right there, so nothing needs opening to know what to fix. Ads that already have a newer
    // version uploaded move to "Sent back to the client" and stop counting as to-do.
    const cmtBy = new Map();
    for (const m of dash.changeComments || []) { const k = `${m.client_slug}|${m.path}`; cmtBy.set(k, [...(cmtBy.get(k) || []), m]); }
    const sibBy = new Map();
    for (const [cs, p] of dash.changeSiblings || []) { const k = `${cs}|${parentOf(p)}`; sibBy.set(k, [...(sibBy.get(k) || []), p]); }
    const kindFromName = (n) => (/\.(mp4|mov|m4v|webm)$/i.test(n) ? "video" : /\.(jpe?g|png|webp|gif|avif)$/i.test(n) ? "image" : "file");
    // Only files that are still there (a file renamed or deleted in Finder leaves its old status behind).
    const known = new Set((dash.changeSiblings || []).map(([cs, p]) => `${cs}|${p}`));
    const changeAds = groupAds(dash.changes.filter((it) => known.has(`${it.clientSlug}|${it.path}`)).map((it) => ({ ...it }))).map((ad) => {
      const paths = ad._paths || [ad.path];
      const info = adInfo(ad);
      const myVer = ad._verLatest || info.ver;
      let newer = null;
      for (const p of sibBy.get(`${ad.clientSlug}|${parentOf(ad.path)}`) || []) {
        const o = adInfo({ name: baseName(p), path: p, kind: kindFromName(p), clientSlug: ad.clientSlug });
        if (o.key === info.key && o.ver > myVer && (!newer || o.ver > newer.ver)) newer = { ver: o.ver, path: p };
      }
      const all = paths.flatMap((p) => cmtBy.get(`${ad.clientSlug}|${p}`) || []);
      const roots = all.filter((m) => !m.parent_id).sort((a, b) => a.created_at - b.created_at).map((m) => ({ ...m, replies: all.filter((r) => r.parent_id === m.id) }));
      const statusAt = Math.max(...dash.changes.filter((c) => c.clientSlug === ad.clientSlug && paths.includes(c.path)).map((c) => c.statusAt || 0));
      return { ad, paths, newer, roots, statusAt };
    }).sort((a, b) => b.statusAt - a.statusAt);
    const todoChanges = changeAds.filter((c) => !c.newer);
    const sentBack = changeAds.filter((c) => c.newer);
    const copyChanges = dash.copyChanges || [];
    const changesCount = todoChanges.length + copyChanges.length;

    function commentList(roots, slug, path) {
      return h("div", { class: "chg-comments" }, roots.map((m) =>
        h("div", { class: "chg-c" + (m.resolved ? " done" : "") },
          h("div", { class: "chg-q" }, m.timecode != null ? h("span", { class: "tc" }, fmtTime(m.timecode)) : null, ...linkify(m.body)),
          h("div", { class: "mono muted chg-by" }, `${m.genvyd ? "Genvyd" : who(m.email)}, ${fmtDate(m.created_at)}${m.resolved ? " · marked done" : ""}`),
          (m.replies || []).map((r) => h("div", { class: "chg-reply" }, h("span", { class: "mono muted" }, `↳ ${r.genvyd ? "You" : who(r.email)}: `), ...linkify(r.body))))));
    }
    function replyButton(slug, path, root, onDone) {
      if (!root) return null;
      const holder = h("div", { class: "chg-reply-box" });
      const btn = h("button", { class: "btn small", type: "button", onclick: () => {
        if (holder.firstChild) { fill(holder); return; }
        const tb = h("textarea", { class: "reply-box", placeholder: `Reply to ${who(root.email)}…`, maxlength: "4000", rows: 2 });
        const go = async () => {
          if (!tb.value.trim()) return tb.focus();
          try {
            await api("POST", `/api/c/${enc(slug)}/comments`, { path: root.path, body: tb.value.trim(), parentId: root.id });
            root.replies = [...(root.replies || []), { email: state.me.email, genvyd: true, body: tb.value.trim() }];
            toast("Replied."); onDone();
          } catch (err) { toast(err.message); }
        };
        fill(holder, h("div", { class: "reply-composer", style: "margin-left:0" }, tb,
          h("div", { class: "composer-row" }, h("span"), h("button", { class: "btn small primary", type: "button", onclick: go }, "Post reply"))));
        tb.focus();
      } }, "↩ Reply");
      return [btn, holder];
    }
    // No comment to reply to: ask on the ad itself (she sees it on the ad and on her home page).
    function askButton(ad, c) {
      const holder = h("div", { class: "chg-reply-box" });
      const btn = h("button", { class: "btn small", type: "button", onclick: () => {
        if (holder.firstChild) { fill(holder); return; }
        const tb = h("textarea", { class: "reply-box", maxlength: "4000", rows: 2 });
        tb.value = "Happy to change this one. What would you like different?";
        const go = async () => {
          if (!tb.value.trim()) return tb.focus();
          try {
            await api("POST", `/api/c/${enc(ad.clientSlug)}/comments`, { path: ad.path, body: tb.value.trim() });
            c.roots.push({ id: 0, path: ad.path, email: state.me.email, genvyd: true, body: tb.value.trim(), created_at: Date.now(), replies: [] });
            toast("Asked. She'll see it on the ad and on her home page."); renderChanges();
          } catch (err) { toast(err.message); }
        };
        fill(holder, h("div", { class: "reply-composer", style: "margin-left:0" }, tb,
          h("div", { class: "composer-row" }, h("span"), h("button", { class: "btn small primary", type: "button", onclick: go }, "Send"))));
        tb.focus();
      } }, "↩ Ask what to change");
      return [btn, holder];
    }
    const changesBox = h("div");
    function renderChanges() {
      const rowFor = (c) => {
        const { ad } = c;
        const href = `#/c/${enc(ad.clientSlug)}/i/${enc(ad.path)}`;
        const src = mediaUrl(ad.clientSlug, ad.path);
        const media = ad.kind === "video"
          ? h("video", { src: src + "#t=0.5", preload: "metadata", muted: true, playsinline: true })
          : ad.kind === "image" ? h("img", { src, alt: "", loading: "lazy" }) : h("div", { class: "ftype" }, ad.name.split(".").pop());
        const open = c.roots.filter((m) => !m.resolved && !m.genvyd);
        const lastOpen = open[open.length - 1] || c.roots.filter((m) => !m.genvyd).pop();
        const replyBits = lastOpen ? replyButton(ad.clientSlug, ad.path, lastOpen, renderChanges) : askButton(ad, c);
        return h("div", { class: "card chg-row" },
          h("a", { class: "chg-thumb", href, title: "Open the ad" }, media),
          h("div", { class: "chg-body" },
            h("div", { class: "mono muted chg-meta" }, `${ad.clientName} · ${ad.folder || "Projects"} · ${who(ad.statusBy || "")} asked ${fmtDate(c.statusAt)}`),
            h("h3", { class: "chg-name" }, h("a", { href }, ad._title || ad.name)),
            ad._sizes || ad._verCount || ad._carousel
              ? h("div", { class: "tile-sizes" },
                  ad._carousel ? h("span", { class: "size-chip car-chip" }, `Carousel · ${ad._carousel.length} cards`) : null,
                  (ad._sizes || []).map((v) => h("span", { class: "size-chip" }, v.label)),
                  ad._verCount ? h("span", { class: "size-chip ver-chip" }, `v${ad._verLatest}`) : null)
              : null,
            c.roots.length ? commentList(c.roots) : h("div", { class: "chg-none" }, "No comment left. Reply to ask what she'd like changed."),
            h("div", { class: "chg-actions" },
              h("a", { class: "btn small primary", href }, "Open the ad"),
              h("a", { class: "btn small", href, title: "On the ad page, use ↑ New version to upload the fixed file" }, `↑ Upload v${(ad._verLatest || adInfo(ad).ver) + 1}`),
              replyBits ? replyBits[0] : null),
            replyBits ? replyBits[1] : null));
      };
      const copyRow = (x) => {
        const label = `${x.card ? `Card ${x.card} ` : ""}${COPY_KIND_LABEL[x.kind] || x.kind}`;
        const href = `#/c/${enc(x.client_slug)}/copy`;
        const roots = x.comments.filter((m) => !m.parent_id).map((m) => ({ ...m, replies: x.comments.filter((r) => r.parent_id === m.id) }));
        return h("div", { class: "card chg-row chg-copy" },
          h("a", { class: "chg-thumb chg-copy-thumb", href }, h("span", { class: "mono" }, "AD COPY")),
          h("div", { class: "chg-body" },
            h("div", { class: "mono muted chg-meta" }, `${x.clientName} · ${x.ad_path ? baseName(x.ad_path) : "Ad copy"} · ${who(x.status_by || "")} asked ${x.status_at ? fmtDate(x.status_at) : ""}`),
            h("h3", { class: "chg-name" }, label, x.version > 1 ? h("span", { class: "mono muted", style: "font-size:13px" }, ` v${x.version}`) : null),
            h("div", { class: "chg-copytext" }, x.text),
            roots.length ? commentList(roots) : h("div", { class: "chg-none" }, "No comment left. Reply to ask what wording she'd like."),
            h("div", { class: "chg-actions" }, h("a", { class: "btn small primary", href }, "Open in Ad review"))));
      };
      fill(changesBox,
        changesCount
          ? h("div", { class: "chg-list" }, todoChanges.map(rowFor), copyChanges.map(copyRow))
          : h("div", { class: "card empty muted" }, "No changes waiting on you."),
        sentBack.length
          ? h("details", { class: "chg-sent" },
              h("summary", { class: "mono muted" }, `SENT BACK TO THE CLIENT, WAITING ON THEM (${sentBack.length})`),
              h("div", { class: "chg-sent-list" }, sentBack.map((c) => h("div", { class: "chg-sent-row" },
                h("a", { href: `#/c/${enc(c.ad.clientSlug)}/i/${enc(c.newer.path)}` }, c.ad._title || c.ad.name),
                h("span", { class: "mono muted" }, ` · ${c.ad.clientName} · v${c.newer.ver} is up`)))))
          : null);
    }
    renderChanges();

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
          ? mediaBrowser(list, { tileFn: dashTile, zipName: `Approved ads${slug ? " - " + (clientsWithApproved.find(([x]) => x === slug) || [, slug])[1] : ""}` })
          : h("div", { class: "card empty muted" }, "Nothing approved yet."),
      );
    }
    renderApproved(null);

    const KIND = { comment: "commented on", like: "favorited", approved: "approved", changes: "requested changes on", rejected: "said no to", pending: "reset the status of", campaign_add: "added to a campaign:", campaign_remove: "took out of a campaign:", renamed: "renamed a file to", hidden: "moved to trash:", unhidden: "took out of the trash:", deleted: "deleted" };
    const feed = fromClients.slice(0, 15).map((a) =>
      h("div", { class: "feed-item" + (a.created_at > lastSeen ? " fresh" : "") },
        h("div", { class: "mono muted" }, `${a.client_name || a.client_slug} · ${fmtDate(a.created_at)}${a.created_at > lastSeen ? " · NEW" : ""}`),
        h("div", {},
          h("span", { style: "color:var(--bone)" }, a.email), ` ${KIND[a.kind] || a.kind} `,
          h("a", { href: itemHref(a.client_slug, a.path) }, itemLabel(a.path, a.kind !== "comment" && !String(a.kind).startsWith("campaign") ? a.detail : null)),
          a.kind.startsWith("campaign") && a.detail ? ` (${a.detail})` : "",
        ),
        a.kind === "comment" && a.detail ? h("div", { class: "detail" }, a.detail) : null,
      ),
    );

    // Clients first: what each one is waiting on, one tap to open.
    const clientCards = state.me.clients.map((c) => {
      const n = {
        changes: todoChanges.filter((x) => x.ad.clientSlug === c.slug).length + copyChanges.filter((x) => x.client_slug === c.slug).length,
        comments: dash.openComments.filter((x) => x.client_slug === c.slug).length,
        approved: dash.approved.filter((x) => x.clientSlug === c.slug).length,
        fresh: fresh.filter((a) => a.client_slug === c.slug).length,
      };
      const chip = (num, label, tone) => num ? h("span", { class: "cc-chip " + tone }, `${num} ${label}`) : null;
      const waiting = [chip(n.fresh, "new", "hot"), chip(n.changes, n.changes === 1 ? "change request" : "change requests", "warn"), chip(n.comments, n.comments === 1 ? "comment" : "comments", ""), chip(n.approved, "approved", "ok")].filter(Boolean);
      return h("div", { class: "card client-card" },
        h("a", { class: "cc-main", href: `#/c/${enc(c.slug)}` },
          h("div", { class: "folder-icon", html: ICON_FOLDER }),
          h("div", { style: "flex:1;min-width:0" },
            h("h3", { style: "margin:0 0 6px" }, c.name),
            waiting.length ? h("div", { class: "cc-chips" }, waiting) : h("div", { class: "mono muted" }, "Nothing waiting")),
          h("span", { class: "btn small primary" }, "Open")),
        h("div", { class: "cc-links" },
          h("a", { href: `#/c/${enc(c.slug)}` }, "Projects"),
          h("a", { href: `#/c/${enc(c.slug)}/campaigns` }, "Campaigns"),
          h("a", { href: `#/c/${enc(c.slug)}/copy` }, "Ad review"),
          h("a", { href: `#/c/${enc(c.slug)}/favorites` }, "Favorites")),
      );
    });

    show(
      h("div", { class: "page-head" }, h("h1", {}, "Studio dashboard"), h("a", { class: "btn small", href: "#/admin" }, "Admin: clients, logins, backups")),
      h("h2", { id: "dash-changes", class: "dash-h" }, changesCount ? `Changes to make (${changesCount})` : "Changes to make"),
      changesCount ? h("p", { class: "muted", style: "margin:-6px 0 14px" }, "What each client asked for, newest first. Upload the fix as a new version and it moves to Sent back.") : null,
      changesBox,
      h("div", { class: "dash-h mono muted", style: "font-size:12px;margin:32px 0 12px" }, "YOUR CLIENTS"),
      h("div", { class: "grid client-grid" }, clientCards.length ? clientCards : h("div", { class: "card empty muted" }, "No clients yet. Add one on the Admin page.")),
      h("div", { class: "stats", style: "margin-top:28px" },
        stat(fresh.length, "NEW SINCE LAST VISIT", "dash-activity", fresh.length ? "hot" : ""),
        stat(changesCount, "CHANGES TO MAKE", "dash-changes", changesCount ? "warn" : ""),
        stat(dash.openComments.length, "UNANSWERED COMMENTS", "dash-comments", ""),
        stat(dash.approved.length, "APPROVED, READY TO USE", "dash-approved", "ok"),
      ),
      h("div", { class: "dash-cols" },
        h("div", {},
          h("h2", { id: "dash-approved", class: "dash-h" }, "Approved and ready to use"),
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
      dir ? null : todoPanel(slug, data.client.name),
    ];

    if (data.folders.length) {
      if (data.items.length) parts.push(h("div", { class: "section-label mono muted" }, `FOLDERS · TAP TO OPEN`));
      parts.push(h("div", { class: "grid" }, data.folders.map((f) => projectCard(slug, f))));
    }

    // Ad copy shows under the ad it belongs to (every size and version of it).
    const copyBy = new Map();
    for (const x of data.copy || []) { const k = copyKey(x.adPath); copyBy.set(k, [...(copyBy.get(k) || []), x]); }
    for (const it of data.items) it._copy = copyBy.get(copyKey(it.path)) || null;
    if (data.items.length) {
      if (data.folders.length) parts.push(h("div", { class: "section-label mono muted" }, "ALSO IN THIS FOLDER"));
      parts.push(mediaBrowser(data.items, { tileFn: (it) => tile(slug, it), slug, zipName: `${data.client.name} - ${title}` }));
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

  // Client home: what is waiting on the client, across every project, newest first. Ads still
  // awaiting review (sizes and versions folded, so a v2 shows once), final ads and ad copy to
  // check, and Genvyd's recent replies to their comments. Admin sees the same, as "Waiting on <client>".
  function todoPanel(slug, clientName) {
    // Same Fit / Fill choice as the folders (Fit, the whole image, unless they picked Fill).
    const box = h("div", { class: "todo" + ((loadPrefs().fit || "fit") === "fit" ? " thumbs-fit" : "") }, h("p", { class: "muted", style: "margin:0" }, "Checking what is new…"));
    const st = { all: false };
    api("GET", `/api/c/${enc(slug)}/todo`).then((d) => {
      const inFinal = (it) => it.folder === "Final ads" || it.folder.startsWith("Final ads/");
      let ads, waiting, changing;
      // Worked out again after every Select action, so approved or trashed ads drop out of the box.
      const tally = () => {
        ads = groupAds(d.items.filter((it) => !inFinal(it) && !it.hidden));
        waiting = ads.filter((a) => a.status === "pending" && (a.kind === "image" || a.kind === "video"))
          // Client: ones they haven't opened first, then newest. Admin: newest first (admin's own views don't matter here).
          .sort((a, b) => (state.me.admin || a.seen === b.seen ? 0 : a.seen ? 1 : -1) || String(b.mtime).localeCompare(String(a.mtime)));
        changing = ads.filter((a) => a.status === "changes").length;
      };
      tally();
      const sel = selectKit({ slug, items: d.items, zipName: `${clientName} - To review`, rerender: () => { tally(); render(); } });
      const finals = finalAdGroups(d.items.filter(inFinal)).filter((g) => g.status === "pending").length;
      const copyN = d.copy.pending || 0;
      const me = !state.me.admin;
      const render = () => {
        const first = window.innerWidth <= 640 ? 4 : 8;
        const shown = st.all || sel.on ? waiting : waiting.slice(0, first);
        sel.setList(shown);
        box.classList.toggle("selecting", sel.on);
        const links = [
          finals ? h("a", { class: "todo-link", href: `#/c/${enc(slug)}/copy` }, h("strong", {}, String(finals)), ` final ad${finals === 1 ? "" : "s"} to check, as they will look on Facebook and Instagram →`) : null,
          copyN ? h("a", { class: "todo-link", href: `#/c/${enc(slug)}/copy` }, h("strong", {}, String(copyN)), ` line${copyN === 1 ? "" : "s"} of ad copy to approve →`) : null,
        ].filter(Boolean);
        const nothing = !waiting.length && !links.length;
        fill(box,
          h("div", { class: "todo-head" },
            h("h2", {}, me ? "Waiting on you" : `Waiting on ${clientName}`),
            waiting.length ? h("span", { class: "pill pending" }, `${waiting.length} to review`) : null,
            me && waiting.some((a) => a.seen === false) ? h("span", { class: "pill new" }, `${waiting.filter((a) => a.seen === false).length} new`) : null,
            waiting.length > 1 ? h("span", { class: "todo-select" }, sel.button()) : null),
          nothing
            ? h("p", { class: "muted", style: "margin:4px 0 0" }, me ? "You're all caught up. New work will show up here as soon as it's ready." : "Nothing waiting on the client right now.")
            : h("p", { class: "muted", style: "margin:4px 0 14px" }, me ? "Newest first. Open one to approve it, ask for changes, or leave a comment." : "What the client still needs to approve, newest first."),
          links.length ? h("div", { class: "todo-links" }, links) : null,
          d.replies.length
            ? h("div", { class: "todo-replies" },
                h("div", { class: "section-label mono muted" }, me ? "MESSAGES FROM GENVYD" : "YOUR RECENT MESSAGES"),
                d.replies.slice(0, 3).map((r) => h("div", { class: "card todo-reply" },
                  h("div", { class: "mono muted", style: "font-size:12px" }, `${fmtDate(r.at)} · on `, h("a", { href: `#/c/${enc(slug)}/i/${enc(r.path)}` }, baseName(r.path))),
                  r.yourComment ? h("div", { class: "muted todo-quote" }, `${me ? "You" : "Client"}: "${String(r.yourComment).slice(0, 140)}${String(r.yourComment).length > 140 ? "…" : ""}"`) : null,
                  h("div", { class: "todo-reply-body" }, h("strong", {}, "Genvyd: "), ...linkify(r.body)))))
            : null,
          shown.length ? h("div", { class: "grid" }, shown.map((it) => sel.pickable(tile(slug, it, true), it))) : null,
          sel.on && shown.length ? sel.bar : null,
          waiting.length > first && !sel.on ? h("button", { class: "btn small", type: "button", style: "margin-top:12px", onclick: () => { st.all = !st.all; render(); } }, st.all ? "Show fewer" : `See all ${waiting.length}`) : null,
          changing ? h("p", { class: "muted todo-note" }, me ? `Genvyd is working on the changes you asked for on ${changing} ad${changing === 1 ? "" : "s"}.` : `${changing} ad${changing === 1 ? "" : "s"} with changes requested.`) : null,
        );
        if (sel.on) sel.paintBar();
      };
      render();
    }).catch(() => box.remove());
    return box;
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
  // Sizes and versions of the same ad. Files in one folder whose names differ only by an
  // aspect ratio (9x16, 4x5, 1x1, 16:9...), words like "feed" or "stories", or a version
  // mark (v2, rev 3, or the "(2)" the portal adds when a name is taken) show as one ad.
  // The tile shows the newest version; the ad page has size and version switchers.
  const SIZE_RE = /(?:^|[\s_\-.(\[])(\d{1,2})\s*[x×:]\s*(\d{1,2})(?=$|[\s_\-.)\]])/i;
  const VER_RE = /(?:^|[\s_\-.(\[])(?:v|ver|version|rev)\s*\.?\s*(\d{1,3})(?=$|[\s_\-.)\]])/i;
  const DUP_RE = /\s*\((\d{1,2})\)\s*$/;
  const PLACEMENT_RE = /\b(feed|stories|story|reels?|post|square|vertical|portrait|landscape|horizontal)\b/gi;
  const SIZE_ORDER = ["9:16", "4:5", "1:1", "16:9"];
  const kindOf = (it) => (it.kind === "video" ? "video" : it.kind === "image" ? "image" : "other");
  const stemOf = (name) => { const d = name.lastIndexOf("."); return d > 0 ? name.slice(0, d) : name; };
  const extOf = (name) => { const d = name.lastIndexOf("."); return d > 0 ? name.slice(d) : ""; };
  const norm = (t) => t.replace(PLACEMENT_RE, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // The name with any version mark taken off (keeps the size), e.g. for naming the next version.
  function unversioned(stem) {
    const v = stem.match(VER_RE);
    let out = v ? stem.replace(v[0], " ") : stem;
    out = out.replace(DUP_RE, "");
    return out.replace(/\s{2,}/g, " ").replace(/[\s_\-.]+$/, "").trim() || stem;
  }
  function adName(name) {
    let rest = stemOf(name);
    let size = null;
    const m = rest.match(SIZE_RE);
    if (m) { size = `${Number(m[1])}:${Number(m[2])}`; rest = rest.replace(m[0], " "); }
    let ver = 1;
    const v = rest.match(VER_RE);
    if (v) { ver = Number(v[1]) || 1; rest = rest.replace(v[0], " "); }
    else { const d = rest.match(DUP_RE); if (d) { ver = Number(d[1]) || 1; rest = rest.replace(DUP_RE, ""); } }
    const base = norm(rest) || norm(stemOf(name)) || name.toLowerCase();
    return { size, ver, base };
  }
  function adInfo(it) {
    const { size, ver, base } = adName(it.name);
    return { size, ver, key: [it.clientSlug || "", parentOf(it.path), kindOf(it), base].join("|") };
  }
  // Ad copy belongs to every size and version of an ad, and to copy files named after it
  // ("Cap ad.copy.txt" goes with "Cap ad 9x16.mp4" and "Cap ad 4x5 v2.mp4").
  const copyKey = (p) => {
    let name = baseName(p);
    // Final ad screenshots are "<Ad name> - <Placement>.png": the copy goes with the ad name.
    if (parentOf(p).split("/")[0] === "Final ads" && name.lastIndexOf(" - ") > 0) name = name.slice(0, name.lastIndexOf(" - "));
    // Copy for a carousel goes with every card ("Just Dropped.copy.txt" covers card 1, card 2...).
    const cm = stemOf(name).match(CARD_RE);
    if (cm) name = stemOf(name).replace(cm[0], " ").replace(/\s{2,}/g, " ").trim() + extOf(name);
    // A copy file named without the extension ("Cap ad") has no extension to take off.
    const n = /\.[a-z0-9]{2,4}$/i.test(name) ? name : name + ".x";
    return parentOf(p) + "|" + adName(n).base;
  };
  const sizeRank = (label) => { if (!label) return 98; const i = SIZE_ORDER.indexOf(label); return i < 0 ? 99 : i; };
  const bySize = (a, b) => sizeRank(a.size) - sizeRank(b.size) || String(a.size).localeCompare(String(b.size));
  // Two files claiming the same size and version (say Hero.mp4 and Hero.mov) are left apart.
  const clashes = (entries) => new Set(entries.map((e) => `${e.ver}|${e.size}`)).size !== entries.length;

  // Returns the list with sizes and versions folded together. A folded entry is the newest
  // version's first size, with `_sizes` [{ label, path, item }] when it comes in several
  // sizes, `_verCount` / `_verLatest` when there are versions, and `_paths` (every file).
  function groupAds(items) {
    const byKey = new Map();
    const order = [];
    for (const it of items) {
      const info = adInfo(it);
      let g = byKey.get(info.key);
      if (!g) { g = []; byKey.set(info.key, g); order.push(g); }
      g.push({ it, ...info });
    }
    const out = [];
    for (const g of order) {
      if (g.length === 1 || clashes(g)) { g.forEach((e) => out.push(e.it)); continue; }
      const latestVer = Math.max(...g.map((e) => e.ver));
      const cur = g.filter((e) => e.ver === latestVer).sort(bySize);
      const verCount = new Set(g.map((e) => e.ver)).size;
      const all = cur.map((e) => e.it);
      const statuses = new Set(all.map((x) => x.status));
      const latest = all.map((x) => (x.mtime ? Date.parse(x.mtime) : 0)).reduce((a, b) => Math.max(a, b), 0);
      out.push({
        ...all[0],
        _sizes: cur.length > 1 ? cur.map((e) => ({ label: e.size || "Original", path: e.it.path, item: e.it })) : null,
        _verCount: verCount > 1 ? verCount : 0,
        _verLatest: latestVer,
        _paths: g.map((e) => e.it.path),
        status: statuses.size === 1 ? all[0].status : statuses.has("changes") ? "changes" : "pending",
        likes: Math.max(...all.map((x) => x.likes || 0)),
        comments: all.reduce((n, x) => n + (x.comments || 0), 0),
        openComments: all.reduce((n, x) => n + (x.openComments || 0), 0),
        seen: all.every((x) => x.seen !== false),
        hidden: g.every((e) => e.it.hidden),
        tags: [...new Set(all.flatMap((x) => x.tags || []))],
        campaigns: [...new Set(all.flatMap((x) => x.campaigns || []))],
        mtime: latest ? new Date(latest).toISOString() : all[0].mtime,
      });
    }
    return foldCarousels(out);
  }

  // Carousels: one ad made of several cards, named "<Ad name> card 1", "card 2"... (or "slide 1").
  // Each card still stacks its own sizes and versions; the cards then fold into one carousel
  // entry with `_carousel` [{ n, path, item }] in card order, `_paths` (every file of every card)
  // and `_approvePaths` (the newest file of every size of every card), so Approve, Favorite,
  // campaigns and Trash cover the whole carousel.
  const CARD_RE = /(?:^|[\s_\-.(\[])(?:card|slide)\s*[_\-]?\s*(\d{1,2})(?=$|[\s_\-.)\]])/i;
  function cardOf(it) {
    const st = stemOf(it.name);
    const m = st.match(CARD_RE);
    if (!m) return null;
    const rest = st.replace(m[0], " ").replace(/\s{2,}/g, " ").trim() + extOf(it.name);
    return { n: Number(m[1]), key: [it.clientSlug || "", parentOf(it.path), kindOf(it), adName(rest).base].join("|") };
  }
  function foldCarousels(list) {
    const groups = new Map();
    const order = [];
    for (const e of list) {
      const c = cardOf(e);
      if (!c) { order.push(e); continue; }
      let g = groups.get(c.key);
      if (!g) { g = { cards: [] }; groups.set(c.key, g); order.push(g); }
      g.cards.push({ n: c.n, e });
    }
    return order.map((x) => {
      if (!x.cards) return x;
      if (x.cards.length === 1) return x.cards[0].e;
      const cards = x.cards.sort((a, b) => a.n - b.n);
      const all = cards.map((c) => c.e);
      const statuses = new Set(all.map((a) => a.status));
      return {
        ...all[0],
        _carousel: cards.map((c) => ({ n: c.n, path: c.e.path, item: c.e })),
        // The carousel's own name: the file name without "card 1", the size and the extension.
        _title: (() => { let t = stemOf(all[0].name); const cm = t.match(CARD_RE); if (cm) t = t.replace(cm[0], " "); const sm = t.match(SIZE_RE); if (sm) t = t.replace(sm[0], " "); return t.replace(/[\s_]{2,}/g, " ").trim(); })(),
        _paths: all.flatMap((a) => a._paths || [a.path]),
        _approvePaths: all.flatMap((a) => (a._sizes ? a._sizes.map((v) => v.path) : [a.path])),
        status: statuses.size === 1 ? all[0].status : statuses.has("changes") ? "changes" : statuses.has("rejected") ? "rejected" : "pending",
        likes: Math.max(...all.map((a) => a.likes || 0)),
        comments: all.reduce((n, a) => n + (a.comments || 0), 0),
        openComments: all.reduce((n, a) => n + (a.openComments || 0), 0),
        seen: all.every((a) => a.seen !== false),
        hidden: all.every((a) => a.hidden),
        tags: [...new Set(all.flatMap((a) => a.tags || []))],
        campaigns: [...new Set(all.flatMap((a) => a.campaigns || []))],
        mtime: all.map((a) => a.mtime).sort().pop(),
      };
    });
  }
  // Sizes (same version) and versions (same size) of one file, from its folder listing.
  function adFamily(items, path) {
    const me = items.find((i) => i.path === path);
    if (!me) return { sizes: [], versions: [], ver: 1, latestVer: 1 };
    const mine = adInfo(me);
    const g = items.map((i) => ({ it: i, ...adInfo(i) })).filter((e) => e.key === mine.key);
    if (clashes(g)) return { sizes: [], versions: [], ver: 1, latestVer: 1 };
    const sizes = g.filter((e) => e.ver === mine.ver).sort(bySize).map((e) => ({ label: e.size || "Original", path: e.it.path }));
    const vers = [...new Set(g.map((e) => e.ver))].sort((a, b) => a - b);
    const versions = vers.map((n) => {
      const same = g.find((e) => e.ver === n && e.size === mine.size) || g.filter((e) => e.ver === n).sort(bySize)[0];
      return { n, path: same.it.path };
    });
    return { sizes, versions, ver: mine.ver, latestVer: vers[vers.length - 1] };
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

  // Select mode, shared by every ad list and the "Waiting on you" box: tick several ads, then act
  // on all of them at once (every size, version and carousel card of each).
  function selectKit({ slug, items, zipName, rerender, trashView = () => false, getDel = () => null }) {
    const k = { on: false, current: [], picked: new Set() };
    const picked = k.picked;
    let busy = false;
    const selBar = h("div", { class: "sel-bar", role: "toolbar", "aria-label": "Selected ads" });
    const st = { get select() { return k.on; }, get hidden() { return trashView(); } };
    const render = () => rerender();
    k.bar = selBar;
    k.setList = (list) => { k.current = list; for (const p of [...picked]) if (!list.some((a) => a.path === p)) picked.delete(p); };
    k.button = () => h("button", { class: "btn small" + (k.on ? " on-warn" : ""), type: "button", title: "Pick several ads and approve, trash or download them together",
      onclick: () => { k.on = !k.on; picked.clear(); render(); } }, k.on ? "Done selecting" : "☑ Select");
    // A tile in select mode: a tap ticks it instead of opening or playing it.
    k.pickable = pickable;
    k.paintBar = () => paintBar();
    function pickable(el, it) {
      if (!st.select) return el;
      const box = h("span", { class: "pick-box", "aria-hidden": "true" }, "✓");
      el.classList.add("pickable");
      el.classList.toggle("picked", picked.has(it.path));
      el.setAttribute("role", "checkbox");
      el.setAttribute("aria-checked", picked.has(it.path) ? "true" : "false");
      el.append(box);
      el.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (picked.has(it.path)) picked.delete(it.path); else picked.add(it.path);
        el.classList.toggle("picked", picked.has(it.path));
        el.setAttribute("aria-checked", picked.has(it.path) ? "true" : "false");
        paintBar();
      }, true);
      return el;
    }

    const sizesOf = (a) => [a.path, ...(a._approvePaths || (a._sizes || []).map((v) => v.path)).filter((p) => p !== a.path)];
    const filesOf = (a) => [...new Set([a.path, ...(a._paths || []), ...sizesOf(a)])];
    const touch = (paths, fn) => { const set = new Set(paths); items.forEach((it) => { if (set.has(it.path)) fn(it); }); };
    const chosen = () => k.current.filter((a) => picked.has(a.path));

    // Runs one request per ad, in order, with a running count. Stops at the first error.
    async function bulk(verb, fn, doneMsg) {
      const list = chosen();
      if (!list.length || busy) return;
      busy = true; paintBar();
      let done = 0;
      try {
        for (const a of list) {
          toast(`${verb} ${done + 1} of ${list.length}…`);
          await fn(a, a.clientSlug || slug);
          done++;
        }
        toast(doneMsg(done));
      } catch (err) {
        toast(`${err.message} (${done} of ${list.length} done)`);
      }
      busy = false;
      state.listCache.clear();
      return done;
    }
    const setStatus = (status, label) => bulk("Updating", async (a, cs) => {
      const paths = sizesOf(a);
      await api("POST", `/api/c/${enc(cs)}/status`, { path: a.path, status, also: paths.slice(1) });
      touch(paths, (it) => (it.status = status));
    }, (n) => `${n} ad${n === 1 ? "" : "s"} ${label}.`).then(() => render());
    const favorite = () => bulk("Adding", async (a, cs) => {
      const paths = sizesOf(a);
      await api("POST", `/api/c/${enc(cs)}/like`, { path: a.path, also: paths.slice(1), liked: true });
      touch(paths, (it) => { if (!it.liked) { it.liked = true; it.likes = (it.likes || 0) + 1; } });
    }, (n) => `${n} ad${n === 1 ? "" : "s"} added to favorites.`).then(() => render());
    const trash = (hide) => bulk(hide ? "Moving" : "Restoring", async (a, cs) => {
      const paths = filesOf(a);
      await api("POST", `/api/c/${enc(cs)}/hide`, { path: a.path, also: paths.slice(1), hidden: hide });
      touch(paths, (it) => (it.hidden = hide));
    }, (n) => hide ? `${n} ad${n === 1 ? "" : "s"} moved to the trash. Tap Trash to get them back.` : `${n} ad${n === 1 ? "" : "s"} restored.`)
      .then(() => { picked.clear(); render(); });
    const download = () => {
      const list = chosen();
      const files = list.flatMap((a) => (a._sizes ? a._sizes.map((v) => v.item) : a._carousel ? a._carousel.map((c) => c.item) : [a]));
      if (files.length) saveMany(files.map((f) => ({ src: mediaUrl(f.clientSlug || slug, f.path), name: f.name, size: f.size })), zipName || "Genvyd ads");
    };
    async function toCampaign() {
      const list = chosen();
      const slugs = [...new Set(list.map((a) => a.clientSlug || slug))];
      if (slugs.length !== 1) return toast("Pick ads from one client at a time to add them to a campaign.");
      const cs = slugs[0];
      const close = () => { layer.remove(); document.removeEventListener("keydown", esc); };
      const esc = (e) => { if (e.key === "Escape") close(); };
      const rows = h("div", { class: "menu-camps" }, h("div", { class: "muted menu-loading" }, "Loading campaigns…"));
      const addTo = async (id, name) => {
        close();
        await bulk("Adding", async (a) => {
          await api("POST", `/api/c/${enc(cs)}/campaigns/${id}/items`, { path: a.path, also: sizesOf(a).slice(1) });
          touch(sizesOf(a), (it) => { it.campaigns = [...new Set([...(it.campaigns || []), name])]; });
        }, (n) => `${n} ad${n === 1 ? "" : "s"} added to ${name}.`);
        render();
      };
      const panel = h("div", { class: "tile-menu save-sheet", role: "dialog", "aria-label": "Add to campaign" },
        h("div", { class: "menu-head" },
          h("div", { class: "menu-title" }, `Add ${list.length} ad${list.length === 1 ? "" : "s"} to a campaign`),
          h("button", { class: "menu-x", type: "button", "aria-label": "Close", onclick: close }, "×")),
        rows);
      const layer = h("div", { class: "menu-layer save-layer", onclick: (e) => { if (e.target === layer) close(); } }, panel);
      document.addEventListener("keydown", esc);
      document.body.append(layer);
      try {
        const r = await api("GET", `/api/c/${enc(cs)}/campaigns?path=${enc(list[0].path)}`);
        let creator = null;
        if (state.me.admin) {
          const input = h("input", { class: "menu-input", placeholder: "New campaign name", maxlength: "120", onkeydown: (e) => { if (e.key === "Enter") create(); } });
          const create = async () => {
            const name = input.value.trim();
            if (!name) return input.focus();
            try { const c = await api("POST", `/api/c/${enc(cs)}/campaigns`, { name }); addTo(c.id, name); } catch (err) { toast(err.message); }
          };
          creator = h("div", { class: "menu-create" }, input, h("button", { class: "btn small primary", type: "button", onclick: create }, "Create"));
        }
        fill(rows,
          r.campaigns.length
            ? r.campaigns.map((cp) => h("button", { class: "menu-item camp-row", type: "button", onclick: () => addTo(cp.id, cp.name) },
                h("span", { class: "camp-check" }, "+"), h("span", { class: "camp-name" }, cp.name)))
            : h("div", { class: "muted menu-loading" }, state.me.admin ? "No campaigns yet. Name one below." : "No campaigns set up yet."),
          creator);
      } catch (err) { fill(rows, h("div", { class: "muted menu-loading" }, err.message)); }
    }
    function paintBar() {
      const list = chosen();
      const n = list.length;
      const none = n === 0 || busy;
      const b = (label, onclick, cls = "") => h("button", { class: "btn small " + cls, type: "button", disabled: none, onclick }, label);
      const allOn = n === k.current.length;
      fill(selBar,
        h("div", { class: "sel-count" },
          h("strong", {}, n ? `${n} selected` : "Tap ads to select them"),
          h("button", { class: "linkish", type: "button", disabled: busy, onclick: () => {
            if (allOn) picked.clear(); else k.current.forEach((a) => picked.add(a.path));
            render();
          } }, allOn ? "Clear" : `Select all ${k.current.length}`)),
        h("div", { class: "sel-actions" },
          st.hidden
            ? [b("↺ Restore", () => trash(false)),
               state.me.admin ? b("Delete for good", () => getDel()(chosen()).then(() => { picked.clear(); render(); }), "danger") : null,
               b("↓ Download", download)]
            : [b("✓ Approve", () => setStatus("approved", "approved"), "sel-ok"),
               b("Request changes", () => setStatus("changes", "marked changes requested")),
               b("✕ No", () => setStatus("rejected", "marked No"), "sel-no"),
               b("Awaiting review", () => setStatus("pending", "set back to awaiting review")),
               b("♥ Favorite", favorite),
               b("+ Campaign", toCampaign),
               b("🗑 Trash", () => trash(true)),
               b("↓ Download", download)]),
      );
    }
    return k;
  }

  function mediaBrowser(items, { tileFn, emptyText, slug, zipName }) {
    const prefs = loadPrefs();
    const st = { type: prefs.type || "all", sort: prefs.sort || "newest", status: "all", tag: null, seen: "all", fit: prefs.fit || "fit", hidden: false };
    const root = h("div", { class: "browser" });
    let delHidden = null;
    const sel = selectKit({ slug, items, zipName, rerender: () => render(), trashView: () => st.hidden, getDel: () => delHidden });
    // Tiles report hides, unhides and deletes so the grid updates in place.
    root.addEventListener("gv-change", (e) => {
      const { paths, hidden, deleted } = e.detail;
      const set = new Set(paths);
      if (deleted) { for (let i = items.length - 1; i >= 0; i--) if (set.has(items[i].path)) items.splice(i, 1); }
      else items.forEach((it) => { if (set.has(it.path)) it.hidden = hidden; });
      state.listCache.clear();
      render();
    });
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
      const grouped = groupAds(items);
      const hiddenAds = grouped.filter((a) => a.hidden);
      if (st.hidden && !hiddenAds.length) st.hidden = false;
      const ads = grouped.filter((a) => !!a.hidden === st.hidden);
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
        [["all", "Any status"], ["pending", "Awaiting review"], ["changes", "Changes requested"], ["approved", "Approved"], ["rejected", "No, not using"]].map(([v, l]) =>
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
      // Hidden ads: out of the way, one tap to see them, Unhide to bring one back.
      const hiddenBtn = hiddenAds.length
        ? h("button", { class: "btn small" + (st.hidden ? " on-warn" : ""), type: "button", title: "Ads you or the client moved to the trash", onclick: () => { st.hidden = !st.hidden; render(); } },
            st.hidden ? "← Back to all ads" : `🗑 Trash (${hiddenAds.length})`)
        : null;
      const hiddenNote = st.hidden
        ? h("div", { class: "card hidden-note" },
            h("div", {},
              h("strong", {}, `${hiddenAds.length} ad${hiddenAds.length === 1 ? "" : "s"} in the trash. `),
              state.me.admin
                ? "Only shown here. Restore one from its ... menu, or delete them for good. Deleting moves the files to the \"_Deleted files\" folder on the Synology."
                : "Only shown here. Tap ... on one and pick Restore to bring it back."),
            state.me.admin
              ? h("button", { class: "btn small danger", type: "button", onclick: () => deleteHidden(hiddenAds) }, `Delete all ${hiddenAds.length} for good`)
              : null)
        : null;
      delHidden = deleteHidden;
      async function deleteHidden(list) {
        const paths = list.flatMap((a) => a._paths || [a.path]).map((p) => ({ p, s: (list.find((a) => (a._paths || [a.path]).includes(p)) || {}).clientSlug || slug }));
        if (!confirm(`Delete ${list.length} hidden ad${list.length === 1 ? "" : "s"} (${paths.length} file${paths.length === 1 ? "" : "s"})?\n\nThe files move to "_Deleted files" on the Synology, and their comments and approvals are removed from the portal.`)) return;
        const done = [];
        for (let i = 0; i < paths.length; i++) {
          toast(`Deleting ${i + 1} of ${paths.length}…`);
          try { await api("POST", `/api/c/${enc(paths[i].s)}/delete`, { path: paths[i].p }); done.push(paths[i].p); }
          catch (err) { toast(err.message); break; }
        }
        if (done.length) {
          root.dispatchEvent(new CustomEvent("gv-change", { detail: { paths: done, deleted: true } }));
          toast(`Deleted ${done.length} file${done.length === 1 ? "" : "s"}.`);
        }
      }

      // Download everything on screen right now (all sizes of each ad, newest versions).
      const files = shown.flatMap((a) => (a._sizes ? a._sizes.map((v) => v.item) : [a]));
      const dlAll = files.length > 1 && !st.hidden
        ? h("button", {
            class: "btn small primary dl-all", type: "button",
            title: "Download everything shown here, with the filters you have set",
            onclick: () => saveMany(files.map((f) => ({ src: mediaUrl(f.clientSlug || slug, f.path), name: f.name, size: f.size })), zipName || "Genvyd ads"),
          }, `↓ Download all ${files.length}`)
        : null;
      sel.setList(shown);
      const grid = (list) => h("div", { class: "grid" }, list.map((it) => sel.pickable(tileFn(it), it)));
      const selectBtn = shown.length ? sel.button() : null;
      let body;
      if (!shown.length) {
        body = h("div", { class: "card empty muted" }, ads.length ? "Nothing matches these filters." : grouped.length ? "Everything here is in the trash. Tap Trash to see it." : emptyText || "Nothing here yet.");
      } else if (st.type === "all") {
        const groups = [["video", "VIDEOS"], ["image", "PHOTOS"], ["other", "OTHER FILES"]]
          .map(([k, label]) => [label, shown.filter((it) => kindOfItem(it) === k)])
          .filter(([, list]) => list.length);
        body = h("div", {}, groups.map(([label, list]) => [h("div", { class: "section-label mono muted" }, `${label} · ${list.length}`), grid(list)]));
      } else {
        body = grid(shown);
      }

      fill(root, 
        ...[h("div", { class: "toolbar" }, typeTabs, h("div", { class: "toolbar-right" }, seenSel, statusSel, sortSel, fitSeg, markAll, hiddenBtn, selectBtn, dlAll)), hiddenNote, tagRow, body, sel.on ? sel.bar : null].filter(Boolean),
      );
      root.classList.toggle("selecting", sel.on);
      if (sel.on) sel.paintBar();
    }

    render();
    return root;
  }

  // One inline video plays at a time.
  let playingVideo = null;

  // A grid tile. Videos show their length and play right in the grid (tap the play
  // button); the Open button (and the name) go to the full-size page with comments.
  // The ad's copy under its preview: the first two lines and how many are approved.
  const COPY_ORDER = ["headline", "description", "link", "primary", "tagline", "caption", "cta", "other"];
  function tileCopy(list) {
    if (!list || !list.length) return null;
    const ok = list.filter((x) => x.status === "approved").length;
    const ch = list.filter((x) => x.status === "changes").length;
    const firsts = [...list].sort((a, b) => COPY_ORDER.indexOf(a.kind) - COPY_ORDER.indexOf(b.kind) || a.id - b.id).slice(0, 2);
    return h("div", { class: "tile-copy" },
      h("div", { class: "mono tile-copy-head" }, "AD COPY",
        h("span", { class: "muted" }, ` · ${list.length} line${list.length === 1 ? "" : "s"}`),
        ok ? h("span", { style: "color:var(--ok)" }, ` · ${ok} ✓`) : null,
        ch ? h("span", { style: "color:var(--warn)" }, ` · ${ch} to change`) : null),
      firsts.map((x) => h("div", { class: "tile-copy-line" + (x.status === "approved" ? " is-approved" : x.status === "changes" ? " is-changes" : "") },
        h("span", { class: "mono muted" }, (COPY_KIND_LABEL[x.kind] || x.kind) + " "), x.text.split("\n")[0])),
    );
  }

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

    // Carousel: small previews of every card along the bottom of the picture; tap one to open it.
    if (it._carousel) {
      const cs = it.clientSlug || slug;
      const strip = h("div", { class: "car-strip", title: `${it._carousel.length} cards in this carousel` },
        it._carousel.slice(0, 6).map((c, i) => {
          const mini = c.item.kind === "video"
            ? h("span", { class: "car-mini car-mini-video" }, String(i + 1))
            : h("img", { class: "car-mini", "data-src": mediaUrl(cs, c.path), alt: `Card ${i + 1}`, loading: "lazy" });
          if (mini.tagName === "IMG") lazy.observe(mini);
          return h("span", { class: "car-mini-wrap", role: "link", tabindex: "0",
            onclick: (e) => { e.preventDefault(); e.stopPropagation(); location.hash = `#/c/${enc(cs)}/i/${enc(c.path)}`; } }, mini);
        }),
        it._carousel.length > 6 ? h("span", { class: "car-more mono" }, `+${it._carousel.length - 6}`) : null);
      thumb.append(strip);
    }
    const pill = pills[0];
    const likesEl = h("span", {}, `♥ ${it.likes}`);
    const campLine = h("div", { class: "mono tile-folder tile-camps" }, it.campaigns && it.campaigns.length ? `In ${it.campaigns.join(", ")}` : "");
    const more = h("button", {
      class: "more-btn", type: "button", title: "More: add to a campaign, favorite, approve", "aria-label": "More options", "aria-haspopup": "menu",
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); openTileMenu(e.currentTarget, slug, it, { pill, likesEl, campLine, href, src }); },
    }, h("span", { html: ICON_DOTS }));
    if (it.status === "rejected") thumb.append(h("div", { class: "no-stamp", "aria-hidden": "true" }, "NO"));
    return h("div", { class: "card tile" + (it.status === "rejected" ? " is-no" : "") + (it._carousel ? " is-carousel" : "") },
      thumb,
      h("div", { class: "meta-wrap" }, more, h("a", { class: "tile-meta", href },
        h("div", { class: "tile-name", title: it.name }, it._title || it.name),
        it._sizes || it._verCount || it._carousel
          ? h("div", { class: "tile-sizes" },
              it._carousel ? h("span", { class: "size-chip car-chip", title: "One ad with several cards people swipe through" }, `Carousel · ${it._carousel.length} cards`) : null,
              (it._sizes || []).map((v) => h("span", { class: "size-chip" }, v.label)),
              it._verCount ? h("span", { class: "size-chip ver-chip", title: `${it._verCount} versions, showing the newest` }, `v${it._verLatest} · ${it._verCount} versions`) : null)
          : null,
        showFolder && it.folder ? h("div", { class: "mono muted tile-folder" }, it.folder) : null,
        tileCopy(it._copy),
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

  // ---- Download all: one zip on computers, the share sheet on phones ---------
  // A small "stored" zip writer (no compression: videos and photos are already
  // compressed), so there is nothing to install and nothing runs on the server.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf, crc = 0) {
    crc = ~crc >>> 0;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return ~crc >>> 0;
  }
  function makeZip(entries) {
    // entries: [{ name, chunks: Uint8Array[], size, crc }]
    const enc8 = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const e of entries) {
      const nameBytes = enc8.encode(e.name);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, e.crc, true);
      lh.setUint32(18, e.size, true); lh.setUint32(22, e.size, true); lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, nameBytes, ...e.chunks);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, e.crc, true); ch.setUint32(20, e.size, true); ch.setUint32(24, e.size, true);
      ch.setUint16(28, nameBytes.length, true); ch.setUint32(42, offset, true);
      central.push(ch.buffer, nameBytes);
      offset += 30 + nameBytes.length + e.size;
    }
    const cdSize = central.reduce((n, b) => n + b.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
  }

  function saveMany(list, zipName) {
    closeTileMenu();
    const ctrl = new AbortController();
    const total = list.reduce((n, f) => n + (f.size || 0), 0);
    const status = h("div", { class: "muted save-status" }, `Getting ${list.length} files ready${total ? ` (${fmtSize(total)})` : ""}…`);
    const bar = h("div", { class: "upload-bar save-bar" }, h("span"));
    const actions = h("div", { class: "save-actions" });
    const close = () => { ctrl.abort(); layer.remove(); document.removeEventListener("keydown", esc); };
    const esc = (e) => { if (e.key === "Escape") close(); };
    const panel = h("div", { class: "tile-menu save-sheet", role: "dialog", "aria-label": "Download all" },
      h("div", { class: "menu-head" },
        h("div", { class: "menu-title" }, `${zipName} · ${list.length} files`),
        h("button", { class: "menu-x", type: "button", "aria-label": "Close", onclick: close }, "×"),
      ),
      status, bar, actions,
    );
    const layer = h("div", { class: "menu-layer save-layer", onclick: (e) => { if (e.target === layer) close(); } }, panel);
    document.addEventListener("keydown", esc);
    document.body.append(layer);

    const safe = (n) => n.replace(/[\\/:*?"<>|]+/g, "-").trim() || "file";
    const download = (blob, name) => {
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: name, style: "display:none" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    };

    (async () => {
      try {
        const got = [];
        const used = new Set();
        let done = 0;
        for (let i = 0; i < list.length; i++) {
          const f = list[i];
          const res = await fetch(f.src, { signal: ctrl.signal, credentials: "same-origin" });
          if (!res.ok) throw new Error(`Could not get ${f.name} (${res.status}).`);
          const reader = res.body.getReader();
          const chunks = [];
          let size = 0, crc = 0;
          for (;;) {
            const { done: end, value } = await reader.read();
            if (end) break;
            chunks.push(value); size += value.length; crc = crc32(value, crc); done += value.length;
            const pct = total ? Math.min(99, Math.round((done / total) * 100)) : Math.round(((i + 0.5) / list.length) * 100);
            bar.firstChild.style.width = pct + "%";
            status.textContent = `File ${i + 1} of ${list.length} · ${pct}%`;
          }
          let name = safe(f.name);
          for (let n = 2; used.has(name.toLowerCase()); n++) name = safe(f.name).replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext || ""}`);
          used.add(name.toLowerCase());
          got.push({ name, chunks, size, crc, type: res.headers.get("content-type") || "application/octet-stream" });
        }
        bar.firstChild.style.width = "100%";
        const zipFile = `${safe(zipName)}.zip`;
        const shareFiles = got.map((g) => new File([new Blob(g.chunks, { type: g.type })], g.name, { type: g.type }));
        const canShare = navigator.canShare && navigator.share && navigator.canShare({ files: shareFiles });
        if (canShare) {
          status.textContent = `All ${got.length} ready. Pick "Save ${got.length} Items" for Photos, or Save to Files.`;
          fill(actions,
            h("button", { class: "btn primary save-main", type: "button", onclick: async () => {
              try { await navigator.share({ files: shareFiles, title: zipName }); close(); }
              catch (err) { if (err && err.name !== "AbortError") { download(makeZip(got), zipFile); close(); } }
            } }, `Save or share all ${got.length}`),
            h("button", { class: "btn save-alt", type: "button", onclick: () => { download(makeZip(got), zipFile); close(); } }, "Download as one zip instead"),
          );
        } else {
          download(makeZip(got), zipFile);
          status.textContent = `Downloaded ${zipFile}. Check your Downloads folder.`;
          fill(actions, h("button", { class: "btn save-main", type: "button", onclick: close }, "Done"));
        }
      } catch (err) {
        if (err && err.name === "AbortError") return;
        status.textContent = err.message || "Something went wrong.";
        fill(actions, h("button", { class: "btn save-main", type: "button", onclick: close }, "Close"));
      }
    })();
  }

  // Save or share a file without leaving the portal. The file is fetched first, then:
  // phones get the share sheet (Save Image to Photos, Save to Files, Messages, AirDrop),
  // computers get a normal download. Never navigates away, so the home screen app
  // never gets stuck on a bare file with no way back.
  function saveFile(src, name) {
    closeTileMenu();
    const ctrl = new AbortController();
    const status = h("div", { class: "muted save-status" }, "Getting it ready…");
    const bar = h("div", { class: "upload-bar save-bar" }, h("span"));
    const actions = h("div", { class: "save-actions" });
    const close = () => { ctrl.abort(); layer.remove(); document.removeEventListener("keydown", esc); };
    const esc = (e) => { if (e.key === "Escape") close(); };
    const panel = h("div", { class: "tile-menu save-sheet", role: "dialog", "aria-label": "Save or share" },
      h("div", { class: "menu-head" },
        h("div", { class: "menu-title", title: name }, name),
        h("button", { class: "menu-x", type: "button", "aria-label": "Close", onclick: close }, "×"),
      ),
      status, bar, actions,
    );
    const layer = h("div", { class: "menu-layer save-layer", onclick: (e) => { if (e.target === layer) close(); } }, panel);
    document.addEventListener("keydown", esc);
    document.body.append(layer);

    const download = (file) => {
      const url = URL.createObjectURL(file);
      const a = h("a", { href: url, download: name, style: "display:none" });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    };

    (async () => {
      try {
        const res = await fetch(src, { signal: ctrl.signal, credentials: "same-origin" });
        if (!res.ok) throw new Error(`Could not get the file (${res.status}).`);
        const total = Number(res.headers.get("content-length") || 0);
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          if (total) { bar.firstChild.style.width = Math.round((got / total) * 100) + "%"; status.textContent = `Getting it ready… ${Math.round((got / total) * 100)}%`; }
        }
        bar.firstChild.style.width = "100%";
        const type = res.headers.get("content-type") || "application/octet-stream";
        const file = new File([new Blob(chunks, { type })], name, { type });
        const canShare = navigator.canShare && navigator.share && navigator.canShare({ files: [file] });
        if (canShare) {
          status.textContent = "Ready. Pick Save Image (or Save Video) for Photos, Save to Files, or send it to someone.";
          fill(actions,
            h("button", { class: "btn primary save-main", type: "button", onclick: async () => {
              try { await navigator.share({ files: [file], title: name }); close(); }
              catch (err) { if (err && err.name !== "AbortError") { download(file); close(); } }
            } }, "Save or share"),
            h("button", { class: "btn save-alt", type: "button", onclick: () => { download(file); close(); } }, "Download file instead"),
          );
        } else {
          download(file);
          status.textContent = "Downloaded. Check your Downloads folder.";
          fill(actions, h("button", { class: "btn save-main", type: "button", onclick: close }, "Done"));
        }
      } catch (err) {
        if (err && err.name === "AbortError") return;
        status.textContent = err.message || "Something went wrong.";
        fill(actions, h("button", { class: "btn save-main", type: "button", onclick: close }, "Close"));
      }
    })();
  }

  // The "..." menu on a tile: add to or take out of campaigns (or start a new one),
  // ---- Rename (admin only) -------------------------------------------------------
  // Renames the file on the Synology and moves its approvals, comments, favorites, campaign
  // spots, trash status and history with it (server side, all or nothing). Offers the whole
  // stack (every version and size) and matching thumbnails, and warns when a name would
  // break the stacking rules in "_Claude feed/file-naming-rules.md".
  const SEP = "[\\s_\\-.]+";
  const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Splits a file name into the ad name (base), its size, placement words and version.
  function nameParts(name) {
    let rest = stemOf(name);
    let size = null, sizeLit = null;
    const m = rest.match(SIZE_RE);
    if (m) { size = `${Number(m[1])}:${Number(m[2])}`; sizeLit = m[0].replace(/^[\s_\-.(\[]+/, ""); rest = rest.replace(m[0], " "); }
    let ver = 1, verLit = null;
    const v = rest.match(VER_RE);
    if (v) { ver = Number(v[1]) || 1; verLit = v[0].replace(/^[\s_\-.(\[]+/, ""); rest = rest.replace(v[0], " "); }
    else { const d = rest.match(DUP_RE); if (d) { ver = Number(d[1]) || 1; verLit = d[0].trim(); rest = rest.replace(DUP_RE, ""); } }
    const placements = rest.match(PLACEMENT_RE) || [];
    const base = rest.replace(PLACEMENT_RE, " ").replace(/\s{2,}/g, " ").replace(/^[\s_\-.]+|[\s_\-.]+$/g, "").trim();
    return { base, size, sizeLit, ver, verLit, placements, ext: extOf(name) };
  }
  // The same file renamed to a new ad name, keeping its size, placement words and version.
  const stackName = (name, newBase) => {
    const p = nameParts(name);
    return [newBase.trim(), p.sizeLit, ...p.placements, p.ver > 1 ? `v${p.ver}` : null].filter(Boolean).join(" ") + p.ext;
  };
  // Thumbnails that belong to a video: "<video name> thumbnail ...". Returns [{ item, rest }].
  function thumbsOf(items, video) {
    const base = nameParts(video.name).base;
    const toks = base.split(/[\s_\-.]+/).filter(Boolean);
    if (!toks.length) return [];
    const re = new RegExp("^" + toks.map(escRe).join(SEP) + "(?=" + SEP + "thumb)", "i");
    return items.filter((i) => i.kind === "image" && parentOf(i.path) === parentOf(video.path) && re.test(i.name))
      .map((i) => ({ item: i, rest: i.name.slice(i.name.match(re)[0].length) }));
  }
  function renameWarnings(items, plan) {
    const warn = [];
    const renamed = new Map(plan.map((r) => [r.path, r.name]));
    const after = items.map((i) => (renamed.has(i.path) ? { ...i, name: renamed.get(i.path), path: parentOf(i.path) ? parentOf(i.path) + "/" + renamed.get(i.path) : renamed.get(i.path), _was: i.path } : i));
    const keyBefore = new Map(items.map((i) => [i.path, adInfo(i).key]));
    const keyAfter = new Map(after.map((i) => [i._was || i.path, adInfo(i).key]));
    const nameOf = new Map(items.map((i) => [i.path, i.name]));
    for (const r of plan) {
      const oldName = nameOf.get(r.path) || baseName(r.path);
      const o = nameParts(oldName), n = nameParts(r.name);
      // Stops stacking with versions or sizes that are not renamed with it.
      const fam = items.filter((i) => i.path !== r.path && keyBefore.get(i.path) === keyBefore.get(r.path));
      const lost = fam.filter((i) => keyAfter.get(i.path) !== keyAfter.get(r.path));
      if (lost.length) warn.push(`"${r.name}" will stop stacking with ${lost.length} other version${lost.length === 1 ? "" : "s"} or size${lost.length === 1 ? "" : "s"} (${lost.slice(0, 3).map((i) => i.name).join(", ")}${lost.length > 3 ? "…" : ""}). Rename all versions and sizes together instead.`);
      const joins = after.filter((i) => !renamed.has(i._was || i.path) && !fam.some((f) => f.path === i.path) && adInfo(i).key === keyAfter.get(r.path));
      if (joins.length) warn.push(`"${r.name}" will stack with ${joins.map((i) => `"${i.name}"`).join(", ")}, which is already in this folder.`);
      if (o.size && !n.size) warn.push(`"${r.name}" drops the size (${o.sizeLit}) from the name, so it won't line up with the other sizes. Keep it as two numbers with an x, like 9x16.`);
      if (o.size && n.size && o.size !== n.size) warn.push(`"${r.name}" changes the size from ${o.sizeLit} to ${n.sizeLit}.`);
      if (o.ver > 1 && n.ver !== o.ver) warn.push(`"${r.name}" ${n.ver > 1 ? `changes the version from v${o.ver} to v${n.ver}` : `drops the version mark (${o.verLit}), so it would count as v1`}.`);
      if (/\b(final|fixed|edit|edited|revised)\b/i.test(n.base) && !/\b(final|fixed|edit|edited|revised)\b/i.test(o.base)) warn.push(`"${r.name}" adds a word like "final", "fixed", "edit" or "revised". Later versions must repeat it exactly or they won't stack. Leave it out if you can.`);
      if (!n.size && /\b\d{3,4}p\b/i.test(n.base)) warn.push(`"${r.name}": "1080p" is not a size. Use 9x16, 4x5, 1x1 or 16x9 if it has one.`);
    }
    // Two files that would claim the same size and version don't stack.
    const groups = new Map();
    for (const i of after) { const k = adInfo(i).key; groups.set(k, [...(groups.get(k) || []), i]); }
    for (const g of groups.values()) {
      if (!g.some((i) => renamed.has(i._was || i.path)) || g.length < 2) continue;
      const seen = new Map();
      for (const i of g) { const a = adInfo(i); const k = `${a.ver}|${a.size}`; if (seen.has(k)) warn.push(`"${seen.get(k)}" and "${i.name}" would both be the same size and version, so neither will stack.`); else seen.set(k, i.name); }
    }
    return [...new Set(warn)];
  }

  async function openRename(slug, it, opts = {}) {
    closeTileMenu();
    const dir = parentOf(it.path);
    let list = state.listCache.get(`${slug}|${dir}`);
    try { if (!list) { list = await api("GET", `/api/c/${enc(slug)}/list?dir=${enc(dir)}`); state.listCache.set(`${slug}|${dir}`, list); } }
    catch (err) { toast(err.message); return; }
    const items = list.items;
    const me = items.find((i) => i.path === it.path) || it;
    const myKey = adInfo(me).key;
    const family = items.filter((i) => adInfo(i).key === myKey).sort((a, b) => a.name.localeCompare(b.name));
    const st = { whole: family.length > 1, thumbs: true };
    const ext = extOf(me.name);

    const input = h("input", { class: "menu-input rename-input", maxlength: "120", spellcheck: "false", autocomplete: "off" });
    const extChip = h("span", { class: "mono rename-ext", title: "The file type stays the same" }, ext || "");
    const label = h("div", { class: "menu-label mono muted" });
    const modeBox = h("div");
    const preview = h("div", { class: "rename-preview" });
    const warnBox = h("div");
    const errBox = h("div");
    const save = h("button", { class: "btn small primary", type: "button" }, "Rename");
    const close = () => { layer.remove(); document.removeEventListener("keydown", esc); };
    const esc = (e) => { if (e.key === "Escape") close(); };

    const setMode = (whole) => {
      st.whole = whole;
      input.value = whole ? nameParts(me.name).base : stemOf(me.name);
      label.textContent = whole ? "NEW AD NAME (SIZES AND VERSIONS ARE ADDED FOR EACH FILE)" : "NEW NAME";
      extChip.hidden = whole || !ext;
      update();
    };
    function plan() {
      const typed = input.value.trim().replace(new RegExp(escRe(ext) + "$", "i"), "").trim();
      if (!typed) return { list: [], thumbs: [] };
      const main = st.whole
        ? family.map((f) => ({ path: f.path, name: stackName(f.name, typed) }))
        : [{ path: me.path, name: typed + ext }];
      // Thumbnails of any video being renamed: same words after the old ad name.
      const newBase = st.whole ? typed : nameParts(typed + ext).base || typed;
      const thumbs = [];
      for (const f of (st.whole ? family : [me])) {
        if (f.kind !== "video") continue;
        for (const t of thumbsOf(items, f)) {
          if (main.some((m) => m.path === t.item.path) || thumbs.some((x) => x.path === t.item.path)) continue;
          thumbs.push({ path: t.item.path, from: t.item.name, name: newBase + t.rest });
        }
      }
      return { list: main.filter((r) => r.name !== baseName(r.path)), thumbs };
    }
    function update() {
      const p = plan();
      const all = [...p.list, ...(st.thumbs ? p.thumbs.filter((t) => t.name !== t.from) : [])];
      const moving = new Set(all.map((r) => r.path.toLowerCase()));
      const taken = all.filter((r) => items.some((i) => i.name.toLowerCase() === r.name.toLowerCase() && !moving.has(i.path.toLowerCase())));
      const dupes = all.filter((r, i) => all.findIndex((x) => x.name.toLowerCase() === r.name.toLowerCase()) !== i);
      fill(preview,
        p.list.length || p.thumbs.length ? h("div", { class: "menu-label mono muted" }, "WILL BECOME") : null,
        p.list.map((r) => h("div", { class: "rename-row" }, h("span", { class: "muted" }, baseName(r.path)), h("span", { class: "rename-arrow" }, "→"), h("span", {}, r.name))),
        p.thumbs.length
          ? h("label", { class: "check rename-thumbs" },
              h("input", { type: "checkbox", checked: st.thumbs, onchange: (e) => { st.thumbs = e.target.checked; update(); } }),
              `Also rename ${p.thumbs.length === 1 ? "its thumbnail" : `its ${p.thumbs.length} thumbnails`} to match`)
          : null,
        st.thumbs ? p.thumbs.map((t) => h("div", { class: "rename-row" }, h("span", { class: "muted" }, t.from), h("span", { class: "rename-arrow" }, "→"), h("span", {}, t.name))) : null,
      );
      const errs = [
        ...taken.map((r) => `There is already a file called "${r.name}" in this folder.`),
        ...[...new Set(dupes.map((r) => r.name))].map((n) => `Two files would both be called "${n}".`),
      ];
      fill(errBox, errs.length ? h("div", { class: "rename-msg is-error" }, errs.map((e) => h("div", {}, e))) : null);
      const warns = all.length ? renameWarnings(items, all) : [];
      fill(warnBox, warns.length
        ? h("div", { class: "rename-msg is-warn" }, h("strong", {}, "Check the naming rules"), warns.map((w) => h("div", {}, w)))
        : null);
      save.disabled = !all.length || errs.length > 0;
      save.textContent = all.length > 1 ? `Rename ${all.length} files` : "Rename";
      save._plan = all;
    }
    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !save.disabled) { e.preventDefault(); save.click(); } });

    if (family.length > 1) {
      fill(modeBox, h("div", { class: "seg rename-seg" },
        h("button", { class: "seg-btn", type: "button", onclick: (e) => { modeBox.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === e.currentTarget)); setMode(true); } }, `All versions and sizes (${family.length})`),
        h("button", { class: "seg-btn", type: "button", onclick: (e) => { modeBox.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === e.currentTarget)); setMode(false); } }, "Just this file")));
      modeBox.querySelector(".seg-btn").classList.add("active");
    }

    save.onclick = async () => {
      const all = save._plan || [];
      if (!all.length) return;
      save.disabled = true;
      save.textContent = "Renaming…";
      try {
        const r = await api("POST", `/api/c/${enc(slug)}/rename`, { renames: all.map((x) => ({ path: x.path, name: x.name })) });
        state.listCache.clear();
        close();
        toast(r.renamed.length === 1 ? `Renamed to ${r.renamed[0].name}.` : `Renamed ${r.renamed.length} files.`);
        const mine = r.renamed.find((x) => x.from === it.path) || r.renamed[0];
        if (opts.onDone) opts.onDone(r, mine);
      } catch (err) {
        fill(errBox, h("div", { class: "rename-msg is-error" }, err.message));
        save.disabled = false;
        save.textContent = "Rename";
      }
    };

    const panel = h("div", { class: "tile-menu save-sheet rename-sheet", role: "dialog", "aria-label": "Rename" },
      h("div", { class: "menu-head" },
        h("div", { class: "menu-title" }, "Rename"),
        h("button", { class: "menu-x", type: "button", "aria-label": "Close", onclick: close }, "×"),
      ),
      h("div", { class: "menu-label mono muted" }, "CURRENT NAME"),
      h("div", { class: "rename-current" }, me.name),
      modeBox,
      label,
      h("div", { class: "rename-field" }, input, extChip),
      errBox,
      preview,
      warnBox,
      h("p", { class: "muted rename-note" }, "Approvals, comments, favorites, campaigns and trash move with the file. The client is not notified."),
      h("div", { class: "save-actions" }, h("button", { class: "btn small", type: "button", onclick: close }, "Cancel"), save),
    );
    const layer = h("div", { class: "menu-layer save-layer", onclick: (e) => { if (e.target === layer) close(); } }, panel);
    document.addEventListener("keydown", esc);
    document.body.append(layer);
    setMode(st.whole);
    input.focus();
    input.select();
  }

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
    const also = (it._approvePaths || (it._sizes || []).map((v) => v.path)).filter((p) => p !== it.path);
    const sizesNote = it._carousel
      ? h("div", { class: "menu-note mono muted" }, `Covers all ${it._carousel.length} cards`)
      : also.length ? h("div", { class: "menu-note mono muted" }, `Covers all ${also.length + 1} sizes`) : null;
    const campList = h("div", { class: "menu-camps" }, h("div", { class: "muted menu-loading" }, "Loading campaigns…"));
    let detail = { status: it.status, liked: !!it.liked, likes: it.likes };

    const favBtn = h("button", { class: "menu-item", type: "button" });
    const okBtn = h("button", { class: "menu-item", type: "button" });
    const noBtn = h("button", { class: "menu-item", type: "button" });
    const paintActions = () => {
      fill(noBtn, h("span", { class: "mi-icon" }, "✕"), detail.status === "rejected" ? "Marked No (tap to undo)" : "No, I don't want this one");
      noBtn.classList.toggle("on-no", detail.status === "rejected");
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
      const card = refs.pill.closest(".tile");
      if (card) {
        card.classList.toggle("is-no", d.status === "rejected");
        const stamp = card.querySelector(".no-stamp");
        if (d.status === "rejected" && !stamp) card.querySelector(".thumb").append(h("div", { class: "no-stamp", "aria-hidden": "true" }, "NO"));
        if (d.status !== "rejected" && stamp) stamp.remove();
      }
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
    noBtn.onclick = async () => {
      try { after(await api("POST", `/api/c/${enc(cs)}/status`, { path: it.path, status: detail.status === "rejected" ? "pending" : "rejected", also })); toast(detail.status === "rejected" ? "Marked No. Move it to the trash too if you never want to see it." : "No taken back."); }
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

    // Hide covers every size and version of the ad.
    const allPaths = it._paths && it._paths.length ? it._paths : [it.path];
    const others = allPaths.filter((p) => p !== it.path);
    const announce = (detail) => anchor.dispatchEvent(new CustomEvent("gv-change", { bubbles: true, detail }));
    const hideBtn = h("button", { class: "menu-item", type: "button", onclick: async () => {
      try {
        await api("POST", `/api/c/${enc(cs)}/hide`, { path: it.path, also: others, hidden: !it.hidden });
        toast(it.hidden ? "Restored. It is back in the list." : "Moved to the trash. Tap Trash in the toolbar to get it back.");
        closeTileMenu();
        announce({ paths: allPaths, hidden: !it.hidden });
      } catch (err) { toast(err.message); }
    } }, h("span", { class: "mi-icon" }, it.hidden ? "↺" : "🗑"), it.hidden ? "Restore (take it out of the trash)" : "Move to trash");
    const delBtn = state.me.admin && it.hidden
      ? h("button", { class: "menu-item danger-item", type: "button", onclick: async () => {
          if (!confirm(`Delete "${it.name}"${others.length ? ` and its ${others.length} other size/version file${others.length === 1 ? "" : "s"}` : ""}?\n\nThe file moves to "_Deleted files" on the Synology, and its comments and approvals are removed from the portal.`)) return;
          try {
            for (const p of allPaths) await api("POST", `/api/c/${enc(cs)}/delete`, { path: p });
            toast("Deleted. The file is in _Deleted files on the Synology.");
            closeTileMenu();
            announce({ paths: allPaths, deleted: true });
          } catch (err) { toast(err.message); }
        } }, h("span", { class: "mi-icon" }, "⨯"), "Delete for good (admin)")
      : null;

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
      noBtn,
      h("a", { class: "menu-item", href: refs.href, onclick: closeTileMenu }, h("span", { class: "mi-icon", html: ICON_EXPAND }), "Open full size and comments"),
      h("button", { class: "menu-item", type: "button", onclick: () => { closeTileMenu(); saveFile(refs.src, it.name); } }, h("span", { class: "mi-icon" }, "↓"), "Save or share"),
      state.me.admin ? h("button", { class: "menu-item", type: "button", onclick: () => openRename(cs, it, {
        onDone: () => anchor.dispatchEvent(new CustomEvent("gv-renamed", { bubbles: true })),
      }) }, h("span", { class: "mi-icon" }, "✎"), "Rename (admin)") : null,
      h("div", { class: "menu-sep" }),
      hideBtn,
      delBtn,
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
        api("GET", `/api/c/${enc(slug)}/item?path=${enc(path)}`).catch((err) => ({ _err: err })),
        list ? Promise.resolve(list) : api("GET", `/api/c/${enc(slug)}/list?dir=${enc(dir)}`),
      ]);
    } catch (err) {
      show(errorCard(err));
      return;
    }
    state.listCache.set(`${slug}|${dir}`, list);
    if (!list.items.some((i) => i.path === path)) {
      // An old link to a file renamed in the portal: open it under its new name.
      try {
        const w = await api("GET", `/api/c/${enc(slug)}/where?path=${enc(path)}`);
        if (w.path) { location.replace(`#/c/${enc(slug)}/i/${enc(w.path)}`); return; }
      } catch { /* fall through */ }
      // A link from ad copy can name the ad without its size or extension: open the ad it means.
      const k = copyKey(path);
      const match = groupAds(list.items).find((a) => copyKey(a.path) === k);
      if (match) { location.replace(`#/c/${enc(slug)}/i/${enc(match.path)}`); return; }
    }
    if (detail._err) { show(errorCard(detail._err)); return; }

    // Opening an ad marks it as viewed for this person.
    const cached = list.items.find((i) => i.path === path);
    if (!cached || !cached.seen) {
      api("POST", `/api/c/${enc(slug)}/view`, { path }).catch(() => {});
      if (cached) cached.seen = true;
    }

    const items = list.items;
    const it = items.find((i) => i.path === path) || { name: baseName(path), path, kind: "file" };
    // Previous / Next step through ads, not through every size of the same ad.
    const ads = groupAds(items);
    const idx = ads.findIndex((a) => a.path === path || (a._paths || []).includes(path));
    const prev = idx > 0 ? ads[idx - 1] : null;
    const next = idx >= 0 && idx < ads.length - 1 ? ads[idx + 1] : null;
    const fam = adFamily(items, path);
    const sizes = fam.sizes.length > 1 ? fam.sizes : [];
    // In a carousel, Approve, Favorite and campaign picks cover every card (all their sizes).
    const carAd = groupAds(items).find((a) => a._carousel && (a._paths || []).includes(path));
    const also = (carAd ? carAd._approvePaths : sizes.map((v) => v.path)).filter((p) => p !== path);
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
      stageInner = h("div", { class: "empty" }, h("p", {}, "This file type does not preview in the browser."), h("button", { class: "btn", type: "button", onclick: () => saveFile(src, it.name) }, "Save or share"));
    }

    const stage = h("div", { class: "card stage" }, stageInner);
    // Carousel: every card in order, tap one to look at it (same size when it has one).
    let cardStrip = null;
    if (carAd) {
      const curN = (carAd._carousel.find((c) => (c.item._paths || [c.path]).includes(path)) || {}).n;
      const sameSize = (c) => {
        const want = thisSize;
        const hit = want && c.item._sizes && c.item._sizes.find((v) => v.label === want);
        return hit ? hit.path : c.path;
      };
      cardStrip = h("div", { class: "card-strip-wrap" },
        h("div", { class: "mono muted card-strip-label" }, `CAROUSEL · CARD ${carAd._carousel.findIndex((c) => c.n === curN) + 1} OF ${carAd._carousel.length}`),
        h("div", { class: "card-strip" }, carAd._carousel.map((c, i) => {
          const target = sameSize(c);
          const thumb = c.item.kind === "video"
            ? h("video", { src: mediaUrl(slug, target) + "#t=0.5", preload: "metadata", muted: true, playsinline: true })
            : h("img", { src: mediaUrl(slug, target), alt: `Card ${i + 1}`, loading: "lazy" });
          return h("a", {
            class: "card-thumb" + (c.n === curN ? " active" : "") + (c.item.status === "changes" ? " is-changes" : c.item.status === "approved" ? " is-approved" : ""),
            href: `#/c/${enc(slug)}/i/${enc(target)}`,
            title: `Card ${i + 1}`,
            onclick: (e) => { e.preventDefault(); if (c.n !== curN) location.replace(`#/c/${enc(slug)}/i/${enc(target)}`); },
          }, thumb, h("span", { class: "card-num mono" }, String(i + 1)));
        })));
    }
    const sizeSeg = sizes.length > 1
      ? h("div", { class: "seg size-seg", title: "Sizes of this ad" },
          sizes.map((v) => h("button", {
            class: "seg-btn" + (v.path === path ? " active" : ""),
            "aria-pressed": v.path === path ? "true" : "false",
            onclick: () => { if (v.path !== path) location.replace(`#/c/${enc(slug)}/i/${enc(v.path)}`); },
          }, v.label)))
      : null;
    // Versions: v1, v2, v3... of this size. Older ones stay viewable with their comments.
    const verSeg = fam.versions.length > 1
      ? h("div", { class: "ver-row" },
          h("span", { class: "mono muted" }, "VERSIONS"),
          h("div", { class: "seg ver-seg" },
            fam.versions.map((v) => h("button", {
              class: "seg-btn" + (v.path === path ? " active" : ""),
              "aria-pressed": v.path === path ? "true" : "false",
              title: v.n === fam.latestVer ? "Newest version" : "Older version",
              onclick: () => { if (v.path !== path) location.replace(`#/c/${enc(slug)}/i/${enc(v.path)}`); },
            }, v.n === fam.latestVer ? `v${v.n} · newest` : `v${v.n}`))))
      : null;
    const latestPath = (fam.versions.find((v) => v.n === fam.latestVer) || {}).path;
    // Hide (and admin Delete) work on the whole ad: every size and version.
    const myAd = ads.find((a) => a.path === path || (a._paths || []).includes(path));
    const adPaths = myAd && myAd._paths ? myAd._paths : [path];
    const isHidden = !!(myAd ? myAd.hidden : it.hidden);
    async function setHidden(hide) {
      try {
        await api("POST", `/api/c/${enc(slug)}/hide`, { path, also: adPaths.filter((p) => p !== path), hidden: hide });
        state.listCache.clear();
        toast(hide ? "Moved to the trash. Tap Trash in the folder to get it back." : "Restored. It is back in the list.");
        if (hide) location.hash = (state.backTo && state.backTo.slug === slug ? state.backTo.hash : `#/c/${enc(slug)}/f/${enc(dir)}`);
        else viewItem(slug, path);
      } catch (err) { toast(err.message); }
    }
    async function deleteAd() {
      if (!confirm(`Delete this ad (${adPaths.length} file${adPaths.length === 1 ? "" : "s"})?\n\nThe files move to "_Deleted files" on the Synology, and comments and approvals are removed from the portal.`)) return;
      try {
        for (const p of adPaths) await api("POST", `/api/c/${enc(slug)}/delete`, { path: p });
        state.listCache.clear();
        toast("Deleted. The file is in _Deleted files on the Synology.");
        location.hash = (state.backTo && state.backTo.slug === slug ? state.backTo.hash : `#/c/${enc(slug)}/f/${enc(dir)}`);
      } catch (err) { toast(err.message); }
    }
    const hiddenNotice = isHidden
      ? h("div", { class: "card hidden-note" },
          h("div", {}, h("strong", {}, "This ad is in the trash. "), "It does not show in the lists."),
          h("div", { class: "actions" },
            h("button", { class: "btn small", type: "button", onclick: () => setHidden(false) }, "Restore"),
            state.me.admin ? h("button", { class: "btn small danger", type: "button", onclick: deleteAd }, "Delete for good") : null))
      : null;
    const oldNotice = fam.versions.length > 1 && fam.ver < fam.latestVer
      ? h("div", { class: "card old-notice" },
          h("div", {}, h("strong", {}, `You are looking at an older version (v${fam.ver}).`), " Comments on it are kept here for reference."),
          h("a", { class: "btn small primary", href: `#/c/${enc(slug)}/i/${enc(latestPath)}`, onclick: (e) => { e.preventDefault(); location.replace(`#/c/${enc(slug)}/i/${enc(latestPath)}`); } }, `See v${fam.latestVer}`))
      : null;

    // Admin: upload an edited file as the next version of this one (same folder, "name v2.jpg").
    let newVerBtn = null;
    if (state.me.admin) {
      const picker = h("input", { type: "file", hidden: true, accept: it.kind === "video" ? "video/*" : it.kind === "image" ? "image/*" : "",
        onchange: () => { const f = picker.files[0]; picker.value = ""; if (f) uploadVersion(f); } });
      newVerBtn = h("span", {}, picker, h("button", { class: "btn small", type: "button", title: "Upload an edited file as the next version of this one", onclick: () => picker.click() }, "↑ New version"));
    }
    async function uploadVersion(file) {
      if (file.size > 100 * 1024 * 1024) return toast("That file is over 100 MB. Copy it in with Finder and name it with v2, v3...");
      const n = fam.latestVer + 1;
      const name = `${unversioned(stemOf(it.name))} v${n}${extOf(file.name).toLowerCase() || extOf(it.name)}`;
      toast(`Uploading v${n}…`);
      try {
        const r = await new Promise((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open("POST", `/api/c/${enc(slug)}/upload?dir=${enc(dir)}&name=${enc(name)}&versionOf=${enc(path)}`);
          x.setRequestHeader("content-type", file.type || "application/octet-stream");
          x.upload.onprogress = (e) => { if (e.lengthComputable) toast(`Uploading v${n}… ${Math.round((e.loaded / e.total) * 100)}%`); };
          x.onload = () => { let d = null; try { d = JSON.parse(x.responseText); } catch {} x.status < 300 ? resolve(d || {}) : reject(new Error((d && d.error) || `Upload failed (${x.status}).`)); };
          x.onerror = () => reject(new Error("Upload failed. Check your connection."));
          x.send(file);
        });
        state.listCache.delete(`${slug}|${dir}`);
        toast(`v${n} is up. It starts as Awaiting review.`);
        location.replace(`#/c/${enc(slug)}/i/${enc(r.path)}`);
      } catch (err) { toast(err.message); }
    }

    const navBar = h("div", { class: "stage-bar" },
      h("div", { class: "actions" },
        h("a", { class: "btn small", href: prev ? `#/c/${enc(slug)}/i/${enc(prev.path)}` : null, "aria-disabled": !prev, style: prev ? null : "opacity:.4;pointer-events:none" }, "← Previous"),
        h("a", { class: "btn small", href: next ? `#/c/${enc(slug)}/i/${enc(next.path)}` : null, "aria-disabled": !next, style: next ? null : "opacity:.4;pointer-events:none" }, "Next →"),
      ),
      h("div", { class: "actions" },
        sizeSeg,
        it.size ? h("span", { class: "mono muted", style: "align-self:center" }, fmtSize(it.size)) : null,
        newVerBtn,
        h("button", { class: "btn small", type: "button", onclick: () => saveFile(src, it.name) }, "↓ Save"),
      ),
    );

    // Ad copy for this ad, right under the preview: every line with Approve / Request changes.
    const copyBox = h("div", { class: "ad-copy" });
    const copyState = { open: new Set(), hidden: false, d: null, adding: false };
    const myKey = copyKey(path);
    const copyBase = `/api/c/${enc(slug)}/copy`;
    async function copyCall(method, url, body) {
      try { copyState.d = await api(method, url, body); renderCopy(); state.listCache.delete(`${slug}|${dir}`); return true; }
      catch (err) { toast(err.message); return false; }
    }
    function renderCopy() {
      const d = copyState.d;
      if (!d) return;
      // On a carousel card's page: that card's lines plus the whole-ad lines.
      const myCardM = stemOf(baseName(path)).match(CARD_RE);
      const myCard = myCardM ? Number(myCardM[1]) : null;
      const mine = d.items.filter((x) => x.adPath && copyKey(x.adPath) === myKey && (!x.card || !myCard || x.card === myCard));
      const hiddenN = mine.filter((x) => x.hidden).length;
      if (!hiddenN) copyState.hidden = false;
      const shown = mine.filter((x) => x.hidden === copyState.hidden);
      const approved = mine.filter((x) => !x.hidden && x.status === "approved");
      if (!mine.length && !state.me.admin) { fill(copyBox); return; }
      let adder = null;
      if (state.me.admin && copyState.adding) {
        const kindSel = h("select", { class: "mini-select" }, d.kinds.map((k) => h("option", { value: k }, COPY_KIND_LABEL[k] || k)));
        const text = h("textarea", { class: "copy-input", rows: 3, maxlength: "3000", placeholder: "Type the copy. Several options? One per line and tick the box." });
        const lines = h("input", { type: "checkbox" });
        const add = h("button", { class: "btn small primary", type: "button", onclick: async () => {
          if (!text.value.trim()) return text.focus();
          add.disabled = true;
          if (await copyCall("POST", copyBase, { kind: kindSel.value, text: text.value, lines: lines.checked, adPath: path })) { copyState.adding = false; renderCopy(); toast("Added under this ad."); }
          else add.disabled = false;
        } }, "Add");
        adder = h("div", { class: "card pad copy-adder" },
          h("div", { class: "copy-row" }, kindSel, h("span", { class: "muted", style: "font-size:13px" }, "Goes with every size and version of this ad")),
          text,
          h("label", { class: "check", style: "margin:8px 0" }, lines, "Each line is its own option"),
          h("div", { class: "copy-row" }, add, h("button", { class: "btn small", type: "button", onclick: () => { copyState.adding = false; renderCopy(); } }, "Cancel")));
      }
      fill(copyBox,
        h("div", { class: "ad-copy-head" },
          h("h2", {}, "Ad copy"),
          h("span", { class: "muted", style: "font-size:13px" }, mine.length ? `${mine.length - hiddenN} line${mine.length - hiddenN === 1 ? "" : "s"}, ${approved.length} approved` : "None yet"),
          h("span", { style: "flex:1" }),
          hiddenN ? h("button", { class: "btn small" + (copyState.hidden ? " on-warn" : ""), type: "button", onclick: () => { copyState.hidden = !copyState.hidden; renderCopy(); } }, copyState.hidden ? "← Back" : `🗑 Trash (${hiddenN})`) : null,
          approved.length && !copyState.hidden ? h("button", { class: "btn small", type: "button", title: "Copy the approved lines for this ad", onclick: async () => {
            const out = d.kinds.map((k) => [k, approved.filter((x) => x.kind === k)]).filter(([, l]) => l.length)
              .map(([k, l]) => `${(COPY_KIND_LABEL[k] || k).toUpperCase()}\n${l.map((x) => x.text).join("\n\n")}`).join("\n\n\n");
            try { await navigator.clipboard.writeText(out); toast(`Copied ${approved.length} approved line${approved.length === 1 ? "" : "s"}.`); }
            catch { toast("Your browser blocked copying. Long-press a line to copy it instead."); }
          } }, "Copy approved") : null,
          state.me.admin && !copyState.adding && !copyState.hidden ? h("button", { class: "btn small primary", type: "button", onclick: () => { copyState.adding = true; renderCopy(); } }, "+ Add copy") : null,
        ),
        adder,
        shown.length
          ? h("div", { class: "copy-list" }, shown.slice().sort((a, b) => COPY_ORDER.indexOf(a.kind) - COPY_ORDER.indexOf(b.kind) || a.id - b.id)
              .map((x) => copyCard(slug, x, { campaigns: d.campaigns, open: copyState.open, call: copyCall, rerender: renderCopy, compact: true })))
          : state.me.admin && !adder ? h("p", { class: "muted", style: "margin:0;font-size:13px" }, "No copy for this ad yet. Add it here, or have Claude or Muse save a copy file next to the ad (see CLAUDE.md).") : null,
      );
    }
    api("GET", copyBase).then((d) => { copyState.d = d; renderCopy(); }).catch(() => {});

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

    let replyTo = null;
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
        h("button", {
          class: "btn no-btn" + (d.status === "rejected" ? " on-no" : ""),
          title: "You don't want this one",
          onclick: () => setStatus(d.status === "rejected" ? "pending" : "rejected"),
        }, d.status === "rejected" ? "✕ Marked No" : "✕ No"),
        h("button", { class: "btn" + (d.liked ? " on-like" : ""), onclick: toggleLike, title: d.likers.length ? "Favorited by " + d.likers.map(who).join(", ") : "Save to your favorites" },
          d.liked ? `♥ Favorited${d.likes > 1 ? " · " + d.likes : ""}` : `♡ Favorite${d.likes ? " · " + d.likes : ""}`),
      );

      const statusNote = d.status === "rejected"
        ? h("div", { class: "card no-banner" },
            h("div", {}, h("strong", {}, "NO. "), `${who(d.statusBy)} marked this one No, ${fmtDate(d.statusAt)}.`),
            isHidden ? null : h("button", { class: "btn small no-btn", type: "button", onclick: () => setHidden(true) }, "🗑 Move to trash"))
        : d.statusBy
        ? h("div", { class: "status-note muted" }, `${STATUS_LABEL[d.status]} by ${who(d.statusBy)}, ${fmtDate(d.statusAt)}`)
        : h("div", { class: "status-note muted" }, "Approve it, request changes and say what in a comment, or tap No if you don't want it.");
      const sizesNote = carAd
        ? h("div", { class: "status-note muted" }, `Approve, Favorite and campaign picks cover all ${carAd._carousel.length} cards of this carousel. Comments stay on the card you are looking at.`)
        : also.length
        ? h("div", { class: "status-note muted" }, `Approve, Favorite and campaign picks cover all ${sizes.length} sizes.`)
        : null;

      // Comments as threads: each comment, then Genvyd's replies under it.
      const roots = d.comments.filter((c) => !c.parent_id || !d.comments.some((x) => x.id === c.parent_id));
      const repliesTo = (c) => d.comments.filter((x) => x.parent_id === c.id);
      const commentEl = (c, isReply) =>
        h("div", { class: "comment" + (c.resolved ? " resolved" : "") + (isReply ? " reply" : "") },
          h("div", { class: "comment-head" },
            h("span", { class: "mono", style: "color:var(--bone)" }, (isReply ? "↳ " : "") + (c.genvyd && !c.mine && !state.me.admin ? "Genvyd" : who(c.email))),
            h("span", { class: "mono muted" }, fmtDate(c.created_at)),
          ),
          h("div", { class: "comment-body" },
            !isReply && c.timecode != null && video
              ? h("button", { class: "tc", onclick: () => { video.currentTime = c.timecode; video.play(); } }, fmtTime(c.timecode))
              : !isReply && c.timecode != null ? h("span", { class: "tc" }, fmtTime(c.timecode)) : null,
            ...linkify(c.body),
          ),
          (c.mine || state.me.admin)
            ? h("div", { class: "comment-tools" },
                state.me.admin && !isReply ? h("button", { class: "linkish", onclick: () => { replyTo = replyTo === c.id ? null : c.id; renderSide(d); } }, "↩ Reply") : null,
                state.me.admin && !isReply ? h("button", { class: "linkish", onclick: () => resolve(c.id) }, c.resolved ? "Reopen" : "✓ Mark done") : null,
                state.me.admin && !isReply && !c.resolved && !c.mine && !isHidden ? h("button", { class: "linkish no-link", onclick: () => doneAndTrash(c.id) }, "🗑 Mark done + move to trash") : null,
                h("button", { class: "linkish", onclick: () => removeComment(c.id, !isReply && repliesTo(c).length) }, "Delete"),
              )
            : null,
        );
      const replyComposer = (c) => {
        const tb = h("textarea", { class: "reply-box", placeholder: `Reply to ${who(c.email)}…`, maxlength: "4000", rows: 2 });
        const go = async (andResolve) => {
          if (!tb.value.trim()) return tb.focus();
          try {
            const r = await api("POST", `/api/c/${enc(slug)}/comments`, { path, body: tb.value.trim(), parentId: c.id, resolve: andResolve });
            replyTo = null;
            renderSide(r);
            state.listCache.delete(`${slug}|${dir}`);
            toast(andResolve ? "Replied and marked done." : "Replied.");
          } catch (err) { toast(err.message); }
        };
        setTimeout(() => tb.focus(), 0);
        return h("div", { class: "reply-composer" }, tb,
          h("div", { class: "composer-row" },
            h("button", { class: "linkish", type: "button", onclick: () => { replyTo = null; renderSide(d); } }, "Cancel"),
            h("div", { class: "actions" },
              c.resolved ? null : h("button", { class: "btn small", type: "button", onclick: () => go(true) }, "Reply + mark done"),
              h("button", { class: "btn small primary", type: "button", onclick: () => go(false) }, "Post reply"))));
      };
      const list = h("div", { class: "comments" },
        roots.length
          ? roots.map((c) => h("div", { class: "thread" },
              commentEl(c, false),
              repliesTo(c).map((r) => commentEl(r, true)),
              state.me.admin && replyTo === c.id ? replyComposer(c) : null))
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
        isHidden || d.status === "rejected" ? null : h("button", { class: "linkish hide-link", type: "button", title: "Take it out of the lists. You can bring it back from Trash.", onclick: () => setHidden(true) }, "🗑 Move to trash (I don't want it)"),
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

    function renameFile() {
      openRename(slug, it, { onDone: (r, mine) => location.replace(`#/c/${enc(slug)}/i/${enc(mine.to)}`) });
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
    const doneAndTrash = async (id) => {
      try {
        await noAndTrash(slug, path, id);
        toast("Done. Marked No and moved to the trash.");
        location.hash = (state.backTo && state.backTo.slug === slug ? state.backTo.hash : `#/c/${enc(slug)}/f/${enc(dir)}`);
      } catch (err) { toast(err.message); }
    };
    const removeComment = (id, replies) => {
      if (confirm(replies ? `Delete this comment and its ${replies} repl${replies === 1 ? "y" : "ies"}?` : "Delete this comment?")) act(api("DELETE", `/api/c/${enc(slug)}/comments/${id}`));
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
      hiddenNotice,
      oldNotice,
      h("div", { class: "viewer" }, h("div", {}, stage, cardStrip, verSeg, navBar, copyBox), side),
    );
  }

  // ---- Final ads: screenshots of the finished ads as people will see them -------
  // Muse saves them on the Synology in "<client folder>/Final ads/", optionally in one level
  // of subfolders (a batch or campaign), named "<Ad name> - <Placement>.png", and
  // "<Ad name> v2 - <Placement>.png" after changes. Each ad shows all its placements side by
  // side; Approve and Request changes cover every placement of the newest version.
  const FINAL_DIR = "Final ads";
  const PLACE_ORDER = ["facebook feed", "instagram feed", "instagram stories", "facebook stories", "instagram reels", "facebook reels"];
  function finalAdGroups(items) {
    const groups = new Map();
    for (const it of items) {
      if (it.hidden || it.kind !== "image") continue;
      const stem = stemOf(it.name);
      const cut = stem.lastIndexOf(" - ");
      let ad = cut > 0 ? stem.slice(0, cut) : stem;
      const place = cut > 0 ? stem.slice(cut + 3).trim() : "Preview";
      // Carousel previews: "<Ad name> card 2 - <Placement>.png", one per card per placement.
      let card = 0;
      const cm = ad.match(CARD_RE);
      if (cm) { card = Number(cm[1]) || 0; ad = ad.replace(cm[0], " "); }
      let ver = 1;
      const v = ad.match(VER_RE);
      if (v) { ver = Number(v[1]) || 1; ad = ad.replace(v[0], " "); }
      ad = ad.replace(/\s{2,}/g, " ").replace(/[\s_\-.]+$/, "").trim() || stem;
      const key = ad.toLowerCase();
      if (!groups.has(key)) groups.set(key, { name: ad, all: [] });
      groups.get(key).all.push({ it, place, ver, card });
    }
    const rank = (p) => { const i = PLACE_ORDER.indexOf(p.toLowerCase()); return i < 0 ? 99 : i; };
    return [...groups.values()].map((g) => {
      const latest = Math.max(...g.all.map((e) => e.ver));
      // Newest version of each placement (and each card), so a v2 of one card keeps the others.
      const newest = new Map();
      for (const e of g.all) { const k = `${e.place.toLowerCase()}|${e.card}`; if (!newest.has(k) || newest.get(k).ver < e.ver) newest.set(k, e); }
      const shots = [...newest.values()].sort((a, b) => rank(a.place) - rank(b.place) || a.place.localeCompare(b.place) || a.card - b.card);
      const cards = new Set(shots.map((e) => e.card).filter(Boolean)).size;
      const st = new Set(shots.map((e) => e.it.status));
      return {
        name: g.name, ver: latest, versions: new Set(g.all.map((e) => e.ver)).size, shots, cards,
        status: st.size === 1 ? shots[0].it.status : st.has("changes") ? "changes" : "pending",
        comments: shots.reduce((n, e) => n + (e.it.comments || 0), 0),
        openComments: shots.reduce((n, e) => n + (e.it.openComments || 0), 0),
        seen: shots.every((e) => e.it.seen !== false),
        mtime: Math.max(...shots.map((e) => (e.it.mtime ? Date.parse(e.it.mtime) : 0))),
      };
    }).sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  }
  // The "Final ads" folder plus up to 12 subfolders. null when there is no such folder yet.
  async function loadFinalAds(slug) {
    let root;
    try { root = await api("GET", `/api/c/${enc(slug)}/list?dir=${enc(FINAL_DIR)}`); }
    catch (err) { if (/not on the Synology/i.test(err.message)) return null; throw err; }
    const subs = await Promise.all(root.folders.slice(0, 12).map((f) =>
      api("GET", `/api/c/${enc(slug)}/list?dir=${enc(f.path)}`).then((d) => ({ title: f.name, dir: f.path, items: d.items })).catch(() => null)));
    return [{ title: null, dir: FINAL_DIR, items: root.items }, ...subs.filter(Boolean)];
  }
  function finalAdsSection(slug, sections, reload, copyFor) {
    const wrap = h("div", { class: "final-ads" });
    const all = (sections || []).map((s) => ({ ...s, ads: finalAdGroups(s.items) })).filter((s) => s.ads.length);
    const count = all.reduce((n, s) => n + s.ads.length, 0);
    const approvedN = all.reduce((n, s) => n + s.ads.filter((a) => a.status === "approved").length, 0);

    let tools = null;
    if (state.me.admin) {
      const picker = h("input", { type: "file", multiple: true, accept: "image/*", hidden: true, onchange: async () => {
        const files = [...picker.files]; picker.value = "";
        if (!files.length) return;
        try {
          if (!sections) await api("POST", `/api/c/${enc(slug)}/folder`, { dir: "", name: FINAL_DIR });
          for (let i = 0; i < files.length; i++) {
            toast(`Uploading ${i + 1} of ${files.length}…`);
            const r = await fetch(`/api/c/${enc(slug)}/upload?dir=${enc(FINAL_DIR)}&name=${enc(files[i].name)}`, { method: "POST", headers: { "content-type": files[i].type || "image/png" }, body: files[i] });
            if (!r.ok) { let m = `Upload failed (${r.status}).`; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
          }
          toast(`${files.length} screenshot${files.length === 1 ? "" : "s"} added.`);
          state.listCache.clear();
          reload();
        } catch (err) { toast(err.message); }
      } });
      tools = h("div", { class: "actions" }, picker,
        sections ? h("a", { class: "btn small", href: `#/c/${enc(slug)}/f/${enc(FINAL_DIR)}` }, "Open folder") : null,
        h("button", { class: "btn small primary", type: "button", onclick: () => picker.click() }, "Add screenshots"));
    }

    const head = h("div", { class: "section-head" },
      h("div", {},
        h("h2", {}, "Final ads"),
        h("p", { class: "muted", style: "margin:4px 0 0;max-width:640px" },
          state.me.admin
            ? `How each ad will look once it runs. Muse saves screenshots in "${FINAL_DIR}" in the client's folder, named "Ad name - Placement.png".`
            : "This is how each ad will look on Facebook and Instagram. Approve it, or ask for changes before it goes live.")),
      h("div", { class: "section-head-right" }, count ? h("span", { class: "mono muted" }, `${approvedN} of ${count} approved`) : null, tools));

    const card = (ad, dir) => {
      const first = ad.shots[0].it;
      const paths = ad.shots.map((e) => e.it.path);
      const also = paths.slice(1);
      const setStatus = async (status) => {
        try {
          await api("POST", `/api/c/${enc(slug)}/status`, { path: first.path, status, also });
          state.listCache.clear();
          if (status === "changes") {
            toast("Say what should change in a comment.");
            location.hash = `#/c/${enc(slug)}/i/${enc(first.path)}`;
            return;
          }
          toast(status === "approved" ? "Approved. Thank you!" : status === "rejected" ? "Marked No." : "Status taken back.");
          reload();
        } catch (err) { toast(err.message); }
      };
      const cp = copyFor ? copyFor(ad, dir) : null;
      const placedCards = new Set();
      const shots = ad.shots.map((e) => {
        const img = h("img", { "data-src": mediaUrl(slug, e.it.path), alt: `${ad.name}, ${e.place}`, loading: "lazy", onload: (ev) => ev.target.classList.add("loaded") });
        lazy.observe(img);
        // A carousel card's own copy sits under the first screenshot of that card.
        const under = cp && e.card && !placedCards.has(e.card) ? cp.perCard.get(e.card) : null;
        if (e.card) placedCards.add(e.card);
        const placeLabel = e.place === "Preview" && e.card ? `Card ${e.card}` : e.card ? `${e.place} · card ${e.card}` : e.place;
        return h("div", { class: "final-col" },
          h("a", { class: "final-shot", href: `#/c/${enc(slug)}/i/${enc(e.it.path)}`, title: "Open full size, with comments" },
            h("div", { class: "final-frame" }, img),
            h("div", { class: "final-place mono" }, placeLabel, e.it.comments ? h("span", { class: "muted" }, ` · 💬 ${e.it.comments}`) : null)),
          under);
      });
      return h("div", { class: "card final-card" + (ad.status === "approved" ? " is-approved" : ad.status === "changes" ? " is-changes" : ad.status === "rejected" ? " is-no" : "") },
        h("div", { class: "copy-head" },
          h("h3", { class: "final-name" }, ad.name),
          ad.versions > 1 ? h("span", { class: "size-chip ver-chip" }, `v${ad.ver} · ${ad.versions} versions`) : null,
          ad.cards > 1 ? h("span", { class: "size-chip car-chip" }, `Carousel · ${ad.cards} cards`) : null,
          h("span", { class: `pill ${ad.status}` }, STATUS_LABEL[ad.status]),
          ad.seen ? null : h("span", { class: "pill new" }, "NEW"),
          h("span", { style: "flex:1" }),
          h("span", { class: "mono muted" }, (() => { const np = new Set(ad.shots.map((e) => e.place.toLowerCase())).size; return `${np} placement${np === 1 ? "" : "s"}` + (ad.cards > 1 ? ` · ${ad.shots.length} previews` : ""); })())),
        h("div", { class: "final-row" }, shots),
        h("div", { class: "copy-actions" },
          h("button", { class: "btn small" + (ad.status === "approved" ? " on-ok" : ""), type: "button", onclick: () => setStatus(ad.status === "approved" ? "pending" : "approved") }, ad.status === "approved" ? "✓ Approved" : "Approve"),
          h("button", { class: "btn small" + (ad.status === "changes" ? " on-warn" : ""), type: "button", onclick: () => setStatus(ad.status === "changes" ? "pending" : "changes") }, ad.status === "changes" ? "Changes requested" : "Request changes"),
          h("button", { class: "btn small no-btn" + (ad.status === "rejected" ? " on-no" : ""), type: "button", onclick: () => setStatus(ad.status === "rejected" ? "pending" : "rejected") }, ad.status === "rejected" ? "✕ Marked No" : "✕ No"),
          h("a", { class: "btn small", href: `#/c/${enc(slug)}/i/${enc(first.path)}` }, `💬 ${ad.comments}${ad.openComments && state.me.admin ? ` · ${ad.openComments} open` : ""}`)),
        cp ? cp.el : null,
      );
    };

    const body = count
      ? all.map((s) => [s.title ? h("div", { class: "section-label mono muted" }, `${s.title.toUpperCase()} · ${s.ads.length}`) : null, h("div", { class: "final-list" }, s.ads.map((ad) => card(ad, s.dir)))])
      : h("div", { class: "card empty muted" }, state.me.admin
          ? (sections ? `No screenshots yet. Muse saves them in "${FINAL_DIR}", or tap Add screenshots.` : `No "${FINAL_DIR}" folder yet. Tap Add screenshots, or have Muse save them in the client's folder under "${FINAL_DIR}".`)
          : "No final ads to review yet. They show up here when they are ready.");
    fill(wrap, head, body);
    return wrap;
  }

  // ---- Ad copy: taglines, headlines, primary text, CTAs for approval -----------
  const COPY_KIND_LABEL = { tagline: "Tagline", headline: "Headline", primary: "Primary text", description: "Description", link: "Link", cta: "Button", caption: "Caption", other: "Other" };
  const COPY_KIND_HINT = {
    tagline: "Short brand line", headline: "Bold line under the ad (about 40 characters)", primary: "Main text above the ad",
    cta: "Button or closing line", caption: "Post or video caption", other: "Anything else",
  };
  // One line of ad copy, small enough to sit under an ad's picture: type, text, status and
  // Approve / Change / comments. "Change" and the comment count open the full card (thread,
  // earlier wordings, campaigns, trash) right below it.
  function copyLine(slug, x, ctx) {
    const base = `/api/c/${enc(slug)}/copy`;
    const open = ctx.open.has(x.id);
    const toggle = () => { open ? ctx.open.delete(x.id) : ctx.open.add(x.id); ctx.rerender(); };
    const isLink = x.kind === "link" && /^https?:\/\//.test(x.text.trim());
    const n = x.comments ? x.comments.length : 0;
    return h("div", { class: "copy-line-wrap" },
      h("div", { class: "copy-line" + (x.status === "approved" ? " is-approved" : x.status === "changes" ? " is-changes" : "") },
        h("div", { class: "cl-kind mono" }, COPY_KIND_LABEL[x.kind] || x.kind, x.version > 1 ? ` · v${x.version}` : ""),
        h("div", { class: "cl-text" }, isLink
          ? h("a", { href: x.text.trim(), target: "_blank", rel: "noopener noreferrer", class: "cl-url" }, x.text.trim().replace(/^https?:\/\/(www\.)?/, ""))
          : x.text),
        h("div", { class: "cl-actions" },
          h("button", { class: "cl-btn" + (x.status === "approved" ? " on-ok" : ""), type: "button", title: x.status === "approved" ? "Approved. Tap to undo." : "Approve this line",
            onclick: () => ctx.call("POST", `${base}/${x.id}/status`, { status: x.status === "approved" ? "pending" : "approved" }) }, x.status === "approved" ? "✓ Approved" : "Approve"),
          h("button", { class: "cl-btn" + (x.status === "changes" ? " on-warn" : ""), type: "button", title: "Ask for different wording",
            onclick: () => { if (x.status !== "changes") { ctx.open.add(x.id); ctx.call("POST", `${base}/${x.id}/status`, { status: "changes" }); } else toggle(); } }, x.status === "changes" ? "Changes asked" : "Change"),
          h("button", { class: "cl-btn", type: "button", title: open ? "Close" : "Comments and more", onclick: toggle }, open ? "Close" : n ? `💬 ${n}` : "⋯"))),
      open ? copyCard(slug, x, { ...ctx, compact: true }) : null);
  }

  // One line of ad copy with Approve / Request changes / comments / Hide, used on the ad page
  // (under the preview) and on the All ad copy page. ctx: { campaigns, open (Set of ids that
  // show their comments), call(method, url, body) -> refreshes, rerender(), showAd }.
  function copyCard(slug, x, ctx) {
        const { open: openSet, call } = ctx;
        const base = `/api/c/${enc(slug)}/copy`;
        const open = openSet.has(x.id);
        const openCount = x.comments.filter((m) => !m.resolved && !m.mine).length;
        const box = h("textarea", { placeholder: "What should change? Or say what you like about it.", maxlength: "4000", rows: 2 });
        const post = h("button", { class: "btn small primary", type: "button", onclick: async () => {
          if (!box.value.trim()) return box.focus();
          post.disabled = true;
          if (!(await call("POST", `${base}/${x.id}/comments`, { body: box.value }))) post.disabled = false;
        } }, "Post");
        const thread = open
          ? h("div", { class: "copy-thread" },
              x.comments.length
                ? x.comments.map((m) => h("div", { class: "comment" + (m.resolved ? " resolved" : "") },
                    h("div", { class: "comment-head" }, h("span", { class: "mono", style: "color:var(--bone)" }, who(m.email)), h("span", { class: "mono muted" }, fmtDate(m.created_at))),
                    h("div", { class: "comment-body" }, ...linkify(m.body)),
                    (m.mine || state.me.admin) ? h("div", { class: "comment-tools" },
                      state.me.admin ? h("button", { class: "linkish", onclick: async () => { try { await api("POST", `/api/c/${enc(slug)}/comments/${m.id}/resolve`); await call("GET", base); } catch (err) { toast(err.message); } } }, m.resolved ? "Reopen" : "Mark done") : null,
                      h("button", { class: "linkish", onclick: async () => { if (!confirm("Delete this comment?")) return; try { await api("DELETE", `/api/c/${enc(slug)}/comments/${m.id}`); await call("GET", base); } catch (err) { toast(err.message); } } }, "Delete")) : null))
                : h("p", { class: "muted", style: "margin:0" }, "No comments yet."),
              x.history.length ? h("div", { class: "copy-history" }, h("div", { class: "mono muted" }, "EARLIER WORDINGS"), x.history.slice().reverse().map((hh) => h("div", { class: "copy-old" }, `v${hh.version}: ${hh.text}`))) : null,
              h("div", { class: "composer" }, box, h("div", { class: "composer-row" }, h("span"), post)))
          : null;
        const editBtn = state.me.admin
          ? h("button", { class: "linkish", type: "button", onclick: async () => {
              const t = prompt("New wording (the old one is kept in history and it goes back to Awaiting review):", x.text);
              if (t == null || !t.trim() || t.trim() === x.text) return;
              if (await call("POST", `${base}/${x.id}/edit`, { text: t })) toast(`Saved as v${x.version + 1}.`);
            } }, "Edit")
          : null;
        return h("div", { class: "card copy-card" + (x.status === "approved" ? " is-approved" : x.status === "changes" ? " is-changes" : "") },
          h("div", { class: "copy-head" },
            h("span", { class: "tag" }, COPY_KIND_LABEL[x.kind] || x.kind),
            x.version > 1 ? h("span", { class: "mono muted" }, `v${x.version}`) : null,
            h("span", { class: `pill ${x.status}` }, STATUS_LABEL[x.status]),
            h("span", { style: "flex:1" }),
            h("button", { class: "linkish", type: "button", title: "Copy this text", onclick: async () => { try { await navigator.clipboard.writeText(x.text); toast("Copied."); } catch { toast("Long-press the text to copy it."); } } }, "Copy text"),
            editBtn,
          ),
          h("div", { class: "copy-text" }, x.text),
          ctx.showAd && x.adPath ? h("a", { class: "mono copy-for", href: `#/c/${enc(slug)}/i/${enc(x.adPath)}` }, `FOR ${baseName(x.adPath).replace(/\.[a-z0-9]{2,4}$/i, "")} →`) : null,
          x.note ? h("div", { class: "muted copy-note" }, x.note) : null,
          ctx.campaigns.length && !x.hidden && ctx.compact
            ? h("div", { class: "filters", style: "margin-top:12px" },
                ctx.campaigns.filter((cp) => x.campaigns.includes(cp.id)).map((cp) =>
                  h("button", { class: "chip small-chip active", type: "button", title: "In this campaign. Tap to take it out.",
                    onclick: () => call("POST", `${base}/${x.id}/campaign`, { campaign: cp.id, on: false }) }, `✓ ${cp.name}`)),
                ctx.campaigns.some((cp) => !x.campaigns.includes(cp.id))
                  ? h("select", { class: "mini-select", "aria-label": "Use in a campaign", onchange: (e) => e.target.value && call("POST", `${base}/${x.id}/campaign`, { campaign: Number(e.target.value), on: true }) },
                      h("option", { value: "" }, "+ Use in campaign"),
                      ctx.campaigns.filter((cp) => !x.campaigns.includes(cp.id)).map((cp) => h("option", { value: cp.id }, cp.name)))
                  : null)
            : ctx.campaigns.length && !x.hidden
            ? h("div", { class: "filters", style: "margin-top:12px" },
                ctx.campaigns.map((cp) => {
                  const on = x.campaigns.includes(cp.id);
                  return h("button", { class: "chip small-chip" + (on ? " active" : ""), type: "button", title: on ? "In this campaign. Tap to take it out." : "Use in this campaign",
                    onclick: () => call("POST", `${base}/${x.id}/campaign`, { campaign: cp.id, on: !on }) }, `${on ? "✓ " : "+ "}${cp.name}`);
                }))
            : null,
          h("div", { class: "copy-actions" },
            x.hidden
              ? [h("button", { class: "btn small", type: "button", onclick: () => call("POST", `${base}/${x.id}/hide`, { hidden: false }) }, "Restore"),
                 state.me.admin ? h("button", { class: "btn small danger", type: "button", onclick: () => confirm("Delete this copy for good? Its comments go too.") && call("POST", `${base}/${x.id}/delete`) }, "Delete") : null]
              : [h("button", { class: "btn small" + (x.status === "approved" ? " on-ok" : ""), type: "button", onclick: () => call("POST", `${base}/${x.id}/status`, { status: x.status === "approved" ? "pending" : "approved" }) }, x.status === "approved" ? "✓ Approved" : "Approve"),
                 h("button", { class: "btn small" + (x.status === "changes" ? " on-warn" : ""), type: "button", onclick: () => { call("POST", `${base}/${x.id}/status`, { status: x.status === "changes" ? "pending" : "changes" }); if (x.status !== "changes") openSet.add(x.id); } }, x.status === "changes" ? "Changes requested" : "Request changes"),
                 h("button", { class: "btn small", type: "button", onclick: () => { open ? openSet.delete(x.id) : openSet.add(x.id); ctx.rerender(); } }, `💬 ${x.comments.length}${openCount && state.me.admin ? ` · ${openCount} open` : ""}`),
                 h("span", { style: "flex:1" }),
                 h("button", { class: "linkish hide-link", type: "button", onclick: () => call("POST", `${base}/${x.id}/hide`, { hidden: true }).then((ok) => ok && toast("Moved to the trash. Tap Trash to get it back.")) }, "🗑 Move to trash")],
          ),
          x.statusBy && x.status !== "pending" ? h("div", { class: "status-note muted" }, `${STATUS_LABEL[x.status]} by ${who(x.statusBy)}, ${fmtDate(x.statusAt)}`) : null,
          thread,
        );
      }

  async function viewCopy(slug, keep) {
    if (!keep) show(h("p", { class: "muted" }, "Loading…"));
    let d, finals;
    try {
      [d, finals] = await Promise.all([
        api("GET", `/api/c/${enc(slug)}/copy`),
        loadFinalAds(slug).catch((err) => ({ error: err.message })),
      ]);
    } catch (err) { show(errorCard(err)); return; }
    const st = viewCopy.state[slug] || (viewCopy.state[slug] = { kind: "all", status: "all", hidden: false, open: new Set(), addingFor: null });
    // Copy shows under the final ad it belongs to: matched by folder and ad name, or by ad
    // name alone (a copy file saved next to the video ad also covers its final screenshots).
    let shownUnder = new Set();
    const ORDER = COPY_ORDER;
    // Returns { el, perCard }: the copy for the whole ad (shown under the screenshots) and, for a
    // carousel, each card's own lines (shown under that card's screenshot).
    function copyFor(ad, dir) {
      const k = dir + "|" + adName(ad.name + ".x").base;
      const live = d.items.filter((x) => x.adPath && !x.hidden && !shownUnder.has(x.id));
      let mine = live.filter((x) => copyKey(x.adPath) === k);
      if (!mine.length) mine = live.filter((x) => copyKey(x.adPath).split("|").pop() === k.split("|").pop());
      mine.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.id - b.id).forEach((x) => shownUnder.add(x.id));
      const lineCtx = { campaigns: d.campaigns, open: st.open, call, rerender: repaint };
      const cardNums = new Set((ad.shots || []).map((e) => e.card).filter(Boolean));
      const perCard = new Map();
      for (const n of cardNums) {
        const lines = mine.filter((x) => x.card === n);
        if (lines.length) perCard.set(n, h("div", { class: "card-copy" }, lines.map((x) => copyLine(slug, x, lineCtx))));
      }
      // Lines for a card that has no screenshot, or a carousel line without a card, go with the whole ad.
      const shared = mine.filter((x) => !x.card || !cardNums.has(x.card));
      const adding = state.me.admin && st.addingFor === k;
      if (!mine.length && !state.me.admin) return { el: null, perCard };
      let adderBox = null;
      if (adding) {
        const kindSel = h("select", { class: "mini-select" }, d.kinds.map((kk) => h("option", { value: kk }, COPY_KIND_LABEL[kk] || kk)));
        const cardSel = cardNums.size
          ? h("select", { class: "mini-select" }, h("option", { value: "" }, "Whole ad"), [...cardNums].sort((a, b) => a - b).map((n) => h("option", { value: n }, `Card ${n}`)))
          : null;
        const text = h("textarea", { class: "copy-input", rows: 3, maxlength: "3000", placeholder: "Type the copy. Several options? One per line and tick the box." });
        const lines = h("input", { type: "checkbox" });
        const add = h("button", { class: "btn small primary", type: "button", onclick: async () => {
          if (!text.value.trim()) return text.focus();
          add.disabled = true;
          st.addingFor = null;
          if (await call("POST", base, { kind: kindSel.value, text: text.value, lines: lines.checked, adPath: `${dir}/${ad.name}`, card: cardSel && cardSel.value ? Number(cardSel.value) : null })) toast("Added under this ad.");
          else { st.addingFor = k; add.disabled = false; }
        } }, "Add");
        adderBox = h("div", { class: "card pad copy-adder" },
          h("div", { class: "copy-row" }, kindSel, cardSel, h("span", { class: "muted", style: "font-size:13px" }, `For ${ad.name}`)),
          text,
          h("label", { class: "check", style: "margin:8px 0" }, lines, "Each line is its own option"),
          h("div", { class: "copy-row" }, add, h("button", { class: "btn small", type: "button", onclick: () => { st.addingFor = null; repaint(); } }, "Cancel")));
      }
      const ok = mine.filter((x) => x.status === "approved").length;
      const el = h("div", { class: "ad-copy final-copy" },
        h("div", { class: "ad-copy-head" },
          h("h2", {}, cardNums.size > 1 ? "Ad copy for the whole carousel" : "Ad copy"),
          h("span", { class: "muted", style: "font-size:13px" }, mine.length ? `${mine.length} line${mine.length === 1 ? "" : "s"}, ${ok} approved` : "None yet"),
          h("span", { style: "flex:1" }),
          state.me.admin && !adding ? h("button", { class: "btn small", type: "button", onclick: () => { st.addingFor = k; repaint(); } }, "+ Add copy") : null),
        cardNums.size > 1 && perCard.size ? h("p", { class: "muted", style: "margin:0 0 10px;font-size:13px" }, "Each card's headline, description and link are under that card above.") : null,
        adderBox,
        shared.length ? h("div", { class: "copy-lines" }, shared.map((x) => copyLine(slug, x, lineCtx))) : null);
      return { el, perCard };
    }
    const finalBox = h("div");
    const paintFinal = () => {
      shownUnder = new Set();
      fill(finalBox, finals && finals.error
        ? h("div", { class: "card empty muted" }, `Could not load the final ads: ${finals.error}`)
        : finalAdsSection(slug, finals, async () => { try { finals = await loadFinalAds(slug); } catch (err) { finals = { error: err.message }; } repaint(); }, copyFor));
    };
    const repaint = () => { paintFinal(); render(); };
    const campName = new Map(d.campaigns.map((c) => [c.id, c.name]));
    const refresh = (data) => { d = data; repaint(); };
    const call = async (method, url, body) => { try { refresh(await api(method, url, body)); return true; } catch (err) { toast(err.message); return false; } };
    const base = `/api/c/${enc(slug)}/copy`;

    // Admin: add copy. One line, or many options at once ("each line is its own option").
    let adder = null;
    if (state.me.admin) {
      const kindSel = h("select", { class: "mini-select" }, d.kinds.map((k) => h("option", { value: k }, COPY_KIND_LABEL[k] || k)));
      const text = h("textarea", { class: "copy-input", rows: 3, maxlength: "3000", placeholder: "Type the copy. To offer several options, put each on its own line and tick the box below." });
      const lines = h("input", { type: "checkbox" });
      const note = h("input", { class: "menu-input", maxlength: "1000", placeholder: "Note for the client (optional), e.g. for the golf ads" });
      const campBoxes = d.campaigns.map((cp) => ({ cp, box: h("input", { type: "checkbox" }) }));
      const add = h("button", { class: "btn small primary", type: "button", onclick: async () => {
        if (!text.value.trim()) return text.focus();
        add.disabled = true;
        const ok = await call("POST", base, { kind: kindSel.value, text: text.value, lines: lines.checked, note: note.value, campaigns: campBoxes.filter((x) => x.box.checked).map((x) => x.cp.id) });
        add.disabled = false;
        if (ok) { text.value = ""; note.value = ""; toast("Added. The client can review it now."); }
      } }, "Add copy");
      adder = h("div", { class: "card pad copy-adder" },
        h("h2", { style: "margin:0 0 12px" }, "Add copy not tied to one ad"),
        h("div", { class: "copy-row" }, kindSel, h("span", { class: "muted", style: "font-size:13px" }, "Tagline, headline, primary text, call to action or caption")),
        text,
        h("label", { class: "check", style: "margin:8px 0" }, lines, "Each line is its own option (she can approve them one by one)"),
        note,
        campBoxes.length ? h("div", { class: "copy-row", style: "flex-wrap:wrap;margin-top:10px" }, h("span", { class: "mono muted" }, "CAMPAIGNS"), campBoxes.map((x) => h("label", { class: "check" }, x.box, x.cp.name))) : null,
        h("div", { style: "margin-top:12px" }, add),
      );
    }

    const listHolder = h("div");
    function render() {
      const hiddenCount = d.items.filter((x) => x.hidden).length;
      if (st.hidden && !hiddenCount) st.hidden = false;
      // Copy already shown under a final ad above is not listed again here.
      const visible = d.items.filter((x) => x.hidden === st.hidden && (st.hidden || !shownUnder.has(x.id)));
      const shown = visible.filter((x) => (st.kind === "all" || x.kind === st.kind) && (st.status === "all" || x.status === st.status));
      const kindsUsed = d.kinds.filter((k) => visible.some((x) => x.kind === k));
      const approved = d.items.filter((x) => !x.hidden && x.status === "approved");

      const copyApproved = approved.length
        ? h("button", { class: "btn small primary", type: "button", title: "Copy every approved line, grouped by type, to paste into Ads Manager", onclick: async () => {
            const groups = d.kinds.map((k) => [k, approved.filter((x) => x.kind === k)]).filter(([, l]) => l.length);
            const out = groups.map(([k, l]) => `${(COPY_KIND_LABEL[k] || k).toUpperCase()}\n${l.map((x) => x.text).join("\n\n")}`).join("\n\n\n");
            try { await navigator.clipboard.writeText(out); toast(`Copied ${approved.length} approved line${approved.length === 1 ? "" : "s"}.`); }
            catch { toast("Your browser blocked copying. Long-press a line to copy it instead."); }
          } }, `Copy all approved (${approved.length})`)
        : null;
      const toolbar = h("div", { class: "toolbar" },
        h("div", { class: "seg" },
          [["all", "All"], ...kindsUsed.map((k) => [k, COPY_KIND_LABEL[k] || k])].map(([k, l]) =>
            h("button", { class: "seg-btn" + (st.kind === k ? " active" : ""), onclick: () => { st.kind = k; render(); } }, `${l} ${visible.filter((x) => k === "all" || x.kind === k).length}`))),
        h("div", { class: "toolbar-right" },
          h("select", { class: "mini-select", "aria-label": "Status", onchange: (e) => { st.status = e.target.value; render(); } },
            [["all", "Any status"], ["pending", "Awaiting review"], ["changes", "Changes requested"], ["approved", "Approved"]].map(([v, l]) => h("option", { value: v, selected: st.status === v }, l))),
          hiddenCount ? h("button", { class: "btn small" + (st.hidden ? " on-warn" : ""), type: "button", onclick: () => { st.hidden = !st.hidden; render(); } }, st.hidden ? "← Back" : `🗑 Trash (${hiddenCount})`) : null,
          st.hidden ? null : copyApproved,
        ),
      );

      const card = (x) => copyCard(slug, x, { campaigns: d.campaigns, open: st.open, call, rerender: repaint, showAd: true, compact: true });

      const body = shown.length
        ? h("div", { class: "copy-list" }, shown.map(card))
        : h("div", { class: "card empty muted" }, shownUnder.size && !visible.length ? "All the copy is shown under its ad above." : d.items.length ? "Nothing matches these filters." : state.me.admin ? "No copy yet. Add taglines, headlines or ad text above and the client can approve them here." : "No ad copy to review yet.");
      fill(listHolder, toolbar,
        st.hidden ? h("div", { class: "card hidden-note" }, h("div", {}, h("strong", {}, "Copy in the trash. "), "Only shown here. Restore to bring a line back.")) : null,
        body);
    }
    paintFinal();
    render();
    show(
      crumbs(d.client, "", "Ad review"),
      clientTabs(slug, "copy"),
      h("div", { class: "page-head" }, h("h1", {}, "Ad review"),
        h("p", { class: "muted", style: "margin:6px 0 0;max-width:640px" }, state.me.admin ? "The final look of each ad, plus the wording, for the client to approve." : "Check how each ad will look, and the wording. Approve what you like, or ask for changes.")),
      finalBox,
      h("div", { class: "section-head", style: "margin-top:36px" }, h("div", {}, h("h2", {}, shownUnder.size ? "Other ad copy" : "Ad copy"),
        h("p", { class: "muted", style: "margin:4px 0 0;max-width:640px" }, shownUnder.size
          ? "Wording that is not tied to one of the ads above. Copy for an ad shows right under it."
          : state.me.admin ? "Taglines, headlines and ad text for the client to approve. Copy saved for an ad shows under that ad." : "Approve the wording you like, ask for changes, or move what you don't want to the trash."))),
      adder,
      listHolder,
    );
  }
  viewCopy.state = {};

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
        ? mediaBrowser(data.items, { tileFn: (it) => tile(slug, it, true), slug, zipName: `${data.client.name} - Favorites` })
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
    const campCopy = h("div", { class: "camp-copy" });
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
        ? mediaBrowser(data.items, { tileFn: campTile, slug, zipName: `${data.client.name} - ${cp.name}` })
        : h("div", { class: "card empty" }, h("h2", {}, "No ads picked yet"),
            h("p", { class: "muted" }, "Open any ad and choose this campaign under “Use in campaign”.")),
      campCopy,
    );
    // The copy picked for this campaign, under the ads.
    api("GET", `/api/c/${enc(slug)}/copy`).then((d) => {
      const mine = d.items.filter((x) => !x.hidden && x.campaigns.includes(cp.id));
      const approved = mine.filter((x) => x.status === "approved");
      fill(campCopy,
        h("div", { class: "section-label mono muted" }, `AD COPY · ${mine.length}`),
        mine.length
          ? h("div", { class: "copy-list" },
              mine.map((x) => h("a", { class: "card copy-card" + (x.status === "approved" ? " is-approved" : x.status === "changes" ? " is-changes" : ""), href: x.adPath ? `#/c/${enc(slug)}/i/${enc(x.adPath)}` : `#/c/${enc(slug)}/copy`, style: "display:block;color:inherit" },
                h("div", { class: "copy-head" }, h("span", { class: "tag" }, COPY_KIND_LABEL[x.kind] || x.kind), h("span", { class: `pill ${x.status}` }, STATUS_LABEL[x.status])),
                h("div", { class: "copy-text" }, x.text))),
              approved.length
                ? h("div", {}, h("button", { class: "btn small primary", type: "button", onclick: async () => {
                    const out = approved.map((x) => `${(COPY_KIND_LABEL[x.kind] || x.kind).toUpperCase()}: ${x.text}`).join("\n\n");
                    try { await navigator.clipboard.writeText(out); toast(`Copied ${approved.length} approved line${approved.length === 1 ? "" : "s"}.`); } catch { toast("Your browser blocked copying."); }
                  } }, `Copy approved copy (${approved.length})`))
                : null)
          : h("div", { class: "card empty muted" }, "No copy in this campaign yet. On the Ad review tab, tap this campaign's name under a line to add it."),
      );
    }).catch(() => {});
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

    // Backups of the portal's own data (approvals, comments, favorites, campaigns, logins).
    const backupCard = h("div", { class: "card pad", style: "margin-bottom:20px" }, h("h2", {}, "Backups"), h("p", { class: "muted" }, "Checking…"));
    async function loadBackups() {
      let b;
      try { b = await api("GET", "/api/admin/backups"); }
      catch (err) { fill(backupCard, h("h2", {}, "Backups"), h("p", { class: "muted" }, err.message)); return; }
      const nowBtn = h("button", { class: "btn small primary", type: "button", onclick: async () => {
        nowBtn.disabled = true; nowBtn.textContent = "Backing up…";
        try { const r = await api("POST", "/api/admin/backups"); toast(`Saved ${r.name}.`); loadBackups(); }
        catch (err) { toast(err.message); nowBtn.disabled = false; nowBtn.textContent = "Back up now"; }
      } }, "Back up now");
      const rows = b.backups.slice(0, 10).map((f) =>
        h("div", { class: "backup-row" },
          h("div", { style: "min-width:0" },
            h("div", { class: "backup-name" }, f.name.replace(/^portal-backup-/, "").replace(/\.json$/, "")),
            h("div", { class: "mono muted" }, f.size ? fmtSize(f.size) : ""),
          ),
          h("div", { class: "actions" },
            h("button", { class: "linkish", type: "button", onclick: () => saveFile(`/api/admin/backups/file?name=${enc(f.name)}`, f.name) }, "Download"),
            h("button", { class: "linkish", type: "button", style: "color:var(--warn)", onclick: async () => {
              if (!confirm(`Put the portal back the way it was in ${f.name}?\n\nApprovals, comments, favorites, campaigns, tags and logins made after it will be replaced. A safety copy of how things are right now is saved first, so this can be undone.`)) return;
              try { const r = await api("POST", "/api/admin/backups/restore", { name: f.name }); toast(`Restored. Safety copy: ${r.safetyCopy}`); state.listCache.clear(); loadBackups(); }
              catch (err) { toast(err.message); }
            } }, "Restore"),
          ),
        ));
      fill(backupCard,
        h("h2", { style: "margin-bottom:8px" }, "Backups"),
        h("p", { class: "muted", style: "margin:0 0 12px" },
          `Every night at 3:17 AM the portal saves a copy of all approvals, comments, favorites, campaigns, tags and logins to the "${b.folder}" folder on your Synology. The videos and photos themselves are protected by the Synology's own snapshots.`),
        h("p", { style: "margin:0 0 12px" },
          b.last ? h("span", {}, "Last backup: ", h("strong", { style: "color:var(--bone)" }, fmtDate(b.last.at)), h("span", { class: "muted" }, ` · ${b.last.rows} records`)) : h("span", { class: "muted" }, "No backup yet. The first one runs tonight, or tap Back up now.")),
        nowBtn,
        b.error ? h("p", { class: "muted", style: "margin:12px 0 0" }, b.error) : null,
        rows.length ? h("div", { class: "backup-list" }, rows) : null,
      );
    }
    loadBackups();

    // Claude feed: a report on the Synology that Claude can read in a chat linked to the Mac.
    const feedCard = h("div", { class: "card pad", style: "margin-bottom:20px" }, h("h2", {}, "Claude feed"));
    async function loadFeed() {
      let f = { last: null, folder: "_Claude feed" };
      try { f = await api("GET", "/api/admin/feed"); } catch { /* shown as not yet */ }
      const btn = h("button", { class: "btn small", type: "button", onclick: async () => {
        btn.disabled = true; btn.textContent = "Updating…";
        try { await api("POST", "/api/admin/feed"); toast("Claude feed updated."); loadFeed(); }
        catch (err) { toast(err.message); btn.disabled = false; btn.textContent = "Update now"; }
      } }, "Update now");
      fill(feedCard,
        h("h2", { style: "margin-bottom:8px" }, "Claude feed"),
        h("p", { class: "muted", style: "margin:0 0 12px" },
          `Every 30 minutes, when something changed, the portal writes what clients approved, the changes they asked for (with every comment and timecode), unanswered comments, campaigns and hidden ads to "${f.folder}/client-feedback.md" on your Synology. In a Claude chat linked to your Mac, ask "check the client feedback" and Claude reads it and can open the files.`),
        h("p", { style: "margin:0 0 12px" }, f.last ? h("span", {}, "Last updated: ", h("strong", { style: "color:var(--bone)" }, fmtDate(f.last))) : h("span", { class: "muted" }, "Not written yet.")),
        btn,
      );
    }
    loadFeed();

    const KIND = { comment: "commented on", like: "liked", approved: "approved", changes: "requested changes on", rejected: "said no to", pending: "reset the status of", campaign_add: "added to a campaign:", campaign_remove: "took out of a campaign:", renamed: "renamed a file to", hidden: "moved to trash:", unhidden: "took out of the trash:", deleted: "deleted" };
    const feed = data.activity.length
      ? data.activity.map((a) =>
          h("div", { class: "feed-item" },
            h("div", { class: "mono muted" }, `${a.client_name || a.client_slug} · ${fmtDate(a.created_at)}`),
            h("div", {},
              h("span", { style: "color:var(--bone)" }, a.email), ` ${KIND[a.kind] || a.kind} `,
              h("a", { href: itemHref(a.client_slug, a.path) }, itemLabel(a.path, a.kind !== "comment" && !String(a.kind).startsWith("campaign") ? a.detail : null)),
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
          backupCard,
          feedCard,
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
    if (parts[2] === "copy") return "Ad review";
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

  // ---- top bar: logo always goes home; admin gets Dashboard, a client menu and Admin ----
  function setupNav() {
    document.getElementById("nav-email").textContent = state.me.email;
    const admin = state.me.admin;
    document.getElementById("nav-admin").hidden = !admin;
    document.getElementById("nav-dash").hidden = !admin;
    const sel = document.getElementById("nav-clients");
    const clients = state.me.clients || [];
    if (admin || clients.length > 1) {
      sel.hidden = false;
      fill(sel, h("option", { value: "" }, admin ? "Clients" : "My projects"), clients.map((c) => h("option", { value: c.slug }, c.name)));
      sel.onchange = () => { if (sel.value) location.hash = `#/c/${enc(sel.value)}`; };
    }
    // Tapping the logo on the page you're already on still refreshes it and goes to the top.
    document.querySelector(".brand").addEventListener("click", (e) => {
      const here = location.hash.replace(/^#/, "") || "/";
      if (here === "/") { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); router(); }
    });
  }
  function markNav(hash, parts) {
    const dash = document.getElementById("nav-dash");
    const adminLink = document.getElementById("nav-admin");
    const sel = document.getElementById("nav-clients");
    dash.classList.toggle("active", hash === "/" || hash === "");
    adminLink.classList.toggle("active", parts[0] === "admin");
    if (!sel.hidden) {
      const slug = parts[0] === "c" ? decodeURIComponent(parts[1] || "") : "";
      sel.value = (state.me.clients || []).some((c) => c.slug === slug) ? slug : "";
      sel.classList.toggle("active", !!sel.value);
    }
  }

  async function route(hash, parts) {
    {
      if (!state.me) {
        state.me = await api("GET", "/api/me");
        setupNav();
      }
      markNav(hash, parts);
      if (parts[0] === "admin") return viewAdmin();
      if (parts[0] === "c" && parts[1]) {
        const slug = decodeURIComponent(parts[1]);
        if (parts[2] === "i" && parts[3]) return viewItem(slug, decodeURIComponent(parts.slice(3).join("/")));
        if (parts[2] === "favorites") return viewFavorites(slug);
        if (parts[2] === "copy") return viewCopy(slug);
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
  // After a rename from a tile's menu, redraw the page with the new names.
  document.addEventListener("gv-renamed", () => router());
  router();
})();
