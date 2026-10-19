/// <reference types="astro/client" />

import type { RequestAuth } from './lib/auth-supabase';

declare global {
  namespace App {
    interface Locals {
      /** CSRF cookie value for this request, set by middleware on GETs past the locks. */
      csrfCookie?: string;
      /** Hidden form-field value matching csrfCookie, ready to embed in forms. */
      csrfField?: string;
      /** Auth client for the auth routes. Absent everywhere else. */
      auth?: RequestAuth;
    }
  }
}

export {};
