/**
 * The builder's top panel, version 2 (owner, 25 Nov 2026): a Status row, the Lead row, the Senior row and the Share row, drawn for real from their
 * props, one state at a time. Nothing in the panel changes a status any more: Confirm → PI draft, the amber "what is missing" row, Confirmed no PI,
 * Mark as lost, Archive, the Lost box and Reopen are gone (a PI draft is made in Lead Management; Reopen sits in the builder's lock notice).
 * With a lead the Status row is the lead's stage (leadCard.dom.test.tsx); here the database answers nothing, so it shows the quotation's own.
 * The ⋯ menu is driven in statusMore.dom.test.tsx.
 *
 * Run: npm run test:file -- src/components/quotations/topRow.test.tsx
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { waitsFor } from './TopPanel'
import { panel, quote, type PanelOver } from './topPanel.testkit'
import type { QuotationStatus } from '@/lib/quotations/api'

const ALL: QuotationStatus[] = ['draft', 'sent', 'negotiating', 'confirmed', 'lost', 'archived']
const names = (n: number) => Array.from({ length: n }, (_, i) => `Chair ${i + 1}`)
const draw = (base: ReturnType<typeof quote>, o: PanelOver = {}) => renderToStaticMarkup(panel(base, o))
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}[^<]*</button>`))?.[0] ?? null
/** One row of the panel, by its group name. */
const row = (html: string, name: string) => {
  const at = html.indexOf(`aria-label="${name}"`)
  const next = html.indexOf('role="group"', at + 1)
  return at < 0 ? '' : html.slice(at, next < 0 ? undefined : next)
}

describe('the Status row: with no lead to follow, the quotation\'s own status, read only', () => {
  test('every status shows as its pill, with how to follow the lead\'s status instead; there is no button in the row', () => {
    for (const status of ALL) {
      const st = row(draw(quote({ status })), 'Status')
      assert.ok(st.includes(`pill st_${status}`), status)
      assert.match(st, /Link a lead to follow its status here\./, status)
      assert.ok(!st.includes('<button') && !st.includes('Open in Lead Management'), status)
    }
  })
  test('the Status row comes first and the Share row last; the quotation\'s pill is no longer in the Share row', () => {
    const html = draw(quote({ status: 'lost' }))
    assert.ok(html.indexOf('aria-label="Status"') < html.indexOf('aria-label="Share"'))
    assert.ok(!row(html, 'Share').includes('pill st_'))
  })
  test('with no lead information there is no Lead row (it needs the database\'s answer)', () => {
    assert.ok(!draw(quote()).includes('aria-label="Lead"'))
  })
})

describe('nothing in the panel changes a status any more', () => {
  test('no Confirm → PI draft, no Confirmed no PI, Mark as lost, Archive, Lost box or Reopen, whatever the status and whoever looks', () => {
    for (const status of ALL) {
      for (const may_edit of [true, false]) {
        const html = draw(quote({ status, may_edit }))
        for (const w of ['Confirm → PI', 'Confirmed, no PI', 'Mark as lost', 'Mark lost', 'Archive<', 'Why was it lost', 'Reopen', 'Mark sent', '<ol', '<select'])
          assert.ok(!html.includes(w), `${status} ${may_edit}: ${w}`)
      }
    }
  })
  test('no amber "what is missing" row: the panel is not told what a PI would need', () => {
    const html = draw(quote({ status: 'sent' }))
    assert.ok(!html.includes('before this can become a PI') && !html.includes('hintBody') && !html.includes('Show which'))
  })
  test('the "what Orders still needs" line is still exported from the panel, worded for one product, for none, and for several things at once', () => {
    assert.equal(waitsFor([{ code: 'NAME_MISSING', lines: ['Line 3'] }]), '1 product needs a name before this can become a PI.')
    assert.equal(waitsFor([{ code: 'NO_LINES', lines: [] }]), 'Add at least one product that is not optional.')
    assert.equal(waitsFor([{ code: 'PRICE_MISSING', lines: names(2) }, { code: 'PICTURE_MISSING', lines: names(1) }]), '2 things to fix before this can become a PI.')
  })
})

describe('the Share row: what can be done', () => {
  test('a PI draft made from the quotation shows its reference and state beside Open the PI draft (the main button); none, none', () => {
    const html = draw(quote({ status: 'confirmed', pi: { id: 'p1', draft_reference: 'DR-1042', status: 'under_review' } as never }))
    const share = row(html, 'Share')
    assert.match(share, /PI draft <b>DR-1042<\/b> · under review/)
    assert.match(share, /<a class="btn btnPrimary pnext" href="[^"]*p1[^"]*">/)
    assert.match(share, /Open the PI draft/)
    for (const status of ALL) assert.ok(!draw(quote({ status })).includes('PI draft'), status)
  })
  test('unsaved edits switch the downloads and the client link off with "Save first", and say so once, beside the buttons', () => {
    const html = draw(quote({ status: 'sent' }), { dirty: true })
    for (const w of ['Download PDF', 'Download Excel', 'Create client link']) {
      assert.match(button(html, w) ?? '', /disabled="" title="Save first"|title="Save first"[^>]*disabled=""|disabled=""[^>]*title="Save first"/, w)
    }
    assert.equal((html.match(/<span class="dirty">Save first<\/span>/g) ?? []).length, 1)
    // the items of the ⋯ menu wait too: statusMore.dom.test.tsx
  })
  test('a reader who may not edit sees the downloads and nothing that changes the quotation: no client link to create, no ⋯ menu', () => {
    const html = draw(quote({ status: 'sent', may_edit: false }))
    assert.ok(html.includes('Download PDF') && html.includes('Download Excel'))
    assert.ok(!html.includes('Create client link') && !html.includes('aria-label="More actions"') && !html.includes('Save first'))
  })
  test('no ⋯ button when there is nothing to put in it (no client link and no Delete)', () => {
    for (const status of ALL) assert.ok(!draw(quote({ status })).includes('aria-label="More actions"'), status)
    assert.ok(draw(quote({ share_token: 'abc' })).includes('aria-label="More actions"'))
    assert.ok(draw(quote(), { canDelete: true, onDelete: () => {} }).includes('aria-label="More actions"'))
  })
})

describe('the Share row: sharing', () => {
  test('before a link: the two downloads and Create client link (an outline button, not the main one), whose tooltip says what it does', () => {
    const html = draw(quote())
    assert.ok(html.includes('Download PDF') && html.includes('Download Excel'))
    assert.ok(!html.includes('Copy link') && !html.includes('WhatsApp') && !html.includes('id="q-link"'))
    const create = button(html, 'Create client link') ?? ''
    assert.ok(create && !create.includes('btnPrimary'))
    assert.match(create, /title="One link with the pictures and a Save as PDF button; no login\. Turning it on marks a draft as Sent\."/)
  })
  test('with a link: Copy link and WhatsApp (to the number) replace Create client link, and the link is no longer a box on the page', () => {
    const html = draw(quote({ share_token: 'abc' }))
    assert.ok(button(html, 'Copy link') && !html.includes('Create client link') && !html.includes('id="q-link"'))
    assert.match(html, /<a class="btn" href="https:\/\/wa\.me\/[^"]*"[^>]*title="WhatsApp opens with the text ready for 98290 12345; you press send\./)
    assert.match(draw(quote({ share_token: 'abc' }), { copied: true }), /Copied/)
  })
  test('unsaved edits: the downloads and WhatsApp wait; no products, or an archived quotation: no link yet', () => {
    const html = draw(quote({ share_token: 'abc' }), { dirty: true })
    assert.match(button(html, 'Download PDF') ?? '', /disabled/); assert.match(button(html, 'Download Excel') ?? '', /disabled/)
    assert.match(button(html, 'WhatsApp') ?? '', /disabled/)
    assert.match(button(draw(quote(), { lineCount: 0 }), 'Create client link') ?? '', /disabled/)
    assert.match(button(draw(quote({ status: 'archived' })), 'Create client link') ?? '', /disabled/)
  })
  test('a price the database still calls blocked no longer holds the link back (the approval is not drawn)', () => {
    assert.doesNotMatch(button(draw(quote({ price: { blocked: true } as never })), 'Create client link') ?? '', /disabled/)
  })
  test('the logo switch: one switch, on unless it was turned off, for people who may edit', () => {
    const on = draw(quote(), { onMark: () => {}, markOn: true })
    assert.match(on, /<input type="checkbox" role="switch" id="q-mark" checked=""/)
    assert.match(on, /Logo on pictures/)
    assert.doesNotMatch(draw(quote(), { onMark: () => {}, markOn: false }), /id="q-mark" checked/)
    assert.match(draw(quote({ may_edit: false }), { onMark: () => {}, markOn: true }), /id="q-mark" disabled="" checked=""/)
    assert.ok(!draw(quote()).includes('q-mark'), 'no switch without a handler')
  })
})

describe('Reopen moved to the builder\'s lock notice', () => {
  const page = readFileSync('src/components/quotations/BuilderScreen.tsx', 'utf8').replace(/\r/g, '')
  const notice = page.slice(page.indexOf('{base.may_edit && LOCKED.includes(base.status) && ('), page.indexOf('{briefing &&'))
  test('a locked quotation (confirmed, lost or archived) that the person may edit says it cannot be changed, and Reopen moves it to Negotiating', () => {
    assert.ok(notice.length > 0, 'the lock notice is on the page')
    assert.match(notice, /This quotation is \{STATUS_LABEL\[base\.status\]\.toLowerCase\(\)\} and cannot be changed\./)
    assert.match(notice, /onClick=\{\(\) => moveTo\('negotiating'\)\}>Reopen<\/button>/)
  })
  test('lost and archived reopen for anyone who may edit; a confirmed quotation only for an administrator, and anyone else is told so', () => {
    assert.match(notice, /\{\(base\.status !== 'confirmed' \|\| access\.admin\) && <button/)
    assert.match(notice, /base\.status === 'confirmed' && !access\.admin \? ' Only an administrator can reopen it\.' : ''/)
  })
})
