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

// ── Prices from Supabase ──────────────────────────────────────────────────
// Every price on the site comes from Supabase: public.builder_packages (the
// price list) and public.campaign_prices (campaign tiers and add-ons). The
// live site reads both in the visitor's browser. The build reads them too,
// so the pre-rendered pages show the same prices; if Supabase cannot be
// reached it uses the copy saved by the last build that could
// (config/prices-snapshot.json) and says so.
const SNAPSHOT_FILE = path.join(ROOT, "config", "prices-snapshot.json");
const PRICES = await (async () => {
  const raw = fs.readFileSync(EXPORT, "utf8");
  const url = (raw.match(/url: \\"(https:\/\/[a-z0-9]+\.supabase\.co)\\"/) || [])[1];
  const key = (raw.match(/anonKey: \\"(eyJ[A-Za-z0-9._-]+)\\"/) || [])[1];
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
    title: "Thank you for booking | Bromage & Co",
    description: "Thank you for booking your Self Assessment tax return with Bromage & Co.",
    robots: "noindex,follow", sitemap: false
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
markup = replaceOnce(markup, "Chartered management accountant in Fleet, Hampshire</h1>",
  "Chartered Management Accountant in Fleet, Hampshire</h1>", "the home page heading");
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
  markup = markup.replace(heroPhone[0], `<sc-if value="{{ sa.showPhoneLink }}" hint-placeholder-val="{{ true }}">${heroPhone[0]}</sc-if>`);
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
    </div>` + markup.slice(to + "</sc-if>".length);
}

// Thank-you page, reached from the Stripe payment links. The Google Ads
// conversion tag goes in config/sa-campaign.json (googleAdsConversionSnippet).
markup = replaceOnce(markup, "<!-- ══ SHARED CTA + FOOTER ══ -->", `<!-- ══ TAX RETURN THANK YOU ══ -->
<sc-if value="{{ isSaThanks }}" hint-placeholder-val="{{ false }}">
<div style="padding:clamp(56px,8vw,112px) clamp(20px,4.6vw,48px);border-bottom:1px solid #dcd8cf;display:flex;flex-direction:column;gap:24px">
  <div style="font:600 14px/1.2 Hanken Grotesk,sans-serif;color:#1f3d34">Self Assessment ${SA_CFG.taxYear}</div>
  <h1 style="margin:0;font:500 clamp(44px,6.4vw,84px)/1 'Cormorant Garamond',serif;letter-spacing:-.02em;color:#1b1f1c;text-wrap:balance">Thank you for booking.</h1>
  <p style="margin:0;font:400 clamp(18px,1.7vw,21px)/1.6 Hanken Grotesk,sans-serif;color:rgba(27,31,28,.8);max-width:58ch;text-wrap:pretty">Louis will call you within one working day to take you through onboarding: a quick ID check and the list of records we need.</p>
  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">
    <a href="${SA_CFG.phoneHref}" style="border:1px solid #1f3d34;background:#1f3d34;color:#fff;padding:20px 32px;font:600 17px/1 Hanken Grotesk,sans-serif;border-radius:2px;white-space:nowrap;text-decoration:none" style-hover="background:#142b24;border-color:#142b24">Call ${SA_CFG.phone}</a>
    <a href="mailto:${SA_CFG.email}" style="border:1px solid #1b1f1c;background:transparent;color:#1b1f1c;padding:20px 30px;font:600 17px/1 Hanken Grotesk,sans-serif;border-radius:2px;white-space:nowrap;text-decoration:none" style-hover="background:rgba(27,31,28,.05)">${SA_CFG.email}</a>
  </div>
</div>
</sc-if>

<!-- ══ SHARED CTA + FOOTER ══ -->`, "the shared footer marker");

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
  const sa = key === "taxReturn" ? saCampaignState() : null;
  const description = sa ? sa.meta : r.description;
  const title = sa ? sa.title : r.title;
  document.title = title;
  const set = (sel, attr, val) => { const el = document.querySelector(sel); if (el) el.setAttribute(attr, val); };
  const url = ${JSON.stringify(SITE_URL)} + r.path;
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
  const conversion = page.key === "saThanks" ? `
<!-- Google Ads conversion tag: set googleAdsConversionSnippet in config/sa-campaign.json and rebuild. -->
${SA_CFG.googleAdsConversionSnippet || "<!-- PLACEHOLDER: Google Ads conversion tag not supplied yet. -->"}` : "";
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
<meta name="theme-color" content="#1f3d34">
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
<style>x-dc{display:none!important}html:not(.sa-ok) [data-sa-dyn]{visibility:hidden}</style>
<noscript><style>[data-sa-dyn]{visibility:visible!important}</style></noscript>${conversion}
${head}
<script>window.__resources = {};</script>
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
    for (const el of document.head.querySelectorAll("style")) {
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
for (const page of PAGES) {
  fs.writeFileSync(outFile(page.path), shell(page, { head: pageCss(page.key), body: rendered[page.key].html, variants: rendered[page.key].variants }));
}

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
    <div style="width:1200px;height:630px;background:#1f3d34;color:#f4f1ea;display:flex;flex-direction:column;justify-content:center;padding:0 96px;box-sizing:border-box">
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

const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(ROOT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.filter(p => p.sitemap !== false).map(p => `  <url><loc>${SITE_URL}${p.path}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`);
fs.writeFileSync(path.join(ROOT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);

console.log("done: " + PAGES.length + " pages written");
