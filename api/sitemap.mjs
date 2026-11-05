// /sitemap.xml (see the rewrites in vercel.json): the site's pages from the
// last build, plus /insights/ and every published insight from Supabase.
// Kept by Vercel's CDN for an hour, like the insights pages.

import { sitemap } from "./_insights/render.mjs";

export default async function handler(req, res) {
  const out = await sitemap();
  res.statusCode = out.status;
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  res.setHeader("Vercel-CDN-Cache-Control", out.cache);
  res.end(out.xml);
}
