'use client'

import { useState } from 'react'
import type { PageNotes, SideNumber } from '@/lib/seo/pages'
import type { SeoTag } from '@/lib/seo/sixMonth'
import { Tag } from './SeoSixMonth'
import s from './sixMonth.module.css'

/** One number beside the verdict: its label, a note under it, the value and the class that colours it. */
export type VerdictNumber = { label: string; note?: string; value: string; valueClass?: string }

/**
 * THE VERDICT PANEL, shared by every SEO page and the 6-month review.
 *
 * ON A PHONE (owner, 2026-11-05, Phase 3) it took 280-500px before anything
 * else showed. Below 768px the verdict is smaller, its paragraph is cut to two
 * lines with a "More" button, the lenses and the side numbers are one line of
 * chips each that scroll sideways. A desktop draws it exactly as before (the
 * More button is hidden there and the paragraph is never cut).
 */
export function VerdictPanel({ kicker, title, text, lenses, sideTitle, side }: {
  kicker?: string
  title: string
  text?: string
  lenses: { label: string; tag: SeoTag }[]
  sideTitle: string
  side: VerdictNumber[]
}) {
  const [more, setMore] = useState(false)
  return (
    <section className={`boe-panel ${s.hero}`} aria-label="Verdict">
      <div className={s.heroMain}>
        {kicker && <div className={s.kicker}>{kicker}</div>}
        <h1 className={s.verdict}>{title}</h1>
        {text && <p className={`${s.verdictText}${more ? ` ${s.verdictOpen}` : ''}`}>{text}</p>}
        {text && (
          <button type="button" className={s.moreBtn} aria-expanded={more} onClick={() => setMore(v => !v)}>
            {more ? 'Less' : 'More'}
          </button>
        )}
        {lenses.length > 0 && (
          <div className={s.lenses}>
            {lenses.map(lens => <span key={lens.label} className={s.lens}>{lens.label} <Tag tag={lens.tag} /></span>)}
          </div>
        )}
      </div>
      <div className={s.heroSide}>
        <div className={s.sideTitle}>{sideTitle}</div>
        {side.map(item => (
          <div key={item.label} className={s.headline}>
            <span>{item.label}{item.note && <small>{item.note}</small>}</span>
            <b className={item.valueClass}>{item.value}</b>
          </div>
        ))}
      </div>
    </section>
  )
}

/** The verdict the Monday session writes, beside numbers worked out from today's rows. */
export function Hero({ notes, side, sideTitle, fallback }: { notes: PageNotes; side: SideNumber[]; sideTitle: string; fallback: { title: string; text?: string } }) {
  return (
    <VerdictPanel
      kicker={notes.kicker}
      title={notes.title || fallback.title}
      text={notes.text || fallback.text}
      lenses={notes.lenses}
      sideTitle={sideTitle}
      side={side.map(item => ({
        label: item.label, note: item.note, value: item.value,
        valueClass: item.tone === 'up' ? s.up : item.tone === 'down' ? s.down : undefined,
      }))}
    />
  )
}

export function Check({ text }: { text?: string }) {
  if (!text) return null
  return <div className={s.strip}><Tag tag={{ text: 'Expert check', tone: 'wait' }} /><span>{text}</span></div>
}

export function Notes({ items }: { items: PageNotes['notes'] }) {
  if (!items.length) return null
  return (
    <section className="boe-panel" aria-label="Before you quote these numbers">
      <div className={s.head}><Tag tag={{ text: 'Expert check', tone: 'wait' }} /><h2 className={s.title}>Before you quote these numbers</h2></div>
      <div className={s.notes}>{items.map(note => <p key={note.label}><b>{note.label}</b> {note.text}</p>)}</div>
    </section>
  )
}

export function Rows({ items }: { items: PageNotes['rows'] }) {
  return items.map(row => (
    <div key={row.title} className={s.mini}>
      <span><b>{row.title}</b> {row.text}</span>
      {row.tag && <Tag tag={row.tag} />}
    </div>
  ))
}

export function Foot({ text }: { text: string }) {
  return text ? <p className={s.foot}>{text}</p> : null
}
