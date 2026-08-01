/**
 * URL-backed list state — parsing and serialisation rules.
 *
 * These are the rules every task list page now depends on and none of them can
 * show on its own:
 *   * an unusable param falls back to the page default instead of crashing or
 *     filtering the list down to nothing,
 *   * a default value is never written, so an untouched list has a clean URL,
 *   * params the page does not own survive every filter change,
 *   * changing a filter returns to page 1, changing the page does not, and
 *   * parse(serialize(x)) === x, which is what makes Back/Forward restore the
 *     exact view that was left.
 *
 * Run:
 *   npx tsx --test src/lib/listState.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  enumParam, optionalEnumParam, optionParam, textParam, idParam, pageParam, enumListParam,
  parseListState, buildListSearch, clearListSearch,
  type ListState,
} from './listState'

const TABS = ['all', 'in_progress', 'overdue'] as const
type Tab = typeof TABS[number]

const UUID_A = '2f9a1c4e-1b6d-4a7c-9d3e-8f5b0c2a6e11'
const UUID_B = '7c1d5b30-9e42-4f18-88aa-3b6e5d0f9c22'

const PRIORITIES = ['high', 'medium', 'low'] as const

const SPECS = {
  tab:      enumParam(TABS, 'all'),
  assignee: idParam(),
  priority: optionParam(PRIORITIES),
  q:        textParam(),
  page:     pageParam(),
}

// ── Codecs ────────────────────────────────────────────────────────────────────

describe('enumParam', () => {
  const tab = enumParam(TABS, 'all')

  test('accepts a member of the set', () => {
    assert.equal(tab.parse('in_progress'), 'in_progress')
  })

  test('an unsupported tab falls back to the default', () => {
    assert.equal(tab.parse('does_not_exist'), 'all')
    assert.equal(tab.parse(''), 'all')
    assert.equal(tab.parse('<script>alert(1)</script>'), 'all')
  })

  test('a missing param is the default', () => {
    assert.equal(tab.parse(null), 'all')
  })

  test('the default is never written to the URL', () => {
    assert.equal(tab.serialize('all'), null)
    assert.equal(tab.serialize('overdue'), 'overdue')
  })

  test('a value outside the set is never written either', () => {
    assert.equal(tab.serialize('nonsense' as Tab), null)
  })
})

describe('optionalEnumParam', () => {
  const tab = optionalEnumParam(TABS)

  test('no param means no tab selected', () => {
    assert.equal(tab.parse(null), null)
    assert.equal(tab.parse('bogus'), null)
  })

  test('round-trips a real member', () => {
    assert.equal(tab.parse('overdue'), 'overdue')
    assert.equal(tab.serialize('overdue'), 'overdue')
    assert.equal(tab.serialize(null), null)
  })
})

describe('optionParam', () => {
  const priority = optionParam(PRIORITIES)

  test('no selection is the default and is not written', () => {
    assert.equal(priority.parse(null), '')
    assert.equal(priority.serialize(''), null)
  })

  test('an unsupported priority reads as All rather than filtering to nothing', () => {
    assert.equal(priority.parse('urgent'), '')
    assert.equal(priority.serialize('urgent' as 'high'), null)
  })

  test('round-trips a real priority', () => {
    assert.equal(priority.parse('high'), 'high')
    assert.equal(priority.serialize('high'), 'high')
  })
})

describe('textParam', () => {
  const q = textParam()

  test('reads the value verbatim, including a trailing space being typed', () => {
    assert.equal(q.parse('repair '), 'repair ')
  })

  test('an empty or whitespace-only query removes the param', () => {
    assert.equal(q.serialize(''), null)
    assert.equal(q.serialize('   '), null)
  })

  test('writes trimmed', () => {
    assert.equal(q.serialize('  repair  '), 'repair')
  })

  test('spaces and special characters survive a URL round-trip', () => {
    const value = 'sofa & chair 50% #2'
    const params = new URLSearchParams()
    params.set('q', q.serialize(value)!)
    assert.equal(q.parse(new URLSearchParams(params.toString()).get('q')), value)
  })
})

describe('idParam', () => {
  const assignee = idParam()

  test('accepts a UUID and normalises its case', () => {
    assert.equal(assignee.parse(UUID_A.toUpperCase()), UUID_A)
  })

  test('an invalid employee id is ignored rather than applied', () => {
    assert.equal(assignee.parse('aditya'), '')
    assert.equal(assignee.parse('123'), '')
    assert.equal(assignee.parse(''), '')
    assert.equal(assignee.parse(null), '')
  })

  test('only a UUID is ever written', () => {
    assert.equal(assignee.serialize(UUID_A), UUID_A)
    assert.equal(assignee.serialize(''), null)
    assert.equal(assignee.serialize('aditya'), null)
  })
})

describe('pageParam', () => {
  const page = pageParam()

  test('reads a page number', () => {
    assert.equal(page.parse('2'), 2)
    assert.equal(page.parse('37'), 37)
  })

  test('junk, zero and negatives fall back to page 1', () => {
    assert.equal(page.parse('abc'), 1)
    assert.equal(page.parse('0'), 1)
    assert.equal(page.parse('-3'), 1)
    assert.equal(page.parse(null), 1)
  })

  test('page 1 is the default and is not written', () => {
    assert.equal(page.serialize(1), null)
    assert.equal(page.serialize(0), null)
    assert.equal(page.serialize(2), '2')
  })
})

describe('enumListParam', () => {
  const status = enumListParam(['pending', 'working', 'completed'] as const)

  test('reads a comma-separated subset', () => {
    assert.deepEqual(status.parse('pending,working'), ['pending', 'working'])
  })

  test('tolerates spacing and drops unknown and duplicate members', () => {
    assert.deepEqual(status.parse(' pending , nonsense ,pending,completed'), ['pending', 'completed'])
  })

  test('no param, or nothing usable in it, means no status filter', () => {
    assert.deepEqual(status.parse(null), [])
    assert.deepEqual(status.parse(',,'), [])
    assert.equal(status.serialize([]), null)
  })

  test('writes the cleaned list', () => {
    assert.equal(status.serialize(['working', 'pending']), 'working,pending')
  })
})

// ── parseListState ────────────────────────────────────────────────────────────

describe('parseListState', () => {
  test('reads a fully specified list URL', () => {
    const params = new URLSearchParams(`tab=in_progress&assignee=${UUID_A}&priority=high&q=repair&page=2`)
    assert.deepEqual(parseListState(SPECS, params), {
      tab: 'in_progress', assignee: UUID_A, priority: 'high', q: 'repair', page: 2,
    })
  })

  test('an empty URL is the page default', () => {
    assert.deepEqual(parseListState(SPECS, new URLSearchParams('')), {
      tab: 'all', assignee: '', priority: '', q: '', page: 1,
    })
  })

  test('a URL where every value is invalid still renders the default view', () => {
    const params = new URLSearchParams('tab=nope&assignee=aditya&priority=urgent&page=-1')
    assert.deepEqual(parseListState(SPECS, params), {
      tab: 'all', assignee: '', priority: '', q: '', page: 1,
    })
  })
})

// ── buildListSearch ───────────────────────────────────────────────────────────

describe('buildListSearch', () => {
  test('sets a value and leaves the rest alone', () => {
    const next = buildListSearch(SPECS, 'tab=overdue&q=repair', { priority: 'high' })
    assert.deepEqual(parseListState(SPECS, new URLSearchParams(next)), {
      tab: 'overdue', assignee: '', priority: 'high', q: 'repair', page: 1,
    })
  })

  test('returning a filter to its default removes the param', () => {
    const next = buildListSearch(SPECS, 'tab=overdue&priority=high', { priority: '' })
    assert.equal(next, 'tab=overdue')
  })

  test('clearing everything leaves an empty query string', () => {
    const next = buildListSearch(SPECS, 'tab=overdue&q=repair', { tab: 'all', q: '' })
    assert.equal(next, '')
  })

  test('params the page does not own are preserved', () => {
    const next = buildListSearch(SPECS, 'from=notification&tab=overdue', { q: 'repair' })
    const params = new URLSearchParams(next)
    assert.equal(params.get('from'), 'notification')
    assert.equal(params.get('tab'), 'overdue')
    assert.equal(params.get('q'), 'repair')
  })

  test('a filter change resets the page', () => {
    const next = buildListSearch(SPECS, 'page=4&tab=overdue', { priority: 'high' }, { pageKey: 'page' })
    assert.equal(new URLSearchParams(next).get('page'), null)
  })

  test('a page change does not reset the page', () => {
    const next = buildListSearch(SPECS, 'tab=overdue&page=2', { page: 3 }, { pageKey: 'page' })
    assert.equal(new URLSearchParams(next).get('page'), '3')
  })

  test('a patch touching both the page and a filter keeps the requested page', () => {
    const next = buildListSearch(SPECS, 'page=4', { q: 'repair', page: 2 }, { pageKey: 'page' })
    assert.equal(new URLSearchParams(next).get('page'), '2')
  })

  test('an empty patch changes nothing, page included', () => {
    assert.equal(buildListSearch(SPECS, 'page=4&tab=overdue', {}, { pageKey: 'page' }), 'page=4&tab=overdue')
  })

  test('undefined values in a patch are skipped, not written', () => {
    const next = buildListSearch(SPECS, 'tab=overdue', { tab: undefined, q: 'repair' })
    assert.equal(new URLSearchParams(next).get('tab'), 'overdue')
  })

  test('an undeclared key is ignored', () => {
    const next = buildListSearch(SPECS, '', { nonsense: 'x' } as never)
    assert.equal(next, '')
  })

  test('accepts URLSearchParams as the current query', () => {
    const next = buildListSearch(SPECS, new URLSearchParams('tab=overdue'), { q: 'repair' })
    assert.equal(new URLSearchParams(next).get('tab'), 'overdue')
  })
})

// ── clearListSearch ───────────────────────────────────────────────────────────

describe('clearListSearch', () => {
  test('drops every owned param and keeps the others', () => {
    const next = clearListSearch(SPECS, `from=notification&tab=overdue&assignee=${UUID_A}&q=repair&page=3`)
    assert.equal(next, 'from=notification')
  })
})

// ── Normalisation terminates ──────────────────────────────────────────────────
// Two places rewrite the URL rather than merely ignoring a bad value: dropping
// an assignee who matches nobody, and clamping a page past the end of the list.
// Both must reach a fixed point in one write, or the replace would loop.

describe('normalisation reaches a fixed point in one write', () => {
  test('dropping an unknown assignee leaves nothing for a second pass to drop', () => {
    const written = buildListSearch(SPECS, `tab=overdue&assignee=${UUID_A}`, { assignee: '' })
    const after   = parseListState(SPECS, new URLSearchParams(written))
    // The page's drop condition is `value && !known.includes(value)`; an empty
    // value makes it false, so the effect cannot fire again.
    assert.equal(after.assignee, '')
    assert.equal(buildListSearch(SPECS, written, { assignee: after.assignee }), written)
  })

  test('clamping a page to the last real one is idempotent', () => {
    const written = buildListSearch(SPECS, 'page=999&tab=overdue', { page: 3 }, { pageKey: 'page' })
    const after   = parseListState(SPECS, new URLSearchParams(written))
    assert.equal(after.page, 3)
    assert.equal(buildListSearch(SPECS, written, { page: after.page }, { pageKey: 'page' }), written)
  })

  test('clamping to page 1 removes the param instead of writing page=1 forever', () => {
    const written = buildListSearch(SPECS, 'page=999', { page: 1 }, { pageKey: 'page' })
    assert.equal(written, '')
    assert.equal(parseListState(SPECS, new URLSearchParams(written)).page, 1)
  })
})

// ── Round-trip ────────────────────────────────────────────────────────────────

describe('round-trip', () => {
  test('every state survives serialise → parse unchanged', () => {
    const states: ListState<typeof SPECS>[] = [
      { tab: 'all',         assignee: '',     priority: '',     q: '',             page: 1 },
      { tab: 'in_progress', assignee: UUID_A, priority: 'high', q: 'repair',       page: 2 },
      { tab: 'overdue',     assignee: UUID_B, priority: 'low',  q: 'sofa & chair', page: 12 },
    ]
    for (const state of states) {
      const search = buildListSearch(SPECS, '', state)
      assert.deepEqual(parseListState(SPECS, new URLSearchParams(search)), state)
    }
  })
})
