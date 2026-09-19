-- Assets & Access — asset handover acknowledgement.
--
-- WHAT THIS IS
-- ------------
-- The employee acceptance that already exists (accept_employee_asset,
-- 20260722000000, logged since 20260727000000) becomes an ACKNOWLEDGEMENT OF
-- STATED TERMS against a STATED CONDITION, instead of a bare status flip.
--
-- It is the SAME flow, extended. No second acceptance system is introduced:
-- employee_assets keeps its one row per custody period, `pending_acceptance`
-- still means "handed over, not yet acknowledged", and accept_employee_asset()
-- is still the only way out of that state.
--
-- THE TWO HALVES
-- --------------
--   1. HANDOVER FACTS, recorded by the assigning user BEFORE the employee is
--      asked to accept: condition at issue, accessories issued, and any
--      existing issue. They live on the assignment row (§3) because they
--      describe THAT handover, not the asset — the same device handed over
--      twice has two conditions and two accessory lists.
--
--      Asset name and serial/asset code are deliberately NOT copied here. They
--      are on `assets`, the assignment row references it, and 20260722000000
--      made that reference ON DELETE RESTRICT precisely so custody history
--      cannot be orphaned. A snapshot would be a second copy that can drift.
--
--   2. ACCEPTANCE, recorded when the employee acknowledges: who accepted, when,
--      WHICH VERSION of the terms, and the EXACT TEXT they were shown.
--
-- WHY THE TERMS TEXT IS SNAPSHOTTED, AND WHY THE CLIENT CANNOT SUPPLY IT
-- ---------------------------------------------------------------------
-- A signature is worth what the signer can be shown to have read. If the sheet
-- rendered today's terms for an acceptance made a year ago, an amended clause
-- would silently rewrite history. So the body is copied onto the assignment
-- row at acceptance.
--
-- And the copy is taken by the DATABASE from asset_handover_terms (§1), never
-- from a parameter. A caller that could post its own `terms` text could record
-- an acceptance of terms nobody ever displayed. accept_employee_asset() takes
-- an acknowledgement BOOLEAN and nothing more.
--
-- DATABASE-FIRST ROLLOUT: NOTHING HERE BREAKS THE DEPLOYED FRONTEND
-- -----------------------------------------------------------------
-- This migration is applied BEFORE the new frontend ships, and the currently
-- deployed frontend must keep working in the window between the two. Both RPCs
-- it calls stay callable:
--
--   accept_employee_asset(uuid)           KEPT, as a legacy wrapper (§5c).
--                                         The old Accept button still works and
--                                         still records a complete acceptance.
--   accept_employee_asset(uuid, boolean)  NEW. The explicit acknowledgement the
--                                         new UI's checkbox sends (§5b).
--   assign_asset(...)                     The 5-argument signature is replaced
--                                         by a 7-argument one whose two new
--                                         parameters DEFAULT to NULL, so the
--                                         old 5-argument call still resolves
--                                         and simply records no accessories and
--                                         no existing issues (§4).
--
-- WHY THE OVERLOAD IS NOT AMBIGUOUS. NEITHER accept_employee_asset TAKES A
-- DEFAULT. PostgREST picks an overload by matching the SET OF ARGUMENT NAMES in
-- the request body against each candidate's parameters, and a candidate is only
-- eligible when every parameter without a default was supplied. So
-- {p_assignment_id} can satisfy the one-argument function alone, and
-- {p_assignment_id, p_accept_terms} can satisfy the two-argument one alone.
-- Giving p_accept_terms a DEFAULT would make both eligible for the first case
-- and produce PGRST203 "could not choose the best candidate function" — which is
-- why it deliberately has none. §6 asserts pronargdefaults = 0 on both.
--
-- ── FOLLOW-UP CLEANUP, TO BE DONE IN A LATER MIGRATION ──────────────────────
--
--   Once the new frontend is stable in production and no client is calling the
--   one-argument form any more, drop the legacy wrapper:
--
--       DROP FUNCTION IF EXISTS public.accept_employee_asset(uuid);
--
--   Do NOT do it here, and do not do it in the same release as the frontend.
--   Check first that nothing is still calling it — every legacy acceptance is
--   logged with "acknowledged_explicitly": false in asset_activity_log.details,
--   so:
--
--       SELECT max(event_at) FROM public.asset_activity_log
--        WHERE event_type = 'assignment_accepted'
--          AND details ->> 'acknowledged_explicitly' = 'false';
--
--   answers "when did the last old client accept an asset". When that is safely
--   behind the frontend rollout, the wrapper can go.
--
--   After it is dropped, the remaining two-argument function may be given
--   `p_accept_terms boolean DEFAULT false` if a default is ever wanted — the
--   ambiguity that forbids it today disappears with the wrapper.
--
-- NOT IN SCOPE (deliberately)
--   No e-signature, no upload, no reminder, no damage-recovery calculation, no
--   approval step, no notification type. Nothing about return conditions, and
--   no change to any asset permission — assigning still requires `assign` and
--   accepting is still restricted to the allocated employee.

-- ═══ 1. The terms, versioned ════════════════════════════════════════════════
--
-- A table rather than a constant in a function body, so that amending the terms
-- is an INSERT of a new version beside the old one, and every acceptance that
-- referenced the old version keeps pointing at text that still exists.
--
-- Readable by every authenticated user: an employee must be able to read the
-- terms in order to accept them, and there is nothing confidential in them.
-- NO write policy for anybody — a new version arrives by migration, so an
-- administrator cannot rewrite the terms an acceptance was made against.

CREATE TABLE IF NOT EXISTS public.asset_handover_terms (
  version    text        PRIMARY KEY,
  body       text        NOT NULL,
  is_current boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly one current version, enforced by the index rather than by convention.
CREATE UNIQUE INDEX IF NOT EXISTS asset_handover_terms_current_idx
  ON public.asset_handover_terms ((is_current)) WHERE is_current;

ALTER TABLE public.asset_handover_terms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "asset_handover_terms_select" ON public.asset_handover_terms;
CREATE POLICY "asset_handover_terms_select" ON public.asset_handover_terms
  FOR SELECT TO authenticated
  USING (true);

-- v1. This body is mirrored CHARACTER FOR CHARACTER by ASSET_HANDOVER_TERMS_BODY
-- in src/lib/assets/handover.ts, and src/lib/assets/handover.test.ts fails the
-- build if the two ever differ — the screen an employee reads and the text the
-- database snapshots must be the same text.
INSERT INTO public.asset_handover_terms (version, body, is_current)
VALUES ('v1', $terms$1. I confirm that I have received the listed company asset(s) in the stated condition, along with the listed accessories.
2. I have noted any existing issue before accepting the handover. Any issue not recorded at handover will be treated as not reported at that time.
3. I will use the asset carefully, keep it secure, and return it in substantially the same condition, allowing for normal wear from proper use.
4. I will promptly report loss, damage, theft, malfunction, or any concern to the company.
5. I will keep the asset safely when not in use. BOE has provided locker facilities; I may request a suitable cover or bag where required.
6. I remain responsible for reasonable care of the asset inside and outside the office. BOE is not responsible for loss or damage arising from my personal handling or storage of the asset.
7. On return, any damage or loss caused by negligence will be reviewed with me. Any recovery, if applicable, will follow company process and applicable law.$terms$, true)
ON CONFLICT (version) DO NOTHING;

-- ═══ 2. The current terms, as one readable call ═════════════════════════════

CREATE OR REPLACE FUNCTION public.current_asset_handover_terms()
RETURNS public.asset_handover_terms
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT * FROM public.asset_handover_terms WHERE is_current LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.current_asset_handover_terms() TO authenticated;

-- ═══ 3. The assignment row carries the handover ═════════════════════════════
--
-- All six columns are NULLABLE and none is backfilled. A custody period opened
-- before this migration genuinely has no recorded condition and no
-- acknowledgement, and inventing one would be the worst possible thing to do to
-- an accountability record. The screens read NULL as "not recorded".
--
-- accepted_by is stored even though it can only ever equal employee_id (§5
-- refuses anyone else). The redundancy is the point: it is the column that says
-- WHO PERFORMED the acknowledgement, and reading it back is how a later audit
-- confirms the constraint held rather than assuming it.

ALTER TABLE public.employee_assets
  ADD COLUMN IF NOT EXISTS handover_condition       text,
  ADD COLUMN IF NOT EXISTS handover_accessories     text,
  ADD COLUMN IF NOT EXISTS handover_existing_issues text,
  ADD COLUMN IF NOT EXISTS accepted_by              uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS acceptance_version       text,
  ADD COLUMN IF NOT EXISTS accepted_terms           text;

COMMENT ON COLUMN public.employee_assets.handover_condition IS
  'Condition of the asset as issued, recorded by the assigning user at handover.';
COMMENT ON COLUMN public.employee_assets.handover_accessories IS
  'Accessories handed over with the asset (charger, bag, mouse…), free text.';
COMMENT ON COLUMN public.employee_assets.handover_existing_issues IS
  'Faults already present at handover. NULL means none was recorded, which the '
  'terms treat as "not reported at that time".';
COMMENT ON COLUMN public.employee_assets.accepted_by IS
  'Who acknowledged. Always equals employee_id — accept_employee_asset refuses '
  'anyone else — and is stored so an audit can verify that rather than assume it.';
COMMENT ON COLUMN public.employee_assets.acceptance_version IS
  'asset_handover_terms.version in force at acceptance.';
COMMENT ON COLUMN public.employee_assets.accepted_terms IS
  'The EXACT terms body shown at acceptance, copied by the database. Never '
  'supplied by the caller.';

-- ═══ 4. assign_asset records the handover ═══════════════════════════════════
--
-- Body is 20260730000000 §1's, unchanged in every respect except that the two
-- new facts are accepted and that the condition, accessories and issues are now
-- WRITTEN ONTO THE ASSIGNMENT ROW as well as onto the movement record. The
-- movement record already carried `condition`; it describes the movement, while
-- the assignment row is what the handover sheet and the acceptance screen read.
--
-- Same authorization (`assign`), same availability checks, same activity entry,
-- same suppression of the edit trigger around the asset UPDATE.
--
-- ROLLOUT-SAFE. The five-argument signature is REPLACED rather than kept
-- beside the new one — exactly as 20260730000000 replaced the two-argument
-- one — because the two new parameters DEFAULT to NULL. The deployed
-- frontend's five-argument call therefore still resolves, against this
-- function, and records a handover with no accessories and no existing issues
-- noted; that is the truth about an assignment made by a client that never
-- collected them. Keeping BOTH signatures is what would break it: two eligible
-- candidates for the same five argument names is PGRST203.

DROP FUNCTION IF EXISTS public.assign_asset(uuid, uuid, date, text, text);

CREATE OR REPLACE FUNCTION public.assign_asset(
  p_asset_id        uuid,
  p_employee_id     uuid,
  p_effective_date  date DEFAULT NULL,
  p_condition       text DEFAULT NULL,
  p_remarks         text DEFAULT NULL,
  p_accessories     text DEFAULT NULL,
  p_existing_issues text DEFAULT NULL
)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         uuid := public.assert_asset_custody_permission(
                          'assign', 'You do not have permission to assign assets');
  v_asset       public.assets;
  v_prev_status text;
  v_prev_loc    text;
  v_assignment  uuid;
  v_employee    text;
  v_dept        text;
  v_condition   text := NULLIF(btrim(COALESCE(p_condition,       '')), '');
  v_accessories text := NULLIF(btrim(COALESCE(p_accessories,     '')), '');
  v_issues      text := NULLIF(btrim(COALESCE(p_existing_issues, '')), '');
BEGIN
  SELECT * INTO v_asset FROM public.assets WHERE id = p_asset_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: This asset no longer exists' USING ERRCODE = '42501';
  END IF;

  IF v_asset.status <> 'available' THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is not available to assign', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF public.current_asset_custody(p_asset_id) IS NOT NULL THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: "%" is already held by someone', v_asset.asset_name
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_employee_id AND is_active) THEN
    RAISE EXCEPTION 'ASSET_CUSTODY_INVALID: That employee is not active' USING ERRCODE = '42501';
  END IF;

  v_prev_status := v_asset.status;
  v_prev_loc    := v_asset.location;
  v_dept        := public.asset_employee_department(p_employee_id);

  INSERT INTO public.employee_assets (
    asset_id, employee_id, assigned_by, status,
    handover_condition, handover_accessories, handover_existing_issues
  )
  VALUES (
    p_asset_id, p_employee_id, v_uid, 'pending_acceptance',
    v_condition, v_accessories, v_issues
  )
  RETURNING id INTO v_assignment;

  PERFORM public.set_asset_edit_logging(false);
  UPDATE public.assets
     SET status     = 'assigned',
         location   = NULL,
         department = v_dept
   WHERE id = p_asset_id
  RETURNING * INTO v_asset;
  PERFORM public.set_asset_edit_logging(true);

  v_employee := public.asset_user_display_name(p_employee_id);

  PERFORM public.record_asset_transfer(
    p_asset_id, 'assigned',
    NULL, p_employee_id,
    v_prev_loc, NULL,
    NULL, v_dept,
    p_effective_date, p_condition, p_remarks, v_uid
  );

  PERFORM public.log_asset_activity(
    p_asset_id, 'asset_assigned',
    'Assigned to ' || coalesce(v_employee, 'an employee'),
    v_uid, p_employee_id,
    jsonb_build_object(
      'assignment_id',   v_assignment,
      'employee_name',   v_employee,
      'actor_name',      public.asset_user_display_name(v_uid),
      'previous_status', v_prev_status,
      'new_status',      v_asset.status,
      'acceptance',      'pending_acceptance',
      'department',      v_dept,
      'effective_date',  p_effective_date,
      'condition',       v_condition,
      'accessories',     v_accessories,
      'existing_issues', v_issues,
      'remarks',         NULLIF(btrim(COALESCE(p_remarks, '')), '')
    )
  );

  RETURN v_asset;
END;
$$;

REVOKE ALL     ON FUNCTION public.assign_asset(uuid, uuid, date, text, text, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.assign_asset(uuid, uuid, date, text, text, text, text) TO authenticated;

-- ═══ 5. Acceptance is an acknowledgement ════════════════════════════════════
--
-- ONE implementation, TWO entry points. The acceptance itself is written in
-- exactly one place (§5a) so the legacy path and the new path cannot drift
-- apart about what an acceptance records; the two public functions differ only
-- in whether the caller stated the acknowledgement explicitly.

-- 5a. The implementation.
--
-- Every guard from 20260722000000 §2 and 20260727000000 §7 is retained
-- verbatim: authentication, ONE message for "no such assignment" and "not
-- yours" (so assignment ids cannot be probed), a refusal once the row has left
-- pending_acceptance, the same guards repeated in the UPDATE's WHERE clause so
-- a concurrent return cannot slip in, and the same activity log entry.
--
-- What is added:
--
--   * accepted_by is written from auth.uid(), never from a parameter;
--   * the version and body are read from asset_handover_terms INSIDE this
--     function, so what is stored is what the terms actually say and a caller
--     cannot record an acknowledgement of text it invented;
--   * the activity entry records WHICH PATH was used, so the follow-up cleanup
--     in this file's header can be decided from evidence rather than from
--     optimism.
--
-- accepted_at remains the database's to set: there is no parameter through
-- which a timestamp could arrive.
--
-- NOT executable by `authenticated`. It is reached only through §5b and §5c,
-- which are SECURITY DEFINER and therefore run as the owner — the same shape
-- record_asset_transfer() has had since 20260730000000. That is what stops a
-- client from calling the implementation directly and choosing
-- p_explicit_acknowledgement for itself.

CREATE OR REPLACE FUNCTION public.accept_employee_asset_impl(
  p_assignment_id            uuid,
  p_explicit_acknowledgement boolean
)
RETURNS public.employee_assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_row   public.employee_assets;
  v_terms public.asset_handover_terms;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required to accept an asset'
      USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_terms FROM public.current_asset_handover_terms();

  IF v_terms.version IS NULL THEN
    RAISE EXCEPTION 'ASSET_ACCEPT_TERMS_MISSING: No Asset Handover Terms are published'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.employee_assets
  WHERE id = p_assignment_id;

  IF NOT FOUND OR v_row.employee_id <> v_uid THEN
    RAISE EXCEPTION 'ASSET_ACCEPT_DENIED: No pending assignment found for you'
      USING ERRCODE = '42501';
  END IF;

  IF v_row.status <> 'pending_acceptance' THEN
    RAISE EXCEPTION 'ASSET_ACCEPT_INVALID: This assignment is already % and cannot be accepted', v_row.status
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.employee_assets
     SET status             = 'accepted',
         accepted_at        = now(),
         accepted_by        = v_uid,
         acceptance_version = v_terms.version,
         accepted_terms     = v_terms.body
   WHERE id          = p_assignment_id
     AND employee_id = v_uid
     AND status      = 'pending_acceptance'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_ACCEPT_CONFLICT: This assignment changed while you were accepting it'
      USING ERRCODE = '40001';
  END IF;

  PERFORM public.log_asset_activity(
    v_row.asset_id, 'assignment_accepted',
    'Accepted by ' || coalesce(public.asset_user_display_name(v_uid), 'the custodian'),
    v_uid, v_uid,
    jsonb_build_object(
      'assignment_id',      v_row.id,
      'employee_name',      public.asset_user_display_name(v_uid),
      'actor_name',         public.asset_user_display_name(v_uid),
      'accepted_at',        v_row.accepted_at,
      'acceptance_version', v_row.acceptance_version,
      -- false = accepted through the legacy one-argument RPC by a frontend
      -- that predates the checkbox. The acceptance is complete either way; this
      -- is how the cleanup migration knows when the wrapper stopped being used.
      'acknowledged_explicitly', p_explicit_acknowledgement
    )
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_employee_asset_impl(uuid, boolean)
  FROM public, anon, authenticated;

-- 5b. THE NEW ENTRY POINT — the checkbox, checked on the server.
--
-- p_accept_terms has NO DEFAULT, deliberately. See the header: a default would
-- make this function eligible for a {p_assignment_id} request as well, and
-- PostgREST would then refuse both candidates with PGRST203.
--
-- The gate is real. A screen that forgot to disable its button until the box
-- was ticked would send `false`, and this refuses it.

CREATE OR REPLACE FUNCTION public.accept_employee_asset(
  p_assignment_id uuid,
  p_accept_terms  boolean
)
RETURNS public.employee_assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_accept_terms IS NOT TRUE THEN
    RAISE EXCEPTION 'ASSET_ACCEPT_TERMS_REQUIRED: Confirm you have read and accept the Asset Handover Terms'
      USING ERRCODE = '42501';
  END IF;

  RETURN public.accept_employee_asset_impl(p_assignment_id, true);
END;
$$;

REVOKE ALL   ON FUNCTION public.accept_employee_asset(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.accept_employee_asset(uuid, boolean) TO authenticated;

-- 5c. THE LEGACY ENTRY POINT — TEMPORARY. REMOVE IN A LATER MIGRATION.
--
-- This is the signature the CURRENTLY DEPLOYED frontend calls, and it is kept
-- so that applying this migration before shipping the new frontend does not
-- break the Accept button for every employee in the window between the two.
--
-- It is NOT a weaker acceptance. It goes through the same implementation and
-- writes the same five facts — status, accepted_at, accepted_by, the terms
-- version and the exact terms body. What it cannot do is claim the employee
-- ticked a box that the screen never showed them, so it records
-- "acknowledged_explicitly": false in the activity log and says nothing more
-- than it knows.
--
-- DO NOT point the new UI at this. The new Accept Handover dialog calls §5b
-- with an explicit `true`; see src/components/assets/AssetHandover.tsx.
--
-- CLEANUP: drop this function in a LATER migration, once the new frontend is
-- stable in production and the query in this file's header shows no recent
-- legacy acceptances. Not in this release, and not in the frontend's release.

CREATE OR REPLACE FUNCTION public.accept_employee_asset(p_assignment_id uuid)
RETURNS public.employee_assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.accept_employee_asset_impl(p_assignment_id, false);
END;
$$;

COMMENT ON FUNCTION public.accept_employee_asset(uuid) IS
  'DEPRECATED compatibility wrapper for frontends that predate the Asset Handover '
  'Terms checkbox (20261029000000 section 5c). Records a complete acceptance but '
  'cannot evidence an explicit acknowledgement, so it logs '
  'acknowledged_explicitly=false. DROP IT in a later migration once the new '
  'frontend is stable in production.';

REVOKE ALL   ON FUNCTION public.accept_employee_asset(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.accept_employee_asset(uuid) TO authenticated;

-- ═══ 6. Post-conditions ═════════════════════════════════════════════════════

DO $$
DECLARE
  v_count int;
BEGIN
  -- 6a. Exactly one current terms version, and it is v1.
  SELECT count(*) INTO v_count FROM public.asset_handover_terms WHERE is_current;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: expected exactly 1 current terms version, found %', v_count;
  END IF;
  IF (SELECT version FROM public.current_asset_handover_terms()) IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: the current terms version is not v1';
  END IF;
  IF (SELECT body FROM public.current_asset_handover_terms()) NOT LIKE '%7. On return, any damage or loss%' THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: the seeded terms body is truncated';
  END IF;

  -- 6b. The six assignment columns exist.
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'employee_assets'
    AND column_name IN ('handover_condition', 'handover_accessories', 'handover_existing_issues',
                        'accepted_by', 'acceptance_version', 'accepted_terms');
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: expected 6 handover columns on employee_assets, found %', v_count;
  END IF;

  -- 6c. BOTH accept_employee_asset entry points exist — the new one and the
  --     legacy wrapper the deployed frontend still calls.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'accept_employee_asset';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: expected 2 accept_employee_asset entry points '
                    '(new + legacy wrapper), found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'accept_employee_asset'
      AND pg_catalog.oidvectortypes(p.proargtypes) = 'uuid, boolean'
  ) THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: accept_employee_asset does not take the acknowledgement flag';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'accept_employee_asset'
      AND pg_catalog.oidvectortypes(p.proargtypes) = 'uuid'
  ) THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: the legacy one-argument accept_employee_asset is missing — '
                    'the deployed frontend would break during a database-first rollout';
  END IF;

  -- 6c(ii). NEITHER may take a DEFAULT. This is the assertion that keeps the
  --     overload resolvable: a default on p_accept_terms would make the
  --     two-argument function eligible for a {p_assignment_id} request as well,
  --     and PostgREST would answer PGRST203 for every acceptance instead of
  --     picking one. It is the single most likely way a later edit breaks this.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'accept_employee_asset'
    AND p.pronargdefaults > 0;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: % accept_employee_asset overload(s) declare a DEFAULT; '
                    'that makes the PostgREST call ambiguous (PGRST203)', v_count;
  END IF;

  -- 6c(iii). The shared implementation is NOT reachable by a client. Only the
  --     two SECURITY DEFINER wrappers may call it, which is what stops a caller
  --     from choosing p_explicit_acknowledgement for itself.
  IF has_function_privilege('authenticated',
       'public.accept_employee_asset_impl(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: accept_employee_asset_impl must not be executable by authenticated';
  END IF;

  -- …while both entry points ARE.
  IF NOT has_function_privilege('authenticated',
        'public.accept_employee_asset(uuid, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
        'public.accept_employee_asset(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: an accept_employee_asset entry point is not executable by authenticated';
  END IF;

  -- 6d. assign_asset is the OPPOSITE case and must stay a single function: one
  --     signature whose trailing five parameters all default, so the deployed
  --     frontend's five-argument call and the new seven-argument call both
  --     resolve against it. A second overload here WOULD be the ambiguity.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'assign_asset';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: expected 1 assign_asset, found %', v_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'assign_asset'
      AND pg_catalog.oidvectortypes(p.proargtypes) = 'uuid, uuid, date, text, text, text, text'
      -- p_effective_date, p_condition, p_remarks, p_accessories, p_existing_issues.
      -- Without all five defaulted the old five-argument call stops resolving.
      AND p.pronargdefaults = 5
  ) THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: assign_asset does not take the handover facts with the '
                    'five trailing defaults the deployed frontend relies on';
  END IF;

  -- 6e. Nothing was backfilled. Acceptances made before this migration must
  --     read as "not recorded", never as an acknowledgement that never happened.
  SELECT count(*) INTO v_count
  FROM public.employee_assets
  WHERE accepted_at IS NOT NULL AND acceptance_version IS NOT NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ASSET_HANDOVER: % pre-existing acceptance(s) were given a terms version', v_count;
  END IF;

  RAISE NOTICE 'ASSET_HANDOVER: all post-conditions passed';
END $$;
