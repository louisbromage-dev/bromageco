# bromageco.com

The Bromage & Co Accounting website, designed in Claude Design.

## How it fits together

- `design/export.html`: the HTML export from Claude Design. This is the source of truth for how the site looks.
- `tools/build.mjs`: turns the export into the site that gets deployed:
  - one real page per section (`/services/`, `/advisory/`, `/packages/` …), each with its own title, description, canonical link and social preview
  - every page pre-rendered to plain HTML, so Google and link previews see the full content without running JavaScript
  - fonts, images and scripts written to `assets/` as normal cached files instead of a 2 MB self-unpacking page
  - business details for search engines (`AccountingService` structured data), plus `sitemap.xml`, `robots.txt` and `social-card.png`
- The design's own runtime still loads on top, so the package builder, forms and menus behave exactly as they did before.

Page titles, descriptions and URLs live in the `PAGES` list at the top of `tools/build.mjs`. The site address is `SITE_URL` in the same file.

## Updating the site after a design change

1. In Claude Design, export the site as HTML and save it over `design/export.html`.
2. Build:
   ```sh
   cd tools
   npm install        # first time only
   CHROMIUM_PATH=/path/to/chromium npm run build   # CHROMIUM_PATH is optional
   ```
3. Commit everything (the generated pages and `assets/` included) and push. Vercel deploys whatever is committed; it runs no build step.

If the build stops with "the design has changed shape", a part of the design the build relies on was renamed or removed (for example a page was added). Add the new page to `PAGES` in `tools/build.mjs`, or ask Claude to update the build.

## Prices

Every price on the site comes from Supabase (project `biumvfliagyebarcoyzv`), read in the visitor's browser with the public anon key:

- **`public.builder_packages`**: the price list, published from the Bromage Insight dashboard. Used by the package builder, the Services page, the service pages, the "Who I work with" cards and the campaign's "Normally" price (the `sa` / `professional` row x 12).
- **`public.campaign_prices`**: campaign tiers (price, first and last day in London time, live Stripe payment link, sort order) and add-ons. Created by `supabase/migrations/20261029120000_campaign_prices.sql`; anyone can read active rows, only the owner can change them.

The build reads both tables too, so the pre-rendered pages already show the right prices. If it cannot reach Supabase it uses the copy saved by the last build that could (`config/prices-snapshot.json`, never edited by hand) and says so. A price change in Supabase shows on the live site straight away; rebuild when convenient so the pre-rendered pages match.

Still typed into the design (not in Supabase yet): payroll (£40 base + £7 per employee), partner self assessments in the package builder (£15 a month) and company formation (£14.99, Tide).

## Self Assessment campaign (until 31 January 2027)

- **Prices, dates, Stripe links and add-ons:** `public.campaign_prices` in Supabase. Wording and contact details: `config/sa-campaign.json`.
- **Which price shows** is worked out in the visitor's browser in London time (`tools/sa-campaign-client.js`), so the site never needs a deploy when a tier changes. Each page is pre-rendered in every state and switches to today's before it is shown, so an old price never flashes.
- **Preview any state** on a preview deployment (ignored on bromageco.com): add `?saPreview=november`, `december`, `january`, `closed` or `over`, or a London date such as `?saPreview=2026-12-01`.
- **Book buttons** on `/tax-return/` go straight to the live Stripe payment link with `client_reference_id` set to where they were clicked: `tax-return-hero`, `tax-return-pricing` or `tax-return-footer`. The banner and the home page card open `/tax-return/`.
- **Thank-you page:** `/tax-return/thank-you/` (not indexed, not in the sitemap). Each Stripe payment link redirects to `/tax-return/thank-you?tier=<november|december|january>&session_id={CHECKOUT_SESSION_ID}`.
- **Google reviews:** fill in `config/site.json` (count and profile link). Until then the site says "Rated 5.0 on Google" with no link.
- The original brief is in `design/sa-campaign-handover.md`.

## Google tag and cookies

- **Tag ID:** `googleTagId` in `config/site.json` (currently `G-SCL14250DK`), and nowhere else.
- **Consent Mode v2** (`tools/tracking-head.js`, in every page's head before gtag.js): `ad_storage`, `ad_user_data`, `ad_personalization` and `analytics_storage` start "denied", `url_passthrough` is on. Accept grants all four; Reject keeps them denied. The choice is kept in the browser (`bc-consent`); if storage is unavailable the banner shows again and consent stays denied.
- **Cookie banner and events** (`tools/tracking-body.js`): the banner at the foot of the screen, "Cookie settings" in the footer to reopen it, `phone_click` on every tel: link, and on the thank-you page one `purchase` event per Stripe Checkout session (`session_id` starting `cs_`), valued at the price of the tier in the URL from Supabase. No labelled conversion events: Google Ads counts a booking when the thank-you page loads.
- No names, emails or phone numbers go into URLs or events.
