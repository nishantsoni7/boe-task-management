-- ═══════════════════════════════════════════════════════════════════════════
-- WHICH ORDERS SHOW THE PI HANDOFF, AND WHY THE REST DO NOT
--
-- Run this when the Approved PI panel, the workbook download or the confirmed
-- documents card are not appearing on an Order and you want to know whether
-- that is correct.
--
-- ── THIS SCRIPT WRITES NOTHING. ────────────────────────────────────────────
-- Four SELECTs. No INSERT, UPDATE, DELETE or TRUNCATE, no transaction, no
-- fixture. Safe to run against any database, production included.
--
-- Usage:  psql "$DATABASE_URL" -f supabase/tests/order_pi_handoff_eligibility.sql
--
-- ── THE ONE RULE THAT DECIDES IT ───────────────────────────────────────────
-- The screen keys off exactly one column: orders.source_order_submission_id.
--
--   not null  ->  the PI panel, the workbook download and the documents card
--                 all render (the documents card renders even before anything
--                 has been generated).
--   null      ->  none of them render. The Order did not come from a PI, so
--                 there is no approved PI to show and no document to generate.
--                 The screen now says so in as many words.
--
-- That column is written by approve_order_submission() and by nothing else, so
-- an Order carries a PI only if it was CREATED by approving one. An Order made
-- directly, or converted from an Order Request, never will — and no amount of
-- permission will change that. Do not backfill this column by hand to make the
-- panel appear: it is immutable once set, financial history hangs off it, and a
-- fabricated link would point an Order at a PI it did not come from.
-- ═══════════════════════════════════════════════════════════════════════════

\echo ''
\echo '── 1. THE HEADLINE: how many Orders can show the PI handoff at all? ──'
select
  count(*)                                                    as orders_total,
  count(*) filter (where source_order_submission_id is not null) as with_pi_eligible,
  count(*) filter (where source_order_submission_id is null)     as without_pi_shows_explanation
from public.orders;

\echo ''
\echo '── 2. THE ELIGIBLE ORDERS. Open one of these to see the feature. ──'
\echo '   (documents_generated counts READY versions only; 0 is normal before'
\echo '    anyone has generated, and the card still appears.)'
select
  o.display_number                                        as order_number,
  o.client_name,
  o.status                                                as order_status,
  s.status                                                as pi_status,
  (s.source_workbook_path is not null)                    as workbook_downloadable,
  (select count(*) from public.order_document_versions d
    where d.order_id = o.id and d.status = 'ready')       as documents_ready,
  o.id                                                    as order_id
from public.orders o
join public.order_submissions s on s.id = o.source_order_submission_id
order by o.created_at desc
limit 25;

\echo ''
\echo '── 3. THE INELIGIBLE ONES, with the reason. Nothing is wrong with these. ──'
select
  o.display_number as order_number,
  o.client_name,
  o.status         as order_status,
  case
    when o.source_order_request_id is not null
      then 'converted from an Order Request — never had a PI'
    else 'created directly — never had a PI'
  end              as why_no_pi
from public.orders o
where o.source_order_submission_id is null
order by o.created_at desc
limit 25;

\echo ''
\echo '── 4. APPROVED PIs THAT PRODUCED NO ORDER. ──'
\echo '   Expected to be empty. A row here means an approval did not complete,'
\echo '   which is a real defect — approve_order_submission writes the PI, the'
\echo '   Order and the link in ONE transaction, so a half-finished pair should'
\echo '   not exist.'
select
  s.id            as submission_id,
  s.client_name,
  s.status        as pi_status,
  s.order_id      as pi_points_at_order
from public.order_submissions s
where s.status = 'approved'
  and not exists (
    select 1 from public.orders o where o.source_order_submission_id = s.id
  )
order by s.id
limit 25;

\echo ''
\echo '── Reading this ──'
\echo '  Section 2 empty  -> no Order has ever been created by approving a PI.'
\echo '                      Approve one PI through the normal flow and the'
\echo '                      feature appears on the Order it creates.'
\echo '  Section 2 has rows, but the panel is still missing on those Orders'
\echo '                   -> not data. Check that the browser is on the preview'
\echo '                      deployment, and that the migrations reached the'
\echo '                      SAME project the app points at.'
\echo '  Section 4 has rows -> a genuine defect. Report it.'
\echo ''
