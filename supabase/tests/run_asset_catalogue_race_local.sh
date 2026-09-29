#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — asset catalogue: product move vs asset write, two sessions
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT IT PROVES
# --------------
# enforce_asset_catalogue_links (20270220000000 §6) reads the product and
# category it validates against FOR SHARE. update_asset_product holds the
# product FOR UPDATE while it counts the assets using it and moves it. Those
# locks make the two operations serialise, in either order:
#
#   1. MOVE FIRST.   Session A moves an unused product to another category and
#                    holds the transaction open. Session B inserts an asset
#                    naming that product under the OLD category. B must WAIT on
#                    the product row lock (checked in pg_stat_activity), and
#                    when A commits, B must be refused ASSET_PRODUCT_MISMATCH.
#   2. INSERT FIRST. Session B inserts such an asset and holds its transaction
#                    open. Session A tries to move the product. A must WAIT,
#                    and when B commits, A must be refused ASSET_CATALOGUE_IN_USE
#                    — the existing rule that an in-use product cannot move.
#
# After both, no asset may name a product from another category.
#
# NEGATIVE CONTROL. With BOE_RACE_NEGATIVE_CONTROL=1 the runner temporarily
# replaces the trigger function with a copy WITHOUT the FOR SHARE locks, runs
# scenario 1, and expects the invariant to BREAK (B is accepted, both commit,
# a mismatched asset exists). It then restores the real function. This is how
# the test shows it can fail.
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target: BOE_DB_CONTAINER must name a running
# local container. It refuses unless that database carries the disposable
# marker (the same one the other Assets & Access runners use) and the catalogue
# migration is applied. It never contacts a linked project.
#
# Fixtures are COMMITTED (two sessions cannot see each other's uncommitted
# rows) and removed in an EXIT trap. The append-only guards on the two activity
# logs are disabled for that cleanup only, on this disposable database, and
# re-enabled before the trap returns.
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_<project> supabase/tests/run_asset_catalogue_race_local.sh
#   BOE_DB_CONTAINER=… BOE_RACE_NEGATIVE_CONTROL=1 supabase/tests/run_asset_catalogue_race_local.sh

set -uo pipefail
export MSYS_NO_PATHCONV=1

MARKER="boe-disposable-assets-access-test"
C="${BOE_DB_CONTAINER:-}"
[ -n "$C" ] || { echo "FATAL: BOE_DB_CONTAINER is not set. Nothing was written." >&2; exit 1; }
docker ps --format '{{.Names}}' | grep -qx "$C" || { echo "FATAL: no running container $C. Nothing was written." >&2; exit 1; }

q()  { docker exec -i -e PGCLIENTENCODING=UTF8 "$C" psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 "$@"; }

GOT_MARKER="$(q -c "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = current_database()")"
[ "$GOT_MARKER" = "$MARKER" ] || { echo "FATAL: database is not marked '$MARKER' (found '$GOT_MARKER'). Nothing was written." >&2; exit 1; }
[ "$(q -c "select to_regclass('public.asset_products') is not null")" = "t" ] \
  || { echo "FATAL: 20270220000000 is not applied here. Nothing was written." >&2; exit 1; }

ADMIN=ca7ace00-0000-4000-8000-00000000000a
PROD=ca7ace00-0000-4000-8000-0000000000b1
CLAIMS="select set_config('request.jwt.claims', '{\"sub\":\"$ADMIN\",\"role\":\"authenticated\"}', false);"
TMP="$(mktemp -d)"
SAVED_FN="$TMP/enforce_fn.sql"
FAILED=0

cleanup() {
  # Restore the real trigger function first if a negative control replaced it.
  if [ -s "$SAVED_FN" ]; then q < "$SAVED_FN" >/dev/null 2>&1 && echo "── restored enforce_asset_catalogue_links"; fi
  q >/dev/null 2>&1 <<SQL
alter table public.asset_catalogue_activity disable trigger asset_catalogue_activity_immutable;
alter table public.asset_activity_log disable trigger user;
delete from public.asset_activity_log where asset_name_snapshot like 'RACE %';
delete from public.assets where asset_name like 'RACE %';
delete from public.asset_catalogue_activity where category_key like 'race\_%';
delete from public.asset_products where id = '$PROD';
delete from public.asset_categories where key like 'race\_%';
delete from public.users where id = '$ADMIN';
alter table public.asset_activity_log enable trigger user;
alter table public.asset_catalogue_activity enable trigger asset_catalogue_activity_immutable;
SQL
  echo "── fixtures removed; guards re-enabled: $(q -c "select count(*) from pg_trigger where tgrelid in ('public.asset_activity_log'::regclass, 'public.asset_catalogue_activity'::regclass) and not tgisinternal and tgenabled = 'D'") disabled trigger(s) left"
  rm -rf "$TMP"
}
trap cleanup EXIT

# ── Fixtures ────────────────────────────────────────────────────────────────
q >/dev/null <<SQL
insert into public.users (id, full_name, email, role, team, is_active)
values ('$ADMIN', 'RACE Admin', 'race.admin@example.invalid', 'admin', 'management', true);
insert into public.asset_categories (key, name) values ('race_cat_a', 'RACE Category A'), ('race_cat_b', 'RACE Category B');
insert into public.asset_products (id, category_key, name) values ('$PROD', 'race_cat_a', 'RACE Product');
SQL
echo "── fixtures: an admin, two categories, one unused product in race_cat_a"

# Wait until a session matching $1 is in state $2 ('PgSleep' or 'Lock'); fail after ~15s.
wait_for() {
  local tag="$1" kind="$2" i
  for i in $(seq 1 60); do
    local n
    if [ "$kind" = "Lock" ]; then
      n="$(q -c "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like '%$tag%' and pid <> pg_backend_pid()")"
    else
      n="$(q -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep' and query like '%$tag%' and pid <> pg_backend_pid()")"
    fi
    [ "$n" -ge 1 ] && return 0
    sleep 0.25
  done
  return 1
}

mismatches() {
  q -c "select count(*) from public.assets a join public.asset_products p on p.id = a.product_id where p.category_key <> a.asset_type"
}

check() { if [ "$1" = "$2" ]; then echo "   ✓ $3"; else echo "   ✗ $3 (expected '$2', got '$1')"; FAILED=1; fi; }

scenario_move_first() {
  local label="$1" expect_refused="$2" expect_mismatch="$3"
  q -c "update public.asset_products set category_key = 'race_cat_a' where id = '$PROD'" >/dev/null
  echo "══ $label: MOVE FIRST"
  # A: move the (unused) product to race_cat_b and hold the transaction.
  q > "$TMP/a1.out" 2>&1 <<SQL &
begin;
$CLAIMS
select public.update_asset_product('$PROD', 'race_cat_b', 'RACE Product', true);
select pg_sleep(10) /* race_a1_hold */;
commit;
SQL
  local A=$!
  wait_for race_a1_hold PgSleep || { echo "   ✗ session A never reached its hold"; FAILED=1; }
  # B: file an asset under the OLD category, naming the product being moved.
  q > "$TMP/b1.out" 2>&1 <<SQL &
insert into public.assets (asset_type, asset_name, product_id) values ('race_cat_a', 'RACE asset move-first', '$PROD') /* race_b1_insert */;
SQL
  local B=$!
  if wait_for race_b1_insert Lock; then BLOCKED=yes; else BLOCKED=no; fi
  wait $A; wait $B
  # B always waits here — with the locks at the trigger's FOR SHARE read, and
  # without them at the foreign key check (KEY SHARE vs the move's FOR UPDATE).
  # So waiting proves only that the two sessions genuinely overlapped; whether
  # the invariant held is decided by the OUTCOME below.
  check "$BLOCKED" "yes" "B was blocked while A held the move open (the sessions overlapped): $BLOCKED"
  if grep -q "ASSET_PRODUCT_MISMATCH" "$TMP/b1.out"; then REFUSED=yes; else REFUSED=no; fi
  check "$REFUSED" "$expect_refused" "B refused with ASSET_PRODUCT_MISMATCH: $REFUSED"
  check "$(mismatches)" "$expect_mismatch" "assets whose product belongs to another category: $(mismatches)"
}

scenario_insert_first() {
  q -c "delete from public.assets where asset_name like 'RACE %'; update public.asset_products set category_key = 'race_cat_a' where id = '$PROD'" >/dev/null
  echo "══ INSERT FIRST"
  # B: file an asset naming the product, and hold the transaction.
  q > "$TMP/b2.out" 2>&1 <<SQL &
begin;
insert into public.assets (asset_type, asset_name, product_id) values ('race_cat_a', 'RACE asset insert-first', '$PROD');
select pg_sleep(10) /* race_b2_hold */;
commit;
SQL
  local B=$!
  wait_for race_b2_hold PgSleep || { echo "   ✗ session B never reached its hold"; FAILED=1; }
  # A: try to move the product while B holds the new asset uncommitted.
  q > "$TMP/a2.out" 2>&1 <<SQL &
$CLAIMS
select public.update_asset_product('$PROD', 'race_cat_b', 'RACE Product', true) /* race_a2_move */;
SQL
  local A=$!
  if wait_for race_a2_move Lock; then BLOCKED=yes; else BLOCKED=no; fi
  wait $B; wait $A
  check "$BLOCKED" "yes" "A waited on a row lock while B held the new asset open: $BLOCKED"
  if grep -q "ASSET_CATALOGUE_IN_USE" "$TMP/a2.out"; then REFUSED=yes; else REFUSED=no; fi
  check "$REFUSED" "yes" "A refused with ASSET_CATALOGUE_IN_USE (in-use product cannot move): $REFUSED"
  check "$(q -c "select count(*) from public.assets where asset_name = 'RACE asset insert-first'")" "1" "B's asset was created"
  check "$(q -c "select category_key from public.asset_products where id = '$PROD'")" "race_cat_a" "the product stayed in race_cat_a"
  check "$(mismatches)" "0" "assets whose product belongs to another category: $(mismatches)"
}

if [ "${BOE_RACE_NEGATIVE_CONTROL:-}" = "1" ]; then
  echo "══ NEGATIVE CONTROL: installing a copy of the trigger function WITHOUT the FOR SHARE locks"
  q -c "select pg_get_functiondef('public.enforce_asset_catalogue_links()'::regprocedure)" > "$SAVED_FN"
  [ "$(grep -c 'FOR SHARE' "$SAVED_FN")" = "2" ] || { echo "FATAL: expected two FOR SHARE reads in the live function"; exit 1; }
  # "…WHERE key = new.asset_type\n       FOR SHARE;" → "…WHERE key = new.asset_type\n;"
  sed 's/^[[:space:]]*FOR SHARE;[[:space:]]*$/;/' "$SAVED_FN" > "$TMP/unlocked.sql"
  q < "$TMP/unlocked.sql" >/dev/null
  [ "$(q -c "select position('FOR SHARE' in pg_get_functiondef('public.enforce_asset_catalogue_links()'::regprocedure)) = 0")" = "t" ] \
    || { echo "FATAL: the lock-less copy still locks"; exit 1; }
  scenario_move_first "NEGATIVE CONTROL" no 1   # accepted, and one mismatched asset committed
  if [ "$FAILED" = "0" ]; then
    echo "══ NEGATIVE CONTROL CONFIRMED: without the locks, B was accepted and a mismatched asset was committed"
    exit 0
  else
    echo "══ NEGATIVE CONTROL DID NOT BREAK THE INVARIANT — the test would not catch a regression" >&2
    exit 1
  fi
fi

scenario_move_first "LOCKED" yes 0             # refused, and no mismatched asset
scenario_insert_first

if [ "$FAILED" = "0" ]; then echo "══ ALL RACE CHECKS PASSED"; else echo "══ RACE CHECKS FAILED" >&2; exit 1; fi
