import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  HIGHLIGHT_REMARK_COLUMN,
  HIGHLIGHT_REMARK_MAX,
  HIGHLIGHT_REMARK_RPC,
  ORDER_HIGHLIGHT_LABEL,
  highlightRemarkProblem,
  highlightRemarkSaveFailure,
  normalizeHighlightRemark,
  readHighlightRemark,
} from './highlightRemark'
import { OrderHighlightRemarkBanner, PiHighlightRemarkView } from '@/components/orders/PiHighlightRemark'

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const MIGRATION = 'supabase/migrations/20270210000000_order_submission_highlight_remark.sql'
const DRAFT_PAGE = 'src/app/orders/drafts/[submissionId]/page.tsx'
const ORDER_PAGE = 'src/app/orders/[id]/page.tsx'
const noop = () => {}

const view = (over: Partial<Parameters<typeof PiHighlightRemarkView>[0]> = {}) => renderToStaticMarkup(
  <PiHighlightRemarkView
    remark={null} canEdit draft="" onDraftChange={noop} onSave={noop}
    saving={false} failure={null} saved={false} {...over}
  />,
)

describe('the remark, as the RPC will store it', () => {
  test('trimmed, and blank is none', () => {
    assert.equal(normalizeHighlightRemark('  Client visits on the 12th  '), 'Client visits on the 12th')
    assert.equal(normalizeHighlightRemark('   '), null)
    assert.equal(normalizeHighlightRemark(null), null)
  })

  test('the database’s own limit, said before the RPC has to', () => {
    assert.equal(highlightRemarkProblem('x'.repeat(HIGHLIGHT_REMARK_MAX)), null)
    assert.match(highlightRemarkProblem('x'.repeat(HIGHLIGHT_REMARK_MAX + 1)) ?? '', /1,000 characters/)
    assert.equal(highlightRemarkProblem(`  ${'x'.repeat(HIGHLIGHT_REMARK_MAX)}  `), null, 'surrounding space is not counted')
  })

  test('a read that failed, found no row, or found no column is simply "none"', () => {
    assert.equal(readHighlightRemark(null), null)
    assert.equal(readHighlightRemark({}), null)
    assert.equal(readHighlightRemark({ [HIGHLIGHT_REMARK_COLUMN]: 42 }), null)
    assert.equal(readHighlightRemark({ [HIGHLIGHT_REMARK_COLUMN]: '  Rush  ' }), 'Rush')
  })

  test('a refusal is the RPC’s sentence, without its machine code', () => {
    assert.equal(
      highlightRemarkSaveFailure({ code: '42501', message: 'ORDER_SUBMISSION_NOT_EDITABLE: the highlight remark can be changed only while the PI is a draft or returned for changes' }),
      'the highlight remark can be changed only while the PI is a draft or returned for changes')
    assert.match(highlightRemarkSaveFailure({ message: 'Failed to fetch' }), /connection/)
    assert.equal(highlightRemarkSaveFailure(null), 'The highlight could not be saved.')
  })
})

describe('the PI draft’s highlight field', () => {
  test('optional, internal, and labelled so', () => {
    const html = view()
    assert.match(html, /Order highlight/)
    assert.match(html, />Optional</)
    assert.match(html, /Internal/)
    assert.match(html, /never printed on the client PI, PDF or messages/)
    assert.match(html, /<textarea[^>]*id="pi-highlight-remark"/)
    assert.match(html, /<label for="pi-highlight-remark"/, 'the label names the field')
  })

  test('inside Supporting details it does not repeat the card’s "Optional"', () => {
    const html = view({ bare: true })
    assert.doesNotMatch(html, />Optional</)
    assert.match(html, /Order highlight/)
    assert.match(html, /Internal/)
  })

  test('Save is offered only for a real change', () => {
    assert.match(view({ remark: 'Rush', draft: 'Rush' }), /<button[^>]*disabled=""[^>]*>Save highlight</)
    assert.doesNotMatch(view({ remark: 'Rush', draft: 'Rush — exhibition stock' }), /disabled=""[^>]*>Save highlight</)
    assert.doesNotMatch(view({ remark: 'Rush', draft: '' }), /disabled=""[^>]*>Save highlight</, 'clearing it is a change too')
  })

  test('too long: said, and Save refused', () => {
    const html = view({ draft: 'x'.repeat(HIGHLIGHT_REMARK_MAX + 1) })
    assert.match(html, /role="alert"[^>]*>Keep the highlight to 1,000 characters/)
    assert.match(html, /disabled=""[^>]*>Save highlight</)
  })

  test('a viewer who may not edit reads it as text, or sees nothing when there is none', () => {
    const readOnly = view({ canEdit: false, remark: 'Client visits the factory on the 12th' })
    assert.doesNotMatch(readOnly, /<textarea|<button/)
    assert.match(readOnly, /Client visits the factory on the 12th/)
    assert.equal(view({ canEdit: false, remark: null }), '', 'no labelled hole')
  })

  test('saved, and a refusal, are each said once', () => {
    assert.match(view({ remark: 'Rush', draft: 'Rush', saved: true }), /role="status"[^>]*>Saved</)
    assert.match(view({ remark: 'Rush', draft: 'Rush!', failure: 'No.' }), /role="alert"[^>]*>No\.</)
  })
})

describe('the Confirmed Order’s banner', () => {
  test('labelled as an internal highlight, kept as typed', () => {
    const html = renderToStaticMarkup(<OrderHighlightRemarkBanner remark={'Rush\nExhibition stock'} />)
    assert.match(html, new RegExp(`aria-label="${ORDER_HIGHLIGHT_LABEL}"`))
    assert.match(html, />Internal highlight</)
    assert.match(html, /BOE only/)
    assert.match(html, /white-space:pre-wrap/)
    assert.match(html, /Rush\nExhibition stock/)
  })

  test('nothing is drawn when there is no remark', () => {
    assert.equal(renderToStaticMarkup(<OrderHighlightRemarkBanner remark={null} />), '')
  })
})

describe('where the remark is read and written', () => {
  test('the draft page offers it exactly where can_edit_order_submission does, and re-reads after a save', () => {
    const page = read(DRAFT_PAGE)
    assert.ok(page.includes('canEditHighlight={canEditSubmission}'), 'the page hands the section the RPC-backed answer')
    const section = read('src/components/orders/PiSupportingDetails.tsx')
    assert.match(section, /<PiHighlightRemark\s+supabase=\{supabase\}\s+submissionId=\{submissionId\}\s+canEdit=\{canEditHighlight && !locked\}\s+rowVersion=\{rowVersion\}\s+onSaved=\{\(\) => \{ void onSaved\(\) \}\}/, 'and never offers Save once locked')
  })

  test('the Confirmed Order reads it from its own PI row, near the top', () => {
    const page = read(ORDER_PAGE)
    assert.match(page, /<OrderHighlightRemark\s+supabase=\{supabase\}\s+submissionId=\{order\.source_order_submission_id \?\? null\}/)
    assert.ok(page.indexOf('<OrderHighlightRemark') > page.indexOf('</header>'), 'under the Order number and status')
    assert.ok(page.indexOf('<OrderHighlightRemark') < page.indexOf('<OrderSummaryPanel'), 'above everything else')
  })

  test('neither page adds the column to its main read, so an unapplied migration cannot break either', () => {
    for (const file of ['src/lib/orders/draftsView.ts', 'src/lib/orders/orderPiHandoff.ts', DRAFT_PAGE, ORDER_PAGE]) {
      assert.ok(!read(file).includes(HIGHLIGHT_REMARK_COLUMN), `${file} must not select it directly`)
    }
    const component = read('src/components/orders/PiHighlightRemark.tsx')
    assert.match(component, /\.select\(HIGHLIGHT_REMARK_COLUMN\)/, 'its own one-column read')
    assert.match(component, /error \|\| !data \? \{ kind: 'unavailable' \}/, 'and a failure hides it rather than breaking the page')
    assert.match(component, new RegExp(`supabase\\.rpc\\(HIGHLIGHT_REMARK_RPC`))
    assert.equal(HIGHLIGHT_REMARK_RPC, 'set_order_submission_highlight_remark')
  })

  test('NO CLIENT DOCUMENT READS IT: the column is named in one module, used by one component', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) files.push(path.replace(/\\/g, '/'))
      }
    }
    walk('src')
    const naming = files.filter(f => read(f).includes(HIGHLIGHT_REMARK_COLUMN) || read(f).includes('order_highlight_remark'))
    assert.deepEqual(naming, ['src/lib/orders/highlightRemark.ts'])
    const importing = files.filter(f => /from '@\/lib\/orders\/highlightRemark'/.test(read(f)))
    assert.deepEqual(importing, ['src/components/orders/PiHighlightRemark.tsx'])
    // The PDFs, the confirmed Excel and the PI preview in particular.
    for (const doc of ['src/lib/orders/confirmedPdf.ts', 'src/lib/pi/previewView.ts', 'src/components/orders/piPreview.tsx']) {
      assert.ok(!/order_highlight|HighlightRemark|highlightRemark/.test(read(doc)), `${doc} never prints the highlight`)
    }
  })
})

describe('the migration', () => {
  const sql = read(MIGRATION)

  test('additive: one nullable, length-checked column and one RPC', () => {
    assert.match(sql, /alter table public\.order_submissions\s+add column if not exists order_highlight_remark text;/)
    assert.match(sql, /check \(order_highlight_remark is null or char_length\(order_highlight_remark\) between 1 and 1000\)/)
    assert.ok(!/drop (table|column|function)/i.test(sql.replace(/drop constraint if exists order_submissions_highlight_remark_len/, '')))
    assert.ok(!/create or replace function public\.(?!set_order_submission_highlight_remark\b)/.test(sql), 'no existing function is replaced')
    assert.ok(!/create policy|alter policy|drop policy/i.test(sql), 'no policy changes who reads the row')
    assert.equal(HIGHLIGHT_REMARK_MAX, 1000, 'the browser’s limit is the database’s')
  })

  test('the writer is the owner-or-admin, draft-or-returned door, with the pg_temp search_path', () => {
    assert.match(sql, /security definer\s+set search_path = public, pg_temp/)
    assert.match(sql, /if not public\.can_edit_order_submission\(p_submission_id\) then/)
    assert.match(sql, /for update;/, 'under a row lock')
    assert.match(sql, /v_sub\.row_version is distinct from p_expected_version/, 'refusing a stale version')
    assert.match(sql, /row_version            = row_version \+ 1/)
    assert.match(sql, /revoke all    on function public\.set_order_submission_highlight_remark\(uuid, text, integer\) from public, anon;/)
    assert.match(sql, /grant  execute on function public\.set_order_submission_highlight_remark\(uuid, text, integer\) to authenticated;/)
  })

  test('the activity entry says THAT it changed, never what it says, under an existing action', () => {
    const log = sql.slice(sql.indexOf('perform public.log_order_submission_activity('))
    const call = log.slice(0, log.indexOf(');') + 2)
    assert.match(call, /'internal_details_updated'/, 'no new action, so the action constraint is untouched')
    assert.match(call, /'highlight_remark_changed', true/)
    assert.ok(!call.includes('v_remark') && !call.includes('p_remark'), 'the text itself is not logged')
    assert.ok(!/order_submission_activity_action_check/.test(sql))
  })

  test('its file name says it reshapes order_submissions, and it sorts after production’s newest', () => {
    assert.match(MIGRATION, /_order_submission_/)
    // Production's newest applied migration since 2026-09-28 is #241's 20270205120000.
    // #248's two come first after it, in this order; later migrations (e.g. #249's
    // 20270211120000) may follow without breaking this pin.
    const later = readdirSync('supabase/migrations').filter(f => f.slice(0, 14) > '20270205120000').sort()
    assert.deepEqual(later.slice(0, 2), [
      '20270210000000_order_submission_highlight_remark.sql',
      '20270211000000_order_submission_sales_order_details.sql',
    ])
  })
})
