import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The site's public address, used for canonical, Open Graph and sitemap URLs.
 * Set VITE_SITE_URL (e.g. https://sndmart.in); Vercel and Netlify production URLs are used as a fallback.
 */
function resolveSiteUrl(env: Record<string, string>): string {
  const raw =
    env.VITE_SITE_URL ||
    (env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "") ||
    env.URL || // Netlify
    "";
  return raw.replace(/\/+$/, "");
}

// Only these pages are public; everything else needs login and is kept out of search results.
// Guests opening "/" are sent to /auth (the login page), so /auth must stay crawlable.
const PUBLIC_PATHS = ["/"];
const PRIVATE_PATHS = [
  "/onboarding",
  "/cart",
  "/checkout/",
  "/orders",
  "/profile",
  "/notifications",
  "/wallet",
  "/reviews",
  "/addresses",
  "/help",
  "/hotel/",
];

function seo(siteUrl: string): Plugin {
  return {
    name: "sndmart-seo",
    // 'pre': replace the placeholder before Vite parses the HTML's URLs.
    transformIndexHtml: {
      order: "pre",
      handler: (html) => {
        if (siteUrl) return html.split("%SITE_URL%").join(siteUrl);
        // No known address: drop tags that need an absolute URL rather than publish broken ones.
        return html
          .split("\n")
          .filter((line) => !/<(link|meta)[^>]*%SITE_URL%/.test(line))
          .join("\n")
          .split("%SITE_URL%")
          .join("");
      },
    },
    generateBundle() {
      const robots = [
        "User-agent: *",
        "Allow: /",
        ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`),
        ...(siteUrl ? ["", `Sitemap: ${siteUrl}/sitemap.xml`] : []),
        "",
      ].join("\n");
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots });
      if (siteUrl) {
        const today = new Date().toISOString().slice(0, 10);
        const urls = PUBLIC_PATHS.map(
          (p) =>
            `  <url><loc>${siteUrl}${p}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
        ).join("\n");
        this.emitFile({
          type: "asset",
          fileName: "sitemap.xml",
          source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
        });
      } else {
        this.warn(
          "VITE_SITE_URL is not set: canonical/Open Graph URLs and sitemap.xml were skipped.",
        );
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // Empty prefix: also reads host variables such as VERCEL_PROJECT_PRODUCTION_URL and URL.
  const env = loadEnv(mode, ".", "");
  return {
    plugins: [react(), seo(resolveSiteUrl(env))],
    server: { port: 5173, host: true },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom", "react-router-dom", "zustand"],
            supabase: ["@supabase/supabase-js"],
            map: ["leaflet", "react-leaflet"],
          },
        },
      },
    },
  };
});
