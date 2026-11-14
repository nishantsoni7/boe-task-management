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
import { eventBy, eventLine } from './LeadBits'
import { DatesChip, DatesFields, PersonChip } from './LeadFilters'
import { DupCallout } from './LeadFields'
import { LeadTable } from './LeadTable'
import type { LeadEvent, Person, SalesLead } from '@/lib/salesLeads/api'

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

  test('a Premium lead is tagged, with what made it Premium on hover', () => {
    assert.ok(table([lead({ premium: '250 seats' })], true).includes('title="Premium: 250 seats">Premium</span>'))
    assert.ok(!table([lead({ premium: null })], true).includes('Premium'))
  })
})

describe('a lead\'s history', () => {
  const ev = (over: Partial<LeadEvent>): LeadEvent => ({ kind: 'allotted', from_name: null, to_name: 'Ashok', detail: null, actor_name: null, at: '2026-11-03T05:00:00Z', ...over })
  const line = (e: LeadEvent) => renderToStaticMarkup(<>{eventLine(e)}</>)

  test('the allotment rule says it acted by itself, and why', () => {
    const auto = ev({ detail: 'in today, 2 fresh leads' })
    assert.equal(line(auto), 'Allotted to <b>Ashok</b> automatically: in today, 2 fresh leads')
    assert.equal(eventBy(auto), 'Automatically')
    const moved = ev({ kind: 'reassigned', from_name: 'Mohit', detail: 'Premium (40 rooms) to a Senior, in today, 0 fresh leads' })
    assert.ok(line(moved).startsWith('Moved from <b>Mohit</b> to <b>Ashok</b> automatically: Premium (40 rooms)'))
    assert.equal(eventBy(moved), 'Automatically')
  })

  test('a WhatsApp chat or ad says where it came from, by itself, and an ordinary repeat is unchanged', () => {
    const chat = ev({ kind: 'added', to_name: null, detail: 'WhatsApp chat' })
    assert.equal(line(chat), 'Came in from the <b>WhatsApp chat</b>')
    assert.equal(eventBy(chat), 'Automatically')
    const ad = ev({ kind: 'enquired_again', to_name: null, detail: 'WhatsApp ad: Hotel furniture' })
    assert.equal(line(ad), 'Enquired again on the <b>WhatsApp ad: Hotel furniture</b>')
    assert.equal(eventBy(ad), 'Automatically')
    assert.equal(line(ev({ kind: 'enquired_again', to_name: null, detail: 'website form' })), 'Enquired again')
    assert.equal(line(ev({ kind: 'enquired_again', to_name: null, detail: 'whatsapp: asked for prices', actor_name: 'Asha' })), 'Enquired again')
  })

  test('a person\'s allotment names them, and one by a former colleague says so', () => {
    assert.equal(line(ev({ actor_name: 'Nishant' })), 'Allotted to <b>Ashok</b>')
    assert.equal(eventBy(ev({ actor_name: 'Nishant' })), 'Nishant')
    assert.equal(eventBy(ev({})), 'A former colleague')
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
    assert.ok(read('src/app/sales/layout.tsx').includes('<ModuleGuard moduleKey="sales" deniedRoute="/modules" checking={<SalesCheckingFrame />}>'))
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
    assert.ok(screen.includes('const when = leadWhen(state.period, days, today, searching)'))
    assert.ok(screen.includes('aria-pressed={!searching && !rangeOn && state.period === p.key}'), 'a card is lit only while no days are chosen')
    assert.ok(screen.includes('A search looks through every day.'))
  })

  test('the list is cut by what leadWhen says and by nothing else, and pressing a card drops chosen days', () => {
    const screen = read('src/components/salesLeads/LeadMasterScreen.tsx')
    assert.ok(screen.includes("queryKey: [SALES_KEY, 'list', when.period, when.from, when.to, state.holder, state.source, state.q]"), 'a new range is a new list')
    assert.ok(screen.includes('period: when.period, from: when.from, to: when.to,'))
    assert.ok(screen.includes('setState({ period: p.key, ...NO_DAYS })'))
    assert.ok(screen.includes('from: dateParam(),') && screen.includes('to: dateParam(),'), 'the days live in the URL as real dates')
  })

  test('a phone gets the dates inside the Filter sheet and, once chosen, as the first chip of the cards', () => {
    const screen = read('src/components/salesLeads/LeadMasterScreen.tsx')
    assert.ok(screen.includes("id: 'received', label: 'Received on'"))
    assert.ok(screen.includes('<DatesChip className={s.phoneHide}'), 'the desktop button is hidden on a phone')
    assert.ok(screen.includes('activeCount={(state.source ? 1 : 0) + (rangeOn ? 1 : 0)}'))
    assert.ok(screen.includes("onClearAll={() => setState({ source: '', ...NO_DAYS })}"))
    assert.ok(screen.includes('className={`fin-stat ${s.rangeChip} ${s.phoneOnly}`}'))
  })

  test('the Allotted to row is Everyone, Not allotted and one Person button, never a chip per person', () => {
    const screen = read('src/components/salesLeads/LeadMasterScreen.tsx')
    assert.ok(screen.includes('<PersonChip people={chips} holder={state.holder}'))
    assert.ok(!screen.includes('chips.map('), 'one chip per person is what filled the row')
    const css = read('src/components/salesLeads/salesLeads.module.css')
    const whoBar = /\.whoBar \{[^}]*\}/.exec(css)?.[0] ?? ''
    assert.ok(whoBar.includes('flex-wrap: wrap') && !whoBar.includes('overflow'), 'a scrolling row would clip the person panel')
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

describe('the dates button', () => {
  const TODAY = '2026-11-06'
  const chip = (days: { from: string; to: string }, active = true) =>
    renderToStaticMarkup(<DatesChip days={days} today={TODAY} active={active} onChange={() => {}} />)

  test('until days are chosen it says Custom dates, is not lit, and has nothing to clear', () => {
    const html = chip({ from: '', to: '' })
    assert.ok(html.includes('Custom dates'))
    assert.ok(html.includes('class="fin-chip"'))
    assert.match(html, /<button[^>]*disabled=""[^>]*>Clear dates<\/button>/)
  })

  test('chosen days are on the button, lit, and in the two boxes, which cannot pass today or each other', () => {
    const html = chip({ from: '2026-11-01', to: '2026-11-05' })
    assert.ok(html.includes('1 Nov – 5 Nov 2026'))
    assert.ok(html.includes('class="fin-chip is-set"'))
    const input = (label: string) => new RegExp(`<input[^>]*aria-label="${label}"[^>]*/>`).exec(html)?.[0] ?? ''
    const from = input('Received on or after'), to = input('Received on or before')
    assert.ok(from.includes('value="2026-11-01"') && from.includes('max="2026-11-05"'), from)
    assert.ok(to.includes('value="2026-11-05"') && to.includes('min="2026-11-01"') && to.includes('max="2026-11-06"'), to)
    assert.ok(!/<button[^>]*disabled=""[^>]*>Clear dates/.test(html))
  })

  test('a whole month is named, and its quick pick is pressed', () => {
    const html = chip({ from: '2026-10-01', to: '2026-10-31' })
    assert.ok(html.includes('Last month'))
    assert.match(html, /aria-pressed="true"[^>]*>Last month<\/button>/)
    assert.match(html, /aria-pressed="false"[^>]*>This month<\/button>/)
  })

  test('while a search is on the days are kept but the button is not lit (the search ignores them)', () => {
    const html = chip({ from: '2026-11-01', to: '2026-11-05' }, false)
    assert.ok(html.includes('1 Nov – 5 Nov 2026'))
    assert.ok(html.includes('class="fin-chip"') && !html.includes('is-set'))
  })

  test('the phone sheet draws the same boxes with the quick picks as pills', () => {
    const html = renderToStaticMarkup(<DatesFields variant="sheet" days={{ from: '', to: '' }} today={TODAY} onChange={() => {}} />)
    assert.ok(html.includes('orders-sheet-options') && html.includes('This month') && html.includes('Last month'))
    assert.ok(html.includes('Received on or after') && html.includes('Received on or before'))
    assert.ok(!html.includes('Quick picks'), 'the sheet already has its own heading')
  })
})

describe('the person button', () => {
  const PEOPLE_N = [
    { id: 'p1', name: 'Ashok Choudhary', n: 6 }, { id: 'p2', name: 'Dhruv', n: 0 }, { id: 'p3', name: 'Mohit Sharma', n: 7 },
  ]
  test('with nobody chosen it says Person and lists everybody with their count, a name with none faded', () => {
    const html = renderToStaticMarkup(<PersonChip people={PEOPLE_N} holder="" onPick={() => {}} />)
    assert.ok(html.includes('>Person</summary>') || html.includes('Person</summary>'))
    assert.ok(html.includes('class="fin-chip"'))
    for (const p of PEOPLE_N) assert.ok(html.includes(p.name))
    assert.equal((html.match(/personZero/g) ?? []).length, 1)
    assert.match(html, /<span class="personName">Mohit Sharma<\/span><span class="count">7<\/span>/)
  })

  test('a chosen person is on the button with their count, lit, and pressed in the list', () => {
    const html = renderToStaticMarkup(<PersonChip people={PEOPLE_N} holder="p3" onPick={() => {}} />)
    assert.ok(html.includes('class="fin-chip is-set"'))
    assert.match(html, /<summary>.*MS.*<span class="chipName">Mohit Sharma<\/span><span class="count">7<\/span><\/summary>/)
    assert.match(html, /aria-pressed="true"[^>]*><span class="fin-avatar"[^>]*>MS<\/span>/)
  })

  test('Not allotted and Everyone have their own chips: they do not light this button', () => {
    for (const holder of ['', 'none']) {
      const html = renderToStaticMarkup(<PersonChip people={PEOPLE_N} holder={holder} onPick={() => {}} />)
      assert.ok(!html.includes('is-set'), `holder "${holder}"`)
    }
  })

  test('a person the list no longer knows still lights the button instead of leaving the filter invisible', () => {
    const html = renderToStaticMarkup(<PersonChip people={PEOPLE_N} holder="gone" onPick={() => {}} />)
    assert.ok(html.includes('is-set') && html.includes('This person'))
  })

  test('nobody to choose yet says so', () => {
    assert.ok(renderToStaticMarkup(<PersonChip people={[]} holder="" onPick={() => {}} />).includes('Nobody to choose yet.'))
  })
})
