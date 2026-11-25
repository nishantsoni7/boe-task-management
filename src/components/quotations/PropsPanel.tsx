'use client'

// The properties panel at the top of the builder (owner, 25 Nov 2026, from an approved mockup; it replaces the top panel of 24 Nov): three quiet rows,
// STATUS (the lead's stage, read only: the status is changed in Lead Board, never on this page), LEAD, and SENIOR (what was asked and what came back,
// with Ask a senior beside it), then the amber "what is missing" row while Create PI draft is waiting on something. Sharing and the next step moved to the
// bar at the bottom of the page (ActionDock); Import client file, Save and the ⋯ menu are in the title bar.

import { TriangleAlert } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import type { QuotationStatus } from '@/lib/quotations/api'
import type { ConversionProblem } from '@/lib/quotations/piWorkbook'
import { SeniorRow } from './AskCard'
import { LeadCard } from './LeadCard'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

/** A quotation in one of these is read only (Reopen, for an administrator or the person who may edit it, is in the notice at the top of the page). */
export const LOCKED: QuotationStatus[] = ['confirmed', 'lost', 'archived']

const NEEDS: Record<Exclude<ConversionProblem['code'], 'NO_LINES'>, string> = {
  NAME_MISSING: 'a name', QTY_MISSING: 'a quantity above 0', PRICE_MISSING: 'a price above ₹0', PICTURE_MISSING: 'a picture (Orders needs one for every product)',
}
const KIND: Record<Exclude<ConversionProblem['code'], 'NO_LINES'>, string> = { NAME_MISSING: 'Name', QTY_MISSING: 'Quantity', PRICE_MISSING: 'Price', PICTURE_MISSING: 'Picture' }
const SHOWN = 6

/** The one line the panel says while Create PI draft waits: what is missing, for how many products. */
export function waitsFor(problems: readonly ConversionProblem[]): string {
  if (problems.length !== 1) return `${problems.length} things to fix before this can become a PI.`
  const p = problems[0]
  return p.code === 'NO_LINES' ? 'Add at least one product that is not optional.' : `${p.lines.length} ${p.lines.length === 1 ? 'product needs' : 'products need'} ${NEEDS[p.code]} before this can become a PI.`
}

export function PropsPanel({ supabase, base, dirty, canConfirm, piProblems, onChanged, onSentBack }: {
  supabase: Supabase; base: Parameters<typeof LeadCard>[0]['base']; dirty: boolean
  canConfirm: boolean; piProblems: readonly ConversionProblem[]
  /** The lead or the ask changed something the quotation shows: read it again. */
  onChanged: () => void; onSentBack?: () => void
}) {
  const waiting = canConfirm && piProblems.length > 0
  return (
    <section className={s.props} aria-label="Status, lead and senior">
      <LeadCard supabase={supabase} base={base} dirty={dirty} onChanged={onChanged} />
      <SeniorRow supabase={supabase} base={base} dirty={dirty} onChanged={onChanged} onSentBack={onSentBack} />

      {waiting && (
        <div className={s.pfix}>
          <details>
            <summary><TriangleAlert size={15} aria-hidden /> <span>{waitsFor(piProblems)}</span><span className={s.hintMore}>Show which</span></summary>
            <div className={s.hintBody}>
              {piProblems.filter(p => p.lines.length > 0).map(p => (
                <div key={p.code} className={s.hintRow}>
                  {piProblems.length > 1 && p.code !== 'NO_LINES' && <b>{KIND[p.code]} needed:</b>}
                  {p.lines.slice(0, SHOWN).map((name, i) => <span key={i} className={s.chip}>{name}</span>)}
                  {p.lines.length > SHOWN && <span className={s.chip}>+ {p.lines.length - SHOWN} more</span>}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </section>
  )
}
