/**
 * The Order Request workflow is retired — proved where it has to be.
 *
 * WHAT RETIREMENT MEANS HERE, AND WHY IT IS TWO KINDS OF ASSERTION
 * ---------------------------------------------------------------
 * Hiding a screen is not retirement. A route that is gone from the sidebar is
 * still a POST away, and an RPC somebody still holds a reference to will still
 * run. So this file proves both halves:
 *
 *   THE PRODUCT — no navigation entry, no create action, no conversion control,
 *   no launcher, and no Access Control option that exists only for the retired
 *   workflow. Read off the real source files, because these are promises about
 *   ABSENCE and absence is what a reviewer stops noticing after the third read.
 *
 *   THE DATABASE — 20261007000000, read as text. Four guards that no role is
 *   exempt from, one dropped INSERT policy, and ten RPCs revoked from every
 *   client role. A repository test cannot execute SQL; the executable half is
 *   the migration's own apply-time assertion block, which refuses the apply
 *   rather than let a partial retirement look successful.
 *
 * AND THE THINGS THAT MUST NOT HAVE MOVED. Finance Payment Requests are a
 * different record on a different table with a different lifecycle, and they
 * remain fully active. Historical Order Requests, their activity, their
 * attachments and the provenance on the Confirmed Orders they became are all
 * still there and still readable — a retirement that deleted history would be a
 * different and much worse change.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderRequestRetirement.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/**
 * Source with its comments removed.
 *
 * The absence assertions below search for names, and a file that DOCUMENTS what
 * it no longer calls would otherwise fail for saying so. What is asserted is
 * what the code DOES, so the prose is stripped first: block comments (including
 * the JSX `{/* … *​/}` form) anywhere, and whole-line `//` comments.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

const readCode = (p: string) => stripComments(read(p))

const MIGRATION = 'supabase/migrations/20261007000000_retire_order_requests.sql'
const sql = read(MIGRATION)
/** Executable SQL only — a comment explains, it does not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** Every RPC the retirement revokes from every client role. */
const RETIRED_RPCS = [
  'finalize_order_request',
  'resubmit_order_request',
  'reapply_order_request',
  'respond_to_clarification',
  'edit_order_request',
  'edit_order_request_attachments',
  'request_order_request_clarification',
  'reject_order_request',
  'convert_order_request_to_order',
  'link_finance_payment_to_order_request',
]

// ══ 1. Nothing in the product offers the workflow ═════════════════════════════

describe('no Order Request navigation remains', () => {
  test('the Orders sidebar offers three destinations, and none of them is the request list', () => {
    const layout = read('src/components/layout/OrdersLayout.tsx')
    const nav = layout.slice(layout.indexOf('const navItems'), layout.indexOf('return ('))
    assert.equal(nav.includes('/orders/requests'), false)
    assert.equal(nav.includes('Order Requests'), false)
    assert.deepEqual(
      [...nav.matchAll(/label: '([^']+)'/g)].map(m => m[1]),
      ['Dashboard', 'PI Drafts', 'Confirmed Orders'],
    )
  })

  test('the request count that fed its badge is gone entirely', () => {
    // A hook nothing calls is an invitation to call it, and this one issued a
    // company-wide count on every Orders page for a list that no longer exists.
    assert.equal(existsSync(join(ROOT, 'src/hooks/queries/useOrderRequestsCount.ts')), false)
    assert.equal(read('src/components/layout/OrdersLayout.tsx').includes('useOrderRequestsCount'), false)
  })

  test('the Orders dashboard offers no card into the retired workflow', () => {
    const cards = readCode('src/lib/orders/orderDashboard.ts')
    const hrefs = [...cards.matchAll(/href: '([^']+)'/g)].map(m => m[1])
    assert.ok(hrefs.length >= 4, 'the dashboard still offers its quick access')
    for (const href of hrefs) {
      assert.equal(href.startsWith('/orders/requests'), false, `${href} leads into the retired workflow`)
    }
  })

  test('the Admin action queue no longer asks anybody to convert one', () => {
    const queue = read('src/app/admin/control-center/action-queue/page.tsx')
    assert.equal(queue.includes('order_request_conversion'), false)
    assert.equal(queue.includes("from('order_requests')"), false)
    // What replaced it in the business: the PI review queue.
    assert.ok(queue.includes("'order_pi_review'"))
    assert.ok(queue.includes("from('order_submissions')"))
  })
})

describe('no Create Order Request action remains', () => {
  test('the whole request UI is gone — list, detail, panels, modals and shared rules', () => {
    for (const path of [
      'src/app/orders/requests/components',
      'src/app/orders/requests/components/shared.ts',
      'src/app/orders/requests/components/RequestActionModals.tsx',
      'src/app/orders/requests/components/RequestInlineEdit.tsx',
      'src/app/orders/requests/components/RequestPanels.tsx',
    ]) {
      assert.equal(existsSync(join(ROOT, path)), false, `${path} must not exist`)
    }
  })

  test('the three request API routes are gone', () => {
    // Creation, attachment editing and the delete orchestration. Every one of
    // them was reachable by POST regardless of what the sidebar offered.
    for (const path of [
      'src/app/api/orders/requests',
      'src/app/api/orders/requests/delete/route.ts',
      'src/app/api/orders/requests/attachments/edit/route.ts',
      'src/app/api/orders/requests/attachments/cleanup/route.ts',
    ]) {
      assert.equal(existsSync(join(ROOT, path)), false, `${path} must not exist`)
    }
  })

  test('the order_* notification writer is gone with the events it announced', () => {
    assert.equal(existsSync(join(ROOT, 'src/app/api/orders/notify/route.ts')), false)
    const notify = read('src/lib/notify.ts')
    assert.equal(notify.includes('export async function notifyOrders'), false)
    assert.equal(notify.includes('OrderNotifyPayload'), false)
    // The PI workflow's own notifier is untouched.
    assert.ok(notify.includes('notifyFinance'))
  })

  test('no source file calls a retired RPC', () => {
    // The strongest form of this assertion: not "the button is hidden" but
    // "nothing in the application asks for it at all".
    for (const rpc of RETIRED_RPCS) {
      const hits = sourceFilesContaining(rpc)
      assert.deepEqual(hits, [], `${rpc} is still called from ${hits.join(', ')}`)
    }
  })

  test('the Finance payment form offers no Order Request target', () => {
    const targets = read('src/app/finance/paymentTargets.ts')
    const options = targets.slice(targets.indexOf('export const PAYMENT_TARGET_OPTIONS'))
      .slice(0, 900)
    assert.equal(options.includes("value: 'order_request'"), false)
    const fields = read('src/app/finance/components/PaymentTargetFields.tsx')
    assert.equal(fields.includes("from('order_requests')"), false,
      'the target selector must not search a workflow that cannot receive money')
  })

  test('the Link modal offers Confirmed Orders and nothing else', () => {
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    const modal = view.slice(view.indexOf('function LinkOrderModal'), view.indexOf('// ── Table ─'))
    assert.equal(modal.includes("from('order_requests')"), false)
    assert.equal(modal.includes('link_finance_payment_to_order_request'), false)
    assert.ok(modal.includes('link_finance_payment_to_order'))
  })

  test('the allocation picker offers Confirmed Orders and PI Drafts only', () => {
    const modal = read('src/app/finance/received/AllocatePaymentModal.tsx')
    assert.equal(modal.includes("from('order_requests')"), false)
    assert.ok(modal.includes("from('orders')"))
    assert.ok(modal.includes("from('order_submissions')"))
    assert.ok(modal.includes('allocate_payment_to_target'))
  })
})

// ══ 2. The database refuses it, for every caller ══════════════════════════════

describe('no active API or RPC can create a new Order Request', () => {
  test('the INSERT policy is dropped, so PostgREST refuses the command outright', () => {
    assert.match(code, /drop policy if exists "order_requests_requester_insert" on public\.order_requests;/)
    // And nothing re-creates one.
    assert.equal(/create policy[^;]*on public\.order_requests[^;]*for insert/i.test(code), false)
  })

  test('a trigger refuses every INSERT, beneath the policy', () => {
    // RLS does not apply to the table owner, to service_role, or inside a
    // SECURITY DEFINER function — and finalize_order_request is exactly such a
    // function. A trigger applies to all of them.
    assert.match(code, /create trigger order_requests_refuse_new\s*\n\s*before insert on public\.order_requests/)
    const fn = functionBody('order_requests_refuse_new')
    assert.match(fn, /raise exception[\s\S]*ORDER_REQUESTS_RETIRED/)
    assert.equal(/auth\.uid\(\)/.test(fn), false,
      'the guard must read no actor: a retirement a privileged path could step around is not one')
    assert.equal(/role = 'admin'/.test(fn), false, 'and must exempt no role')
  })

  test('the apply itself fails if either layer is missing', () => {
    assert.match(sql, /the retirement guard "%" is missing or disabled/)
    assert.match(sql, /order_requests still has % INSERT-capable polic\(ies\)/)
    assert.match(sql, /row level security must remain enabled on public\.order_requests/)
  })
})

describe('no active API or RPC can convert one into an Order', () => {
  test('the request side refuses the transition into converted', () => {
    const fn = functionBody('order_requests_refuse_conversion')
    assert.match(fn, /new\.status = 'converted' and old\.status is distinct from 'converted'/)
    assert.match(fn, /ORDER_REQUESTS_RETIRED/)
    // And the id route, in case the CHECK is ever relaxed.
    assert.match(fn, /new\.converted_order_id is not null and old\.converted_order_id is null/)
  })

  test('the ORDER side refuses a new Order carrying request provenance', () => {
    // Both writes are refused, in the two places they happen: either one alone
    // would leave the other reachable.
    const fn = functionBody('orders_refuse_request_provenance')
    assert.match(fn, /new\.source_order_request_id is not null or new\.source_request_number is not null/)
    assert.match(code, /create trigger orders_refuse_request_provenance\s*\n\s*before insert on public\.orders/)
    assert.equal(/before insert or update on public\.orders/.test(code), false,
      'INSERT only — an existing Order keeps its provenance and keeps opening')
  })

  test('all ten retired RPCs are revoked from every client role, in every overload', () => {
    // BY NAME, ACROSS OVERLOADS. convert_order_request_to_order and
    // reject_order_request each have two signatures in the catalog; revoking one
    // and leaving the other is the exact gap this closes.
    for (const rpc of RETIRED_RPCS) {
      assert.ok(code.includes(`'${rpc}'`), `${rpc} must be named in the revoke loop`)
    }
    assert.match(code, /revoke execute on function %s from public, anon, authenticated/)
    assert.match(code, /where n\.nspname = 'public' and p\.proname = v_name/)
    assert.match(sql, /is still executable by a client role in % overload\(s\)/)
  })

  test('a payment can no longer be attached to an Order Request', () => {
    const fn = functionBody('finance_payment_requests_refuse_request_target')
    assert.match(fn, /new\.order_request_id is not null/)
    assert.match(fn, /tg_op = 'INSERT' or new\.order_request_id is distinct from old\.order_request_id/)
    // The trigger name sorts after derive_target, which runs first and is what
    // would otherwise classify the row.
    assert.match(code, /create trigger zz_finance_payment_requests_refuse_request_target/)
  })
})

// ══ 3. What must not have moved ═══════════════════════════════════════════════

describe('Finance Payment Requests remain unchanged', () => {
  test('the migration touches no Finance policy, table or column', () => {
    for (const forbidden of [
      /drop policy[^;]*on public\.finance_payment_requests/i,
      /alter table public\.finance_payment_requests[^;]*drop/i,
      /create policy[^;]*on public\.finance_payment_requests/i,
    ]) {
      assert.equal(forbidden.test(code), false, `the retirement must not run ${forbidden}`)
    }
  })

  test('the four doors that make the workflow work stay executable', () => {
    for (const rpc of ['approve_finance_payment_request', 'allocate_payment_to_target',
                       'reverse_payment_allocation', 'link_finance_payment_to_order']) {
      assert.ok(sql.includes(`'${rpc}'`), `${rpc} must be asserted still executable`)
      assert.equal(RETIRED_RPCS.includes(rpc), false, `${rpc} must not be revoked`)
    }
    assert.match(sql, /Finance Payment Requests must remain active: % is no longer executable/)
  })

  test('raising, verifying and correcting a payment is untouched in the product', () => {
    const page = read('src/app/finance/page.tsx')
    assert.ok(page.includes('approve_finance_payment_request'))
    assert.ok(page.includes('deriveFinanceCapabilities'))
    // The retired TARGET is gone; the workflow it sat in is not.
    assert.ok(read('src/app/finance/paymentTargets.ts').includes("'confirmed_order'"))
    assert.ok(read('src/app/finance/paymentTargets.ts').includes("'unallocated'"))
  })
})

describe('history is preserved, and stays readable', () => {
  test('nothing is deleted — no table, column, row, index or storage object', () => {
    for (const forbidden of [
      /\bdrop table\b/i, /\bdrop column\b/i, /\bdelete from\b/i, /\btruncate\b/i,
      /\bdrop index\b/i, /storage\.objects/i,
    ]) {
      assert.equal(forbidden.test(code), false, `the retirement must not run ${forbidden}`)
    }
    // And it does not rewrite a single row.
    assert.equal(/\bupdate public\./i.test(code), false, 'no row is rewritten')
  })

  test('the columns confirmed Orders depend on are asserted present at apply time', () => {
    for (const column of [
      'orders.source_order_request_id',
      'orders.source_request_number',
      'finance_payment_requests.order_request_id',
      'finance_payment_requests.order_request_number',
      'order_requests.converted_order_id',
      'order_requests.request_number',
    ]) {
      assert.ok(sql.includes(`'${column}'`), `${column} must be asserted present`)
    }
    assert.match(sql, /must not be dropped: confirmed Orders depend on it/)
  })

  test('every Order Request table keeps its SELECT policies', () => {
    for (const table of ['order_requests', 'order_request_activity', 'order_request_attachments']) {
      assert.ok(sql.includes(`'${table}'`), `${table} must be asserted still readable`)
    }
    assert.match(sql, /lost its SELECT policies; historical records must stay readable/)
  })

  test('the cleanup and unlink paths stay executable, so nothing is stranded', () => {
    // Revoking these would strand abandoned drafts and, worse, strand money on a
    // retired record with no way to move it to a real one.
    for (const rpc of ['admin_delete_order_request', 'cleanup_unfinalized_order_request',
                       'remove_unfinalized_order_request_attachment',
                       'unlink_finance_payment_from_order_request']) {
      assert.ok(sql.includes(`'${rpc}'`), `${rpc} must be asserted still executable`)
      assert.equal(RETIRED_RPCS.includes(rpc), false, `${rpc} must not be revoked`)
    }
    assert.match(sql, /retiring a workflow must not strand its data/)
  })

  test('the controlled cleanup protocol is the only way data ever goes', () => {
    assert.match(sql, /controlled test-data cleanup protocol \(20260706000000\), not\s*\n-- here/)
    // The cleanup page still drives it, and still through its own route.
    const cleanup = read('src/app/admin/control-center/test-data-cleanup/page.tsx')
    assert.ok(cleanup.includes("'/api/orders/test-data-cleanup'"))
    assert.ok(cleanup.includes('order_requests'), 'the protocol still knows about the table')
  })

  test('a historical confirmed Order still opens, and still shows where it came from', () => {
    const detail = readCode('src/app/orders/[id]/page.tsx')
    // The Order page reads its own record and never the retired workflow's RPCs.
    // Its COMMENTS still name convert_order_request_to_order, and should: that
    // function is why a historical row carries the provenance it does, and a
    // reader of the page deserves to know where the value came from.
    for (const rpc of RETIRED_RPCS) {
      assert.equal(detail.includes(rpc), false, `the Order page must not call ${rpc}`)
    }
    assert.ok(detail.includes("from('orders')"))
  })
})

// ══ 4. The retired routes still answer ════════════════════════════════════════

describe('a retired route lands somewhere sensible', () => {
  test('both routes render the notice rather than 404ing', () => {
    for (const path of ['src/app/orders/requests/page.tsx', 'src/app/orders/requests/[id]/page.tsx']) {
      assert.ok(existsSync(join(ROOT, path)), `${path} must still exist`)
      assert.ok(read(path).includes('RetiredWorkflowNotice'))
    }
  })

  test('the notice explains the retirement and offers exactly one way forward', () => {
    const notice = read('src/app/orders/requests/RetiredWorkflowNotice.tsx')
    assert.ok(notice.includes("export const OPEN_PI_DRAFTS_LABEL = 'Open PI Drafts'"))
    assert.ok(notice.includes("export const PI_DRAFTS_PATH = '/orders/drafts'"))
    assert.match(notice, /RETIRED_EXPLANATION[\s\S]{0,400}PI Draft/)
  })

  test('it writes nothing and offers no control that would restart the workflow', () => {
    const notice = read('src/app/orders/requests/RetiredWorkflowNotice.tsx')
    for (const rpc of RETIRED_RPCS) {
      assert.equal(notice.includes(rpc), false, `the notice must not call ${rpc}`)
    }
    for (const write of ['.insert(', '.update(', '.delete(', '.upsert(']) {
      assert.equal(notice.includes(write), false, `the notice must not ${write}`)
    }
  })

  test('provenance is a READ, and names nothing the reader could not already open', () => {
    const notice = read('src/app/orders/requests/RetiredWorkflowNotice.tsx')
    // Both lookups run under the reader's own RLS: the request for its
    // converted_order_id, then the Order for its number. A reader entitled to
    // neither simply gets the single action.
    assert.ok(notice.includes("from('order_requests')"))
    assert.ok(notice.includes("select('converted_order_id')"))
    assert.ok(notice.includes("from('orders')"))
    assert.ok(notice.includes('{converted && ('))
  })

  test('every Order notification still deep-links to a route that answers', () => {
    const meta = read('src/lib/notificationMeta.ts')
    // Order Request notifications were sent for months and carry a request id.
    // The href is unchanged; what changed is what the route draws.
    assert.ok(meta.includes('/orders/requests/'))
    assert.ok(existsSync(join(ROOT, 'src/app/orders/requests/[id]/page.tsx')))
  })
})

// ══ 5. Access Control no longer offers the retired actions ════════════════════

describe('Access Control no longer shows the retired options', () => {
  test('the Orders module registers neither approve nor can_be_order_assignee', () => {
    const modules = read('src/lib/permissions/modules.ts')
    const orders = modules.slice(modules.indexOf("moduleKey: 'orders'"))
      .slice(0, modules.slice(modules.indexOf("moduleKey: 'orders'")).indexOf('})'))
    assert.equal(/actionKey: 'approve'\s*,/.test(orders), false)
    assert.equal(orders.includes("actionKey: 'can_be_order_assignee'"), false)
    // The live review authority is still there.
    assert.ok(orders.includes("actionKey: 'approve_order'"))
  })

  test('the permissions screen has no label for an option it cannot offer', () => {
    const page = read('src/app/admin/control-center/permissions/page.tsx')
    assert.equal(page.includes("can_be_order_assignee: 'Be an order assignee'"), false)
  })

  test('the enforcement register no longer claims either action is enforced', () => {
    const enforcement = read('src/lib/permissions/enforcement.ts')
    const orders = enforcement.slice(enforcement.indexOf('orders: {'))
      .slice(0, enforcement.slice(enforcement.indexOf('orders: {')).indexOf('},'))
    assert.equal(orders.includes("'can_be_order_assignee'"), false)
    assert.equal(/'approve'/.test(orders), false)
    assert.ok(orders.includes("'approve_order'"))
  })
})

// ── helpers ───────────────────────────────────────────────────────────────────

/** The body of one function in the retirement migration, header to `$$;`. */
function functionBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}()`)
  assert.ok(start > 0, `public.${name} is not defined in ${MIGRATION}`)
  const end = sql.indexOf('\n$$;', start)
  assert.ok(end > start, `public.${name} has no closing dollar tag`)
  return sql.slice(start, end)
}

/**
 * Every application source file that mentions `needle`, ignoring this test and
 * the migrations (which legitimately name what they are revoking).
 */
function sourceFilesContaining(needle: string): string[] {
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) { walk(path); continue }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
      const source = readFileSync(join(ROOT, path), 'utf8')
      // A comment naming what was removed is not a call. Only an actual rpc()
      // or fetch of the name counts.
      if (new RegExp(`rpc\\(\\s*['"\`]${needle}['"\`]`).test(source)) hits.push(path)
    }
  }
  walk('src')
  return hits
}
