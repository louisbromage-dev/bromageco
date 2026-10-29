// Self Assessment campaign: works out which price tier applies right now, in
// the visitor's browser, and everything the site shows for it.
//
// Prices, dates, payment links and add-ons come from Supabase:
//   public.campaign_prices   the campaign tiers and add-ons
//   public.builder_packages  the standard fee (Professional SA x 12 months)
// The build injects this file into every page's <head> (with the rows it
// read from Supabase, so the pre-rendered page can switch to the right tier
// before it is painted) and into the design's page logic, which fetches the
// rows live and calls saSetRows() again.
//
// SA_CFG (wording and contact details only, from config/sa-campaign.json) is
// defined just above this code by the build. Keep this file plain ES5: it
// runs before anything else on the page.

function saDayNum(iso) {
  var p = String(iso).slice(0, 10).split("-");
  return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000;
}

function saIsoFromDay(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function saMoney(n) {
  return "£" + Number(n).toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

var SA_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function saLongDate(iso) {
  var p = String(iso).split("-");
  return (+p[2]) + " " + SA_MONTHS[+p[1] - 1] + " " + p[0];
}
function saShortDate(iso) {
  var p = String(iso).split("-");
  return (+p[2]) + " " + SA_MONTHS[+p[1] - 1];
}

// Turn the Supabase rows into the tiers and add-ons the site uses.
function saSetRows(campaignRows, packageRows) {
  var rows = (campaignRows || []).filter(function (r) { return r.campaign === SA_CFG.campaign; });
  rows.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
  var tiers = [], addons = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.kind === "addon") { addons[r.key] = { label: r.label, price: r.price == null ? null : Number(r.price), basis: r.price_basis }; continue; }
    if (r.kind !== "tier") continue;
    tiers.push({
      key: r.key, note: r.label, price: Number(r.price), link: r.payment_link || null,
      from: String(r.active_from).slice(0, 10), until: String(r.active_until).slice(0, 10)
    });
  }
  for (var j = 0; j < tiers.length; j++) {
    var t = tiers[j], prev = tiers[j - 1];
    t.untilLabel = saLongDate(t.until);
    t.untilShort = saShortDate(t.until);
    t.tableLabel = t.link || !prev ? "By " + t.untilLabel : "After " + prev.untilLabel;
    t.laterText = t.link || !prev ? "in " + SA_MONTHS[+t.until.split("-")[1] - 1]
      : "after " + prev.untilShort + ", by phone and subject to capacity";
  }
  var std = null, sf = SA_CFG.standardFee;
  for (var k = 0; k < (packageRows || []).length; k++) {
    var p = packageRows[k];
    if (p.category === sf.category && p.tier_key === sf.tierKey) std = Number(p.price) * sf.months;
  }
  SA_CFG.tiers = tiers;
  SA_CFG.addons = addons;
  SA_CFG.standardFee.amount = std;
  if (tiers.length) SA_CFG.filingDeadline = { date: tiers[tiers.length - 1].until, label: saLongDate(tiers[tiers.length - 1].until) };
}

// Today's date in London, as YYYY-MM-DD. Each tier ends at 23:59:59 London
// time on its last day, so comparing London calendar dates is exact.
function saLondonToday(now) {
  try {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: SA_CFG.timeZone, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(now);
    var get = function (type) {
      for (var i = 0; i < parts.length; i++) if (parts[i].type === type) return parts[i].value;
      return "";
    };
    return get("year") + "-" + get("month") + "-" + get("day");
  } catch (e) {
    return now.toISOString().slice(0, 10);
  }
}

// ?saPreview=<tier key>|over, or a London date such as ?saPreview=2026-12-01.
// Ignored on the production domain.
function saPreviewParam() {
  try {
    if (SA_CFG.productionHosts.indexOf(window.location.hostname) !== -1) return "";
    return new URLSearchParams(window.location.search).get("saPreview") || "";
  } catch (e) {
    return "";
  }
}

function saToday() {
  var tiers = SA_CFG.tiers;
  var real = saLondonToday(new Date());
  var pv = saPreviewParam();
  if (/^\d{4}-\d{2}-\d{2}$/.test(pv)) return pv;
  if (pv === "over" && tiers.length) return saIsoFromDay(saDayNum(tiers[tiers.length - 1].until) + 1);
  for (var i = 0; i < tiers.length; i++) {
    if (tiers[i].key !== pv) continue;
    var r = saDayNum(real);
    if (r >= saDayNum(tiers[i].from) && r <= saDayNum(tiers[i].until)) return real;
    return tiers[i].from;
  }
  return real;
}

function saWithSource(link, source) {
  return link + (link.indexOf("?") === -1 ? "?" : "&") + "client_reference_id=" + encodeURIComponent(source);
}

function saAddonText(key, style) {
  var a = SA_CFG.addons[key];
  if (!a) return "";
  if (a.basis === "quote") return "Quoted individually";
  if (a.basis === "plus_tier") return style === "faq" ? "the tier price plus " + saMoney(a.price) : "Tier price + " + saMoney(a.price);
  return style === "faq" || style === "plain" ? saMoney(a.price) : saMoney(a.price) + " at any tier";
}

// Fill price placeholders in fixed wording: {partner}, {highIncome}.
function saFill(text) {
  return String(text)
    .split("{partner}").join(saAddonText("partner", "plain"))
    .split("{highIncome}").join(saAddonText("income-100k-200k", "faq"));
}

// The add-on rows for the price table.
function saAddonNotes() {
  var out = [], keys = [];
  for (var k in SA_CFG.addons) keys.push(k);
  for (var i = 0; i < keys.length; i++) out.push({ label: SA_CFG.addons[keys[i]].label, value: saAddonText(keys[i], "table") });
  return out;
}

// Everything the campaign shows, for the tier in force today.
function saCampaignState() {
  var c = SA_CFG, tiers = c.tiers, today = saToday(), td = saDayNum(today);
  var idx = -1;
  for (var i = 0; i < tiers.length; i++) {
    if (td <= saDayNum(tiers[i].until)) { idx = i; break; }
  }
  var over = idx === -1;
  var t = over ? tiers[tiers.length - 1] : tiers[idx];
  var closed = !over && !t.link;
  var daysLeft = saDayNum(t.until) - td + 1;
  var price = saMoney(t.price);
  var std = c.standardFee.amount;
  var v = {
    key: over ? "over" : t.key, today: today, idx: over ? tiers.length : idx,
    phase: over ? "over" : "live", live: !over, closed: closed, over: over,
    tier: { key: over ? "over" : t.key }, priceText: price
  };

  var book = function (source) {
    if (over) return "/contact/";
    if (closed) return c.phoneHref;
    return saWithSource(t.link, source);
  };
  v.bannerHref = "/tax-return/";
  v.heroHref = book("tax-return-hero");
  v.pricingHref = book("tax-return-pricing");
  v.footerHref = book("tax-return-footer");
  v.bookLabel = over ? "Get in touch" : closed ? "Call " + c.phone : "Book my tax return";
  v.cardBook = closed ? "Late booking details" : "Book my tax return";
  v.pricingLabel = closed ? "Call " + c.phone + " →" : "Secure my tax return →";
  v.showPhoneLink = !closed;
  v.partnerNote = c.addons.partner
    ? "Add a spouse or partner return for " + saMoney(c.addons.partner.price) + " at checkout. Any extras are agreed with you before work starts."
    : "Any extras are agreed with you before work starts.";

  if (closed) {
    v.banner = "Online bookings have closed. Call " + c.phone + " to check if we have capacity.";
    v.cardHeading = "Online bookings have closed";
    v.cardLine = "Call " + c.phone + " to check if we have capacity. Late returns are " + price + ", subject to capacity.";
    v.countdown = daysLeft === 1 ? "Last day before the " + t.untilShort + " deadline" : daysLeft + " days to the " + t.untilShort + " deadline";
    v.heroHeading = "Online bookings have closed.";
    v.heroAccent = "Call to check capacity.";
    v.heroLine = "The online filing deadline is " + c.filingDeadline.label + ". Late returns are " + price + ", subject to capacity. Call Louis on " + c.phone + " and he will tell you straight away whether he can take yours on.";
    v.formHeading = "Call to book a late return";
    v.formNote = "Late returns are " + price + ", subject to capacity. Fixed fee, no VAT.";
    v.meta = "Online bookings for Self Assessment " + c.taxYear + " have closed. Call " + c.phone + " to check capacity for a late return at " + price + ", prepared by Louis Bromage ACMA CGMA in Fleet, Hampshire.";
  } else if (over) {
    v.banner = "";
    v.cardHeading = ""; v.cardLine = ""; v.countdown = "";
    v.heroHeading = "Self Assessment " + c.taxYear;
    v.heroAccent = "Online booking has closed.";
    v.heroLine = "The " + c.filingDeadline.label + " deadline has passed. If you still need to file, get in touch and Louis will quote for a late return.";
    v.formHeading = "Still need to file?";
    v.formNote = "Louis will quote for a late return before any work starts.";
    v.meta = "Self Assessment tax returns from Bromage & Co, Chartered Management Accountant in Fleet, Hampshire. Get in touch about a late or future return.";
  } else {
    v.banner = "Self Assessment " + c.taxYear + ": " + price + " if you book by " + t.untilShort + " →";
    v.cardHeading = "Your tax return for " + price;
    v.cardLine = "Book by " + t.untilShort + "." + (std && t.price < std ? " Normally " + saMoney(std) + "." : "") + " Fixed fee, no VAT.";
    v.countdown = (daysLeft === 1 ? "Last day" : daysLeft + " days left") + " at " + price;
    v.heroHeading = "Your tax return for " + price + ".";
    v.heroAccent = "Book by " + t.untilShort + ".";
    v.heroLine = "Prepared, checked and filed by Louis Bromage ACMA CGMA. One fixed fee, all in" + (std && t.price < std ? " (normally " + saMoney(std) + ")" : "") + ", and you approve every figure before it goes to HMRC.";
    v.formHeading = "Book at " + price;
    v.formNote = "Secure card payment through Stripe. Fixed fee, no VAT.";
    v.meta = "Your Self Assessment " + c.taxYear + " tax return prepared and filed by Louis Bromage ACMA CGMA, Chartered Management Accountant in Fleet. " + price + " if you book by " + t.untilShort + (std && t.price < std ? ", normally " + saMoney(std) : "") + ". Fixed fee, no VAT.";
  }
  v.title = "Self Assessment tax return " + (over ? "" : closed ? price + ", subject to capacity " : "from " + price + " ") + "| Bromage & Co";

  var later = [];
  if (!over && !closed) {
    for (var j = idx + 1; j < tiers.length; j++) {
      if (!tiers[j].link && idx < tiers.length - 2) continue;
      later.push(saMoney(tiers[j].price) + " " + tiers[j].laterText);
    }
  }
  v.nextLine = later.join(" · ");
  v.hasNext = later.length > 0;
  v.untilText = t.untilLabel;
  v.panelUntil = over ? "Online booking closed" : closed ? "Subject to capacity" : "Book by " + t.untilShort;
  v.payLabel = v.bookLabel;

  v.tiers = [];
  for (var k = 0; k < tiers.length; k++) {
    var x = tiers[k], cur = !over && k === idx, past = over || k < idx;
    v.tiers.push({
      label: x.tableLabel,
      note: past ? "Ended" : x.note,
      priceLabel: saMoney(x.price),
      current: cur, past: past, aria: cur ? "true" : "false",
      bg: cur ? "#e9efe9" : "transparent",
      priceInk: cur ? "#1f3d34" : past ? "rgba(27,31,28,.45)" : "#1b1f1c"
    });
  }
  return v;
}
