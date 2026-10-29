// Self Assessment campaign: works out which price tier applies right now, in
// the visitor's browser, and everything the site shows for it. The build
// injects this file twice: into every page's <head> (so the pre-rendered page
// can switch to the right price before it is painted) and into the design's
// page logic (so the live site renders the same thing).
//
// SA_CFG is defined just above this code by the build, from
// config/sa-campaign.json. Keep this file plain ES5: it runs before anything
// else on the page.

function saDayNum(iso) {
  var p = iso.split("-");
  return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000;
}

function saIsoFromDay(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

// Today's date in London, as YYYY-MM-DD. Each tier ends at 23:59:59 London
// time on its end date, so comparing London calendar dates is exact.
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

// ?saPreview=november|december|january|closed|over, or a London date such as
// ?saPreview=2026-12-01. Ignored on the production domain.
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
  if (pv === "over") return saIsoFromDay(saDayNum(tiers[tiers.length - 1].until) + 1);
  for (var i = 0; i < tiers.length; i++) {
    if (tiers[i].key !== pv) continue;
    var end = saDayNum(tiers[i].until);
    var start = i === 0 ? -Infinity : saDayNum(tiers[i - 1].until) + 1;
    var r = saDayNum(real);
    if (r >= start && r <= end) return real;
    return saIsoFromDay(i === 0 ? end : start);
  }
  return real;
}

function saWithSource(link, source) {
  return link + (link.indexOf("?") === -1 ? "?" : "&") + "client_reference_id=" + encodeURIComponent(source);
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
  var price = "£" + t.price;
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
  v.cardHref = book("home-card");
  v.heroHref = book("tax-return-hero");
  v.pricingHref = book("tax-return-pricing");
  v.footerHref = book("tax-return-footer");
  v.bookLabel = over ? "Get in touch" : closed ? "Call " + c.phone : "Book my tax return";
  v.cardBook = closed ? "Call " + c.phone : "Book my tax return";
  v.pricingLabel = closed ? "Call " + c.phone + " →" : "Secure my tax return →";
  v.showPhoneLink = !closed;

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
    v.cardLine = "Book by " + t.untilShort + "." + (t.price < c.standardFee ? " Normally £" + c.standardFee + "." : "") + " Fixed fee, no VAT.";
    v.countdown = (daysLeft === 1 ? "Last day" : daysLeft + " days left") + " at " + price;
    v.heroHeading = "Your tax return for " + price + ".";
    v.heroAccent = "Book by " + t.untilShort + ".";
    v.heroLine = "Prepared, checked and filed by Louis Bromage ACMA CGMA. One fixed fee, all in, and you approve every figure before it goes to HMRC.";
    v.formHeading = "Book at " + price;
    v.formNote = "Secure card payment through Stripe. Fixed fee, no VAT.";
    v.meta = "Your Self Assessment " + c.taxYear + " tax return prepared and filed by Louis Bromage ACMA CGMA, Chartered Management Accountant in Fleet. " + price + " if you book by " + t.untilShort + ". Fixed fee, no VAT.";
  }

  var later = [];
  if (!over && !closed) {
    for (var j = idx + 1; j < tiers.length; j++) {
      if (!tiers[j].link && idx < tiers.length - 2) continue;
      later.push("£" + tiers[j].price + " " + tiers[j].laterText);
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
      label: x.link ? "By " + x.untilLabel : x.untilLabel,
      note: past ? "Ended" : x.note,
      priceLabel: "£" + x.price,
      current: cur, past: past, aria: cur ? "true" : "false",
      bg: cur ? "#e9efe9" : "transparent",
      priceInk: cur ? "#1f3d34" : past ? "rgba(27,31,28,.45)" : "#1b1f1c"
    });
  }
  return v;
}
