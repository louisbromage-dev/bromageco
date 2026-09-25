// Builds the static, search-friendly site from the Claude Design export.
//
//   design/export.html  ->  index.html, <page>/index.html, 404.html, assets/,
//                           sitemap.xml, robots.txt
//
// Every page gets its own URL, title, description and fully rendered HTML, so
// search engines and link previews see the real content without running
// JavaScript. The original design runtime still boots on top, so the package
// builder, forms and menus behave exactly as they do in Claude Design.
//
// Usage (from the repo root):  cd tools && npm install && npm run build

import { chromium } from "playwright";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT = path.join(ROOT, "design", "export.html");
const SITE_URL = "https://bromageco.com";
const SITE_NAME = "Bromage & Co Accounting";

// One entry per page in the design. `key` is the page name the design uses
// internally; `path` is the public URL.
const PAGES = [
  {
    key: "home", path: "/",
    title: "Bromage & Co Accounting | Chartered Accountant in Fleet, Hampshire",
    description: "CIMA chartered accountant in Fleet, Hampshire for limited companies, sole traders and growing businesses across the UK. Fixed monthly fees, published online. You deal with Louis."
  },
  {
    key: "services", path: "/services/",
    title: "Accounting & Tax Services for Small Businesses | Bromage & Co",
    description: "Year-end accounts, corporation tax, self assessment, VAT, bookkeeping, payroll and management accounts. Buy one service or bundle them into one fixed monthly fee."
  },
  {
    key: "finance", path: "/outsourced-finance/",
    title: "Outsourced Finance & Part-Time FD Support | Bromage & Co",
    description: "Bookkeeping, payroll, monthly management accounts and finance director support for growing businesses, for a fixed monthly fee. Available from August 2027."
  },
  {
    key: "advisory", path: "/advisory/",
    title: "Business Advisory: Valuations, Sale Readiness & Due Diligence | Bromage & Co",
    description: "Buying, selling or valuing a business? Valuations, exit readiness, due diligence and deal modelling from a CIMA chartered accountant, scoped as projects with the fee fixed first."
  },
  {
    key: "package", path: "/packages/",
    title: "Accounting Package Prices: Build Your Quote Online | Bromage & Co",
    description: "Build your accounting package and see the fixed monthly price instantly. Published prices for limited companies, sole traders, partnerships and personal tax. No call needed."
  },
  {
    key: "mtd", path: "/making-tax-digital/",
    title: "Making Tax Digital for Income Tax: What You Need to Do | Bromage & Co",
    description: "Making Tax Digital for Income Tax starts April 2026 for sole traders and landlords over £50,000, then £30,000 from April 2027. What changes, and how Bromage & Co can handle the quarterly updates for you."
  },
  {
    key: "about", path: "/about/",
    title: "About Louis Bromage, CIMA Chartered Accountant | Bromage & Co",
    description: "A solo practice in Fleet, Hampshire, on purpose. Meet Louis Bromage, CIMA chartered management accountant, and see how Bromage & Co works with its clients."
  },
  {
    key: "contact", path: "/contact/",
    title: "Contact Bromage & Co Accounting | Fleet, Hampshire",
    description: "Talk to Louis about your accounts, tax or finance. Call 07387 835 746, email enquiries@bromageco.com or send a message. Questions are always free."
  },
  {
    key: "legal", path: "/legal/",
    title: "Legal Information & Privacy Notice | Bromage & Co Accounting",
    description: "Company details, professional regulation and the privacy notice for Bromage & Co Accounting Ltd, company number 17052920."
  }
];

const REACT_URL = "https://unpkg.com/react@18.3.1/umd/react.production.min.js";
const REACT_DOM_URL = "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js";

// Images wider than this (in pixels) are scaled down; the largest one on the
// site is shown at under 100px wide but shipped at full print resolution.
const MAX_IMAGE_WIDTH = 480;

function fail(msg) {
  console.error("build failed: " + msg);
  process.exit(1);
}

function hash(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 10);
}

function replaceOnce(src, find, repl, what) {
  const i = src.indexOf(find);
  if (i === -1) fail(`could not find ${what} in the design. The export has changed shape; update tools/build.mjs.`);
  if (src.indexOf(find, i + find.length) !== -1) fail(`found ${what} more than once in the design.`);
  return src.slice(0, i) + repl + src.slice(i + find.length);
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ── 1. Unpack the Claude Design bundle ─────────────────────────────────────

const exported = fs.readFileSync(EXPORT, "utf8");

function bundleBlock(type) {
  const m = exported.match(new RegExp(`<script type="__bundler/${type}">\\s*([\\s\\S]*?)\\s*</script>`));
  if (!m) fail(`design/export.html has no ${type} block. Is it a Claude Design HTML export?`);
  return JSON.parse(m[1]);
}

const manifest = bundleBlock("manifest");
const extResources = bundleBlock("ext_resources");
const exportedTemplate = bundleBlock("template");

const OUT_ASSETS = path.join(ROOT, "assets");
fs.rmSync(OUT_ASSETS, { recursive: true, force: true });
fs.mkdirSync(OUT_ASSETS, { recursive: true });

const EXT = {
  "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf",
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/svg+xml": "svg", "text/javascript": "js", "application/javascript": "js", "text/css": "css"
};

const assetBytes = {}; // uuid -> Buffer
for (const [uuid, entry] of Object.entries(manifest)) {
  let buf = Buffer.from(entry.data, "base64");
  if (entry.compressed) buf = gunzipSync(buf);
  assetBytes[uuid] = { buf, mime: entry.mime };
}

const extByUuid = Object.fromEntries(extResources.map(r => [r.uuid, r.id]));
const runtimeUuid = (exportedTemplate.match(/<script src="([0-9a-f-]{36})"><\/script>/) || [])[1];
if (!runtimeUuid || !assetBytes[runtimeUuid]) fail("could not find the design runtime script.");

// ── 2. Serve the unpacked site locally and render it with Chromium ─────────

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("not found"); return;
  }
  const type = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
    ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain"
  }[path.extname(file)] || "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();

// Scale oversized images down (Chromium does the resampling, so the build
// needs no image library).
async function shrinkPng(buf) {
  const page = await browser.newPage();
  const out = await page.evaluate(async ({ b64, max }) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    if (img.naturalWidth <= max) return null;
    const c = document.createElement("canvas");
    c.width = max;
    c.height = Math.round(img.naturalHeight * max / img.naturalWidth);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/png").split(",")[1];
  }, { b64: buf.toString("base64"), max: MAX_IMAGE_WIDTH });
  await page.close();
  if (!out) return buf;
  const smaller = Buffer.from(out, "base64");
  return smaller.length < buf.length ? smaller : buf;
}

// Write every bundled file to assets/ under a readable, content-hashed name
// so it can be cached for a year.
const assetPath = {}; // uuid -> "/assets/…"
for (const [uuid, { buf: raw, mime }] of Object.entries(assetBytes)) {
  let buf = raw;
  let dir, base;
  if (uuid === runtimeUuid) { dir = "js"; base = "dc-runtime"; }
  else if (extByUuid[uuid] === REACT_URL) { dir = "js"; base = "react-18.3.1"; }
  else if (extByUuid[uuid] === REACT_DOM_URL) { dir = "js"; base = "react-dom-18.3.1"; }
  else if (mime.startsWith("font/")) { dir = "fonts"; base = "font"; }
  else if (mime.startsWith("image/")) { dir = "img"; base = "image"; }
  else { dir = "misc"; base = "file"; }
  if (mime === "image/png") buf = await shrinkPng(buf);
  const ext = EXT[mime] || "bin";
  const rel = `/assets/${dir}/${base}-${hash(buf)}.${ext}`;
  fs.mkdirSync(path.join(ROOT, "assets", dir), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), buf);
  assetPath[uuid] = rel;
}
for (const url of [REACT_URL, REACT_DOM_URL]) {
  if (!extResources.some(r => r.id === url)) fail("the export no longer bundles " + url);
}
const reactSrc = assetPath[extResources.find(r => r.id === REACT_URL).uuid];
const reactDomSrc = assetPath[extResources.find(r => r.id === REACT_DOM_URL).uuid];
const runtimeSrc = assetPath[runtimeUuid];

// ── 3. Adapt the design so each page has a real URL ───────────────────────

let tpl = exportedTemplate;
for (const [uuid, rel] of Object.entries(assetPath)) tpl = tpl.split(uuid).join(rel);

const xStart = tpl.indexOf("<x-dc>");
const xEnd = tpl.lastIndexOf("</x-dc>");
if (xStart === -1 || xEnd === -1) fail("could not find the <x-dc> design template.");
let markup = tpl.slice(xStart + "<x-dc>".length, xEnd);

const scriptMatch = tpl.match(/<script type="text\/x-dc" data-dc-script="" data-props="([^"]*)">([\s\S]*?)<\/script>/);
if (!scriptMatch) fail("could not find the design's page logic script.");
const dataProps = scriptMatch[1];
let logic = scriptMatch[2];

// Title, description, icons and social tags are written per page into the
// static <head> instead of coming from the design.
markup = markup.replace(/<title>[\s\S]*?<\/title>\s*/, "");
markup = markup.replace(/<meta (name|property)="(description|og:[a-z:]+|twitter:[a-z:]+)"[^>]*>\s*/g, "");
markup = markup.replace(/<link rel="(icon|apple-touch-icon)"[^>]*>\s*/g, "");
const faviconSrc = (tpl.match(/<link rel="icon" href="([^"]+)"/) || [])[1];
if (!faviconSrc || !faviconSrc.endsWith(".svg")) fail("the design no longer has an SVG favicon.");

// Navigation buttons become real links, so crawlers can follow them and
// visitors can open pages in new tabs. Clicks still go through the design's
// own navigation.
const pathOf = Object.fromEntries(PAGES.map(p => [p.key, p.path]));
const LINK_TARGETS = {
  goHome: pathOf.home, goServices: pathOf.services, goPackage: pathOf.package,
  goContact: pathOf.contact, goAbout: pathOf.about, goAdvisory: pathOf.advisory,
  goFinance: pathOf.finance, goFinanceCall: pathOf.contact + "?topic=finance",
  goLegal: pathOf.legal, "n.go": "{{ n.href }}", "s.go": "{{ s.href }}"
};
let linkCount = 0;
markup = markup.replace(/<button sc-camel-on-click="\{\{ ([\w.]+) \}\}"([^>]*)>([\s\S]*?)<\/button>/g, (whole, handler, attrs, inner) => {
  const href = LINK_TARGETS[handler];
  if (!href) return whole;
  linkCount++;
  return `<a data-nav="" href="${href}" sc-camel-on-click="{{ ${handler} }}"${attrs}>${inner}</a>`;
});
if (linkCount < 15) fail(`only ${linkCount} navigation buttons found; the design has changed shape.`);

// Plain links keep the design's link colours; navigation links keep the look
// of the buttons they replace.
markup = replaceOnce(markup, "a{color:#4a5742}a:hover{color:#2b3327}",
  "a:not([data-nav]){color:#4a5742}a:not([data-nav]):hover{color:#2b3327}\n" +
  "a[data-nav]{color:ButtonText;text-decoration:none;display:inline-block;text-align:center;cursor:pointer;box-sizing:border-box}",
  "the global link colour rule");

// Page logic: read the page from the URL, keep the URL, title and
// description in step when the page changes, and support back/forward.
const ROUTER = `
const __ROUTES = ${JSON.stringify(PAGES.map(({ key, path, title, description }) => ({ key, path, title, description })))};
const __routeFor = key => __ROUTES.find(r => r.key === key) || __ROUTES[0];
function __pageFromLocation() {
  if (typeof window === "undefined") return "home";
  const p = window.location.pathname.replace(/\\/index\\.html$/, "/").replace(/\\/?$/, "/");
  const hit = __ROUTES.find(r => r.path === p);
  return hit ? hit.key : "home";
}
function __topicFromLocation() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("topic") || "";
}
function __applyMeta(key, topic) {
  const r = __routeFor(key);
  document.title = r.title;
  const set = (sel, attr, val) => { const el = document.querySelector(sel); if (el) el.setAttribute(attr, val); };
  const url = ${JSON.stringify(SITE_URL)} + r.path;
  set('meta[name="description"]', "content", r.description);
  set('link[rel="canonical"]', "href", url);
  set('meta[property="og:title"]', "content", r.title);
  set('meta[property="og:description"]', "content", r.description);
  set('meta[property="og:url"]', "content", url);
}
`;
logic = ROUTER + logic;
logic = replaceOnce(logic, `page: "home", open: 0,`,
  `page: __pageFromLocation(), open: 0,`, "the initial page state");
logic = replaceOnce(logic, `menu: false, finOpen: 0, topic: ""`,
  `menu: false, finOpen: 0, topic: __topicFromLocation()`, "the initial topic state");
logic = replaceOnce(logic, `document.title = "Bromage & Co Accounting";`,
  `__applyMeta(this.state.page, this.state.topic);
    window.addEventListener("popstate", () => {
      const page = __pageFromLocation();
      this.setState({ page, open: 0, finOpen: 0, sent: false, menu: false, topic: __topicFromLocation() });
      __applyMeta(page);
    });`, "the page title line");
logic = replaceOnce(logic,
  `this.setState({ page, open: 0, finOpen: 0, sent: false, menu: false, topic: topic || "" });`,
  `this.setState({ page, open: 0, finOpen: 0, sent: false, menu: false, topic: topic || "" });
    if (typeof window !== "undefined") {
      const target = __routeFor(page).path + (topic ? "?topic=" + encodeURIComponent(topic) : "");
      if (target !== window.location.pathname + window.location.search) window.history.pushState(null, "", target);
      __applyMeta(page, topic);
    }`, "the go() navigation method");
logic = replaceOnce(logic, `go: () => this.go(n.key),\n`,
  `go: () => this.go(n.key),\n          href: __routeFor(n.key).path,\n`, "the main navigation items");
logic = replaceOnce(logic, `go: () => this.go(s.key)\n`,
  `go: () => this.go(s.key),\n            href: __routeFor(s.key).path\n`, "the services submenu items");
logic = replaceOnce(logic, `.map(n => ({ label: n.label, go: () => this.go(n.key) })),`,
  `.map(n => ({ label: n.label, href: __routeFor(n.key).path, go: () => this.go(n.key) })),`, "the footer navigation items");

// ── 4. Page shell ─────────────────────────────────────────────────────────

const ORG = {
  "@context": "https://schema.org",
  "@type": "AccountingService",
  "@id": SITE_URL + "/#business",
  name: SITE_NAME,
  legalName: "Bromage & Co Accounting Ltd",
  alternateName: "Fileo & Co Accounting",
  url: SITE_URL + "/",
  logo: SITE_URL + "/icon-512.png",
  image: SITE_URL + "/social-card.png",
  description: PAGES[0].description,
  telephone: "+44 7387 835746",
  email: "enquiries@bromageco.com",
  founder: { "@type": "Person", name: "Louis Bromage", jobTitle: "CIMA Chartered Management Accountant" },
  address: { "@type": "PostalAddress", addressLocality: "Fleet", addressRegion: "Hampshire", addressCountry: "GB" },
  areaServed: [{ "@type": "Country", name: "United Kingdom" }],
  identifier: { "@type": "PropertyValue", propertyID: "Companies House company number", value: "17052920" },
  knowsAbout: ["Year-end accounts", "Corporation tax", "Self assessment", "VAT", "Bookkeeping", "Payroll", "Management accounts", "Making Tax Digital", "Business valuations"]
};

function shell(page, { head = "", body = "", robots = "index,follow" }) {
  const url = SITE_URL + page.path;
  const ld = [ORG, {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": url,
    url,
    name: page.title,
    description: page.description,
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL + "/" },
    about: { "@id": ORG["@id"] }
  }];
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(page.title)}</title>
<meta name="description" content="${escapeAttr(page.description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#4a5742">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME.replace("&", "&amp;")}">
<meta property="og:locale" content="en_GB">
<meta property="og:title" content="${escapeAttr(page.title)}">
<meta property="og:description" content="${escapeAttr(page.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}/social-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
<style>x-dc{display:none!important}</style>
${head}
<script>window.__resources = {};</script>
<script defer src="${reactSrc}"></script>
<script defer src="${reactDomSrc}"></script>
<script defer src="${runtimeSrc}"></script>
</head>
<body>
<div id="prerender">${body}</div>
<script type="text/x-dc-template" id="dc-template">${markup.replace(/<\/script/gi, "<\\/script")}</script>
<script type="text/x-dc" data-dc-script="" data-props="${dataProps}">${logic}</script>
<script>
(function () {
  // Hand the page over from the pre-rendered copy to the live design once it
  // has rendered, with no visible swap.
  var pre = document.getElementById("prerender");
  var x = document.createElement("x-dc");
  x.innerHTML = document.getElementById("dc-template").textContent.replace(/<\\\\\\/script/gi, "</script");
  pre.after(x);
  new MutationObserver(function (_, obs) {
    var live = document.getElementById("dc-root");
    if (live && live.firstElementChild) { pre.remove(); obs.disconnect(); }
  }).observe(document.body, { childList: true, subtree: true });
  // Ctrl/Cmd/Shift-click opens a new tab as usual; a plain click on a
  // navigation link switches page in place once the design is live.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[data-nav]");
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) e.stopPropagation();
  }, true);
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[data-nav]");
    if (a && document.getElementById("dc-root")) e.preventDefault();
  });
})();
</script>
</body>
</html>
`;
}

// ── 5. Render each page and write it out ──────────────────────────────────

function outFile(p) {
  return path.join(ROOT, p === "/" ? "index.html" : p.slice(1) + "index.html");
}

// First pass: live shells with no pre-rendered content.
for (const page of PAGES) {
  fs.mkdirSync(path.dirname(outFile(page.path)), { recursive: true });
  fs.writeFileSync(outFile(page.path), shell(page, {}));
}

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const rendered = {};
for (const page of PAGES) {
  const tab = await context.newPage();
  const errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.goto(ORIGIN + page.path, { waitUntil: "networkidle" });
  await tab.waitForFunction(() => {
    const r = document.getElementById("dc-root");
    return r && r.innerText.trim().length > 200 && !document.getElementById("prerender");
  }, null, { timeout: 30000 });
  await tab.waitForTimeout(500);
  if (errors.length) fail(`${page.path} threw: ${errors.join("; ")}`);
  const snap = await tab.evaluate(() => {
    // Styles the design injected at runtime, including rules added through
    // the CSSOM (hover and focus states), which never appear in textContent.
    const css = [...document.head.querySelectorAll("style")].map(s => {
      try { return [...s.sheet.cssRules].map(r => r.cssText).join("\n"); }
      catch { return s.textContent; }
    }).filter(Boolean).join("\n");
    const root = document.getElementById("dc-root").cloneNode(true);
    root.querySelectorAll("[data-dc-tpl]").forEach(el => el.removeAttribute("data-dc-tpl"));
    const h1 = document.querySelector("#dc-root h1");
    return { css, html: root.innerHTML, h1: h1 ? h1.innerText : "", text: document.getElementById("dc-root").innerText.length };
  });
  rendered[page.key] = snap;
  console.log(`rendered ${page.path.padEnd(22)} h1: ${JSON.stringify(snap.h1)}  (${snap.text} chars of text)`);
  await tab.close();
}

// Second pass: full pages with the rendered content and styles inline.
const pageCss = key => `<style id="prerender-css">${rendered[key].css.replace(/<\/style/gi, "<\\/style")}</style>`;
for (const page of PAGES) {
  fs.writeFileSync(outFile(page.path), shell(page, { head: pageCss(page.key), body: rendered[page.key].html }));
}

// Not-found page: the home page content, marked noindex.
const notFound = { ...PAGES[0], title: "Page not found | " + SITE_NAME };
fs.writeFileSync(path.join(ROOT, "404.html"),
  shell(notFound, { head: pageCss("home"), body: rendered.home.html, robots: "noindex,follow" }));

// Site icons at fixed addresses. Google shows a favicon only if it is square
// and a multiple of 48px, and it looks for /favicon.ico by default.
{
  const svg = fs.readFileSync(path.join(ROOT, faviconSrc));
  fs.writeFileSync(path.join(ROOT, "favicon.svg"), svg);
  const tab = await browser.newPage();
  const png = async size => Buffer.from(await tab.evaluate(async ({ b64, size }) => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = size;
    c.getContext("2d").drawImage(img, 0, 0, size, size);
    return c.toDataURL("image/png").split(",")[1];
  }, { b64: svg.toString("base64"), size }), "base64");
  const ico48 = await png(48);
  // A .ico file holding one 48 × 48 PNG image.
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt8(48, 6); header.writeUInt8(48, 7);
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(ico48.length, 14); header.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(ROOT, "favicon.ico"), Buffer.concat([header, ico48]));
  fs.writeFileSync(path.join(ROOT, "apple-touch-icon.png"), await png(180));
  fs.writeFileSync(path.join(ROOT, "icon-192.png"), await png(192));
  fs.writeFileSync(path.join(ROOT, "icon-512.png"), await png(512));
  await tab.close();
}

// Social sharing card (1200 × 630).
{
  const tab = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await tab.goto(ORIGIN + "/");
  await tab.waitForFunction(() => document.fonts.ready.then(() => true));
  await tab.setContent(`<html><head>${pageCss("home")}</head><body style="margin:0">
    <div style="width:1200px;height:630px;background:#4a5742;color:#f6f5f1;display:flex;flex-direction:column;justify-content:center;padding:0 96px;box-sizing:border-box">
      <div style="font:400 150px/1 'Cormorant Garamond',Georgia,serif">B&amp;Co</div>
      <div style="font:500 26px/1 'Barlow Condensed',sans-serif;letter-spacing:.32em;color:#b9c4ad;margin-top:18px">ACCOUNTING</div>
      <div style="font:400 38px/1.25 'Cormorant Garamond',Georgia,serif;margin-top:56px;max-width:900px">The accountant for businesses ready to grow.</div>
      <div style="font:400 22px/1.4 Barlow,sans-serif;color:#d8dfd1;margin-top:18px">CIMA chartered · Fleet, Hampshire · Fixed monthly fees</div>
    </div></body></html>`, { waitUntil: "networkidle" });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: path.join(ROOT, "social-card.png") });
  await tab.close();
}

await browser.close();
server.close();

// ── 6. Sitemap and robots.txt ─────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(ROOT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map(p => `  <url><loc>${SITE_URL}${p.path}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`);
fs.writeFileSync(path.join(ROOT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);

console.log("done: " + PAGES.length + " pages written");
