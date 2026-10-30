-- One row per real punch from the Minop machine, stored once.
--
-- minop_webhook_deliveries keeps every message verbatim and is left untouched.
-- This table keeps each punch ONCE, keyed by device + person + punch time.
--
-- The key is deliberately NOT the device's transaction id. On production
-- (2026-10-30) txnId 21 and 22 each carried two different punches, so a key on
-- it would silently drop a real punch. txn_id is kept only as information.
--
-- Nothing here writes attendance_records or payroll. Minop stays collection-only
-- (src/lib/minop/collectionMode.ts) until the machine-attendance switch-on, which
-- is a separate change.
--
-- Who a punch belongs to is NOT stored: it is resolved at read time from
-- users.minop_user_id (next migration), so correcting Employee Master corrects
-- history automatically.

create table public.minop_punches (
  id              uuid primary key default gen_random_uuid(),
  dvc_id          text not null,
  minop_user_id   text not null,
  -- Exactly as the machine sent it (no time zone).
  punch_local     timestamp not null,
  -- punch_local read as IST. New rows get this from application code
  -- (MINOP_DEVICE_UTC_OFFSET_MINUTES); production confirmed the machine runs on
  -- IST on 2026-10-30, when punches arrived 2 minutes after their stated time.
  punch_at        timestamptz not null,
  txn_id          text,
  mode            text,
  -- When BOE first received this punch.
  first_seen_at   timestamptz not null,
  created_at      timestamptz not null default now(),
  constraint minop_punches_device_person_time_key unique (dvc_id, minop_user_id, punch_local),
  constraint minop_punches_user_not_blank check (btrim(minop_user_id) <> '')
);

create index minop_punches_punch_at_idx on public.minop_punches (punch_at);
create index minop_punches_user_punch_at_idx on public.minop_punches (minop_user_id, punch_at);

alter table public.minop_punches enable row level security;
-- No policies on purpose: only the service-role routes touch this table.
revoke all on public.minop_punches from anon, authenticated;
grant all on public.minop_punches to service_role;

-- Everything the machine has already sent. Each punch takes the values of the
-- earliest message that carried it. A repeat on the unique key cannot happen
-- here (distinct on), and on conflict keeps a re-run harmless.
insert into public.minop_punches
  (dvc_id, minop_user_id, punch_local, punch_at, txn_id, mode, first_seen_at)
select distinct on (dvc_id, minop_user_id, punch_local)
  dvc_id, minop_user_id, punch_local,
  punch_local at time zone 'Asia/Kolkata',
  txn_id, mode, received_at
from (
  select
    coalesce(nullif(btrim(e->>'dvcId'), ''), 'unknown') as dvc_id,
    btrim(e->>'punchId') as minop_user_id,
    (e->>'txnDateTime')::timestamp as punch_local,
    nullif(btrim(e->>'txnId'), '') as txn_id,
    nullif(btrim(e->>'mode'), '') as mode,
    d.received_at
  from public.minop_webhook_deliveries d
  cross join lateral jsonb_array_elements(d.payload->'trans') e
  where d.processing_status = 'received'
    and jsonb_typeof(d.payload->'trans') = 'array'
    and btrim(e->>'punchId') <> ''
    and e->>'txnDateTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
) readable
order by dvc_id, minop_user_id, punch_local, received_at
on conflict (dvc_id, minop_user_id, punch_local) do nothing;
