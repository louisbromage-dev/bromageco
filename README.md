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

## Self Assessment campaign (until 31 January 2027)

- **Prices, dates and Stripe links:** `config/sa-campaign.json`, and nowhere else. Change a value there and rebuild.
- **Which price shows** is worked out in the visitor's browser in London time (`tools/sa-campaign-client.js`), so the site never needs a deploy when a tier changes. Each page is pre-rendered in every state and switches to today's before it is shown, so an old price never flashes.
- **Preview any state** on a preview deployment (ignored on bromageco.com): add `?saPreview=november`, `december`, `january`, `closed` or `over`, or a London date such as `?saPreview=2026-12-01`.
- **Book buttons** on `/tax-return/` go straight to the live Stripe payment link with `client_reference_id` set to where they were clicked: `tax-return-hero`, `tax-return-pricing` or `tax-return-footer`. The banner and the home page card open `/tax-return/`.
- **Thank-you page:** `/tax-return/thank-you/` (not indexed). Paste the Google Ads conversion tag into `googleAdsConversionSnippet` in the config and rebuild.
- **Google reviews:** fill in `config/site.json` (count and profile link). Until then the site says "Rated 5.0 on Google" with no link.
- The original brief is in `design/sa-campaign-handover.md`.
