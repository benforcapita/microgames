declare namespace App {
  interface Locals {
    supabase: import('@supabase/supabase-js').SupabaseClient;
    user: { id: string; email: string | null } | null;
    profile: import('./lib/server/profiles').Profile | null;
    device: import('./lib/server/device').DeviceKind;
  }
}
