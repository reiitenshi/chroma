// First-run crawler: talks to Steam's CEF debugger and dumps a profile.
// Run: node --experimental-websocket crawl.mjs [port]   (Node 20; Node 22+ needs no flag)

import { writeFile, mkdir } from "node:fs/promises";

const PORT = process.argv[2] ?? "8080";
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.CHROMA_OUT
  ? new URL(`file://${process.env.CHROMA_OUT.replace(/\/?$/, "/")}`)
  : new URL("./out/", import.meta.url);

async function targets() {
  const res = await fetch(`${BASE}/json`);
  return (await res.json()).filter((t) => t.webSocketDebuggerUrl);
}

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  async function evaluate(fn) {
    await ready;
    const id = nextId++;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression: `(${fn})()`, returnByValue: true, awaitPromise: true },
      })
    );
    const { result: r, exceptionDetails } = await result;
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return r.value;
  }

  return { evaluate, close: () => ws.close() };
}

// Runs inside each page: what is this page, and does it hold Steam's webpack bundle / SteamClient?
const probe = () => ({
  title: document.title,
  url: location.href,
  elements: document.querySelectorAll("*").length,
  webpack: Object.keys(window).filter((k) => k.startsWith("webpackChunk")),
  steamClient: typeof window.SteamClient,
});

// Runs inside the page holding the bundle: every loaded CSS-module export, readable key -> hashed class.
const classMap = () => {
  const chunk = window.webpackChunksteamui;
  let req;
  chunk.push([[Symbol("chroma")], {}, (r) => (req = r)]);
  chunk.pop();

  const looksLikeClass = (v) => typeof v === "string" && /^[A-Za-z_][\w-]*$/.test(v);
  const modules = {};
  let failed = 0;
  // Steam's runtime exposes no module cache (req.c), so require each module id, as @decky/ui does.
  for (const id of Object.keys(req.m)) {
    let ex;
    try {
      ex = req(id);
    } catch {
      failed++;
      continue;
    }
    if (!ex || typeof ex !== "object") continue;
    const entries = Object.entries(ex);
    if (entries.length < 2 || !entries.every(([, v]) => looksLikeClass(v))) continue;
    modules[id] = Object.fromEntries(entries);
  }
  return { failed, total: Object.keys(req.m).length, modules };
};

// Runs inside the page holding SteamClient: namespace -> method names.
const steamClientApi = () => {
  const out = {};
  for (const [ns, val] of Object.entries(window.SteamClient ?? {})) {
    out[ns] =
      val && typeof val === "object"
        ? Object.keys(val).sort()
        : typeof val;
  }
  return out;
};

// Runs inside a UI page: visible elements with classes, text, box, colours and focus markers.
const domSnapshot = () => {
  const visible = (el, r) => r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  const nodes = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const cs = getComputedStyle(el);
    const ownText = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(" ")
      .slice(0, 60);
    nodes.push({
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList],
      text: ownText || undefined,
      box: [r.x, r.y, r.width, r.height].map(Math.round),
      color: cs.color,
      background: cs.backgroundColor,
      focusable: el.classList.contains("Focusable") || el.tabIndex >= 0 || undefined,
      focused: el.classList.contains("gpfocus") || undefined,
    });
  }
  return { title: document.title, size: [innerWidth, innerHeight], nodes };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const list = await targets();
  const pages = [];

  for (const t of list) {
    const page = connect(t);
    try {
      pages.push({ target: t, page, info: await page.evaluate(probe) });
    } catch (e) {
      console.warn(`skip ${t.title}: ${e.message}`);
      page.close();
    }
  }

  console.log("Pages:");
  for (const { info } of pages)
    console.log(`  ${info.title.padEnd(32)} els=${String(info.elements).padStart(5)} webpack=[${info.webpack}] SteamClient=${info.steamClient}`);

  const bundleHost = pages.find((p) => p.info.webpack.includes("webpackChunksteamui"));
  const clientHost = pages.find((p) => p.info.steamClient === "object");
  const profile = { capturedAt: new Date().toISOString(), pages: pages.map((p) => p.info) };

  if (bundleHost) profile.classMap = await bundleHost.page.evaluate(classMap);
  if (clientHost) profile.steamClient = await clientHost.page.evaluate(steamClientApi);

  profile.dom = {};
  for (const { info, page } of pages) {
    if (info.elements < 20) continue;
    profile.dom[info.title] = await page.evaluate(domSnapshot);
  }

  for (const { page } of pages) page.close();

  const stamp = profile.capturedAt.replace(/[:.]/g, "-");
  await writeFile(new URL(`profile-${stamp}.json`, OUT), JSON.stringify(profile, null, 2));

  const cm = profile.classMap;
  console.log(`\nClass map: ${cm ? `${Object.keys(cm.modules).length} CSS modules (${cm.total} webpack modules, ${cm.failed} failed to load)` : "bundle not found"}`);
  console.log(`SteamClient: ${profile.steamClient ? `${Object.keys(profile.steamClient).length} namespaces` : "not found"}`);
  for (const [title, snap] of Object.entries(profile.dom))
    console.log(`DOM ${title}: ${snap.nodes.length} visible nodes at ${snap.size.join("x")}`);
  console.log(`\nWrote out/profile-${stamp}.json`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
