// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';

// Vercel builds set VERCEL=1; local dev / `npm start` keep the standalone Node server.
export default defineConfig({
  output: 'server',
  adapter: process.env.VERCEL ? vercel() : node({ mode: 'standalone', bodySizeLimit: 12 * 1024 * 1024 }),
  server: { port: 4321 },
});
