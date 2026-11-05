// Insights pages and the sitemap, rendered from Supabase.
//
// The build (tools/build.mjs) renders the frame of each page from the
// design, with the header, footer and banners, and writes it to site.mjs
// with %%…%% placeholders. This module fills those in:
//   %%INSIGHTS_HTML%%          the page content (also handed to the design,
//                              which shows the same HTML once it takes over)
//   %%TITLE%% %%DESCRIPTION%%  title and meta description
//   %%URL%% %%ROBOTS%%         canonical address and robots rule
//   <!--%%INSIGHTS_HEAD%%-->   styles, article tags and structured data
//   <!--%%INSIGHTS_BODY%%-->   the topic filter script

import { Marked } from "./marked.mjs";
import { SITE_URL, SITE_NAME, ORG_ID, SUPABASE, STATIC_PAGES, TEMPLATES } from "./site.mjs";

export const CATEGORIES = [
  { key: "tax", label: "Tax" },
  { key: "rates-money", label: "Rates & Money" },
  { key: "deadlines", label: "Deadlines" },
  { key: "rules-regulation", label: "Rules & Regulation" }
];
const categoryKey = label => (CATEGORIES.find(c => c.label === label) || {}).key || "";

const KEY_DATES_SHOWN = 4;
const MORE_SHOWN = 3;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// How long the CDN keeps a page before fetching it again: an hour, then
// serve the old copy while a fresh one is made in the background.
const CACHE_OK = "max-age=3600, stale-while-revalidate=86400";
const CACHE_MISSING = "max-age=300";

// ── Helpers ───────────────────────────────────────────────────────────────

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonInScript = v => JSON.stringify(v).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, c => "\\u" + c.charCodeAt(0).toString(16));

const londonDay = d => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const longDate = d => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "long", year: "numeric" }).format(d);
// A plain calendar date such as "2027-01-31", read at midday so no time
// zone can move it to another day.
const calendar = iso => new Date(String(iso).slice(0, 10) + "T12:00:00Z");

async function rest(table, query) {
  const res = await fetch(`${SUPABASE.url.replace(/\/$/, "")}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE.anonKey, Authorization: `Bearer ${SUPABASE.anonKey}` },
    signal: AbortSignal.timeout(6000)
  });
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
  return res.json();
}

// Row-level security returns only published posts whose date has passed.
const LIST_FIELDS = "slug,title,summary,category,published_at,updated_at";
export const fetchPosts = (limit = 500) =>
  rest("insights", `select=${LIST_FIELDS}&order=published_at.desc&limit=${limit}`);
export const fetchPost = slug =>
  rest("insights", `select=${LIST_FIELDS},body&slug=eq.${encodeURIComponent(slug)}&limit=1`).then(rows => rows[0] || null);
export const fetchKeyDates = (today = londonDay(new Date())) =>
  rest("key_dates", `select=label,date,description,audience&date=gte.${today}&order=date.asc&limit=${KEY_DATES_SHOWN}`);

// ── Markdown ──────────────────────────────────────────────────────────────

const markdown = new Marked({ gfm: true, async: false });
markdown.use({
  // The page title is the only h1, so headings in a post start at h2.
  walkTokens(token) { if (token.type === "heading" && token.depth === 1) token.depth = 2; },
  renderer: {
    // Raw HTML in a post is shown as text, never run.
    html(html) { return esc(typeof html === "string" ? html : html.text); },
    link(href, title, text) {
      const external = /^https?:\/\//i.test(href || "") && !String(href).startsWith(SITE_URL);
      return `<a href="${esc(href || "")}"${title ? ` title="${esc(title)}"` : ""}${external ? ` rel="noopener"` : ""}>${text}</a>`;
    }
  }
});
export const renderMarkdown = md => markdown.parse(String(md || ""));

// ── Content ───────────────────────────────────────────────────────────────

const CSS = `
.ins{color:#1b1f1c}
.ins a{color:#1f3d34}
.ins-intro{padding:60px clamp(20px,4.6vw,44px) 50px;border-bottom:1px solid #dcd8cf;display:grid;grid-template-columns:1fr 1fr;gap:52px;align-items:end}
.ins-eyebrow{margin:0 0 16px;font:600 14px/1 var(--font-body);color:#1f3d34}
.ins-h1{margin:0;font:500 clamp(32px,5.6vw,52px)/1.1 var(--font-heading);letter-spacing:-.015em;color:#1b1f1c;text-wrap:balance;max-width:20ch}
.ins-lede{margin:0;font:400 17px/1.65 var(--font-body);color:rgba(27,31,28,.8);text-wrap:pretty;max-width:60ch}
.ins-main{padding:40px clamp(20px,4.6vw,44px) 56px;border-bottom:1px solid #dcd8cf;display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:64px;align-items:start}
.ins-filter{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px;padding:0;list-style:none}
.ins-chip{display:inline-block;padding:11px 16px;border:1px solid #cfcabf;border-radius:2px;font:600 14.5px/1 var(--font-body);color:#1b1f1c!important;text-decoration:none}
.ins-chip:hover{border-color:#1f3d34;color:#1f3d34!important}
.ins-chip[aria-current="true"]{background:#1f3d34;border-color:#1f3d34;color:#f7f5f0!important}
.ins-list{list-style:none;margin:0;padding:0;border-top:1px solid #dcd8cf}
.ins-item{padding:26px 0 28px;border-bottom:1px solid #dcd8cf}
.ins-item[hidden]{display:none}
.ins-meta{margin:0 0 10px;font:600 13.5px/1.4 var(--font-body);color:rgba(27,31,28,.74);display:flex;flex-wrap:wrap;gap:4px 10px}
.ins-cat{color:#1f3d34}
.ins-item-title{margin:0 0 10px;font:600 clamp(24px,2.4vw,30px)/1.15 var(--font-heading);letter-spacing:-.01em;text-wrap:balance}
.ins-item-title a{color:#1b1f1c!important;text-decoration:none}
.ins-item-title a:hover{color:#1f3d34!important;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:4px}
.ins-summary{margin:0;font:400 16px/1.6 var(--font-body);color:rgba(27,31,28,.8);max-width:62ch;text-wrap:pretty}
.ins-empty{margin:0;padding:26px 0;border-bottom:1px solid #dcd8cf;font:400 16px/1.6 var(--font-body);color:rgba(27,31,28,.8)}
.ins-empty[hidden]{display:none}
.ins-dates{border-top:2px solid #1f3d34}
.ins-dates-h{margin:22px 0 4px;font:600 26px/1.15 var(--font-heading);letter-spacing:-.01em}
.ins-dates-note{margin:0 0 6px;font:400 14.5px/1.5 var(--font-body);color:rgba(27,31,28,.74)}
.ins-date-list{list-style:none;margin:0;padding:0}
.ins-date{display:grid;grid-template-columns:64px minmax(0,1fr);gap:16px;padding:18px 0;border-bottom:1px solid #dcd8cf}
.ins-date-when{display:flex;flex-direction:column;gap:5px}
.ins-date-day{font:500 34px/1 var(--font-heading);color:#1f3d34}
.ins-date-my{font:600 12.5px/1.2 var(--font-body);color:rgba(27,31,28,.74)}
.ins-date-label{margin:0 0 4px;font:600 16px/1.35 var(--font-body)}
.ins-date-desc{margin:0 0 8px;font:400 14.5px/1.55 var(--font-body);color:rgba(27,31,28,.8)}
.ins-date-aud{margin:0;font:600 13px/1.4 var(--font-body);color:#44705c}
.ins-post-head{padding:56px clamp(20px,4.6vw,44px) 44px;border-bottom:1px solid #dcd8cf}
.ins-crumbs{margin:0 0 18px;font:600 14px/1.4 var(--font-body);color:rgba(27,31,28,.45);display:flex;flex-wrap:wrap;gap:8px}
.ins-crumbs a{text-decoration:none}
.ins-crumbs a:hover{text-decoration:underline;text-underline-offset:3px}
.ins-post-title{max-width:24ch}
.ins-dateline{margin:18px 0 0;font:600 14.5px/1.5 var(--font-body);color:rgba(27,31,28,.74)}
.ins-post-head .ins-lede{margin-top:20px}
.ins-post-body{padding:44px clamp(20px,4.6vw,44px) 0}
.ins-prose{max-width:68ch;font:400 17px/1.7 var(--font-body);color:rgba(27,31,28,.88);overflow-wrap:break-word}
.ins-prose>:first-child{margin-top:0}
.ins-prose p{margin:0 0 1.1em}
.ins-prose h2{margin:1.8em 0 .5em;font:600 clamp(24px,2.6vw,30px)/1.15 var(--font-heading);letter-spacing:-.01em;color:#1b1f1c}
.ins-prose h3{margin:1.6em 0 .4em;font:600 22px/1.2 var(--font-heading);color:#1b1f1c}
.ins-prose h4,.ins-prose h5,.ins-prose h6{margin:1.4em 0 .4em;font:600 17px/1.4 var(--font-body);color:#1b1f1c}
.ins-prose ul,.ins-prose ol{margin:0 0 1.1em;padding-left:1.3em}
.ins-prose li{margin:.35em 0}
.ins-prose li::marker{color:#44705c}
.ins-prose a{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.ins-prose strong{font-weight:600;color:#1b1f1c}
.ins-prose blockquote{margin:1.4em 0;padding:2px 0 2px 20px;border-left:2px solid #1f3d34;color:#1b1f1c}
.ins-prose blockquote p:last-child{margin-bottom:0}
.ins-prose hr{border:0;border-top:1px solid #dcd8cf;margin:2em 0}
.ins-prose table{display:block;overflow-x:auto;border-collapse:collapse;margin:0 0 1.2em;font-size:15.5px}
.ins-prose th,.ins-prose td{border-bottom:1px solid #dcd8cf;padding:10px 16px 10px 0;text-align:left;vertical-align:top}
.ins-prose th{font-weight:600;color:#1b1f1c}
.ins-prose code{font:400 .9em ui-monospace,monospace;background:rgba(27,31,28,.06);padding:1px 5px;border-radius:2px}
.ins-prose img{max-width:100%;height:auto}
.ins-note{box-sizing:border-box;max-width:68ch;margin:36px 0 56px;padding:22px 24px;border-left:2px solid #1f3d34;background:#efebe3;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px 24px}
.ins-note p{margin:0;flex:1 1 300px;font:400 16px/1.6 var(--font-body);color:#1b1f1c}
.ins-btn{display:inline-block;border:1px solid #1f3d34;background:#1f3d34;color:#f7f5f0!important;padding:15px 26px;font:600 15px/1 var(--font-body);border-radius:2px;text-decoration:none;white-space:nowrap}
.ins-btn:hover{background:#142b24;border-color:#142b24}
.ins-more{padding:44px clamp(20px,4.6vw,44px) 56px;border-top:1px solid #dcd8cf}
.ins-more-h{margin:0 0 22px;font:600 clamp(26px,4vw,36px)/1.15 var(--font-heading);letter-spacing:-.015em}
.ins-more .ins-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));column-gap:36px}
.ins-more .ins-item-title{font-size:24px}
@media (max-width:900px){.ins-main{grid-template-columns:minmax(0,1fr);gap:48px}}
@media (max-width:760px){.ins-intro{grid-template-columns:1fr;gap:20px;padding:44px clamp(20px,4.6vw,44px) 36px}.ins-post-head{padding:40px clamp(20px,4.6vw,44px) 32px}.ins-main,.ins-post-body{padding-top:32px}}
@media (max-width:420px){.ins-chip{padding:10px 13px;font-size:14px}.ins-note{padding:20px}}
`.trim().replace(/\n/g, "");

// Show or hide posts by topic in place, and keep the address in step, so the
// filter works as plain links without the script and instantly with it.
const FILTER_SCRIPT = `<script>
(function () {
  function show(cat) {
    var lists = document.querySelectorAll("[data-ins-list]");
    for (var g = 0; g < lists.length; g++) {
      var root = lists[g], shown = 0, items = root.querySelectorAll("[data-ins-cat]");
      for (var i = 0; i < items.length; i++) {
        var on = cat === "all" || items[i].getAttribute("data-ins-cat") === cat;
        items[i].hidden = !on;
        if (on) shown++;
      }
      var empty = root.querySelector("[data-ins-empty]");
      if (empty) empty.hidden = shown > 0;
      var chips = root.querySelectorAll("[data-ins-filter]");
      for (var j = 0; j < chips.length; j++) {
        if (chips[j].getAttribute("data-ins-filter") === cat) chips[j].setAttribute("aria-current", "true");
        else chips[j].removeAttribute("aria-current");
      }
    }
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[data-ins-filter]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
    e.preventDefault();
    show(a.getAttribute("data-ins-filter"));
    try { history.replaceState(history.state, "", a.getAttribute("href")); } catch (err) {}
  });
})();
</script>`;

function postMeta(p) {
  const key = categoryKey(p.category);
  return `<p class="ins-meta"><a class="ins-cat" href="/insights/?category=${key}" data-ins-filter="${key}" style="text-decoration:none">${esc(p.category)}</a><span aria-hidden="true">·</span><time datetime="${esc(p.published_at)}">${longDate(new Date(p.published_at))}</time></p>`;
}

function postItem(p, headingTag, hidden) {
  return `<li class="ins-item" data-ins-cat="${categoryKey(p.category)}"${hidden ? " hidden" : ""}><article>${postMeta(p)}<${headingTag} class="ins-item-title"><a href="/insights/${esc(p.slug)}/">${esc(p.title)}</a></${headingTag}><p class="ins-summary">${esc(p.summary)}</p></article></li>`;
}

function keyDatesBlock(dates) {
  const rows = dates.map(d => {
    const day = calendar(d.date);
    const dm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", month: "short", year: "numeric" }).format(day);
    return `<li class="ins-date"><time class="ins-date-when" datetime="${esc(String(d.date).slice(0, 10))}"><span class="ins-date-day">${day.getUTCDate()}</span><span class="ins-date-my">${dm}</span></time><div><p class="ins-date-label">${esc(d.label)}</p>${d.description ? `<p class="ins-date-desc">${esc(d.description)}</p>` : ""}${d.audience ? `<p class="ins-date-aud">${esc(d.audience)}</p>` : ""}</div></li>`;
  }).join("");
  return `<aside class="ins-dates" aria-labelledby="ins-dates-h"><h2 class="ins-dates-h" id="ins-dates-h">Key dates</h2><p class="ins-dates-note">The next deadlines worth having in the diary.</p>${rows ? `<ol class="ins-date-list">${rows}</ol>` : `<p class="ins-dates-note">No dates to show just now.</p>`}</aside>`;
}

export function listContent({ posts, keyDates, category = "all", failed = false }) {
  const filter = posts.length
    ? `<nav aria-label="Filter by topic"><ul class="ins-filter">${[{ key: "all", label: "All" }, ...CATEGORIES].map(c =>
        `<li><a class="ins-chip" href="/insights/${c.key === "all" ? "" : "?category=" + c.key}" data-ins-filter="${c.key}"${c.key === category ? ' aria-current="true"' : ""}>${esc(c.label)}</a></li>`).join("")}</ul></nav>`
    : "";
  const visible = posts.filter(p => category === "all" || categoryKey(p.category) === category).length;
  const list = failed
    ? `<p class="ins-empty">Insights could not be loaded just now. Please try again in a few minutes.</p>`
    : posts.length
      ? `<ol class="ins-list">${posts.map(p => postItem(p, "h2", category !== "all" && categoryKey(p.category) !== category)).join("")}</ol><p class="ins-empty" data-ins-empty${visible ? " hidden" : ""}>Nothing on this topic yet. <a href="/insights/" data-ins-filter="all">See all insights</a>.</p>`
      : `<p class="ins-empty">The first notes are on their way. New ones are published here on Tuesdays.</p>`;
  return `<div class="ins">
<div class="ins-intro"><div><p class="ins-eyebrow">Insights</p><h1 class="ins-h1">Tax and money changes, and what they mean for you.</h1></div><p class="ins-lede">Short notes, published on Tuesdays, on the tax, legal and economic changes that affect small businesses and personal finances. What changed, who it affects and what to do about it.</p></div>
<div class="ins-main"><section aria-label="Latest insights" data-ins-list>${filter}${list}</section>${keyDatesBlock(keyDates || [])}</div>
</div>`;
}

export function postContent({ post, more = [] }) {
  const published = new Date(post.published_at);
  const updated = post.updated_at ? new Date(post.updated_at) : null;
  const showUpdated = updated && londonDay(updated) > londonDay(published);
  const key = categoryKey(post.category);
  return `<div class="ins"><article>
<header class="ins-post-head"><p class="ins-crumbs"><a href="/insights/">Insights</a><span aria-hidden="true">/</span><a href="/insights/?category=${key}">${esc(post.category)}</a></p><h1 class="ins-h1 ins-post-title">${esc(post.title)}</h1><p class="ins-dateline">Published <time datetime="${esc(post.published_at)}">${longDate(published)}</time>${showUpdated ? ` · Updated <time datetime="${esc(post.updated_at)}">${longDate(updated)}</time>` : ""}</p><p class="ins-lede">${esc(post.summary)}</p></header>
<div class="ins-post-body"><div class="ins-prose">${renderMarkdown(post.body)}</div>
<aside class="ins-note" aria-label="About this note"><p>This is general information, not advice for your situation. Questions? We don't charge for them.</p><a class="ins-btn" href="/contact/">Get in touch</a></aside></div>
</article>${more.length ? `
<section class="ins-more" aria-labelledby="ins-more-h"><h2 class="ins-more-h" id="ins-more-h">More insights</h2><ol class="ins-list">${more.map(p => postItem(p, "h3")).join("")}</ol></section>` : ""}
</div>`;
}

function notFoundContent() {
  return `<div class="ins"><div class="ins-post-head"><p class="ins-crumbs"><a href="/insights/">Insights</a></p><h1 class="ins-h1">This insight isn't available.</h1><p class="ins-lede" style="margin-top:20px">It may have moved or not be published yet. <a href="/insights/">See all insights</a>.</p></div></div>`;
}

// ── Pages ─────────────────────────────────────────────────────────────────

export function fillPage(template, { title, description, url, robots = "index,follow", content, head = "", body = "", ogType = "website" }) {
  let html = template;
  // Structured data: JSON strings.
  html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, block => block
    .split("%%TITLE%%").join(jsonInScript(title).slice(1, -1))
    .split("%%DESCRIPTION%%").join(jsonInScript(description).slice(1, -1))
    .split("%%URL%%").join(jsonInScript(url).slice(1, -1)));
  // The copy handed to the design: a JavaScript string.
  html = html.split(`"%%INSIGHTS_HTML%%"`).join(jsonInScript(content));
  // Everything else is HTML.
  html = html.split("%%INSIGHTS_HTML%%").join(content)
    .split("%%TITLE%%").join(esc(title))
    .split("%%DESCRIPTION%%").join(esc(description))
    .split("%%URL%%").join(esc(url))
    .split("%%ROBOTS%%").join(esc(robots))
    .replace("<!--%%INSIGHTS_HEAD%%-->", `<style data-insights>${CSS}</style>${head}`)
    .replace("<!--%%INSIGHTS_BODY%%-->", body);
  if (ogType !== "website") html = html.replace(`<meta property="og:type" content="website">`, `<meta property="og:type" content="${esc(ogType)}">`);
  return html;
}

const LIST_TITLE = "Small business tax and money insights | Bromage & Co";
const LIST_DESCRIPTION = "Short notes, published on Tuesdays, on the tax, legal and economic changes that affect small businesses and personal finances, and what they mean for you.";

export async function listPage({ category }) {
  const cat = CATEGORIES.some(c => c.key === category) ? category : "all";
  const label = cat === "all" ? "" : CATEGORIES.find(c => c.key === cat).label;
  let posts = [], keyDates = [], failed = false;
  try { [posts, keyDates] = await Promise.all([fetchPosts(), fetchKeyDates()]); }
  catch (e) { failed = true; console.error("[insights] list:", e.message); }
  const html = fillPage(TEMPLATES.list, {
    title: label ? `${label} insights | Bromage & Co` : LIST_TITLE,
    description: LIST_DESCRIPTION,
    url: SITE_URL + "/insights/",
    content: listContent({ posts, keyDates, category: cat, failed }),
    body: FILTER_SCRIPT
  });
  return { status: failed ? 503 : 200, html, cache: failed ? null : CACHE_OK };
}

export async function postPage({ slug }) {
  let post = null;
  if (SLUG.test(slug || "")) {
    try { post = await fetchPost(slug); }
    catch (e) {
      console.error("[insights] post:", e.message);
      return { status: 503, html: fillPage(TEMPLATES.post, { title: "Insights | Bromage & Co", description: LIST_DESCRIPTION, url: SITE_URL + "/insights/", robots: "noindex,follow", content: `<div class="ins"><div class="ins-post-head"><h1 class="ins-h1">This insight could not be loaded just now.</h1><p class="ins-lede" style="margin-top:20px">Please try again in a few minutes.</p></div></div>` }), cache: null };
    }
  }
  if (!post) {
    return { status: 404, cache: CACHE_MISSING, html: fillPage(TEMPLATES.post, {
      title: "Insight not found | Bromage & Co", description: LIST_DESCRIPTION, url: SITE_URL + "/insights/",
      robots: "noindex,follow", content: notFoundContent() }) };
  }
  let more = [];
  try { more = (await fetchPosts(MORE_SHOWN + 1)).filter(p => p.slug !== post.slug).slice(0, MORE_SHOWN); }
  catch (e) { console.error("[insights] more:", e.message); }
  const url = `${SITE_URL}/insights/${post.slug}/`;
  const modified = post.updated_at && post.updated_at > post.published_at ? post.updated_at : post.published_at;
  const article = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.summary,
    articleSection: post.category,
    datePublished: post.published_at,
    dateModified: modified,
    url,
    mainEntityOfPage: url,
    inLanguage: "en-GB",
    image: SITE_URL + "/social-card.png",
    author: { "@type": "Person", name: "Louis Bromage", jobTitle: "Chartered Management Accountant", url: SITE_URL + "/about/" },
    publisher: { "@id": ORG_ID, "@type": "Organization", name: SITE_NAME, logo: SITE_URL + "/icon-512.png" }
  };
  const head = `<meta property="article:published_time" content="${esc(post.published_at)}"><meta property="article:modified_time" content="${esc(modified)}"><meta property="article:section" content="${esc(post.category)}"><script type="application/ld+json">${jsonInScript(article)}</script>`;
  return { status: 200, cache: CACHE_OK, html: fillPage(TEMPLATES.post, {
    title: `${post.title} | Bromage & Co`, description: post.summary, url, ogType: "article", head,
    content: postContent({ post, more }) }) };
}

export async function sitemap() {
  const urls = STATIC_PAGES.map(p => ({ ...p }));
  let posts = [], failed = false;
  try { posts = await fetchPosts(); } catch (e) { failed = true; console.error("[insights] sitemap:", e.message); }
  const day = iso => String(iso).slice(0, 10);
  const newest = posts.reduce((m, p) => { const d = day(p.updated_at || p.published_at); return d > m ? d : m; }, "");
  urls.push({ loc: SITE_URL + "/insights/", lastmod: newest || undefined });
  for (const p of posts) urls.push({ loc: `${SITE_URL}/insights/${p.slug}/`, lastmod: day(p.updated_at && p.updated_at > p.published_at ? p.updated_at : p.published_at) });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n")}
</urlset>
`;
  return { status: 200, xml, cache: failed ? CACHE_MISSING : CACHE_OK };
}
