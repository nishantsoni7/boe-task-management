// The Dashboard's Quotation Requests table (owner, 2026-11-11, option B): what an
// admin reads for each request, and what must not change around it.

import { before, test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@/lib/types'
import type { QuotationRequestsList as ListType, avatarClass as AvatarClassType, avatarLetters as AvatarLettersType } from './QuotationRequestsList'

let QuotationRequestsList: typeof ListType
let avatarClass: typeof AvatarClassType
let avatarLetters: typeof AvatarLettersType

// The runner cannot load a CSS module, so for this file each class is its own name.
before(async () => {
  const loaders = (Module as unknown as { _extensions: Record<string, (mod: { exports: unknown }) => void> })._extensions
  loaders['.css'] = mod => {
    mod.exports = { __esModule: true, default: new Proxy({}, { get: (_, name) => String(name) }) }
  }
  const mod = await import('./QuotationRequestsList')
  QuotationRequestsList = mod.QuotationRequestsList
  avatarClass = mod.avatarClass
  avatarLetters = mod.avatarLetters
})

const NOW = Date.parse('2026-11-11T05:00:00.000Z')
const DAY = 86_400_000
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')

function task(id: string, over: Record<string, unknown> = {}): Task {
  return {
    id,
    title: `Quotation request ${id}`,
    customer_name: null,
    priority: 'medium',
    created_by: 'user-shravi',
    created_at: new Date(NOW - 2 * DAY - 3_600_000).toISOString(),
    ...over,
  } as unknown as Task
}

const NAMES = { 'user-shravi': 'Shravi', 'user-prerna': 'Prerna', 'user-dinesh': 'Dinesh Reddy' }
const noop = () => {}
const render = (tasks: Task[], onOpen: (t: Task) => void = noop) =>
  renderToStaticMarkup(<QuotationRequestsList tasks={tasks} userMap={NAMES} onOpen={onOpen} now={NOW} />)

/** Every element in a rendered tree whose role is "button": the rows, without a DOM. */
function rowsOf(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = []
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (!isValidElement(n)) return
    const props = n.props as Record<string, unknown>
    if (props.role === 'button') out.push(n as ReactElement<Record<string, unknown>>)
    walk(props.children as ReactNode)
  }
  walk(node)
  return out
}

describe('the table', () => {
  test('four column headers, hidden from assistive tech because each row reads as a sentence', () => {
    const html = render([task('a')])
    const header = html.slice(html.indexOf('class="cols"'), html.indexOf('role="button"'))
    assert.ok(header.includes('aria-hidden="true"'))
    for (const label of ['Lead', 'Sales person', 'Priority', 'Pending']) assert.ok(text(header).includes(label), label)
  })

  test('a row shows the lead, who raised it, the priority word and how long it has waited', () => {
    const html = render([
      task('a', { customer_name: 'Chandrakanth Sir', priority: 'high', created_by: 'user-prerna', created_at: new Date(NOW - 9 * DAY - 2 * 3_600_000).toISOString() }),
    ])
    const row = text(html)
    assert.ok(row.includes('Chandrakanth Sir'))
    assert.ok(row.includes('Prerna'))
    assert.ok(row.includes('PR'), 'initials circle')
    assert.ok(row.includes('High'))
    assert.ok(row.includes('Pending 9 days'))
  })

  test('with no customer name the task title is the lead, as before', () => {
    assert.ok(text(render([task('a')])).includes('Quotation request a'))
  })

  test('under a day it counts hours, and the bar and colour follow the wait', () => {
    const fresh = render([task('f', { created_at: new Date(NOW - 5 * 3_600_000).toISOString() })])
    assert.ok(text(fresh).includes('5 hours'))
    assert.ok(fresh.includes('waitFresh'))
    assert.ok(render([task('g', { created_at: new Date(NOW - 3 * DAY).toISOString() })]).includes('waitAging'))
    const late = render([task('h', { created_at: new Date(NOW - 5 * DAY).toISOString() })])
    assert.ok(late.includes('waitLate'))
    assert.ok(late.includes('style="width:71%"'), 'five of seven days')
  })

  test('priority reads without colour: High has three full bars, Low one', () => {
    const full = (html: string) => (html.match(/opacity="1"/g) ?? []).length
    const faded = (html: string) => (html.match(/opacity="0.28"/g) ?? []).length
    const high = render([task('a', { priority: 'high' })])
    assert.equal(full(high), 3); assert.equal(faded(high), 0)
    const medium = render([task('a', { priority: 'medium' })])
    assert.equal(full(medium), 2); assert.equal(faded(medium), 1)
    const low = render([task('a', { priority: 'low' })])
    assert.equal(full(low), 1); assert.equal(faded(low), 2)
    assert.ok(high.includes('priHigh') && medium.includes('priMedium') && low.includes('priLow'))
  })

  test('a name or priority that is not there is a dash, never "Unknown" or a crash', () => {
    const html = render([task('a', { created_by: 'someone-else', priority: null })])
    assert.equal(text(html).includes('Unknown'), false)
    assert.equal((html.match(/—/g) ?? []).length, 2)
  })

  test('the row is one sentence for a screen reader', () => {
    const html = render([task('a', { customer_name: 'Parag Jain Sir', priority: 'high', created_at: new Date(NOW - 4 * DAY).toISOString() })])
    assert.ok(html.includes('aria-label="Parag Jain Sir, raised by Shravi, High priority, pending 4 days"'))
  })

  test('at most eight rows, in the order the page passes them', () => {
    const many = Array.from({ length: 12 }, (_, i) => task(`t${i}`, { customer_name: `Lead ${i}` }))
    const html = render(many)
    assert.equal((html.match(/role="button"/g) ?? []).length, 8)
    assert.ok(html.indexOf('Lead 0') < html.indexOf('Lead 7'))
    assert.equal(html.includes('Lead 8'), false)
  })
})

describe('opening a request', () => {
  const calls: string[] = []

  test('a click, Enter and Space open that request; another key does not', () => {
    calls.length = 0
    const rows = rowsOf(QuotationRequestsList({
      tasks: [task('first'), task('second')], userMap: NAMES, onOpen: t => calls.push(t.id), now: NOW,
    }))
    assert.equal(rows.length, 2)
    const second = rows[1].props as { onClick: () => void; onKeyDown: (e: { key: string; preventDefault: () => void }) => void; tabIndex: number }
    assert.equal(second.tabIndex, 0)
    second.onClick()
    let prevented = 0
    const key = (k: string) => second.onKeyDown({ key: k, preventDefault: () => { prevented++ } })
    key('Enter'); key(' '); key('a')
    assert.deepEqual(calls, ['second', 'second', 'second'])
    assert.equal(prevented, 2, 'Space must not scroll the page')
  })
})

describe('the little helpers', () => {
  test('initials: two letters for one name, first letters for two', () => {
    assert.equal(avatarLetters('Shravi'), 'SH')
    assert.equal(avatarLetters('Dinesh Reddy'), 'DR')
    assert.equal(avatarLetters('  prerna  '), 'PR')
    assert.equal(avatarLetters('   '), '')
  })

  test('a person keeps one of four colours', () => {
    assert.equal(avatarClass('user-prerna'), avatarClass('user-prerna'))
    const seen = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(avatarClass))
    assert.ok(seen.size >= 2 && seen.size <= 4)
    for (const c of seen) assert.match(c, /^av[0-3]$/)
  })
})

describe('what the Dashboard around it keeps', () => {
  const PAGE = read('src/app/dashboard/page.tsx')
  const CSS = read('src/app/dashboard/quotationRequests.module.css')

  test('one list on the page, the old rows are gone, and only admins get the card', () => {
    assert.equal(PAGE.split('<QuotationRequestsList').length - 1, 1)
    assert.equal(PAGE.includes('QuotationRequestsSection'), false)
    assert.ok(PAGE.includes('now={now.getTime()}'), 'the page owns the clock')
    const slot = PAGE.slice(PAGE.indexOf('{isAdmin ? ('), PAGE.indexOf('<QuotationPanel'))
    assert.match(slot, /^\{isAdmin \? \(\s*$/)
  })

  test('the panel keeps its title, count, empty state and the click that returns to the Dashboard', () => {
    assert.ok(PAGE.includes('title="Quotation Requests"'))
    assert.ok(PAGE.includes('count={tasks.length}'))
    assert.ok(PAGE.includes('headline="No active requests"'))
    assert.ok(PAGE.includes('onOpen={task => router.push(taskDetailHref(task.id, pathname))}'))
    assert.ok(PAGE.includes("onViewAll={() => router.push('/tasks/quotation-requests')}"))
  })

  test('the order is still the Dashboard rule: longest pending first, then priority', () => {
    assert.ok(PAGE.includes("const quotationTasks = tasks.filter(t => t.task_type === 'quotation_request').sort(compareByUrgency)"))
  })

  test('it folds by the width of the card, not the window: header and arrow go under 520px', () => {
    assert.match(CSS, /\.list\s*\{[^}]*container-type:\s*inline-size;/)
    const phone = CSS.slice(CSS.indexOf('@container (max-width: 519px)'))
    assert.match(phone, /\.cols\s*\{\s*display:\s*none;/)
    assert.match(phone, /\.meter,\s*\.chev\s*\{\s*display:\s*none;/)
    assert.match(phone, /\.pendingWord\s*\{\s*display:\s*inline;/)
  })

  test('only High is solid', () => {
    assert.match(CSS, /\.priHigh\s*\{\s*background:\s*#A12438;[^}]*color:\s*#FFFFFF;/)
    assert.match(CSS, /\.priMedium\s*\{\s*background:\s*#FAF0DA;/)
    assert.match(CSS, /\.priLow\s*\{\s*background:\s*#F1EEE9;/)
  })

  test('the rows hold no write: the component takes the click as a prop and calls nothing else', () => {
    const SRC = read('src/app/dashboard/QuotationRequestsList.tsx')
    for (const forbidden of ['supabase', 'fetch(', '.rpc(', '.update(', '.insert(', '.delete(']) {
      assert.equal(SRC.includes(forbidden), false, forbidden)
    }
  })
})
