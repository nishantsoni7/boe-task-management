#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — two sessions approving two new PI Drafts at once
# (20270102000000), on a DISPOSABLE local Supabase stack.
# ═════════════════════════════════════════════════════════════════════════════
#
# A new draft holds no Order number; approve_order_submission() allocates one
# from order_number_cycle under its FOR UPDATE lock. This proves, with two real
# sessions:
#
#   round 1  A approves X and holds its transaction open; B's approval of Y
#            WAITS on the cycle row (seen in pg_stat_activity, not assumed from
#            a sleep); A commits; B completes. X and Y get consecutive, distinct
#            numbers.
#   round 2  the same race, but A ROLLS BACK: B takes the number A had, so a
#            failed approval skips nothing.
#
# COMMITS FIXTURE ROWS (clients named 'ASSERT RACE …'): run it on a stack you
# will rebuild, and after the ROLLBACK-only suites, which assume a clean DB.
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_<project_id> bash supabase/tests/run_order_submission_numbering_race.sh
set -euo pipefail

: "${BOE_DB_CONTAINER:?BOE_DB_CONTAINER must name the database container of the disposable stack}"
case "$BOE_DB_CONTAINER" in
  supabase_db_*) ;;
  *) echo "refusing: $BOE_DB_CONTAINER is not a local Supabase database container" >&2; exit 2 ;;
esac

# Each session's output. Unset, it goes to a fresh temporary folder: a default
# of /dev/null would make "/dev/null.a.commit", which cannot be created, and the
# session would never run.
RACE_LOG="${RACE_LOG:-$(mktemp -d)/race}"

psql_in() { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
scalar()  { docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -Atc "$1"; }

[ "$(scalar "select to_regclass('public.order_submission_draft_reference_seq') is not null")" = "t" ] \
  || { echo "refusing: 20270102000000 is not applied" >&2; exit 3; }
[ "$(scalar "select count(*) from public.orders where client_name not like 'ASSERT%'")" = "0" ] \
  || { echo "refusing: this database holds Orders that are not test fixtures; it is not disposable" >&2; exit 4; }
for u in 11111111-1111-1111-1111-111111111111 55555555-5555-5555-5555-555555555555 77777777-7777-7777-7777-777777777777; do
  [ "$(scalar "select count(*) from public.users where id = '$u'")" = "1" ] \
    || { echo "refusing: fixture user $u is missing" >&2; exit 3; }
done

ADMIN=11111111-1111-1111-1111-111111111111
SALES=55555555-5555-5555-5555-555555555555

# One committed, submitted, PI-approved draft with 40% verified, ready to confirm.
make_ready() {
  local id; id=$(scalar "select gen_random_uuid()")
  psql_in <<SQL >/dev/null
insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
values ('$id', 'draft', '$SALES', '$SALES', '[]', '[]');
do \$\$
declare v_item uuid := gen_random_uuid(); v_sha text := repeat('b', 64);
        v_wb text := 'submissions/$id/original/' || gen_random_uuid() || '.xlsx'; v_img text; v_pay uuid := gen_random_uuid();
begin
  update public.order_submissions set client_name = 'ASSERT RACE $1', gross_product_amount = 100000,
         discount_amount = 0, grand_total = 100000, source_workbook_path = v_wb, source_workbook_sha256 = v_sha
   where id = '$id';
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_wb,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items (id, submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_item, '$id', 10, '1', 'ASSERT chair', 1, 100000, 100000, 0);
  v_img := 'submissions/$id/images/' || v_item || '/representative/0-' || v_sha || '.png';
  insert into public.order_submission_item_images (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  values ('$id', v_item, 'representative', 0, v_img, 'image/png', v_sha, 10);
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_img, jsonb_build_object('mimetype', 'image/png'));
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'ASSERT', 40000, current_date, 'hdfc', 'approved_unlinked', '$SALES', null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, '$id', 40000, 'order_submission', '$SALES');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '$SALES', 'role', 'authenticated')::text, true);
  perform public.submit_pi_for_review('$id', null, null, null, null);
  perform set_config('request.jwt.claims', json_build_object('sub', '$ADMIN', 'role', 'authenticated')::text, true);
  if (select pi_approved_at from public.order_submissions where id = '$id') is null then
    perform public.approve_pi_review('$id');
  end if;
  reset role;
end \$\$;
SQL
  echo "$id"
}

confirm_sql() {
  echo "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub', '$ADMIN', 'role', 'authenticated')::text, false);
        select public.approve_order_submission('$1', '$SALES', current_date, current_date + 30, 'reference');"
}

wait_for_lock_wait() {
  for _ in $(seq 1 100); do
    if [ "$(scalar "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like '%approve_order_submission(''$1''%'")" -ge 1 ]; then return 0; fi
    sleep 0.1
  done
  echo "FAIL: B never waited on the cycle lock" >&2; exit 5
}

round() {
  local ending=$1 x y next nx ny
  x=$(make_ready "X-$ending"); y=$(make_ready "Y-$ending")
  next=$(scalar "select next_number from public.order_number_cycle")

  # A: approve X, then hold the transaction open until told to finish.
  ( { echo "begin;"; confirm_sql "$x"; echo "select pg_sleep(6);"; echo "$ending;"; } \
      | docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q > "${RACE_LOG}.a.$ending" 2>&1 ) &
  local pa=$!
  for _ in $(seq 1 100); do
    [ "$(scalar "select count(*) from pg_stat_activity where query like '%pg_sleep(6)%' and state = 'active' and pid <> pg_backend_pid()")" -ge 1 ] && break
    sleep 0.1
  done
  # B: approve Y while A holds the cycle row.
  ( { echo "begin;"; confirm_sql "$y"; echo "commit;"; } \
      | docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q > "${RACE_LOG}.b.$ending" 2>&1 ) &
  local pb=$!
  wait_for_lock_wait "$y"
  echo "  B is waiting on the lock while A holds it"
  wait $pa; wait $pb

  nx=$(scalar "select o.display_number from public.orders o where o.source_order_submission_id = '$x'")
  ny=$(scalar "select o.display_number from public.orders o where o.source_order_submission_id = '$y'")
  if [ "$ending" = "commit" ]; then
    [ "$nx" = "$(printf '%04d' "$next")" ] && [ "$ny" = "$(printf '%04d' $((next + 1)))" ] \
      || { echo "FAIL round commit: X=$nx Y=$ny, expected $(printf '%04d' "$next") and $(printf '%04d' $((next + 1)))" >&2; exit 6; }
    echo "  commit: X=$nx Y=$ny — distinct and consecutive"
  else
    [ -z "$nx" ] && [ "$ny" = "$(printf '%04d' "$next")" ] \
      || { echo "FAIL round rollback: X=${nx:-none} Y=$ny, expected none and $(printf '%04d' "$next")" >&2; exit 7; }
    echo "  rollback: X=none Y=$ny — B took the number A gave back"
  fi
  [ "$(scalar "select count(*) from (select display_number from public.orders group by 1 having count(*) > 1) d")" = "0" ] \
    || { echo "FAIL: a duplicate Order number exists" >&2; exit 8; }
}

echo "round 1: both commit";  round commit
echo "round 2: A rolls back"; round rollback
echo "ALL NUMBERING RACE ASSERTIONS PASSED"
