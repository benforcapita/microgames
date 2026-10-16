-- .wasm is on the CDN allowlist. The original check only named image/audio/font/json/text.
alter table public.game_assets drop constraint game_assets_expected_type_check;
alter table public.game_assets add constraint game_assets_expected_type_check
  check (expected_type in ('image', 'audio', 'font', 'json', 'text', 'wasm'));
