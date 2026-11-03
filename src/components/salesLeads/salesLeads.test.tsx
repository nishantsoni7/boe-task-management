/**
 * Sales, Lead Master: what the pieces draw, and the guards on the routes.
 *
 * Run:
 *   npm run test:file -- src/components/salesLeads/salesLeads.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { AllotPicker, ConfirmChange, Holder } from './AllotParts'
import { DupCallout } from './LeadFields'
import { LeadTable } from './LeadTable'
import type { Person, SalesLead } from '@/lib/salesLeads/api'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')

const MOHIT = '00000000-0000-0000-0000-0000000000c1'
const DHRUV = '00000000-0000-0000-0000-0000000000c2'
const PEOPLE: Person[] = [{ id: MOHIT, full_name: 'Mohit' }, { id: DHRUV, full_name: 'Dhruv' }]

const lead = (over: Partial<SalesLead> = {}): SalesLead => ({
  id: 'lead-1', lead_no: 12406, received_on: '2026-11-02', phone: '+919087124455', source: 'website',
  name: 'Rohan Mehta', email: 'rohan@example.com', location: 'Jaipur', requirement: 'Six rattan chairs',
  assigned_to: null, holder_name: null, assigned_at: null, updated_at: '2026-11-02T05:50:00.123456+00:00', ...over,
})
const held = lead({ id: 'lead-2', lead_no: 12401, assigned_to: DHRUV, holder_name: 'Dhruv', assigned_at: '2026-11-02T05:50:00Z' })

const table = (rows: SalesLead[], canAssign: boolean) => renderToStaticMarkup(
  <LeadTable rows={rows} people={PEOPLE} canAssign={canAssign} today="2026-11-02" saving={{}} onOpen={() => {}} onPick={() => {}} />,
)

describe('the name dropdown in the list', () => {
  test('a lead nobody holds asks for a name; one that is held shows it', () => {
    const html = table([lead(), held], true)
    assert.ok(html.includes('Select name'))
    assert.ok(html.includes('pickEmpty'), 'the unallotted dropdown is drawn as waiting')
    assert.equal((html.match(/<select/g) ?? []).length, 2)
    assert.match(html, /<option value="[^"]+" selected="">Dhruv<\/option>/)
  })

  test('the choices are the sales candidates, by name', () => {
    const html = renderToStaticMarkup(<AllotPicker lead={lead()} people={PEOPLE} canAssign saving={undefined} onPick={() => {}} />)
    assert.ok(html.includes(`<option value="${MOHIT}">Mohit</option>`))
    assert.ok(html.includes(`<option value="${DHRUV}">Dhruv</option>`))
  })

  test('without the assign right the name is only shown: no dropdown at all', () => {
    const html = table([lead(), held], false)
    assert.ok(!html.includes('<select'))
    assert.ok(html.includes('Not allotted yet'))
    assert.ok(html.includes('Dhruv'))
  })

  test('a holder who is no longer a sales candidate still reads as themselves', () => {
    const gone = lead({ assigned_to: '00000000-0000-0000-0000-0000000000ff', holder_name: 'Former Person' })
    const html = renderToStaticMarkup(<AllotPicker lead={gone} people={PEOPLE} canAssign saving={undefined} onPick={() => {}} />)
    assert.ok(html.includes('Former Person'))
  })

  test('a change that comes from a stray key press is ignored, so only a deliberate pick allots', () => {
    const source = read('src/components/salesLeads/AllotParts.tsx')
    assert.ok(source.includes('if (isSelectNavigationKey(e)) keyAt.current = e.timeStamp'))
    assert.match(source, /if \(changeCameFromKey\(keyAt\.current, e\.timeStamp\)\) return\s+if \(busy \|\| !e\.target\.value\) return\s+onPick\(e\.target\.value\)/)
    assert.ok(!source.includes('onKeyUp'), 'no key-up to wait for: on a Mac an arrow key opens the list and its key-up never arrives')
  })

  test('while a save runs the dropdown shows the person being saved, ignores picks, and keeps keyboard focus', () => {
    const html = renderToStaticMarkup(<AllotPicker lead={lead()} people={PEOPLE} canAssign saving={MOHIT} onPick={() => {}} />)
    assert.match(html, new RegExp(`<option value="${MOHIT}" selected="">Mohit</option>`), 'the new name, not "Select name"')
    assert.ok(html.includes('aria-busy="true"'))
    assert.ok(!/<select[^>]*disabled/.test(html), 'a disabled control would drop focus to <body>')
    assert.ok(!html.includes('pickEmpty'), 'it no longer reads as waiting')
    const idle = renderToStaticMarkup(<AllotPicker lead={held} people={PEOPLE} canAssign saving={undefined} onPick={() => {}} />)
    assert.ok(idle.includes('aria-busy="false"'))
  })

  test('the number is a call link, the received day reads Today, and the lead number is shown', () => {
    const html = table([lead()], true)
    assert.ok(html.includes('href="tel:+919087124455"'))
    assert.ok(html.includes('+91 90871 24455'))
    assert.ok(html.includes('Today'))
    assert.ok(html.includes('#12406'))
  })

  test('a lead with no name says so', () => {
    assert.ok(table([lead({ name: null, email: null })], true).includes('No name'))
  })
})

describe('the confirmation when a name changes', () => {
  const html = renderToStaticMarkup(<ConfirmChange lead={held} fromName="Dhruv" toName="Mohit" saving={false} onConfirm={() => {}} onCancel={() => {}} />)

  test('it asks the question and names the lead, who holds it now and who would', () => {
    assert.ok(html.includes('Change who holds this lead?'))
    assert.ok(html.includes('Lead #12401'))
    assert.ok(html.includes('From'))
    assert.ok(html.includes('To'))
    assert.ok(html.includes('Dhruv'))
    assert.ok(html.includes('Mohit'))
    assert.ok(html.includes('Both names stay in the lead&#x27;s history.'))
  })

  test('it is a dialog with both answers on it', () => {
    assert.ok(html.includes('role="dialog"'))
    assert.ok(html.includes('aria-modal="true"'))
    assert.ok(html.includes('Keep as it is'))
    assert.ok(html.includes('Change to Mohit'))
  })

  // Server markup carries no autofocus, so the safe default is pinned in the source.
  test('the safe answer is the one that has focus, and Escape or a click outside both choose it', () => {
    const source = read('src/components/salesLeads/AllotParts.tsx')
    assert.match(source, /onClick=\{onCancel\} disabled=\{saving\} autoFocus>Keep as it is</)
    assert.ok(source.includes('useDialogFocus<HTMLDivElement>(() => { if (!saving) onCancel() })'), 'Escape cancels, and does nothing while the change is saved')
    assert.ok(source.includes('e.target === e.currentTarget'), 'a click outside cancels')
  })

  // The reviewer's finding: Escape used to close this question AND the lead panel under it.
  test('Escape, Tab and focus are handled by one shared layer, so the panel underneath never hears them', () => {
    const hook = read('src/components/salesLeads/useDialogFocus.ts')
    assert.ok(hook.includes("window.addEventListener('keydown', onKey, true)"), 'the capture phase')
    assert.ok(hook.includes('e.stopPropagation()') && hook.includes('e.preventDefault()'), 'Escape is swallowed')
    assert.ok(hook.includes('if (open[open.length - 1] !== me) return'), 'only the top layer answers')
    assert.ok(hook.includes('resolveTrapTarget('), 'Tab stays inside, with the repo\'s own trap')
    assert.ok(hook.includes('opener.focus?.()'), 'focus goes back to what opened it')
    for (const file of ['AllotParts.tsx', 'LeadPanel.tsx']) {
      assert.ok(read(`src/components/salesLeads/${file}`).includes('useDialogFocus<'), `${file} uses it`)
    }
    assert.ok(!read('src/components/salesLeads/LeadPanel.tsx').includes("document.addEventListener('keydown'"), 'the panel no longer listens on document')
  })

  test('both buttons are disabled while the change is saved', () => {
    const saving = renderToStaticMarkup(<ConfirmChange lead={held} fromName="Dhruv" toName="Mohit" saving onConfirm={() => {}} onCancel={() => {}} />)
    assert.equal((saving.match(/disabled/g) ?? []).length, 2)
    assert.ok(saving.includes('Changing…'))
  })
})

describe('the duplicate warning', () => {
  test('a lead this person may not open names the holder and the day, and offers no link', () => {
    const html = renderToStaticMarkup(<DupCallout lead={held} />)
    assert.ok(html.includes('This number is already in Lead Master'))
    assert.ok(html.includes('Lead #12401'))
    assert.ok(html.includes('2 Nov 2026'))
    assert.ok(html.includes('Allotted to'))
    assert.ok(html.includes('<b>Dhruv</b>'))
    assert.ok(!/<a [^>]*href/.test(html), 'the database sends no stage for a lead this person may not open')
    assert.ok(html.includes('Nothing was saved.'))
  })

  test('a lead this person may open links to it on the board', () => {
    const html = renderToStaticMarkup(<DupCallout lead={{ ...held, stage: 'new' } as SalesLead} />)
    assert.ok(html.includes(`href="/sales/board?lead=${held.id}"`))
  })

  test('repeat enquiry is offered only where the screen can record one', () => {
    assert.ok(!renderToStaticMarkup(<DupCallout lead={held} />).includes('repeat enquiry'))
    assert.ok(renderToStaticMarkup(<DupCallout lead={held} onRepeat={async () => {}} />).includes('Same customer: record a repeat enquiry'))
  })

  test('a lead nobody holds yet says so', () => {
    const html = renderToStaticMarkup(<DupCallout lead={lead()} />)
    assert.ok(html.includes('Not allotted yet'))
    assert.ok(html.includes('still waiting to be allotted'))
  })

  test('Holder reads Not allotted yet for nobody', () => {
    assert.ok(renderToStaticMarkup(<Holder name={null} />).includes('Not allotted yet'))
    assert.ok(renderToStaticMarkup(<Holder name="Mohit" />).includes('Mohit'))
  })
})

describe('the routes', () => {
  test('the module is guarded and a refused person goes back to Modules', () => {
    assert.ok(read('src/app/sales/layout.tsx').includes('<ModuleGuard moduleKey="sales" deniedRoute="/modules">'))
  })

  test('/sales opens My day, and the board, the list and the add page exist', () => {
    assert.ok(read('src/app/sales/page.tsx').includes("redirect('/sales/my-day')"))
    assert.ok(read('src/app/sales/my-day/page.tsx').includes('<MyDayScreen />'))
    assert.ok(read('src/app/sales/board/page.tsx').includes('<BoardScreen />'))
    assert.ok(read('src/app/sales/board/page.tsx').includes('<Suspense'), 'the filters and the open lead live in the URL')
    assert.ok(read('src/app/sales/lead-master/page.tsx').includes('<LeadMasterScreen />'))
    assert.ok(read('src/app/sales/lead-master/page.tsx').includes('<Suspense'), 'the filters live in the URL, which needs a Suspense boundary')
    assert.ok(read('src/app/sales/lead-master/new/page.tsx').includes('<AddLeadScreen />'))
  })

  test('the Add lead screen never allots: no allotment call, no name chooser', () => {
    const add = read('src/components/salesLeads/AddLeadScreen.tsx')
    assert.ok(!/allotLead|AllotPicker|assigned_to|Who gets/.test(add))
    assert.ok(add.includes('createLead('))
  })

  test('the list allots through one decision, and asks before changing a name', () => {
    const screen = read('src/components/salesLeads/LeadMasterScreen.tsx')
    assert.ok(screen.includes('allotStep(lead.assigned_to, toId)'))
    assert.ok(screen.includes("await allotLead(supabase, lead.id, toId, lead.assigned_to)"), 'the holder the screen saw goes with the change')
    assert.ok(screen.includes('<ConfirmChange'))
  })

  // The reviewer's findings on LeadMasterScreen: what a saved allotment shows, and what one lead's save may touch.
  test('a saved allotment is never shown as the old name, and one lead finishing never disturbs another', () => {
    const screen = read('src/components/salesLeads/LeadMasterScreen.tsx')
    assert.ok(screen.includes('const [saving, setSaving] = useState<Record<string, string>>({})'), 'one slot per lead, not one for the screen')
    const afterRefetch = screen.indexOf('await queryClient.invalidateQueries({ queryKey: [SALES_KEY] })')
    const clears = screen.indexOf('delete next[lead.id]')
    assert.ok(afterRefetch > 0 && clears > afterRefetch, 'the row keeps the new name until the fresh list is in')
    assert.ok(screen.includes('setPending(p => (p && p.lead.id === lead.id ? null : p))'), 'only this lead\'s own question closes')
    assert.ok(screen.includes("toast.show(e instanceof SalesRequestError ? e.message : 'Something went wrong. Nothing was changed.', true)"), 'a refusal is an alert')
  })

  test('a search looks through every day, and the period cards say they are not in use while it does', () => {
    const screen = read('src/components/salesLeads/LeadMasterScreen.tsx')
    assert.ok(screen.includes("const period: Period = searching ? 'all' : state.period"))
    assert.ok(screen.includes('aria-pressed={!searching && state.period === p.key}'))
    assert.ok(screen.includes('A search looks through every day.'))
  })

  test('an edit carries the version it started from, and Add/edit look again when a number turns out to be taken', () => {
    const panel = read('src/components/salesLeads/LeadPanel.tsx')
    assert.ok(panel.includes('updateLead(supabase, lead.id, toInput(form), lead.updated_at)'))
    assert.ok(panel.includes("e.kind === 'changed'"), 'a stale edit leaves edit mode and shows the latest version')
    assert.ok(panel.includes("queryKey: [SALES_KEY, 'phone']"))
    assert.ok(panel.includes("raced && phone.kind !== 'taken'"))
    const add = read('src/components/salesLeads/AddLeadScreen.tsx')
    assert.ok(add.includes("queryKey: [SALES_KEY, 'phone']"))
    assert.ok(add.includes("raced && phone.kind !== 'taken'"))
  })

  test('the launcher card, the layout and the pages agree on the module key', () => {
    const launcher = read('src/app/modules/page.tsx')
    assert.ok(launcher.includes("canOpenModule('sales')"))
    assert.ok(launcher.includes("description: 'Sales: the Lead Master, every lead and who holds it.'"))
    assert.ok(read('src/components/layout/SalesLayout.tsx').includes("const BASE = '/sales'"))
  })
})
