#!/usr/bin/env bash
# The custody table's and the destination projection's privileges, under
# PRODUCTION-SHAPED default privileges.
#
#   supabase/tests/run_payment_custody_and_modes_privileges_suite.sh <psql-host-or-socket-dir>
#
# WHY A SEPARATE SUITE — AND WHY IT EXISTS BEFORE THE PUSH THIS TIME.
# Every other suite here builds a bare PostgreSQL, where a new table starts with
# an empty ACL. A Supabase project does not: its bootstrap runs
#
#   alter default privileges in schema public
#     grant all on tables to anon, authenticated, service_role;
#
# for the role the migration runner connects as, so a table arrives already
# carrying `authenticated=arwdDxt/postgres`. 20261013000000's first version
# revoked from PUBLIC and anon and never named `authenticated`, which narrows
# nothing on a project — it passed the bare-database suite and failed the real
# push. 20261014000000 creates another table, and this suite is what makes sure
# the same gap is not open a second time.
#
# THE BEFORE-PROBE IS THE POINT. It rewrites §2's privilege block back to the
# form that failed and requires the migration to REFUSE. A suite that only proves
# the fix works cannot tell you whether it is still needed.
#
# Creates and drops a database called `boe_custody_privileges`. Touches nothing
# else, and never talks to a linked project.
set -euo pipefail
HOST="${1:?usage: run_payment_custody_and_modes_privileges_suite.sh <psql host or socket dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=boe_custody_privileges
MIG="$REPO/supabase/migrations/20261014000000_payment_destination_display_modes_and_custody.sql"
Q=(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q)

"${Q[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
"${Q[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

echo "== modelling the Supabase project bootstrap: roles, and ALL on every new table"
"${Q[@]}" -d "$DB" >/dev/null <<'BOOT'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')
    then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated')
    then create role authenticated nologin noinherit; end if;
  -- BYPASSRLS, as the real service_role has: it is the server-side key.
  if not exists (select 1 from pg_roles where rolname = 'service_role')
    then create role service_role nologin noinherit bypassrls; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- THE LINE THE LOCAL FIXTURES WERE MISSING.
alter default privileges in schema public
  grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
BOOT

echo "== building the schema through 20261013000000"
for f in \
  "$REPO/supabase/tests/_order_finance_reset_shaped_schema.sql" \
  "$REPO/supabase/migrations/20261010000000_order_submission_and_finance_test_data_reset.sql" \
  "$REPO/supabase/tests/_admin_payment_deletion_and_payment_id_extra_schema.sql" \
  "$REPO/supabase/migrations/20261011000000_admin_payment_deletion_and_payment_id.sql" \
  "$REPO/supabase/tests/_allocation_ledger_single_source_extra_schema.sql" \
  "$REPO/supabase/migrations/20261012000000_allocation_ledger_as_single_source.sql" \
  "$REPO/supabase/tests/_payment_entry_destination_model_extra_schema.sql" \
  "$REPO/supabase/migrations/20261013000000_payment_entry_destination_model.sql" \
  "$REPO/supabase/tests/_payment_custody_and_modes_extra_schema.sql"
do
  "${Q[@]}" -d "$DB" -f "$f" >/dev/null 2>&1
done

# ── The before-probe ─────────────────────────────────────────────────────────
# §2's privilege block, rewritten back to the version that reached production in
# 20261013000000. The migration must refuse it. If this ever applies cleanly,
# either the assertion has been weakened or the fixture has stopped modelling a
# project — and either way nothing below this line would mean anything.
echo "== before-probe: the pre-fix grants must be REFUSED by the migration"
BROKEN=$(mktemp /tmp/mig114_prefix_grants.XXXXXX.sql)
trap 'rm -f "$BROKEN"; "${Q[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT
python3 - "$MIG" "$BROKEN" <<'PY'
import io, sys
src, dst = sys.argv[1], sys.argv[2]
s = io.open(src, encoding='utf-8').read()
fixed = """revoke all on public.finance_payment_custody_events from public;

revoke insert, update, delete, truncate, references, trigger
  on public.finance_payment_custody_events from anon, authenticated;"""
if s.count(fixed) != 1:
    sys.exit("before-probe: §2's privilege block has moved — update this probe rather than deleting it")
# The exact form that shipped and failed for 20261013000000: PUBLIC and anon
# named, `authenticated` not.
s = s.replace(fixed, "revoke all on public.finance_payment_custody_events from public, anon;", 1)
io.open(dst, 'w', encoding='utf-8').write(s)
PY

set +e
PROBE="$(psql -h "$HOST" -U postgres -v ON_ERROR_STOP=1 -q -1 -d "$DB" -f "$BROKEN" 2>&1)"
PROBE_STATUS=$?
set -e
if [ $PROBE_STATUS -eq 0 ]; then
  echo "FAIL: the pre-fix grants applied cleanly. Either §9b was weakened or this"
  echo "      fixture no longer models a Supabase project's default privileges."
  exit 1
fi
if ! printf '%s' "$PROBE" | grep -q 'must be read-only for authenticated'; then
  echo "FAIL: the pre-fix grants were refused, but not by the privilege assertion:"
  printf '%s\n' "$PROBE" | grep -E 'ERROR' | head -3
  exit 1
fi
echo "   refused, by the privilege assertion, before it could reach a project"

echo "== applying 20261014000000 (its own apply-time assertions run here)"
"${Q[@]}" -1 -d "$DB" -f "$MIG" 2>&1 \
  | grep -vE 'NOTICE:  (trigger|policy|constraint|relation|view|index|function)' || true

echo "== the privilege assertions"
set +e
OUTPUT="$("${Q[@]}" -d "$DB" -f "$REPO/supabase/tests/payment_custody_and_modes_privileges_assertions.sql" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | grep -vE '^NOTICE:  (trigger|constraint|relation)' || true
if [ $STATUS -ne 0 ] || ! printf '%s' "$OUTPUT" | grep -q 'ALL PRIVILEGE ASSERTIONS PASSED'; then
  echo "FAIL: the privilege assertions did not reach the end"
  exit 1
fi

echo "== suite complete; database dropped"
