// THE ADMINISTRATOR'S PREVIEW OF A SALESPERSON'S ORDERS DASHBOARD (20270304000000).
//
// supabase/tests/admin_preview_salesperson_dashboard_assertions.sql pins the rules against a real database:
// who may ask, whom it can preview, that the answer equals the salesperson's own read, that it holds only
// that salesperson's records. These pin the other half, read as text and rendered: that the page asks for the
// preview ONLY when an administrator is in View As, that the answer is validated like the personal one, that
// the notice says whose dashboard it is, and that the migration keeps its three promises (administrators only,
// read-only, the personal function untouched).
//
// Run with: npx tsx --test "src/lib/orders/adminPreviewSalespersonDashboard.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  parseSalespersonDashboard,
  resolvePersonalRead,
  spPreviewNote,
  type SalespersonDashboard,
} from './salespersonDashboard'
import { SalespersonDashboardView } from '@/components/orders/dashboard/SalespersonDashboardView'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r/g, '')
const MIGRATION = 'supabase/migrations/20270304000000_admin_preview_salesperson_orders_dashboard.sql'
const PERSONAL = 'supabase/migrations/20270228000000_salesperson_orders_dashboard.sql'

/** The smallest valid answer: real structure, empty lists. */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicable: true, today: '2026-10-05', now: '2026-10-05T10:00:00Z', month_from: '2026-10-01',
    total_orders: 0, revenue: { amount: 0, orders: 0, no_product_value: 0, before_discount: 0 },
    pending_total: 0, pending: [], advance: [], advance_unchecked: [], fabric_finish: [],
    fabric_finish_unknown: [], ready_for_dispatch: [], ...over,
  }
}
const PREVIEW = { salesperson_id: 'd0000000-0000-4000-8000-0000000000a1', full_name: 'Asha Mehta' }

function parsed(raw: unknown): SalespersonDashboard {
  const r = parseSalespersonDashboard(raw)
  assert.ok(r.ok && r.applicable, 'expected an applicable, valid payload')
  return r.dashboard
}
const html = (d: SalespersonDashboard) => renderToStaticMarkup(createElement(SalespersonDashboardView, { data: d }))

describe('the preview answer is validated like the personal one', () => {
  test('the preview key names whose dashboard it is', () => {
    const d = parsed(payload({ preview: PREVIEW }))
    assert.deepEqual(d.preview, { salespersonId: PREVIEW.salesperson_id, fullName: 'Asha Mehta' })
  })

  test("a salesperson's OWN answer has no preview", () => {
    assert.equal(parsed(payload()).preview, undefined)
  })

  test('a preview key that cannot be read is an error, never a dashboard that does not say whose it is', () => {
    for (const bad of [{ salesperson_id: 'x' }, { full_name: 'Asha' }, 'Asha Mehta', 42, { salesperson_id: 1, full_name: 'Asha' }]) {
      assert.equal(parseSalespersonDashboard(payload({ preview: bad })).ok, false, JSON.stringify(bad))
    }
  })

  test('applicable:false with a preview key (a person with no personal dashboard) keeps the dashboard they have', () => {
    assert.deepEqual(resolvePersonalRead({ data: { applicable: false, preview: PREVIEW }, error: null }), { kind: 'other' })
  })

  test('a refusal is an error, not a quiet fallback; only a MISSING function falls back', () => {
    assert.equal(resolvePersonalRead({ data: null, error: { code: '42501', message: 'Only an administrator can preview a salesperson\'s dashboard' } }).kind, 'error')
    assert.equal(resolvePersonalRead({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.admin_preview_salesperson_orders_dashboard' } }).kind, 'other')
  })
})

describe('the notice says whose dashboard it is, and only when it is a preview', () => {
  test('it names the person, says read-only, and says the links use the administrator\'s own access', () => {
    const note = spPreviewNote('Asha Mehta')
    assert.match(note, /Asha Mehta/)
    assert.match(note, /Read-only/)
    assert.match(note, /your own access/)
    assert.ok(html(parsed(payload({ preview: PREVIEW }))).includes(note.replace(/'/g, '&#x27;')) || html(parsed(payload({ preview: PREVIEW }))).includes(note))
  })

  test('a name is escaped, never injected as markup', () => {
    const out = html(parsed(payload({ preview: { ...PREVIEW, full_name: '<img src=x onerror=alert(1)>' } })))
    assert.ok(!out.includes('<img src=x'), 'the name is text')
    assert.ok(out.includes('&lt;img'))
  })

  test('a salesperson\'s own dashboard draws no notice, and a preview draws the SAME dashboard plus the notice only', () => {
    const own = html(parsed(payload()))
    const pre = html(parsed(payload({ preview: PREVIEW })))
    assert.ok(!own.includes('data-testid="spd-preview"'))
    const stripped = pre.replace(/<p class="spd-preview"[^>]*>.*?<\/p>/, '')
    assert.equal(stripped, own, 'nothing else on the page changes')
  })
})

describe('the page asks for the preview only for an administrator in View As', () => {
  const page = read('src/app/orders/page.tsx')

  test('View As → the preview read for the viewed person; otherwise the personal read, unchanged', () => {
    assert.match(page, /viewAsUserId\s*\?\s*supabase\.rpc\('admin_preview_salesperson_orders_dashboard', \{ p_salesperson_id: viewAsUserId \}\)\s*:\s*supabase\.rpc\('salesperson_orders_dashboard'\)/)
    assert.equal((page.match(/admin_preview_salesperson_orders_dashboard/g) ?? []).length, 1, 'named once: in that one call')
  })

  test('the personal read is still made with NO argument (a salesperson can name nobody)', () => {
    assert.equal((page.match(/rpc\('salesperson_orders_dashboard'\)/g) ?? []).length, 1)
    assert.ok(!/rpc\('salesperson_orders_dashboard',/.test(page))
  })

  test('switching View As while the page is open runs the load again (the dependency of the one load effect)', () => {
    assert.match(page, /init\(\)\s*\n(\s*\/\/[^\n]*\n)+\s*\}, \[viewAsUserId\]\)/)
    assert.ok(!/viewAsSeen/.test(page), 'no second effect: one load, one dependency')
  })

  test('nothing else in the app calls the preview', () => {
    const files = ['src/app/orders/page.tsx', 'src/components/orders/dashboard/SalespersonDashboardView.tsx', 'src/lib/orders/salespersonDashboard.ts']
    for (const f of files.filter(f => f !== 'src/app/orders/page.tsx')) assert.ok(!/admin_preview_salesperson/.test(read(f)), f)
  })
})

describe('the migration keeps its three promises', () => {
  const sql = read(MIGRATION)
  const personal = read(PERSONAL)
  const body = sql.slice(sql.indexOf('create or replace function public.admin_preview'), sql.indexOf('$$;', sql.indexOf('return v_result;')) + 3)

  test('administrators only: refused with an error BEFORE any record is read', () => {
    const gate = body.indexOf("u.role = 'admin' and u.is_active")
    assert.ok(gate > 0)
    assert.match(body.slice(gate, gate + 400), /raise exception 'Only an administrator can preview[^']*(''[^']*)*' using errcode = '42501'/)
    assert.ok(gate < body.indexOf('public.orders o'), 'the gate comes before the first read of orders')
    assert.ok(gate < body.indexOf('public.order_submissions s'), 'and before the first read of submissions')
  })

  test('it is the personal dashboard for ANOTHER owner: the two ownership filters name the target, never the caller', () => {
    assert.match(body, /where o\.assigned_to = v_target/)
    assert.match(body, /where s\.salesperson_id = v_target/)
    assert.ok(!/(assigned_to|salesperson_id) = v_actor/.test(body))
    // the caller is used for exactly one thing: proving they are an administrator
    assert.equal((body.match(/v_actor/g) ?? []).length, 2, 'declared once, and used once to prove the caller is an administrator — nothing else')
  })

  test('it applies the personal dashboard\'s own eligibility test to the previewed person', () => {
    assert.match(body, /public\.is_eligible_order_assignee\(v_target\)/)
    assert.match(body, /u\.role = 'admin' or u\.team = 'operations'/)
  })

  test('read-only: STABLE, SECURITY DEFINER, a pinned search_path, and no DML anywhere', () => {
    const head = body.slice(0, body.indexOf('as $$'))
    assert.match(head, /\bstable\b/)
    assert.match(head, /security definer/)
    assert.match(head, /set search_path = public, pg_temp/)
    assert.ok(!/\b(insert into|update public\.|delete from|truncate)\b/i.test(body.replace(/--[^\n]*/g, '')), 'no write statement in the body')
  })

  test('grants: never anon or PUBLIC; authenticated may call (the function itself refuses non-administrators)', () => {
    assert.match(sql, /revoke execute on function public\.admin_preview_salesperson_orders_dashboard\(uuid\) from public, anon;/)
    assert.match(sql, /grant\s+execute on function public\.admin_preview_salesperson_orders_dashboard\(uuid\) to authenticated;/)
  })

  test('it refuses to run without the personal dashboard it previews', () => {
    assert.match(sql, /to_regprocedure\('public\.salesperson_orders_dashboard\(\)'\) is null/)
    assert.match(sql, /DEPENDENCY MISSING: 20270228000000_salesperson_orders_dashboard/)
  })

  test('the personal function is NOT touched: this migration neither re-emits nor alters it', () => {
    const code = sql.replace(/--[^\n]*/g, '')
    assert.ok(!/create or replace function public\.salesperson_orders_dashboard\b/.test(code))
    assert.ok(!/(alter|drop) function public\.salesperson_orders_dashboard/i.test(code))
    assert.ok(personal.includes('create or replace function public.salesperson_orders_dashboard()'), 'and the applied migration still defines it')
  })

  test('the body is the personal one: every list, in the same order, with only the owner and the preview key changed', () => {
    const keys = (s: string) => [...s.matchAll(/^\s+'([a-z_0-9]+)',\s/gm)].map(m => m[1])
    const personalBody = personal.slice(personal.indexOf('create or replace function public.salesperson_orders_dashboard()'), personal.indexOf('$$;', personal.indexOf('return v_result;')))
    const a = keys(personalBody), b = keys(body).filter(k => k !== 'preview')
    assert.deepEqual(b, a, 'the answer\'s keys and their order are identical')
    for (const cte of ['confirmed as materialized', 'open_orders as materialized', 'rev as', 'pending as', 'pos as materialized', 'advance as', 'ff as', 'ff_orders as', 'ready as']) {
      assert.ok(personalBody.includes(cte) && body.includes(cte), cte)
    }
  })
})
