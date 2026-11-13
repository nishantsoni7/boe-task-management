-- 20270703000000_scoreboard_top5_switch.sql
--
-- The Scoreboard's Top 5 (owner, 2026-11-13): "everyone is still able to see the rankings, how do I hide it".
-- Staff see only their own score; administrators still see the Top 5 and "Most improved"; one switch on
-- Team Today -> People & targets shows the Top 5 to everyone again (for example from December).
--
--   day_close_settings.scoreboard_top5_public   false (hidden from staff) by default
--
-- day_close_settings stays closed to the browser: the switch is read and written only by the service role
-- (/api/scoreboard/me and /api/scoreboard/visibility, administrators only for the write).
--
-- Before this migration is applied the server reads the switch as "hidden", so staff never see the Top 5.
-- Safe to run again.
--
-- ROLLBACK: alter table public.day_close_settings drop column scoreboard_top5_public;

do $$
begin
  if to_regclass('public.day_close_settings') is null then
    raise exception 'DEPENDENCY MISSING: day_close_settings (20270622000000) must exist';
  end if;
end $$;

alter table public.day_close_settings
  add column if not exists scoreboard_top5_public boolean not null default false;

comment on column public.day_close_settings.scoreboard_top5_public is
  'Show the Scoreboard Top 5 and Most improved to everyone (true) or to administrators only (false). Owner, 2026-11-13.';
