/**
 * Payroll dashboard row controls — rendering contract.
 *
 * What a row is allowed to put in front of an admin: one labelled action, icon
 * buttons for the rest, and an icon rather than a paragraph in the Attention
 * column. These are the assertions that stop the cell from filling back up with
 * warning text and the row from growing a fourth full-width button.
 *
 * The components are hook-free on purpose, so each one can be called as a plain
 * function to check that a control is wired to the handler it claims — not only
 * that it renders.
 *
 * Run:
 *   npx tsx --test src/app/payroll/PayrollRowActions.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PayrollAttentionIndicator,
  PayrollAttentionModal,
  PayrollRowActionBar,
  type PayrollRowActionBarProps,
} from './PayrollRowActions'
import {
  payrollAttention,
  PAYROLL_ATTENTION_ARIA_LABEL,
} from '@/lib/payroll/periodActions'
import type { PeriodStatus } from '@/lib/payroll/correctionRules'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Text a person actually reads — markup stripped, attributes gone with it. */
const visibleText = (html: string) =>
  html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

/** Every element in a rendered tree, so buttons can be inspected and invoked. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = node as ReactElement<any>
  return [el, ...elements(el.props?.children)]
}

const spies = () => {
  const calls: string[] = []
  return {
    calls,
    handlers: {
      onGenerate:    () => calls.push('generate'),
      onLock:        () => calls.push('lock'),
      onUnlock:      () => calls.push('unlock'),
      onViewResults: () => calls.push('view'),
    },
  }
}

const bar = (status: PeriodStatus, over: Partial<PayrollRowActionBarProps> = {}) => {
  const props: PayrollRowActionBarProps = {
    status, isBusy: false, ...spies().handlers, ...over,
  }
  return renderToStaticMarkup(<PayrollRowActionBar {...props} />)
}

/** The <button> elements a row renders, without going through the DOM. */
const buttonsOf = (status: PeriodStatus, over: Partial<PayrollRowActionBarProps> = {}) => {
  const props: PayrollRowActionBarProps = {
    status, isBusy: false, ...spies().handlers, ...over,
  }
  return elements(PayrollRowActionBar(props)).filter(e => e.type === 'button')
}

// ── Row actions ───────────────────────────────────────────────────────────────

describe('payroll row actions', () => {
  test('View Payroll stays a visible text action', () => {
    for (const status of ['generated', 'locked'] as const) {
      assert.match(visibleText(bar(status)), /View Payroll/, status)
    }
  })

  test('a draft row still leads with the labelled Generate Payroll', () => {
    assert.match(visibleText(bar('draft')), /Generate Payroll/)
  })

  test('a locked row shows Unlock as its only secondary action, as an icon', () => {
    const html = bar('locked')
    // Present as an accessible name…
    assert.match(html, /aria-label="Unlock Payroll"/)
    // …absent as reading matter in the cell.
    assert.doesNotMatch(visibleText(html), /Unlock Payroll/)
    // A locked row carries no Lock or Regenerate control at all, not even disabled.
    assert.doesNotMatch(html, /aria-label="Lock Payroll"/)
    assert.doesNotMatch(html, /aria-label="Regenerate Payroll"/)
    assert.equal(buttonsOf('locked').length, 2)
  })

  test('a generated row shows Regenerate and Lock as icons', () => {
    const html = bar('generated')
    assert.match(html, /aria-label="Regenerate Payroll"/)
    assert.match(html, /aria-label="Lock Payroll"/)
    assert.doesNotMatch(visibleText(html), /Regenerate Payroll/)
    assert.doesNotMatch(visibleText(html), /Lock Payroll/)
  })

  test('no full-text Regenerate, Lock or Unlock button remains in any row', () => {
    for (const status of ['draft', 'generated', 'locked'] as const) {
      const text = visibleText(bar(status))
      assert.doesNotMatch(text, /Regenerate Payroll/, status)
      assert.doesNotMatch(text, /Lock Payroll/,       status)
      assert.doesNotMatch(text, /Unlock Payroll/,     status)
    }
  })

  test('every icon button carries an accessible name and a tooltip', () => {
    for (const status of ['draft', 'generated', 'locked'] as const) {
      for (const b of buttonsOf(status)) {
        const label = b.props['aria-label'] as string | undefined
        const title = b.props.title as string | undefined
        assert.ok(title, `${status}: every control needs a tooltip`)
        // A control with no readable text must announce itself some other way.
        const hasText = typeof b.props.children === 'object'
          ? visibleText(renderToStaticMarkup(b)).length > 0
          : true
        if (!hasText) assert.ok(label, `${status}: an icon-only control needs an aria-label`)
        if (label) assert.equal(label, title, `${status}: name and tooltip must agree`)
      }
    }
  })

  test('the icon buttons are the 34px design-system control, not a new one', () => {
    const html = bar('generated')
    const iconButtons = html.match(/boe-record-action boe-record-action--icon/g) ?? []
    assert.equal(iconButtons.length, 2)
  })

  test('the actions cell is a single non-wrapping row', () => {
    assert.match(bar('generated'), /class="boe-payroll-actions"/)
  })

  test('each control calls the handler it is named after', () => {
    const s = spies()
    const press = (status: PeriodStatus, label: string) => {
      const found = elements(PayrollRowActionBar({ status, isBusy: false, ...s.handlers }))
        .find(e => e.type === 'button' && e.props.title === label)
      assert.ok(found, `${status}: ${label} must be present`)
      found.props.onClick()
    }

    press('generated', 'View Payroll')
    press('generated', 'Regenerate Payroll')
    press('generated', 'Lock Payroll')
    press('locked',    'Unlock Payroll')
    press('draft',     'Generate Payroll')

    // Same handlers, same meanings as before the icons: regenerating and
    // generating are one code path, and nothing new sits between the click and
    // the page's fetch.
    assert.deepEqual(s.calls, ['view', 'generate', 'lock', 'unlock', 'generate'])
  })

  test('a generation in flight disables only the generation control', () => {
    const busy = buttonsOf('generated', { isBusy: true })
    const byTitle = Object.fromEntries(busy.map(b => [b.props.title, b.props.disabled]))
    assert.equal(byTitle['Regenerate Payroll'], true)
    assert.equal(byTitle['Lock Payroll'],       false)
    assert.equal(byTitle['View Payroll'],       false)
  })
})

// ── Attention ─────────────────────────────────────────────────────────────────

const stale = (status: PeriodStatus) =>
  payrollAttention({ status, outOfDate: true, reopened: false })!

describe('attention indicator', () => {
  test('the warning sentence is no longer printed in the cell', () => {
    const html = renderToStaticMarkup(
      <PayrollAttentionIndicator detail={stale('generated')} onOpen={() => {}} />,
    )
    assert.doesNotMatch(visibleText(html), /Attendance records were updated/)
    assert.doesNotMatch(visibleText(html), /regeneration/i)
    // What is left is one icon-sized control.
    assert.match(html, /<button/)
    assert.match(html, /<svg/)
  })

  test('no icon at all when nothing needs attention', () => {
    const html = renderToStaticMarkup(
      <PayrollAttentionIndicator detail={null} onOpen={() => {}} />,
    )
    assert.doesNotMatch(html, /<button/)
    assert.doesNotMatch(html, /<svg/)
    assert.equal(visibleText(html), '—')
  })

  test('the icon announces itself and names the state in its tooltip', () => {
    for (const status of ['generated', 'locked'] as const) {
      const detail = stale(status)
      const html = renderToStaticMarkup(
        <PayrollAttentionIndicator detail={detail} onOpen={() => {}} />,
      )
      assert.match(html, new RegExp(`aria-label="${PAYROLL_ATTENTION_ARIA_LABEL}"`), status)
      // Colour alone must not be the signal — the tooltip says what is wrong.
      assert.match(html, new RegExp(`title="${detail.title}"`), status)
      assert.match(html, /aria-haspopup="dialog"/, status)
    }
  })

  test('a stale period is amber; a merely reopened one is not', () => {
    const amber = renderToStaticMarkup(
      <PayrollAttentionIndicator detail={stale('locked')} onOpen={() => {}} />,
    )
    assert.match(amber, /boe-payroll-attention--amber/)

    const info = renderToStaticMarkup(
      <PayrollAttentionIndicator
        detail={payrollAttention({ status: 'generated', outOfDate: false, reopened: true })!}
        onOpen={() => {}}
      />,
    )
    assert.match(info, /boe-payroll-attention--info/)
  })

  test('clicking the icon opens the popup', () => {
    let opened = 0
    const el = PayrollAttentionIndicator({ detail: stale('generated'), onOpen: () => { opened += 1 } })
    const button = elements(el).find(e => e.type === 'button')
    assert.ok(button, 'the indicator must be a button')
    button.props.onClick()
    assert.equal(opened, 1)
  })
})

describe('attention popup', () => {
  const render = (status: PeriodStatus, reopened = null as null | {
    actorName: string | null; at: string; reason: string | null
  }) => renderToStaticMarkup(
    <PayrollAttentionModal
      detail={stale(status)}
      periodLabel="July 2026"
      lastGeneratedLabel="2 Aug 2026 10:15 AM"
      reopened={reopened}
      onAct={() => {}}
      onClose={() => {}}
    />,
  )

  test('the generated popup explains the staleness and offers Regenerate Payroll', () => {
    const text = visibleText(render('generated'))
    assert.match(text, /Payroll needs regeneration/)
    assert.match(text, /Attendance records were updated after payroll generation\./)
    assert.match(text, /July 2026/)
    assert.match(text, /2 Aug 2026 10:15 AM/)
    assert.match(text, /Regenerate Payroll/)
    assert.match(text, /Close/)
    assert.doesNotMatch(text, /Unlock Payroll/)
  })

  test('the locked popup gives the four-step way back and offers Unlock Payroll', () => {
    const html = render('locked')
    const text = visibleText(html)
    assert.match(text, /Payroll has attendance changes/)
    assert.match(text, /Attendance records were updated after this payroll was locked\./)
    assert.match(text, /Unlock payroll.*Regenerate payroll.*Review results.*Lock payroll again/)
    assert.match(html, /<ol/)
    assert.match(text, /Unlock Payroll/)
    assert.match(text, /Close/)
  })

  test('the popup stays a dialog with a heading, not a bare tooltip', () => {
    const html = render('generated')
    assert.match(html, /role="dialog"/)
    assert.match(html, /aria-modal="true"/)
    assert.match(html, /aria-labelledby="/)
  })

  test('the popup stays short — no audit trail, one supporting line at most', () => {
    const text = visibleText(render('locked', {
      actorName: 'Nishant Soni',
      at: '3 Aug 2026 09:00 AM',
      reason: 'Late attendance correction approved.',
    }))
    assert.match(text, /Reopened after locking/)
    assert.match(text, /Nishant Soni/)
    assert.match(text, /Late attendance correction approved\./)
    // Compact by construction: the whole dialog reads shorter than a paragraph
    // of history would.
    assert.ok(text.length < 480, `popup grew to ${text.length} characters`)
  })

  test('the popup action is the row action, so no second code path exists', () => {
    let acted: string | null = null
    const el = PayrollAttentionModal({
      detail: stale('locked'),
      periodLabel: 'July 2026',
      lastGeneratedLabel: '—',
      reopened: null,
      onAct: a => { acted = a },
      onClose: () => {},
    })
    const act = elements(el).find(e => e.type === 'button' && e.props.children === 'Unlock Payroll')
    assert.ok(act, 'the locked popup must lead with Unlock Payroll')
    act.props.onClick()
    assert.equal(acted, 'unlock')
  })
})
