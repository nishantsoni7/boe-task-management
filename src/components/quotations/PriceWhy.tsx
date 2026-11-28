'use client'

// "Why this price" (28 Nov 2026; the owner approved the mockup): the popup behind the suggested price on a quotation line, for the people who
// see "Why?" (Pricing). It shows three opinions side by side (what the person taught, what the estimator says, what was really charged), the
// estimator's price as a CHAIN (a starting point and one step at a time, each with the prices behind it), the closest past prices, and the way
// to teach a price. A step can be switched off to see the price without it: that changes only this screen and saves nothing.
// A suggestion that did not come from the model (history only) keeps the old facts-only popup.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatINR } from '@/lib/currency'
import { formatDateIN } from '@/lib/quotations/math'
import { istDateOf } from '@/lib/istDate'
import { TYPE_LABEL } from '@/lib/pricing/features'
import { roundPrice } from '@/lib/pricing/suggest'
import type { ModelSuggestion, PriceChain } from '@/lib/pricing/model'
import type { PriceHint } from '@/lib/quotations/api'
import { SuggestionFeedback, type FeedbackLine } from '@/components/pricing/learning/SuggestionFeedback'
import s from './quotations.module.css'
import w from './priceWhy.module.css'

/** Who and what a price popup is about: given by the builder, which knows the quotation and the person. */
export type WhyCtx = {
  line: FeedbackLine; clientType: string | null; quotationId: string | null; isDesk: boolean
  /** The line's photo and the price typed on it (for the Teach panel). */
  imagePath?: string | null; price?: number | null
  /** The taught case the line picked, worked out for the line; null or absent when none. */
  taught?: { caseNo: number; name: string; price: number } | null
  /** The way into the Teach panel; absent for people who may not teach. Gets what was typed in the note box. */
  onTeach?: (note: string) => void
}
type Sug = { price: number; low: number; high: number; confidence: string; basis: string }

// A short code such as PU stays in capitals; any other word starts with one.
const cap = (x: string) => (x.length <= 2 ? x.toUpperCase() : x.charAt(0).toUpperCase() + x.slice(1).replace(/_/g, ' '))
const money = (n: number) => formatINR(Math.round(n))

export function PriceWhy({ ctx, hint, model, sug, onClose }: { ctx: WhyCtx; hint?: PriceHint; model?: ModelSuggestion | null; sug: Sug | null; onClose: () => void }) {
  const o = hint?.ordered ?? null
  const note = useRef('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const chained = !!model?.why && !!sug
  const name = ctx.line.name.trim() || 'This product'
  const teach = ctx.onTeach && (
    <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => { onClose(); ctx.onTeach!(note.current) }}>Teach my price</button>
  )
  // In the body, not inside the product row: the row sits in a muted small-print block that a popup must not inherit.
  return createPortal(
    <div className={s.scrim} onClick={onClose}>
      <div className={`${s.modal} ${w.dlg}`} role="dialog" aria-modal="true" aria-labelledby="why-title" onClick={e => e.stopPropagation()}>
        <div className={s.cardHead}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="why-title">{chained ? `${name}: where ${formatINR(sug!.price)} comes from` : `${name}: the price`}</h2>
            {chained && <div className={w.sub}>Learned from {model!.n} past prices (typical error ±{Math.round((Math.exp(model!.why!().sigma) - 1) * 100)}%)</div>}
          </div>
          <button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close" autoFocus>×</button>
        </div>
        {chained ? (
          <div className={w.body}>
            <ChainBody ctx={ctx} model={model!} sug={sug!} />
            <SuggestionFeedback source="quotation" line={ctx.line} clientType={ctx.clientType} quotationId={ctx.quotationId} isDesk={ctx.isDesk} label="Send a note to the pricing desk instead"
              onComment={t => { note.current = t }}
              suggestion={{ price: sug!.price, low: sug!.low, high: sug!.high, confidence: sug!.confidence, basis: sug!.basis, reasons: model?.reasons ?? [] }} />
          </div>
        ) : (
          <div className={w.body}>
            {sug && (
              <div>
                <div>Suggested <b>{formatINR(sug.price)}</b>{sug.low !== sug.high && <> · range {formatINR(sug.low)}–{formatINR(sug.high)}</>} · {sug.confidence} confidence</div>
                <div className={`${s.small} ${s.muted}`}>From {sug.basis}</div>
              </div>
            )}
            {model && model.reasons.length > 0 && <ul className={s.small} style={{ margin: 0, paddingLeft: 18 }}>{model.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
            {(o || hint?.quoted) && (
              <div className={s.small}>
                {o && <div>Last ordered <b>{formatINR(Number(o.last))}</b>{Number(o.count) > 1 && <> · {formatINR(Number(o.min))}–{formatINR(Number(o.max))} over {o.count} orders</>}</div>}
                {hint?.quoted && <div>Last quoted <b>{formatINR(Number(hint.quoted.last))}</b></div>}
              </div>
            )}
            {sug && (
              <SuggestionFeedback source="quotation" line={ctx.line} clientType={ctx.clientType} quotationId={ctx.quotationId} isDesk={ctx.isDesk} defaultOpen onComment={t => { note.current = t }}
                suggestion={{ price: sug.price, low: sug.low, high: sug.high, confidence: sug.confidence, basis: sug.basis, reasons: model?.reasons ?? [] }} />
            )}
          </div>
        )}
        <div className={w.foot}>{teach}<button type="button" className={s.btn} onClick={onClose}>Close</button></div>
      </div>
    </div>,
    document.body,
  )
}

const inside = (x: number, lo: number, hi: number) => (x < lo ? 'below' : x > hi ? 'above' : 'inside')

function ChainBody({ ctx, model, sug }: { ctx: WhyCtx; model: ModelSuggestion; sug: Sug }) {
  const chain = useMemo<PriceChain>(() => model.why!(), [model])
  const near = useMemo(() => model.closest?.() ?? [], [model])
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set())
  const [all, setAll] = useState(false)
  const kind = (TYPE_LABEL[model.type] ?? model.type).toLowerCase()
  // The running figure: the starting point times each step that is switched on, in the order they are listed.
  const rows = chain.steps.reduce<(typeof chain.steps[number] & { on: boolean; after: number })[]>((acc, st) => {
    const on = !off.has(st.key), before = acc.length ? acc[acc.length - 1].after : chain.base
    return [...acc, { ...st, on, after: on ? before * Math.exp(st.c) : before }]
  }, [])
  const run = rows.length ? rows[rows.length - 1].after : chain.base
  const price = roundPrice(run), low = roundPrice(run * Math.exp(-chain.sigma)), high = roundPrice(run * Math.exp(chain.sigma))
  const prices = near.map(n => n.price).sort((a, b) => a - b)
  const past = prices.length >= 3 ? { min: prices[0], max: prices[prices.length - 1], mid: prices[Math.floor(prices.length / 2)], n: prices.length } : null
  const mine = ctx.taught?.price ?? ctx.price ?? null
  const changed = off.size > 0
  const side = chain.typical.area ? Math.round(Math.sqrt(chain.typical.area)) : null
  const toggle = (key: string) => setOff(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const shown = all ? near : near.slice(0, 5)
  const sizeText = (ctx.line.size ?? '').trim()

  return (
    <>
      <div>
        <div className={w.ops}>
          <div className={`${w.op} ${ctx.taught ? w.opMine : w.opNone}`}>
            <span className={w.k}>Your costing</span>
            {ctx.taught
              ? <><span className={w.v}>{formatINR(ctx.taught.price)}</span><span className={w.r}>#{ctx.taught.caseNo} {ctx.taught.name}, taught</span></>
              : <><span className={w.vNone}>Not taught yet</span><span className={w.r}>Teach it once and it counts from then on.</span></>}
          </div>
          <div className={w.op}>
            <span className={w.k}>Estimator</span><span className={w.v}>{formatINR(sug.price)}</span>
            <span className={w.r}>Range {formatINR(sug.low)}–{formatINR(sug.high)} · {sug.confidence} confidence</span>
          </div>
          {past && (
            <div className={w.op}>
              <span className={w.k}>Past prices</span><span className={w.v}>{formatINR(past.mid)}</span>
              <span className={w.r}>{past.n} similar {kind} prices: {formatINR(past.min)}–{formatINR(past.max)}, middle price</span>
            </div>
          )}
        </div>
        {mine !== null && (
          <p className={w.verdict}>
            {ctx.taught ? 'Your taught price' : 'The price on the line'} {formatINR(mine)} is {inside(mine, sug.low, sug.high)} the estimator&apos;s range
            {past ? <> and {inside(mine, past.min, past.max)} the past prices ({formatINR(past.min)}–{formatINR(past.max)})</> : null}.
          </p>
        )}
      </div>

      <div>
        <div className={w.sech}><h3>How the estimator got {formatINR(sug.price)}</h3><span>top to bottom, each step multiplies the one before</span></div>
        <table className={w.chain}>
          <thead><tr><th>Step</th><th className={w.num}>Effect</th><th className={w.num}>Price after it</th><th /></tr></thead>
          <tbody>
            <tr className={w.start}>
              <td><b>Starting point</b>
                <span className={w.why}>A typical {kind}{side ? ` of the usual size (about ${side} × ${side} in)` : ''}, {chain.typical.material === 'unknown' ? 'material not stated' : cap(chain.typical.material)}, {chain.typical.finish === 'unknown' ? 'finish not stated' : `${cap(chain.typical.finish)} finish`}, 1–10 pieces, as most of the {chain.n} prices describe.</span></td>
              <td /><td className={w.num}><b>{money(chain.base)}</b></td><td />
            </tr>
            {rows.map(r => (
              <tr key={r.key} className={r.on ? undefined : w.off}>
                <td><b>{r.label}</b>
                  <span className={w.why}>
                    {r.label === 'Size not written' && <>{sizeText ? `The Dimensions box says “${sizeText}”: no width and depth to measure. ` : 'The Dimensions box is empty. '}</>}
                    {r.behind}{r.behind ? '.' : ''}
                  </span></td>
                <td className={w.num}><span className={`${w.eff} ${r.pct < 0 ? w.neg : w.pos}`}>{r.pct > 0 ? '+' : ''}{r.pct}%</span></td>
                <td className={`${w.num} ${w.after}`}>{money(r.after)}</td>
                <td className={`${w.num} ${w.swCell}`}>
                  {r.key !== 'rest' && <label className={w.sw}><input type="checkbox" checked={r.on} onChange={() => toggle(r.key)} aria-label={`Count this step: ${r.label}`} /> Count</label>}
                </td>
              </tr>
            ))}
            <tr className={w.end}>
              <td><span className={w.endV}>Estimator suggests</span><span className={w.why}>Range {formatINR(low)}–{formatINR(high)} (the typical error of ±{Math.round((Math.exp(chain.sigma) - 1) * 100)}% around it)</span></td>
              <td /><td className={w.num}><span className={w.endV}>{formatINR(price)}</span></td><td />
            </tr>
          </tbody>
        </table>
        {chain.notes.length > 0 && <p className={w.hint}>{chain.notes.join('. ')}.</p>}
        {changed
          ? <div className={w.rule} role="status"><b>With your changes: {formatINR(price)}.</b> {past ? (inside(price, past.min, past.max) === 'inside' ? <>That is inside what similar {kind}s were charged ({formatINR(past.min)}–{formatINR(past.max)}). </> : <>That is {inside(price, past.min, past.max)} what similar prices were ({formatINR(past.min)}–{formatINR(past.max)}), so these steps are doing real correcting work. </>) : null}Only this screen changes; nothing is saved.</div>
          : <p className={w.hint}>Switch a step off to see the price without it. Nothing is saved.</p>}
      </div>

      {near.length > 0 && (
        <div>
          <div className={w.sech}><h3>Closest past prices</h3><span>real prices of the same kind of product, newest first among the closest</span></div>
          <div className={w.nb}>
            {shown.map((n, i) => (
              <div key={i} className={`${w.nbr} ${n.kind === 'taught' ? w.nbMine : ''}`}>
                <span className={w.nbMeta}>{n.qty ? `${n.qty.toLocaleString('en-IN')} pcs` : ''}</span>
                <span className={w.nbName}>{n.name}<small>{n.kind === 'taught' ? 'Taught in Training' : n.detail}</small></span>
                <span className={`${w.nbMeta} ${w.nbDate}`}>{formatDateIN(istDateOf(n.at))}</span>
                <span className={w.nbPrice}>{formatINR(n.price)}</span>
              </div>
            ))}
            {near.length > shown.length && <button type="button" className={w.more} onClick={() => setAll(true)}>Show the other {near.length - shown.length}</button>}
          </div>
        </div>
      )}
    </>
  )
}
