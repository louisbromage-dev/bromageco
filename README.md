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
   npm run build
   ```
3. Commit everything (the generated pages and `assets/` included) and push. Vercel deploys whatever is committed; it runs no build step.

If the build stops with "the design has changed shape", a part of the design the build relies on was renamed or removed (for example a page was added). Add the new page to `PAGES` in `tools/build.mjs`, or ask Claude to update the build.
