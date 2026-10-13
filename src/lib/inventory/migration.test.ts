/**
 * The Inventory migration, audited against its SQL text. A text audit cannot prove behaviour (that is
 * supabase/tests/inventory_module_suite.sql, run against Postgres); it proves the SQL SAYS what the access
 * model requires, so a later edit that quietly weakens it fails in CI, which has no database.
 *
 * Run: npx tsx --test src/lib/inventory/migration.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import '../permissions/modules'
import { getRegisteredModules } from '../permissions/registry'
import { CONDITIONS, STAGES } from './constants'

const ROOT = process.cwd()
const FILE = '20270313000000_inventory_module.sql'
const sql = readFileSync(join(ROOT, 'supabase/migrations', FILE), 'utf8').replace(/\r/g, '')
const code = sql.replace(/--[^\n]*/g, '')

function functions(): { name: string; text: string; body: string }[] {
  const out: { name: string; text: string; body: string }[] = []
  const re = /create or replace function public\.(\w+)\(([\s\S]*?)\$\$([\s\S]*?)\$\$;/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) out.push({ name: m[1], text: m[0], body: m[3] })
  return out
}
const fns = functions()
const byName = (n: string) => fns.find(f => f.name === n) as { name: string; text: string; body: string }

// Functions the browser may call, and the ones that only other functions may.
const CLIENT = ['inventory_my_access', 'inventory_can_upload', 'inventory_save_item', 'inventory_delete_item', 'inventory_request_booking',
  'inventory_decide_booking', 'inventory_cancel_booking', 'inventory_bookings_list', 'inventory_item_history']
const INTERNAL = ['inventory_actor']

describe('numbering', () => {
  it('is the only migration with its number and sorts after every earlier one', () => {
    const all = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql'))
    const mine = all.filter(f => f.startsWith('20270313000000'))
    assert.deepEqual(mine, [FILE])
  })
})

describe('functions', () => {
  it('there are exactly the functions this audit knows about', () => {
    assert.deepEqual(fns.map(f => f.name).sort(), [...CLIENT, ...INTERNAL].sort())
  })
  it('every one is SECURITY DEFINER with a pinned search_path', () => {
    for (const f of fns) {
      assert.match(f.text, /security definer/i, `${f.name} must be security definer`)
      assert.match(f.text, /set search_path = public, pg_temp/i, `${f.name} must pin search_path`)
    }
  })
  it('none is callable by anon, and the internal one by nobody', () => {
    for (const n of [...CLIENT, ...INTERNAL]) {
      assert.match(code, new RegExp(`revoke all on function public\\.${n}\\([^)]*\\)\\s+from public, anon`), `${n} must revoke from public and anon`)
    }
    assert.match(code, /revoke all on function public\.inventory_actor\(\) from public, anon, authenticated/)
    assert.ok(!/grant execute on function public\.inventory_actor/.test(code))
    for (const n of CLIENT) assert.match(code, new RegExp(`grant execute on function public\\.${n}\\([^)]*\\)\\s+to authenticated`), `${n} must be granted to authenticated`)
  })
  it('every function but the actor itself starts from inventory_actor() before touching data', () => {
    for (const n of CLIENT.filter(c => c !== 'inventory_can_upload')) {
      const b = byName(n).body
      const a = b.indexOf('inventory_actor()')
      assert.ok(a > -1, `${n} must call inventory_actor()`)
      const firstTouch = b.search(/\b(insert into|update public|delete from|from public\.inventory_(?!actor))/)
      assert.ok(firstTouch === -1 || a < firstTouch, `${n} must check the caller before reading or writing`)
    }
  })
  it('each right is checked where it is needed', () => {
    assert.match(byName('inventory_save_item').body, /p_create/)
    assert.match(byName('inventory_save_item').body, /p_edit/)
    assert.match(byName('inventory_delete_item').body, /p_delete/)
    assert.match(byName('inventory_decide_booking').body, /p_approve/)
    assert.match(byName('inventory_bookings_list').body, /p_approve/)
    assert.match(byName('inventory_request_booking').body, /p_confirm_now and not a\.p_approve/)
    assert.match(byName('inventory_cancel_booking').body, /a\.p_approve or v_bk\.requested_by = a\.p_uid/)
  })
  it('every stock change happens while the product row is locked', () => {
    for (const n of ['inventory_request_booking', 'inventory_decide_booking', 'inventory_cancel_booking', 'inventory_delete_item', 'inventory_save_item']) {
      assert.match(byName(n).body, /from public\.inventory_items[^;]*for update/i, `${n} must lock the product`)
    }
  })
  it('a retry of the same tap cannot reserve twice', () => {
    assert.match(code, /request_id\s+uuid not null unique/)
    assert.match(byName('inventory_request_booking').body, /where request_id = p_request_id/)
  })
})

describe('tables', () => {
  it('clients can read but never write them', () => {
    assert.match(code, /revoke all on public\.inventory_items, public\.inventory_images, public\.inventory_bookings, public\.inventory_events\s+from anon, authenticated, public/)
    assert.match(code, /grant select on public\.inventory_items, public\.inventory_images, public\.inventory_bookings, public\.inventory_events\s+to authenticated/)
    assert.ok(!/grant (insert|update|delete|all)[^;]*public\.inventory_/i.test(code))
    assert.ok(!/create policy \w+ on public\.inventory_\w+\s+for (insert|update|delete)/i.test(code))
  })
  it('row level security is on, with the module gate on every table', () => {
    for (const t of ['inventory_items', 'inventory_images', 'inventory_bookings', 'inventory_events']) {
      assert.match(code, new RegExp(`alter table public\\.${t}\\s+enable row level security`))
      assert.match(code, new RegExp(`create policy ${t}_module_entry_gate on public\\.${t}\\s+as restrictive for all to authenticated\\s+using \\(public\\.module_entry_open\\('inventory'\\)\\)`))
    }
  })
  it('a salesperson reads only their own requests', () => {
    assert.match(code, /create policy inventory_bookings_select[\s\S]*?requested_by = auth\.uid\(\)[\s\S]*?'approve'/)
  })
  it('overselling is impossible even if a function were wrong', () => {
    assert.match(code, /constraint inventory_items_no_oversell check \(qty_sold \+ qty_reserved <= qty_total\)/)
    assert.match(code, /qty_available\s+integer generated always as \(qty_total - qty_sold - qty_reserved\) stored/)
  })
  it('the stored vocabularies are the ones the screens offer', () => {
    const list = (col: string) => [...(code.match(new RegExp(`${col}\\s+text not null check \\(${col} in \\(([^)]*)\\)`)) as RegExpMatchArray)[1].matchAll(/'(\w+)'/g)].map(m => m[1])
    assert.deepEqual(list('condition'), CONDITIONS.map(c => c.value))
    assert.deepEqual(list('stage'), STAGES.map(s => s.value))
  })
  it('a product code is unique among live products only', () => {
    assert.match(code, /create unique index inventory_items_code_live on public\.inventory_items \(product_code\) where deleted_at is null/)
  })
})

describe('Control Center registration', () => {
  it('registers the module and its five actions, default off, Admin on', () => {
    assert.match(code, /insert into public\.permission_modules[\s\S]*?'inventory'/)
    assert.match(code, /pa\.action_key in \('view', 'create', 'edit', 'delete', 'approve'\)[\s\S]*?default_allowed|select pm\.id, pa\.id, false/)
    assert.match(code, /select 'admin', mpa\.module_id, mpa\.action_id, true/)
    assert.ok(!/insert into public\.department_permissions/.test(code), 'nobody is granted anything by the migration')
  })
  it('matches src/lib/permissions/modules.ts', () => {
    const reg = getRegisteredModules().find(m => m.moduleKey === 'inventory')
    assert.ok(reg, 'inventory must be registered in modules.ts')
    assert.deepEqual(reg.actions.map(a => a.actionKey).sort(), ['approve', 'create', 'delete', 'edit', 'view'])
    assert.match(code, new RegExp(`'${(reg.description ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
  })
})

describe('pictures', () => {
  it('the bucket takes JPEG only, 3 MB, public so a customer can open the link', () => {
    assert.match(code, /values \('inventory-images', 'inventory-images', true, 3145728, array\['image\/jpeg'\]\)/)
  })
  it('an upload goes only into the caller\'s own folder and needs create or edit', () => {
    assert.match(byName('inventory_can_upload').body, /v_uid::text/)
    assert.match(byName('inventory_can_upload').body, /a\.p_create or a\.p_edit/)
    assert.match(code, /create policy inventory_images_insert on storage\.objects\s+for insert to authenticated\s+with check \(bucket_id = 'inventory-images' and public\.inventory_can_upload\(name\)\)/)
  })
  it('a saved product may only use pictures that are on the bucket and not another product\'s', () => {
    const b = byName('inventory_save_item').body
    assert.match(b, /from storage\.objects o/)
    assert.match(b, /A picture already belongs to another product/)
  })
})
