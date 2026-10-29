// Cookie banner, phone-click events and the booking (purchase) event. Runs
// at the end of every page. BC_TRACKING is defined just above this by the
// build. Plain ES5.

(function () {
  var cfg = BC_TRACKING;
  var ALL = ["ad_storage", "ad_user_data", "ad_personalization", "analytics_storage"];
  var root = document.documentElement;

  function consentAll(state) {
    var c = {};
    for (var i = 0; i < ALL.length; i++) c[ALL[i]] = state;
    return c;
  }
  function readChoice() {
    try { return window.localStorage.getItem(cfg.consentKey); } catch (e) { return null; }
  }
  function saveChoice(v) {
    try { window.localStorage.setItem(cfg.consentKey, v); } catch (e) {}
  }

  // ── Cookie banner ──────────────────────────────────────────────────────
  // A fixed bar at the foot of the screen. The page stays usable and can be
  // scrolled clear of it; the phone action bar steps aside while it shows.
  var bar = document.getElementById("cc");

  function setHeight() {
    root.style.setProperty("--cc-h", bar.offsetHeight + "px");
  }
  function closeBanner() {
    bar.hidden = true;
    bar.innerHTML = "";
    root.classList.remove("cc-open");
    root.style.removeProperty("--cc-h");
    window.removeEventListener("resize", setHeight);
  }
  function openBanner(focusFirst) {
    bar.hidden = false;
    root.classList.add("cc-open");
    // Filled after it is shown, so screen readers announce it (the region is
    // aria-live) without moving the visitor's focus.
    setTimeout(function () {
      bar.innerHTML =
        '<div class="cc-inner">' +
          '<p class="cc-text">We use cookies to see which of our adverts bring us clients. They only run if you agree, and you can change your mind at any time. ' +
          '<a href="' + cfg.privacyHref + '">Privacy and cookies</a></p>' +
          '<div class="cc-actions">' +
            '<button type="button" class="cc-btn cc-primary" data-cc-choice="granted">Accept</button>' +
            '<button type="button" class="cc-btn cc-secondary" data-cc-choice="denied">Reject</button>' +
          '</div>' +
        '</div>';
      setHeight();
      window.addEventListener("resize", setHeight);
      if (focusFirst) bar.querySelector("button").focus();
    }, 50);
  }
  function choose(v) {
    saveChoice(v);
    gtag("consent", "update", consentAll(v === "granted" ? "granted" : "denied"));
    closeBanner();
  }

  bar.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-cc-choice]");
    if (b) choose(b.getAttribute("data-cc-choice"));
  });

  // "Cookie settings" in the footer reopens the banner, and phone links
  // report a phone_click. Listened for on the document because the footer
  // and links are redrawn by the page's design runtime.
  document.addEventListener("click", function (e) {
    if (!e.target.closest) return;
    if (e.target.closest("[data-cookie-settings]")) {
      e.preventDefault();
      openBanner(true);
      return;
    }
    if (e.target.closest('a[href^="tel:"]') && typeof window.gtag === "function") {
      gtag("event", "phone_click");
    }
  }, true);

  var choice = readChoice();
  if (choice !== "granted" && choice !== "denied") openBanner(false);

  // ── Booking confirmed (thank-you page only) ────────────────────────────
  // Stripe redirects to /tax-return/thank-you/?tier=<tier>&session_id=cs_...
  // Send one purchase event per Checkout session, valued at the price of the
  // tier the customer paid through, read from Supabase.
  if (!cfg.thankYouPage) return;
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get("session_id") || "";
  var tier = params.get("tier") || "";
  if (sessionId.indexOf("cs_") !== 0) return;

  var SENT = "bc-purchase-sent", sent = [];
  try { sent = JSON.parse(window.sessionStorage.getItem(SENT) || "[]"); } catch (e) {}
  if (sent.indexOf(sessionId) !== -1) return;
  sent.push(sessionId);
  try { window.sessionStorage.setItem(SENT, JSON.stringify(sent)); } catch (e) {}

  function send(price) {
    var p = { transaction_id: sessionId, currency: "GBP" };
    if (price != null && isFinite(price)) p.value = price;
    gtag("event", "purchase", p);
  }
  function fromBuild() {
    for (var i = 0; i < cfg.tiers.length; i++) if (cfg.tiers[i].key === tier) return cfg.tiers[i].price;
    return null;
  }
  if (!/^[a-z0-9-]+$/.test(tier)) { send(null); return; }
  try {
    fetch(cfg.supabaseUrl + "/rest/v1/campaign_prices?select=price&kind=eq.tier&active=eq.true&campaign=eq." +
      encodeURIComponent(cfg.campaign) + "&key=eq." + encodeURIComponent(tier),
      { headers: { apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (rows) { send(rows && rows.length ? Number(rows[0].price) : null); })
      .catch(function () { send(fromBuild()); });
  } catch (e) {
    send(fromBuild());
  }
})();
