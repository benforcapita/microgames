// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// Built only by the meshgrounds-admin Vercel project. There is no local
// standalone-server mode; `astro dev` / `astro build` are the local entrypoints.
export default defineConfig({
  output: 'server',
  adapter: vercel(),
  security: { checkOrigin: true },
});
