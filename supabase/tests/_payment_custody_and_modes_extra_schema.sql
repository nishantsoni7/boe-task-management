-- ── The production shape 20261014000000 needs, and the reset fixture omits ────
--
-- supabase/tests/_order_finance_reset_shaped_schema.sql models order_submissions
-- with the columns THAT suite needed. 20261014000000 §8 reads two more, both of
-- which have existed in production since 20260908000000 §1:
--
--     source_order_number    whatever the PI workbook printed as its own number
--     source_workbook_name   the uploaded file's name, the fallback when the
--                            workbook printed no number
--
-- They are how a PI Draft identifies itself to a person — the same two fields
-- every PI picker in the application shows, and the same pair
-- src/app/finance/paymentIntents.ts already reads back for the detail modal. A
-- destination projection that could not name a PI would print a blank where the
-- chosen record belongs.
--
-- ADDED HERE RATHER THAN INVENTED IN THE MIGRATION. The migration is entitled to
-- assume production's schema; it is the FIXTURE that is a reduction, and the
-- 20261013000000 push proved what happens when a fixture answers an easier
-- question than production asks.

alter table public.order_submissions
  add column if not exists source_order_number  text,
  add column if not exists source_workbook_name text;

comment on column public.order_submissions.source_order_number is
  'Fixture stand-in for the production column created by 20260908000000.';
comment on column public.order_submissions.source_workbook_name is
  'Fixture stand-in for the production column created by 20260908000000.';
