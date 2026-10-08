/**
 * The migration, audited against its SQL text.
 *
 * A text audit cannot prove behaviour — supabase/tests/exhibition_leads_assertions.sql
 * and run_exhibition_leads_race_local.sh do that against Postgres. What this
 * proves is that the SQL SAYS what the access model requires, so a later edit
 * that quietly weakens it fails in CI, which has no database.
 *
 * Run: npx tsx --test src/lib/exhibitionLeads/migration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const FILE = '20270305000000_exhibition_leads.sql'
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')
const sql = read(`supabase/migrations/${FILE}`)
const code = sql.replace(/--[^\n]*/g, '') // comments stripped

function functions(): { name: string; header: string; body: string }[] {
  const out: { name: string; header: string; body: string }[] = []
  const re = /create (?:or replace )?function public\.(\w+)\(([\s\S]*?)\$\$([\s\S]*?)\$\$;/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) out.push({ name: m[1], header: m[0].slice(0, m[0].indexOf('$$')), body: m[3] })
  return out
}

describe('numbering', () => {
  test('sorts after every other migration and is unique', () => {
    const all = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
    assert.equal(all[all.length - 1], FILE, 'the newest migration in the tree')
    assert.equal(all.filter(f => f.startsWith(FILE.slice(0, 14))).length, 1, 'no other migration shares the timestamp')
  })
})

describe('registration mirrors the registry', () => {
  const registry = read('src/lib/permissions/modules.ts')
  test('the same name and description in code and SQL', () => {
    const desc = 'Capture visitors at an exhibition and follow them up afterwards.'
    assert.ok(registry.includes(`moduleKey: 'exhibition_leads'`) && registry.includes(desc))
    assert.ok(sql.includes(`'exhibition_leads', 'Exhibition Leads'`))
    assert.equal(sql.split(desc).length - 1, 2, 'app_modules and permission_modules carry it verbatim')
  })
  test('admin by role, Sales by an ordinary department rule, nobody else', () => {
    assert.match(code, /insert into public\.role_permissions[\s\S]*?'admin'/)
    assert.match(code, /insert into public\.department_permissions[\s\S]*department_key = 'sales'/)
    assert.doesNotMatch(code, /insert into public\.employee_permission_overrides/)
  })
  test('the module is engine-gated and declared enforced', () => {
    assert.match(read('src/lib/permissions/moduleVisibility.ts'), /'exhibition_leads'/)
    assert.match(read('src/lib/permissions/enforcement.ts'), /exhibition_leads:\s*\{\s*state: 'enforced'/)
  })
})

describe('tables are read-only to the browser', () => {
  test('RLS on, writes revoked, only select granted', () => {
    for (const t of ['exhibitions', 'exhibition_leads', 'exhibition_lead_events']) {
      assert.match(code, new RegExp(`alter table public\\.${t}\\s+enable row level security`))
    }
    assert.match(code, /revoke all on public\.exhibitions, public\.exhibition_leads, public\.exhibition_lead_events\s+from anon, authenticated, public/)
    assert.match(code, /grant select on public\.exhibitions, public\.exhibition_leads, public\.exhibition_lead_events\s+to authenticated/)
    assert.doesNotMatch(code, /grant (insert|update|delete|all)[^;]*exhibition_/)
  })
  test('every table carries the restrictive module gate', () => {
    for (const t of ['exhibitions', 'exhibition_leads', 'exhibition_lead_events']) {
      assert.match(code, new RegExp(`create policy ${t}_module_entry_gate on public\\.${t}\\s+as restrictive for all to authenticated\\s+using \\(public\\.module_entry_open\\('exhibition_leads'\\)\\)`))
    }
  })
  test('a salesperson reads only what they own; Admin reads all', () => {
    assert.match(code, /create policy exhibition_leads_select[\s\S]*?owner_id = auth\.uid\(\)[\s\S]*?u\.role = 'admin'/)
  })
  test('collector, exhibition, creation time and submission id are immutable; owner moves only through reassign', () => {
    const g = functions().find(f => f.name === 'exhibition_leads_guard_immutable')!
    for (const c of ['collected_by', 'exhibition_id', 'created_at', 'submission_id']) assert.ok(g.body.includes(`new.${c}`), c)
    assert.ok(g.body.includes("exhibition_leads.reassigning"))
    const reassign = functions().find(f => f.name === 'reassign_exhibition_lead')!
    assert.ok(reassign.body.includes("set_config('exhibition_leads.reassigning', 'on', true)"), 'transaction-local switch')
  })
  test('the activity trail is append-only', () => {
    assert.match(code, /before update or delete on public\.exhibition_lead_events/)
  })
  test('one ACTIVE lead per number per exhibition, enforced by an index', () => {
    assert.match(code, /create unique index exhibition_leads_one_active_phone\s+on public\.exhibition_leads \(exhibition_id, phone_e164\)\s+where archived_at is null/)
    assert.match(code, /submission_id\s+uuid not null unique/)
  })
})

describe('every function', () => {
  const fns = functions()
  const definers = fns.filter(f => /security definer/.test(f.header))
  const browser = ['exhibition_leads_page', 'get_exhibition_lead', 'exhibition_lead_people', 'exhibition_lead_ranking',
    'export_exhibition_leads', 'create_exhibition_lead', 'update_exhibition_lead', 'reassign_exhibition_lead',
    'archive_exhibition_lead', 'restore_exhibition_lead']

  test('the module defines the functions it should', () => {
    for (const n of browser) assert.ok(fns.some(f => f.name === n), n)
  })
  test('every definer pins search_path with pg_temp last', () => {
    assert.ok(definers.length >= browser.length)
    for (const f of definers) assert.match(f.header, /set search_path = public, pg_temp\s*$/m, f.name)
  })
  test('the actor is auth.uid(), never a parameter', () => {
    for (const f of fns) assert.doesNotMatch(f.header, /\bp_(user|actor|owner_id|collector)[a-z_]*\b/, `${f.name} takes no identity`)
    for (const n of browser) {
      const f = fns.find(x => x.name === n)!
      assert.ok(f.body.includes('exhibition_leads_actor()'), `${n} resolves the caller through the module check`)
    }
  })
  test('admin-only doors check admin inside', () => {
    for (const n of ['exhibition_lead_people', 'exhibition_lead_ranking', 'export_exhibition_leads', 'reassign_exhibition_lead', 'archive_exhibition_lead', 'restore_exhibition_lead']) {
      const f = fns.find(x => x.name === n)!
      assert.ok(/not v_admin/.test(f.body) && f.body.includes('Admin only'), n)
    }
  })
  test('ownership is checked inside the owner-facing doors', () => {
    for (const n of ['get_exhibition_lead', 'update_exhibition_lead']) {
      assert.match(fns.find(x => x.name === n)!.body, /v_admin or v_(old|lead)\.owner_id = v_uid/, n)
    }
    assert.match(fns.find(x => x.name === 'exhibition_leads_filtered')!.header + fns.find(x => x.name === 'exhibition_leads_filtered')!.body, /not p_is_admin or/)
  })
  test('browser doors are granted to authenticated only; helpers to nobody', () => {
    for (const n of browser) {
      assert.match(code, new RegExp(`revoke all on function public\\.${n}\\([^)]*\\) from public, anon;\\s*grant execute on function public\\.${n}\\([^)]*\\) to authenticated;`), n)
    }
    for (const n of ['exhibition_leads_user_eligible', 'exhibition_leads_actor', 'exhibition_leads_filtered', 'exhibition_lead_json', 'exhibition_leads_text_array', 'exhibition_leads_guard_immutable', 'exhibition_lead_events_append_only']) {
      assert.match(code, new RegExp(`revoke all on function public\\.${n}\\([^)]*\\) from public, anon, authenticated;`), n)
    }
    assert.doesNotMatch(code, /grant execute on function[^;]*to (public|anon)/)
    assert.doesNotMatch(code, /grant[^;]*to service_role/, 'no service credential path')
  })
  test('module access is the engine, not a team name', () => {
    const e = fns.find(f => f.name === 'exhibition_leads_user_eligible')!
    assert.ok(e.body.includes("resolve_permission(u.id, 'exhibition_leads', 'view')"))
    assert.ok(!/team\s*=/.test(e.body), 'no hard-coded department')
  })
  test('every write records an event with the actor', () => {
    for (const [fn, ev] of [['create_exhibition_lead', 'created'], ['update_exhibition_lead', 'details_edited'], ['update_exhibition_lead', 'status_changed'],
      ['update_exhibition_lead', 'follow_up_changed'], ['update_exhibition_lead', "'note'"], ['reassign_exhibition_lead', 'reassigned'],
      ['archive_exhibition_lead', 'archived'], ['restore_exhibition_lead', 'restored']]) {
      assert.ok(fns.find(f => f.name === fn)!.body.includes(ev), `${fn} → ${ev}`)
    }
  })
  test('no phone number is ever written into an event', () => {
    const inserts = code.match(/insert into public\.exhibition_lead_events[\s\S]*?;/g) ?? []
    assert.ok(inserts.length >= 8)
    for (const i of inserts) assert.doesNotMatch(i, /phone/i)
  })
})

describe('days are India days', () => {
  test('no UTC date arithmetic on created_at', () => {
    assert.doesNotMatch(code, /created_at::date/)
    assert.doesNotMatch(code, /current_date/)
    assert.ok((code.match(/Asia\/Kolkata/g) ?? []).length >= 10)
  })
})

describe('the migration checks itself', () => {
  test('ends with executed self-checks that raise', () => {
    const tail = code.slice(code.lastIndexOf('do $$'))
    assert.match(tail, /raise exception 'EXHIBITION_LEADS_ACL/)
    assert.match(tail, /raise exception 'EXHIBITION_LEADS_PHONE/)
  })
})
