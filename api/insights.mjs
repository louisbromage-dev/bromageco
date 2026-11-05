// /insights/ and /insights/<slug>/ (see the rewrites in vercel.json).
//
// Rendered from Supabase on request and kept by Vercel's CDN for an hour
// (Vercel-CDN-Cache-Control), so a post published in Supabase appears
// within the hour without a redeploy. Browsers always check back, as they do
// for the rest of the site.

import { listPage, postPage } from "./_insights/render.mjs";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const query = req.query || Object.fromEntries(url.searchParams);
  const fromPath = (url.pathname.match(/^\/insights\/([^/]+)\/?$/) || [])[1];
  const slug = query.slug || fromPath || "";
  const category = String(query.category || "");

  const page = slug ? await postPage({ slug: String(slug) }) : await listPage({ category });
  res.statusCode = page.status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  res.setHeader("Vercel-CDN-Cache-Control", page.cache || "no-store");
  res.end(page.html);
}
