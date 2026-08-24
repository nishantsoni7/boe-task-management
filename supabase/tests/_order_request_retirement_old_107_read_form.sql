-- THE SECOND FORM OF MIGRATION 20261007000000 §5i — the one that failed, preserved
-- ===========================================================================
-- Not a migration. The load-bearing part of the second form of §5i, kept
-- verbatim so the suite can reproduce the second linked failure and prove the
-- corrected form is what fixes it, rather than asserting that from memory.
--
-- Two things are copied unmodified from commit f877ead:
--
--   * §5f's role handling — `set local role authenticated` for the client
--     probe, then `reset role` to "put it back". RESET ROLE is SET ROLE NONE:
--     it returns to SESSION_USER, which on the linked database is the CLI's
--     LOGIN role, not the owner role the migration was running as. Everything
--     after this point runs demoted.
--
--   * §5i's readability probe — a dynamic read of the business table, which a
--     migration should never need in order to prove a column exists.
--
-- Expected outcome, and the runner requires exactly this:
--
--   ERROR:  public.orders.source_order_request_id is in the catalog but could
--           not be read (permission denied for table orders): the historical
--           record must stay reachable
--
-- Run with --single-transaction, as a migration applies, and as the CLI login
-- role having assumed the owner role — which is the only configuration in which
-- it fails, and the whole point.

do $$
declare
  v_missing text;
  v_count   int;
begin
  -- §5f, in miniature: become a client to probe RLS, then "put the role back".
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ff', true);
  execute 'reset role';                       -- <<< the demotion, not a restore
  perform set_config('request.jwt.claim.sub', '', true);

  -- §5i, second form: catalog first — which is correct and still passes —
  foreach v_missing in array array[
    'orders.source_order_request_id',
    'orders.source_request_number'
  ] loop
    if to_regclass('public.' || quote_ident(split_part(v_missing, '.', 1))) is null
       or not exists (
         select 1
         from pg_catalog.pg_attribute a
         where a.attrelid = ('public.' || quote_ident(split_part(v_missing, '.', 1)))::regclass
           and a.attname  = split_part(v_missing, '.', 2)
           and a.attnum > 0
           and not a.attisdropped
       ) then
      raise exception 'public.% must not be dropped: confirmed Orders depend on it', v_missing;
    end if;

    -- — and then the read, which is where it dies.
    begin
      execute format('select count(*) from public.%I where %I is not null',
                     split_part(v_missing, '.', 1), split_part(v_missing, '.', 2))
        into v_count;
    exception when others then
      raise exception
        'public.% is in the catalog but could not be read (%): the historical record must stay reachable',
        v_missing, sqlerrm;
    end;
  end loop;
end $$;
