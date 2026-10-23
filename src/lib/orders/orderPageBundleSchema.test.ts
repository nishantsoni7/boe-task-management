// THE ORDER PAGE'S ONE READ: THE MIGRATION AND THE PAGE'S USE OF IT (20270406000000).
//
// Source-level pins for what must stay true of public.order_page_bundle() and of the page that calls it:
// it is SECURITY INVOKER (so every table's own row-level security decides, as it does for the page's separate
// reads), it only reads, its column lists are the page's own constants, and the page keeps its separate reads
// as the fallback. The migration was also executed inside BEGIN..ROLLBACK against the live database for every
// Order as an administrator, an operations user and a salesperson (0 failed checks); that run is the proof of
// behaviour, these keep the file honest afterwards.
//
// Run with: npx tsx --test "src/lib/orders/orderPageBundleSchema.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORDER_PI_HANDOFF_COLUMNS } from './orderPiHandoff'
import { PI_DRAFT_ITEM_COLUMNS, PI_DRAFT_ITEM_IMAGE_COLUMNS } from './draftsView'
import { ORDER_PI_VERSION_COLUMNS } from './orderPiVersions'
import { PI_ACTIVITY_COLUMNS } from './submissionActivity'
import { PI_COMMISSION_COLUMNS } from './piInternalDetails'
import { ORDER_OPERATIONS_HANDOFF_COLUMNS } from './operationsHandoff'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')
const RAW = read('supabase/migrations/20270406000000_order_page_bundle.sql')
// code only: no comments, one line, single spaces
const CODE = RAW.replace(/--.*$/gm, '').replace(/\s+/g, ' ')
const PAGE = read('src/app/orders/[id]/page.tsx')

describe('the function', () => {
  test('is SECURITY INVOKER, stable, search_path pinned, and never a definer', () => {
    assert.match(CODE, /create or replace function public\.order_page_bundle\(p_order_id uuid\) returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp/)
    assert.equal(/security definer/i.test(CODE), false)
  })

  test('is closed to anon and open to signed-in users', () => {
    assert.match(CODE, /revoke execute on function public\.order_page_bundle\(uuid\) from public, anon;/)
    assert.match(CODE, /grant execute on function public\.order_page_bundle\(uuid\) to authenticated;/)
  })

  test('only reads: no write, no schema change, no policy, no trigger', () => {
    const fn = CODE.slice(CODE.indexOf('create or replace function'), CODE.indexOf('comment on function'))
    assert.equal(/\b(insert|update|delete|truncate|alter|drop)\b/i.test(fn.replace(/set search_path/gi, '')), false)
    assert.equal(/create (table|policy|trigger|index|view|type)/i.test(CODE), false)
  })

  test('every part is wrapped, so one refused part never takes the others down', () => {
    const blocks = (CODE.match(/exception when others then/g) ?? []).length
    assert.ok(blocks >= 17, `expected a protected block per part, found ${blocks}`)
    assert.match(CODE, /return jsonb_build_object\('found', false\)/)
  })

  test('the Order page\'s own column constants are the column lists it selects', () => {
    const lists: [string, string, string][] = [
      ['the source PI', ORDER_PI_HANDOFF_COLUMNS, 'order_submissions'],
      ['items', PI_DRAFT_ITEM_COLUMNS, 'order_submission_items'],
      ['item images', PI_DRAFT_ITEM_IMAGE_COLUMNS, 'order_submission_item_images'],
      ['PI versions', ORDER_PI_VERSION_COLUMNS, 'order_pi_versions'],
      ['the PI trail', PI_ACTIVITY_COLUMNS, 'order_submission_activity'],
      ['the commission', PI_COMMISSION_COLUMNS, 'order_submission_middleman_commissions'],
      ['the operations handoffs', ORDER_OPERATIONS_HANDOFF_COLUMNS, 'order_operations_handoffs'],
    ]
    for (const [what, cols, table] of lists) {
      assert.ok(CODE.includes(`select ${cols} from public.${table}`), `${what}: the SQL must select exactly the page's columns from ${table}`)
    }
  })

  test('the parts the page maps by name are all returned, under those names', () => {
    for (const name of ['advance', 'submission', 'items', 'images', 'codes', 'versions', 'trail', 'handoffs', 'commission',
      'commission_readable', 'payments', 'allocations', 'active_totals', 'activity', 'approvals', 'change_requests', 'people']) {
      assert.ok(CODE.includes(`'${name}', v_`), `the answer carries ${name}`)
    }
  })

  test('the migration proves itself when it runs', () => {
    assert.match(CODE, /prosecdef/)
    assert.match(CODE, /raise exception 'order_page_bundle proof:/)
  })
})

describe('the page', () => {
  test('asks the database for the whole page first and keeps its separate reads as the fallback', () => {
    assert.match(PAGE, /const bundle = await fetchOrderBundle\(supabase, id\)/)
    assert.match(PAGE, /if \(!bundle\) void loadAdvance\(\)/)
    assert.match(PAGE, /bundle \? bundle\.orderRow : await earlyRow/)
    // the header is drawn from the order row read alongside the bundle, and never after the bundle has landed
    assert.match(PAGE, /const earlyRow = orderRowQuery\(\)[\s\S]*?if \(bundleApplied \|\| !early\) return[\s\S]*?const bundle = await fetchOrderBundle/)
    assert.match(PAGE, /loadPiHandoff\(mapped, bundle\?\.pi\)/)
    assert.match(PAGE, /\? Promise\.resolve\(prefetched\.people\)/)
    assert.match(PAGE, /: await supabase\.rpc\('payment_active_allocation_totals'/)
    // the old reads are still all there
    for (const old of [".from('order_submissions')", ".from('order_submission_items')", ".from('order_product_codes')",
      ".from('finance_payment_allocations')", "order_change_requests", 'approvalsQuery()', 'activityQuery()']) {
      assert.ok(PAGE.includes(old), `the fallback still reads ${old}`)
    }
  })

  test('approvals and change requests are filled from their own reads (the names follow the order of the reads)', () => {
    assert.match(PAGE, /\{ data: aData \},\s+\{ data: apprData \},\s+\{ data: cData \},\s+\] = bundle/)
    assert.match(PAGE, /\[bundle\.payments, bundle\.allocations, bundle\.activity, bundle\.approvals, bundle\.changeRequests\] as const/)
    assert.match(PAGE, /setApprovals\(mapApprovalRows\(apprData\)\)/)
    assert.match(PAGE, /setChangeRequests\(\(\(cData \?\? \[\]\) as any\[\]\)/)
    // and the old path issues them in that same order
    const group = PAGE.slice(PAGE.indexOf(': await Promise.all(['), PAGE.indexOf('setApprovals(mapApprovalRows(apprData))'))
    assert.ok(group.indexOf('activityQuery()') < group.indexOf('approvalsQuery()'), 'activity, then approvals')
    assert.ok(group.indexOf('approvalsQuery()') < group.indexOf(".from('order_change_requests')"), 'then change requests')
  })
})
