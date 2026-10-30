-- The employee's ID on the NEW Minop machine, kept separate from
-- fingerprint_employee_code (the old machine's code, used by the Excel import).
-- The two machines number people differently: production codes look like 0014,
-- the machine sends 1, 2, 4 ... so one column cannot serve both.
--
-- Private by construction: authenticated holds column-level SELECT on an
-- explicit list only (20260813000000), so a new column is unreadable from a
-- browser until someone grants it. Only service-role routes read or write it.

alter table public.users add column minop_user_id text;

alter table public.users
  add constraint users_minop_user_id_not_blank
  check (minop_user_id is null or btrim(minop_user_id) <> '');

-- One person per machine ID. Matching is exact text, like the fingerprint code.
create unique index users_minop_user_id_key
  on public.users (minop_user_id)
  where minop_user_id is not null;
