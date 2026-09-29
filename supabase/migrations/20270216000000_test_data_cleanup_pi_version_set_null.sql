-- ═══ Test Data Cleanup: an advance exception no longer blocks finalization ═══
--
-- THE DEFECT, AS IT HAPPENED IN PRODUCTION (Order 0526, 2026-09-27).
--
-- 20270116000000 created public.order_advance_exceptions with
--
--     pi_version_id uuid references public.order_pi_versions(id) on delete set null
--
-- and made every row immutable: order_advance_exceptions_immutable() refuses
-- every UPDATE, and lets a DELETE through only inside Test Data Cleanup.
--
-- finalize_test_data_cleanup() deletes the PI BEFORE the Order (defect A of
-- 20260916000000: both directions of the provenance pair must hold at every
-- moment). Deleting the PI cascades to its order_pi_versions rows, and the
-- foreign key above then issues
--
--     UPDATE ONLY public.order_advance_exceptions SET pi_version_id = NULL ...
--
-- on the Order's advance exception — which is still there, because it cascades
-- from the ORDER, and the Order is deleted one statement later. The guard sees
-- an UPDATE and refuses it:
--
--     42501 ORDER_ADVANCE_EXCEPTION_IMMUTABLE: an advance exception is a record
--           and cannot be changed
--
-- The whole finalization rolls back. By then the route has already removed the
-- files, so the claim is kept (correctly) and the admin is told to run it again —
-- but every retry fails the same way. Any test Order carrying a below-40%
-- advance exception approved against a PI version could not be cleaned up.
--
-- WHY THE GUARD AND NOT FINALIZE. Same reasoning as 20260926000000 §2b:
-- finalize_test_data_cleanup() is a long SECURITY DEFINER function whose lock
-- and deletion order took a migration of its own to get right. The exemption
-- belongs with the table whose rule it relaxes, and it holds wherever a cleanup
-- deletes a PI version from.
--
-- HOW NARROW IT IS. Inside the cleanup context only (boe.cleanup_context is set
-- transaction-locally by the cleanup finalizers, after every gate has passed),
-- and only the exact change the foreign key's own SET NULL action makes:
-- pi_version_id from a value to NULL, every other column unchanged. Any other
-- UPDATE — in or out of a cleanup — is still refused, and outside a cleanup a
-- DELETE is still refused. The row itself is removed a moment later by the
-- Order's cascade, which this guard already allowed.
--
-- NOTHING IS RE-EMITTED BUT THIS ONE GUARD. Its attributes are those
-- 20270117000000 and 20270213000000 left it with: SECURITY DEFINER, and a
-- search_path that pins pg_temp last.

create or replace function public.order_advance_exceptions_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.in_test_data_cleanup() then
    if tg_op = 'DELETE' then
      return old;
    end if;

    -- The pi_version_id foreign key's own ON DELETE SET NULL, fired when a
    -- cleanup deletes the PI (and so its versions) before the Order.
    if tg_op = 'UPDATE'
       and old.pi_version_id is not null
       and new.pi_version_id is null
       and (to_jsonb(new) - 'pi_version_id') = (to_jsonb(old) - 'pi_version_id') then
      return new;
    end if;
  end if;

  raise exception 'ORDER_ADVANCE_EXCEPTION_IMMUTABLE: an advance exception is a record and cannot be changed'
    using errcode = '42501';
end;
$$;

revoke execute on function public.order_advance_exceptions_immutable()
  from public, anon, authenticated, service_role;

comment on function public.order_advance_exceptions_immutable() is
  'An advance exception is immutable. Inside Test Data Cleanup only, it may be deleted, and its pi_version_id may be set to NULL by the foreign key''s ON DELETE SET NULL (every other column unchanged) when the cleanup deletes the PI before the Order. 20270216000000.';
