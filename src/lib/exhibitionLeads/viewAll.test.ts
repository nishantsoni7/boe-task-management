/**
 * "View All Leads" (20270309000000), audited against its SQL and the screens.
 *
 * Behaviour is proven against Postgres by supabase/tests/exhibition_leads_view_all_assertions.sql;
 * this proves the SQL SAYS what the access model requires, so a later edit that widens a holder's
 * power (a write, the export, the ranking page) fails in CI, which has no database.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')
const FILE = 'supabase/migrations/20270309000000_exhibition_leads_view_all.sql'
const sql = read(FILE)
const code = sql.replace(/--[^\n]*/g, '')

const fnNames = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]).sort()

describe('the migration', () => {
  it('re-creates exactly the read functions it names, and no write function', () => {
    assert.deepEqual(fnNames, [
      'exhibition_lead_card_readable', 'exhibition_lead_people', 'exhibition_lead_ranking', 'exhibition_lead_standings',
      'exhibition_leads_my_access', 'exhibition_leads_page', 'exhibition_leads_viewer', 'get_exhibition_lead',
    ])
    for (const write of ['create_exhibition_lead', 'update_exhibition_lead', 'reassign_exhibition_lead', 'archive_exhibition_lead',
      'restore_exhibition_lead', 'set_exhibition_lead_contact', 'export_exhibition_leads']) {
      assert.ok(!code.includes(`function public.${write}(`), `${write} is not touched`)
    }
  })

  it('grants nobody anything: no override, department or role row for view_all other than Admin', () => {
    assert.doesNotMatch(code, /insert into public\.(employee_permission_overrides|employee_permissions|department_permissions)/)
    assert.match(code, /insert into public\.role_permissions \(role, module_id, action_id, allowed\)\s+select 'admin'/)
    assert.match(code, /insert into public\.module_permission_actions[\s\S]*?select pm\.id, pa\.id, false/)
  })

  it('a holder is a non-Admin who may use the module, and the helper is closed to clients', () => {
    const f = code.slice(code.indexOf('create or replace function public.exhibition_leads_viewer'))
    assert.match(f, /u\.role <> 'admin'/)
    assert.match(f, /exhibition_leads_user_eligible\(u\.id\)/)
    assert.match(f, /resolve_permission\(u\.id, 'exhibition_leads', 'view_all'\)/)
    assert.match(code, /revoke all on function public\.exhibition_leads_viewer\(uuid\) from public, anon, authenticated;/)
  })

  it('page, get and people widen the READ gate by one line each; nothing else about them changes', () => {
    const page = code.slice(code.indexOf('function public.exhibition_leads_page'), code.indexOf('function public.get_exhibition_lead'))
    const get = code.slice(code.indexOf('function public.get_exhibition_lead'), code.indexOf('function public.exhibition_lead_people'))
    const people = code.slice(code.indexOf('function public.exhibition_lead_people'), code.indexOf('function public.exhibition_lead_ranking'))
    assert.equal(page.split('exhibition_leads_viewer(v_uid)').length - 1, 1)
    assert.equal(get.split('exhibition_leads_viewer(v_uid)').length - 1, 1)
    assert.match(people, /if not \(v_admin or public\.exhibition_leads_viewer\(v_uid\)\) then/)
  })

  it('the ranking and the leaderboard leave a holder out, even one with leads collected', () => {
    for (const name of ['exhibition_lead_ranking', 'exhibition_lead_standings']) {
      const f = code.slice(code.indexOf(`function public.${name}`))
      const block = f.slice(0, f.indexOf('$$;'))
      assert.match(block, /where not public\.exhibition_leads_viewer\(u\.id\)\s+and \(\(u\.role <> 'admin' and public\.exhibition_leads_user_eligible\(u\.id\)\)\s+or u\.id in \(select collected_by from credit\)\)/, name)
    }
  })

  it('keeps Admin-only what is Admin-only: the ranking page itself', () => {
    const f = code.slice(code.indexOf('function public.exhibition_lead_ranking'))
    assert.match(f.slice(0, f.indexOf('$$;')), /if not v_admin then\s+raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only'/)
  })

  it('the card photograph is readable by a holder, no further', () => {
    const f = code.slice(code.indexOf('function public.exhibition_lead_card_readable'))
    assert.match(f.slice(0, f.indexOf('$$;')), /v_owner = v_uid\s+or public\.exhibition_leads_viewer\(v_uid\)/)
  })

  it('checks its own grants', () => {
    const tail = code.slice(code.lastIndexOf('do $$'))
    assert.match(tail, /EXHIBITION_VIEW_ALL_ACL/)
  })
})

describe('the registry and the screens', () => {
  it('the action is registered for the module, with its words', () => {
    const modules = read('src/lib/permissions/modules.ts')
    const block = modules.slice(modules.indexOf("moduleKey: 'exhibition_leads'"))
    assert.match(block.slice(0, block.indexOf('})')), /actionKey: 'view_all'/)
    assert.match(read('src/lib/permissions/accessControlChanges.ts'), /exhibition_leads: \{ view_all:/)
    assert.match(read('src/app/api/control-center/permissions/employees/[id]/route.ts'), /exhibition_leads: \{ view_all: 'View All Leads' \}/)
  })

  it('the all-leads list opens for a holder, the export and the ranking stay Admin', () => {
    const list = read('src/components/exhibitionLeads/LeadsListScreen.tsx')
    assert.match(list, /mode === 'all' && !canViewAll\) router\.replace/)
    assert.match(list, /\{mode === 'all' && isAdmin && \(\s+<button className=\{s\.btn\} onClick=\{exportCsv\}/)
    const ranking = read('src/components/exhibitionLeads/RankingScreen.tsx')
    assert.match(ranking, /if \(!loading && !isAdmin\) router\.replace/)
  })

  it('a lead that is not yours opens read only: no form, no photo changes', () => {
    const sheet = read('src/components/exhibitionLeads/LeadDetailSheet.tsx')
    assert.match(sheet, /canEdit=\{isAdmin \|\| !meId \|\| q\.data\.lead\.owner_id === meId\}/)
    assert.match(sheet, /\{!archived && canEdit && \(\s+<form/)
    assert.match(sheet, /canEdit=\{!archived && canEdit\}/)
    assert.match(sheet, /View only\./)
  })

  it('the menu shows the all-leads item to a holder and the rest to Admin', () => {
    const layout = read('src/components/layout/ExhibitionLeadsLayout.tsx')
    assert.match(layout, /label: 'All Exhibition Leads'[^\n]*adminOnly: true, viewAll: true/)
    assert.match(layout, /isAdmin \|\| !item\.adminOnly \|\| \('viewAll' in item && item\.viewAll && canViewAll\)/)
  })

  it('the screens ask the database who they are, and if it cannot answer nobody gets more', () => {
    const q = read('src/lib/exhibitionLeads/queries.ts')
    assert.match(q, /fetchMyAccess\(supabase\)[\s\S]*?retry: false/)
    assert.match(read('src/hooks/useExhibitionLeads.ts'), /canViewAll: isAdmin \|\| access\.data\?\.view_all === true/)
  })
})
