/**
 * Closing an exhibition: the quick link follows it, and closing changes nobody's
 * rights over existing leads.
 *
 * Run: node node_modules/tsx/dist/cli.mjs --test src/lib/exhibitionLeads/closeExhibition.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { intakeState, showAddLeadEntry, showQuickLink } from './intake'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const noComments = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

describe('intakeState', () => {
  test('open while any exhibition is open, closed only when every one is', () => {
    assert.equal(intakeState([{ is_active: false }, { is_active: true }]), 'open')
    assert.equal(intakeState([{ is_active: false }]), 'closed')
    assert.equal(intakeState([]), 'closed')
  })
  test('no answer yet is unknown, never closed', () => {
    assert.equal(intakeState(undefined), 'unknown')
  })
  test('the quick link: hidden when closed or still loading, kept when the read failed', () => {
    assert.equal(showQuickLink('open', false), true)
    assert.equal(showQuickLink('closed', false), false)
    assert.equal(showQuickLink('unknown', false), false)
    assert.equal(showQuickLink('unknown', true), true)
  })
  test('the module navigation drops Add Lead only on a definite closed', () => {
    assert.equal(showAddLeadEntry('open'), true)
    assert.equal(showAddLeadEntry('unknown'), true)
    assert.equal(showAddLeadEntry('closed'), false)
  })
})

describe('wiring', () => {
  test('the launcher gates the quick link on module access AND an open exhibition', () => {
    const page = read('src/app/modules/page.tsx')
    assert.match(page, /const canAddExhibitionLead = canOpenExhibitionLeads\s*&& showQuickLink\(intakeState\(exhibitionsRead\.data\), exhibitionsRead\.isError\)/)
    assert.match(page, /enabled: permsReady && canOpenExhibitionLeads/)
  })
  test('the module layout hides the Add Lead item and bar when closed', () => {
    const layout = read('src/components/layout/ExhibitionLeadsLayout.tsx')
    assert.match(layout, /const showAddBar = addAllowed && /)
    assert.match(layout, /addAllowed \|\| item\.href !== `\$\{BASE\}\/add`/)
  })
  test('Close asks first; Re-open does not; only the Exhibitions screen (Admin) offers either', () => {
    const screen = read('src/components/exhibitionLeads/ExhibitionsScreen.tsx')
    assert.match(screen, /x\.is_active \? setClosing\(x\) : reopen\.mutate\(x\)/)
    assert.match(screen, /setExhibitionOpen\(supabase, closing\.id, false\)/)
    assert.match(screen, /if \(!loading && !isAdmin\) router\.replace/)
  })
})

describe('closing changes nobody\'s rights over leads', () => {
  const base = noComments(read('supabase/migrations/20270305000000_exhibition_leads.sql'))
  const fn = (name: string) => {
    const i = base.indexOf(`create or replace function public.${name}(`)
    return base.slice(i, base.indexOf('$$;', base.indexOf('$$', i + 40) + 2))
  }
  test('removing a lead is Admin only, whatever the exhibition state', () => {
    for (const name of ['archive_exhibition_lead', 'restore_exhibition_lead']) {
      const f = fn(name)
      assert.match(f, /if not v_admin then\s+raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only'/, name)
      assert.doesNotMatch(f, /is_active|exhibitions/, `${name} must not depend on the exhibition being open`)
    }
  })
  test('an owner can still edit a lead after the exhibition closes', () => {
    const f = fn('update_exhibition_lead')
    assert.match(f, /v_admin or v_old\.owner_id = v_uid/)
    assert.doesNotMatch(f, /is_active/)
  })
  test('the lead sheet offers archive and restore to Admin only', () => {
    const sheet = read('src/components/exhibitionLeads/LeadDetailSheet.tsx')
    const adminBlock = sheet.slice(sheet.indexOf('{isAdmin && ('))
    assert.ok(adminBlock.includes('Archive (invalid, test or duplicate)'))
    assert.equal((sheet.match(/archiveLead\(/g) ?? []).length, 1)
  })
})

describe('20270312 migration', () => {
  const sql = read('supabase/migrations/20270312000000_exhibition_close_reopen.sql')
  const code = noComments(sql)
  test('set_exhibition_open is Admin only, signed-in only, and deletes nothing', () => {
    const f = code.slice(code.indexOf('create or replace function public.set_exhibition_open'), code.indexOf('revoke all on function public.set_exhibition_open'))
    assert.match(f, /if not v_admin then\s+raise exception 'EXHIBITION_LEADS_FORBIDDEN: Admin only'/)
    assert.match(f, /security definer/)
    assert.doesNotMatch(f, /\bdelete\b/i)
    assert.match(code, /revoke all on function public\.set_exhibition_open\(uuid, boolean\) from public, anon;/)
    assert.match(code, /grant execute on function public\.set_exhibition_open\(uuid, boolean\) to authenticated;/)
  })
  test('the stamp trigger covers every path that flips is_active, and is not client-callable', () => {
    assert.match(code, /before insert or update of is_active on public\.exhibitions/)
    assert.match(code, /revoke all on function public\.exhibitions_stamp_closed\(\) from public, anon, authenticated;/)
  })
  test('closed_at exists exactly when the exhibition is closed', () => {
    assert.match(code, /check \(is_active = \(closed_at is null\)\)/)
  })
  test('it drops nothing and re-issues only the admin list', () => {
    assert.doesNotMatch(code, /drop (table|column|function|policy)|delete from|truncate/i)
    assert.equal((code.match(/create or replace function public\.list_exhibitions_admin/g) ?? []).length, 1)
  })
})
