/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** CSRF cookie value for this request, set by middleware on GETs past the locks. */
    csrfCookie?: string;
    /** Hidden form-field value matching csrfCookie, ready to embed in forms. */
    csrfField?: string;
  }
}
