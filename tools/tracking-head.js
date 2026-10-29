// Google tag with Consent Mode v2. Runs in every page's <head>, before
// gtag.js loads. BC_TRACKING is defined just above this by the build, from
// config/site.json (googleTagId). Plain ES5.
//
// Everything starts denied. If the visitor accepted on an earlier visit (and
// their browser kept the choice), consent is granted before the tag starts.

window.dataLayer = window.dataLayer || [];
function gtag() { window.dataLayer.push(arguments); }

gtag("consent", "default", {
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  analytics_storage: "denied"
});
gtag("set", "url_passthrough", true);

(function () {
  var choice = null;
  try { choice = window.localStorage.getItem(BC_TRACKING.consentKey); } catch (e) {}
  if (choice === "granted") {
    gtag("consent", "update", {
      ad_storage: "granted",
      ad_user_data: "granted",
      ad_personalization: "granted",
      analytics_storage: "granted"
    });
  }
})();

gtag("js", new Date());
gtag("config", BC_TRACKING.tagId);
