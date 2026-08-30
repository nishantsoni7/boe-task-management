#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# The gate: is this database one we are allowed to write a schema into?
# ═════════════════════════════════════════════════════════════════════════════
#
# Sourced by run_customer_review_outreach_local.sh and by its guard tests, so
# there is ONE implementation and no second copy to drift. The tests call these
# functions directly rather than inferring their behaviour from the runner.
#
# THE RULE EVERY CHECK HERE OBEYS: a question that cannot be answered is not an
# answer of zero.
#
# An earlier version wrote the auth and storage probes as
#
#     count="$(psql_q "select count(*) from auth.users" 2>/dev/null || echo 0)"
#
# which turns "the auth schema is missing", "the connection died" and "psql is
# not on the path" all into "there are no identities here, go ahead". Every
# failure mode of that line produced the answer that permits writing. The checks
# below fail closed: an error, a missing relation, an empty result, more than
# one line, or anything that is not an integer stops the run and names the probe
# that broke.
#
# Requires: DB_CONTAINER and MARKER set by the caller. DB_NAME is optional and
# defaults to `postgres` — naming the database as well as the container is part
# of naming the target, and it is what lets the guard tests point this at a
# database that genuinely has no auth or storage schema.

# ── Why these functions signal rather than exit ──────────────────────────────
#
# count_or_die() is called as `n="$(count_or_die …)"`, and a command
# substitution runs in a SUBSHELL: an `exit` inside it ends the subshell and
# leaves the parent running with an empty variable — the precise failure this
# file exists to prevent. So it returns non-zero and every call site propagates
# with `|| return 1`, which the runner turns into an exit.
#
# For the same reason nothing here relies on `if [ $? -ne 0 ]` after an
# assignment: under `set -e` a failing substitution aborts before that line is
# reached, and the operator would get no explanation. Every fallible command is
# written as `x="$(…)" || { explain; return 1; }`.

_psql_raw() {
  docker exec -i "$DB_CONTAINER" \
    psql -U postgres -d "${DB_NAME:-postgres}" -At -v ON_ERROR_STOP=1 -c "$1" 2>&1
}

# One integer, or a non-zero return. Never a default, never a fallback.
#
#   n="$(count_or_die '<label>' '<sql>')" || return 1
count_or_die() {
  local label="$1" sql="$2" out lines

  if ! out="$(_psql_raw "$sql")"; then
    {
      echo "FATAL: the '$label' check could not run against $DB_CONTAINER."
      echo "       A check that cannot answer is not an answer of zero, so this"
      echo "       stops here rather than assuming the database is empty."
      printf '%s\n' "$out" | sed 's/^/         /'
      echo "       Nothing was written."
    } >&2
    return 1
  fi

  # Exactly one line. More would mean a notice, a warning or an extra row.
  lines="$(printf '%s\n' "$out" | grep -c '')"
  if [ "$lines" -ne 1 ]; then
    {
      echo "FATAL: the '$label' check returned $lines lines; expected exactly one."
      printf '%s\n' "$out" | sed 's/^/         /'
      echo "       Nothing was written."
    } >&2
    return 1
  fi

  # ...and that line must be an integer. Anything else means the probe did not
  # measure what it was written to measure.
  case "$out" in
    ''|*[!0-9]*)
      {
        echo "FATAL: the '$label' check returned '$out', which is not a count."
        echo "       Nothing was written."
      } >&2
      return 1
      ;;
  esac

  printf '%s' "$out"
}

# A single emptiness check: run the probe, insist on zero.
_require_empty() {
  local label="$1" sql="$2" noun="$3" n
  n="$(count_or_die "$label" "$sql")" || return 1
  if [ "$n" != "0" ]; then
    echo "FATAL: $DB_CONTAINER holds $n $noun. Nothing was written." >&2
    return 1
  fi
  return 0
}

# Every guard, in order, before a single statement of schema is applied.
# Returns non-zero on the first failure; the caller exits.
require_disposable_stack() {
  local found_marker ledger

  # ── The marker ────────────────────────────────────────────────────────────
  # A database comment: it lives in the database, so it travels with the thing
  # being protected, and setting it is a deliberate statement that this database
  # holds nothing anybody wants.
  if ! found_marker="$(_psql_raw "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = current_database()")"; then
    {
      echo "FATAL: could not read the disposable-stack marker from $DB_CONTAINER."
      printf '%s\n' "$found_marker" | sed 's/^/         /'
      echo "       Nothing was written."
    } >&2
    return 1
  fi

  if [ -z "$found_marker" ]; then
    {
      echo "FATAL: $DB_CONTAINER carries no disposable-stack marker."
      echo "       This script only builds on a database somebody has declared"
      echo "       throwaway:"
      echo "         docker exec -i $DB_CONTAINER psql -U postgres -d postgres -c \\"
      echo "           \"comment on database postgres is '$MARKER'\""
      echo "       Nothing was written."
    } >&2
    return 1
  fi
  if [ "$found_marker" != "$MARKER" ]; then
    {
      echo "FATAL: marker mismatch on $DB_CONTAINER."
      echo "       found    '$found_marker'"
      echo "       expected '$MARKER'"
      echo "       Nothing was written."
    } >&2
    return 1
  fi

  # ── Emptiness, in every place a real deployment keeps something ───────────
  # public alone was the original check and it was not enough: a database can
  # have an empty public schema and still hold every identity and every file.
  _require_empty 'public tables' \
    "select count(*) from pg_tables where schemaname = 'public'" \
    'table(s) in public' || return 1

  _require_empty 'auth identities' \
    "select count(*) from auth.users" \
    'identit(ies) in auth.users' || return 1

  _require_empty 'storage objects' \
    "select count(*) from storage.objects" \
    'object(s) in storage.objects' || return 1

  _require_empty 'storage buckets' \
    "select count(*) from storage.buckets" \
    'bucket(s) in storage.buckets' || return 1

  # ── The migration ledger, the one probe that may legitimately find nothing
  #    to count ───────────────────────────────────────────────────────────────
  #
  # auth.users and storage.objects always exist in a Supabase stack, so a
  # missing one means something is wrong and the checks above refuse. The ledger
  # is different: `supabase db reset --no-seed` with migrations disabled leaves
  # supabase_migrations.schema_migrations ABSENT, and that absence is exactly the
  # blank stack this script wants.
  #
  # So it is asked in two parts and BOTH fail closed. First "does the relation
  # exist", via to_regclass, which answers on any live connection and so still
  # catches a dead one. Only if it exists is it counted. What is never allowed is
  # inferring emptiness from an error.
  if ! ledger="$(_psql_raw "select coalesce(to_regclass('supabase_migrations.schema_migrations')::text, '')")"; then
    {
      echo "FATAL: could not determine whether $DB_CONTAINER has a migration ledger."
      printf '%s\n' "$ledger" | sed 's/^/         /'
      echo "       Nothing was written."
    } >&2
    return 1
  fi

  if [ -n "$ledger" ]; then
    _require_empty 'migration ledger' \
      "select count(*) from supabase_migrations.schema_migrations" \
      'applied migration(s) in its ledger; this is not a blank stack' || return 1
  fi

  return 0
}
