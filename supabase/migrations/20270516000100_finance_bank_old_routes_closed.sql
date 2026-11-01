-- ═══════════════════════════════════════════════════════════════════════════════
-- A STATEMENT CREATES NOTHING, FROM A BROWSER EITHER.
--
-- Second half of 20270516000000. That migration made a Payment Request the only
-- thing that creates a payment and took the calls off the screens, but left the two
-- old doors open so that a screen still running the old code kept working during
-- the release. The new screens are live and a real payment has been verified through
-- them, so the doors close. An old browser tab that still calls one now gets a
-- refusal instead of adding a payment.
--
--   sync_bank_credits(uuid[])                          added credits on upload
--   add_bank_line_to_confirmed(uuid, uuid[], text)     Add to Confirmed on the bank page
--
-- create_payment_from_bank_line was closed to browsers by 20270514000000.
--
-- CLOSED, NOT DROPPED: both stay, so a rollback is one grant and nothing has to be
-- rebuilt. No data changes. Payments these doors already added stay as they are.
--
-- ROLLBACK:
--   grant execute on function public.sync_bank_credits(uuid[]) to authenticated;
--   grant execute on function public.add_bank_line_to_confirmed(uuid, uuid[], text) to authenticated;
-- ═══════════════════════════════════════════════════════════════════════════════

revoke all on function public.sync_bank_credits(uuid[]) from public, anon, authenticated;
revoke all on function public.add_bank_line_to_confirmed(uuid, uuid[], text) from public, anon, authenticated;

do $assert$
declare
  f text;
begin
  foreach f in array array[
    'public.sync_bank_credits(uuid[])',
    'public.add_bank_line_to_confirmed(uuid, uuid[], text)',
    'public.create_payment_from_bank_line(uuid, boolean, text)'
  ] loop
    if to_regprocedure(f) is null then
      raise exception '% must stay in place, closed, for a rollback', f;
    end if;
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% must not be callable from a browser', f;
    end if;
  end loop;

  -- The door that replaced them stays open.
  if not has_function_privilege('authenticated', 'public.verify_payment_with_bank(uuid, uuid[])', 'execute') then
    raise exception 'verify_payment_with_bank must stay callable';
  end if;
end
$assert$;
