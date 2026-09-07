-- Native share records the same "opened" fact the phone-number tool does.
--
-- THE PROBLEM. Confirm Sent — and therefore submission — is gated on
-- customer_review_test_cards.whatsapp_opened_at being non-null (see
-- confirm_customer_review_test_card_sent(), 20261017000000 §8). Until now the
-- ONLY writer of that column was record_customer_review_test_card_whatsapp_opened(),
-- which requires a validated phone number's last four digits — a parameter
-- with no equivalent when a candidate shares through the device's own native
-- share sheet (Web Share API) instead of typing a number into BOE. A first
-- production pilot found this: a real candidate's genuine share-and-post left
-- her with no way to ever unlock Confirm Sent, because nothing recorded that
-- a hand-off had happened.
--
-- THE COLUMN'S MEANING DOES NOT CHANGE. Its own comment already says
-- "proves preparation only" — that is exactly as true of a native share
-- hand-off as it is of a wa.me link, and confirm_customer_review_test_card_sent()
-- only ever checked "is this non-null", never anything about how it got that
-- way. Reusing it here is not a reinterpretation.
--
-- WHY A NEW FUNCTION RATHER THAN A NEW PARAMETER ON THE OLD ONE.
-- record_customer_review_test_card_whatsapp_opened() takes p_actor_id as an
-- EXPLICIT ARGUMENT and is therefore service-role only — a client could pass
-- any id it liked, so the only safe caller is the server route that resolves
-- the real actor itself. A native share has no phone number to validate and no
-- reason to go through a server round trip at all: the browser already knows
-- everything it needs (the card id) the moment navigator.share() returns.
-- confirm_customer_review_test_card_sent() next to it uses auth.uid() instead
-- of an actor parameter and is safely grantable straight to `authenticated` —
-- this function follows that same, safer shape, not the older one's.
--
-- WHAT IT DOES NOT DO. It does not touch whatsapp_target_last_four (there is
-- no number to mask) or status. It does not accept a caller-supplied actor id.
-- It does not require or record which share mechanism was used beyond the
-- event detail. It changes no existing function, no existing grant and no
-- existing constraint — customer_review_test_card_events.event_type already
-- permits 'whatsapp_opened', so this reuses that value with different detail
-- text rather than widening the CHECK.

create or replace function public.record_customer_review_test_card_share_opened(
  p_card_id uuid
)
returns public.customer_review_test_cards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c     public.customer_review_test_cards%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists' using errcode = 'P0002';
  end if;

  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review, so it can no longer be shared'
      using errcode = '42501';
  end if;

  -- THE HOLDER, AND ONLY THE HOLDER — no role bypass, matching every other
  -- writer on this card. Sharing is a candidate action; an administrator
  -- doing it on somebody else's card would be an administrator running
  -- somebody else's review.
  if not (
    c.booked_by = v_uid
    and public.resolve_permission(v_uid, 'customer_review_requests', 'use')
    and exists (select 1 from public.users u where u.id = v_uid and u.is_active)
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only the candidate holding this card can record a share for it'
      using errcode = '42501';
  end if;

  if c.status <> 'booked' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_TRANSITION: A share can only be recorded for a booked card'
      using errcode = '23514';
  end if;

  update public.customer_review_test_cards
     set whatsapp_opened_at    = now(),
         whatsapp_opened_count = whatsapp_opened_count + 1
   where id = p_card_id;

  insert into public.customer_review_test_card_events
    (card_id, event_type, detail, actor_id)
  values
    (p_card_id, 'whatsapp_opened',
     'The review was shared through the device''s native share sheet. This does not confirm the message was sent.',
     v_uid);

  select * into c from public.customer_review_test_cards where id = p_card_id;
  return c;
end;
$$;

revoke execute on function public.record_customer_review_test_card_share_opened(uuid) from public, anon;
grant  execute on function public.record_customer_review_test_card_share_opened(uuid) to authenticated;

comment on function public.record_customer_review_test_card_share_opened(uuid) is
  'Records that a native share hand-off happened for a booked card — the Web Share API equivalent of record_customer_review_test_card_whatsapp_opened(), for a caller with no phone number to validate. Writes whatsapp_opened_at and the counter only; touches no status and no target digits.';
