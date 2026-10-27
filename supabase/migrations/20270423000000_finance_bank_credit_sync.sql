-- ═════════════════════════════════════════════════════════════════════════════
-- Bank Statements: sync bank credits into Confirmed Payments
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every customer credit of an uploaded statement should end up as ONE payment
-- in Confirmed Payments, linked to its bank line. `sync_bank_credits` does that
-- for the lines the page names, one line at a time:
--
--   * a credit already linked to a payment is Synced; nothing is done;
--   * otherwise create_payment_from_bank_line (20270419000000) runs on it, so
--     the same rules apply as for the Add to Confirmed button: the ordinary
--     payment door, verified at once only for an admin / a verify_own_payment
--     holder, and every duplicate refusal;
--   * a credit whose bank reference is ALREADY on a recorded payment of the
--     same amount (nothing linked to it yet) is linked to that payment instead
--     of creating a second one;
--   * any other refusal (a same-amount payment within 21 days, no permission, a
--     paise problem …) is kept on the line as `sync_error` and the line stays
--     Not Synced. One bad line never stops the others: each line runs in its
--     own sub-transaction.
--
-- WHICH lines to sync is the caller's choice (the page leaves out credits that
-- look like not-customer money, which the database cannot recognise). The
-- database still refuses a debit, a classified line, and anyone without
-- finance.reconcile + finance.create. At most 200 lines per call.
--
-- Nothing is allocated; payments stay "Not identified" until allocated in
-- Confirmed Payments, where all later linking is done.
--
-- ROLLBACK: drop function public.sync_bank_credits(uuid[]);
--           alter table public.bank_statement_lines drop column sync_error, drop column sync_attempted_at;
-- Payments already created stay (they are ordinary payments).
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.bank_statement_lines
  add column if not exists sync_error        text        null check (sync_error is null or length(sync_error) <= 300),
  add column if not exists sync_attempted_at timestamptz null;

create or replace function public.sync_bank_credits(p_line_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor    uuid;
  v_line     public.bank_statement_lines%rowtype;
  v_id       uuid;
  v_human    text;
  v_pay      public.finance_payment_requests%rowtype;
  v_created  integer := 0;
  v_linked   integer := 0;
  v_already  integer := 0;
  v_failed   jsonb   := '[]'::jsonb;
  v_reason   text;
begin
  v_actor := public.assert_bank_reconcile_door();

  if not public.actor_has_module_permission('finance', 'create') then
    raise exception 'BANK_CREATE_FORBIDDEN: finance.create is required to add a payment' using errcode = '42501';
  end if;
  if p_line_ids is null or cardinality(p_line_ids) = 0 then
    return jsonb_build_object('created', 0, 'linked_existing', 0, 'already_synced', 0, 'failed', '[]'::jsonb);
  end if;
  if cardinality(p_line_ids) > 200 then
    raise exception 'BANK_SYNC_TOO_MANY: at most 200 lines per call' using errcode = '22023';
  end if;

  for v_id in
    select l.id from public.bank_statement_lines l
     where l.id = any (p_line_ids)
     order by l.line_date, l.seq
  loop
    select * into v_line from public.bank_statement_lines where id = v_id;

    if v_line.deposit <= 0 or v_line.classification is not null then
      continue; -- only unclassified credits are synced
    end if;
    if exists (select 1 from public.bank_line_payment_links where line_id = v_id and unlinked_at is null) then
      v_already := v_already + 1;
      continue;
    end if;

    begin
      perform public.create_payment_from_bank_line(v_id, false);
      v_created := v_created + 1;
      update public.bank_statement_lines set sync_error = null, sync_attempted_at = now() where id = v_id;
    exception when others then
      v_reason := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');

      if sqlerrm like 'BANK_PAYMENT_DUPLICATE:%' then
        -- The reference is already on a payment: link it, if it is the same
        -- money and nothing else is linked to it. Otherwise leave it for a person.
        v_human := substring(sqlerrm from 'payment (\S+) already carries');
        select * into v_pay from public.finance_payment_requests
         where human_payment_id = v_human and deleted_at is null and status <> 'rejected' limit 1;
        if found and v_pay.amount = v_line.deposit
           and not exists (select 1 from public.bank_line_payment_links k where k.payment_id = v_pay.id and k.unlinked_at is null) then
          begin
            perform public.link_bank_line_to_payment(v_id, v_pay.id, v_line.deposit);
            v_linked := v_linked + 1;
            update public.bank_statement_lines set sync_error = null, sync_attempted_at = now() where id = v_id;
            continue;
          exception when others then
            v_reason := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
          end;
        end if;
      end if;

      update public.bank_statement_lines
         set sync_error = left(v_reason, 300), sync_attempted_at = now()
       where id = v_id;
      v_failed := v_failed || jsonb_build_object('line_id', v_id, 'reason', left(v_reason, 300));
    end;
  end loop;

  return jsonb_build_object('created', v_created, 'linked_existing', v_linked,
                            'already_synced', v_already, 'failed', v_failed);
end;
$fn$;

comment on function public.sync_bank_credits(uuid[]) is
  'Adds each named unclassified bank credit to Confirmed Payments (create_payment_from_bank_line), or links it to the recorded payment that already carries its bank reference; failures are kept on the line as sync_error. Needs finance.reconcile and finance.create. 20270423000000.';

revoke all on function public.sync_bank_credits(uuid[]) from public, anon;
grant execute on function public.sync_bank_credits(uuid[]) to authenticated;

do $assert$
begin
  if has_function_privilege('anon', 'public.sync_bank_credits(uuid[])', 'execute') then
    raise exception 'sync_bank_credits must not be executable by anon';
  end if;
end
$assert$;
