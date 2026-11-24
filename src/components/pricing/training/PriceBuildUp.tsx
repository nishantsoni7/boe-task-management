'use client'

// Pricing > Training: the running price of a case, beside its elements (24 Nov 2026 redesign). The cost of making by kind,
// then Overhead % and Margin % (the two boxes of boxes.ts), then the selling price, and how far it is from the price on
// the PI. The margin is worked on the cost only, unless the case says "cost plus overhead" (owner, 24 Nov 2026).
// Nothing here saves anything.

import { formatINR } from '@/lib/currency'
import { KINDS, KIND_LABEL } from '@/lib/pricing/training/doc'
import { priceCheck } from '@/lib/pricing/training/draft'
import { boxOf, boxPct, type BoxKind, type Boxes, type BuildUp } from '@/lib/pricing/training/boxes'
import t from './training.module.css'

type Props = {
  editable: boolean; build: BuildUp; boxes: Boxes; sold: number | null
  onPct: (kind: BoxKind, value: string) => void; onBase: (of: 'cost' | 'above') => void
}

const share = (part: number, whole: number) => (whole > 0 ? Math.round(part / whole * 100) : 0)

export function PriceBuildUp({ editable, build: b, boxes, sold, onPct, onBase }: Props) {
  const cost = b.total - b.overhead - b.margin
  const check = priceCheck(b.total, sold)
  const pctRow = (kind: BoxKind, label: string, amount: number) => {
    const text = boxPct(boxes[kind])
    return (
      <div className={t.pct}>
        {editable ? <label htmlFor={`box-${kind}`}>{label}</label> : <span>{label}</span>}
        {editable
          ? <div className={t.fx}><input id={`box-${kind}`} inputMode="decimal" value={text} placeholder="0" aria-describedby={`box-${kind}-amount`} onChange={e => onPct(kind, e.target.value)} /><span className={t.sf} aria-hidden>%</span></div>
          : <span className={t.num} id={`box-${kind}`}>{text ? `${text}%` : '—'}</span>}
        <span className={t.num} id={`box-${kind}-amount`}>{amount > 0 ? `+ ${formatINR(amount)}` : '—'}</span>
      </div>
    )
  }
  return (
    <aside className={`${t.card} ${t.build}`} aria-label="Price build-up">
      <div className={t.cardH}>Price build-up</div>
      <div className={t.cardB}>
        <div>
          {KINDS.filter(k => b.byKind[k] > 0).map(k => <div key={k} className={`${t.brow} ${t.dim}`}><span>{KIND_LABEL[k]}</span><span className={t.num}>{formatINR(b.byKind[k])}</span></div>)}
          {b.cost === 0 && <div className={`${t.brow} ${t.dim}`}><span>No elements yet</span><span className={t.num}>—</span></div>}
          {b.extra > 0 && <div className={`${t.brow} ${t.dim}`}><span>Percentages in the elements</span><span className={t.num}>{formatINR(b.extra)}</span></div>}
          <div className={`${t.brow} ${t.costRow}`}><span>Cost of making</span><span className={t.num}>{formatINR(b.cost)}</span></div>
          <div className={t.pcts}>
            {pctRow('overhead', 'Overhead', b.overhead)}
            {pctRow('margin', 'Margin', b.margin)}
          </div>
        </div>
        <fieldset className={t.base} disabled={!editable}>
          <legend>Margin is worked out on</legend>
          <label><input type="radio" name="margin-base" checked={boxOf(boxes.margin) === 'cost'} onChange={() => onBase('cost')} /> The cost <span className={t.num}>{formatINR(b.cost)}</span></label>
          <label><input type="radio" name="margin-base" checked={boxOf(boxes.margin) === 'above'} onChange={() => onBase('above')} /> The cost plus overhead <span className={t.num}>{formatINR(b.above)}</span></label>
        </fieldset>
        <div className={t.price}><span>Selling price</span><b aria-live="polite">{formatINR(b.total)}</b></div>
        {b.total > 0 && (
          <>
            <div className={t.bar} aria-hidden>
              <i style={{ width: `${cost / b.total * 100}%`, background: 'var(--boe-text)' }} />
              <i style={{ width: `${b.overhead / b.total * 100}%`, background: 'var(--boe-text-muted)' }} />
              <i style={{ width: `${b.margin / b.total * 100}%`, background: 'var(--boe-border-strong)' }} />
            </div>
            <div className={t.legend}>
              <span><em style={{ background: 'var(--boe-text)' }} />Cost <b>{share(cost, b.total)}%</b></span>
              <span><em style={{ background: 'var(--boe-text-muted)' }} />Overhead <b>{share(b.overhead, b.total)}%</b></span>
              <span><em style={{ background: 'var(--boe-border-strong)' }} />Margin <b>{share(b.margin, b.total)}%</b></span>
            </div>
          </>
        )}
        {check && (check.ok
          ? <div className="boe-callout boe-callout-success" role="status">Matches the price on the case ({formatINR(sold!)}): {check.pct}% apart, which is rounding.</div>
          : <div className="boe-callout boe-callout-warning" role="status">{formatINR(Math.abs(b.total - sold!))} {b.total > sold! ? 'above' : 'below'} the price on the case ({formatINR(sold!)}), {check.pct}% apart. Check a row or the percentages, or say in the notes why they differ.</div>)}
      </div>
    </aside>
  )
}
