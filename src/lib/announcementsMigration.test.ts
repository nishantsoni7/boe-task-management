// Announcements — what the migration and the wiring SAY. The behaviour itself is
// executed by supabase/tests/run_announcements_local.sh on a disposable stack;
// this file needs no database and writes nothing.
// Run: npx tsx --test src/lib/announcementsMigration.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// CRLF matters on Windows: `.` does not match \r, so comment stripping would fail.
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const MIGRATION = read('supabase/migrations/20270110000000_announcements.sql')
const SQL = MIGRATION.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

const functionBlocks = SQL.match(/create or replace function[\s\S]*?\$\$;/g) ?? []

describe('the migration', () => {
  test('three tables, RLS enabled and forced on each', () => {
    for (const t of ['announcements', 'announcement_recipients', 'announcement_reads']) {
      assert.match(SQL, new RegExp(`create table if not exists public\\.${t} \\(`))
      assert.match(SQL, new RegExp(`alter table public\\.${t}\\s+enable row level security`))
      assert.match(SQL, new RegExp(`alter table public\\.${t}\\s+force\\s+row level security`))
    }
  })

  test('clients may only SELECT the tables; every write is a function', () => {
    const grants = SQL.match(/grant [^;]* on table public\.announcement[^;]*;/g) ?? []
    assert.equal(grants.length, 3)
    for (const g of grants) assert.match(g, /^grant select on table/)
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) to authenticated[\s\S]{0,40}on public\./)
    assert.doesNotMatch(SQL, /create policy "announcement(s|_recipients|_reads)_(insert|update|delete)"/)
  })

  test('every SECURITY DEFINER function pins search_path to public, pg_temp', () => {
    const definers = functionBlocks.filter(b => /security definer/.test(b))
    assert.ok(definers.length >= 8)
    for (const b of definers) assert.match(b, /set search_path = public, pg_temp/, b.slice(0, 80))
  })

  test('the admin writes check an ACTIVE, non-deleted admin', () => {
    const helper = functionBlocks.find(b => b.includes('announcement_caller_is_admin()'))!
    assert.match(helper, /u\.role = 'admin'/)
    assert.match(helper, /u\.is_active/)
    assert.match(helper, /coalesce\(u\.is_deleted, false\) = false/)
    for (const fn of ['create_announcement', 'update_announcement', 'end_announcement']) {
      const block = functionBlocks.find(b => b.includes(`function public.${fn}(`))!
      assert.match(block, /if not public\.announcement_caller_is_admin\(\) then/, fn)
    }
  })

  test('a user can record only their OWN read: acknowledge takes no user id', () => {
    const block = functionBlocks.find(b => b.includes('function public.acknowledge_announcement('))!
    assert.match(block, /acknowledge_announcement\(p_id uuid\)/)
    assert.match(block, /values \(p_id, auth\.uid\(\)\)/)
    assert.match(block, /announcement_visible_to_caller\(p_id\)/)
  })

  test('visibility requires being a named recipient and the India-date window', () => {
    assert.match(SQL, /\(p_at at time zone 'Asia\/Kolkata'\)::date/)
    assert.match(SQL, /p_ended_at is null and p_starts_on <= p_on and p_on <= p_ends_on/)
    const visible = functionBlocks.find(b => b.includes('function public.announcement_visible_to_caller('))!
    assert.match(visible, /r\.user_id = auth\.uid\(\)/)
  })

  test('an empty audience is refused — never "everyone"', () => {
    assert.match(SQL, /ANNOUNCEMENT_NO_RECIPIENTS/)
  })

  test('the PDF bucket is private, PDF only, 10 MiB, with no UPDATE policy', () => {
    assert.match(SQL, /values \('announcement-files', 'announcement-files', false, 10485760, array\['application\/pdf'\]\)/)
    assert.doesNotMatch(SQL, /policy "announcement_files_update"/)
    assert.match(SQL, /policy "announcement_files_insert"[\s\S]*?announcement_caller_is_admin\(\)/)
  })

  test('nothing is fanned out into public.notifications', () => {
    assert.doesNotMatch(SQL, /public\.notifications/)
    assert.doesNotMatch(SQL, /notification_type/)
  })

  test('everything sitting behind it is accounted for', () => {
    const files = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
    assert.ok(files.includes('20270110000000_announcements.sql'), 'the migration file is missing')
    assert.deepEqual(files.slice(files.indexOf('20270110000000_announcements.sql') + 1), [
      // A payment's typed reference survives verification: a trigger on
      // finance_payment_requests, a carry-forward of unverified rows, and
      // pi_submission_payment_summary. It touches nothing Announcements creates.
      '20270111120000_finance_payment_reference_survives_verification.sql',
      // Order document submissions (#202), renumbered after this applied
      // migration. It touches nothing Announcements creates.
      '20270112000000_order_document_submissions.sql',
      // Revised-PI promotion (#205), renumbered likewise.
      '20270113000000_order_submission_revised_pi_promotes_on_operations_acceptance.sql',
      // PI numbering, PI edit revisions and the revision in force at Admin
      // approval (#209), renumbered likewise.
      '20270114000000_order_submission_numbering_at_conversion_and_exception_reasons.sql',
      '20270115000000_order_submission_pi_edit_revisions.sql',
      '20270116000000_order_pi_revision_in_force_at_admin_approval.sql',
      '20270117000000_order_finance_guards_run_as_owner.sql',
      '20270118120000_finance_payment_proof_opens_for_its_reviewers.sql',
      '20270120000000_order_submission_admin_decisions_ask_permissions.sql',
      '20270122000000_order_submission_internal_details.sql',
      '20270123000000_order_submission_internal_details_required_on_submit.sql',
      '20270201000000_order_pi_version_pdf_order_number.sql',
      '20270205000000_order_production_needs_order_level_exception.sql',
      '20270205120000_expense_reimbursements_and_bills.sql',
      '20270210000000_order_submission_highlight_remark.sql',
      '20270211000000_order_submission_sales_order_details.sql',
      '20270211120000_expense_payment_source_required.sql',
      '20270212000000_order_submission_legacy_advance_doors_closed.sql',
      '20270213000000_security_definer_search_path_pins_pg_temp.sql',
      '20270214000000_permission_resolvers_are_not_for_anon.sql',
      '20270215000000_attendance_requests.sql',
      '20270215000100_attendance_request_notification_types.sql',
      '20270216000000_test_data_cleanup_pi_version_set_null.sql',
      '20270217000000_order_submission_cleanup_number_choice.sql',
      '20270220000000_asset_catalogue.sql',
      '20270221000000_orders_dashboard_factory_focus.sql',
      '20270222000000_attendance_request_live_uniqueness.sql',
      '20270223000000_customer_review_custom_edit_delete.sql',
      '20270224000000_customer_review_custom_duplicate_detection.sql',
      '20270225000000_customer_review_reporting_and_leaderboard.sql',
      '20270226000000_payment_request_owner_soft_delete.sql',
      '20270227000000_order_submission_advance_on_total_before_gst.sql',
      '20270228000000_salesperson_orders_dashboard.sql',
      '20270301000000_notifications_event_idempotency.sql',
      '20270302000000_task_change_status_rpc.sql',
      '20270303000000_task_acknowledge_rpc.sql',
      '20270304000000_customer_review_admin_reject_and_delete.sql',
    ])
  })
})

describe('the wiring', () => {
  test('the notification routes know nothing about announcements', () => {
    // So reading, marking or deleting an ordinary notification cannot mark an
    // announcement read: they do not share a table, a route or a cache key.
    for (const p of [
      'src/app/api/notifications/route.ts',
      'src/app/api/notifications/mark-read/route.ts',
      'src/app/api/notifications/[id]/route.ts',
      'src/app/api/notifications/delete-selected/route.ts',
      'src/lib/notificationMutations.ts',
    ]) assert.doesNotMatch(read(p), /announcement/i, p)
    assert.doesNotMatch(read('src/hooks/queries/useAnnouncements.ts'), /\['notifications'/)
  })

  test('the only write the employee screens make is acknowledge_announcement', () => {
    const hook = read('src/hooks/queries/useAnnouncements.ts')
    assert.deepEqual(hook.match(/\.rpc\('([a-z_]+)'/g), [".rpc('my_announcements'", ".rpc('acknowledge_announcement'"])
    assert.doesNotMatch(hook, /\.(insert|update|upsert|delete)\(/)
  })

  test('the Modules page shows the latest announcement and the bell, but not while previewing somebody else', () => {
    // The launcher's redesign (#218) shows the latest announcement beside the
    // greeting instead of the unread banner; it reads the same query.
    const page = read('src/app/modules/page.tsx')
    assert.match(page, /const showAnnouncements = !viewMode && !!userId/)
    assert.match(page, /useMyAnnouncements\(userId, showAnnouncements\)/)
    assert.match(page, /\{!editingOrder && showAnnouncements && myAnnouncements\.length > 0 && \(/)
    assert.match(page, /<LatestAnnouncement latest=\{myAnnouncements\[0\]\} \/>/)
    assert.match(page, /\{showBell && <AnnouncementBell announcements=\{myAnnouncements\} \/>\}/)
  })

  test('Announcements is reachable from the BOE OS sidebar and Control Center', () => {
    assert.match(read('src/components/layout/BoeOsLayout.tsx'), /label="Announcements"[\s\S]{0,200}navTo\('\/announcements'\)/)
    assert.match(read('src/components/layout/ControlCenterLayout.tsx'), /label="Announcements"[\s\S]{0,120}\/announcements`/)
  })

  test('the admin form uploads first, then calls the admin RPC, and cleans up on failure', () => {
    const form = read('src/app/admin/control-center/announcements/AnnouncementForm.tsx')
    const upload = form.indexOf('.upload(newPath')
    const rpc = form.indexOf("rpc(existing ? 'update_announcement' : 'create_announcement'")
    assert.ok(upload > 0 && rpc > upload)
    assert.match(form, /if \(newPath\) await supabase\.storage\.from\(ANNOUNCEMENT_BUCKET\)\.remove\(\[newPath\]\)/)
    assert.match(form, /<MeetingModal/)
  })
})
