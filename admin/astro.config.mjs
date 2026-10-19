// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// Built only by the meshgrounds-admin Vercel project. There is no local
// standalone-server mode; `astro dev` / `astro build` are the local entrypoints.
export default defineConfig({
  output: 'server',
  adapter: vercel(),
  security: { checkOrigin: true },
  vite: {
    // Pin tsconfig discovery to this package. Rolldown's auto discovery walks
    // past a tsconfig that doesn't cover the resolved file (e.g. virtual
    // modules, index.html) up to the repo-root tsconfig.json, whose
    // `extends: "astro/tsconfigs/strict"` is unresolvable when only admin's
    // node_modules is installed (the CI `admin` job) and fails the build.
    tsconfig: './tsconfig.json',
  },
});
