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
const css = read('src/components/salesLeads/leadBoard.module.css')
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
    // The board's own shape in grey (2026-11-23), not a full-screen spinner inside the shell.
    assert.ok(board.includes('if (!ready) {') && board.includes('body = <BoardBlocks />'))
  })

  test('no other list was changed', () => {
    // (The Lead Master joined the Board on 2026-11-23: see src/components/salesLeads/loadShape.test.tsx.)
    for (const file of ['src/app/orders/all/page.tsx', 'src/app/tasks/my/page.tsx']) {
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

describe('the popup, as approved on the clickable previews (owner, 2026-11-14 and 2026-11-15)', () => {
  const part = (from: string, to: string) => panel.slice(panel.indexOf(from), panel.indexOf(to))
  const strip = part('function Strip(', 'function ClientCard(')
  const card = part('function ClientCard(', '// ── Right:')
  const menu = part('function StatusMenu(', 'const plural')
  const screen = css.slice(css.indexOf('@media (min-width: 768px) {\n  .modal {'))

  test('Updates only is the first button and is on when the popup opens; All is second', () => {
    assert.ok(panel.includes('const [updatesOnly, setUpdatesOnly] = useState(true)'))
    assert.ok(panel.indexOf('onClick={() => setUpdatesOnly(true)}>Updates only</button>') < panel.indexOf('onClick={() => setUpdatesOnly(false)}>All</button>'))
  })

  test('the activity is read again in the background while it loads, and a failed load says so', () => {
    assert.ok(panel.includes('Loading the activity…') && panel.includes('The activity could not be loaded.'))
  })

  // "Neat and easy to scan" (owner, 2026-11-15), on the lines of Quotation Details: one strip, then two cards.
  test('the popup is a status strip, then the client card and the activity card', () => {
    const body = part('function PanelBody(', '/** A menu in the popup closes')
    const at = (x: string) => body.indexOf(x)
    assert.ok(at('<Strip ') > 0 && at('<Strip ') < at('<ClientCard ') && at('<ClientCard ') < at('<ActivitySide'))
    for (const label of ['Where this lead stands', 'Client', 'Activity']) assert.ok(panel.includes(`aria-label="${label}"`), label)
    assert.ok(!panel.includes('function Who(') && !panel.includes('function StateBox(') && !panel.includes('function NextStep(') && !panel.includes('function Details('), 'the old pieces are gone')
  })

  test('the strip has the next follow-up, the last update, the Board status and Hot / Warm / Cold, in that order, and no Held by', () => {
    const at = (x: string) => strip.indexOf(x)
    const cells = ['>Next follow-up</div>', '>Last update</div>', 'Board status{since', '>Temperature</div>'].map(at)
    assert.ok(cells[0] > 0 && cells[0] < cells[1] && cells[1] < cells[2] && cells[2] < cells[3], 'in that order')
    assert.ok(strip.includes('<StatusMenu ') && strip.includes('TEMPERATURES.map') && strip.includes("lastOf(lead, work.today)"))
    assert.ok(!strip.includes('Held by') && !strip.includes('telHref') && !strip.includes('openWhatsApp'), 'who and how to reach them are in the card')
    assert.ok(/\.strip \{[^}]*grid-template-columns: minmax\(0, 1\.3fr\) minmax\(0, \.9fr\) minmax\(0, 1\.3fr\) minmax\(0, 1\.15fr\)/.test(css))
  })

  test('how the follow-up stands is said in words as well as in colour, and shown with an icon', () => {
    for (const words of ['`${plural(step.days)} late`', "'Tomorrow'", "'Parked until then'", "'No follow-up date'", "'None needed'"]) assert.ok(strip.includes(words), words)
    for (const icon of ['TriangleAlert', 'Clock', 'CircleCheck', 'Ban', 'CalendarDays']) assert.ok(strip.includes(icon), icon)
    assert.ok(/\.stripLate \{ --acc: #B42332; background: #FBE9EC; \}/.test(css) && /\.stripToday \{ --acc: #C98A1E;/.test(css) && /\.stripOk \{ --acc: #276247; \}/.test(css) && /\.stripWon \{/.test(css))
    assert.ok(/\.strip \{[^}]*border-left: 3px solid var\(--acc\)/.test(css), 'the accent is on the left edge, as on Quotation Details')
  })

  test('Change date is a link with no box in the strip, at least 28px tall (40 and 44 on a phone), and opens the follow-up menu', () => {
    assert.ok(strip.includes('className={s.nLink}') && strip.includes('<ChevronDown aria-hidden="true" />') && strip.includes('<FollowUpMenu '))
    assert.ok(strip.includes("setMenu(open ? null : 'due')"))
    assert.ok(/\.nLink \{[^}]*min-height: 28px;[^}]*border: 0;[^}]*background: none;/.test(css), 'a link, 28px tall')
    assert.ok(/\.stSub \.nLink \{ min-height: 40px;/.test(css) && /\.cHead \.nLink \{ min-height: 44px;/.test(css), 'a finger-sized target on a phone')
    assert.ok(/\.nCopy \{ height: 28px;/.test(css), 'Copy is no shorter than 28px on a screen')
  })

  test('a converted or dead lead has no follow-up and says how to reopen it; somebody who can only read it has no controls', () => {
    assert.ok(strip.includes("step.kind !== 'closed'") && strip.includes('Pick a status to reopen it'))
    assert.ok(strip.includes('canWork && step.kind') && strip.includes('disabled={!canWork}'))
    assert.ok(menu.includes('disabled={!canWork}') && menu.includes('{canWork && <ChevronDown aria-hidden="true" />}'))
  })

  test('Call and WhatsApp are at the end of the number\'s row in the client card, only for somebody who can work an open lead', () => {
    assert.ok(card.includes('telHref(lead.phone)') && card.includes('work.openWhatsApp(lead)') && card.includes('className={s.nReach}'))
    assert.ok(card.indexOf('className={s.cReach}') < card.indexOf('className={s.nReach}'), 'the buttons are in the number\'s row')
    assert.ok(card.includes('const reach = canWork && !closed') && card.includes('{reach && ('), 'read-only and closed leads have no buttons')
    assert.ok(card.includes("step.kind === 'over' || step.kind === 'today' ? 'Call now' : 'Call'"))
  })

  test('the client card: name, who holds it and the market, the number with Copy, the requirement, then the facts with a label over each', () => {
    const at = (x: string) => card.indexOf(x)
    assert.ok(at('<h2 className={s.mName}>') < at('Held by') && at('Held by') < at('className={s.cReach}') && at('className={s.cReach}') < at('<div className={s.eyebrow}>Requirement</div>'))
    for (const [a, b] of [['Project value', 'Needed by'], ['Needed by', 'Location'], ['Location', 'Source'], ['Source', 'Email']]) assert.ok(at(`<dt className={s.eyebrow}>${a}</dt>`) < at(`<dt className={s.eyebrow}>${b}</dt>`), `${a} before ${b}`)
    assert.ok(card.includes('aria-label="Copy number"') && card.includes('<span className={s.cTag}>{marketLabel(lead)}{roleLabel(lead.contact_role)'))
    assert.ok(!card.includes('<dt>Phone') && !card.includes('Type of client</dt>') && !card.includes('Quantity</dt>'), 'no Phone, Type of client or Quantity row')
  })

  test('Source is in the client card and in the top bar (owner, 2026-11-15: not visible on top alone)', () => {
    assert.ok(card.includes('sourceLabel(lead.source)'))
    assert.ok(panel.includes('sourceLabel(detail.data.lead.source)'))
  })

  test('Edit details is a link with a pencil at the top of the card, with "N not set" beside it, only for somebody who can work the lead', () => {
    assert.ok(!panel.includes('nEditBtn') && !css.includes('.nEditBtn'), 'the boxed button is gone')
    assert.ok(card.includes('{!editing && canWork && <button type="button" className={s.nLink} onClick={edit}><Pencil aria-hidden="true" />Edit details</button>}'))
    assert.ok(card.indexOf('{notSet} not set') < card.indexOf('>Edit details</button>') && card.indexOf('>Edit details</button>') < card.indexOf('<h2 className={s.mName}>'))
  })

  test('Type of client and Quantity are not shown but are still in Edit details', () => {
    assert.ok(card.includes('htmlFor="fact-type">Type of client') && card.includes("text('quantity', 'Quantity')"))
  })

  test('the email is a mailto link', () => {
    assert.ok(card.includes('href={`mailto:${lead.email}`}'))
  })

  test('the requirement is written in paragraphs: a blank line is a small gap, not a whole empty line', () => {
    assert.ok(card.includes('lead.requirement.split(/\\n{2,}/)'))
    assert.ok(/\.cReq \+ \.cReq \{ margin-top: 5px; \}/.test(css) && /\.cReq \{[^}]*white-space: pre-wrap/.test(css))
  })

  test('Stuck is in the status button', () => {
    assert.ok(menu.includes('{lead.stuck && <span className={s.mStuck}>Stuck</span>}'))
  })

  test('a selected Hot / Warm / Cold is charcoal, so it never looks like the red of a late follow-up', () => {
    assert.ok(/\.stHeat button\[aria-pressed="true"\] \{ background: #303536; color: #fff;/.test(css))
  })

  // Owner, 2026-11-15, on the live popup: "hovering on the selected temperature makes the text invisible".
  test('the selected Hot / Warm / Cold keeps its charcoal under the mouse (its white words would vanish on the light hover)', () => {
    assert.ok(css.includes('.stHeat button:hover:not(:disabled):not([aria-pressed="true"]) { background: #FAF8F5; }'))
    assert.ok(!css.includes('.stHeat button:hover:not(:disabled) {'), 'no hover rule that also reaches the selected one')
  })

  test('the update box has no date of its own: the follow-up is changed at the top, and posting keeps a date still ahead', () => {
    const composer = panel.slice(panel.indexOf('function Composer('))
    assert.ok(!composer.includes('FollowUpMenu') && !composer.includes('Follow up <b>') && !composer.includes('setDue') && !composer.includes('s.mNext'))
    assert.ok(composer.includes('const due = waitingBoq ? boqFollowUp(work.today) : dueAfterUpdate(lead, work.today)') && composer.includes('nextDue: due'))
    assert.ok(panel.includes("type Menu = 'status' | 'due' | null"), 'one menu less')
    assert.ok(composer.includes('<span className={s.mKbd}>Ctrl + Enter</span>'))
    assert.ok(!css.includes('.mNext'))
  })

  test('the activity card has a count beside its heading, and its days and updates are headings and rows, not bubbles', () => {
    assert.ok(panel.includes('{!filling && <span className={s.mPill}>{detail.activities.length + detail.events.length}</span>}'))
    assert.ok(/\.mDay \{ position: sticky; top: 0;/.test(css))
    assert.ok(/\.mBubble \{ flex: 1; min-width: 0; \}/.test(css), 'no border, fill or corner on an update')
    assert.ok(/\.mEntry \{[^}]*border-bottom: 1px solid #F1EEE9;/.test(css), 'a thin line under each update')
    assert.ok(panel.includes('s.mAvCu'), 'what ClickUp brought has a grey avatar')
  })

  // Files on an update (owner, 2026-11-15): Attach files, drag and drop, paste.
  test('the update box takes files by a button, by drag and drop and by paste, and an update of only files says so', () => {
    const composer = panel.slice(panel.indexOf('function Composer('), panel.indexOf('function KindIcon('))
    assert.ok(composer.includes('accept={LEAD_FILE_ACCEPT}') && composer.includes('multiple') && composer.includes('picker.current?.click()'), 'Attach files')
    assert.ok(composer.includes('files.add(Array.from(e.dataTransfer.files))') && composer.includes('onDrop='), 'drop')
    assert.ok(composer.includes("i.kind === 'file'") && composer.includes('onPaste=') && composer.includes('e.preventDefault()'), 'paste, with no file name pasted as text')
    assert.ok(composer.includes('note: text.trim() || noteForFiles(files.ready.length)'), 'only files')
    assert.ok(composer.includes('(text.trim() !== \'\' || withFiles) && !files.uploading && !files.failed && !saving'), 'Post waits for the uploads and for a retry or a removal')
    assert.ok(composer.includes('files.finish()'), 'a saved update keeps its files')
  })

  test('each file in the box shows its state and can be tried again or removed; refusals are said in words', () => {
    const composer = panel.slice(panel.indexOf('function Composer('), panel.indexOf('function KindIcon('))
    assert.ok(composer.includes('<FileChips items={files.items} onRetry={files.retry} onRemove={files.remove} />') && composer.includes('files.refusal'))
    const chips = panel.slice(panel.indexOf('export function FileChips('), panel.indexOf('function KindIcon('))
    assert.ok(chips.includes('onRetry(f.id)') && chips.includes('onRemove(f.id)') && chips.includes('data-status={f.status}'))
    assert.ok(/\.mDrop \{[^}]*pointer-events: none;/.test(css), 'the drop veil does not catch the mouse')
    assert.ok(/@media \(prefers-reduced-motion: reduce\) \{ \.mSpin \{ animation: none; \} \}/.test(css))
  })

  test('the uploads are taken away when they are removed, and when the box goes without posting them', () => {
    const hook = read('src/components/salesLeads/useLeadFiles.ts')
    assert.ok(hook.includes('LEAD_FILES_BUCKET') && hook.includes('.upload(path, file, { contentType: type, upsert: false })'))
    assert.ok(hook.includes('bucket().remove([it.path])'), 'removing a file takes its object out')
    assert.ok(hook.includes('gone.current.has(id)') && hook.includes('void bucket().remove([path])'), 'removed while uploading: the upload takes its own object away')
    assert.ok(hook.includes("client.current.storage.from(LEAD_FILES_BUCKET).remove(paths)"), 'the cleanup when the box goes away')
    assert.ok(hook.includes('compressImageFile(original)') && hook.includes('mapWithConcurrency(fresh, ATTACHMENT_UPLOAD_CONCURRENCY'))
  })

  test('the files of an update show under its words through links signed once, only for a lead that has files', () => {
    assert.ok(panel.includes('createSignedUrls(paths, 300)') && panel.includes('enabled: paths.length > 0 && !filling'))
    assert.ok(panel.includes('{e.files.length > 0 && <FileList files={e.files} links={links} />}'))
    assert.ok(panel.includes("...e.files.map(f => f.name)"), 'a search finds a file by its name')
    const list = panel.slice(panel.indexOf('function FileList('))
    assert.ok(list.includes('canPreview(f.type)') && list.includes('target="_blank" rel="noopener noreferrer"'))
  })

  test('files go to the database only when there are some, so a plain update works before the migration is applied', () => {
    const api = read('src/lib/salesLeads/api.ts')
    assert.ok(api.includes('...(a.files && a.files.length > 0 ? { p_files: a.files } : {})'))
    assert.ok(api.includes('export type LeadFile =') && api.includes('files?: LeadFile[]'))
  })

  test('on a screen every size grows with the height of the window; a narrow window gives the strip two rows and the buttons their own row', () => {
    assert.ok(screen.includes('@media (min-width: 768px) {'), 'the screen block is there')
    for (const name of ['g', 'sp', 'padY', 'padX', 'cg', 'name', 'ctl', 'btn', 'stripY', 'fgap']) assert.ok(new RegExp(`--${name}: clamp\\(`).test(screen), `--${name} follows the height of the window`)
    assert.ok(/\.client \{ flex: 1 0 auto;/.test(css), 'the client card stretches to its column and never shrinks below its content')
    assert.ok(/@media \(min-width: 768px\) and \(max-width: 1080px\) \{\s*\.strip \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); \}/.test(css))
    assert.ok(/\.nReach \{ flex: 1 1 100%; margin-left: 0; \}/.test(css))
  })

  test('on a phone the two sides are two tabs, the strip scrolls with the client, and its cells stack', () => {
    const phone = css.slice(css.indexOf('/* The lead popup fills the screen'))
    assert.ok(phone.includes('.modal[data-tab="details"] .mBody { display: block; overflow-y: auto; }'))
    assert.ok(phone.includes('.modal[data-tab="details"] .mRight, .modal[data-tab="activity"] .strip, .modal[data-tab="activity"] .mLeft { display: none; }'))
    assert.ok(phone.includes('.mPop { width: min(300px, calc(100vw - 48px)); }'), 'the date menu stays inside the screen')
    assert.ok(/\.stCell:nth-child\(n\+3\) \{ grid-column: 1 \/ -1;/.test(css), 'status and temperature each have a row')
    assert.ok(/\.stHeat \{ height: 48px; \}/.test(css) && /\.nReach > \* \{ flex: 1; height: 46px; \}/.test(css), 'finger-sized controls')
  })
})
