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
const SITE_URL = "https://www.bromageco.com";
const SITE_NAME = "Bromage & Co Accounting";

// ── Prices from Supabase ──────────────────────────────────────────────────
// Every price on the site comes from Supabase: public.builder_packages (the
// price list) and public.campaign_prices (campaign tiers and add-ons). The
// live site reads both in the visitor's browser. The build reads them too,
// so the pre-rendered pages show the same prices; if Supabase cannot be
// reached it uses the copy saved by the last build that could
// (config/prices-snapshot.json) and says so.
const SNAPSHOT_FILE = path.join(ROOT, "config", "prices-snapshot.json");
const SUPABASE = (() => {
  const raw = fs.readFileSync(EXPORT, "utf8");
  return {
    url: (raw.match(/url: \\"(https:\/\/[a-z0-9]+\.supabase\.co)\\"/) || [])[1],
    anonKey: (raw.match(/anonKey: \\"(eyJ[A-Za-z0-9._-]+)\\"/) || [])[1]
  };
})();
const PRICES = await (async () => {
  const { url, anonKey: key } = SUPABASE;
  const get = async (table, query) => {
    const res = await fetch(`${url}/rest/v1/${table}?${query}`, { headers: { apikey: key, Authorization: "Bearer " + key }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
    return res.json();
  };
  try {
    if (!url || !key) throw new Error("no Supabase address in the design");
    const snap = {
      _note: "Copy of the active rows the website reads from Supabase (public anon access), saved by the build and used only to pre-render pages. Do not edit: change prices in Supabase.",
      fetchedAt: new Date().toISOString(),
      builder_packages: await get("builder_packages", "select=name,category,tier_key,price,short_desc,includes,billing_suffix,business_types,sort_order&active=eq.true&order=sort_order.asc"),
      campaign_prices: await get("campaign_prices", "select=campaign,kind,key,label,price,price_basis,active_from,active_until,payment_link,sort_order&active=eq.true&order=sort_order.asc")
    };
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2) + "\n");
    console.log("prices: read live from Supabase");
    return snap;
  } catch (e) {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
    console.warn(`prices: Supabase not reachable (${e.message}); using the snapshot from ${snap.fetchedAt}`);
    return snap;
  }
})();
const minPrice = cat => {
  const p = PRICES.builder_packages.filter(r => r.category === cat).map(r => Number(r.price));
  if (!p.length) fail(`builder_packages has no active "${cat}" rows.`);
  return Math.min(...p);
};
const money = n => "£" + Number(n).toLocaleString("en-GB", { maximumFractionDigits: 2 });

// Self Assessment campaign. Wording and contact details are in
// config/sa-campaign.json; the tier is worked out in the visitor's browser
// (tools/sa-campaign-client.js), never at build time.
const SA_CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "sa-campaign.json"), "utf8"));
const SA_ROWS = PRICES.campaign_prices.filter(r => r.campaign === SA_CFG.campaign);
if (!SA_ROWS.some(r => r.kind === "tier")) fail(`campaign_prices has no active tiers for "${SA_CFG.campaign}".`);
for (const r of SA_ROWS) {
  if (r.payment_link && (!/^https:\/\/book\.stripe\.com\/[A-Za-z0-9]+$/.test(r.payment_link) || /\/test_/.test(r.payment_link)))
    fail(`campaign_prices "${r.key}" must use a live https://book.stripe.com/ payment link.`);
}
const SA_SNAPSHOT = {
  campaign_prices: SA_ROWS,
  builder_packages: PRICES.builder_packages.filter(r => r.category === SA_CFG.standardFee.category)
};
const SA_CLIENT = `var SA_CFG = ${JSON.stringify(SA_CFG)};\nvar SA_SNAPSHOT = ${JSON.stringify(SA_SNAPSHOT)};\n` +
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "sa-campaign-client.js"), "utf8") +
  "\nsaSetRows(SA_SNAPSHOT.campaign_prices, SA_SNAPSHOT.builder_packages);\n";
const SA_STATES = [...SA_ROWS.filter(r => r.kind === "tier").sort((x, y) => x.sort_order - y.sort_order).map(r => r.key), "over"];
const SA_BUILD = new Function(SA_CLIENT + "\nreturn saCampaignState();")();
const SA_BUILD_STATE = SA_BUILD.key;

// Google tag (Consent Mode v2), cookie banner, phone clicks and the booking
// event. The tag ID lives in config/site.json and nowhere else.
const SITE_CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "site.json"), "utf8"));
if (!/^(G|AW|GT)-[A-Z0-9]+$/.test(SITE_CFG.googleTagId || "")) fail("config/site.json needs a googleTagId such as G-XXXXXXX.");
const TRACKING = {
  tagId: SITE_CFG.googleTagId,
  consentKey: "bc-consent",
  privacyHref: "/legal/",
  supabaseUrl: SUPABASE.url,
  anonKey: SUPABASE.anonKey,
  campaign: SA_CFG.campaign,
  tiers: SA_ROWS.filter(r => r.kind === "tier").map(r => ({ key: r.key, price: Number(r.price) }))
};
const toolFile = f => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), f), "utf8");
const TRACKING_HEAD = toolFile("tracking-head.js");
const TRACKING_BODY = toolFile("tracking-body.js");
const BANNER_CSS = `#cc{position:fixed;left:0;right:0;bottom:0;z-index:60;background:var(--bg);border-top:1px solid #1f3d34;box-shadow:0 -6px 20px rgba(27,31,28,.06)}
#cc[hidden]{display:none}
.cc-inner{max-width:1180px;margin:0 auto;box-sizing:border-box;padding:16px clamp(16px,4vw,48px);display:flex;align-items:center;justify-content:space-between;gap:14px 32px;flex-wrap:wrap}
.cc-text{margin:0;flex:1 1 440px;font:400 15px/1.5 var(--font-body);color:#1b1f1c}
.cc-text a{color:#1f3d34;font-weight:600;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}
.cc-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:0 0 auto}
.cc-btn{min-width:132px;padding:14px 22px;border-radius:2px;font:600 15.5px/1 var(--font-body);cursor:pointer}
.cc-primary{border:1px solid #1f3d34;background:#1f3d34;color:#fff}
.cc-primary:hover{background:#142b24;border-color:#142b24}
.cc-secondary{border:1px solid #1b1f1c;background:transparent;color:#1b1f1c}
.cc-secondary:hover{background:rgba(27,31,28,.05)}
.cc-btn:focus-visible,.cc-text a:focus-visible,[data-cookie-settings]:focus-visible{outline:2px solid #1f3d34;outline-offset:3px}
html.cc-open [data-mobbar]{display:none!important}
html.cc-open body{padding-bottom:var(--cc-h,0px)!important}
@media (max-width:620px){.cc-inner{padding:12px 16px 14px}.cc-text{flex-basis:100%;font-size:14px}.cc-actions{width:100%}.cc-btn{min-width:0}}`;

const PAGES = [
  {
    key: "home", path: "/",
    title: "Bromage & Co Accounting | Chartered Management Accountant in Fleet, Hampshire",
    description: "Chartered Management Accountant in Fleet, Hampshire for limited companies, sole traders and growing businesses across the UK. Fixed monthly fees, published online. You deal with Louis."
  },
  {
    key: "services", path: "/services/",
    title: "Accounting & Tax Services for Small Businesses | Bromage & Co",
    description: "Year-end accounts, corporation tax, self assessment, VAT, bookkeeping, payroll and management accounts. Buy one service or bundle them into one fixed monthly fee."
  },
  {
    key: "companyAccounts", path: "/services/company-accounts/",
    title: "Limited Company Accounts & Corporation Tax | Bromage & Co, Fleet",
    description: `Year-end accounts, CT600 and Companies House filing for limited companies, from ${money(minPrice("ct"))} a month. Prepared early enough to act on, by a Chartered Management Accountant in Fleet, Hampshire.`
  },
  {
    key: "selfAssessment", path: "/services/self-assessment/",
    title: `Self Assessment Tax Returns from ${money(minPrice("sa") * 12)} a Year | Bromage & Co, Fleet`,
    description: `Self assessment tax returns for sole traders, landlords and company directors, done in the autumn rather than January. From ${money(minPrice("sa") * 12)} a year, by a Chartered Management Accountant in Fleet, Hampshire.`
  },
  {
    key: "managementAccounts", path: "/services/management-accounts/",
    title: "Management Accounts for Small Businesses | Bromage & Co",
    description: `Monthly or quarterly management accounts from ${money(minPrice("ma"))} a month: P&L against budget, cashflow forecast, margins, KPIs and a review call. From a CIMA Chartered Management Accountant.`
  },
  {
    key: "finance", path: "/outsourced-finance/",
    title: "Outsourced Finance & Part-Time FD Support | Bromage & Co",
    description: "Bookkeeping, payroll, monthly management accounts and finance director support for growing businesses, for a fixed monthly fee. Available from August 2027."
  },
  {
    key: "advisory", path: "/advisory/",
    title: "Business Advisory: Valuations, Sale Readiness & Due Diligence | Bromage & Co",
    description: "Buying, selling or valuing a business? Valuations, exit readiness, due diligence and deal modelling from a Chartered Management Accountant, scoped as projects with the fee fixed first."
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
    title: "About Louis Bromage, Chartered Management Accountant | Bromage & Co",
    description: "A principal-led practice in Fleet, Hampshire. Meet Louis Bromage ACMA CGMA, Chartered Management Accountant, and see how Bromage & Co works with its clients."
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
  },
  {
    // The description follows the current price tier; this is only the
    // fallback for anything that reads the page without running it.
    key: "taxReturn", path: "/tax-return/",
    title: SA_BUILD.title,
    description: SA_BUILD.meta
  },
  {
    key: "saThanks", path: "/tax-return/thank-you/",
    title: "Booking confirmed | Bromage & Co",
    description: "Thank you, your Self Assessment booking with Bromage & Co is confirmed.",
    robots: "noindex,follow", sitemap: false
  },
  // Insights are served by api/insights.mjs from Supabase. The build renders
  // only the frame of these two pages (header, footer, banners), with
  // %%…%% placeholders the function fills in, and writes them to
  // api/_insights/site.mjs instead of to a file of their own.
  {
    key: "insights", path: "/insights/", template: "list",
    title: "%%TITLE%%", description: "%%DESCRIPTION%%", robots: "%%ROBOTS%%", sitemap: false
  },
  {
    key: "insight", path: "/insights/__post__/", template: "post",
    title: "%%TITLE%%", description: "%%DESCRIPTION%%", robots: "%%ROBOTS%%", sitemap: false
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

// CHROMIUM_PATH lets the build use a Chromium that is already installed.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

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

// ── 3a. Self Assessment campaign ─────────────────────────────────────────
// The design's own campaign code is replaced by tools/sa-campaign-client.js,
// so prices, dates and links come only from Supabase (campaign_prices), the
// tier follows London time, and the closed and finished states behave as briefed.
{
  // Remove one top-level declaration, from its first line to the line that
  // closes it.
  const cut = (startText, endText, what) => {
    const a = logic.indexOf(startText);
    const b = a === -1 ? -1 : logic.indexOf(endText, a);
    if (a === -1 || b === -1) fail(`could not find ${what} in the design.`);
    logic = logic.slice(0, a) + logic.slice(b + endText.length);
  };
  cut("const SA = {", "\n};\n", "the campaign price table");
  cut("const SA_STRIPE = {", "\n};\n", "the campaign payment links");
  cut("function saDate(", "; }\n", "the campaign date helper");
  cut("function saState(", "\n  return v;\n}\n", "the campaign state function");
  logic = "const SA_STRIPE = {};\nfunction saState() { return saCampaignState(); }\n" + logic;
}
logic = logic.replace(/\n  saNow\(\) \{[\s\S]*?\n  \}\n/, "\n  saNow() { return null; }\n");
// The page now comes from the URL, so drop the design's own address sniffing.
logic = logic.replace(/\n\s*if \(\/tax-return\|paid=1\/i\.test\([^\n]*\n/, "\n");
logic = logic.replace(/\n\s*if \(typeof document !== "undefined"\) document\.title = page === "taxReturn"[^\n]*\n/, "\n");
logic = logic.split("within 24 hours").join("within one working day");
logic = replaceOnce(logic, "const SA_FAQ = [", "const SA_FAQ = [\n" +
  '  { q: "What if you can\\u2019t take me on?", a: "Then your payment is refunded in full. Louis will tell you on your onboarding call, within one working day of booking, and the money goes back to the card you paid with." },',
  "the Self Assessment questions");
// Self-employment and CIS income are part of the fixed fee, not an extra.
logic = replaceOnce(logic, `const SA_INCLUDED = ["Employment and pension income", `,
  `const SA_INCLUDED = ["Employment and pension income", "Self-employment or CIS income", `, "the included list");
logic = replaceOnce(logic, `const SA_EXTRAS = ["Self-employment or CIS income", `, `const SA_EXTRAS = [`, "the extras list");
logic = replaceOnce(logic, `a: "Self-employment or CIS income, additional properties, capital gains and foreign income are added`,
  `a: "Additional properties, capital gains and foreign income are added`, "the complex return answer");
markup = replaceOnce(markup, "Everything most employees, pensioners and single-property landlords need, in the fixed fee.",
  "Everything most employees, sole traders, pensioners and single-property landlords need, in the fixed fee.", "the included intro");
logic = replaceOnce(logic, `isTaxReturn: p === "taxReturn",`, `isTaxReturn: p === "taxReturn",\n      isSaThanks: p === "saThanks",`, "the tax return page flag");
logic = replaceOnce(logic, `&& p !== "taxReturn",`, `&& p !== "taxReturn" && p !== "saThanks",`, "the shared call-to-action rule");

// ── Prices: everything the design hard-coded now comes from Supabase ─────
{
  const cut = (startText, endText, replacement, what) => {
    const a = logic.indexOf(startText);
    const b = a === -1 ? -1 : logic.indexOf(endText, a);
    if (a === -1 || b === -1) fail(`could not find ${what} in the design.`);
    logic = logic.slice(0, a) + replacement + logic.slice(b + endText.length);
  };
  // The price list the page starts with is the one read from Supabase at
  // build time; the live fetch replaces it when it arrives.
  cut("const FALLBACK_TIERS = [", "\n];\n", "const FALLBACK_TIERS = __PRICE_ROWS;\n", "the fallback price list");
  logic = replaceOnce(logic, `tiers: null, priceState: "loading",`, `tiers: __PRICE_ROWS, priceState: "live",`, "the initial price state");
  // Campaign tiers and add-ons: read live, then re-render.
  logic = replaceOnce(logic, `this.setState({ tiers: rows, priceState: "live" }, () => this.seedDefaults());`,
    `saSetRows(__saCampaignRows, rows);
      this.setState({ tiers: rows, priceState: "live" }, () => this.seedDefaults());`, "the live price update");
  logic = replaceOnce(logic, "this.loadPrices();", "this.loadPrices();\n    this.loadCampaign();", "the price loading call");
  logic = replaceOnce(logic, "  async loadPrices() {", `  async loadCampaign() {
    try {
      const res = await fetch(
        PRICING.url.replace(/\\/$/, "") + "/rest/v1/campaign_prices?select=campaign,kind,key,label,price,price_basis,active_from,active_until,payment_link,sort_order&active=eq.true&campaign=eq." + encodeURIComponent(SA_CFG.campaign) + "&order=sort_order.asc",
        { headers: { apikey: PRICING.anonKey, Authorization: "Bearer " + PRICING.anonKey } }
      );
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.some(r => r.kind === "tier")) throw new Error("no active campaign tiers");
      __saCampaignRows = rows;
      saSetRows(rows, this.state.tiers || __PRICE_ROWS);
      this.setState({ saRev: Date.now() });
    } catch (e) {
      if (typeof console !== "undefined") console.warn("[pricing] campaign prices unreachable, using the prices the page was built with:", e.message);
    }
  }

  async loadPrices() {`, "the price loader");
  // Service list: match the database categories and drop the typed-in prices.
  for (const [from, to] of [["accounts", "ct"], ["books", "bk"], ["mgmt", "ma"]])
    logic = replaceOnce(logic, `priceKey: "${from}"`, `priceKey: "${to}"`, `the ${from} price key`);
  // Payroll is the exception: its rates are not in builder_packages yet, so it
  // keeps the design's own payroll constants (the package builder uses them too).
  logic = logic.replace(/price: "[^"]*£[^"]*", priceKey: "(?!payroll")/g, `price: "", priceKey: "`);
  // "Who I work with" cards.
  logic = logic.replace(/(\{ num: "\d+", title: "[^"]*", body: "[^"]*", )price: "[^"]*£[^"]*"/g, `$1price: ""`);
  logic = replaceOnce(logic, "audiences: AUDIENCES.map(a => ({ ...a,",
    "audiences: AUDIENCES.map(a => ({ ...a, price: __audiencePrice(a, this.state.tiers || __PRICE_ROWS),", "the audience cards");
  // Service pages: starting prices come from the price list.
  logic = logic.replace(/cat: "(\w+)", fallback: \d+/g, (m, cat) => `cat: "${cat}", fallback: __minPrice(__PRICE_ROWS, "${cat}")`);
  // Campaign add-ons.
  cut("saPriceNotes: [", "\n      ],\n", "saPriceNotes: saAddonNotes(),\n", "the campaign add-on table");
  logic = replaceOnce(logic, `"Spouse or partner return, £150"`, `"Spouse or partner return, {partner}"`, "the partner extra");
  logic = replaceOnce(logic, "saExtras: SA_EXTRAS.map(label => ({ label })),", "saExtras: SA_EXTRAS.map(label => ({ label: saFill(label) })),", "the extras binding");
  logic = replaceOnce(logic, "the fee is the tier price plus £100,", "the fee is {highIncome},", "the high income answer");
  logic = replaceOnce(logic, "saFaq: SA_FAQ,", "saFaq: SA_FAQ.map(f => ({ ...f, a: saFill(f.a) })),", "the questions binding");
  const left = logic.match(/["'`][^"'`\n]*£\d[^"'`\n]*["'`]/g) || [];
  const allowed = /£1\.5 million|£(1,000|3,000|10|100,000|200,000|50,000|30,000|20,000)\b|£100 penalty|£100 penalty|charges a £100|The £100 penalty/;
  const typed = left.filter(t => !allowed.test(t));
  if (typed.length) console.warn("prices still typed into the design:\n  " + typed.join("\n  "));
}
const PRICE_HELPERS = `
var __PRICE_ROWS = ${JSON.stringify(PRICES.builder_packages)};
var __saCampaignRows = SA_SNAPSHOT.campaign_prices;
function __minPrice(rows, cat) {
  var p = (rows || []).filter(function (r) { return r.category === cat; }).map(function (r) { return Number(r.price); });
  return p.length ? Math.min.apply(null, p) : null;
}
function __tierPrice(rows, cat, key) {
  var r = (rows || []).filter(function (x) { return x.category === cat && x.tier_key === key; })[0];
  return r ? Number(r.price) : null;
}
function __audiencePrice(a, rows) {
  var n = null, from = true;
  if (a.key === "companyAccounts") n = __minPrice(rows, "ct");
  else if (a.key === "managementAccounts") n = __minPrice(rows, "ma");
  else if (a.key === "selfAssessment") { n = __tierPrice(rows, SA_CFG.standardFee.category, SA_CFG.standardFee.tierKey); from = false; }
  else return a.price;
  return n == null ? "" : (from ? "From " : "") + saMoney(n) + " / month";
}
`;
logic = SA_CLIENT + PRICE_HELPERS + "\n" + logic;

markup = markup.split("within 24 hours").join("within one working day");
// Home page hero: new copy, with the design's own styles. The headline is
// the page's single H1 (the accent line is part of it); the eyebrow is a
// paragraph. Only copy, heading size and links change here.
{
  const hero = markup.match(/<h1 style="([^"]*)">Chartered management accountant in Fleet, Hampshire<\/h1>\s*<div role="text" style="([^"]*)">Your accountant, by name\. <span style="([^"]*)">Your fee, in writing\.<\/span><\/div>\s*<p style="([^"]*)">[^<]*<\/p>\s*<div style="([^"]*)">\s*<button sc-camel-on-click="\{\{ goContact \}\}" ([^>]*)>Book a consultation<\/button>\s*<button sc-camel-on-click="\{\{ goPackage \}\}" ([^>]*)>See our fees<\/button>\s*<\/div>/);
  if (!hero) fail("could not find the home page hero.");
  const [, eyebrowStyle, headingStyle, accentStyle, subStyle, buttonsStyle, primaryAttrs, secondaryAttrs] = hero;
  const heading = headingStyle.replace(/font:500 clamp\([^)]*\)\/[.\d]+/, "font:500 clamp(33px,3.6vw,50px)/1.04");
  if (heading === headingStyle) fail("could not resize the home page heading.");
  markup = markup.replace(hero[0], `<p style="${eyebrowStyle}">Chartered Management Accountant in Fleet, Hampshire</p>
        <h1 style="${heading}">Accounts and tax for sole traders, landlords and small companies. <span style="${accentStyle}">And advice when it matters.</span></h1>
        <p style="${subStyle}">You deal with Louis directly. Fixed fees, agreed upfront.</p>
        <div style="${buttonsStyle}">
          <button sc-camel-on-click="{{ goContact }}" ${primaryAttrs}>Book a free call</button>
          <button sc-camel-on-click="{{ goPackage }}" ${secondaryAttrs}>See prices</button>
        </div>
        <button sc-camel-on-click="{{ goAdvisory }}" style="align-self:flex-start;margin-top:12px;border:0;background:transparent;padding:2px 0;text-align:left;font:400 15px/1.5 Hanken Grotesk,sans-serif;color:rgba(27,31,28,.74);text-decoration:underline;text-decoration-color:rgba(27,31,28,.3);text-underline-offset:4px" style-hover="color:#1f3d34;text-decoration-color:#1f3d34">Buying, selling or valuing a business? Advisory →</button>`);
}

// Home page hero layout: the text runs the full width, with the campaign card
// and the Services list side by side underneath (stacked on phones; the
// Services list takes the full width when the campaign card is not shown).
{
  const swap = (find, repl, what) => { markup = replaceOnce(markup, find, repl, what); };
  swap(`<div data-stack="" style="display:grid;grid-template-columns:1.25fr .75fr;gap:clamp(40px,6vw,96px);align-items:start">`,
    `<div style="display:flex;flex-direction:column;gap:clamp(44px,5vw,64px)">`, "the hero grid");
  swap(`<div style="display:flex;flex-direction:column;gap:clamp(28px,3vw,40px);min-width:0">`,
    `<div data-stack="" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:clamp(28px,3.6vw,48px);align-items:stretch">`, "the hero side column");
  // Services list: same rule as the card's border along its top, label level
  // with the card's label, slightly tighter rows.
  swap(`<nav aria-label="Services" style="display:flex;flex-direction:column;border-top:1px solid #1b1f1c">`,
    `<nav aria-label="Services" style="display:flex;flex-direction:column;border-top:2px solid #1f3d34;min-width:0">`, "the hero services list");
  // Card: a larger heading to fill the wider card, and the button row at the
  // bottom, level with the end of the list.
  swap(`font:500 clamp(30px,3vw,38px)/1.05 'Cormorant Garamond',serif;letter-spacing:-.015em;color:#1b1f1c;text-wrap:balance">{{ sa.cardHeading }}`,
    `font:500 clamp(30px,3.4vw,46px)/1.05 'Cormorant Garamond',serif;letter-spacing:-.015em;color:#1b1f1c;text-wrap:balance">{{ sa.cardHeading }}`, "the campaign card heading");
  swap(`margin-top:6px;padding-top:18px;border-top:1px solid rgba(27,31,28,.12)`,
    `margin-top:auto;padding-top:18px;border-top:1px solid rgba(27,31,28,.12)`, "the campaign card button row");
  swap(`<div style="font:600 14px/1 Hanken Grotesk,sans-serif;color:rgba(27,31,28,.66);padding:18px 0 6px">Services</div>`,
    `<div style="font:600 14px/1.2 Hanken Grotesk,sans-serif;color:#1f3d34;padding:clamp(22px,2.4vw,30px) 0 8px">Services</div>`, "the hero services label");
  swap(`style="border:0;border-bottom:1px solid #dcd8cf;background:transparent;padding:18px 0;display:flex;justify-content:space-between;align-items:baseline;gap:16px;text-align:left;color:#1b1f1c" style-hover="color:#1f3d34">
            <span style="font:500 clamp(23px,2.2vw,27px)/1.15 'Cormorant Garamond',serif;letter-spacing:-.01em">{{ h.label }}</span>`,
    `style="border:0;border-bottom:1px solid #dcd8cf;background:transparent;padding:15px 0;display:flex;justify-content:space-between;align-items:baseline;gap:16px;text-align:left;color:#1b1f1c" style-hover="color:#1f3d34">
            <span style="font:500 clamp(22px,2vw,25px)/1.2 'Cormorant Garamond',serif;letter-spacing:-.01em">{{ h.label }}</span>`, "the hero services rows");
}

// Line icons (24px grid, 1.5px stroke, in the text colour they sit in).
const ICON_PATHS = {
  building: `<path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16"/><path d="M15 9h4a1 1 0 0 1 1 1v11"/><path d="M2.5 21h19"/><path d="M8 8h3M8 12h3M8 16h3"/>`,
  home: `<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-5.5h4V20"/>`,
  sprout: `<path d="M12 21v-8.5"/><path d="M12 12.5C12 8.4 14.8 6 19.5 6c0 4.2-2.9 6.5-7.5 6.5z"/><path d="M12 14.5c0-3.2-2.3-5.5-6.5-5.5 0 3.3 2.4 5.5 6.5 5.5z"/>`,
  growth: `<path d="M3.5 20.5h17"/><path d="M5.5 16.5l4.5-4.5 3 3 6.5-7"/><path d="M15 8h4.5v4.5"/>`,
  advisory: `<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/><path d="M8 12.5v-1.5M10.5 12.5V8.5M13 12.5V10"/>`,
  finance: `<path d="M12 3.5 3 8.5l9 5 9-5-9-5z"/><path d="m3 12.5 9 5 9-5"/><path d="m3 16.5 9 5 9-5"/>`
};
// In the design template, attribute names that use capitals are written in
// the runtime's encoded form; HTML handed over as a string is not.
const iconSvg = (name, template = true) => `<svg aria-hidden="true" width="28" height="28" ${template ? "sc-camel-view-box" : "viewBox"}="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block">${ICON_PATHS[name].replace(/\/>/g, "></path>").replace(/<circle([^>]*)><\/path>/g, "<circle$1></circle>")}</svg>`;
const ICON_TILE = "display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:50%;background:#f1eee6;color:#1f3d34;flex:none";
const iconTile = name => `<span aria-hidden="true" style="${ICON_TILE}">${iconSvg(name)}</span>`;

// A sample monthly management accounts pack, as a card. The figures are
// made up and the card says so.
const SAMPLE_PACK = (() => {
  const revenue = [38.4, 41.2, 39.6, 44.1, 45.3, 48.2];
  const budget = [40, 40.5, 42, 43, 44, 45.5];
  const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];
  const W = 300, H = 112, top = 6, base = 92, max = 52, step = W / revenue.length;
  const y = v => base - (v / max) * (base - top);
  const bars = revenue.map((v, i) => `<rect x="${(i * step + step * 0.22).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(step * 0.56).toFixed(1)}" height="${(base - y(v)).toFixed(1)}" rx="2" fill="${i === revenue.length - 1 ? "#1f3d34" : "#b9cabf"}"></rect>`).join("");
  const line = budget.map((v, i) => `${i ? "L" : "M"}${(i * step + step / 2).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const labels = months.map((m, i) => `<text x="${(i * step + step / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" style="font:600 10px var(--font-body);fill:rgba(27,31,28,.66)">${m}</text>`).join("");
  const kpi = (label, value, note, edge) => `<div style="padding:12px ${edge === "last" ? "0" : "10px"} 12px ${edge === "first" ? "0" : "12px"};${edge === "first" ? "" : "border-left:1px solid #dcd8cf;"}display:flex;flex-direction:column;gap:5px;min-width:0">
          <span style="font:600 11.5px/1.2 var(--font-body);color:rgba(27,31,28,.66)">${label}</span>
          <span style="font:600 25px/1 var(--font-heading);color:#1b1f1c">${value}</span>
          <span style="font:600 11.5px/1.3 var(--font-body);color:#44705c">${note}</span>
        </div>`;
  return `<figure aria-label="Sample monthly management accounts pack, with made-up figures" style="margin:0;max-width:440px;background:#fff;border:1px solid #dcd8cf;border-radius:4px;box-shadow:0 22px 44px -18px rgba(27,31,28,.18),0 2px 6px rgba(27,31,28,.04);padding:22px 22px 20px;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div style="min-width:0">
          <div style="font:600 12.5px/1.2 var(--font-body);color:#44705c">Monthly management pack</div>
          <div style="font:600 21px/1.2 var(--font-heading);color:#1b1f1c;margin-top:6px">October, at a glance</div>
        </div>
        <span style="font:600 11px/1 var(--font-body);color:#1f3d34;background:#f1eee6;border:1px solid #dcd8cf;border-radius:999px;padding:6px 10px;white-space:nowrap">Sample figures</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid #dcd8cf;border-bottom:1px solid #dcd8cf">
        ${kpi("Revenue", "£48.2k", "6% over budget", "first")}
        ${kpi("Gross margin", "41%", "Up 2 points", "")}
        ${kpi("Cash in bank", "£62k", "7 months of runway", "last")}
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font:600 11.5px/1.2 var(--font-body);color:rgba(27,31,28,.66)">
          <span>Revenue against budget</span>
          <span style="display:inline-flex;align-items:center;gap:12px"><span style="display:inline-flex;align-items:center;gap:5px"><span style="width:9px;height:9px;border-radius:2px;background:#1f3d34;display:inline-block"></span>Revenue</span><span style="display:inline-flex;align-items:center;gap:5px"><span style="width:12px;border-top:1.5px dashed #44705c;display:inline-block"></span>Budget</span></span>
        </div>
        <svg role="img" aria-label="Revenue rising from £38k in May to £48k in October, ahead of budget for the last three months" sc-camel-view-box="0 0 ${W} ${H}" style="display:block;width:100%;height:auto">
          <path d="M0 ${base}H${W}" stroke="#dcd8cf" stroke-width="1"></path>
          ${bars}
          <path d="${line}" fill="none" stroke="#44705c" stroke-width="1.5" stroke-dasharray="4 3" stroke-linecap="round"></path>
          ${labels}
        </svg>
      </div>
      <p style="margin:0;padding:12px 14px;background:#f1eee6;border-left:2px solid #1f3d34;font:400 13.5px/1.5 var(--font-body);color:#1b1f1c"><strong style="font-weight:600">Louis's note:</strong> margin is up on the new pricing. Debtor days are creeping up, so two invoices to chase this week.</p>
    </figure>`;
})();

// A shorter home page (11 sections to 8). "How we work" repeated the
// referral steps and the case for the practice, and "What we do for you"
// repeated the services list in the hero, so both go. The Advisory and
// Outsourced finance teasers share one band, side by side, wording as it was.
{
  const home = markup.indexOf(`<sc-if value="{{ isHome }}"`);
  if (home === -1) fail("could not find the home page.");
  // The home page section (a child of its wrapper) that contains `needle`.
  const section = needle => {
    const at = markup.indexOf(needle, home);
    if (at === -1) fail(`could not find the home page section with ${needle}`);
    const re = /<(\/?)(div|section|sc-if|sc-for)\b[^>]*>/g;
    re.lastIndex = home;
    const open = [];
    for (let m; (m = re.exec(markup));) {
      if (!m[1]) { open.push(m.index); continue; }
      const start = open.pop();
      if (open.length === 2 && start < at && m.index > at) return { start, end: m.index + m[0].length };
    }
    fail(`could not find the home page section with ${needle}`);
  };
  const how = section("How we work</h2>");
  const what = section("What we do for you</h2>");
  const adv = section("Buying, selling or valuing a business?</h2>");
  const fin = section("Outgrown just the accounts?</h2>");
  if (!(how.end < what.start && what.end < adv.start && adv.end < fin.start)) fail("the home page sections have moved.");
  // Each teaser's label, heading, text and link, as one column.
  const column = (s, icon) => {
    const m = markup.slice(s.start, s.end).match(/^<div[^>]*>\s*<div>\s*(<div[^>]*>[^<]*<\/div>)\s*<h2 style="([^"]*)">([^<]*)<\/h2>\s*<\/div>\s*<div[^>]*>\s*(<p[\s\S]*?<\/p>)\s*(<button[\s\S]*?<\/button>)\s*<\/div>\s*<\/div>$/);
    if (!m) fail("a home page teaser has changed shape.");
    const [, label, hStyle, heading, text, link] = m;
    return `<div style="display:flex;flex-direction:column;gap:16px">
      ${iconTile(icon)}
      ${label.replace("margin-bottom:14px", "margin-bottom:-2px")}
      <h2 style="${hStyle.replace(/font:500 clamp\([^)]*\)/, "font:500 clamp(25px,2.8vw,32px)")}">${heading}</h2>
      ${text}
      ${link}
    </div>`;
  };
  const band = `<div data-stack-sm="" style="padding:56px clamp(20px,4.6vw,44px);border-bottom:1px solid #dcd8cf;display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:start">
    ${column(adv, "advisory")}
    ${column(fin, "finance")}
  </div>`;
  markup = markup.slice(0, how.start) + markup.slice(how.end, what.start) + band + markup.slice(fin.end);
}

// Branded visuals on the home page, drawn in the site's own colours and
// fonts (no photographs yet): a line icon for each kind of client, and a
// sample monthly management accounts pack beside "Most small businesses
// outgrow their first accountant", labelled as sample figures.
logic = `const __ICONS = ${JSON.stringify(Object.fromEntries(Object.entries({
  companyAccounts: "building", selfAssessment: "home", package: "sprout", managementAccounts: "growth"
}).map(([key, name]) => [key, iconSvg(name, false)])))};\n` + logic;
logic = replaceOnce(logic, "audiences: AUDIENCES.map(a => ({ ...a, price:",
  `audiences: AUDIENCES.map(a => ({ ...a, icon: { __html: __ICONS[a.key] || "" }, price:`, "the audience cards (icons)");
markup = replaceOnce(markup,
  `<span style="font:500 27px/1.1 'Cormorant Garamond',serif;letter-spacing:-.01em;text-wrap:balance">{{ a.title }}</span>`,
  `<span aria-hidden="true" sc-camel-dangerously-set-inner-h-t-m-l="{{ a.icon }}" style="${ICON_TILE}"></span>
          <span style="font:500 27px/1.1 'Cormorant Garamond',serif;letter-spacing:-.01em;text-wrap:balance">{{ a.title }}</span>`, "the audience card titles");
{
  const h = `<h2 style="margin:0;font:500 clamp(29px,4.8vw,44px)/1.08 'Cormorant Garamond',serif;letter-spacing:-.015em;max-width:20ch">Most small businesses outgrow their first accountant.</h2>`;
  markup = replaceOnce(markup, h, `<div style="display:flex;flex-direction:column;gap:clamp(28px,3.4vw,40px);min-width:0">
    ${h}
    ${SAMPLE_PACK}
  </div>`, "the 'Most small businesses' heading");
}

// Home page hero: the text on the left and, on the right, a small stack of
// branded cards (a records checklist, a filed return and the next deadline)
// over a faint line map of Fleet and the towns around it. Below 980px the
// visual sits under the buttons; on phones it is a simple pair of cards.
{
  const card = "background:#fff;border:1px solid #dcd8cf;border-radius:6px;box-shadow:0 24px 48px -20px rgba(27,31,28,.24),0 2px 6px rgba(27,31,28,.05)";
  const tick = (size = 20) => `<span style="width:${size}px;height:${size}px;border-radius:50%;background:#1f3d34;display:inline-flex;align-items:center;justify-content:center;flex:none"><svg width="${Math.round(size * .55)}" height="${Math.round(size * .55)}" sc-camel-view-box="0 0 12 12" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M2.5 6.5 5 9l4.5-6"></path></svg></span>`;
  const todo = `<span style="width:20px;height:20px;border-radius:50%;border:1.5px dashed #879690;box-sizing:border-box;flex:none"></span>`;
  const row = (done, text, note) => `<li style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid #e7e3da;font:500 13.5px/1.3 var(--font-body);color:${done ? "#1b1f1c" : "rgba(27,31,28,.66)"}">${done ? tick() : todo}<span style="flex:1;min-width:0">${text}</span>${note ? `<span style="font:600 11px/1.2 var(--font-body);color:#44705c;white-space:nowrap">${note}</span>` : ""}</li>`;
  // The towns (unlabelled) are placed roughly as they sit on a map, around Fleet.
  const towns = [["Fleet", 250, 236, 1], ["Church Crookham", 214, 296, 0], ["Farnborough", 372, 176, 0], ["Camberley", 404, 92, 0], ["Hook", 106, 214, 0], ["Odiham", 128, 316, 0], ["Yateley", 300, 98, 0]];
  const map = `<svg data-hv-map="" sc-camel-view-box="0 0 480 440" sc-camel-preserve-aspect-ratio="xMidYMid slice" style="position:absolute;inset:0;width:100%;height:100%;display:block">
      <path d="M-10 268 C 80 250, 150 236, 236 222 S 400 150, 490 86" fill="none" stroke="#D6DFDA" stroke-width="9" stroke-linecap="round"></path>
      <path d="M-10 268 C 80 250, 150 236, 236 222 S 400 150, 490 86" fill="none" stroke="#FCFCFA" stroke-width="2" stroke-dasharray="10 9"></path>
      <path d="M120 450 C 170 360, 220 300, 250 236 S 330 120, 320 -10" fill="none" stroke="#DCE4E0" stroke-width="3"></path>
      <path d="M40 -10 C 90 90, 110 170, 106 214 S 120 300, 128 316 S 180 420, 220 450" fill="none" stroke="#DCE4E0" stroke-width="2.5"></path>
      <path d="M250 236 C 300 210, 340 190, 372 176" fill="none" stroke="#DCE4E0" stroke-width="2.5"></path>
      <circle cx="250" cy="236" r="96" fill="none" stroke="#C9D4CE" stroke-width="1.5" stroke-dasharray="4 6"></circle>
      ${towns.map(([name, x, y, main]) => `<circle cx="${x}" cy="${y}" r="${main ? 6 : 4}" fill="${main ? "#1f3d34" : "#FCFCFA"}" stroke="#1f3d34" stroke-opacity="${main ? 1 : .45}" stroke-width="1.5"></circle>`).join("")}
    </svg>`;
  const visual = `<div data-herovis="" aria-hidden="true" style="position:relative;box-sizing:border-box;min-height:460px;border-radius:8px;background:#f1eee6;overflow:hidden">
    ${map}
    <div data-hv-list="" style="position:absolute;left:6%;top:15%;width:min(300px,84%);${card};padding:18px 18px 8px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">
        <span style="font:600 17px/1.2 var(--font-heading);color:#1b1f1c">Records for your return</span>
        <span style="font:600 11px/1 var(--font-body);color:#1f3d34;background:#f1eee6;border-radius:999px;padding:6px 9px;white-space:nowrap">3 of 4 in</span>
      </div>
      <ul style="list-style:none;margin:0;padding:0">
        ${row(true, "P60 from your employer")}
        ${row(true, "Bank interest statements")}
        ${row(true, "Rental income and costs")}
        ${row(false, "Pension contributions", "Reminder sent")}
      </ul>
    </div>
    <div data-hv-filed="" style="position:absolute;right:6%;bottom:8%;width:min(280px,78%);${card};padding:16px 18px;display:flex;gap:12px;align-items:flex-start">
      ${tick(30)}
      <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1">
        <span style="font:600 17px/1.2 var(--font-heading);color:#1b1f1c">Tax return 2025/26</span>
        <span style="font:500 13px/1.35 var(--font-body);color:rgba(27,31,28,.72)">Submitted to HMRC, 14 November</span>
        <span style="display:block;height:4px;border-radius:2px;background:#1f3d34;margin:4px 0 2px"></span>
        <span style="font:600 11.5px/1.3 var(--font-body);color:#44705c">Nothing more to do until 31 January</span>
      </div>
    </div>
    <div data-hv-chip="" style="position:absolute;right:6%;top:4.5%;${card};border-radius:999px;padding:9px 14px;display:inline-flex;align-items:center;gap:8px;font:500 12.5px/1 var(--font-body);color:#1b1f1c;white-space:nowrap">
      <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="#1f3d34" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block"><rect x="3.5" y="5" width="17" height="15.5" rx="2"></rect><path d="M3.5 10h17M8 3v4M16 3v4"></path></svg>
      Next deadline <strong style="font-weight:600">31 Jan</strong>
    </div>
  </div>`;
  const open = `<div style="display:flex;flex-direction:column;gap:28px">`;
  const at = markup.indexOf(open, markup.indexOf(`<sc-if value="{{ isHome }}"`));
  const end = markup.indexOf("</div>", markup.indexOf("Buying, selling or valuing a business? Advisory →</button>", at));
  if (at === -1 || end === -1) fail("could not find the home page hero text.");
  markup = markup.slice(0, at) +
    `<div data-herogrid="" style="display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.75fr);gap:clamp(32px,4vw,64px);align-items:center;min-width:0">
      <div style="display:flex;flex-direction:column;gap:28px;min-width:0">` +
    markup.slice(at + open.length, end + "</div>".length) + `
      ${visual}
    </div>` + markup.slice(end + "</div>".length);
  markup = replaceOnce(markup, `@media (max-width:640px){ [data-steps3]{grid-template-columns:1fr !important} }`,
    `@media (max-width:640px){ [data-steps3]{grid-template-columns:1fr !important} }
@media (max-width:980px){ [data-herogrid]{grid-template-columns:minmax(0,1fr) !important} [data-herogrid] h1{font-size:clamp(33px,5vw,50px) !important} [data-herovis]{width:100%;max-width:560px} }
@media (max-width:620px){ [data-herovis]{min-height:0 !important;padding:20px 16px;display:flex;flex-direction:column} [data-hv-list],[data-hv-filed]{position:relative !important;left:auto !important;right:auto !important;top:auto !important;bottom:auto !important;width:auto !important} [data-hv-filed]{margin:-10px 0 0 12% !important} [data-hv-list]{padding:16px 14px 6px !important} [data-hv-chip]{display:none !important} }`, "the home hero breakpoints");
}
markup = replaceOnce(markup, `<a href="#tax-return" sc-camel-on-click="{{ goTaxReturnLink }}"`,
  `<a data-nav="" href="/tax-return/" sc-camel-on-click="{{ goTaxReturnLink }}"`, "the campaign banner link");
markup = replaceOnce(markup, "<span>Call and onboarding within one working day</span>",
  "<span>Louis calls within one working day</span>", "the tax return trust line");
markup = replaceOnce(markup, "Partner returns and extras are confirmed on your call and invoiced separately.",
  "{{ sa.partnerNote }}",
  "the booking section note");

// Refunds: fully refundable until work starts on the return. The separate
// promise (a full refund if Louis can't take the return on) stays as it is.
logic = replaceOnce(logic,
  `a: "Yes, fully. If you change your mind, tell Louis and the full amount goes back to the card you paid with."`,
  `a: "Yes. Your payment is fully refundable until work starts on your return. Tell Louis and the full amount goes back to the card you paid with."`,
  "the refund answer");
for (const part of ["markup", "logic"]) {
  let src = part === "markup" ? markup : logic;
  src = src.replace(/\b(F|f)ully refundable(?! until)/g, (m, f) => `${f}ully refundable until work starts on your return`);
  if (part === "markup") markup = src; else logic = src;
}

// The home page campaign card: the same dark rule on all four sides.
markup = markup.split("border:0;border-top:2px solid #1f3d34;border-radius:0").join("border:2px solid #1f3d34;border-radius:0");

// "About Louis": no photo yet, so no placeholder and no empty column. Add a
// real photo in Claude Design and this falls away.
{
  const ph = markup.match(/(<div data-sa2="" style="[^"]*)grid-template-columns:minmax\(0,\.6fr\) minmax\(0,1\.4fr\)([^"]*">)\s*<div role="img" aria-label="Photo of Louis Bromage to be added"[^>]*>Photo of Louis<\/div>/);
  if (ph) markup = markup.replace(ph[0], `${ph[1]}grid-template-columns:minmax(0,1fr)${ph[2]}`);
}

// The card-payment reassurance line only applies while online booking is open.
{
  const trust = markup.match(/<div [^>]*>\s*<span>Pay securely by card through Stripe<\/span>[\s\S]*?<\/div>/);
  if (!trust) fail("could not find the tax return reassurance line.");
  markup = markup.replace(trust[0], `<sc-if value="{{ sa.showPhoneLink }}" hint-placeholder-val="{{ true }}">${trust[0]}</sc-if>`);
}

// Design fix: on phones the price table's note column should hide, but the
// design's rule loses to the cells' own inline style.
if (markup.includes("[data-saprice] [data-sanote]{display:none}"))
  markup = markup.replace("[data-saprice] [data-sanote]{display:none}", "[data-saprice] [data-sanote]{display:none !important}");

// "Continue without paying": a short form under the final Book button that
// sends the visitor's details to Louis (the same Formspree form as the
// contact page) instead of going to Stripe. Nothing is paid, so nothing is
// held: the fee is the one that applies on the day they pay. Shown while
// online booking is open; the hero's "Continue without paying" opens it.
const FIELD = `background:#fff;border:1px solid rgba(27,31,28,.35);border-radius:2px;color:#1b1f1c;font:400 16px/1.4 Hanken Grotesk,sans-serif;padding:13px 14px;outline:none`;
const FIELD_FOCUS = `border-color:#1f3d34;box-shadow:0 0 0 2px rgba(31,61,52,.25)`;
const LABEL = `font:600 14px/1.2 Hanken Grotesk,sans-serif;color:#1b1f1c`;
const PAY_LATER = `<sc-if value="{{ payLaterOffer }}" hint-placeholder-val="{{ true }}">
      <div id="pay-later" style="align-self:stretch;margin-top:14px;padding-top:24px;border-top:1px solid #dcd8cf;display:flex;flex-direction:column;gap:12px">
        <sc-if value="{{ payLaterShut }}" hint-placeholder-val="{{ true }}">
          <button type="button" sc-camel-on-click="{{ openPayLater }}" aria-controls="pay-later" style="align-self:flex-start;border:0;border-bottom:1px solid #1f3d34;background:transparent;padding:0 0 3px;font:600 16px/1.3 Hanken Grotesk,sans-serif;color:#1f3d34;cursor:pointer">Continue without paying</button>
          <p style="margin:0;font:400 14.5px/1.55 Hanken Grotesk,sans-serif;color:rgba(27,31,28,.72);max-width:52ch;text-wrap:pretty">Send your details and Louis will call you. Nothing is taken now, and the fee is the one that applies on the day you pay.</p>
        </sc-if>
        <sc-if value="{{ payLaterForm }}" hint-placeholder-val="{{ false }}">
          <form sc-camel-on-submit="{{ payLaterSubmit }}" aria-labelledby="pay-later-h" style="display:flex;flex-direction:column;gap:20px">
            <div style="display:flex;flex-direction:column;gap:6px">
              <div id="pay-later-h" style="font:600 18px/1.3 Hanken Grotesk,sans-serif;color:#1b1f1c">Continue without paying</div>
              <p style="margin:0;font:400 15px/1.6 Hanken Grotesk,sans-serif;color:rgba(27,31,28,.8);max-width:56ch;text-wrap:pretty">{{ payLaterNote }}</p>
            </div>
            <div data-sa2="" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px">
              <label style="display:flex;flex-direction:column;gap:8px"><span style="${LABEL}">Full name</span>
                <input name="name" sc-camel-auto-complete="name" required="{{ true }}" value="{{ saName }}" sc-camel-on-change="{{ setSaName }}" style="${FIELD}" style-focus="${FIELD_FOCUS}"></label>
              <label style="display:flex;flex-direction:column;gap:8px"><span style="${LABEL}">Email</span>
                <input name="email" type="email" sc-camel-auto-complete="email" required="{{ true }}" value="{{ saEmail }}" sc-camel-on-change="{{ setSaEmail }}" style="${FIELD}" style-focus="${FIELD_FOCUS}"></label>
            </div>
            <label style="display:flex;flex-direction:column;gap:8px;max-width:calc(50% - 10px);min-width:min(100%,260px)"><span style="${LABEL}">Phone <span style="font-weight:400;color:rgba(27,31,28,.72)">(optional)</span></span>
              <input name="phone" type="tel" sc-camel-auto-complete="tel" value="{{ saPhone }}" sc-camel-on-change="{{ setSaPhone }}" style="${FIELD}" style-focus="${FIELD_FOCUS}"></label>
            <fieldset style="border:0;margin:0;padding:0">
              <legend style="${LABEL};padding:0;margin-bottom:12px">Best way to reach you</legend>
              <div style="display:flex;gap:10px 24px;flex-wrap:wrap">
                <sc-for list="{{ saContactOpts }}" as="o" hint-placeholder-count="3">
                  <label style="display:flex;gap:10px;align-items:center;font:400 15.5px/1.4 Hanken Grotesk,sans-serif;color:#1b1f1c;cursor:pointer;padding:4px 0"><input type="radio" name="pay-later-contact" checked="{{ o.checked }}" sc-camel-on-change="{{ o.select }}" style="width:20px;height:20px;margin:0;accent-color:#1f3d34">{{ o.label }}</label>
                </sc-for>
              </div>
            </fieldset>
            <sc-if value="{{ saHasError }}" hint-placeholder-val="{{ false }}">
              <p role="alert" style="margin:0;font:500 15px/1.5 Hanken Grotesk,sans-serif;color:#8a2f1f">{{ saError }}</p>
            </sc-if>
            <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
              <button type="submit" disabled="{{ saSending }}" style="border:1px solid #1b1f1c;background:transparent;color:#1b1f1c;padding:18px 28px;font:600 16.5px/1 Hanken Grotesk,sans-serif;border-radius:2px;white-space:nowrap;cursor:pointer" style-hover="background:rgba(27,31,28,.05)">{{ payLaterLabel }}</button>
            </div>
          </form>
        </sc-if>
        <sc-if value="{{ payLaterSent }}" hint-placeholder-val="{{ false }}">
          <div role="status" style="background:#fff;border:1px solid #dcd8cf;border-radius:2px;padding:24px;display:flex;flex-direction:column;gap:8px">
            <div style="font:600 26px/1.15 'Cormorant Garamond',serif;color:#1b1f1c">Thank you, your details are in.</div>
            <p style="margin:0;font:400 16px/1.6 Hanken Grotesk,sans-serif;color:rgba(27,31,28,.8);text-wrap:pretty">{{ payLaterThanks }}</p>
          </div>
        </sc-if>
      </div>
    </sc-if>`;
logic = replaceOnce(logic, `saHidden: "", saPaid: false`, `saHidden: "", saPaid: false, payLater: false, payLaterSent: false`, "the campaign form state");
logic = replaceOnce(logic, `      saHasError: !!this.state.saError, saError: this.state.saError,\n`,
  `      saHasError: !!this.state.saError, saError: this.state.saError,
      payLaterOffer: saV.live && !saV.closed,
      payLaterShut: !this.state.payLater && !this.state.payLaterSent,
      payLaterForm: this.state.payLater && !this.state.payLaterSent,
      payLaterSent: this.state.payLaterSent,
      openPayLater: e => { if (e && e.preventDefault) e.preventDefault(); this.openPayLater(); },
      payLaterSubmit: e => { e.preventDefault(); this.payLaterSend(saV); },
      payLaterLabel: this.state.saSending ? "Sending…" : "Send my details",
      payLaterNote: "No payment is taken now. Louis will call you, and the fee is the one that applies on the day you pay: " + saV.priceText + " until " + saV.untilText + ".",
      payLaterThanks: "Louis will be in touch within one working day. When you are ready to go ahead he will send you the payment link, and the fee is the one that applies on the day you pay.",
`, "the campaign form values");
logic = replaceOnce(logic, `  dismissBanner() {\n`, `  openPayLater() {
    this.setState({ payLater: true, saError: "" }, () => {
      if (typeof document === "undefined") return;
      const el = document.getElementById("pay-later");
      if (!el) return;
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 96, behavior: "smooth" });
      const first = el.querySelector("input");
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 400);
    });
  }

  async payLaterSend(sa) {
    if (this.state.saSending) return;
    const st = this.state;
    if (!st.saName.trim() || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(st.saEmail.trim())) {
      this.setState({ saError: "Please add your name and a valid email address so Louis can reply." });
      return;
    }
    const body = {
      name: st.saName.trim(), email: st.saEmail.trim(), phone: st.saPhone.trim() || "(not given)",
      preferred_contact: st.saContact,
      booking: "Continue without paying (no payment taken)",
      price_shown: sa.priceText + " until " + sa.untilText,
      _subject: "Self Assessment ${SA_CFG.taxYear}, pay later: " + st.saName.trim(),
      source: "Tax return page, continue without paying"
    };
    this.setState({ saSending: true, saError: "" });
    try {
      const res = await fetch(FORM_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      this.setState({ saSending: false, payLaterSent: true });
    } catch (err) {
      this.setState({ saSending: false, saError: "That didn't send. Please try again, or call ${SA_CFG.phone}." });
    }
  }

  dismissBanner() {
`, "the banner dismiss method");

// Book buttons on the campaign page become links straight to the current
// Stripe payment link, each tagged with where it was clicked (client_reference_id).
const asLink = (button, href, label) => {
  const m = button.match(/^<button sc-camel-on-click="\{\{ \w+ \}\}" style="([^"]*)"([^>]*)>[\s\S]*<\/button>$/);
  if (!m) fail("could not convert a campaign button into a link.");
  return `<a href="{{ ${href} }}" style="${m[1]};text-decoration:none;display:inline-flex;align-items:center;justify-content:center"${m[2]}>{{ ${label} }}</a>`;
};
{
  const card = markup.match(/<button sc-camel-on-click="\{\{ goTaxReturn \}\}"[^>]*>Book my tax return<\/button>/);
  if (!card) fail("could not find the home page campaign card button.");
  // The card's button opens the campaign page (it stays a navigation link).
  markup = markup.replace(card[0], card[0].replace(">Book my tax return</button>", ">{{ sa.cardBook }}</button>"));
  const hero = markup.match(/<button sc-camel-on-click="\{\{ scrollBook \}\}"[^>]*>Book my tax return<\/button>/);
  if (!hero) fail("could not find the tax return page hero button.");
  markup = markup.replace(hero[0], asLink(hero[0], "sa.heroHref", "sa.bookLabel"));
  const pricing = markup.match(/<button sc-camel-on-click="\{\{ scrollBook \}\}"[^>]*>Secure my tax return →<\/button>/);
  if (!pricing) fail("could not find the tax return price table button.");
  markup = markup.replace(pricing[0], asLink(pricing[0], "sa.pricingHref", "sa.pricingLabel"));
  const heroPhone = markup.match(/<a href="tel:\+447387835746" [^>]*style-hover="background:rgba\(27,31,28,\.05\)">Call 07387 835 746<\/a>/);
  if (!heroPhone) fail("could not find the tax return page phone button.");
  // "Continue without paying" takes the phone button's place in the hero and
  // opens the pay-later form at the foot of the page; the phone number moves
  // to a link underneath. Neither shows once online booking has closed.
  {
    const at = markup.indexOf(heroPhone[0]);
    const rowEnd = markup.indexOf("</div>", at);
    const payLater = heroPhone[0]
      .replace(/^<a href="tel:\+447387835746" /, `<a href="#pay-later" sc-camel-on-click="{{ openPayLater }}" `)
      .replace(/>Call 07387 835 746<\/a>$/, ">Continue without paying</a>");
    markup = markup.slice(0, at) +
      `<sc-if value="{{ payLaterOffer }}" hint-placeholder-val="{{ true }}">${payLater}</sc-if>
    </div>
    <sc-if value="{{ sa.showPhoneLink }}" hint-placeholder-val="{{ true }}"><a href="${SA_CFG.phoneHref}" style="align-self:flex-start;margin-top:-8px;font:600 16px/1.3 Hanken Grotesk,sans-serif;color:#1f3d34;text-decoration:none;border-bottom:1px solid #1f3d34;padding-bottom:3px">Or call ${SA_CFG.phone}</a></sc-if>` +
      markup.slice(rowEnd + "</div>".length);
  }
  // The booking form becomes a final Book button: the Stripe checkout takes
  // the details, and the partner return is an add-on inside it.
  const submit = markup.match(/<button type="submit" disabled="\{\{ saSending \}\}" style="([^"]*)"([^>]*)>/);
  const from = markup.indexOf(`<sc-if value="{{ saSent }}"`);
  const formEnd = markup.indexOf("</form>", from);
  const to = markup.indexOf("</sc-if>", formEnd);
  if (!submit || from === -1 || formEnd === -1 || to === -1) fail("could not find the tax return booking form.");
  markup = markup.slice(0, from) +
    `<div style="display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:14px">
      <a href="{{ sa.footerHref }}" style="${submit[1]};text-decoration:none;display:inline-flex;align-items:center"${submit[2]}>{{ sa.bookLabel }}</a>
      <span style="font:400 14.5px/1.4 Hanken Grotesk,sans-serif;color:rgba(27,31,28,.72)">{{ sa.formNote }}</span>
      ${PAY_LATER}
    </div>` + markup.slice(to + "</sc-if>".length);
}

// Thank-you page, reached from the Stripe payment links
// (/tax-return/thank-you/?tier=<tier>&session_id=cs_...). The booking is
// counted by Google Ads when this page loads; tools/tracking-body.js sends the
// purchase value once per Checkout session.
markup = replaceOnce(markup, "<!-- ══ SHARED CTA + FOOTER ══ -->", `<!-- ══ TAX RETURN THANK YOU ══ -->
<sc-if value="{{ isSaThanks }}" hint-placeholder-val="{{ false }}">
<div style="padding:clamp(56px,8vw,112px) clamp(20px,4.6vw,48px);border-bottom:1px solid #dcd8cf;display:flex;flex-direction:column;gap:28px">
  <div style="font:600 14px/1.2 Hanken Grotesk,sans-serif;color:#1f3d34">Self Assessment ${SA_CFG.taxYear}</div>
  <h1 style="margin:0;font:500 clamp(40px,6vw,80px)/1.02 'Cormorant Garamond',serif;letter-spacing:-.02em;color:#1b1f1c;text-wrap:balance;max-width:16ch">Thank you, your booking is confirmed.</h1>
  <div style="display:flex;flex-direction:column;gap:12px;max-width:640px">
    <div style="font:600 15px/1.3 Hanken Grotesk,sans-serif;color:rgba(27,31,28,.74)">What happens next</div>
    <ol style="list-style:none;margin:0;padding:0;border-top:1px solid #1b1f1c">
    <li style="display:grid;grid-template-columns:48px minmax(0,1fr);gap:12px;align-items:baseline;padding:18px 0;border-bottom:1px solid #dcd8cf"><span aria-hidden="true" style="font:500 22px/1.1 'Cormorant Garamond',serif;color:#44705c">01</span><span style="font:400 clamp(17px,1.5vw,19px)/1.5 Hanken Grotesk,sans-serif;color:#1b1f1c">Louis will call you within one working day.</span></li>
    <li style="display:grid;grid-template-columns:48px minmax(0,1fr);gap:12px;align-items:baseline;padding:18px 0;border-bottom:1px solid #dcd8cf"><span aria-hidden="true" style="font:500 22px/1.1 'Cormorant Garamond',serif;color:#44705c">02</span><span style="font:400 clamp(17px,1.5vw,19px)/1.5 Hanken Grotesk,sans-serif;color:#1b1f1c">A quick ID check, which the law requires.</span></li>
    <li style="display:grid;grid-template-columns:48px minmax(0,1fr);gap:12px;align-items:baseline;padding:18px 0;border-bottom:1px solid #dcd8cf"><span aria-hidden="true" style="font:500 22px/1.1 'Cormorant Garamond',serif;color:#44705c">03</span><span style="font:400 clamp(17px,1.5vw,19px)/1.5 Hanken Grotesk,sans-serif;color:#1b1f1c">Your records checklist, so you can send everything in one go.</span></li>
    </ol>
  </div>
  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px">
    <a href="${SA_CFG.phoneHref}" style="border:1px solid #1f3d34;background:#1f3d34;color:#fff;padding:20px 32px;font:600 17px/1 Hanken Grotesk,sans-serif;border-radius:2px;white-space:nowrap;text-decoration:none" style-hover="background:#142b24;border-color:#142b24">Call ${SA_CFG.phone}</a>
    <a href="mailto:${SA_CFG.email}" style="border:1px solid #1b1f1c;background:transparent;color:#1b1f1c;padding:20px 30px;font:600 17px/1 Hanken Grotesk,sans-serif;border-radius:2px;white-space:nowrap;text-decoration:none" style-hover="background:rgba(27,31,28,.05)">${SA_CFG.email}</a>
  </div>
</div>
</sc-if>

<!-- ══ SHARED CTA + FOOTER ══ -->`, "the shared footer marker");

// Cookies: footer "Cookie settings" link (handled by tools/tracking-body.js),
// no search snippets from the top banners, the privacy notice's cookie
// paragraph, and no campaign banner on the thank-you page.
{
  const legal = markup.match(/<button sc-camel-on-click="\{\{ goLegal \}\}" style="([^"]*)"([^>]*)>Legal &amp; privacy<\/button>/);
  if (!legal) fail("could not find the footer Legal & privacy link.");
  markup = markup.replace(legal[0], legal[0] + `\n    <button type="button" data-cookie-settings="" style="${legal[1].replace(/;?margin-top:[^;]*/, "")}"${legal[2]}>Cookie settings</button>`);
  markup = replaceOnce(markup, `<div role="region" aria-label="Self Assessment offer"`, `<div data-nosnippet="" role="region" aria-label="Self Assessment offer"`, "the campaign banner");
  const rebrand = markup.match(/<div (style="[^"]*")>\s*<span [^>]*>Fileo &amp; Co Accounting is now Bromage &amp; Co\./);
  if (!rebrand) fail("could not find the rebrand notice.");
  markup = markup.replace(rebrand[0], rebrand[0].replace(`<div ${rebrand[1]}>`, `<div data-nosnippet="" ${rebrand[1]}>`));
  logic = replaceOnce(logic,
    `{ num: "08", title: "Cookies and tracking", body: "This site sets no advertising or analytics cookies and does not track you between sites. One small record is stored in your own browser, remembering that you closed the rebrand notice so it does not reappear. Nothing about it reaches us." }`,
    `{ num: "08", title: "Cookies", body: "We use Google advertising cookies to measure which of our adverts lead to bookings. They only run if you choose Accept in the cookie notice, and you can change your choice at any time with \\u201cCookie settings\\u201d at the foot of every page. Your browser also keeps a small note of your cookie choice and of any notice you have closed; that note stays on your device." }`,
    "the privacy notice cookie paragraph");
  logic = replaceOnce(logic, `showSaBanner: saV.live && this.state.saHidden !== saV.tier.key,`,
    `showSaBanner: saV.live && this.state.saHidden !== saV.tier.key && p !== "saThanks",`, "the campaign banner rule");
}

// ── 3a2. Site details that live in config/site.json ──────────────────────
// Google review count and profile link. Until both are filled in, the site
// says "Rated 5.0 on Google" with no link, so a placeholder can never go live.
{
  const SITE_CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "site.json"), "utf8"));
  const { count, profileUrl } = SITE_CFG.googleReviews || {};
  const reviewLink = /<a href="\[GOOGLE BUSINESS PROFILE URL\]"[^>]*style="([^"]*)"[^>]*>5\.0 from \[NUMBER\] Google reviews([^<]*)<\/a>/;
  if (count && /^https:\/\//.test(profileUrl || "")) {
    markup = markup.split("[GOOGLE BUSINESS PROFILE URL]").join(escapeAttr(profileUrl)).split("[NUMBER]").join(String(count));
    logic = logic.split("[GOOGLE BUSINESS PROFILE URL]").join(profileUrl).split("[NUMBER]").join(String(count));
  } else {
    const m = markup.match(reviewLink);
    if (m) markup = markup.replace(m[0], `<span style="${m[1].replace(/;?border-bottom:[^;]*|;?padding-bottom:[^;]*/g, "")}">Rated 5.0 on Google</span>`);
    logic = logic.replace(/\{ figure: "5\.0", label: "from \[NUMBER\] Google reviews", href: "\[GOOGLE BUSINESS PROFILE URL\]" \}/,
      `{ figure: "5.0", label: "Rated on Google" }`);
  }
  const left = (markup + logic).match(/\[[A-Z][A-Z0-9 _£]{2,}\]/);
  if (left) fail(`the design still contains the placeholder ${left[0]}. Fill it in (config/site.json) or remove it in Claude Design.`);
}

// ── 3b. Real links for navigation ────────────────────────────────────────
// Navigation buttons become real links, so crawlers can follow them and
// visitors can open pages in new tabs. Clicks still go through the design's
// own navigation.
const pathOf = Object.fromEntries(PAGES.map(p => [p.key, p.path]));
const LINK_TARGETS = {
  goHome: pathOf.home, goServices: pathOf.services, goPackage: pathOf.package,
  goContact: pathOf.contact, goAbout: pathOf.about, goAdvisory: pathOf.advisory,
  goFinance: pathOf.finance, goFinanceCall: pathOf.contact + "?topic=finance",
  goLegal: pathOf.legal, goMtd: pathOf.mtd, goTaxReturn: pathOf.taxReturn,
  "s.goPage": "{{ s.pageHref }}", "svc.goLink": "{{ svc.linkHref }}"
};
let linkCount = 0;
markup = markup.replace(/<button sc-camel-on-click="\{\{ ([\w.]+) \}\}"([^>]*)>([\s\S]*?)<\/button>/g, (whole, handler, attrs, inner) => {
  // Any list item's "x.go" handler gets a matching "x.href" (added below).
  const href = LINK_TARGETS[handler] || (/^\w+\.go$/.test(handler) ? `{{ ${handler.replace(/\.go$/, ".href")} }}` : null);
  if (!href) return whole;
  linkCount++;
  return `<a data-nav="" href="${href}" sc-camel-on-click="{{ ${handler} }}"${attrs}>${inner}</a>`;
});
if (linkCount < 15) fail(`only ${linkCount} navigation buttons found; the design has changed shape.`);

// Plain links keep the design's link colours; navigation links keep the look
// of the buttons they replace.
{
  const linkRule = /a\{color:(#[0-9a-fA-F]{3,8})\}a:hover\{color:(#[0-9a-fA-F]{3,8})\}/;
  const m = markup.match(linkRule);
  if (!m) fail("could not find the global link colour rule in the design.");
  markup = markup.replace(linkRule,
    `a:not([data-nav]){color:${m[1]}}a:not([data-nav]):hover{color:${m[2]}}\n` +
    "a[data-nav]{color:ButtonText;text-decoration:none;display:inline-block;text-align:center;cursor:pointer;box-sizing:border-box}");
}

// Page logic: read the page from the URL, keep the URL, title and
// description in step when the page changes, and support back/forward.
const ROUTER = `
const __ROUTES = ${JSON.stringify(PAGES.map(({ key, path, title, description, template }) => template ? { key, path } : { key, path, title, description }))};
const __routeFor = key => __ROUTES.find(r => r.key === key) || __ROUTES[0];
// Insights pages are written by the server (api/insights.mjs), so they keep
// the title and description they were served with.
const __servedMeta = typeof document === "undefined" ? null : {
  title: document.title,
  description: (document.querySelector('meta[name="description"]') || {}).content,
  url: (document.querySelector('link[rel="canonical"]') || {}).href
};
function __pageFromLocation() {
  if (typeof window === "undefined") return "home";
  const p = window.location.pathname.replace(/\\/index\\.html$/, "/").replace(/\\/?$/, "/");
  if (/^\\/insights\\/[^/]+\\/$/.test(p)) return "insight";
  const hit = __ROUTES.find(r => r.path === p);
  return hit ? hit.key : "home";
}
function __topicFromLocation() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("topic") || "";
}
function __applyMeta(key, topic) {
  const r = __routeFor(key);
  const served = (key === "insights" || key === "insight") && __servedMeta;
  const sa = key === "taxReturn" ? saCampaignState() : null;
  const description = served ? served.description : sa ? sa.meta : r.description;
  const title = served ? served.title : sa ? sa.title : r.title;
  document.title = title;
  const set = (sel, attr, val) => { const el = document.querySelector(sel); if (el) el.setAttribute(attr, val); };
  const url = served ? served.url : ${JSON.stringify(SITE_URL)} + r.path;
  set('meta[name="description"]', "content", description);
  set('link[rel="canonical"]', "href", url);
  set('meta[property="og:title"]', "content", title);
  set('meta[property="og:description"]', "content", description);
  set('meta[property="og:url"]', "content", url);
}
`;
logic = ROUTER + logic;
logic = replaceOnce(logic, `page: "home", open: 0,`,
  `page: __pageFromLocation(), open: 0,`, "the initial page state");
if (!/finOpen: 0, topic: ""/.test(logic)) fail("could not find the initial topic state in the design.");
logic = logic.replace(/finOpen: 0, topic: ""/, "finOpen: 0, topic: __topicFromLocation()");
logic = replaceOnce(logic, `document.title = "Bromage & Co Accounting";`,
  `__applyMeta(this.state.page, this.state.topic);
    window.addEventListener("popstate", () => {
      const page = __pageFromLocation();
      this.setState({ page, open: 0, finOpen: 0, sent: false, menu: false, mobileMenu: false, topic: __topicFromLocation() });
      __applyMeta(page);
    });`, "the page title line");
{
  const go = logic.match(/\n  go\(page, topic\) \{\n    this\.setState\(\{ page,[^\n]*\}\);\n/);
  if (!go) fail("could not find the go() navigation method in the design.");
  logic = logic.replace(go[0], go[0] + `    if (typeof window !== "undefined") {
      const target = __routeFor(page).path + (topic ? "?topic=" + encodeURIComponent(topic) : "");
      if (target !== window.location.pathname + window.location.search) window.history.pushState(null, "", target);
      __applyMeta(page, topic);
    }
`);
}
// Every list item that navigates gets the address it navigates to.
logic = logic.replace(/\bgo: \(\) => this\.go\(([^()]*)\)/g, (m, target) => `href: __routeFor(${target}).path, go: () => this.go(${target})`);
logic = logic.replace(/\bgo: \(\) => \{ this\.setState\(\{ mobileMenu: false \}\); this\.go\(([^()]*)\); \}/g,
  (m, target) => `href: __routeFor(${target}).path, ${m}`);
logic = replaceOnce(logic, `goPage: pageKey ? () => this.go(pageKey) : undefined`,
  `goPage: pageKey ? () => this.go(pageKey) : undefined, pageHref: pageKey ? __routeFor(pageKey).path : undefined`,
  "the service page links");
logic = replaceOnce(logic, `goLink: a.link ? () => this.go(a.link) : undefined,`,
  `goLink: a.link ? () => this.go(a.link) : undefined, linkHref: a.link ? __routeFor(a.link).path : undefined,`,
  "the service page side link");

// ── 3b2. Insights ────────────────────────────────────────────────────────
// "Insights" joins the header, mobile menu and footer after Prices. The
// pages themselves come from api/insights.mjs: it fills the frame rendered
// here with the posts and key dates from Supabase, and hands the design the
// same HTML (window.__INSIGHTS_HTML) so nothing changes when it takes over.
// Opening Insights from another page always loads it from the server.
logic = replaceOnce(logic, `  { key: "package", label: "Prices" },\n`,
  `  { key: "package", label: "Prices" },\n  { key: "insights", label: "Insights" },\n`, "the design's page list");
logic = replaceOnce(logic, `const active = p === n.key || (hasSub &&`,
  `const active = p === n.key || (n.key === "insights" && p === "insight") || (hasSub &&`, "the active nav item rule");
logic = replaceOnce(logic, `      isLegal: p === "legal",\n`,
  `      isLegal: p === "legal",
      isInsights: p === "insights" || p === "insight",
      insightsHtml: { __html: (typeof window !== "undefined" && window.__INSIGHTS_HTML) || "" },
`, "the legal page flag");
logic = replaceOnce(logic, `  go(page, topic) {\n`,
  `  go(page, topic) {
    if (page === "insights" && typeof window !== "undefined") { window.location.assign(__routeFor("insights").path); return; }
`, "the go() navigation method");
// With the extra item the desktop header ran 65px wider than the screen
// between 901px and about 970px, so it tightens its spacing there.
markup = replaceOnce(markup, `<div style="display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px clamp(16px,4vw,48px)">`,
  `<div data-deskbar="" style="display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px clamp(16px,4vw,48px)">`, "the header bar");
markup = replaceOnce(markup, `<div data-desk="" style="display:flex;align-items:center;gap:26px">\n      <sc-for list="{{ nav }}"`,
  `<div data-desk="" data-desknav="" style="display:flex;align-items:center;gap:26px">\n      <sc-for list="{{ nav }}"`, "the desktop nav");
markup = replaceOnce(markup, `@media (max-width:900px){ [data-desk]{display:none !important} [data-mob]{display:inline-flex !important} }`,
  `@media (max-width:900px){ [data-desk]{display:none !important} [data-mob]{display:inline-flex !important} }
@media (min-width:901px) and (max-width:1080px){ [data-deskbar]{gap:14px !important} [data-desknav]{gap:14px !important} }`, "the desktop header breakpoint");
markup = replaceOnce(markup, `<!-- ══ SHARED CTA + FOOTER ══ -->`,
  `<sc-if value="{{ isInsights }}" hint-placeholder-val="{{ false }}">
<div data-insights="" sc-camel-dangerously-set-inner-h-t-m-l="{{ insightsHtml }}"></div>
</sc-if>

<!-- ══ SHARED CTA + FOOTER ══ -->`, "the shared footer");

// ── 3b3. Header ──────────────────────────────────────────────────────────
// The desktop header, refined: a drawn chevron for Services instead of a
// text arrow, a finer underline under the current page (also announced to
// screen readers), hover states that show, a quieter phone number with an
// icon so "Book a call" is the one call to action, a little more space
// between links on wide screens, and a lightly frosted sticky bar.
logic = replaceOnce(logic, `          color: active ? "#1f3d34" : "#1b1f1c",\n`,
  `          color: active ? "#1f3d34" : "#1b1f1c",
          current: active ? "page" : undefined,
          caretTurn: subOpen ? "rotate(180deg)" : "none",
`, "the nav item colours");
markup = replaceOnce(markup,
  `sc-camel-on-click="{{ n.go }}" style="border:0;background:transparent;padding:10px 0;font:500 15.5px/1 Hanken Grotesk,sans-serif;white-space:nowrap;color:{{ n.color }};box-shadow:inset 0 -2px 0 {{ n.rule }}" style-hover="color:#1f3d34">`,
  `sc-camel-on-click="{{ n.go }}" data-navlink="" aria-current="{{ n.current }}" style="border:0;background:transparent;padding:10px 0;font:500 15px/1 Hanken Grotesk,sans-serif;letter-spacing:.01em;white-space:nowrap;color:{{ n.color }};text-decoration:underline 2px {{ n.rule }};text-underline-offset:9px">`,
  "the desktop nav links");
markup = replaceOnce(markup,
  `<button sc-camel-on-click="{{ n.toggle }}" aria-label="More services" aria-expanded="{{ n.subOpen }}" style="border:0;background:transparent;padding:10px 4px;font:400 13px/1 Hanken Grotesk,sans-serif;color:{{ n.color }}" style-hover="color:#1f3d34">{{ n.caret }}</button>`,
  `<button sc-camel-on-click="{{ n.toggle }}" aria-label="More services" aria-expanded="{{ n.subOpen }}" data-navcaret="" style="border:0;background:transparent;padding:10px 2px 10px 5px;display:inline-flex;align-items:center;color:{{ n.color }}"><svg aria-hidden="true" width="10" height="10" sc-camel-view-box="0 0 10 10" style="display:block;transition:transform .15s ease;transform:{{ n.caretTurn }}"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg></button>`,
  "the services menu arrow");
markup = replaceOnce(markup,
  `<div style="display:flex;align-items:center;gap:16px">\n      <a data-desk="" href="tel:+447387835746" style="font:600 15.5px/1 Hanken Grotesk,sans-serif;color:#1f3d34;text-decoration:none;white-space:nowrap" style-hover="color:#142b24">07387 835 746</a>`,
  `<div data-navactions="" style="display:flex;align-items:center;gap:22px">\n      <a data-desk="" data-navphone="" href="tel:+447387835746" style="font:500 15px/1 Hanken Grotesk,sans-serif;letter-spacing:.01em;color:#1b1f1c;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center;gap:8px"><svg aria-hidden="true" width="15" height="15" sc-camel-view-box="0 0 24 24" style="display:block;flex:none;color:#1f3d34"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.6 21 3 13.4 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"></path></svg>07387 835 746</a>`,
  "the header phone number");
markup = replaceOnce(markup, `<div data-desk="" data-desknav="" style="display:flex;align-items:center;gap:26px">`,
  `<div data-desk="" data-desknav="" style="display:flex;align-items:center;gap:clamp(22px,2.2vw,34px)">`, "the desktop nav spacing");
markup = replaceOnce(markup, `<div style="background:#fff;border-radius:2px;min-width:280px;display:flex;flex-direction:column;padding:8px;box-shadow:0 16px 40px rgba(27,31,28,.14)">`,
  `<div style="background:#fff;border:1px solid #dcd8cf;border-radius:2px;min-width:280px;display:flex;flex-direction:column;padding:8px;box-shadow:0 16px 40px rgba(27,31,28,.12)">`, "the services dropdown");
markup = replaceOnce(markup, `<div style="position:sticky;top:0;z-index:30;background:#f7f5f0;border-bottom:1px solid #dcd8cf">`,
  `<div style="position:sticky;top:0;z-index:30;background:color-mix(in srgb,#f7f5f0 92%,transparent);backdrop-filter:saturate(1.2) blur(10px);border-bottom:1px solid #dcd8cf">`, "the sticky header");
markup = replaceOnce(markup, `@media (min-width:901px) and (max-width:1080px){ [data-deskbar]{gap:14px !important} [data-desknav]{gap:14px !important} }`,
  `@media (min-width:901px) and (max-width:1080px){ [data-deskbar]{gap:14px !important} [data-desknav]{gap:14px !important} }
@media (min-width:901px) and (max-width:1080px){ [data-navactions]{gap:14px !important} [data-navphone] svg{display:none !important} }
[data-navlink]:not([aria-current]):hover{color:#1f3d34 !important;text-decoration-color:var(--border-strong) !important}
[data-navcaret]:hover,[data-navphone]:hover{color:#1f3d34 !important}`, "the header hover styles");

// ── 3c. Typography ───────────────────────────────────────────────────────
// Two fonts, each set once as a CSS variable in every page's head, so either
// can be swapped by changing FONTS:
//   --font-heading  EB Garamond: headings, titles and figures
//   --font-body     Hanken Grotesk: text, navigation, buttons, forms and prices
// EB Garamond comes from Google Fonts and is served from /assets/fonts (the
// files are in design/fonts/eb-garamond). The design sets fonts inline on
// each element, so every serif and sans declaration is pointed at a variable
// here. The logo keeps its own typeface.
const FONTS = {
  heading: `"EB Garamond", Georgia, "Times New Roman", serif`,
  body: `"Hanken Grotesk", system-ui, sans-serif`
};
const FONT_DIR = path.join(ROOT, "design", "fonts", "eb-garamond");
let FONT_CSS = fs.readFileSync(path.join(FONT_DIR, "eb-garamond.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
let FONT_PRELOAD = "";
fs.mkdirSync(path.join(OUT_ASSETS, "fonts"), { recursive: true });
for (const f of fs.readdirSync(FONT_DIR).filter(f => f.endsWith(".woff2"))) {
  const buf = fs.readFileSync(path.join(FONT_DIR, f));
  const rel = `/assets/fonts/${f.replace(/\.woff2$/, "")}-${hash(buf)}.woff2`;
  if (!FONT_CSS.includes(`url(${f})`)) fail(`design/fonts/eb-garamond/eb-garamond.css does not use ${f}.`);
  fs.writeFileSync(path.join(ROOT, rel), buf);
  FONT_CSS = FONT_CSS.split(`url(${f})`).join(`url(${rel})`);
  if (f === "eb-garamond-normal-latin.woff2") FONT_PRELOAD = rel;
}
if (!FONT_PRELOAD) fail("design/fonts/eb-garamond has no eb-garamond-normal-latin.woff2.");
FONT_CSS = `:root{--font-heading:${FONTS.heading};--font-body:${FONTS.body}}h1,h2,h3{text-wrap:balance}` +
  FONT_CSS.replace(/\s*\n\s*/g, "");

{
  // Each serif element is restyled by its tag and what it contains:
  //   h1 (the hero included)  EB Garamond 500, line height 1.1
  //   h2, h3                  EB Garamond 600, line height 1.15
  //   other titles            EB Garamond 600 at their existing size and spacing,
  //                           so every heading has the same weight whatever its tag
  //   prices                  the sans, 600
  //   the logo                unchanged
  //   anything else           EB Garamond at its existing weight and spacing
  //                           (figures, step numbers, options, the quote)
  const SERIF = /font:(italic )?(\d{3})( italic)? ((?:clamp\([^)]*\)|[\d.]+px))\/([\d.]+) 'Cormorant Garamond',serif/;
  const LOGO = /^(<span aria-hidden="true" style="width:34px;height:34px|B<span style="color:#6f8f7c">C<\/span>)/;
  const PRICE = /^\s*(£|\{\{ (t\.priceLabel|svc\.priceFig) \}\})/;
  const TITLE = new RegExp("^\\s*(" + [
    /\{\{ (sa\.cardHeading|a\.title|f\.q|r\.title|saThanksHeading) \}\}/, // card, FAQ and section item titles
    /Your package is ready|Thank you\{\{ sentName \}\}/,                     // form confirmations
    /Pay through your tax code|Know where you stand on MTD/                 // "Why file early"
  ].map(r => r.source).join("|") + ")");
  const count = { logo: 0, price: 0, title: 0 };
  markup = markup.replace(/ style="([^"]*'Cormorant Garamond',serif[^"]*)"/g, (attr, style, at) => {
    const tag = markup.slice(markup.lastIndexOf("<", at) + 1, at).match(/^[a-z][a-z0-9-]*/)[0];
    const content = markup.slice(markup.indexOf(">", at) + 1, markup.indexOf(">", at) + 120);
    const m = style.match(SERIF);
    if (!m) fail(`a serif style on <${tag}> has an unexpected shape: ${style}`);
    const [decl, italic1, weight, italic2, size, lineHeight] = m;
    const italic = italic1 || italic2 ? "italic " : "";
    if (LOGO.test(content)) { count.logo++; return attr; }
    let font;
    if (PRICE.test(content)) {
      // The sans sets larger than the serif at the same size, so prices are
      // scaled to keep each figure's footprint.
      count.price++;
      font = `font:600 ${Math.round(parseFloat(size) * 0.8)}px/${lineHeight} var(--font-body);letter-spacing:-.02em`;
      style = style.replace(/;?letter-spacing:[^;]*/, "");
    } else if (tag === "h1") {
      font = `font:${italic}500 ${size}/1.1 var(--font-heading)`;
    } else if (tag === "h2" || tag === "h3") {
      font = `font:${italic}600 ${size}/1.15 var(--font-heading)`;
    } else if (tag === "h4" || tag === "summary" || TITLE.test(content)) {
      count.title++;
      font = `font:${italic}600 ${size}/${lineHeight} var(--font-heading)`;
    } else {
      font = `font:${italic}${weight} ${size}/${lineHeight} var(--font-heading)`;
    }
    return ` style="${style.replace(decl, font)}"`;
  });
  if (count.logo !== 4) fail(`expected the logo in 4 places, found ${count.logo}.`);
  if (count.price !== 5) fail(`expected 5 serif prices, found ${count.price}. Check PRICE in the typography step.`);
  if (count.title !== 21) fail(`expected 21 serif titles, found ${count.title}. Check TITLE in the typography step.`);
  // EB Garamond sets wider than the serif it replaces; at up to 120px the tax
  // return headline broke onto a third line on desktop.
  markup = replaceOnce(markup, `font:500 clamp(48px,8.6vw,120px)/1.1 var(--font-heading)`,
    `font:500 clamp(48px,7vw,96px)/1.1 var(--font-heading)`, "the tax return headline size");

  // The sans, wherever the design names it (but not its @font-face rules).
  const SANS = /'?Hanken Grotesk'?,(system-ui,)?sans-serif/g;
  markup = markup.replace(/ style="[^"]*"|font-family:Hanken Grotesk,system-ui,sans-serif/g, s => s.replace(SANS, "var(--font-body)"));
  logic = logic.replace(SANS, "var(--font-body)");
  if (/Hanken Grotesk'?,/.test(markup + logic)) fail("a sans style was left behind by the typography step.");

  // Every font is served from this site, so the design's preconnect to
  // Google Fonts only opens a connection that is never used.
  markup = markup.replace(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*/, "");
}

// ── 3d. Colours ──────────────────────────────────────────────────────────
// A near-white scheme, set once as CSS variables in every page's head. To
// change a colour, change THEME and rebuild. The design's warm beige and
// tan tones are pointed at these variables here.
const THEME = {
  "bg": "#FCFCFA",            // page background
  "bg-alt": "#F3F6F4",        // tinted sections: banners, FAQs, prices
  "surface": "#FFFFFF",       // cards, forms and inputs
  "border": "#E3E8E5",        // dividers and card borders
  "border-soft": "#ECF0ED",   // the lightest dividers, inside lists
  "border-strong": "#CFD8D3", // outlines that need a little more weight
  "border-input": "#879690",  // form fields (3:1 against white, WCAG 1.4.11)
  "accent": "#1f3d34",        // headings, buttons and accents
  "accent-dark": "#142b24",   // button hover
  "on-accent": "#FCFCFA"      // text on the accent green
};
const THEME_CSS = `:root{${Object.entries(THEME).map(([k, v]) => `--${k}:${v}`).join(";")}}`;
{
  // SVG presentation attributes cannot read CSS variables, so drawings get
  // the equivalent colour itself.
  const SVG = { "#fbfaf6": THEME.bg, "#f1eee6": THEME["bg-alt"], "#e2ddd2": THEME.border, "#c9c2b4": "#C3CEC8", "#6b665b": "#5C6A63", "#dcd8cf": THEME.border };
  const recolour = s => s
    .replace(/\b(fill|stroke|stop-color)="(#[0-9a-fA-F]{6})"/g, (m, a, c) => SVG[c.toLowerCase()] ? `${a}="${SVG[c.toLowerCase()]}"` : m)
    .replace(/rgba\(251,\s*248,\s*242,/g, "rgba(252,252,250,")
    .replace(/(^|[^-])color:\s*#f7f5f0/gi, "$1color:var(--on-accent)")
    .replace(/#fbf8f2/gi, "var(--on-accent)")
    .replace(/#f7f5f0|#fbfaf6/gi, "var(--bg)")
    .replace(/#f1eee6|#efece4|#f3ede3/gi, "var(--bg-alt)")
    .replace(/#dcd8cf|#ebe3d6/gi, "var(--border)")
    .replace(/#e7e3da/gi, "var(--border-soft)")
    .replace(/background:\s*#fff(fff)?\b/gi, "background:var(--surface)")
    // The Fleet area map's road and label colours, set as styles.
    .replace(/#c9c2b4/gi, "#C3CEC8").replace(/#6b665b/gi, "#5C6A63").replace(/#e2ddd2/gi, "var(--border)");
  logic = replaceOnce(logic, `fg: e.key === this.state.entity ? "#f7f5f0" : "#1b1f1c",`,
    `fg: e.key === this.state.entity ? "var(--on-accent)" : "#1b1f1c",`, "the business type button colours");
  markup = recolour(markup);
  logic = recolour(logic);
  const WARM = /#(f7f5f0|fbf8f2|fbfaf6|f1eee6|efece4|f3ede3|dcd8cf|ebe3d6|e7e3da|e2ddd2|c9c2b4|6b665b)\b|251,\s*248,\s*242/i;
  const left = (markup + logic).match(WARM);
  if (left) fail(`a beige colour (${left[0]}) was left behind by the colour step.`);

  // Unselected options in the package builder and forms are white cards.
  for (const [find, repl] of [
    [`bg: on ? "#1f3d34" : "transparent",`, `bg: on ? "#1f3d34" : "var(--surface)",`],
    [`bg: tOn ? "#1f3d34" : "transparent",`, `bg: tOn ? "#1f3d34" : "var(--surface)",`],
    [`noneBg: on ? "transparent" : "rgba(47,85,70,.16)",`, `noneBg: on ? "var(--surface)" : "rgba(47,85,70,.16)",`],
    [`bg: e.key === this.state.entity ? "#1f3d34" : "#fff",`, `bg: e.key === this.state.entity ? "#1f3d34" : "var(--surface)",`]
  ]) logic = replaceOnce(logic, find, repl, "a package builder option colour");

  // Form fields: white, with a border that meets 3:1.
  let fields = 0;
  markup = markup.replace(/<(input|textarea|select)\b[^>]*>/g, tag => tag.replace(/border:1px solid rgba\(27,31,28,\.[23]\d?\)/, () => { fields++; return "border:1px solid var(--border-input)"; }));
  if (fields < 6) fail(`expected at least 6 form fields with a border, found ${fields}.`);

  // The home page campaign card is a white card.
  markup = markup.replace(/(<div[^>]*aria-label="Self Assessment 2025\/26 offer"[^>]*style="[^"]*?)background:var\(--bg-alt\)/, (m, pre) => pre + "background:var(--surface)");
  if (!/aria-label="Self Assessment 2025\/26 offer"[^>]*background:var\(--surface\)|background:var\(--surface\)[^>]*aria-label="Self Assessment 2025\/26 offer"/.test(markup))
    fail("could not make the home page campaign card white.");

  // Tinted sections, alternating with the page: questions, prices and the
  // package builder (the referral band and "Why file early" already were).
  const tint = (find, count, what) => {
    const n = markup.split(find).length - 1;
    if (n !== count) fail(`expected ${count} of ${what}, found ${n}.`);
    markup = markup.split(find).join(find.replace(`style="`, `style="background:var(--bg-alt);`));
  };
  tint(`<div data-stack="" style="padding:70px clamp(20px,4.6vw,44px);display:grid;grid-template-columns:.8fr 1.2fr;gap:52px;border-bottom:1px solid var(--border)">`, 2, "the home and outsourced finance questions");
  tint(`<div data-stack="" style="padding:64px clamp(20px,4.6vw,44px);display:grid;grid-template-columns:.8fr 1.2fr;gap:52px;border-bottom:1px solid var(--border)">`, 1, "the service page questions");
  tint(`<div data-sa2="" style="padding:clamp(48px,6vw,88px) clamp(20px,4.6vw,48px);border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:clamp(28px,3.5vw,40px)">`, 1, "the tax return prices");
  tint(`<div data-sa2="" style="padding:clamp(48px,6vw,88px) clamp(20px,4.6vw,48px);border-bottom:1px solid var(--border);display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:clamp(32px,5vw,72px);align-items:start">`, 1, "the tax return questions");
  tint(`<div data-stack="" style="display:grid;grid-template-columns:1fr 340px;border-bottom:1px solid var(--border)">`, 1, "the package builder");
}

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

// Inline JSON safely inside a <script> element.
const scriptJson = v => JSON.stringify(v).replace(/</g, "\\u003c");

function shell(page, { head = "", body = "", variants = {}, robots = page.robots || "index,follow" }) {
  const url = page.template ? "%%URL%%" : SITE_URL + page.path;
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
<meta name="theme-color" content="${THEME.bg}">
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
<script>
${SA_CLIENT}
${page.key === "taxReturn" ? `(function () {
  var s = saCampaignState(), d = s.meta;
  document.title = s.title;
  document.querySelector('meta[property="og:title"]').setAttribute("content", s.title);
  document.querySelector('meta[name="description"]').setAttribute("content", d);
  document.querySelector('meta[property="og:description"]').setAttribute("content", d);
})();` : ""}
</script>
<link rel="preload" href="${FONT_PRELOAD}" as="font" type="font/woff2" crossorigin>
<style data-fonts>${THEME_CSS}${FONT_CSS}</style>
<style>x-dc{display:none!important}html:not(.sa-ok) [data-sa-dyn]{visibility:hidden}</style>
<noscript><style>[data-sa-dyn]{visibility:visible!important}</style></noscript>
<script>
var BC_TRACKING = ${scriptJson({ ...TRACKING, thankYouPage: page.key === "saThanks" })};
${TRACKING_HEAD}</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${TRACKING.tagId}"></script>
<style>${BANNER_CSS}</style>
${head}
${page.template ? `<script>window.__INSIGHTS_HTML = "%%INSIGHTS_HTML%%";</script>\n<!--%%INSIGHTS_HEAD%%-->\n` : ""}<script>window.__resources = {};</script>
<script defer src="${reactSrc}"></script>
<script defer src="${reactDomSrc}"></script>
<script defer src="${runtimeSrc}"></script>
</head>
<body>
<div id="prerender">${body}</div>
<script>
(function () {
  // The page was pre-rendered for one campaign state. Swap in the parts that
  // differ for today's state before anything is painted, so the price shown
  // is never stale, then honour any banner the visitor has dismissed.
  var V = ${scriptJson(variants)}, built = ${scriptJson(SA_BUILD_STATE)};
  var st = saCampaignState().key, pre = document.getElementById("prerender");
  if (st !== built) {
    var nodes = pre.querySelectorAll("[data-sa-dyn]");
    for (var i = 0; i < nodes.length; i++) {
      var v = V[nodes[i].getAttribute("data-sa-dyn")];
      if (v && v[st] != null) nodes[i].outerHTML = v[st];
    }
  }
  try {
    if (window.localStorage.getItem("bc-sa-banner") === st) {
      var b = pre.querySelector('[aria-label="Self Assessment offer"]');
      if (b) b.parentNode.removeChild(b);
    }
    if (window.localStorage.getItem("bc-rebrand-notice") === "dismissed") {
      var d = pre.querySelector('button[aria-label="Dismiss notice"]');
      if (d && d.parentNode) d.parentNode.parentNode.removeChild(d.parentNode);
    }
  } catch (e) {}
  document.documentElement.className += " sa-ok";
})();
</script>
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
<section id="cc" role="region" aria-label="Cookie choice" aria-live="polite" data-nosnippet hidden></section>
<script>
${TRACKING_BODY}</script>
${page.template ? "<!--%%INSIGHTS_BODY%%-->\n" : ""}</body>
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

// Render one page in one campaign state (?saPreview works on the local build
// server) and capture its HTML and styles.
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
async function renderState(page, state) {
  const tab = await context.newPage();
  const errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  // Answer the page's Supabase price requests with the rows this build read,
  // so the pre-rendered page matches what a visitor's browser loads.
  await tab.route(/\.supabase\.co\/rest\/v1\/(builder_packages|campaign_prices)\?/, route => {
    const table = route.request().url().match(/rest\/v1\/(\w+)/)[1];
    const rows = table === "campaign_prices" ? SA_ROWS : PRICES.builder_packages;
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) });
  });
  await tab.goto(`${ORIGIN}${page.path}?saPreview=${state}`, { waitUntil: "networkidle" });
  await tab.waitForFunction(() => {
    const r = document.getElementById("dc-root");
    return r && r.innerText.trim().length > 200 && !document.getElementById("prerender");
  }, null, { timeout: 30000 });
  await tab.waitForTimeout(400);
  if (errors.length) fail(`${page.path} (${state}) threw: ${errors.join("; ")}`);
  const snap = await tab.evaluate(() => {
    // Hover and focus styles get numbered class names in render order, which
    // differ between states; rename each after its own rule so they line up.
    const hashOf = s => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(36); };
    const rename = {};
    const css = [];
    for (const el of document.head.querySelectorAll("style:not([data-fonts])")) {
      let rules;
      try { rules = [...el.sheet.cssRules]; } catch { css.push(el.textContent); continue; }
      for (const r of rules) {
        let text = r.cssText;
        const m = r.selectorText && r.selectorText.match(/^\.(scp[0-9a-z]+)(::?[\w-]+)$/);
        if (m) {
          const name = "p" + hashOf(m[2] + r.style.cssText);
          rename[m[1]] = name;
          text = text.replace("." + m[1], "." + name);
        }
        css.push(text);
      }
    }
    const root = document.getElementById("dc-root").cloneNode(true);
    root.querySelectorAll("[data-dc-tpl]").forEach(el => el.removeAttribute("data-dc-tpl"));
    root.querySelectorAll("[class]").forEach(el =>
      el.setAttribute("class", el.getAttribute("class").split(/\s+/).map(c => rename[c] || c).join(" ")));
    const h1 = document.querySelector("#dc-root h1");
    return { css, html: root.innerHTML, h1: h1 ? h1.innerText : "", text: document.getElementById("dc-root").innerText.length };
  });
  await tab.close();
  return snap;
}

// Combine one page's renders: the build-day state is written out in full, and
// each element that differs between states is marked so the page script can
// swap in the right version.
const mergeTab = await browser.newPage();
async function mergeStates(byState) {
  return mergeTab.evaluate(({ byState, states, built }) => {
    const parse = h => { const d = document.createElement("div"); d.innerHTML = h; return d; };
    const roots = states.map(s => parse(byState[s].html));
    const variants = {};
    let n = 0;
    const sameAttrs = els => els.every(e => e.attributes.length === els[0].attributes.length &&
      [...els[0].attributes].every(at => e.getAttribute(at.name) === at.value));
    const mark = els => {
      if (els[0] === roots[0]) throw new Error("the whole page differs between campaign states");
      const id = String(n++);
      els.forEach(e => e.setAttribute("data-sa-dyn", id));
      variants[id] = {};
      states.forEach((s, i) => { variants[id][s] = els[i].outerHTML; });
    };
    const walk = els => {
      if (els.every(e => e.outerHTML === els[0].outerHTML)) return;
      const kids = els.map(e => [...e.childNodes]);
      const k0 = kids[0];
      const sameShape = kids.every(k => k.length === k0.length &&
        k.every((c, i) => c.nodeType === k0[i].nodeType && c.nodeName === k0[i].nodeName));
      const sameText = sameShape && k0.every((c, i) => c.nodeType === 1 || kids.every(k => k[i].textContent === c.textContent));
      if (!sameShape || !sameText || !sameAttrs(els)) { mark(els); return; }
      k0.forEach((c, i) => { if (c.nodeType === 1) walk(kids.map(k => k[i])); });
    };
    walk(roots);
    const css = [];
    const seen = new Set();
    for (const s of [built, ...states]) for (const r of byState[s].css) if (!seen.has(r)) { seen.add(r); css.push(r); }
    return { html: roots[states.indexOf(built)].innerHTML, variants, css: css.join("\n"), dynamic: n };
  }, { byState, states: SA_STATES, built: SA_BUILD_STATE });
}

const rendered = {};
for (const page of PAGES) {
  const byState = {};
  for (const state of SA_STATES) byState[state] = await renderState(page, state);
  rendered[page.key] = await mergeStates(byState);
  const b = byState[SA_BUILD_STATE];
  console.log(`rendered ${page.path.padEnd(32)} h1: ${JSON.stringify(b.h1)}  (${b.text} chars, ${rendered[page.key].dynamic} parts vary by campaign state)`);
}
await mergeTab.close();

// Second pass: full pages with the rendered content and styles inline.
const pageCss = key => `<style id="prerender-css">${rendered[key].css.replace(/<\/style/gi, "<\\/style")}</style>`;
const insightTemplates = {};
for (const page of PAGES) {
  const html = shell(page, { head: pageCss(page.key), body: rendered[page.key].html, variants: rendered[page.key].variants });
  if (page.template) {
    for (const mark of ["%%INSIGHTS_HTML%%", "<!--%%INSIGHTS_HEAD%%-->", "<!--%%INSIGHTS_BODY%%-->", "%%TITLE%%", "%%DESCRIPTION%%", "%%URL%%", "%%ROBOTS%%"])
      if (!html.includes(mark)) fail(`the ${page.key} page frame has no ${mark}.`);
    if (!/<div data-insights=""[^>]*>%%INSIGHTS_HTML%%<\/div>/.test(html)) fail(`the ${page.key} page frame did not render its content area.`);
    insightTemplates[page.template] = html;
  } else {
    fs.writeFileSync(outFile(page.path), html);
  }
}
// Nothing may be left at /insights/: a file there would be served instead of
// the function.
fs.rmSync(path.join(ROOT, "insights"), { recursive: true, force: true });

// Not-found page: the home page content, marked noindex.
const notFound = { ...PAGES[0], title: "Page not found | " + SITE_NAME };
fs.writeFileSync(path.join(ROOT, "404.html"),
  shell(notFound, { head: pageCss("home"), body: rendered.home.html, variants: rendered.home.variants, robots: "noindex,follow" }));

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
    <div style="width:1200px;height:630px;background:#1f3d34;color:${THEME["on-accent"]};display:flex;flex-direction:column;justify-content:center;padding:0 96px;box-sizing:border-box">
      <div style="font:500 128px/1 'Cormorant Garamond',Georgia,serif;letter-spacing:-.02em">Bromage &amp; Co</div>
      <div style="font:500 44px/1.2 'Cormorant Garamond',Georgia,serif;margin-top:48px;max-width:900px">Your accountant, by name. <i style="color:#b9cabf">Your fee, in writing.</i></div>
      <div style="font:500 24px/1.4 'Hanken Grotesk',sans-serif;color:#d3dcd5;margin-top:22px">Chartered Management Accountant · Fleet, Hampshire</div>
    </div></body></html>`, { waitUntil: "networkidle" });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: path.join(ROOT, "social-card.png") });
  await tab.close();
}

await browser.close();
server.close();

// ── 6. Sitemap and robots.txt ─────────────────────────────────────────────

// The sitemap is served by api/sitemap.mjs so that it lists each insight as
// soon as it is published; the build supplies the fixed pages. A sitemap.xml
// file would be served instead of the function, so there must not be one.
const today = new Date().toISOString().slice(0, 10);
fs.rmSync(path.join(ROOT, "sitemap.xml"), { force: true });
fs.writeFileSync(path.join(ROOT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);

// Everything api/insights.mjs and api/sitemap.mjs need from the build.
fs.mkdirSync(path.join(ROOT, "api", "_insights"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "api", "_insights", "site.mjs"),
  `// Written by tools/build.mjs; do not edit. Rebuild the site to change it.
export const SITE_URL = ${JSON.stringify(SITE_URL)};
export const SITE_NAME = ${JSON.stringify(SITE_NAME)};
export const ORG_ID = ${JSON.stringify(ORG["@id"])};
export const SUPABASE = ${JSON.stringify(SUPABASE)};
export const STATIC_PAGES = ${JSON.stringify(PAGES.filter(p => p.sitemap !== false && !p.template).map(p => ({ loc: SITE_URL + p.path, lastmod: today })), null, 1)};
export const TEMPLATES = ${JSON.stringify(insightTemplates)};
`);

console.log(`done: ${PAGES.filter(p => !p.template).length} pages written, plus the insights page frames in api/_insights/site.mjs`);
