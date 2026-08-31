#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# TEST-ONLY RUNNER — Assets & Access delegation + handover, isolated local DB
# ═════════════════════════════════════════════════════════════════════════════
#
# WHAT THIS IS FOR
# ----------------
# asset_access_delegation_and_handover_assertions.sql proves things no text
# audit can: that a direct request from somebody without the Manage Access
# Records grant is actually refused by RLS, that the grant confers no asset,
# member-management or Control Center authority, that an acceptance really does
# record the employee, the moment, the terms version and the exact terms text,
# and that BOTH the new two-argument RPC and the legacy one-argument wrapper
# work. It needs a database with both pending migrations applied. This builds
# one.
#
# It cannot use the repository's own migration history: the files there cannot
# construct a blank database, because public.users, tasks, task_activity_log and
# notifications predate the chain (see
# docs/migrations-are-not-self-contained.md). So it lays down a test-only
# stand-in for public.users, then applies the REAL prerequisite migrations and
# the two REAL pending migrations, whole and unmodified.
#
#   1.    the test-only baseline (bootstrap/001_…_baseline.sql) — NOT a migration
#   2-21. twenty real prerequisite migrations, in filename order
#   22.   the test-only scoped module entry gate — NOT a migration
#   23-24. the two REAL pending migrations, whose own assertion blocks run
#         inside them
#   25.   the assertions, which create their own fixtures and roll back
#
# WHY STEP 22 IS TEST-ONLY
# ------------------------
# 20260905000000 gates 27 tables across five modules and ASSERTS it created 27.
# A database built from the Assets & Access chain alone holds 8 of them, so the
# real file would refuse — correctly. supabase/tests/_assets_access_module_entry_
# gate.sql lays the same gate on the same eight tables and says so in its header.
#
# WHAT IS DELIBERATELY NOT IN THE CHAIN
# -------------------------------------
#   20260620000000 / 20260620000100 / 20260620000200 / 20260621000000 /
#   20260625000000  the pre-reset Assets schema. 20260640 drops and recreates
#                   every one of those tables ("a clean reset"), so applying
#                   them first would test nothing and only add failure modes.
#   20260731000000  ALTER TYPE notification_type ADD VALUE …, and one index on
#   20260802000000  public.notifications. That table is one of the four the
#                   history never creates. Nothing in the delegation or handover
#                   work reads a notification and no assertion inserts one, so
#                   these are left out rather than faked.
#   20260726000000  IS included — asset_code is read by the handover sheet.
#   20260905000000  see above.
#
# WHAT IT WILL NOT DO
# -------------------
# It will not choose its own target: BOE_DB_CONTAINER must name the container.
# It will not run against a database that has not been marked disposable, or
# whose marker does not match. It will not run if public holds tables, if
# auth.users holds identities, if storage holds objects or buckets, or if the
# migration ledger has history. It will not run if a prerequisite migration
# differs from HEAD, because a run proves nothing if the ground under the
# pending files has shifted.
#
# It never resets, never deletes, never repairs, never edits a migration, and
# never contacts anything outside the named local container. Every guard runs
# before the first statement is applied, so a refusal leaves the database
# untouched.
#
# PREREQUISITES
# -------------
#   1. Docker running, and a local Supabase stack for this repo:
#
#        supabase init          # if supabase/config.toml does not exist yet
#
#      Then, in supabase/config.toml, turn OFF automatic migrations:
#
#        [db.migrations]
#        enabled = false
#
#      Without that, `supabase start` tries the full history and dies on the
#      first file. (config.toml is deliberately not committed: its ports are
#      per-machine.)
#
#   2. supabase start
#   3. supabase db reset --no-seed
#
#   4. NAME THE TARGET, and MARK IT DISPOSABLE. Both are deliberate acts and
#      neither is guessed:
#
#        export BOE_DB_CONTAINER=supabase_db_<your-project>
#        docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
#          "comment on database postgres is 'boe-disposable-assets-access-test'"
#
# USAGE
#   BOE_DB_CONTAINER=supabase_db_myproject \
#     supabase/tests/run_assets_access_delegation_and_handover_local.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BASELINE="supabase/tests/bootstrap/001_assets_access_baseline.sql"
ENTRY_GATE="supabase/tests/_assets_access_module_entry_gate.sql"
ASSERTIONS="supabase/tests/asset_access_delegation_and_handover_assertions.sql"

# THE FILES UNDER REVIEW. Both are allowed to differ from HEAD (they are new and
# uncommitted); every other migration in the list must match it.
PENDING_FILES=(
  "20261028000000_assets_access_manage_access_records.sql"
  "20261029000000_asset_handover_acknowledgement.sql"
)

MIGRATIONS=(
  "20260645_create_control_center_v1.sql"
  "20260660_create_permission_engine.sql"
  "20260661_add_permission_engine_bulk_resolver.sql"
  "20260662_fix_permission_resolver_team_cast.sql"
  "20260640_reset_assets_access_v1.sql"
  "20260641_add_admin_delete_assets.sql"
  "20260642_add_asset_specifications.sql"
  "20260721000000_assets_access_permission_cutover.sql"
  "20260722000000_assets_custody_integrity.sql"
  "20260723000000_assets_access_permission_corrections.sql"
  "20260724000000_asset_change_requests.sql"
  "20260725000000_assets_access_assign_action.sql"
  "20260726000000_asset_code_and_location.sql"
  "20260727000000_asset_activity_log.sql"
  "20260728000000_asset_master_details.sql"
  "20260729000000_asset_transfer_service_documents.sql"
  "20260730000000_asset_lifecycle_rpcs.sql"
  "20260801000100_assets_status_exclude_returned.sql"
  "20260803000000_asset_permanent_delete.sql"
  "20260810000000_assets_access_own_records_boundary.sql"
  "20261028000000_assets_access_manage_access_records.sql"
  "20261029000000_asset_handover_acknowledgement.sql"
)

is_pending() {
  local m="$1" p
  for p in "${PENDING_FILES[@]}"; do [ "$m" = "$p" ] && return 0; done
  return 1
}

MARKER="boe-disposable-assets-access-test"

# ── The target is named, never guessed ──────────────────────────────────────
if [ -z "${BOE_DB_CONTAINER:-}" ]; then
  echo "FATAL: BOE_DB_CONTAINER is not set." >&2
  echo "       Name the container explicitly; this script will not choose one." >&2
  echo "       Running Supabase database containers:" >&2
  docker ps --format '{{.Names}}' | grep '^supabase_db_' | sed 's/^/         /' >&2 || true
  echo "       Nothing was written." >&2
  exit 1
fi
DB_CONTAINER="$BOE_DB_CONTAINER"

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "FATAL: no running container named $DB_CONTAINER." >&2
  echo "       Nothing was written." >&2
  exit 1
fi

DB_NAME="${BOE_DB_NAME:-postgres}"

# The gate lives in its own file so that its tests exercise the same code this
# script trusts, rather than a second copy of it.
# shellcheck source=supabase/tests/lib/disposable_stack_guard.sh
. "$REPO/supabase/tests/lib/disposable_stack_guard.sh"

psql_file() {
  # ON_ERROR_STOP=1 makes the first error abort the file rather than leaving a
  # half-applied migration behind. PGCLIENTENCODING is set because every file in
  # this repository is UTF-8 and several carry box-drawing characters in their
  # headers.
  docker exec -i -e PGCLIENTENCODING=UTF8 "$DB_CONTAINER" \
    psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$1"
}

# ── SAY WHAT IS ABOUT TO BE WRITTEN TO, BEFORE WRITING ──────────────────────
if ! TARGET_DB="$(_psql_raw 'select current_database()')"; then
  echo "FATAL: could not query $DB_CONTAINER at all." >&2
  printf '%s\n' "$TARGET_DB" | sed 's/^/         /' >&2
  echo "       Nothing was written." >&2
  exit 1
fi
TARGET_MARKER="$(_psql_raw "select coalesce(shobj_description(oid, 'pg_database'), '(none)') from pg_database where datname = current_database()" || true)"

echo "══ target"
echo "──   container : $DB_CONTAINER"
echo "──   database  : $TARGET_DB"
echo "──   marker    : $TARGET_MARKER"
echo

# ── Every guard runs before a single statement is applied ───────────────────
require_disposable_stack || exit 1

echo "══ marker present; public, auth, storage and the ledger are all empty — safe to build"
echo

step=0
next_step() { step=$((step + 1)); echo; echo "══ step $step  $1"; }

next_step "baseline (TEST-ONLY, not a migration)"
echo "──      $BASELINE"
psql_file "$REPO/$BASELINE"
echo "        ✓ applied"

for m in "${MIGRATIONS[@]}"; do
  if is_pending "$m"; then
    PENDING_NOTE=1
  elif ! git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m"; then
    echo "FATAL: prerequisite supabase/migrations/$m differs from HEAD. Refusing to run." >&2
    exit 1
  else
    PENDING_NOTE=0
  fi

  # ── Whatever has to be true BEFORE this migration ────────────────────────
  case "$m" in
    20261028000000_*)
      # 20261028000000 requires the RESTRICTIVE access_records entry gate and
      # refuses without it. The real 20260905000000 cannot run here — see the
      # header — so the scoped stand-in goes down immediately before it.
      next_step "$ENTRY_GATE (TEST-ONLY)"
      psql_file "$REPO/$ENTRY_GATE"
      GATES="$(_psql_raw "select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
                           where p.polname = c.relname || '_module_entry_gate' and not p.polpermissive")"
      [ "$GATES" = "8" ] \
        || { echo "FATAL: expected 8 restrictive entry gates, found $GATES. Nothing further was applied." >&2; exit 1; }
      echo "        ✓ eight restrictive Assets & Access entry gates"
      ;;
  esac

  next_step "$m"
  if [ "$PENDING_NOTE" = "1" ]; then
    if git -C "$REPO" diff --quiet HEAD -- "supabase/migrations/$m" 2>/dev/null; then
      echo "        (unchanged from HEAD)"
    else
      echo "        UNCOMMITTED / MODIFIED vs HEAD — this run tests the working-tree version"
    fi
  fi
  psql_file "$REPO/supabase/migrations/$m"
  echo "        ✓ applied"

  # ── Whatever has to be true AFTER it ─────────────────────────────────────
  case "$m" in
    20261028000000_*)
      # THE CLAIM THAT MATTERS MOST ABOUT THIS FILE: it grants the capability
      # to nobody. Checked here as well as inside the migration, because the
      # migration's own post-condition is the thing a bad edit would remove.
      HOLDERS="$(_psql_raw "select count(*) from public.employee_permission_overrides eo
                              join public.permission_modules pm on pm.id = eo.module_id
                              join public.permission_actions  pa on pa.id = eo.action_id
                             where pm.module_key = 'assets_access'
                               and pa.action_key = 'manage_access_records'
                               and eo.allowed and eo.revoked_at is null")"
      [ "$HOLDERS" = "0" ] \
        || { echo "FATAL: the migration granted manage_access_records to $HOLDERS employee(s); it must grant it to nobody." >&2; exit 1; }
      ROLES="$(_psql_raw "select count(*) from public.role_permissions rp
                            join public.permission_modules pm on pm.id = rp.module_id
                            join public.permission_actions  pa on pa.id = rp.action_id
                           where pm.module_key = 'assets_access'
                             and pa.action_key = 'manage_access_records'
                             and rp.role <> 'admin' and rp.allowed")"
      [ "$ROLES" = "0" ] \
        || { echo "FATAL: $ROLES non-admin role rule(s) grant manage_access_records." >&2; exit 1; }
      echo "        ✓ granted to nobody: 0 employee overrides, 0 non-admin role rules"
      ;;
    20261029000000_*)
      # BOTH acceptance entry points must exist and NEITHER may take a default,
      # or the PostgREST overload becomes ambiguous for every caller.
      SIGS="$(_psql_raw "select string_agg(pg_catalog.oidvectortypes(p.proargtypes) || ':' || p.pronargdefaults, ' | ' order by p.pronargs)
                           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'accept_employee_asset'")"
      [ "$SIGS" = "uuid:0 | uuid, boolean:0" ] \
        || { echo "FATAL: accept_employee_asset overloads are '$SIGS'; expected 'uuid:0 | uuid, boolean:0'." >&2; exit 1; }
      echo "        ✓ both entry points present, neither declares a DEFAULT"
      ;;
  esac
done

next_step "$ASSERTIONS"
psql_file "$REPO/$ASSERTIONS"
echo "        ✓ ALL ASSERTIONS PASSED (the file rolled itself back)"

# ── OPTIONAL: the overload, through real PostgREST ──────────────────────────
#
# THE ONE CLAIM SQL CANNOT CHECK. Everything above proves the two functions
# exist and behave. It cannot prove that POSTing {p_assignment_id} to
# /rest/v1/rpc/accept_employee_asset picks ONE of them — and if PostgREST cannot
# choose, it answers PGRST203 and EVERY acceptance fails for the whole
# database-first rollout window. That is the exact risk the two-entry-point
# design exists to manage, so it is worth testing against the real router.
#
# Skipped, loudly, when the local API URL and JWT secret are not supplied —
# `supabase start` prints both. It is never inferred and never defaulted.
#
#   BOE_API_URL=http://127.0.0.1:55321 \
#   BOE_JWT_SECRET='super-secret-jwt-token-with-at-least-32-characters-long' \
#   BOE_ANON_KEY=<the anon key> \
#     … run this script
next_step "PostgREST overload resolution (optional)"
if [ -z "${BOE_API_URL:-}" ] || [ -z "${BOE_JWT_SECRET:-}" ] || [ -z "${BOE_ANON_KEY:-}" ]; then
  echo "        SKIPPED — set BOE_API_URL, BOE_JWT_SECRET and BOE_ANON_KEY to run it."
  echo "        (Everything above passed; this step is the extra one.)"
else
  # A local-only HS256 token for a user id that does not exist. Every call below
  # is EXPECTED to be refused; what is being read is WHICH refusal comes back,
  # because that names the function PostgREST chose.
  TOKEN="$(node -e "
    const crypto = require('crypto');
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const h = b64({ alg: 'HS256', typ: 'JWT' });
    const p = b64({ role: 'authenticated', sub: '00000000-0000-4000-8000-00000000dead',
                    exp: Math.floor(Date.now() / 1000) + 300 });
    process.stdout.write(h + '.' + p + '.' +
      crypto.createHmac('sha256', process.env.BOE_JWT_SECRET).update(h + '.' + p).digest('base64url'));
  ")"

  rpc() {
    curl -s -X POST "$BOE_API_URL/rest/v1/rpc/$1" \
      -H "apikey: $BOE_ANON_KEY" -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -d "$2"
  }

  expect_message() {
    local label="$1" body="$2" want="$3"
    case "$body" in
      *PGRST203*)
        echo "FATAL: $label — PostgREST could not choose between the overloads." >&2
        echo "         $body" >&2
        echo "       Every acceptance would fail during the rollout." >&2
        exit 1 ;;
      *"$want"*)
        echo "        ✓ $label → $want" ;;
      *)
        echo "FATAL: $label answered something unexpected:" >&2
        echo "         $body" >&2
        exit 1 ;;
    esac
  }

  DEAD='00000000-0000-4000-8000-00000000dead'

  # The deployed frontend's call. It must reach the legacy wrapper — proved by
  # getting the implementation's ownership refusal rather than a routing error.
  expect_message "accept_employee_asset {p_assignment_id}" \
    "$(rpc accept_employee_asset "{\"p_assignment_id\":\"$DEAD\"}")" \
    'ASSET_ACCEPT_DENIED'

  # The new UI's call, with the box ticked.
  expect_message "accept_employee_asset {p_assignment_id, p_accept_terms: true}" \
    "$(rpc accept_employee_asset "{\"p_assignment_id\":\"$DEAD\",\"p_accept_terms\":true}")" \
    'ASSET_ACCEPT_DENIED'

  # …and with it unticked, which the DATABASE refuses before it looks at
  # anything else. This is the checkbox being real rather than decorative.
  expect_message "accept_employee_asset {p_assignment_id, p_accept_terms: false}" \
    "$(rpc accept_employee_asset "{\"p_assignment_id\":\"$DEAD\",\"p_accept_terms\":false}")" \
    'ASSET_ACCEPT_TERMS_REQUIRED'

  # The other half of the same screen: the deployed frontend's five-argument
  # assign_asset must still resolve against the seven-argument function.
  expect_message "assign_asset (five arguments)" \
    "$(rpc assign_asset "{\"p_asset_id\":\"$DEAD\",\"p_employee_id\":\"$DEAD\",\"p_effective_date\":null,\"p_condition\":\"good\",\"p_remarks\":\"x\"}")" \
    'ASSET_CUSTODY_DENIED'
fi

echo
echo "══ done. The database still holds the schema; the assertions left no rows."
