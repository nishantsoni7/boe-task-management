-- ═══════════════════════════════════════════════════════════════════════════
-- PI EDITING — a READ-ONLY posture check for 20260927000000 … 20261003000000
--
-- WHAT THIS IS FOR. The behavioural assertion scripts prove the rules hold
-- SOMEWHERE — on a scratch database, with fixture rows, inside a transaction
-- that ends in ROLLBACK. Nothing else asks whether those properties survived
-- the trip to the database people actually use.
--
-- SO THIS WRITES NOTHING. Every check below is a catalog read. There is no
-- INSERT, no UPDATE, no DELETE, no TRUNCATE, no fixture and no transaction to
-- roll back, which is what makes it safe to run against production — where the
-- question matters most and where the assertion scripts must never go.
--
-- RUN IT IMMEDIATELY AFTER APPLYING the seven migrations:
--
--     psql "$DATABASE_URL" -f supabase/tests/order_pi_editing_posture.sql
--
-- It prints POSTURE OK, or names every property that did not hold.
--
-- Companion to order_confirmed_handoff_posture.sql, which covers the three
-- document migrations that precede these.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

do $$
declare
  n_pass int := 0; n_fail int := 0;
  bad text[] := '{}';
  v_name text; v_def text; v_int int; v_bool boolean; v_pinned boolean;

  -- Server-only: reached by the import worker or by another function, never by
  -- a browser. A grant here is a capability escalation.
  server_only constant text[] := array[
    'public.assert_order_submission_workbook_editor(uuid, uuid, text, boolean)',
    'public.assert_order_submission_editor(uuid, uuid)',
    'public.replace_order_submission_parse(uuid, uuid, jsonb)',
    'public.begin_order_submission_processing(uuid, uuid, uuid)',
    'public.supersede_order_documents(uuid, text)',
    'public.log_order_document_event(uuid, uuid, text, jsonb)'
  ];

  -- Client-facing: the editors a signed-in employee calls directly. Each
  -- re-derives its own authority; the grant only decides who may ask.
  client_facing constant text[] := array[
    'public.can_edit_order_submission(uuid)',
    'public.can_admin_edit_order_submission(uuid)',
    'public.update_order_submission_client_details(uuid, jsonb, integer, text)',
    'public.update_order_submission_schedule_terms(uuid, jsonb, integer, text)',
    'public.update_order_submission_item_details(uuid, jsonb, integer, text)',
    'public.reorder_order_submission_items(uuid, uuid[], integer, text)',
    'public.request_order_submission_correction(uuid, text, text, text)',
    'public.set_order_submission_billing_percentage(uuid, numeric, text)'
  ];

  -- The twenty-four the closed set must admit.
  actions constant text[] := array[
    'submission_created', 'parse_replaced', 'submitted', 'changes_requested',
    'rejected', 'advance_exception_requested', 'advance_exception_approved',
    'advance_exception_rejected', 'finance_verified', 'approved',
    'payment_recorded', 'payment_allocations_moved',
    'billing_percentage_set', 'billing_percentage_amended_by_admin',
    'client_details_updated', 'client_details_amended_by_admin',
    'schedule_terms_updated', 'schedule_terms_amended_by_admin',
    'correction_requested', 'correction_resolved', 'correction_rejected',
    'product_details_updated', 'product_details_amended_by_admin',
    'workbook_replaced_by_admin'
  ];

  procedure_missing text[] := '{}';
begin
  -- ═══ 1. EVERYTHING THE SEVEN MIGRATIONS DEFINE IS INSTALLED ═════════════
  foreach v_name in array (server_only || client_facing) loop
    if to_regprocedure(v_name) is null then
      procedure_missing := array_append(procedure_missing, v_name);
    end if;
  end loop;
  if array_length(procedure_missing, 1) is null then n_pass := n_pass + 1;
  else bad := array_append(bad, '1. not installed: ' || array_to_string(procedure_missing, ', ')); n_fail := n_fail + 1; end if;

  if to_regclass('public.order_submission_correction_requests') is not null then n_pass := n_pass + 1;
  else bad := array_append(bad, '1b. order_submission_correction_requests is missing'); n_fail := n_fail + 1; end if;

  -- ═══ 2. EVERY ONE IS SECURITY DEFINER WITH A PINNED search_path ═════════
  --
  -- An unpinned search_path on a definer function is the classic escalation:
  -- the caller chooses which schema `users` means.
  for v_name in select unnest(server_only || client_facing) loop
    select p.prosecdef,
           'search_path=public, pg_temp' = any(coalesce(p.proconfig, '{}'))
      into v_bool, v_pinned
    from pg_proc p where p.oid = to_regprocedure(v_name);
    if v_bool is null then continue; end if;
    if not v_bool then
      bad := array_append(bad, format('2. %s is not SECURITY DEFINER', v_name)); n_fail := n_fail + 1;
    elsif not coalesce(v_pinned, false) then
      bad := array_append(bad, format('2. %s does not pin search_path', v_name)); n_fail := n_fail + 1;
    else
      n_pass := n_pass + 1;
    end if;
  end loop;

  -- ═══ 3. THE SERVER-ONLY FUNCTIONS ARE UNREACHABLE FROM A BROWSER ════════
  foreach v_name in array server_only loop
    if to_regprocedure(v_name) is null then continue; end if;
    if has_function_privilege('authenticated', to_regprocedure(v_name), 'execute')
       or has_function_privilege('anon', to_regprocedure(v_name), 'execute') then
      bad := array_append(bad, format('3. %s is callable by a browser role', v_name)); n_fail := n_fail + 1;
    else
      n_pass := n_pass + 1;
    end if;
  end loop;

  -- The import worker keeps the two grants it needs, and nothing else does.
  foreach v_name in array array[
    'public.replace_order_submission_parse(uuid, uuid, jsonb)',
    'public.begin_order_submission_processing(uuid, uuid, uuid)'
  ] loop
    if to_regprocedure(v_name) is not null
       and has_function_privilege('service_role', to_regprocedure(v_name), 'execute')
    then n_pass := n_pass + 1;
    else bad := array_append(bad, format('3b. the import worker cannot call %s', v_name)); n_fail := n_fail + 1; end if;
  end loop;

  -- ═══ 4. THE CLIENT-FACING EDITORS ARE REACHABLE, AND NOT BY anon ════════
  foreach v_name in array client_facing loop
    if to_regprocedure(v_name) is null then continue; end if;
    if not has_function_privilege('authenticated', to_regprocedure(v_name), 'execute') then
      bad := array_append(bad, format('4. %s is not callable by a signed-in employee', v_name)); n_fail := n_fail + 1;
    elsif has_function_privilege('anon', to_regprocedure(v_name), 'execute') then
      bad := array_append(bad, format('4. %s is callable by anon', v_name)); n_fail := n_fail + 1;
    else
      n_pass := n_pass + 1;
    end if;
  end loop;

  -- ═══ 5. THE OWNER RULE WAS NOT WIDENED ══════════════════════════════════
  --
  -- The whole shape of 20260927000000 and 20261003000000 is a SECOND predicate
  -- beside the first. If the admin rule ever appears inside the owner rule, an
  -- admin silently acquires every write path the owner rule gates — items,
  -- images, files and the submission itself — unaudited.
  select pg_get_functiondef(oid) into v_def
  from pg_proc where oid = to_regprocedure('public.can_edit_order_submission(uuid)');
  if v_def is not null and position('can_admin_edit' in v_def) = 0
     and position($q$status in ('draft', 'needs_changes')$q$ in v_def) > 0
  then n_pass := n_pass + 1;
  else bad := array_append(bad, '5. can_edit_order_submission is not the unwidened owner rule'); n_fail := n_fail + 1; end if;

  select pg_get_functiondef(oid) into v_def
  from pg_proc where oid = to_regprocedure('public.assert_order_submission_editor(uuid, uuid)');
  if v_def is not null and position('workbook_editor' in v_def) = 0
  then n_pass := n_pass + 1;
  else bad := array_append(bad, '5b. assert_order_submission_editor was rewritten'); n_fail := n_fail + 1; end if;

  -- ═══ 6. THE LEASE ASKS THE NEW PREDICATE ════════════════════════════════
  --
  -- Without this the Change PI authority is unreachable: an admin is refused a
  -- lease and never arrives at the write.
  select pg_get_functiondef(oid) into v_def
  from pg_proc where oid = to_regprocedure('public.begin_order_submission_processing(uuid, uuid, uuid)');
  if v_def is not null
     and position('assert_order_submission_workbook_editor' in v_def) > 0
     and position('ORDER_SUBMISSION_PROCESSING_BUSY' in v_def) > 0
     and position('order_submission_processing_ttl' in v_def) > 0
  then n_pass := n_pass + 1;
  else bad := array_append(bad, '6. the lease does not carry the new authority, or lost its TTL'); n_fail := n_fail + 1; end if;

  -- ═══ 7. THE ORDER'S IDENTITY IS NEVER ASSIGNED BY A REPLACEMENT ═════════
  select pg_get_functiondef(oid) into v_def
  from pg_proc where oid = to_regprocedure('public.replace_order_submission_parse(uuid, uuid, jsonb)');
  if v_def is null then
    bad := array_append(bad, '7. replace_order_submission_parse is not installed'); n_fail := n_fail + 1;
  else
    foreach v_name in array array[
      'display_number', 'source_order_submission_id', 'status', 'created_by', 'requested_by'
    ] loop
      if v_def ~ ('(?n)^\s*(set\s+)?' || v_name || '\s*=') then
        bad := array_append(bad, format('7. a replacement assigns orders.%s', v_name)); n_fail := n_fail + 1;
      else
        n_pass := n_pass + 1;
      end if;
    end loop;
    foreach v_name in array array['finance_payment_allocations', 'finance_payments'] loop
      if position(v_name in v_def) > 0 then
        bad := array_append(bad, format('7b. a replacement names %s directly', v_name)); n_fail := n_fail + 1;
      else
        n_pass := n_pass + 1;
      end if;
    end loop;
  end if;

  -- ═══ 8. THE ACTION SET ADMITS ALL TWENTY-FOUR, AND IS STILL CLOSED ══════
  --
  -- 20260923000000 is applied to production and logs billing_percentage_set
  -- without declaring it, so every successful billing write fails at the moment
  -- it records what it did. This is the check that says whether that is fixed
  -- HERE.
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and t.relname = 'order_submission_activity'
    and c.conname = 'order_submission_activity_action_check';

  if v_def is null then
    bad := array_append(bad, '8. the action constraint is missing entirely'); n_fail := n_fail + 1;
  else
    v_int := 0;
    foreach v_name in array actions loop
      if position('''' || v_name || '''' in v_def) = 0 then
        bad := array_append(bad, format('8. the action set does not admit %s', v_name)); n_fail := n_fail + 1;
      else
        v_int := v_int + 1;
      end if;
    end loop;
    if v_int = 24 then n_pass := n_pass + 1; end if;

    -- Closed, not open: a constraint rewritten as `action is not null` would
    -- pass every check above.
    if position('= ANY' in v_def) > 0 or position(' IN ' in upper(v_def)) > 0
    then n_pass := n_pass + 1;
    else bad := array_append(bad, '8b. the action constraint is no longer an enumeration'); n_fail := n_fail + 1; end if;
  end if;

  -- ═══ 9. SUPERSESSION IS READABLE AND WRITABLE BY NOBODY ═════════════════
  --
  -- The card must be able to say "not current"; nothing but
  -- supersede_order_documents may set it.
  for v_name in select unnest(array['superseded_at', 'superseded_reason']) loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'order_document_versions'
        and column_name = v_name)
    then
      bad := array_append(bad, format('9. order_document_versions.%s is missing', v_name)); n_fail := n_fail + 1;
    elsif not has_column_privilege('authenticated', 'public.order_document_versions', v_name, 'select') then
      bad := array_append(bad, format('9. %s is not readable by a client', v_name)); n_fail := n_fail + 1;
    elsif has_column_privilege('authenticated', 'public.order_document_versions', v_name, 'update') then
      bad := array_append(bad, format('9. %s is writable by a client', v_name)); n_fail := n_fail + 1;
    else
      n_pass := n_pass + 1;
    end if;
  end loop;

  -- The claim token stays invisible, exactly as before these migrations.
  if has_column_privilege('authenticated', 'public.order_document_versions', 'claim_token', 'select')
     or has_column_privilege('anon', 'public.order_document_versions', 'claim_token', 'select')
  then bad := array_append(bad, '9b. claim_token is readable by a client role'); n_fail := n_fail + 1;
  else n_pass := n_pass + 1; end if;

  -- ═══ 10. row_version EXISTS AND IS A COUNTER, NOT A TIMESTAMP ═══════════
  --
  -- The first cut of the client-details editor used updated_at for optimistic
  -- concurrency. now() is transaction-scoped, so two writes in one transaction
  -- stamp the identical value and a stale edit compares equal to a fresh one.
  select data_type into v_name from information_schema.columns
  where table_schema = 'public' and table_name = 'order_submissions' and column_name = 'row_version';
  if v_name = 'integer' then n_pass := n_pass + 1;
  else bad := array_append(bad, format('10. order_submissions.row_version is %s', coalesce(v_name, 'absent'))); n_fail := n_fail + 1; end if;

  -- ═══ REPORT ════════════════════════════════════════════════════════════
  if n_fail = 0 then
    raise notice 'POSTURE OK (% checks)', n_pass;
  else
    foreach v_name in array bad loop raise notice 'FAIL  %', v_name; end loop;
    raise exception 'POSTURE FAILED: % passed, % failed', n_pass, n_fail;
  end if;
end $$;
