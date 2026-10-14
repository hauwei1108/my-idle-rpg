-- Security hardening for Supabase's default function grants.
-- Applied to project zeepmabytylpsjkxatva in separate migrations on 2026-10-14.
-- The login and save RPCs are intentionally callable only by authenticated users.
REVOKE EXECUTE ON FUNCTION public.claim_game_session(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.game_session_alive(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.read_game_save(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.write_game_save(uuid,bigint,jsonb) FROM anon;
