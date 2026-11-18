/*
 * Discord Connections+ - page-world script
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Runs inside discord.com's own JavaScript world at document_start.
 *
 * 1. Unhide: Discord keeps every connection type in one platform registry and
 *    hides some of them with `enabled: false` (TikTok, Instagram, Mastodon, ...).
 *    We wrap that registry's webpack module and flip the flag as soon as it
 *    loads, so the hidden types show up again in Settings > Connections.
 *    This is the same idea as Endcord's AllConnectionsEnabled plugin
 *    (https://github.com/Endcord/Endcord, GPL-3.0-or-later), done without a
 *    full client mod.
 *
 * 2. Panel: a small in-page panel (toolbar button or Alt+Shift+C) that starts
 *    the real connection flow through Discord's own code, opens the provider's
 *    sign-in window, and reports exactly what Discord or the provider said.
 *
 * Nothing here reads, stores or sends your Discord token. Every request goes
 * through Discord's own HTTP client, as if you had clicked the button in Settings.
 */
(() => {
    "use strict";

    if (window.__dcPlus) return;

    const TAG = "[Connections+]";
    const log = (...a) => console.log("%c" + TAG, "color:#5865f2;font-weight:bold", ...a);
    const warn = (...a) => console.warn(TAG, ...a);

    /* ------------------------------------------------------------------ */
    /* Config                                                              */
    /* ------------------------------------------------------------------ */

    // Hidden types we leave hidden in Settings (still listed in the panel).
    const KEEP_HIDDEN_IN_SETTINGS = new Set(["playstation-stg"]);

    // Types the panel can't drive with a plain sign-in popup.
    const PANEL_SKIP = new Set(["domain", "contacts"]);

    // What we know about specific types. Shown under the row in the panel.
    const NOTES = {
        instagram: "Meta shut down the Instagram API Discord used in December 2024. Discord or Instagram will most likely reject this.",
        skype: "Skype itself shut down in May 2025.",
        twitter_legacy: "The old Twitter connection. The X connection replaced it.",
        "playstation-stg": "Discord's internal PlayStation test environment. Not for normal accounts.",
        samsung: "Old Samsung Galaxy connection Discord no longer offers.",
    };

    /* ------------------------------------------------------------------ */
    /* State                                                               */
    /* ------------------------------------------------------------------ */

    const state = {
        wreq: null,          // Discord's webpack require
        platforms: null,     // Discord's platform registry ({ get, map, isSupported, ... })
        unhidden: [],        // [{ type, name }] flipped to enabled
        hiddenTypes: new Set(), // every type Discord had disabled
        hookedFactory: false,
        trap: null,
    };
    const mods = { accounts: null, store: null, http: null, storeListening: false };

    /* ------------------------------------------------------------------ */
    /* Webpack helpers                                                     */
    /* ------------------------------------------------------------------ */

    const fnToString = Function.prototype.toString;
    const srcOf = f => {
        try { return fnToString.call(f); } catch { return ""; }
    };

    function isPlatformsApi(o) {
        if (!o || typeof o !== "object") return false;
        if (typeof o.getByUrl !== "function" || typeof o.isSupported !== "function" || typeof o.map !== "function" || typeof o.get !== "function") return false;
        const list = o.map(x => x);
        return Array.isArray(list) && list.length > 5 && list.every(p => p && typeof p.type === "string" && "enabled" in p);
    }
    const isAccountsApi = o =>
        !!o && typeof o.authorize === "function" && typeof o.callback === "function" && srcOf(o.authorize).includes("CONNECTIONS_AUTHORIZE");
    const isAccountsStore = o =>
        !!o && typeof o.getAccounts === "function" && o.constructor?.displayName === "ConnectedAccountsStore";
    const HTTP_KEYS = ["get", "post", "put", "patch", "del"];
    const isHttp = o => {
        if (!o || typeof o !== "object" || Object.getPrototypeOf(o) !== Object.prototype) return false;
        const keys = Object.keys(o);
        return keys.length === HTTP_KEYS.length && HTTP_KEYS.every(k => typeof o[k] === "function");
    };

    // Return `ex` or one of its direct exports that matches `pred`.
    function pick(ex, pred) {
        if (!ex || ex === window || (typeof ex !== "object" && typeof ex !== "function")) return null;
        try { if (pred(ex)) return ex; } catch { }
        let keys;
        try { keys = Object.keys(ex); } catch { return null; }
        for (const k of keys) {
            let v;
            try { v = ex[k]; } catch { continue; }
            if (!v || v === window) continue;
            try { if (pred(v)) return v; } catch { }
        }
        return null;
    }

    // Grab webpack's require by pushing a fake chunk (works after Discord loaded).
    // Several Discord bundles (web, fast-connect, sentry, ...) each run their own
    // webpack runtime on the same chunk array, and a pushed chunk reaches all of
    // them. Keep the one that owns the connection list, or else the biggest.
    function getWreq() {
        if (state.wreq) return state.wreq;
        const chunks = window.webpackChunkdiscord_app;
        if (!Array.isArray(chunks) || chunks.push === Array.prototype.push) return null;

        const found = [];
        try {
            chunks.push([[Symbol("dcPlus")], {}, r => { if (typeof r === "function" && !found.includes(r)) found.push(r); }]);
            chunks.pop();
        } catch (e) { warn("could not reach webpack", e); }
        if (!found.length) return null;

        const ownsPlatforms = r => {
            try {
                for (const id in r.m) if (srcOf(r.m[id]).includes("getPlatformUserUrl:")) return true;
            } catch { }
            return false;
        };
        const size = r => { try { return Object.keys(r.m ?? {}).length; } catch { return 0; } };
        state.wreq = found.find(ownsPlatforms) ?? found.sort((a, b) => size(b) - size(a))[0];
        restoreTrap();
        return state.wreq;
    }

    // Look in loaded modules first; if `hints` are given, load the module whose
    // source contains all of them.
    function findModule(pred, hints) {
        const r = getWreq();
        if (!r) return null;
        for (const id in r.c) {
            const hit = pick(r.c[id]?.exports, pred);
            if (hit) return hit;
        }
        if (!hints) return null;
        for (const id in r.m) {
            if (r.c[id]) continue;
            const s = srcOf(r.m[id]);
            if (!hints.every(h => s.includes(h))) continue;
            try {
                const hit = pick(r(id), pred);
                if (hit) return hit;
            } catch (e) { warn("loading module", id, "failed", e); }
        }
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* 1. Unhide                                                           */
    /* ------------------------------------------------------------------ */

    function unhide(api) {
        if (state.platforms) return;
        state.platforms = api;
        for (const p of api.map(x => x)) {
            if (!p || p.enabled !== false) continue;
            state.hiddenTypes.add(p.type);
            if (KEEP_HIDDEN_IN_SETTINGS.has(p.type)) continue;
            try {
                p.enabled = true;
                state.unhidden.push({ type: p.type, name: p.name });
            } catch (e) { warn("could not unhide", p.type, e); }
        }
        log(`Unhid ${state.unhidden.length} connection(s): ${state.unhidden.map(u => u.name).join(", ")}`);
        scheduleRender();
    }

    // Catch the moment Discord's webpack runtime does `require.m = modules`.
    // At that point no module has run yet, so we can wrap the platform
    // registry's factory and fix the list before anything reads it.
    function installTrap() {
        const proto = Function.prototype;
        const prev = Object.getOwnPropertyDescriptor(proto, "m");
        if (prev && !prev.configurable) return;
        const desc = {
            configurable: true,
            enumerable: false,
            get: prev?.get,
            set(modules) {
                try {
                    Object.defineProperty(this, "m", { value: modules, configurable: true, enumerable: true, writable: true });
                } catch { }
                if (prev?.set) {
                    try { prev.set.call(this, modules); } catch { }
                }
                try { onModules(this, modules); } catch (e) { warn("webpack hook failed", e); }
            },
        };
        Object.defineProperty(proto, "m", desc);
        state.trap = { prev, desc };
    }

    function restoreTrap() {
        const t = state.trap;
        if (!t) return;
        state.trap = null;
        const cur = Object.getOwnPropertyDescriptor(Function.prototype, "m");
        if (cur?.set !== t.desc.set) return; // someone else took over; leave theirs alone
        if (t.prev) Object.defineProperty(Function.prototype, "m", t.prev);
        else delete Function.prototype.m;
    }

    function onModules(req, modules) {
        if (state.hookedFactory || !modules || typeof modules !== "object") return;
        if (!srcOf(req).includes("exports:{}")) return;
        for (const id in modules) {
            const factory = modules[id];
            if (typeof factory !== "function") continue;
            const s = srcOf(factory);
            if (!s.includes("getPlatformUserUrl:") || !s.includes("isSupported:")) continue;

            const wrapped = function dcPlusPlatformRegistry(module) {
                const ret = factory.apply(this, arguments);
                try {
                    const api = pick(module?.exports, isPlatformsApi);
                    if (api) unhide(api);
                    else warn("found the platform module but not its registry export");
                } catch (e) { warn("unhide failed", e); }
                return ret;
            };
            // Other mods look modules up by source text; keep it intact for them.
            wrapped.toString = () => s;
            modules[id] = wrapped;

            state.wreq ||= req;
            state.hookedFactory = true;
            restoreTrap();
            return;
        }
    }

    installTrap();

    // Fallback for late injection (tab was open before install) or if Discord
    // moves the registry into a lazy chunk: look for it once Discord is up.
    {
        let tries = 0;
        const timer = setInterval(() => {
            if (state.platforms || ++tries > 90) {
                clearInterval(timer);
                if (!state.platforms) warn("Could not find Discord's connection list. Discord may have changed; open the panel to retry.");
                return;
            }
            if (!getWreq()) return;
            const api = findModule(isPlatformsApi, tries > 10 ? ["getPlatformUserUrl:", "isSupported:"] : null);
            if (api) unhide(api);
        }, 1000);
    }

    /* ------------------------------------------------------------------ */
    /* 2. Connecting                                                       */
    /* ------------------------------------------------------------------ */

    function resolveModules() {
        if (!getWreq()) return false;
        if (!state.platforms) {
            const api = findModule(isPlatformsApi, ["getPlatformUserUrl:", "isSupported:"]);
            if (api) unhide(api);
        }
        mods.accounts ||= findModule(isAccountsApi, ['"ConnectedAccounts"', "CONNECTIONS_AUTHORIZE"]);
        mods.store ||= findModule(isAccountsStore, ['displayName="ConnectedAccountsStore"']);
        mods.http ||= findModule(isHttp, null);
        if (mods.store && !mods.storeListening && typeof mods.store.addChangeListener === "function") {
            mods.store.addChangeListener(scheduleRender);
            mods.storeListening = true;
        }
        return !!state.platforms && !!(mods.accounts || mods.http);
    }

    function accountsOf(type) {
        try {
            return (mods.store?.getAccounts?.() ?? []).filter(a => a?.type === type);
        } catch { return []; }
    }

    async function refreshAccounts() {
        try {
            if (typeof mods.accounts?.fetch === "function") await mods.accounts.fetch();
        } catch (e) { warn("refreshing connections failed", e); }
    }

    async function getAuthorizeUrl(type, handle) {
        const opts = handle ? { handle } : {};
        let res;
        if (mods.accounts) {
            res = await mods.accounts.authorize(type, opts);
        } else if (mods.http) {
            const qs = handle ? "?handle=" + encodeURIComponent(handle) : "";
            res = await mods.http.get({ url: `/connections/${encodeURIComponent(type)}/authorize${qs}`, oldFormErrors: true });
        } else {
            throw new Error("Couldn't find Discord's connection code. Discord may have updated; reload the page and try again.");
        }
        const url = res?.body?.url;
        if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
            throw Object.assign(new Error("Discord didn't return a sign-in link"), { body: res?.body });
        }
        return url;
    }

    function flattenErrors(errors, out = []) {
        if (!errors || out.length >= 3) return out;
        if (typeof errors === "string") { out.push(errors); return out; }
        if (Array.isArray(errors)) { errors.forEach(e => flattenErrors(e, out)); return out; }
        if (typeof errors === "object") {
            if (typeof errors.message === "string") out.push(errors.message);
            for (const [k, v] of Object.entries(errors)) if (k !== "message" && k !== "code") flattenErrors(v, out);
        }
        return out;
    }

    function describeError(err) {
        if (!err) return "Unknown error";
        const body = err.body && typeof err.body === "object" ? err.body : {};
        const code = err.code ?? body.code;
        const status = err.status ?? err.statusCode;
        if (status === 401) return "you're not logged in to Discord in this tab (HTTP 401).";
        let msg = typeof body.message === "string" && body.message ? body.message : err.message;
        if (!msg && typeof err === "string") msg = err;
        const meta = [code ? `code ${code}` : null, status ? `HTTP ${status}` : null].filter(Boolean);
        const details = flattenErrors(err.errors ?? body.errors).filter(m => m !== msg);
        return [msg || "Unknown error", meta.length ? `(${meta.join(", ")})` : "", details.length ? "- " + details.join("; ") : ""]
            .filter(Boolean).join(" ");
    }

    function popupFeatures() {
        const w = 520, h = 760;
        const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
        const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
        return `popup,width=${w},height=${h},left=${left},top=${top}`;
    }

    async function connect(platform, handle) {
        const { type, name } = platform;
        if (ui.busy.has(type)) return;
        if (platform.isFederated && !handle) {
            addLog(name, "warn", `Type your ${name} handle first (for example you@mastodon.social).`);
            return;
        }

        // Open the window now, while we still have your click, or the browser blocks it.
        const popup = window.open("about:blank", "dcplus-" + type, popupFeatures());
        try {
            if (popup) {
                popup.document.title = `Connecting ${name}...`;
                popup.document.body.style.cssText = "font:15px system-ui;background:#1e1f22;color:#dbdee1;display:grid;place-items:center;height:100vh;margin:0";
                popup.document.body.textContent = `Asking Discord for a ${name} sign-in link...`;
            }
        } catch { }

        const before = new Set(accountsOf(type).map(a => a.id));
        ui.busy.set(type, "Asking Discord for a sign-in link...");
        render();

        let url;
        try {
            url = await getAuthorizeUrl(type, handle);
        } catch (err) {
            try { popup?.close(); } catch { }
            ui.busy.delete(type);
            addLog(name, "err", "Discord wouldn't start the connection: " + describeError(err));
            return;
        }

        if (!popup || popup.closed) {
            window.open(url, "_blank");
            addLog(name, "warn", "Your browser blocked the popup, so the sign-in page opened in a new tab. Finish it there, then press refresh here.");
            ui.busy.delete(type);
            render();
            return;
        }

        popup.location.href = url;
        addLog(name, "info", `Discord gave a ${name} sign-in link. Finish signing in in the popup.`);
        ui.busy.set(type, "Waiting for you to finish in the popup...");
        render();
        watchPopup(popup, platform, before);
    }

    function watchPopup(popup, platform, before) {
        const { type, name } = platform;
        const startedAt = Date.now();
        let sawSuccess = false;
        let sawError = false;

        const timer = setInterval(() => {
            let closed = true;
            try { closed = popup.closed; } catch { }

            if (!closed) {
                let path = null, search = "";
                try {
                    // Throws while the popup is on the provider's site (cross-origin).
                    if (popup.location.origin === location.origin) {
                        path = popup.location.pathname;
                        search = popup.location.search;
                    }
                } catch { }
                const m = path && /^\/connections\/[^/]+\/(success|error)\/?$/.exec(path);
                if (m?.[1] === "success") {
                    sawSuccess = true;
                } else if (m?.[1] === "error" && !sawError) {
                    sawError = true;
                    const code = new URLSearchParams(search).get("error-code");
                    // Give Discord's error page a moment to render its message, then quote it.
                    setTimeout(() => {
                        let said = "";
                        try { said = (popup.document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 260); } catch { }
                        addLog(name, "err", `Discord rejected the ${name} connection${code ? ` (error code ${code})` : ""}.${said ? " The page said: “" + said + "”" : ""}`);
                    }, 1500);
                }
            }

            if (closed || Date.now() - startedAt > 15 * 60e3) {
                clearInterval(timer);
                ui.busy.set(type, "Checking your connections...");
                render();
                refreshAccounts().then(() => {
                    ui.busy.delete(type);
                    const added = accountsOf(type).filter(a => !before.has(a.id));
                    if (added.length) {
                        addLog(name, "ok", `Connected: ${added.map(a => a.name || a.id).join(", ")}.`);
                    } else if (sawSuccess) {
                        addLog(name, "ok", "Discord said the connection worked, but it hasn't shown up yet. Press refresh in a few seconds.");
                    } else if (!sawError) {
                        addLog(name, "warn", `The sign-in window closed and no new ${name} connection showed up on your account.`);
                    }
                    render();
                });
            }
        }, 400);
    }

    /* ------------------------------------------------------------------ */
    /* Panel UI                                                            */
    /* ------------------------------------------------------------------ */

    const ui = {
        host: null,
        root: null,
        panel: null,
        body: null,
        open: false,
        showOthers: false,
        busy: new Map(),
        handles: new Map(),
        logs: [],
        renderQueued: false,
        waitTimer: null,
    };

    const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel {
  --bg: #232428; --surface: #2b2d31; --hover: #35373c; --text: #f2f3f5; --muted: #b5bac1;
  --border: #3f4147; --brand: #5865f2; --brand-hover: #4752c4; --ok: #23a55a; --err: #f23f43; --warn: #f0b232;
  position: fixed; top: 16px; right: 16px; width: 384px; max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px); display: flex; flex-direction: column;
  background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0,0,0,.5); overflow: hidden;
  font: 14px/1.4 "gg sans", "Noto Sans", "Segoe UI", system-ui, sans-serif;
}
.panel.light {
  --bg: #ffffff; --surface: #f2f3f5; --hover: #e8e9ec; --text: #060607; --muted: #4e5058; --border: #d9dadd;
  box-shadow: 0 16px 48px rgba(0,0,0,.18);
}
header { display: flex; align-items: center; gap: 8px; padding: 14px 14px 12px 16px; border-bottom: 1px solid var(--border); }
header .titles { flex: 1; min-width: 0; }
h1 { margin: 0; font-size: 16px; font-weight: 700; }
header p { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.icon-btn {
  width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 8px;
  background: transparent; color: var(--muted); cursor: pointer;
}
.icon-btn:hover { background: var(--hover); color: var(--text); }
.icon-btn:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.icon-btn svg { width: 18px; height: 18px; }
.body { overflow-y: auto; padding: 12px 16px 16px; }
.banner { padding: 10px 12px; border-radius: 8px; background: var(--surface); font-size: 13px; margin-bottom: 14px; }
.banner.warn { border-left: 3px solid var(--warn); }
.banner.ok { border-left: 3px solid var(--ok); }
h2 { margin: 16px 0 6px; font-size: 12px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); }
h2:first-child { margin-top: 0; }
.row { display: grid; grid-template-columns: 32px 1fr auto; gap: 10px; align-items: center; padding: 8px; border-radius: 8px; }
.row:hover { background: var(--surface); }
.logo { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; background: var(--surface); overflow: hidden; font-weight: 700; color: var(--muted); }
.logo img { width: 24px; height: 24px; object-fit: contain; }
.main { min-width: 0; }
.name { font-weight: 600; }
.sub { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.sub.connected { color: var(--ok); }
.note { font-size: 12px; color: var(--warn); margin-top: 2px; }
.handle { grid-column: 2 / 4; display: flex; gap: 6px; }
input {
  flex: 1; min-width: 0; height: 32px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); font: inherit; font-size: 13px;
}
button.connect {
  height: 32px; padding: 0 14px; border: 0; border-radius: 6px; background: var(--brand); color: #fff;
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
}
button.connect:hover { background: var(--brand-hover); }
button.connect[disabled] { opacity: .55; cursor: default; background: var(--brand); }
details { margin-top: 12px; }
summary { cursor: pointer; font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--muted); padding: 4px 0; border-radius: 4px; }
.log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.log li { display: grid; grid-template-columns: 8px 1fr; gap: 8px; font-size: 12.5px; padding: 8px 10px; background: var(--surface); border-radius: 8px; }
.log .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; background: var(--muted); }
.log .ok .dot { background: var(--ok); }
.log .err .dot { background: var(--err); }
.log .warn .dot { background: var(--warn); }
.log time { color: var(--muted); margin-right: 4px; }
.empty { font-size: 12.5px; color: var(--muted); }
.foot { font-size: 11.5px; color: var(--muted); margin-top: 16px; }
`;

    const SVG_NS = "http://www.w3.org/2000/svg";
    function svgIcon(d) {
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("fill", "currentColor");
        path.setAttribute("d", d);
        svg.append(path);
        return svg;
    }
    const ICON_CLOSE = "M17.3 5.3a1 1 0 1 1 1.4 1.4L13.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4L12 13.42l-5.3 5.3a1 1 0 0 1-1.4-1.42L10.58 12l-5.3-5.3a1 1 0 0 1 1.42-1.4L12 10.58l5.3-5.3Z";
    const ICON_REFRESH = "M4 12a8 8 0 0 1 13.66-5.66L19 7.68V4a1 1 0 1 1 2 0v6a1 1 0 0 1-1 1h-6a1 1 0 1 1 0-2h3.6l-1.36-1.24A6 6 0 1 0 18 12a1 1 0 1 1 2 0 8 8 0 0 1-16 0Z";

    // Tiny DOM builder. Text always goes through textContent, never HTML.
    function el(tag, props, ...kids) {
        const n = document.createElement(tag);
        if (props) {
            for (const [k, v] of Object.entries(props)) {
                if (v == null || v === false) continue;
                if (k === "class") n.className = v;
                else if (k === "text") n.textContent = v;
                else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
                else n.setAttribute(k, v === true ? "" : String(v));
            }
        }
        for (const c of kids.flat()) {
            if (c == null || c === false) continue;
            n.append(c instanceof Node ? c : String(c));
        }
        return n;
    }

    function ensurePanel() {
        if (ui.host) {
            if (!ui.host.isConnected) (document.body || document.documentElement).append(ui.host);
            return;
        }
        const host = document.createElement("div");
        host.id = "dcplus-root";
        const root = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = PANEL_CSS;

        const closeBtn = el("button", { class: "icon-btn", type: "button", "aria-label": "Close", title: "Close (Esc)", onclick: () => setOpen(false) }, svgIcon(ICON_CLOSE));
        const refreshBtn = el("button", {
            class: "icon-btn", type: "button", "aria-label": "Refresh connections", title: "Refresh",
            onclick: () => { resolveModules(); refreshAccounts().then(render); },
        }, svgIcon(ICON_REFRESH));

        const body = el("div", { class: "body" });
        const panel = el("div", { class: "panel", role: "dialog", "aria-label": "Connections+" },
            el("header", null,
                el("div", { class: "titles" },
                    el("h1", { text: "Connections+" }),
                    el("p", { text: "Hidden Discord connections, back in reach" })),
                refreshBtn, closeBtn),
            body);
        panel.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } });

        root.append(style, panel);
        (document.body || document.documentElement).append(host);
        Object.assign(ui, { host, root, panel, body, closeBtn });
    }

    function setOpen(open) {
        ui.open = open;
        if (open) {
            ensurePanel();
            ui.host.hidden = false;
            if (resolveModules()) refreshAccounts().then(render);
            render();
            ui.closeBtn.focus();
            if (!ui.waitTimer) {
                let tries = 0;
                ui.waitTimer = setInterval(() => {
                    const ready = resolveModules();
                    if (!ui.open || ready || ++tries >= 30) {
                        clearInterval(ui.waitTimer);
                        ui.waitTimer = null;
                        ui.gaveUp = !ready && tries >= 30;
                        render();
                    }
                }, 1000);
            }
        } else if (ui.host) {
            ui.host.hidden = true;
        }
    }

    function scheduleRender() {
        if (ui.renderQueued || !ui.open) return;
        ui.renderQueued = true;
        requestAnimationFrame(() => { ui.renderQueued = false; render(); });
    }

    function addLog(name, level, text) {
        const entry = { time: new Date(), name, level, text };
        ui.logs.unshift(entry);
        ui.logs.length = Math.min(ui.logs.length, 30);
        (level === "err" ? warn : log)(`${name}: ${text}`);
        render();
    }

    function platformLogo(p, light) {
        const src = light ? (p.icon?.lightSVG ?? p.icon?.lightPNG) : (p.icon?.darkSVG ?? p.icon?.darkPNG);
        const box = el("div", { class: "logo", "aria-hidden": "true" });
        if (typeof src === "string" && src) {
            const img = el("img", { src, alt: "" });
            img.addEventListener("error", () => { img.remove(); box.textContent = (p.name || "?")[0]; });
            box.append(img);
        } else {
            box.textContent = (p.name || "?")[0];
        }
        return box;
    }

    function platformRow(p, light) {
        const busy = ui.busy.get(p.type);
        const accounts = accountsOf(p.type);
        const status = busy
            ? el("div", { class: "sub", text: busy })
            : accounts.length
                ? el("div", { class: "sub connected", text: "Connected: " + accounts.map(a => a.name || a.id).join(", ") })
                : el("div", { class: "sub", text: "Not connected" });

        let handleInput = null;
        if (p.isFederated) {
            handleInput = el("input", {
                "data-key": "handle:" + p.type,
                type: "text", placeholder: p.type === "bluesky" ? "you.bsky.social" : "you@mastodon.social",
                "aria-label": `${p.name} handle`, value: ui.handles.get(p.type) ?? "", spellcheck: "false", autocomplete: "off",
            });
            handleInput.addEventListener("input", () => ui.handles.set(p.type, handleInput.value.trim()));
            handleInput.addEventListener("keydown", e => { if (e.key === "Enter") btn.click(); });
        }

        const btn = el("button", {
            "data-key": "connect:" + p.type,
            class: "connect", type: "button", disabled: !!busy,
            "aria-label": `Connect ${p.name}`,
            onclick: () => connect(p, handleInput ? handleInput.value.trim() : undefined),
        }, busy ? "Working..." : accounts.length ? "Add another" : "Connect");

        const note = NOTES[p.type];
        return el("div", { class: "row" },
            platformLogo(p, light),
            el("div", { class: "main" },
                el("div", { class: "name", title: `Discord type: ${p.type}`, text: p.name }),
                status,
                note ? el("div", { class: "note", text: note }) : null),
            btn,
            handleInput ? el("div", { class: "handle" }, handleInput) : null);
    }

    function render() {
        if (!ui.open || !ui.body) return;
        const light = document.documentElement.classList.contains("theme-light");
        ui.panel.classList.toggle("light", light);

        const ready = !!state.platforms && !!(mods.accounts || mods.http);
        const kids = [];

        if (!ready) {
            const msg = ui.gaveUp
                ? "Couldn't find Discord's connection code. Discord probably changed something; reload the page, and if it keeps happening the extension needs an update."
                : state.wreq ? "Looking for Discord's connection code..." : "Waiting for Discord to finish loading...";
            kids.push(el("div", { class: "banner warn", text: msg }));
            if (!state.wreq && location.pathname.startsWith("/login")) {
                kids.push(el("div", { class: "empty", text: "Log in to Discord first." }));
            }
        } else {
            const shown = state.unhidden.length;
            kids.push(el("div", { class: "banner ok" },
                shown
                    ? `${shown} hidden connection${shown === 1 ? " is" : "s are"} back in Settings > Connections. You can also connect them from here.`
                    : "Discord isn't hiding any connections right now."));

            const all = state.platforms.map(x => x).filter(p => p && !PANEL_SKIP.has(p.type));
            const byName = (a, b) => String(a.name).localeCompare(String(b.name));
            // Ones with no known blocker first; known-dead services after.
            const byHope = (a, b) => (a.type in NOTES) - (b.type in NOTES) || byName(a, b);
            const hidden = all.filter(p => state.hiddenTypes.has(p.type)).sort(byHope);
            const others = all.filter(p => !state.hiddenTypes.has(p.type)).sort(byName);

            kids.push(el("h2", { text: "Hidden by Discord" }));
            if (hidden.length) hidden.forEach(p => kids.push(platformRow(p, light)));
            else kids.push(el("div", { class: "empty", text: "None." }));

            const details = el("details", null, el("summary", { text: `Other connections (${others.length})` }));
            details.open = ui.showOthers;
            details.addEventListener("toggle", () => { ui.showOthers = details.open; });
            others.forEach(p => details.append(platformRow(p, light)));
            kids.push(details);

            if (!mods.store) kids.push(el("div", { class: "empty", text: "Couldn't read your current connections; statuses may be missing." }));
        }

        kids.push(el("h2", { text: "Activity" }));
        if (ui.logs.length) {
            kids.push(el("ul", { class: "log" }, ui.logs.map(l => el("li", { class: l.level },
                el("span", { class: "dot", "aria-hidden": "true" }),
                el("div", null,
                    el("time", { datetime: l.time.toISOString(), text: l.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }),
                    el("strong", { text: l.name + ": " }),
                    l.text)))));
        } else {
            kids.push(el("div", { class: "empty", text: "Nothing yet. Press Connect on a platform to start." }));
        }

        kids.push(el("div", { class: "foot", text: "Discord's servers and each platform decide whether a connection goes through. This extension can only show you the button and their answer." }));

        // Rebuilding the list would drop focus (e.g. while typing a handle); put it back.
        const active = ui.root.activeElement;
        const activeKey = active?.dataset?.key;
        const selection = active && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
        const scroll = ui.body.scrollTop;

        ui.body.replaceChildren(...kids);
        ui.body.scrollTop = scroll;

        if (activeKey) {
            const again = ui.body.querySelector(`[data-key="${CSS.escape(activeKey)}"]`);
            if (again && !again.disabled) {
                again.focus({ preventScroll: true });
                if (selection && typeof again.setSelectionRange === "function") {
                    try { again.setSelectionRange(selection[0], selection[1]); } catch { }
                }
            }
        }
    }

    window.addEventListener("dcplus:toggle", () => {
        if (window.top !== window) return;
        setOpen(!ui.open);
    });

    Object.defineProperty(window, "__dcPlus", {
        value: Object.freeze({
            state, mods,
            open: () => setOpen(true),
            close: () => setOpen(false),
        }),
    });

    log("loaded");
})();
