'use client'

import type { PageNotes, SideNumber } from '@/lib/seo/pages'
import { Tag } from './SeoSixMonth'
import s from './sixMonth.module.css'

/** The verdict the Monday session writes, beside numbers worked out from today's rows. */
export function Hero({ notes, side, sideTitle, fallback }: { notes: PageNotes; side: SideNumber[]; sideTitle: string; fallback: { title: string; text?: string } }) {
  return (
    <section className={`boe-panel ${s.hero}`} aria-label="Verdict">
      <div className={s.heroMain}>
        {notes.kicker && <div className={s.kicker}>{notes.kicker}</div>}
        <h1 className={s.verdict}>{notes.title || fallback.title}</h1>
        <p className={s.verdictText}>{notes.text || fallback.text}</p>
        {notes.lenses.length > 0 && (
          <div className={s.lenses}>
            {notes.lenses.map(lens => <span key={lens.label} className={s.lens}>{lens.label} <Tag tag={lens.tag} /></span>)}
          </div>
        )}
      </div>
      <div className={s.heroSide}>
        <div className={s.sideTitle}>{sideTitle}</div>
        {side.map(item => (
          <div key={item.label} className={s.headline}>
            <span>{item.label}{item.note && <small>{item.note}</small>}</span>
            <b className={item.tone === 'up' ? s.up : item.tone === 'down' ? s.down : undefined}>{item.value}</b>
          </div>
        ))}
      </div>
    </section>
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
