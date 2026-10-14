-- One JSON snapshot per authenticated Google/Supabase account.
-- Already applied to Supabase project zeepmabytylpsjkxatva on 2026-10-14.
CREATE TABLE IF NOT EXISTS public.game_saves (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  save_data jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_saves_payload_check CHECK (
    jsonb_typeof(save_data) = 'object'
    AND save_data->>'format' = 'idle-rpg-cloud-bundle'
    AND (save_data->>'schema') = '1'
    AND jsonb_typeof(save_data->'entries') = 'object'
    AND octet_length(save_data::text) <= 12582912
  )
);

ALTER TABLE public.game_saves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.game_saves FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.game_saves TO authenticated;
CREATE POLICY game_saves_read_own ON public.game_saves
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY game_saves_insert_own ON public.game_saves
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY game_saves_update_own ON public.game_saves
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
