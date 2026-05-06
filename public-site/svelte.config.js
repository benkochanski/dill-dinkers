import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      // Single-page-app mode: every route is rendered client-side. The
      // Cloudflare adapter still produces a Worker but it just serves the
      // static shell; data fetching happens in the browser against the
      // Apps Script JSON endpoint.
      fallback: 'index.html'
    }),
    // Routes are dynamic (live data from Apps Script). Disable prerender
    // globally so build doesn't try to crawl them.
    prerender: { entries: [] },
  },
};

export default config;
