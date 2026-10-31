-- ═════════════════════════════════════════════════════════════════════════════
-- Bank Statements: "Synced" is checked, and a person reviews every possible
-- duplicate from the facts the database itself holds
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY. Until now a credit read Synced the moment any link existed, so a linked
-- payment that was later rejected, deleted, edited or still unverified stayed
-- green. The Add button could also override the duplicate check without saying
-- which payments had been looked at, and left no record. Two credits could end
-- up stuck: refused as a duplicate, and refused as fully linked.
--
-- WHAT THIS ADDS
--
--   bank_lines_sync_state(ids)    the one definition of Synced. A credit is in
--                                 sync ONLY when verified, undeleted payments in
--                                 the SAME account cover every rupee of it, and
--                                 no linked payment was edited below what is
--                                 linked to it. Otherwise it names the problem.
--                                 Read live, so a later change shows at once.
--
--   bank_lines_recorded_matches(ids)
--                                 the payments the database itself would refuse
--                                 on, so the screen and the refusal cannot
--                                 disagree. Kinds:
--                                   reference       the bank's reference is on a
--                                                   payment with room left. It
--                                                   IS that payment: link it.
--                                   reference_used  the reference is on a payment
--                                                   already fully linked elsewhere.
--                                                   This credit is real money the
--                                                   payment cannot cover (a remitter's
--                                                   account number repeats on every
--                                                   transfer), but it may be a second
--                                                   stored copy of one credit: never
--                                                   added on its own, a person decides.
--                                   amount          same rupees and paise left, either
--                                                   HDFC account, within 21 days.
--                                   linked_elsewhere
--                                                   the same money, on a payment linked in
--                                                   full to a credit further from its date
--                                                   than this one. That link may be wrong:
--                                                   never added on its own, a person decides.
--
--   add_bank_line_to_confirmed(line, checked ids, reason)
--                                 THE ONLY way a browser adds a credit. When a
--                                 possible match exists it needs the ids the
--                                 person compared and a reason, is refused if any
--                                 OTHER payment matches by then, and writes the
--                                 reason on the new payment. A bank reference on a
--                                 payment with room left is never overridden.
--
--   unlink_bank_line_payment(link, reason)
--                                 a reason is required and kept on the link row.
--
--   bank_sync_overview()          both accounts, every month: credits not in
--                                 sync, payments with no bank credit, and dates
--                                 no uploaded statement covers.
--
--   sync_bank_credits(ids)        links before it adds, and only when it is sure:
--                                 same account, same amount, within 3 days, no
--                                 other payment fits the credit and no other credit
--                                 fits the payment. Two credits that could both be
--                                 one payment wait for a person, so the order of
--                                 the statement never decides whose money it is.
--
-- WHAT THIS CLOSES
--   create_payment_from_bank_line takes the note and is no longer callable from
--   a browser, so its blanket "allow a possible duplicate" flag cannot be sent by
--   anyone. sync_bank_credits still calls it (definer to definer, flag false).
--
-- NOTHING is changed on any payment door: a payment can still be rejected,
-- edited or deleted, and the bank page shows the result truthfully.
-- Nothing here verifies a payment beyond what complete_payment_entry already did.
--
-- ROLLBACK:
--   drop function public.bank_sync_overview();
--   drop function public.add_bank_line_to_confirmed(uuid, uuid[], text);
--   drop function public.bank_lines_recorded_matches(uuid[]);
--   drop function public.bank_lines_sync_state(uuid[]);
--   drop function public.bank_lines_sync_rows(uuid[]);
--   drop function public.create_payment_from_bank_line(uuid, boolean, text);
--   drop function public.unlink_bank_line_payment(uuid, text);
--   drop function public.bank_line_sure_payment(uuid);
--   drop function public.bank_line_payment_matches(uuid);
--   drop function public.bank_line_reference_tokens(text, text);
--   alter table public.bank_line_payment_links drop column unlink_reason;
--   then re-run the create_payment_from_bank_line section of 20270419000000, the
--   sync_bank_credits section of 20270423000000 and the unlink_bank_line_payment
--   section of 20270329000000, with their grants.
-- Payments and links already made stay (they are ordinary rows).
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.bank_line_payment_links
  add column if not exists unlink_reason text null
    check (unlink_reason is null or length(unlink_reason) between 3 and 200);


-- ═══ §1. Which recorded payments could this credit be? ══════════════════════

-- The bank's own reference tokens: the statement reference and every long mixed
-- letters-and-digits word of the narration (UTRs, NEFT/RTGS numbers). An IFSC
-- (four letters, a zero, six characters) names a branch, not a payment.
create or replace function public.bank_line_reference_tokens(p_narration text, p_bank_ref text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select coalesce(array_agg(distinct t), '{}')
    from (
      select x as t
        from regexp_split_to_table(upper(coalesce(p_narration, '')), '[^A-Z0-9]+') as x
       where length(x) >= 10 and x ~ '[0-9]' and x !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
         and x !~ '^0+$'
      union
      select upper(p_bank_ref)
       where p_bank_ref is not null and length(p_bank_ref) >= 8 and p_bank_ref !~ '^0+$'
    ) s;
$fn$;

create or replace function public.bank_line_payment_matches(p_line_id uuid)
returns table (payment_id uuid, match_kind text, left_to_link numeric)
language sql
stable
set search_path = public, pg_temp
as $fn$
  with line as (
    select b.line_date,
           b.deposit - coalesce((select sum(k.amount) from public.bank_line_payment_links k
                                  where k.line_id = b.id and k.unlinked_at is null), 0) as left_on_line,
           public.bank_line_reference_tokens(b.narration, b.bank_ref) as tokens
      from public.bank_statement_lines b
     where b.id = p_line_id and b.deposit > 0
  ),
  recorded as (
    select p.id, p.amount, p.payment_mode, p.payment_date,
           p.amount - coalesce(u.used, 0) as room,
           coalesce(u.on_this_line, false) as on_this_line,
           exists (
             select 1 from line l, unnest(l.tokens) tk
              where p.proof_note is not null
                and position(tk in regexp_replace(upper(p.proof_note), '[^A-Z0-9]', '', 'g')) > 0
           ) as has_reference
      from public.finance_payment_requests p
      left join lateral (
        select sum(k.amount) as used, bool_or(k.line_id = p_line_id) as on_this_line
          from public.bank_line_payment_links k
         where k.payment_id = p.id and k.unlinked_at is null
      ) u on true
     where p.deleted_at is null and p.status <> 'rejected'
  )
  select r.id,
         case when r.has_reference and r.room > 0 then 'reference'
              when r.has_reference then 'reference_used'
              when r.room > 0 then 'amount'
              else 'linked_elsewhere' end,
         greatest(r.room, 0)
    from recorded r, line l
   where (r.has_reference and (r.room > 0 or not r.on_this_line))
      or (r.payment_mode in ('hdfc', 'hdfc_sec')
          and r.payment_date between l.line_date - 21 and l.line_date + 21
          and ((r.room > 0 and r.room = l.left_on_line)
               -- Linked in full, but to a credit further from the payment's date
               -- than this one: the link itself may be the mistake.
               or (r.room <= 0 and not r.on_this_line and r.amount = l.left_on_line
                   and exists (
                     select 1
                       from public.bank_line_payment_links k
                       join public.bank_statement_lines o on o.id = k.line_id
                      where k.payment_id = r.id and k.unlinked_at is null and k.amount = r.amount
                        and abs(o.line_date - r.payment_date) > abs(l.line_date - r.payment_date)
                   ))));
$fn$;

comment on function public.bank_line_payment_matches(uuid) is
  'The recorded payments a bank credit could be (reference / reference_used / amount / linked_elsewhere). Internal: read through bank_lines_recorded_matches. 20270514000000.';


-- ═══ §2. Adding a credit as a payment ═══════════════════════════════════════

drop function if exists public.create_payment_from_bank_line(uuid, boolean);

create function public.create_payment_from_bank_line(
  p_line_id                  uuid,
  p_allow_possible_duplicate boolean default false,
  p_sales_note               text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor     uuid;
  v_line      public.bank_statement_lines%rowtype;
  v_tokens    text[];
  v_ref       text;
  v_human     text;
  v_used      text;
  v_elsewhere text;
  v_possible  text;
  v_res       jsonb;
  v_pay_id    uuid;
  v_done      jsonb;
  v_status    text;
begin
  v_actor := public.assert_bank_reconcile_door();

  if not public.actor_has_module_permission('finance', 'create') then
    raise exception 'BANK_CREATE_FORBIDDEN: finance.create is required to add a payment' using errcode = '42501';
  end if;

  select * into v_line from public.bank_statement_lines where id = p_line_id for update;
  if not found then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_line.deposit <= 0 then
    raise exception 'BANK_LINE_NOT_A_CREDIT: only money in can be added as a payment' using errcode = '22023';
  end if;
  if v_line.classification is not null then
    raise exception 'BANK_LINE_CLASSIFIED: clear the old-order / not-customer-money mark first' using errcode = '22023';
  end if;
  if exists (select 1 from public.bank_line_payment_links where line_id = p_line_id and unlinked_at is null) then
    raise exception 'BANK_LINE_ALREADY_LINKED: this credit is already linked to a payment' using errcode = '22023';
  end if;

  -- The bank's reference on a payment with room left: this credit IS that
  -- payment. Never overridden. The same-amount one first, so a sync links it.
  select coalesce(p.human_payment_id, '(no id)') into v_human
    from public.bank_line_payment_matches(p_line_id) m
    join public.finance_payment_requests p on p.id = m.payment_id
   where m.match_kind = 'reference'
   order by (p.amount = v_line.deposit) desc, p.payment_date, p.human_payment_id
   limit 1;
  if found then
    raise exception 'BANK_PAYMENT_DUPLICATE: payment % already carries this bank reference. Link it instead of adding another.',
      v_human using errcode = '22023';
  end if;

  if not coalesce(p_allow_possible_duplicate, false) then
    select string_agg(coalesce(p.human_payment_id, p.request_number), ', ' order by p.payment_date)
      into v_used
      from public.bank_line_payment_matches(p_line_id) m
      join public.finance_payment_requests p on p.id = m.payment_id
     where m.match_kind = 'reference_used';
    if v_used is not null then
      raise exception 'BANK_PAYMENT_REFERENCE_USED: this bank reference is already on %, which is linked to another bank line. Compare them before adding this one.',
        v_used using errcode = '22023';
    end if;

    select string_agg(coalesce(p.human_payment_id, p.request_number), ', ' order by p.payment_date)
      into v_elsewhere
      from public.bank_line_payment_matches(p_line_id) m
      join public.finance_payment_requests p on p.id = m.payment_id
     where m.match_kind = 'linked_elsewhere';
    if v_elsewhere is not null then
      raise exception 'BANK_PAYMENT_LINKED_ELSEWHERE: this may be %, which is linked to another bank line further from its date. Compare them before adding this one.',
        v_elsewhere using errcode = '22023';
    end if;

    select string_agg(coalesce(p.human_payment_id, p.request_number) || ' (' || coalesce(p.client_name, 'Not identified')
                      || ', ' || to_char(p.payment_date, 'DD Mon YYYY') || ')', ', ' order by p.payment_date)
      into v_possible
      from public.bank_line_payment_matches(p_line_id) m
      join public.finance_payment_requests p on p.id = m.payment_id
     where m.match_kind = 'amount';
    if v_possible is not null then
      raise exception 'BANK_PAYMENT_POSSIBLE_DUPLICATE: this may already be recorded as %. Link that payment instead, or confirm this is a different payment.',
        v_possible using errcode = '22023';
    end if;
  end if;

  v_tokens := public.bank_line_reference_tokens(v_line.narration, v_line.bank_ref);
  v_ref := coalesce(
    (select tk from unnest(v_tokens) tk order by length(tk) desc, tk limit 1),
    'bank statement line');

  -- The ordinary payment door: Finance entry, the paise rule, the current-mode
  -- rule, the id and request number. Suspense: no target, no customer.
  v_res := public.submit_payment_request(
    p_destination => 'suspense',
    p_target_id   => null,
    p_amount      => v_line.deposit,
    p_payment_date => v_line.line_date,
    p_payment_mode => v_line.account,
    p_proof_note  => left('Bank reference ' || v_ref, 200),
    p_sales_note  => coalesce(nullif(btrim(p_sales_note), ''), 'Added from the bank statement'));
  v_pay_id := (v_res ->> 'payment_request_id')::uuid;

  insert into public.bank_line_payment_links (line_id, payment_id, amount, linked_by)
  values (p_line_id, v_pay_id, v_line.deposit, v_actor);

  -- Verifies on the spot only for a self-verifier; otherwise changes nothing.
  v_done := public.complete_payment_entry(v_pay_id);

  select human_payment_id, status into v_human, v_status
    from public.finance_payment_requests where id = v_pay_id;

  return jsonb_build_object(
    'payment_request_id', v_pay_id,
    'request_number',     v_res ->> 'request_number',
    'human_payment_id',   v_human,
    'status',             v_status,
    'verified_on_entry',  coalesce((v_done ->> 'verified_on_entry')::boolean, false));
end;
$fn$;

comment on function public.create_payment_from_bank_line(uuid, boolean, text) is
  'Internal: records an unlinked bank credit as a Suspense payment through submit_payment_request and links it. Callers: sync_bank_credits, add_bank_line_to_confirmed. Not callable from a browser. 20270514000000.';

create or replace function public.add_bank_line_to_confirmed(
  p_line_id             uuid,
  p_checked_payment_ids uuid[] default '{}',
  p_reason              text   default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_checked uuid[] := coalesce(p_checked_payment_ids, '{}');
  v_unseen  text;
  v_seen    text;
begin
  perform public.assert_bank_reconcile_door();

  -- Lock first, so the matches read here are the ones that stand when it is added.
  perform 1 from public.bank_statement_lines where id = p_line_id for update;
  if not found then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0002'; end if;

  select string_agg(coalesce(p.human_payment_id, p.request_number), ', ' order by p.payment_date)
         filter (where not (m.payment_id = any (v_checked))),
         string_agg(coalesce(p.human_payment_id, p.request_number), ', ' order by p.payment_date)
         filter (where m.payment_id = any (v_checked))
    into v_unseen, v_seen
    from public.bank_line_payment_matches(p_line_id) m
    join public.finance_payment_requests p on p.id = m.payment_id
   where m.match_kind in ('amount', 'reference_used', 'linked_elsewhere');

  if v_unseen is not null then
    raise exception 'BANK_MATCHES_CHANGED: % also matches this credit. Close this window and compare it first.',
      v_unseen using errcode = '22023';
  end if;

  if v_seen is null then
    return public.create_payment_from_bank_line(p_line_id, false, null);
  end if;

  if length(v_reason) < 3 then
    raise exception 'BANK_REASON_REQUIRED: say why this is a different payment' using errcode = '22023';
  end if;
  if length(v_reason) > 200 then
    raise exception 'BANK_REASON_TOO_LONG: keep the reason under 200 characters' using errcode = '22023';
  end if;

  return public.create_payment_from_bank_line(
    p_line_id, true,
    'Added from the bank statement. Checked against ' || v_seen || ': ' || v_reason);
end;
$fn$;

comment on function public.add_bank_line_to_confirmed(uuid, uuid[], text) is
  'The one door a browser adds a bank credit through. With a possible match it needs the payment ids compared and a reason, refuses any other match, and writes the reason on the new payment. Needs finance.reconcile and finance.create. 20270514000000.';


-- ═══ §3. Unlinking takes a reason ═══════════════════════════════════════════

drop function if exists public.unlink_bank_line_payment(uuid);

create function public.unlink_bank_line_payment(p_link_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor  uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  n        integer;
begin
  v_actor := public.assert_bank_reconcile_door();

  if length(v_reason) < 3 then
    raise exception 'BANK_REASON_REQUIRED: say why this link is wrong' using errcode = '22023';
  end if;
  if length(v_reason) > 200 then
    raise exception 'BANK_REASON_TOO_LONG: keep the reason under 200 characters' using errcode = '22023';
  end if;

  update public.bank_line_payment_links
     set unlinked_by = v_actor, unlinked_at = now(), unlink_reason = v_reason
   where id = p_link_id and unlinked_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'BANK_LINK_NOT_FOUND' using errcode = 'P0002'; end if;
end;
$fn$;


-- ═══ §4. What "Synced" means ════════════════════════════════════════════════

-- One row per unmarked credit (all of them when p_line_ids is null). issue is
-- null only when the credit is truly in sync. uncovered is how much of it is
-- not yet covered by a healthy, verified payment.
create or replace function public.bank_lines_sync_rows(p_line_ids uuid[])
returns table (line_id uuid, account text, line_date date, issue text, uncovered numeric, payment_label text, payment_mode text)
language sql
stable
set search_path = public, pg_temp
as $fn$
  with lines as (
    select b.id, b.account, b.line_date, b.deposit
      from public.bank_statement_lines b
     where b.deposit > 0 and b.classification is null
       and (p_line_ids is null or b.id = any (p_line_ids))
  ),
  linked as (
    select k.line_id, k.amount, coalesce(p.human_payment_id, p.request_number) as label, p.payment_mode,
           case
             when p.deleted_at is not null then 1
             when p.status = 'rejected' then 2
             when p.payment_mode is distinct from l.account then 3
             when used.total > p.amount then 4
             when not public.finance_payment_status_is_verified(p.status) then 5
           end as problem
      from public.bank_line_payment_links k
      join lines l on l.id = k.line_id
      join public.finance_payment_requests p on p.id = k.payment_id
      cross join lateral (
        select sum(o.amount) as total
          from public.bank_line_payment_links o
         where o.payment_id = k.payment_id and o.unlinked_at is null
      ) used
     where k.unlinked_at is null
  ),
  totals as (
    select a.line_id,
           sum(a.amount) as linked_total,
           coalesce(sum(a.amount) filter (where a.problem is null), 0) as covered,
           min(a.problem) as worst
      from linked a
     group by a.line_id
  )
  select l.id, l.account, l.line_date,
         case
           when t.line_id is null then 'no_payment'
           when t.worst = 1 then 'payment_deleted'
           when t.worst = 2 then 'payment_rejected'
           when t.worst = 3 then 'other_account'
           when t.worst = 4 then 'amount_changed'
           when t.linked_total < l.deposit then 'part_linked'
           when t.worst = 5 then 'waiting'
         end,
         l.deposit - coalesce(t.covered, 0),
         w.label, w.payment_mode
    from lines l
    left join totals t on t.line_id = l.id
    left join lateral (
      select a.label, a.payment_mode
        from linked a
       where a.line_id = l.id
       order by a.problem nulls last, a.label
       limit 1
    ) w on true;
$fn$;

create or replace function public.bank_lines_sync_state(p_line_ids uuid[])
returns table (line_id uuid, issue text, uncovered numeric, payment_label text, payment_mode text)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.assert_bank_reconcile_door();
  if cardinality(coalesce(p_line_ids, '{}')) > 2000 then
    raise exception 'BANK_LINES_TOO_MANY: at most 2000 lines per call' using errcode = '22023';
  end if;
  return query
    select r.line_id, r.issue, r.uncovered, r.payment_label, r.payment_mode
      from public.bank_lines_sync_rows(coalesce(p_line_ids, '{}')) r;
end;
$fn$;

comment on function public.bank_lines_sync_state(uuid[]) is
  'The one definition of Synced: verified, undeleted, same-account payments cover every rupee of the credit. Read live. Needs finance.reconcile. 20270514000000.';

create or replace function public.bank_lines_recorded_matches(p_line_ids uuid[])
returns table (
  line_id uuid, payment_id uuid, human_payment_id text, client_name text, amount numeric,
  left_to_link numeric, payment_date date, payment_mode text, proof_note text, status text, match_kind text,
  linked_link_id uuid, linked_line_date date, linked_narration text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.assert_bank_reconcile_door();
  if cardinality(coalesce(p_line_ids, '{}')) > 2000 then
    raise exception 'BANK_LINES_TOO_MANY: at most 2000 lines per call' using errcode = '22023';
  end if;
  return query
    select x.id, p.id, p.human_payment_id, p.client_name, p.amount,
           m.left_to_link, p.payment_date, p.payment_mode, p.proof_note, p.status, m.match_kind,
           e.id, e.line_date, e.narration
      from unnest(coalesce(p_line_ids, '{}')) as x(id)
      join public.bank_statement_lines b on b.id = x.id
     cross join lateral public.bank_line_payment_matches(x.id) m
      join public.finance_payment_requests p on p.id = m.payment_id
      left join lateral (
        select k.id, o.line_date, o.narration
          from public.bank_line_payment_links k
          join public.bank_statement_lines o on o.id = k.line_id
         where m.match_kind = 'linked_elsewhere' and k.payment_id = p.id and k.unlinked_at is null
         order by o.line_date
         limit 1
      ) e on true
     order by x.id, case m.match_kind when 'reference' then 0 when 'reference_used' then 1 else 2 end,
              abs(p.payment_date - b.line_date), p.payment_date desc;
end;
$fn$;

comment on function public.bank_lines_recorded_matches(uuid[]) is
  'The recorded payments each bank credit could be, by the same rule that refuses a second payment. Needs finance.reconcile. 20270514000000.';


-- ═══ §5. Both accounts, every month ═════════════════════════════════════════

create or replace function public.bank_sync_overview()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_out jsonb;
begin
  perform public.assert_bank_reconcile_door();

  with open_lines as (
    select r.account, to_char(r.line_date, 'YYYY-MM') as month,
           count(*)::integer as lines, sum(r.uncovered) as amount
      from public.bank_lines_sync_rows(null) r
     where r.issue is not null
     group by 1, 2
  ),
  ranges as (
    select b.account, min(b.line_date) as first_date, max(b.line_date) as last_date
      from public.bank_statement_lines b
     group by b.account
  ),
  open_payments as (
    select p.payment_mode as account, to_char(p.payment_date, 'YYYY-MM') as month, count(*)::integer as payments
      from public.finance_payment_requests p
      join ranges g on g.account = p.payment_mode
     where p.deleted_at is null
       and p.status <> 'rejected'
       and p.payment_date >= date_trunc('month', g.first_date)::date
       and p.payment_date <  (date_trunc('month', g.last_date) + interval '1 month')::date
       and coalesce((select sum(k.amount) from public.bank_line_payment_links k
                      where k.payment_id = p.id and k.unlinked_at is null), 0) < p.amount
     group by 1, 2
  ),
  months as (
    select coalesce(a.account, b.account) as account,
           coalesce(a.month, b.month) as month,
           coalesce(a.lines, 0) as not_synced,
           coalesce(a.amount, 0) as not_synced_amount,
           coalesce(b.payments, 0) as not_in_bank
      from open_lines a
      full join open_payments b on b.account = a.account and b.month = a.month
  ),
  periods as (
    select i.account, i.period_from,
           max(i.period_to) over (partition by i.account order by i.period_from, i.period_to
                                  rows between unbounded preceding and 1 preceding) as covered_to
      from public.bank_statement_imports i
  ),
  gaps as (
    select s.account, s.covered_to + 1 as gap_from, s.period_from - 1 as gap_to
      from periods s
     where s.covered_to is not null and s.period_from > s.covered_to + 1
  )
  select jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(g.account order by g.account) from ranges g), '[]'::jsonb),
    'months',   coalesce((select jsonb_agg(to_jsonb(m) order by m.account, m.month desc) from months m), '[]'::jsonb),
    'gaps',     coalesce((select jsonb_agg(to_jsonb(x) order by x.account, x.gap_from) from gaps x), '[]'::jsonb))
    into v_out;

  return v_out;
end;
$fn$;

comment on function public.bank_sync_overview() is
  'Both accounts, every month: credits not in sync, payments with no bank credit, and dates no uploaded statement covers. Needs finance.reconcile. 20270514000000.';


-- ═══ §6. Sync links before it adds ══════════════════════════════════════════

-- The one payment this credit is, or null. Sure means each has only the other:
-- same account, same amount, within 3 days, no other unlinked payment fits the
-- credit, no other unlinked credit fits the payment, and nothing the database
-- found points anywhere else. Both directions are checked so that the order of
-- the statement never decides which of two credits gets a payment.
create or replace function public.bank_line_sure_payment(p_line_id uuid)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $fn$
  with line as (
    select b.account, b.line_date, b.deposit
      from public.bank_statement_lines b
     where b.id = p_line_id and b.deposit > 0 and b.classification is null
       and not exists (select 1 from public.bank_line_payment_links k
                        where k.line_id = b.id and k.unlinked_at is null)
  ),
  near as (
    select p.id, p.amount, p.payment_date, p.payment_mode
      from public.finance_payment_requests p, line l
     where p.deleted_at is null and p.status <> 'rejected'
       and p.payment_mode = l.account
       and p.amount = l.deposit
       and p.payment_date between l.line_date - 3 and l.line_date + 3
       and not exists (select 1 from public.bank_line_payment_links k
                        where k.payment_id = p.id and k.unlinked_at is null)
  )
  select n.id
    from near n
   where (select count(*) from near) = 1
     and not exists (select 1 from public.bank_line_payment_matches(p_line_id) m
                      where m.match_kind <> 'amount')
     and (select count(*)
            from public.bank_statement_lines o
           where o.account = n.payment_mode
             and o.deposit = n.amount
             and o.classification is null
             and o.line_date between n.payment_date - 3 and n.payment_date + 3
             and not exists (select 1 from public.bank_line_payment_links k
                              where k.line_id = o.id and k.unlinked_at is null)) = 1;
$fn$;

comment on function public.bank_line_sure_payment(uuid) is
  'The one recorded payment a bank credit surely is, or null when a person must look. Internal: sync_bank_credits. 20270514000000.';

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
  v_sure     uuid;
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

    v_sure := public.bank_line_sure_payment(v_id);
    if v_sure is not null then
      begin
        perform public.link_bank_line_to_payment(v_id, v_sure, v_line.deposit);
        v_linked := v_linked + 1;
        update public.bank_statement_lines set sync_error = null, sync_attempted_at = now() where id = v_id;
        continue;
      exception when others then
        null; -- taken a moment ago by someone else: the checks below decide
      end;
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


-- ═══ §7. Who may call what ══════════════════════════════════════════════════

revoke all on function public.bank_line_reference_tokens(text, text) from public, anon, authenticated;
revoke all on function public.bank_line_payment_matches(uuid) from public, anon, authenticated;
revoke all on function public.bank_line_sure_payment(uuid) from public, anon, authenticated;
revoke all on function public.bank_lines_sync_rows(uuid[]) from public, anon, authenticated;
revoke all on function public.create_payment_from_bank_line(uuid, boolean, text) from public, anon, authenticated;

revoke all on function public.add_bank_line_to_confirmed(uuid, uuid[], text) from public, anon;
revoke all on function public.unlink_bank_line_payment(uuid, text) from public, anon;
revoke all on function public.bank_lines_sync_state(uuid[]) from public, anon;
revoke all on function public.bank_lines_recorded_matches(uuid[]) from public, anon;
revoke all on function public.bank_sync_overview() from public, anon;

grant execute on function public.add_bank_line_to_confirmed(uuid, uuid[], text) to authenticated;
grant execute on function public.unlink_bank_line_payment(uuid, text) to authenticated;
grant execute on function public.bank_lines_sync_state(uuid[]) to authenticated;
grant execute on function public.bank_lines_recorded_matches(uuid[]) to authenticated;
grant execute on function public.bank_sync_overview() to authenticated;

do $assert$
declare
  f text;
begin
  foreach f in array array[
    'public.bank_line_reference_tokens(text, text)',
    'public.bank_line_payment_matches(uuid)',
    'public.bank_line_sure_payment(uuid)',
    'public.bank_lines_sync_rows(uuid[])',
    'public.create_payment_from_bank_line(uuid, boolean, text)'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% must not be callable from a browser', f;
    end if;
  end loop;

  foreach f in array array[
    'public.add_bank_line_to_confirmed(uuid, uuid[], text)',
    'public.unlink_bank_line_payment(uuid, text)',
    'public.bank_lines_sync_state(uuid[])',
    'public.bank_lines_recorded_matches(uuid[])',
    'public.bank_sync_overview()'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception '% must not be executable by anon', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% must be executable by authenticated', f;
    end if;
  end loop;
end
$assert$;
