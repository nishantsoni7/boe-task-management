-- Finance — cash cannot be handed over before it was collected.
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
-- Apply AFTER 20260716000000 (which IS applied — verified local+remote via
-- `supabase migration list --linked` on 2026-07-27, and left untouched by this
-- migration).
--
-- ── Why this exists, and why it is a REVERSAL ─────────────────────────────────
--
-- 20260716 §2 states, in its own comment, that this rule was deliberately left
-- OUT of the database and enforced only by the form (collectionErrorFor in
-- src/app/finance/paymentDestinations.ts). That reasoning was:
--
--     "as a CHECK it would also refuse a later, legitimate correction of
--      payment_date on a row that already carries a handover — a real edit
--      blocked by a rule about a different field."
--
-- That trade was decided the wrong way round, and this migration reverses it.
-- The deciding argument: handed_over_at is a FINANCIAL ACCOUNTABILITY field —
-- it is the record of who became responsible for physical cash, and when. A
-- rule protecting that cannot live only in a React component, because a
-- component is bypassed by a direct PostgREST call, by a stale client running
-- yesterday's bundle, and by the next edit to the form that forgets it.
--
-- The cost is real and is accepted knowingly: moving payment_date FORWARD past
-- an existing handed_over_at is now refused, so correcting the payment date of
-- an already-handed-over payment means correcting both fields in the same
-- UPDATE. The form sends every cash column on every save, so it does that
-- naturally; a hand-written PATCH must do it deliberately.
--
-- ── What this migration does NOT do ───────────────────────────────────────────
--
--   * it does not modify 20260716000000, which is applied;
--   * it does not recreate or replace any trigger, function, RLS policy, grant
--     or index — the constraint is self-enforcing and needs none of them;
--   * it does not touch finance_payment_requests_handover_pair, which keeps
--     stating its own separate rule (recipient and date move together);
--   * it does not change a column type;
--   * it does not backfill or repair anything. There is nothing to repair: a
--     live count of rows where `handed_over_at is not null and handed_over_at <
--     payment_date` returned 0 (of 6 rows, 0 carry a handover at all) before
--     this file was written, so ADD CONSTRAINT validates against real data
--     rather than hoping.

-- ── The rule ──────────────────────────────────────────────────────────────────
-- NULL-permissive on purpose: "not handed over yet" is the normal state of a
-- PNB payment on the day it is submitted, and must stay writable. The
-- constraint only has an opinion once a handover date actually exists.
--
-- `>=` not `>`: collecting cash and handing it over the same day is the ordinary
-- case, not an error.
--
-- No `drop constraint if exists`. This constraint has never existed, so a drop
-- would be dead code that also silently masks a name collision with something
-- else in a future rerun. (20260716 §2 used the drop-first form because it was
-- re-asserting a constraint that migration itself owned.)

alter table public.finance_payment_requests
  add constraint finance_payment_requests_handover_not_before_payment
  check (
    handed_over_at is null
    or handed_over_at >= payment_date
  );

comment on constraint finance_payment_requests_handover_not_before_payment
  on public.finance_payment_requests is
  'Cash cannot be handed over before it was collected. NULL-permissive: a PNB payment is submitted with no handover and completes it later. Same-day handover is allowed. Consequence: moving payment_date forward past an existing handed_over_at requires updating both in one statement.';
