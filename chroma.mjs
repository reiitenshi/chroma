#!/usr/bin/env node
// chroma — themes for Steam Big Picture.
// Serves chroma-picker (/) and the dev editor (/dev), previews live in Steam over CDP, exports a
// CSS Loader theme. Node 22+, no dependencies. Usage: node chroma.mjs [--port 7300] [--profile mine]
// The desktop app (desktop/) imports this file and sets CHROMA_DATA to its writable folder.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ROOT holds what ships (editor, catalogue, template; read-only inside the app); DATA holds what
// chroma writes (profiles, cache, catalogues extended by the trawl).
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CHROMA_DATA ?? ROOT;
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg('port', process.env.CHROMA_PORT ?? 7300));
const PROFILE = arg('profile', 'mine');
// The Steam build chroma's catalogue and template were made on (stable). Others: best effort.
const MADE_FOR = '1794536281';
// Steam's debugging port: 8080 when turned on by file or launch option (what Decky uses); 8081
// is tried too.
const CDP_PORTS = [8080, 8081];
const THEMES_DIR = path.join(os.homedir(), 'homebrew', 'themes'); // CSS Loader's themes folder
const PROFILE_PATH = path.join(DATA, 'profiles', `${PROFILE}.json`);
const PREVIEW_ID = 'chroma-preview';
const LOCATE_ID = 'chroma-locate';

// Only colour properties (plus the glass blur), only colour- or blur-shaped values: the CSS is
// built from page input.
const PROPS = new Set(['background', 'color', 'border-color', 'fill', 'backdrop-filter']);
// State props ("highlight:color") style the part's hover/focus or :active rules.
const STATES = new Set(['highlight', 'pressed']);
const validProp = k => PROPS.has(k) || (k.includes(':') && STATES.has(k.split(':')[0]) && PROPS.has(k.split(':')[1]));
const VALUE_RE = /^(#[0-9a-f]{3,8}|(rgba?|hsla?)\([\d.,%\s/]+\)|[a-z]{3,20})$/i;
const BLUR_RE = /^blur\(\d{1,3}(\.\d+)?px\)$/;
const validValue = (prop, v) => typeof v === 'string' && (prop.endsWith('backdrop-filter') ? BLUR_RE : VALUE_RE).test(v);

// ─── CDP ────────────────────────────────────────────────────────────────────

const TARGETS = {
  BigPicture: t => t.title === 'Steam Big Picture Mode' || t.url.includes('Valve%20Steam%20Gamepad'),
  SharedJSContext: t => t.title === 'SharedJSContext',
  MainMenu: t => t.title.startsWith('MainMenu'),       // Ctrl+1 side menu
  QuickAccess: t => t.title.startsWith('QuickAccess'), // Ctrl+2 side menu
};
// Windows that get the theme. The side menus are their own windows with the same stylesheets.
const WINDOWS = ['BigPicture', 'MainMenu', 'QuickAccess'];
// Run fn(role) for every theme window; a side menu that isn't up is skipped.
const eachWindow = fn => Promise.all(WINDOWS.map(role =>
  fn(role).catch(e => { if (role === 'BigPicture') throw e; })));
const sockets = new Map();

// The debugging endpoint that answers, or null when Steam isn't running with debugging on.
let cdpBase = null;
async function findCdp() {
  for (const port of [...new Set([cdpBase && Number(cdpBase.split(':').pop()), ...CDP_PORTS].filter(Boolean))]) {
    const base = `http://localhost:${port}`;
    try {
      const r = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return (cdpBase = base);
    } catch { /* not this one */ }
  }
  cdpBase = null;
  return null;
}

async function connect(role) {
  const open = sockets.get(role);
  if (open && open.ws.readyState === WebSocket.OPEN) return open;

  const base = cdpBase ?? await findCdp();
  if (!base) throw new Error('Steam is not reachable: run it with debugging on (README, Steam debugging) and open Big Picture');
  const list = await (await fetch(`${base}/json`).catch(() => { cdpBase = null; throw new Error('Lost Steam; try again'); })).json();
  const target = list.find(TARGETS[role]);
  if (!target) throw new Error(`Steam target ${role} not found — is Big Picture open?`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const conn = { ws, id: 0, pending: new Map() };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`Could not connect to ${role}`));
  });
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    const p = conn.pending.get(msg.id);
    if (!p) return;
    conn.pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  };
  ws.onclose = () => {
    sockets.delete(role);
    for (const p of conn.pending.values()) p.reject(new Error(`${role} connection closed`));
  };
  sockets.set(role, conn);
  return conn;
}

async function evaluate(role, expression) {
  const conn = await connect(role);
  const id = ++conn.id;
  const result = await new Promise((resolve, reject) => {
    conn.pending.set(id, { resolve, reject });
    conn.ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

// ─── Catalog, profile, CSS ──────────────────────────────────────────────────

const steamBuild = () =>
  evaluate('SharedJSContext', 'SteamClient.System.GetSystemInfo().then(s => s.nSteamVersion)');

// The catalogue for a build: chroma's writable copy first (the trawl extends it), then the one
// shipped; else the newest shipped. `file` is where changes are written (always under DATA).
function loadCatalog(build) {
  const own = path.join(DATA, 'catalog', `${build}.json`);
  const shipped = path.join(ROOT, 'catalog', `${build}.json`);
  for (const f of [own, shipped]) if (fs.existsSync(f)) return { catalog: readJson(f), exact: true, file: own };
  const dir = path.join(ROOT, 'catalog');
  const newest = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().at(-1);
  if (!newest) throw new Error('No catalogue found in catalog/');
  return { catalog: readJson(path.join(dir, newest)), exact: false, file: path.join(DATA, 'catalog', newest) };
}

function loadProfile(build) {
  if (fs.existsSync(PROFILE_PATH)) return readJson(PROFILE_PATH);
  return { name: PROFILE, steamBuild: String(build), followMaster: true, edits: [] };
}

function saveProfile(profile) { saveProfileAt(PROFILE_PATH, profile); }
function saveProfileAt(file, profile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + '\n');
}

// A linked prop follows its master through a :root variable, so one edit moves every follower.
// With followMaster off, linked props ignore the master and use their own edits.
const varName = (part, prop) => `--chroma-${part}-${prop}`.replace(/[^\w-]/g, '_');

// A part's selector list with its pseudo on each member. A merged part can mix a ::before band
// with a plain element ("._a::before, ._b"); its pseudo then sits in the selector, not `pseudo`.
const members = sel => sel.split(',').map(s => s.trim());
const selOf = (p, base = p.selector) => members(base).map(s => s + (p.pseudo ?? '')).join(', ');

function buildCss(edits, catalog, followMaster = true) {
  const byPart = new Map(catalog.parts.map(p => [p.part, p]));
  const set = new Map(); // part -> { prop: value }, own edits only
  const skipped = [];
  for (const e of edits) {
    if (!byPart.has(e.part)) { skipped.push(e.part); continue; }
    const clean = Object.entries(e.set).filter(([prop, value]) => validProp(prop) && validValue(prop, value));
    if (clean.length) set.set(e.part, Object.fromEntries(clean));
  }

  // Masters: edited props that some other part links to.
  const masters = new Set();
  for (const p of followMaster ? catalog.parts : []) {
    for (const link of Object.values(p.links ?? {})) {
      if (set.get(link.to)?.[link.prop] !== undefined) masters.add(`${link.to}|${link.prop}`);
    }
  }

  const rules = [];
  const vars = [...masters].map(k => {
    const [part, prop] = k.split('|');
    return `  ${varName(part, prop)}: ${set.get(part)[prop]};`;
  });
  if (vars.length) rules.push(`:root {\n${vars.join('\n')}\n}`);

  for (const p of catalog.parts) {
    const own = set.get(p.part) ?? {};
    const decls = new Map(); // selector -> declarations; props can live on another of Steam's rules
    const emitted = new Set();
    for (const prop of Object.keys(p.props)) {
      const link = p.links?.[prop];
      let value;
      if (link && followMaster) {
        if (masters.has(`${link.to}|${link.prop}`)) {
          const v = `var(${varName(link.to, link.prop)})`;
          value = link.alpha < 1 ? `color-mix(in srgb, ${v} ${Math.round(link.alpha * 100)}%, transparent)` : v;
        }
      } else if (own[prop] !== undefined) {
        value = masters.has(`${p.part}|${prop}`) ? `var(${varName(p.part, prop)})` : own[prop];
      }
      if (value !== undefined) {
        const sel = selOf(p, p.propSelectors?.[prop] ?? p.selector);
        decls.set(sel, [...(decls.get(sel) ?? []), `  ${prop}: ${value} !important;`]);
        emitted.add(prop);
      }
    }
    for (const [sel, d] of decls) rules.push(`/* ${p.part} */\n${sel} {\n${d.join('\n')}\n}`);

    // Underlay: where Steam swaps a translucent part for a solid one (store pages' opaque header and
    // footer), paint another part's background under it, so the edit looks as it does elsewhere.
    // `plain` selectors get that background alone (the colour is drawn above them, e.g. a ::before
    // band); `layered` ones get the edit drawn over it.
    const u = p.underlay;
    const mine = u && own[u.prop];
    if (mine !== undefined) {
      const under = set.get(u.from)?.[u.prop] ?? byPart.get(u.from)?.props[u.prop];
      if (under !== undefined) {
        if (u.plain?.length) rules.push(`/* ${p.part} — underlay */\n${u.plain.join(',\n')} {\n  background: ${under} !important;\n}`);
        if (u.layered?.length) rules.push(`/* ${p.part} — underlay */\n${u.layered.join(',\n')} {\n  background: linear-gradient(${mine}, ${mine}), ${under} !important;\n}`);
      }
    }

    // States: an own edit covers every selector of the state. Without one, Steam's own value is
    // re-asserted per selector whenever the base prop is overridden — an !important base rule
    // would otherwise beat Steam's (non-important) state rules.
    for (const [state, st] of Object.entries(p.states ?? {})) {
      const shared = [];
      const per = new Map(); // selector -> decls
      for (const prop of Object.keys(st.props)) {
        const value = own[`${state}:${prop}`];
        if (value !== undefined) { shared.push(`  ${prop}: ${value} !important;`); continue; }
        if (!emitted.has(prop)) continue;
        for (const sel of st.selectors) {
          const dflt = st.defaults?.[sel]?.[prop];
          if (dflt !== undefined) per.set(sel, [...(per.get(sel) ?? []), `  ${prop}: ${dflt} !important;`]);
        }
      }
      for (const [sel, decls] of per) rules.push(`/* ${p.part} — ${state}, Steam default */\n${sel} {\n${decls.join('\n')}\n}`);
      if (shared.length) rules.push(`/* ${p.part} — ${state} */\n${st.selectors.join(',\n')} {\n${shared.join('\n')}\n}`);
    }
  }
  return { css: rules.join('\n\n') + '\n', skipped };
}

function validEdits(edits) {
  if (!Array.isArray(edits)) throw new Error('edits must be an array');
  return edits
    .filter(e => e && typeof e.part === 'string' && e.set && typeof e.set === 'object')
    .map(e => ({ part: e.part, set: Object.fromEntries(
      Object.entries(e.set).filter(([k, v]) => validProp(k) && validValue(k, v))) }))
    .filter(e => Object.keys(e.set).length);
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function state() {
  const build = await steamBuild();
  const { catalog, exact } = loadCatalog(build);
  // Counted in each part's own window; a window that isn't up counts nothing.
  const counts = catalog.parts.map(() => 0);
  await Promise.all(WINDOWS.map(async role => {
    const idx = catalog.parts.flatMap((p, i) => (p.window ?? 'BigPicture') === role ? [i] : []);
    if (!idx.length) return;
    const n = await evaluate(role, `(${JSON.stringify(idx.map(i => catalog.parts[i].selector))})
      .map(s => { try { return document.querySelectorAll(s).length; } catch { return 0; } })`).catch(() => null);
    n?.forEach((c, j) => { counts[idx[j]] = c; });
  }));
  return {
    build, exact, catalogBuild: catalog.steamBuild,
    parts: [...catalog.parts.map((p, i) => ({ ...p, onScreen: counts[i] })), ...paletteParts(loadProfile(build))],
    profile: loadProfile(build),
  };
}

// Put css in a <style id> in Big Picture, last in <head> so it wins over CSS Loader's styles.
function setStyle(id, css, role = 'BigPicture') {
  const hide = id === PREVIEW_ID && defaultsShown;
  return evaluate(role, `(() => {
    let el = document.getElementById(${JSON.stringify(id)});
    if (!el) {
      el = document.createElement('style');
      el.id = ${JSON.stringify(id)};
      if (${hide}) { el.media = 'not all'; el.dataset.chromaHidden = ''; }
    }
    el.textContent = ${JSON.stringify(css)};
    document.head.appendChild(el);
    return true;
  })()`);
}

// Defaults (header toggle): a look at Steam's own colours. chroma's preview and CSS Loader's themes
// get media="not all", which survives preview updates; only styles marked here are restored.
let defaultsShown = false;
async function showDefaults(on) {
  defaultsShown = !!on;
  await eachWindow(role => evaluate(role, `(() => {
    if (${defaultsShown}) {
      for (const el of document.querySelectorAll('#${PREVIEW_ID}, style.css-loader-style')) {
        if (el.media || 'chromaHidden' in el.dataset) continue;
        el.media = 'not all';
        el.dataset.chromaHidden = '';
      }
    } else {
      for (const el of document.querySelectorAll('style[data-chroma-hidden]')) {
        el.removeAttribute('media');
        delete el.dataset.chromaHidden;
      }
    }
  })()`));
  return { ok: true, on: defaultsShown };
}

// Outline a part's elements in Steam while its row is pointed at in the editor.
// The glass layer Steam shows behind its side menus (Background glass in the catalog).
const GLASS = 'fjbDEq55_BackgroundGlass.fjbDEq55_DrawBackground';
const menuStore = 'SteamUIStore.WindowStore.GamepadUIMainWindowInstance.MenuStore';
const MENU_IDS = { MainMenu: 1, QuickAccess: 2 }; // MenuStore's side-menu ids
let menuOpened = null; // the side menu locate opened ('MainMenu' | 'QuickAccess'), which it closes again
const openMenu = async () => {
  const id = await evaluate('SharedJSContext', `${menuStore}.m_eOpenSideMenu`);
  return Object.keys(MENU_IDS).find(k => MENU_IDS[k] === id) ?? null;
};

// Header Line: Steam draws it only while the home tabs (What's New, Friends…) have focus, a flag
// in the home page's router state. Locate sets the flag (going home first if needed), which also
// scrolls to the tabs; leaving scrolls back, clears it, and returns to where Steam was.
const EDGE = 'QcGXoqZ7_HeaderTopEdge';
const mainHistory = 'SteamUIStore.WindowStore.GamepadUIMainWindowInstance.m_history';
let edgeShown = null; // null, or { navigated } when locate raised the line
async function showEdge(want, selector) {
  if (want === !!edgeShown) return;
  if (want) {
    // Home focuses its top row as it mounts, which clears the flag: set it until it holds.
    const navigated = await evaluate('SharedJSContext', `(async () => {
      const h = ${mainHistory}, home = '/library/home';
      const navigated = h.location.pathname !== home;
      if (navigated) h.push(home);
      for (let i = 0, held = 0; i < 16 && held < 3; i++) {
        if (h.location.pathname !== home) break;
        if (h.location.state?.HomeTabsActive_HistoryValue) held++;
        else { held = 0; h.replace(home, { ...h.location.state, HomeTabsActive_HistoryValue: true }); }
        await new Promise(r => setTimeout(r, 150));
      }
      return navigated;
    })()`);
    edgeShown = { navigated: navigated === true };
    return;
  }
  await evaluate('BigPicture', `(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    const sc = e && [...e.parentElement.querySelectorAll('*')].find(x => x.scrollTop > 0);
    sc?.scrollTo({ top: 0, behavior: 'smooth' });
  })()`);
  await evaluate('SharedJSContext', `(() => {
    const h = ${mainHistory};
    if (${edgeShown.navigated}) return h.goBack();
    h.replace(h.location.pathname, { ...h.location.state, HomeTabsActive_HistoryValue: false });
  })()`);
  edgeShown = null;
}

// Show a row's subject in Steam. A state row ("highlight:background") puts that state's colours
// on the element; the glass row opens the main menu, which brings up the glass; Header Line is
// brought up (showEdge); any other row outlines the element.
async function locate(part, key = null) {
  const build = await steamBuild();
  const { catalog } = loadCatalog(build);
  const p = part ? lastTrawl?.items.find(i => i.id === part)?.part ?? catalog.parts.find(x => x.part === part) : null;
  // A Ctrl+1 / Ctrl+2 part is shown by opening its menu (left open if it already was).
  const win = p?.window ?? 'BigPicture';
  const wantMenu = p?.part === GLASS ? 'MainMenu' : MENU_IDS[win] ? win : null;
  if (wantMenu !== menuOpened) {
    if (wantMenu && await openMenu() !== wantMenu) {
      await evaluate('SharedJSContext', `${menuStore}.OpenSideMenu(${MENU_IDS[wantMenu]})`);
      menuOpened = wantMenu;
    } else if (!wantMenu && menuOpened) {
      if (await openMenu() === menuOpened) await evaluate('SharedJSContext', `${menuStore}.CloseSideMenus()`);
      menuOpened = null;
    }
  }
  const edge = catalog.parts.find(x => x.part === EDGE);
  if (edge) await showEdge(p?.part === EDGE, edge.selector);
  let css = '';
  const [state] = typeof key === 'string' && key.includes(':') ? key.split(':') : [];
  const st = state && p?.states?.[state];
  if (st) {
    const own = loadProfile(build).edits.find(e => e.part === part)?.set ?? {};
    const decls = Object.entries(st.props)
      .map(([pr, dflt]) => [pr, own[`${state}:${pr}`] ?? dflt])
      .filter(([pr, v]) => validValue(pr, v))
      .map(([pr, v]) => `  ${pr}: ${v} !important;`);
    // :not(#…) adds id weight, so this wins over the preview's !important rules for the same element.
    // Pseudo-elements can't sit inside :is(), so each member keeps its ::before outside.
    const weighted = members(selOf(p)).map(m => m.match(/^(.*?)((?:::?(?:before|after))?)$/))
      .map(([, base, pseudo]) => `:is(${base}):not(#chroma-none)${pseudo}`).join(', ');
    if (decls.length) css = `${weighted} {\n${decls.join('\n')}\n}`;
  } else if (p && p.part !== GLASS) {
    css = `${selOf(p)} { outline: 3px solid #ff2bd6 !important; outline-offset: -3px !important; }`;
  }
  await eachWindow(role => setStyle(LOCATE_ID, css && role === win ? `@layer chroma-locate {\n${css}\n}` : '', role));
  return { ok: true };
}

// ─── Palette ────────────────────────────────────────────────────────────────
// The theme beyond cataloged parts: a Steam colour -> your colour, applied to every Steam rule that
// uses that exact colour, on every page and in the side menus. The colours are the profile's
// `palette` ([{ kind: 'bg' | 'fg', steam, name }]); the values are ordinary edits on virtual parts
// "palette:<kind>:<steam>", so the editor shows them as rows. bg covers background-color and
// gradients in background-image; fg covers color and fill.
const paletteId = e => `palette:${e.kind}:${e.steam}`;
const paletteParts = profile => (profile.palette ?? []).map((e, order) => ({
  part: paletteId(e), label: e.name, palette: e.kind, order, window: 'BigPicture', selector: '',
  props: { [e.kind === 'bg' ? 'background' : 'color']: e.steam },
}));

// Steam's colour rules, snapshotted so the palette (and export) works without Steam running.
// Taken in each theme window from Steam's own stylesheets (chroma's and CSS Loader's skipped);
// colours normalised to rgb(). Entries: { c: [@media / @supports…], s: selector, d: [[prop, value]] }
// for rules whose colour props hold a colour, and { c, k: name, f: [[keyText, [[prop, value]…]]] }
// for @keyframes that animate one (all their declarations, to redefine them whole). Merged as
// Steam loads more pages' CSS; shipped per build in catalog/<build>.rules.json.
const SNAPSHOT_JS = `(() => {
  const probe = document.createElement('i');
  document.body.appendChild(probe);
  const norm = v => { probe.style.color = ''; probe.style.color = v; return probe.style.color ? getComputedStyle(probe).color : null; };
  const TOK = /rgba?\\([^)]*\\)|#[0-9a-fA-F]{3,8}\\b/g;
  const COLOURISH = new Set(['background-color', 'background-image', 'box-shadow', 'color', 'fill']);
  const counts = p => COLOURISH.has(p) || p.startsWith('--');
  const clean = v => v.replace(TOK, t => t.startsWith('rgb') ? t : norm(t) || t);
  const out = [];
  const visit = (rule, c) => {
    const type = rule.constructor.name;
    if (type === 'CSSKeyframesRule') {
      const f = [...rule.cssRules].map(fr => [fr.keyText, [...fr.style].map(p => [p, clean(fr.style.getPropertyValue(p))])]);
      if (f.some(([, d]) => d.some(([p, v]) => counts(p) && /rgb/.test(v)))) out.push({ c, k: rule.name, f });
      return;
    }
    if (rule.cssRules && !rule.selectorText) {
      const w = type === 'CSSMediaRule' ? '@media ' + rule.media.mediaText : type === 'CSSSupportsRule' ? '@supports ' + rule.conditionText : null;
      if (w) for (const r of rule.cssRules) visit(r, [...c, w]);
      return;
    }
    if (!rule.style || !rule.selectorText) return;
    const d = [];
    for (const p of rule.style) {
      if (!counts(p)) continue;
      const v = clean(rule.style.getPropertyValue(p));
      if (/rgb/.test(v)) d.push([p, v]);
    }
    if (d.length) out.push({ c, s: rule.selectorText, d });
  };
  for (const sh of document.styleSheets) {
    const node = sh.ownerNode;
    if (node && (/^chroma-/.test(node.id) || node.classList?.contains('css-loader-style'))) continue;
    let rules;
    try { rules = sh.cssRules; } catch { continue; }
    for (const r of rules) visit(r, []);
  }
  probe.remove();
  return out;
})()`;
// A window's stylesheets change when Steam loads another page's CSS: snapshot again only then.
const SHEETS_SIG_JS = `[...document.styleSheets].filter(s => !/^chroma-/.test(s.ownerNode?.id ?? ''))
  .map(s => { try { return s.cssRules.length; } catch { return -1; } }).join(',')`;

const rulesFile = (dir, build) => path.join(dir, 'catalog', `${build}.rules.json`);
const snapshots = new Map(); // build -> { entries: Map(key -> entry), sigs: { role: sig } }
const entryKey = e => JSON.stringify([e.c, e.s ?? '@' + e.k, e.d ?? e.f]);

function loadSnapshot(build) {
  if (!snapshots.has(build)) {
    const f = [rulesFile(DATA, build), rulesFile(ROOT, build)].find(x => fs.existsSync(x));
    const list = f ? readJson(f) : [];
    snapshots.set(build, { entries: new Map(list.map(e => [entryKey(e), e])), sigs: {} });
  }
  return snapshots.get(build);
}

// Fold in whatever Steam has loaded since the last look (only when Steam is reachable).
async function refreshSnapshot(build) {
  const snap = loadSnapshot(build);
  let added = 0;
  await eachWindow(async role => {
    const sig = await evaluate(role, SHEETS_SIG_JS);
    if (snap.sigs[role] === sig) return;
    for (const e of await evaluate(role, SNAPSHOT_JS)) {
      const k = entryKey(e);
      if (!snap.entries.has(k)) { snap.entries.set(k, e); added++; }
    }
    snap.sigs[role] = sig;
  });
  if (added) {
    const f = rulesFile(DATA, build);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify([...snap.entries.values()]) + '\n');
    paletteCache.clear();
  }
  return snap;
}

// The palette's rules from the snapshot. `map` is { bg: { steam: mine }, fg: { … } }. Reaches:
// - plain rules: background-color / background-image (gradient stops one by one) / box-shadow
//   (Ctrl+2's title glow) for bg, color / fill for fg; @media / @supports kept around them;
// - colour custom properties (Steam's --background-color: #23262E …); names that say text /
//   color / fg count as fg, the rest as bg;
// - @keyframes that animate a colour (a tab's selected state holds its last frame), redefined;
// - near shades: a colour within NEAR of an opaque palette colour moves by the same offset, and
//   its own alpha is kept (Steam's fades, hover steps). Pure black is never near anything.
const NEAR = 20;
const fmtRgb = ([r, g, b, a]) => a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
const PALETTE_BG = new Set(['background-color', 'background-image', 'box-shadow']), PALETTE_FG = new Set(['color', 'fill']);
const paletteKind = prop => PALETTE_BG.has(prop) ? 'bg' : PALETTE_FG.has(prop) ? 'fg'
  : prop.startsWith('--') ? (/text|color|colour|fg|foreground/i.test(prop) && !/bg|background/i.test(prop) ? 'fg' : 'bg') : null;

function paletteRules(entries, map) {
  const keys = {};
  for (const kind of ['bg', 'fg']) {
    keys[kind] = Object.entries(map[kind] || {}).map(([steam, mine]) => ({ steam, k: parseColour(steam), m: parseColour(mine) }));
  }
  const mapToken = (tok, kind) => {
    const exact = keys[kind].find(x => x.steam === tok);
    if (exact) return fmtRgb(exact.m);
    const t = parseColour(tok);
    if (!t) return null; // rgba(var(--x), …) and the like
    let best = null, bestD = NEAR + 1;
    for (const x of keys[kind]) {
      if (x.k[3] < 1) continue; // translucent palette colours match exactly only
      const d = Math.max(Math.abs(t[0] - x.k[0]), Math.abs(t[1] - x.k[1]), Math.abs(t[2] - x.k[2]));
      if (d < bestD) { best = x; bestD = d; }
    }
    if (!best) return null;
    const c = i => Math.max(0, Math.min(255, Math.round(best.m[i] + t[i] - best.k[i])));
    return fmtRgb([c(0), c(1), c(2), t[3] * best.m[3]]);
  };
  const swap = (value, kind) => {
    let hit = false;
    const out = value.replace(/rgba?\([^)]*\)/g, tok => { const m = mapToken(tok, kind); if (m) { hit = true; return m; } return tok; });
    return hit ? out : null;
  };
  const wrap = (rule, conds) => [...conds].reverse().reduce((r, c) => `${c} { ${r} }`, rule);
  const out = [];
  for (const e of entries) {
    if (e.k) {
      let hit = false;
      const frames = e.f.map(([keyText, decls]) => `${keyText} { ${decls.map(([p, v]) => {
        const k = paletteKind(p), sw = k && swap(v, k);
        if (sw) hit = true;
        return `${p}: ${sw || v}`;
      }).join('; ')} }`);
      if (hit) out.push(wrap(`@keyframes ${e.k} { ${frames.join(' ')} }`, e.c));
      continue;
    }
    const decls = e.d.flatMap(([p, v]) => { const k = paletteKind(p), sw = k && swap(v, k); return sw ? [`${p}: ${sw} !important`] : []; });
    if (decls.length) out.push(wrap(`${e.s} { ${decls.join('; ')}; }`, e.c));
  }
  return out;
}

const paletteCache = new Map(); // build + map -> css

// The palette's CSS: from the snapshot, refreshed first when Steam is reachable.
async function paletteCss(profile, edits, build, live = true) {
  const map = { bg: {}, fg: {} };
  let n = 0;
  for (const e of profile.palette ?? []) {
    const own = edits.find(x => x.part === paletteId(e))?.set;
    const v = own && Object.values(own)[0];
    if (v && validValue('background', v) && /^(#|rgb)/i.test(v) && v !== e.steam) { map[e.kind][e.steam] = v; n++; }
  }
  if (!n) return '';
  const snap = live ? await refreshSnapshot(build) : loadSnapshot(build);
  const key = `${build} ${JSON.stringify(map)}`;
  if (!paletteCache.has(key)) {
    if (paletteCache.size > 20) paletteCache.clear();
    const rules = paletteRules(snap.entries.values(), map);
    paletteCache.set(key, `/* chroma palette: ${n} colours, ${rules.length} rules */\n${rules.join('\n')}\n`);
  }
  return paletteCache.get(key);
}

// The whole theme. Cascade layers order the !important rules: locate (its own layer, declared
// first) beats the parts, the parts beat the palette (unlayered), and all beat Steam's own.
// `live`: Steam is up, so the snapshot is refreshed first; export runs without it.
async function composeCss(catalog, profile, edits, follow, build, live = true) {
  const paletteIds = new Set((profile.palette ?? []).map(paletteId));
  const partEdits = edits.filter(e => !paletteIds.has(e.part));
  const { css, skipped } = buildCss(partEdits, catalog, follow);
  const palette = await paletteCss(profile, edits, String(build), live);
  return { css: `@layer chroma-locate, chroma-parts;\n\n${palette}\n@layer chroma-parts {\n${css}}\n`, skipped };
}

async function preview(edits, followMaster, pageHasPalette = false) {
  const build = await steamBuild();
  const { catalog } = loadCatalog(build);
  let clean = validEdits(edits);
  const profile = loadProfile(build);
  // An editor page from before the palette doesn't send its rows; keep the saved ones then.
  if (!pageHasPalette) {
    const ids = new Set(paletteParts(profile).map(p => p.part));
    clean = [...clean.filter(e => !ids.has(e.part)), ...profile.edits.filter(e => ids.has(e.part))];
  }
  const follow = typeof followMaster === 'boolean' ? followMaster : profile.followMaster !== false;
  // Trawl Data parts preview like catalog parts, but their edits aren't saved until accepted.
  const pending = lastTrawl?.build === build ? lastTrawl.items.map(i => i.part) : [];
  const pendingIds = new Set(pending.map(p => p.part));
  const view = { ...catalog, parts: [...catalog.parts.filter(p => !pendingIds.has(p.part)), ...pending] };
  const { css, skipped } = await composeCss(view, profile, clean, follow, build);
  await eachWindow(role => setStyle(PREVIEW_ID, css, role));
  const saved = new Set([...catalog.parts, ...paletteParts(profile)].map(p => p.part));
  saveProfile({ ...profile, steamBuild: String(build), followMaster: follow, edits: clean.filter(e => saved.has(e.part)) });
  return { ok: true, skipped };
}

// Bin: move a part out of the catalog's rows into `removed`, drop its edits, re-preview.
async function removePart(part) {
  const build = await steamBuild();
  const { catalog, file } = loadCatalog(build);
  const i = catalog.parts.findIndex(p => p.part === part);
  if (i < 0) throw new Error(`No part ${part} in the catalogue`);
  const [entry] = catalog.parts.splice(i, 1);
  catalog.removed = [...(catalog.removed ?? []), entry];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
  const edits = loadProfile(build).edits.filter(e => e.part !== part);
  await preview(edits);
  return { ok: true };
}

// ─── Trawl ──────────────────────────────────────────────────────────────────
// Add every rule that sets text or background colour on something visible in the current
// screen to the catalog, keyed by steamui-watch names. Skips binned and known parts.

const STABLE_URL = 'https://beallio.github.io/steamui-watch/stable.json';
const STABLE_CACHE = path.join(DATA, 'cache', 'steamui-watch-stable.json');
const STABLE_MAX_AGE_MS = 6 * 3600e3; // steamui-watch publishes every 6h
const MASTER = { to: 'J5rxTYCm_BasicHome', prop: 'color' };
const PAGE_COVER = 0.5; // a part whose element covers half the screen is the page, not a block
let classMapCache = null;

async function classMap() {
  const stale = !fs.existsSync(STABLE_CACHE) ||
    Date.now() - fs.statSync(STABLE_CACHE).mtimeMs > STABLE_MAX_AGE_MS;
  if (stale) {
    try {
      const res = await fetch(STABLE_URL, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      JSON.parse(text);
      fs.mkdirSync(path.dirname(STABLE_CACHE), { recursive: true });
      fs.writeFileSync(STABLE_CACHE, text);
      classMapCache = null;
    } catch (e) {
      if (!fs.existsSync(STABLE_CACHE)) throw new Error(`Could not fetch steamui-watch map: ${e.message}`);
    }
  }
  if (!classMapCache) {
    const map = readJson(STABLE_CACHE);
    const keyOf = new Map();
    const readable = new Map();
    for (const [key, variants] of Object.entries(map)) {
      for (const v of variants) if (!keyOf.has(v)) keyOf.set(v, key);
      // The readable alias is the variant that also appears with a trailing underscore.
      readable.set(key, variants.find(v => variants.includes(`${v}_`)) ?? key);
    }
    // A key's prefix names its module ("header_Clock" -> "header"). Keys without a readable
    // alias borrow it from another key with the same hashed prefix.
    const moduleOf = new Map();
    for (const [key, name] of readable) {
      if (name !== key) moduleOf.set(key.split('_')[0], name.split('_')[0]);
    }
    const areaOf = keys => keys.map(k => moduleOf.get(k.split('_')[0])).find(Boolean) ?? keys[0]?.split('_')[0];
    classMapCache = { keyOf, readable, areaOf };
  }
  return classMapCache;
}

const TRAWL_JS = `(() => {
  // Measure Steam's own colours: switch off chroma's preview and CSS Loader's themes meanwhile.
  const off = [...document.querySelectorAll(${JSON.stringify(`#${PREVIEW_ID}, #${LOCATE_ID}, style.css-loader-style`)})]
    .map(el => el.sheet).filter(sh => sh && !sh.disabled);
  off.forEach(sh => { sh.disabled = true; });
  try {
    // On screen with a box. visibility: hidden still counts: Steam hides some parts until their
    // container is hovered (the like / comment bar on activity posts), and they keep their box.
    const visible = el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
        r.top < innerHeight && r.left < innerWidth;
    };
    // Hover/focus/active parts of a selector; removing them gives the element the state styles.
    const STATE_RE = /(:hover|:focus-visible|:focus-within|:focus|:active|\\.gpfocuswithin|\\.gpfocus)(?![\\w-])/g;
    // A state rule's declared value, resolved (var() etc.) in the context of a real element.
    const resolve = (el, prop, declared) => {
      if (!declared) return null;
      const probe = document.createElement('span');
      probe.style.setProperty(prop, declared);
      if (!probe.style.getPropertyValue(prop)) return null;
      el.appendChild(probe);
      const v = getComputedStyle(probe).getPropertyValue(prop);
      probe.remove();
      return v;
    };
    // Name from the element's own text; a container's nested text (the battery % in the header
    // for the whole home screen) says nothing about it.
    const ownText = el => {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
      if (own) return own;
      return el.querySelectorAll('*').length <= 3 ? (el.innerText || '').trim() : '';
    };
    // Identity of the set of elements a selector hits, to group rules that style the same thing.
    const ids = new WeakMap();
    let nextId = 0;
    const idOf = el => { if (!ids.has(el)) ids.set(el, ++nextId); return ids.get(el); };
    // Largest element's share of the screen; the page's own backgrounds cover all of it.
    const coverOf = els => Math.max(...els.map(el => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    })) / (innerWidth * innerHeight);
    const found = new Map();
    const visit = rule => {
      if (rule.cssRules) for (const r of rule.cssRules) visit(r);
      if (!rule.style || !rule.selectorText) return;
      const st = rule.style;
      const setsColor = !!st.getPropertyValue('color');
      const setsBg = !!(st.getPropertyValue('background-color') || st.getPropertyValue('background-image'));
      // SVG icons: a CSS fill beats the path's fill="currentColor", so color alone doesn't move them.
      const setsFill = !!st.getPropertyValue('fill');
      if (!setsColor && !setsBg && !setsFill) return;
      for (const piece of rule.selectorText.split(',').map(s => s.trim())) {
        // A ::before / ::after is its own part (e.g. the tab bar's band); other pseudo-elements aren't.
        const pm = /::?(before|after)$/.exec(piece);
        const pseudo = pm ? '::' + pm[1] : '';
        const plain = pm ? piece.slice(0, pm.index) : piece;
        if (!plain.includes('.') || plain.includes('::')) continue;
        const tokens = plain.match(STATE_RE);
        const base = tokens ? plain.replace(STATE_RE, '').replace(/:not\\(\\s*\\)/g, '').trim() : plain;
        if (!base.includes('.') || /[\\s>+~]$/.test(base)) continue;
        let els;
        try { els = [...document.querySelectorAll(base)].filter(visible); } catch { continue; }
        if (!els.length) continue;
        if (pseudo && getComputedStyle(els[0], pseudo).content === 'none') continue; // not drawn
        const e = found.get(base + pseudo) ?? { selector: base, pseudo, props: {}, states: {}, count: els.length,
          key: els.map(idOf).sort((a, b) => a - b).join(',') + pseudo, cover: coverOf(els),
          sample: ownText(els[0]).split('\\n')[0].slice(0, 40) };
        if (!tokens) {
          const cs = getComputedStyle(els[0], pseudo || null);
          if (setsColor && !cs.color.endsWith(', 0)')) e.props.color = cs.color;
          if (setsBg) {
            const bg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor
              : /gradient/.test(cs.backgroundImage) ? cs.backgroundImage : null;
            if (bg) e.props.background = bg;
          }
          if (setsFill && /^rgba?\\(/.test(cs.fill) && !cs.fill.endsWith(', 0)')) e.props.fill = cs.fill;
        } else {
          // Every hover/focus flavour is one "highlight" state; :active is "pressed".
          // Steam's value is kept per selector: hover and controller focus often differ.
          const s = (e.states[tokens.includes(':active') ? 'pressed' : 'highlight'] ??= { selectors: [], defaults: {} });
          if (!s.selectors.includes(piece)) s.selectors.push(piece);
          const d = (s.defaults[piece] ??= {});
          if (setsColor) {
            const v = resolve(els[0], 'color', st.getPropertyValue('color'));
            if (v && !v.endsWith(', 0)')) d.color = v;
          }
          if (setsBg) {
            const c = resolve(els[0], 'background-color', st.getPropertyValue('background-color'));
            const i = resolve(els[0], 'background-image', st.getPropertyValue('background-image'));
            const bg = c && c !== 'rgba(0, 0, 0, 0)' ? c : i && /gradient/.test(i) ? i : null;
            if (bg) d.background = bg;
          }
          if (setsFill) {
            const v = resolve(els[0], 'fill', st.getPropertyValue('fill'));
            if (v && /^rgba?\\(/.test(v) && !v.endsWith(', 0)')) d.fill = v;
          }
        }
        if (Object.keys(e.props).length || Object.keys(e.states).length) found.set(base + pseudo, e);
      }
    };
    for (const sheet of document.styleSheets) {
      if (sheet.disabled) continue;
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) visit(r);
    }
    // One entry per element set. The broadest selector names it; a prop first set by another
    // rule keeps that rule's selector, so it still only applies where Steam applies it.
    const classes = sel => (sel.match(/\\.[_a-zA-Z][\\w-]*/g) || []).length;
    const groups = new Map();
    for (const e of found.values()) {
      if (!groups.has(e.key)) groups.set(e.key, []);
      groups.get(e.key).push(e);
    }
    return [...groups.values()].map(g => {
      g.sort((a, b) => classes(a.selector) - classes(b.selector) || a.selector.length - b.selector.length);
      const main = { selector: g[0].selector, pseudo: g[0].pseudo, members: g.map(e => e.selector), props: {}, propSelectors: {},
        states: {}, count: g[0].count, cover: g[0].cover, sample: g.map(e => e.sample).find(Boolean) || '' };
      for (const e of g) {
        for (const [prop, v] of Object.entries(e.props)) {
          if (main.props[prop] !== undefined) continue;
          main.props[prop] = v;
          if (e.selector !== main.selector) main.propSelectors[prop] = e.selector;
        }
        for (const [name, st] of Object.entries(e.states)) {
          const into = (main.states[name] ??= { selectors: [], defaults: {} });
          for (const sel of st.selectors) {
            if (into.selectors.includes(sel)) continue;
            into.selectors.push(sel);
            into.defaults[sel] = st.defaults[sel];
          }
        }
      }
      return main;
    });
  } finally {
    off.forEach(sh => { sh.disabled = false; });
  }
})()`;

// "rgb(139, 146, 154)" -> grey level, or null unless it is opaque, grey, and light enough to be
// text on Steam's dark UI (dark text sits on light chips and keycaps and must not follow).
function greyLevel(value) {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(value);
  if (!m) return null;
  const c = m.slice(1).map(Number);
  const level = (c[0] + c[1] + c[2]) / 3;
  return Math.max(...c) - Math.min(...c) <= 24 && level >= 96 ? level : null;
}

const words = name => name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

// What the last trawl found, held until its results are accepted into the catalog (or replaced
// by the next trawl). Not written anywhere: the editor shows it as "Trawl Data".
let lastTrawl = null; // { build, found, items }

const keysOf = p => [...Object.keys(p.props ?? {}),
  ...Object.entries(p.states ?? {}).flatMap(([s, st]) => Object.keys(st.props ?? {}).map(k => `${s}:${k}`))];

// A new part's subheading in the editor, from where it was found. Home's own subheadings (Tabs,
// Friends…) are sorted by hand, so home parts start under Other.
const ROUTE_GROUPS = [[/^\/library\/app\//, 'Game Page'], [/^\/settings/, 'Settings'], [/^\/media/, 'Media'],
  [/^\/library\/(downloads|collection|all|favorites|installed)/, 'Library']];
const groupFor = (role, route) => role === 'MainMenu' ? 'Main Menu' : role === 'QuickAccess' ? 'Quick Access'
  : ROUTE_GROUPS.find(([re]) => re.test(route ?? ''))?.[1];

// Scan the current screen. Nothing is saved: the result is a list of parts that would be added,
// or known parts that would gain rows, for the editor to show until accepted.
async function trawl() {
  const build = await steamBuild();
  // Big Picture, and Ctrl+1 / Ctrl+2 when open (a closed menu's window keeps stale layout).
  const roles = ['BigPicture', ...[await openMenu()].filter(Boolean)];
  const route = await evaluate('SharedJSContext', `${mainHistory}.location.pathname`).catch(() => '');
  const found = (await Promise.all(roles.map(async role =>
    (await evaluate(role, TRAWL_JS)).map(f => ({ ...f, window: role, group: groupFor(role, route) }))))).flat();
  const { catalog } = loadCatalog(build);
  const { items, unresolved } = await absorb(structuredClone(catalog), found);
  lastTrawl = { build, found, items };
  return { ok: true, found: found.length, unresolved, items };
}

// Write the chosen trawl results (part ids) into the catalog.
async function accept(ids) {
  const build = await steamBuild();
  if (!lastTrawl || lastTrawl.build !== build) throw new Error('Nothing trawled on this Steam build; trawl again');
  const { catalog: current, exact } = loadCatalog(build);
  const dir = path.join(DATA, 'catalog');
  const file = path.join(dir, `${build}.json`);
  const catalog = exact ? current
    : { steamBuild: build, branch: 'stable', cataloged: new Date().toISOString().slice(0, 10), notes: [], parts: [] };
  const { items } = await absorb(catalog, lastTrawl.found, new Set(ids));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
  lastTrawl.items = lastTrawl.items.filter(i => !items.some(a => a.id === i.id));
  return { ok: true, accepted: items.length };
}

// Fold trawled entries into a catalog, in place. Returns one item per part added or given new
// rows: { id, kind: 'added' | 'updated', part, keys }. `only` limits it to those part ids.
async function absorb(catalog, found, only = null) {
  const { keyOf, readable, areaOf } = await classMap();
  catalog.removed ??= [];

  const idsOf = p => [p.part, ...(p.aliases ?? [])];
  const binned = new Set(catalog.removed.flatMap(idsOf));
  const byId = new Map(catalog.parts.flatMap(p => idsOf(p).map(id => [id, p])));
  const master = catalog.parts.find(p => p.part === MASTER.to);
  const masterGrey = master && greyLevel(master.props[MASTER.prop]);

  // Selector -> steamui-watch part id, or null when it has a hashed class steamui-watch lacks.
  const resolveSelector = selector => {
    let resolved = 0;
    let missing = false;
    const nameWords = [];
    const keys = [];
    const id = selector.replace(/\.([_a-zA-Z][\w-]*)/g, (all, cls) => {
      const key = keyOf.get(cls);
      if (key) {
        resolved++;
        keys.push(key);
        nameWords.push(words(key.split('_').slice(1).join(' ')));
        return `.${key}`;
      }
      if (/^_?[\w-]*\d[\w-]*$/.test(cls) && cls.length > 10) missing = true; // looks hashed
      else nameWords.push(words(cls)); // Steam's plain state classes: gpfocus, Selected, …
      return all;
    }).replace(/(^|[\s>+~])\./g, '$1');
    return resolved && !missing ? { id, keys, nameWords } : null;
  };

  const items = [];
  let unresolved = 0;
  for (const f of found) {
    const states = Object.fromEntries(Object.entries(f.states ?? {})
      .map(([name, st]) => [name, withProps(structuredClone(st))])
      .filter(([, st]) => Object.keys(st.props).length));
    const members = f.members.map(sel => ({ sel, r: resolveSelector(sel) })).filter(m => m.r);
    if (!members.length) { unresolved++; continue; }
    const ids = members.map(m => m.r.id + (f.pseudo ?? ''));
    if (ids.some(id => binned.has(id))) continue;

    // Already cataloged under any of its selectors: fill in what that part lacks.
    const existing = ids.map(id => byId.get(id)).find(Boolean);
    if (existing) {
      if (only && !only.has(existing.part)) continue;
      const before = new Set(keysOf(existing));
      mergeStates(existing, states);
      existing.area ??= areaOf(members[0].r.keys);
      if (f.cover >= PAGE_COVER) existing.page ??= true;
      for (const [prop, v] of Object.entries(f.props)) {
        if (existing.props[prop] !== undefined || existing.dropped?.includes(prop)) continue; // dropped by hand
        existing.props[prop] = v;
        const sel = f.propSelectors[prop] ?? f.selector;
        if (sel !== existing.selector) (existing.propSelectors ??= {})[prop] = sel;
      }
      const aliases = ids.filter(id => !idsOf(existing).includes(id));
      if (aliases.length) existing.aliases = [...(existing.aliases ?? []), ...aliases];
      for (const id of aliases) byId.set(id, existing);
      const keys = keysOf(existing).filter(k => !before.has(k));
      if (keys.length) items.push({ id: existing.part, kind: 'updated', part: existing, keys });
      continue;
    }
    if (!Object.keys(f.props).length && !Object.keys(states).length) continue;

    const { sel, r } = members[0];
    if (only && !only.has(ids[0])) continue;
    // A selector ending in a tag (an icon's svg or path) says so, so an icon's two rows differ.
    const tag = /(?:^|[\s>+~])([a-z][a-z0-9]*)$/.exec(sel)?.[1];
    const name = [...new Set([...r.nameWords, ...(tag ? [tag] : []), ...(f.pseudo ? [f.pseudo.slice(2)] : [])])].join(', ');
    const part = {
      part: ids[0],
      label: f.sample ? `${name} — “${f.sample}”` : name,
      readable: r.keys.map(k => readable.get(k)).join(' '),
      area: areaOf(r.keys),
      window: f.window ?? 'BigPicture',
      ...(f.group ? { group: f.group } : {}),
      selector: sel,
      props: { ...f.props },
      trawled: new Date().toISOString().slice(0, 10),
    };
    if (f.pseudo) part.pseudo = f.pseudo; // styles go on selector + pseudo; state selectors carry it already
    if (f.cover >= PAGE_COVER) part.page = true;
    const propSelectors = Object.fromEntries(Object.entries(f.propSelectors).filter(([, ps]) => ps !== sel));
    if (Object.keys(propSelectors).length) part.propSelectors = propSelectors;
    if (ids.length > 1) part.aliases = ids.slice(1);
    if (Object.keys(states).length) part.states = states;
    // Grey text follows the master text colour, scaled to keep Steam's light/dim hierarchy.
    const grey = f.props.color && greyLevel(f.props.color);
    if (master && grey && masterGrey) {
      const alpha = Math.min(1, Math.max(0.3, Math.round(grey / masterGrey * 100) / 100));
      part.links = { color: { ...MASTER, alpha } };
    }
    catalog.parts.push(part);
    for (const id of ids) byId.set(id, part);
    items.push({ id: part.part, kind: 'added', part, keys: keysOf(part) });
  }
  return { items, unresolved };
}

// A state's shown defaults: controller focus (.gpfocus) first — it's what Big Picture shows —
// then the other selectors for props it doesn't set.
function withProps(st) {
  const order = [...st.selectors].sort((a, b) =>
    Number(/\.gpfocus(?![\w-])/.test(b)) - Number(/\.gpfocus(?![\w-])/.test(a)));
  const props = {};
  for (const sel of order) {
    for (const [prop, v] of Object.entries(st.defaults[sel] ?? {})) props[prop] ??= v;
  }
  return { ...st, props };
}

// Add state selectors a part doesn't have yet; returns how many state props were added.
function mergeStates(part, states) {
  let n = 0;
  for (const [state, st] of Object.entries(states)) {
    if (part.fused?.includes(state)) continue; // folded into the normal row by hand; don't bring it back
    const into = ((part.states ??= {})[state] ??= { selectors: [], defaults: {}, props: {} });
    const before = Object.keys(into.props).length;
    for (const sel of st.selectors) {
      if (into.selectors.includes(sel)) continue;
      into.selectors.push(sel);
      into.defaults[sel] = st.defaults[sel];
    }
    Object.assign(into, withProps(into));
    n += Object.keys(into.props).length - before;
  }
  return n;
}

// Export: a profile as a CSS Loader theme, `chroma-<name>/` holding theme.json and shared.css.
// Written into this machine's CSS Loader themes folder (when ~/homebrew exists) and zipped into
// ~/Downloads, to send to another machine (extract into ~/homebrew/themes there). Never switched
// on: which themes run is CSS Loader's business (user, 2026-11-21).
const themeId = name => `chroma-${name.trim().toLowerCase().replace(/[^\w-]+/g, '-')}`;

async function exportTheme(profile) {
  // Steam isn't needed: without it the build is the profile's, and the palette comes from the
  // stored snapshot.
  const liveBuild = await steamBuild().catch(() => null);
  const build = String(liveBuild ?? profile.steamBuild ?? MADE_FOR);
  const { catalog, exact } = loadCatalog(build);
  const { css, skipped } = await composeCss(catalog, profile, profile.edits, profile.followMaster !== false, build, !!liveBuild);
  const id = themeId(profile.name);
  const files = {
    'theme.json': JSON.stringify({
      name: id,
      display_name: `chroma: ${profile.name}`,
      author: 'chroma',
      version: 'v1.0',
      description: `Made with chroma on Steam build ${build}. Other Steam builds: best effort.`,
      manifest_version: 8,
      inject: { 'shared.css': ['bigpicture', 'MainMenu', 'QuickAccess'] },
    }, null, 2) + '\n',
    'shared.css': `/* chroma theme "${profile.name}" for Steam build ${build}. Generated by chroma. */\n\n${css}`,
  };

  let installed = null;
  if (fs.existsSync(path.dirname(THEMES_DIR))) {
    installed = path.join(THEMES_DIR, id);
    fs.mkdirSync(installed, { recursive: true });
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(installed, f), text);
  }
  const downloads = [path.join(os.homedir(), 'Downloads'), os.homedir()].find(d => fs.existsSync(d));
  const zip = path.join(downloads, `${id}.zip`);
  fs.writeFileSync(zip, zipFiles(Object.entries(files).map(([f, text]) => [`${id}/${f}`, text])));

  const note = installed
    ? `In CSS Loader's themes: refresh there and switch on "chroma: ${profile.name}".`
    : 'No CSS Loader here (~/homebrew missing); send the zip.';
  return { ok: true, id, installed, zip, exactCatalog: exact, skipped, note };
}

// A zip of text files (deflated), for sending a theme in one file. [[path, text], ...]
function zipFiles(entries) {
  const local = [], central = [];
  let offset = 0;
  const now = new Date(); // DOS date and time
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, text] of entries) {
    const data = Buffer.from(text), packed = zlib.deflateRawSync(data), fname = Buffer.from(name);
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8); head.writeUInt16LE(dosTime, 10); head.writeUInt16LE(dosDate, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(fname.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(0x031e, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10); dir.writeUInt16LE(dosTime, 12); dir.writeUInt16LE(dosDate, 14); dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(fname.length, 28);
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38); dir.writeUInt32LE(offset, 42);
    local.push(head, fname, packed);
    central.push(dir, fname);
    offset += 30 + fname.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

// Whether chroma can reach Steam, for the pages' header message.
async function status() {
  const base = await findCdp();
  if (!base) return { steam: false, madeFor: MADE_FOR };
  let bigPicture = false, build = null;
  try {
    const list = await (await fetch(`${base}/json`)).json();
    bigPicture = list.some(TARGETS.BigPicture);
    build = String(await steamBuild());
  } catch { /* Steam still starting */ }
  return { steam: true, bigPicture, build, madeFor: MADE_FOR, cssLoader: fs.existsSync(path.dirname(THEMES_DIR)) };
}

// ─── Picker ─────────────────────────────────────────────────────────────────
// chroma-picker (the default page): a whole theme from two choices, Dark / Light and a hue. Every
// colour of the template (a hand-made profile: palette + part edits) is turned in OKLCH by the
// hue's distance from the template's own, which keeps each colour's lightness and so the
// template's contrast. Dark mode also lowers opaque backgrounds' lightness; text stays light.
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'chroma.json');
const PROFILE_DIR = path.join(DATA, 'profiles');

const toLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const fromLin = v => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);
function toOklch(rgb) {
  const [r, g, b] = rgb.map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
}
function fromOklch([L, C, h]) {
  const A = C * Math.cos(h * Math.PI / 180), B = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s].map(fromLin);
}
// Out-of-gamut colours (a turned pastel can leave sRGB) lose chroma until they fit.
function fitOklch([L, C, h]) {
  const ok = c => fromOklch([L, c, h]).every(v => v >= -0.5 && v <= 255.5);
  if (ok(C)) return fromOklch([L, C, h]);
  let lo = 0, hi = C;
  for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; ok(mid) ? lo = mid : hi = mid; }
  return fromOklch([L, lo, h]);
}
const hex2 = v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
const COLOUR_TOKEN = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi;
function parseColour(tok) {
  if (tok[0] === '#') {
    let h = tok.slice(1);
    if (h.length <= 4) h = [...h].map(c => c + c).join('');
    const n = h.match(/../g).map(x => parseInt(x, 16));
    return [n[0], n[1], n[2], n.length > 3 ? n[3] / 255 : 1];
  }
  const n = (tok.match(/[\d.]+/g) ?? []).map(Number);
  return n.length >= 3 && !/var\(/.test(tok) ? [n[0], n[1], n[2], n[3] ?? 1] : null;
}
// One colour value (or every colour in a gradient) turned by `turn` degrees; `dark` darkens it
// (a background in dark mode).
function turnValue(value, turn, dark) {
  return value.replace(COLOUR_TOKEN, tok => {
    const parsed = parseColour(tok);
    if (!parsed) return tok;
    const [r, g, b, a] = parsed;
    let [L, C, h] = toOklch([r, g, b]);
    h = (h + turn + 360) % 360;
    // Dark: opaque backgrounds drop to around 0.2 lightness; light tints laid over them (bars,
    // hover fills) drop less, so they still lift what they cover.
    if (dark) L = a >= 0.5 ? Math.min(0.6, Math.max(0.12, 0.2 + (L - 0.6) * 0.9)) : L * 0.7;
    const rgb = fitOklch([L, C, h]);
    return '#' + rgb.map(hex2).join('') + (a < 1 ? hex2(a * 255) : '');
  });
}
const isBgKey = key => /(^|:)(background|border-color)$/.test(key);

function loadTemplate() {
  const t = readJson(TEMPLATE_PATH);
  // The template's own hue: its main background (the first palette colour).
  t.main = Object.values(t.edits.find(e => e.part === paletteId(t.palette[0])).set)[0];
  t.hue = Math.round(toOklch(parseColour(t.main))[2]);
  return t;
}
function pickerEdits(t, mode, hue) {
  const turn = hue - t.hue, dark = mode === 'dark';
  return t.edits.map(e => ({ part: e.part, set: Object.fromEntries(Object.entries(e.set).map(([k, v]) =>
    [k, k.endsWith('backdrop-filter') ? v : turnValue(v, turn, dark && isBgKey(k))])) }));
}
const pickerInput = b => {
  const mode = b.mode === 'dark' ? 'dark' : 'light';
  const hue = Number(b.hue);
  if (!Number.isFinite(hue) || hue < 0 || hue > 360) throw new Error('hue must be 0-360');
  return { mode, hue };
};
const profileFile = name => path.join(PROFILE_DIR, `${name.trim().toLowerCase().replace(/[^\w-]+/g, '-')}.json`);

function pickerProfiles() {
  if (!fs.existsSync(PROFILE_DIR)) return [];
  return fs.readdirSync(PROFILE_DIR).filter(f => f.endsWith('.json')).flatMap(f => {
    const file = path.join(PROFILE_DIR, f);
    try {
      const p = readJson(file);
      return p.picker ? [{ name: p.name, ...p.picker, saved: fs.statSync(file).mtimeMs }] : [];
    } catch { return []; }
  }).sort((a, b) => b.saved - a.saved);
}

async function pickerState() {
  const t = loadTemplate();
  // The slider's track: the main background at every 15 degrees, per mode.
  const track = mode => Array.from({ length: 25 }, (_, i) => turnValue(t.main, i * 15 - t.hue, mode === 'dark'));
  return { templateHue: t.hue, profiles: pickerProfiles(), track: { light: track('light'), dark: track('dark') } };
}

// Take chroma's preview (and any locate outline) out of Steam: the picker's Preview switch, and
// leaving a page or quitting the app, so CSS Loader's themes show again (a preview sits above them).
export async function clearPreview() {
  await eachWindow(async role => {
    await setStyle(PREVIEW_ID, '', role);
    await setStyle(LOCATE_ID, '', role);
  });
  return { ok: true };
}

async function pickerPreview(b) {
  const { mode, hue } = pickerInput(b);
  const t = loadTemplate();
  const build = await steamBuild();
  const { catalog } = loadCatalog(build);
  const { css } = await composeCss(catalog, t, pickerEdits(t, mode, hue), t.followMaster !== false, build);
  await eachWindow(role => setStyle(PREVIEW_ID, css, role));
  return { ok: true };
}

// Save under a name. Only picker profiles are overwritten; hand-made ones (the dev editor's) are not.
// Export saves first, then exports that profile.
async function pickerExport(b) {
  const r = await pickerSave(b);
  return { ...await exportTheme(readJson(r.file)), profiles: r.profiles };
}

async function pickerSave(b) {
  const { mode, hue } = pickerInput(b);
  const name = String(b.name ?? '').trim();
  if (!/^[\p{L}\p{N} _-]{1,40}$/u.test(name)) throw new Error('Name: 1-40 letters, numbers, spaces, - or _');
  const file = profileFile(name);
  if (fs.existsSync(file) && !readJson(file).picker) throw new Error(`"${name}" is a dev profile; pick another name`);
  const t = loadTemplate();
  const build = await steamBuild().catch(() => t.steamBuild);
  saveProfileAt(file, { name, steamBuild: String(build), followMaster: t.followMaster !== false,
    palette: t.palette, edits: pickerEdits(t, mode, hue), picker: { mode, hue } });
  return { ok: true, file, profiles: pickerProfiles() };
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res, code, data, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}

const routes = {
  'GET /': (req, res) => send(res, 200, fs.readFileSync(path.join(ROOT, 'editor', 'picker.html')), 'text/html'),
  'GET /dev': (req, res) => send(res, 200, fs.readFileSync(path.join(ROOT, 'editor', 'index.html')), 'text/html'),
  'GET /api/picker': async (req, res) => send(res, 200, await pickerState()),
  'POST /api/picker/preview': async (req, res) => send(res, 200, await pickerPreview(await body(req))),
  'POST /api/preview/clear': async (req, res) => send(res, 200, await clearPreview()),
  'POST /api/picker/save': async (req, res) => send(res, 200, await pickerSave(await body(req))),
  'GET /api/state': async (req, res) => send(res, 200, await state()),
  'POST /api/preview': async (req, res) => {
    const b = await body(req);
    send(res, 200, await preview(b.edits, b.followMaster, b.palette === true));
  },
  'POST /api/trawl': async (req, res) => send(res, 200, await trawl()),
  'POST /api/accept': async (req, res) => {
    const ids = (await body(req)).ids;
    if (!Array.isArray(ids)) throw new Error('ids must be an array');
    send(res, 200, await accept(ids.filter(id => typeof id === 'string')));
  },
  'POST /api/locate': async (req, res) => {
    const b = await body(req);
    send(res, 200, await locate(b.part ?? null, b.key ?? null));
  },
  'POST /api/export': async (req, res) => send(res, 200, await exportTheme(loadProfile(await steamBuild()))),
  'GET /api/status': async (req, res) => send(res, 200, await status()),
  'POST /api/picker/export': async (req, res) => send(res, 200, await pickerExport(await body(req))),
  'POST /api/defaults': async (req, res) => send(res, 200, await showDefaults((await body(req)).on)),
  'POST /api/remove': async (req, res) => send(res, 200, await removePart((await body(req)).part)),
};

// The editor's fonts (JetBrains Mono, copied from magik). Fixed list: nothing else is served.
const FONTS = new Set(['JetBrainsMono-Regular.ttf', 'JetBrainsMono-Medium.ttf']);

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  const font = req.method === 'GET' && pathname.startsWith('/fonts/') && pathname.slice(7);
  if (font && FONTS.has(font)) {
    res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'max-age=86400' });
    return res.end(fs.readFileSync(path.join(ROOT, 'editor', 'fonts', font)));
  }
  const route = routes[`${req.method} ${pathname}`];
  if (!route) return send(res, 404, { error: 'not found' });
  try {
    await route(req, res);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});
// Resolves with the URL once serving (the desktop app waits on it); rejects if the port is taken.
export const listening = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`chroma-picker: http://localhost:${PORT}  dev editor: http://localhost:${PORT}/dev  (profile: ${PROFILE_PATH})`);
    resolve(`http://localhost:${PORT}`);
  });
});
