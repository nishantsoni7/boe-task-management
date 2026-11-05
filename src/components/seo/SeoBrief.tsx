'use client'

import { useMemo } from 'react'
import { PhoneTableCards } from '@/components/ui/PhoneTableCards'
import { useQuery } from '@tanstack/react-query'
import { useSeoAccess } from '@/hooks/useSeoAccess'
import { fetchLatestBrief } from '@/lib/seo/api'
import type { DiscussionBrief } from '@/lib/seo/sixMonth'
import { createClient } from '@/lib/supabase/client'
import { SeoScreen } from './SeoScreen'
import { Tag } from './SeoSixMonth'
import s from './sixMonth.module.css'

const Step = ({ number, title, note }: { number: number; title: string; note?: string }) => (
  <div className={s.head}><span className={s.number}>{number}</span><h2 className={s.title}>{title}</h2>{note && <span className={s.noteLeft}>{note}</span>}</div>
)

export function BriefBody({ brief }: { brief: DiscussionBrief }) {
  const { proof } = brief
  const most = Math.max(...proof.bars.map(b => b.value), 1)

  return (
    <div className={s.page}>
      <section className={`boe-panel ${s.message}`} aria-label="The message">
        <div className={s.heroMain}>
          <div className={s.kicker}>The one message for this meeting</div>
          <h1 className={s.messageText}>{brief.message}</h1>
          <p className={s.small}>{brief.subtitle}</p>
        </div>
        <div className={s.heroSide}>
          <div className={s.sideTitle}><Tag tag={{ text: 'Expert check', tone: 'wait' }} /> Before you start</div>
          {brief.before.map(line => <div key={line} className={s.small}>{line}</div>)}
        </div>
      </section>

      <div className={s.briefColumns}>
        <div className={s.stack}>
          <section className="boe-panel" aria-label="Start with credit">
            <Step number={1} title="Start with credit" note="5 minutes" />
            {brief.credit.map(item => (
              <div key={item.title} className={s.line}>
                <div className={s.strong}>{item.title}</div>
                <div className={s.small}>{item.text}</div>
                {item.ask && <div className={s.ask}>{item.ask}</div>}
              </div>
            ))}
          </section>

          <section className="boe-panel" aria-label="Raise these">
            <Step number={2} title="Raise these" note="15 minutes. Fact first, then the question. Start with the first two." />
            {brief.raise.map(item => (
              <div key={item.title} className={s.issue}>
                <div className={s.strong}>{item.title}</div>
                <Tag tag={item.tag} />
                <div className={`${s.small} ${s.wide}`}>{item.text}</div>
                <div className={`${s.ask} ${s.wide}`}>{item.ask}</div>
              </div>
            ))}
          </section>
        </div>

        <div className={s.stack}>
          <section className="boe-panel" aria-label="Be fair">
            <Step number={3} title="Be fair: not on them" />
            {brief.fair.map(item => (
              <div key={item.title} className={s.line}><div className={s.strong}>{item.title}</div><div className={s.small}>{item.text}</div></div>
            ))}
          </section>

          <section className="boe-panel" aria-label="Agree for 30 days">
            <Step number={4} title="Agree for 30 days" note="Suggested. You decide." />
            <div className={s.group}>Scored: SEO person</div>
            {brief.scored.map(item => (
              <div key={item.title} className={s.goal}>
                <div><div className={s.strong}>{item.title}</div><div className={s.small}>{item.text}</div></div>
                <div className={s.goalValue}>{item.value}</div>
              </div>
            ))}
            <div className={s.group}>Not scored against them</div>
            {brief.others.map(item => (
              <div key={item.title} className={s.line}><div className={s.strong}>{item.title}</div><div className={s.small}>{item.text}</div></div>
            ))}
            <div className={`${s.goal} ${s.goalYou}`}>
              <div><div className={s.strong}>{brief.yours.title}</div><div className={s.small}>{brief.yours.text}</div></div>
              <div className={s.goalValue}>You</div>
            </div>
          </section>

          <section className="boe-panel" aria-label={brief.next.title}>
            <Step number={5} title={brief.next.title} />
            <div className={s.nextRows}>
              {brief.next.rows.map(row => <div key={row.tag.text} className={s.nextRow}><Tag tag={row.tag} /><span>{row.text}</span></div>)}
            </div>
          </section>
        </div>
      </div>

      <section className="boe-panel" aria-label={proof.title}>
        <div className={s.head}><h2 className={s.title}>{proof.title}</h2><span className={s.noteLeft}>{proof.note}</span></div>
        <div className={s.proofGrid}>
          <div>
            <div className={s.small}>{proof.chart}</div>
            <div className={s.proofBars} role="img" aria-label={proof.chart}>
              {proof.bars.map(bar => (
                <i key={bar.month} className={bar.recent ? s.proofRecent : undefined} style={{ height: `${Math.round((bar.value / most) * 100)}%` }} title={`${bar.month}: ${bar.value}`} />
              ))}
            </div>
            <div className={s.proofAxis}>{proof.axis.map(label => <span key={label}>{label}</span>)}</div>
          </div>
          <PhoneTableCards className={s.tableWrapFlat}>
            <table className={s.table}>
              <thead><tr>{proof.table.head.map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{proof.table.rows.map(row => <tr key={row[0]}>{row.map((cell, i) => <td key={`${i}-${cell}`}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </PhoneTableCards>
        </div>
      </section>

      <p className={s.foot}>{brief.foot}</p>
    </div>
  )
}

function Brief() {
  const { isAdmin } = useSeoAccess()
  const supabase = useMemo(() => createClient(), [])
  const query = useQuery({
    queryKey: ['seo', 'brief'],
    queryFn: () => fetchLatestBrief(supabase),
    enabled: isAdmin,
    staleTime: 5 * 60_000,
  })

  if (!isAdmin) {
    return <div className="boe-empty"><p className="boe-empty-title">This page is for the Admin only</p></div>
  }
  if (query.isError) {
    return (
      <div className="boe-empty">
        <p className="boe-empty-title">The brief could not be loaded</p>
        <button className="boe-btn boe-btn-secondary" onClick={() => query.refetch()}>Try again</button>
      </div>
    )
  }
  if (query.isPending) return <p className={s.small}>Loading the brief...</p>
  if (!query.data) {
    return <div className="boe-empty"><p className="boe-empty-title">No discussion brief yet</p><p>It appears here after the scheduled sessions send the first one.</p></div>
  }
  return <BriefBody brief={query.data.body} />
}

// Admin only, in its own table, and read here rather than in the shared read, so it never reaches anybody else's browser.
export function SeoBrief() {
  return <SeoScreen title="Discussion brief" subtitle="Only the Admin can see this page">{() => <Brief />}</SeoScreen>
}
