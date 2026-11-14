import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { classifySalesError, fetchBoard } from './api'

// The Lead Board and its popup were slow, and the owner uses them all day (2026-11-14). Measured on the live board: a click on a
// card took 3.4 s to show the popup (the router asked the server for the whole page again), closing it froze the page for
// ~0.7 s, and the board's own totals took 1.2 s. These pin the fixes: the address changes without the server, a card is drawn
// once, the popup opens from what the list already holds, and the totals do not carry 480 lead rows.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const board = read('src/components/salesLeads/BoardScreen.tsx')
const panel = read('src/components/salesLeads/WorkPanel.tsx')
const work = read('src/components/salesLeads/useLeadWork.tsx')
const hook = read('src/hooks/useListUrlState.ts')
const sql = read('supabase/migrations/20270716000000_sales_board_summary.sql')

describe('the totals come from the light function; the old one answers only until it is in the database', () => {
  const none = { filter: { holder: '', market: '', segment: '', temperature: '', source: '', q: '' } }
  const totals = { stats: { open: 1, value_paise: 0, overdue: 0, due_today: 0, stuck: 0 }, stages: {}, holders: [], waiting_allotment: null }
  const fake = (answers: { data: unknown; error: unknown }[]) => {
    const calls: { fn: string; args: Record<string, unknown> }[] = []
    return { calls, client: { rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return Promise.resolve(answers[Math.min(calls.length - 1, answers.length - 1)]) } } }
  }

  // The three tests are in order on purpose: the second and third change what the module remembers about the database.
  test('the summary is asked for, with the filters as they are and nothing chosen meaning everyone', async () => {
    const f = fake([{ data: totals, error: null }])
    const got = await fetchBoard(f.client as never, { ...none.filter, temperature: 'hot', q: '98765' })
    assert.deepEqual(got, totals)
    assert.deepEqual(f.calls, [{ fn: 'sales_board_summary', args: { p_holder: 'all', p_market: null, p_segment: null, p_temperature: 'hot', p_source: null, p_q: '98765' } }])
  })

  test('a refusal is a refusal: it is told to the person, and the old function is not asked instead', async () => {
    const f = fake([{ data: null, error: { message: 'SALES_FORBIDDEN', code: '42501' } }])
    await assert.rejects(() => fetchBoard(f.client as never, none.filter), (e: Error) => e.message === classifySalesError({ message: 'SALES_FORBIDDEN' }).message)
    assert.deepEqual(f.calls.map(c => c.fn), ['sales_board_summary'])
  })

  test('a database without the function falls back to sales_board, once, and then stops asking for it', async () => {
    const f = fake([
      { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.sales_board_summary(p_holder) in the schema cache' } },
      { data: totals, error: null },
    ])
    assert.deepEqual(await fetchBoard(f.client as never, none.filter), totals)
    assert.deepEqual(f.calls.map(c => c.fn), ['sales_board_summary', 'sales_board'])
    await fetchBoard(f.client as never, none.filter)
    assert.deepEqual(f.calls.map(c => c.fn), ['sales_board_summary', 'sales_board', 'sales_board'], 'no second failed call each time the board loads')
  })
})

describe('the new function', () => {
  test('is new, read-only, signed-in only, and replaces nothing', () => {
    assert.ok(sql.includes('create function public.sales_board_summary('))
    assert.ok(!/create or replace function public\.sales_board\(/.test(sql), 'sales_board stays as it is')
    assert.ok(sql.includes('security definer') && sql.includes('set search_path = public, pg_temp') && sql.includes('stable'))
    assert.ok(sql.includes('revoke all on function public.sales_board_summary(text, text, text, text, text, text) from public, anon;'))
    assert.ok(sql.includes('grant execute on function public.sales_board_summary(text, text, text, text, text, text) to authenticated;'))
    assert.ok(sql.includes('v_uid uuid := public.sales_leads_require(null);'), 'the same sign-in check as the board')
    assert.ok(!/insert into|update public|delete from|alter table|create table/i.test(sql.split('$$')[1]), 'it reads only')
  })

  test('has no lead rows, and works out "stuck" for open leads only', () => {
    const body = sql.split('$$')[1]
    assert.ok(!body.includes("'rows'") && !body.includes('sales_lead_row'), 'no lead is built')
    assert.ok(body.includes("case when l.stage in ('converted', 'dead') then false else public.sales_lead_stuck(l) end"))
  })

  test('answers what the board screen reads, and the screen no longer expects rows', () => {
    const body = sql.split('$$')[1]
    for (const key of ["'stats'", "'stages'", "'holders'", "'waiting_allotment'"]) assert.ok(body.includes(key), key)
    assert.ok(!/rows:\s*WorkLead\[\]\s*\n\s*holders/.test(read('src/lib/salesLeads/api.ts')), 'BoardData has no rows')
  })

  test('the PGlite suite loads it and checks it against sales_board for every role', () => {
    const suite = read('supabase/tests/sales_full_flow_pglite.mjs')
    assert.ok(suite.includes("'20270716000000_sales_board_summary.sql'"))
    assert.ok(suite.includes('Summary: the same totals as sales_board, key by key, for every role and several filters'))
  })
})

describe('the address changes without asking the server', () => {
  test('useListUrlState has a shallow mode that uses the browser history, and the router stays the default', () => {
    assert.ok(hook.includes('shallow?: boolean') && hook.includes('shallow = false'))
    assert.ok(hook.includes("window.history[history === 'push' ? 'pushState' : 'replaceState'](null, '', href)"))
    assert.ok(hook.includes('router[history](href, { scroll: false })'), 'every other list keeps the router')
  })

  test('the Lead Board uses it, so a filter, a tab and the open lead take effect at once', () => {
    assert.ok(board.includes('useListUrlState(LIST_PARAMS, { shallow: true })'))
    assert.ok(!board.includes('useRouter') && !board.includes('router.'), 'nothing on the board goes through the router')
  })

  test('the board and the columns are read while the permission read is still running, and drawn only when it is done', () => {
    assert.ok(!board.includes('enabled: ready') && !board.includes('enabled={ready'))
    assert.ok(board.includes('if (!ready) {') && board.includes('<LoadingScreen message="Loading the board..." />'))
  })

  test('no other list was changed', () => {
    for (const file of ['src/app/orders/all/page.tsx', 'src/app/tasks/my/page.tsx', 'src/components/salesLeads/LeadMasterScreen.tsx']) {
      assert.ok(!read(file).includes('shallow: true'), file)
    }
  })
})

describe('a card is drawn once', () => {
  const card = board.slice(board.indexOf('const Card = memo('))

  test('the card is memoized, and takes only values and handlers that stay the same between draws', () => {
    assert.ok(board.includes('const Card = memo(function Card('))
    assert.ok(board.includes('function useStable<'))
    assert.ok(board.includes('const openLead = useStable('))
    assert.ok(board.includes('const openCard = useCallback((id: string) => onOpen(stage, id, latestRows.current), [onOpen, stage])'))
    assert.ok(board.includes('const endDrag = useCallback('))
    assert.ok(board.includes('onLeadDrag={NOTHING} onLeadDragEnd={NOTHING}'), 'the closed lists do not make new functions each draw')
    assert.ok(!card.includes('work.') && !card.includes('Date.now'), 'a card reads nothing that changes on its own')
  })

  test('opening a lead hands the popup the row the card holds, so nothing waits for the network', () => {
    assert.ok(board.includes('peek: leadId =>'))
    assert.ok(panel.includes('placeholderData: stand'))
    assert.ok(panel.includes('const peeked = nav?.peek?.(leadId)'))
    assert.ok(read('src/components/salesLeads/MyDayScreen.tsx').includes('peek: id =>'))
  })

  test('the popup does not start its own permission read, and posting does not wait for the board to be read again', () => {
    assert.ok(!panel.includes('useSalesAccess') && panel.includes('work.readOnly'))
    assert.ok(work.includes('const { readOnly } = useSalesAccess()'))
    assert.ok(work.includes('void refresh()') && !work.includes('await refresh()'))
    assert.ok(panel.includes('void work.refresh()') && !panel.includes('await work.refresh()'))
  })
})

describe('the card (owner, 2026-11-14): name, number, Hot / Warm / Cold, next follow-up, and nothing to press', () => {
  const card = board.slice(board.indexOf('const Card = memo('))

  test('it shows the four things', () => {
    assert.ok(card.includes('<h3 className={`${s.name}'), 'the name')
    assert.ok(card.includes('formatPhone(lead.phone)') && card.includes('s.cardPhone'), 'the number')
    assert.ok(card.includes('<TempChip value={lead.temperature} />'), 'Hot / Warm / Cold in words')
    assert.ok(card.includes('<Due lead={lead} today={today} plain />') && card.includes('title="Next follow-up"'), 'the follow-up')
  })

  test('a lead with no name has its number as the title, so the number is not written twice', () => {
    assert.ok(card.includes('const named = title !== formatPhone(lead.phone)'))
    assert.ok(card.includes('{named && <div className={s.cardPhone}>'))
  })

  test('it has no step line, chips, flag or buttons, and dragging still moves it on a desktop', () => {
    for (const gone of ['StepLine', 'ValueChip', 'Flag', '<button', '<a ', 'onClick={stop(']) assert.ok(!card.includes(gone), gone)
    assert.ok(card.includes('draggable={canWork}'))
  })
})

describe('the popup, as approved on the clickable preview (owner, 2026-11-14)', () => {
  test('Updates only is the first button and is on when the popup opens; All is second', () => {
    assert.ok(panel.includes('const [updatesOnly, setUpdatesOnly] = useState(true)'))
    assert.ok(panel.indexOf('onClick={() => setUpdatesOnly(true)}>Updates only</button>') < panel.indexOf('onClick={() => setUpdatesOnly(false)}>All</button>'))
  })

  test('the left side is in the order who, where it stands, what they want, reference facts', () => {
    const at = (s: string) => panel.indexOf(s)
    assert.ok(at('<Who ') < at('<StateBox ') && at('<StateBox ') < at('<Details '))
    assert.ok(at('aria-label="Where this lead stands"') < at('aria-label="Requirement"') && at('aria-label="Requirement"') < at('aria-label="Client details"'))
  })

  test('the number is beside the name with Copy, and the facts do not repeat it', () => {
    assert.ok(panel.includes('className={s.nPhoneLine}') && panel.includes('aria-label="Copy number"'))
    const view = panel.slice(panel.indexOf('<section className={s.nSec} aria-label="Requirement">'))
    assert.ok(!view.includes('<dt>Phone') && !view.includes('<dt>Type of client') && !view.includes('<dt>Quantity'), 'no Phone, Type of client or Quantity row')
    assert.ok(view.includes('<dt>Location</dt>') && view.includes('<dt>Source</dt>') && view.includes('<dt>Email</dt>'))
  })

  test('Type of client and Quantity are no longer shown but are still in Edit details', () => {
    assert.ok(panel.includes('htmlFor="fact-type">Type of client') && panel.includes("text('quantity', 'Quantity')"))
  })

  test('Board status, Hot / Warm / Cold and the follow-up are in one card, with overdue said in words', () => {
    assert.ok(panel.includes('className={s.nState}') && panel.includes('className={s.nHeatSeg}') && panel.includes('className={s.nHeld}'))
    assert.ok(panel.includes('{note && <span className={s.nDueNote}>{note}</span>}'))
  })

  test('the activity is read again in the background while it loads, and a failed load says so', () => {
    assert.ok(panel.includes('Loading the activity…') && panel.includes('The activity could not be loaded.'))
  })
})
