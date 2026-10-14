-- Single active game session per Supabase Auth user.
-- New game login atomically replaces the previous one. Older sessions cannot read/write saves.
CREATE TABLE IF NOT EXISTS public.game_sessions (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    session_id uuid NOT NULL,
    claimed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.game_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.game_sessions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_game_session(p_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := (SELECT auth.uid());
BEGIN
    IF v_uid IS NULL OR p_session IS NULL THEN
        RAISE EXCEPTION 'GAME_SESSION_REQUIRED';
    END IF;
    INSERT INTO public.game_sessions (user_id,session_id,claimed_at)
        VALUES (v_uid,p_session,now())
    ON CONFLICT (user_id) DO UPDATE
        SET session_id=EXCLUDED.session_id, claimed_at=now();
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.game_session_alive(p_session uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
    SELECT EXISTS(
        SELECT 1 FROM public.game_sessions s
        WHERE s.user_id=(SELECT auth.uid()) AND s.session_id=p_session
    );
$$;

CREATE OR REPLACE FUNCTION public.read_game_save(p_session uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_uid uuid := (SELECT auth.uid());
    v_data jsonb;
BEGIN
    IF v_uid IS NULL OR p_session IS NULL OR NOT EXISTS(
        SELECT 1 FROM public.game_sessions
        WHERE user_id=v_uid AND session_id=p_session
    ) THEN
        RAISE EXCEPTION 'GAME_SESSION_REPLACED';
    END IF;
    SELECT to_jsonb(x) INTO v_data FROM (
        SELECT revision, save_data, updated_at FROM public.game_saves
        WHERE user_id=v_uid
    ) x;
    RETURN v_data;
END;
$$;

CREATE OR REPLACE FUNCTION public.write_game_save(
    p_session uuid, p_expected_revision bigint, p_data jsonb
)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_uid uuid := (SELECT auth.uid());
    v_revision bigint;
BEGIN
    IF v_uid IS NULL OR p_session IS NULL OR p_data IS NULL
        OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
        RAISE EXCEPTION 'GAME_SESSION_REQUIRED';
    END IF;
    -- Row lock serializes new claims against any in-flight save transaction.
    PERFORM 1 FROM public.game_sessions
      WHERE user_id=v_uid AND session_id=p_session FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_SESSION_REPLACED'; END IF;

    IF p_expected_revision = 0 THEN
        INSERT INTO public.game_saves(user_id,save_data,revision)
        VALUES (v_uid,p_data,1)
        ON CONFLICT (user_id) DO NOTHING
        RETURNING revision INTO v_revision;
    ELSE
        UPDATE public.game_saves SET save_data=p_data,
            revision=revision+1,updated_at=now()
        WHERE user_id=v_uid AND revision=p_expected_revision
        RETURNING revision INTO v_revision;
    END IF;
    IF v_revision IS NULL THEN
        RAISE EXCEPTION 'SAVE_REVISION_CONFLICT';
    END IF;
    RETURN v_revision;
END;
$$;

-- All cloud saves must go through token-checked RPC. Authenticated JWT alone
-- is insufficient after the user has signed in from another tab/device.
REVOKE ALL ON TABLE public.game_saves FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_game_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.game_session_alive(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_game_save(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.write_game_save(uuid,bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_game_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.game_session_alive(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.read_game_save(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.write_game_save(uuid,bigint,jsonb) TO authenticated;
