'use client'

import type { ReactNode } from 'react'
import { PhoneTableCards } from '@/components/ui/PhoneTableCards'
import type { BriefCase, BriefProof, DiscussionBrief } from '@/lib/seo/sixMonth'
import { Head, Tag } from './SeoSixMonth'
import s from './sixMonth.module.css'

type Case = DiscussionBrief & Partial<BriefCase>

export function Proof({ proof }: { proof: DiscussionBrief['proof'] }) {
  const most = Math.max(...proof.bars.map(b => b.value), 1)
  return (
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
  )
}

const Takeaway = ({ text, label = 'What it shows' }: { text: string; label?: string }) => (
  <div className={s.strip}><Tag tag={{ text: label, tone: 'wait' }} /><span>{text}</span></div>
)

/** Where each figure can be checked. Links open in a new tab; a file with no link is named so it can be found. */
function Proofs({ proofs }: { proofs?: BriefProof[] }) {
  if (!proofs?.length) return null
  return (
    <div className={s.proofs}>
      <div className={s.miniHead}>Check it yourself</div>
      <ul className={s.proofList}>
        {proofs.map(proof => (
          <li key={`${proof.label}-${proof.shows}`}>
            {proof.url
              ? <a href={proof.url} target="_blank" rel="noopener noreferrer" className={s.proofLink}>{proof.label}<span className="sr-only"> (opens in a new tab)</span></a>
              : <span className={s.strong}>{proof.label}</span>}
            <span className={s.small}>{proof.shows}</span>
            <span className={s.proofHow}>{proof.how}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Table({ head, rows, highlightFirst = false }: { head: string[]; rows: string[][]; highlightFirst?: boolean }) {
  return (
    <PhoneTableCards className={`${s.tableWrapFlat} ${s.padded}`}>
      <table className={`${s.table} ${s.caseTable}`}>
        <thead><tr>{head.map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={row[0]} className={highlightFirst && r === 0 ? s.usRow : undefined}>{row.map((cell, i) => <td key={`${i}-${cell}`}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </PhoneTableCards>
  )
}

// ── The two charts: all clicks as bars, and the buyer lines beside them, with Google's updates marked on both ──

const W = 760
const H = 240
const LEFT = 46
const RIGHT = 12
const TOP = 14
const BOTTOM = 30

function Chart({ months, events, ticks, label, children }: {
  months: string[]
  events: BriefCase['trend']['events']
  ticks: number[]
  label: string
  children: (x: (i: number) => number, y: (v: number) => number) => ReactNode
}) {
  const x = (i: number) => LEFT + (i + 0.5) * ((W - LEFT - RIGHT) / months.length)
  const top = ticks[ticks.length - 1]
  const y = (v: number) => TOP + (H - TOP - BOTTOM) * (1 - v / top)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className={s.chartSvg}>
      {ticks.map(t => (
        <g key={t}>
          <line x1={LEFT} x2={W - RIGHT} y1={y(t)} y2={y(t)} className={s.gridLine} />
          <text x={LEFT - 6} y={y(t) + 4} textAnchor="end" className={s.axisText}>{t.toLocaleString('en-IN')}</text>
        </g>
      ))}
      {children(x, y)}
      {events.map((e, k) => (
        <g key={e.text}>
          <line x1={x(e.month)} x2={x(e.month)} y1={TOP} y2={y(0)} className={s.eventLine} />
          <circle cx={x(e.month)} cy={TOP + 2} r={8} className={s.eventDot} />
          <text x={x(e.month)} y={TOP + 6} textAnchor="middle" className={s.dotText}>{k + 1}</text>
        </g>
      ))}
      {months.map((m, i) => (i % 2 === 0 || i === months.length - 1) && (
        <text key={m + i} x={x(i)} y={H - 10} textAnchor="middle" className={s.axisText}>{m}</text>
      ))}
    </svg>
  )
}

/** Round ticks from 0 that hold the largest value in about three steps of 1, 2, 2.5 or 5 times a power of ten. */
export function axisTicks(most: number) {
  const rough = Math.max(most, 1) / 3
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(m => m >= rough) ?? 10 * power
  return Array.from({ length: Math.ceil(Math.max(most, 1) / step) + 1 }, (_, i) => i * step)
}

function Trend({ trend }: { trend: BriefCase['trend'] }) {
  const [all, ...lines] = trend.series
  const ticks1 = axisTicks(Math.max(...all.values))
  const ticks2 = axisTicks(Math.max(...lines.flatMap(l => l.values)))
  const LINE = [s.lineBuyer, s.lineCategory]
  const KEY = [s.keyBuyer, s.keyCategory]
  // The line ending higher is labelled above its last point, the lower one below, so the two labels never meet.
  const ends = lines.map(l => l.values[l.values.length - 1])
  return (
    <>
      <div className={s.trendGrid}>
        <div>
          <div className={s.chartTitle}><i className={`${s.key} ${s.keyAll}`} />{all.label} a month</div>
          <Chart months={trend.months} events={trend.events} ticks={ticks1} label={`${all.label} a month, from ${all.values[0]} to ${all.values[all.values.length - 1]}.`}>
            {(x, y) => all.values.map((v, i) => {
              const width = ((W - LEFT - RIGHT) / trend.months.length) * 0.62
              return <rect key={trend.months[i] + i} x={x(i) - width / 2} y={y(v)} width={width} height={y(0) - y(v)} rx={2} className={s.barAll}><title>{`${trend.months[i]}: ${v.toLocaleString('en-IN')}`}</title></rect>
            })}
          </Chart>
        </div>
        <div>
          <div className={s.chartTitle}>{lines.map((l, k) => <span key={l.label} className={s.chartKey}><i className={`${s.key} ${KEY[k]}`} />{l.label}</span>)}</div>
          <Chart months={trend.months} events={trend.events} ticks={ticks2} label={lines.map(l => `${l.label} from ${l.values[0]} to ${l.values[l.values.length - 1]}`).join('. ')}>
            {(x, y) => lines.map((l, k) => {
              const last = l.values.length - 1
              const below = ends[k] < Math.max(...ends)
              return (
                <g key={l.label} className={LINE[k]}>
                  <polyline points={l.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} className={s.linePath} />
                  <circle cx={x(0)} cy={y(l.values[0])} r={4} />
                  <circle cx={x(last)} cy={y(l.values[last])} r={4} />
                  <text x={x(0) - 8} y={y(l.values[0]) - 8} className={s.valueText}>{l.values[0]}</text>
                  <text x={x(last) + 8} y={below ? y(l.values[last]) + 18 : y(l.values[last]) - 8} textAnchor="end" className={s.valueText}>{l.values[last]}</text>
                </g>
              )
            })}
          </Chart>
        </div>
      </div>
      <div className={s.events}>{trend.events.map((e, k) => <div key={e.text} className={s.event}><span className={s.dot}>{k + 1}</span><span>{e.text}</span></div>)}</div>
      <Takeaway text={trend.takeaway} />
      <Proofs proofs={trend.proofs} />
    </>
  )
}

// Under 11 is page 1, because 10.9 shows as 10 in Search Console.
const cell = (v: number | null) => (v === null ? s.qNone : v < 4 ? s.qTop : v < 11 ? s.qPage1 : v < 21 ? s.qPage2 : s.qLow)

function Quarters({ quarters }: { quarters: BriefCase['quarters'] }) {
  return (
    <>
      <PhoneTableCards className={s.tableWrapFlat}>
        <table className={s.qTable}>
          <thead>
            <tr>
              <th>Search</th><th>Searches a month</th>
              {quarters.columns.map((c, i) => {
                const link = quarters.links?.[i]
                return <th key={c}>{link ? <a href={link} target="_blank" rel="noopener noreferrer" className={s.proofLink}>{c}<span className="sr-only"> (opens the report in a new tab)</span></a> : c}</th>
              })}
            </tr>
          </thead>
          <tbody>
            {quarters.rows.map(row => (
              <tr key={row.keyword}>
                <td>{row.keyword}</td>
                <td className={s.muted}>{row.demand}</td>
                {row.values.map((v, i) => {
                  const clicks = row.clicks?.[i]
                  return (
                    <td key={quarters.columns[i]}>
                      <span className={`${s.qCell} ${cell(v)}`}>{v === null ? '—' : v.toFixed(1)}</span>
                      {clicks !== undefined && clicks !== null && <small className={s.qClicks}>{clicks} {clicks === 1 ? 'click' : 'clicks'}</small>}
                    </td>
                  )
                })}
              </tr>
            ))}
            {quarters.totals.map(total => (
              <tr key={total.label} className={s.qTotal}>
                <td>{total.label}</td>
                <td />
                {total.values.map((v, i) => <td key={quarters.columns[i]}>{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </PhoneTableCards>
      <div className={s.legend}>
        <span><s className={s.qTop} />Top 3</span><span><s className={s.qPage1} />Page 1</span><span><s className={s.qPage2} />Page 2</span><span><s className={s.qLow} />Page 3 or lower</span>
      </div>
      <Takeaway text={quarters.caveat} label="Read this first" />
      <Takeaway text={quarters.takeaway} />
      <Proofs proofs={quarters.proofs} />
    </>
  )
}

function Leads({ leads }: { leads: BriefCase['leads'] }) {
  return (
    <>
      <div className={s.flow}>
        {leads.steps.map((step, i) => (
          <div key={step.label} className={s.flowItem}>
            {i > 0 && <span className={s.arrow} aria-hidden>→</span>}
            <div className={`${s.flowStep}${step.tone ? ` ${s.flowOpen}` : ''}`}>
              <span className={s.flowValue}>{step.value}</span>
              <span className={s.strong}>{step.label}</span>
              <span className={s.small}>{step.note}</span>
            </div>
          </div>
        ))}
      </div>
      <Table head={leads.head} rows={leads.rows} />
      <Takeaway text={leads.takeaway} />
      <Proofs proofs={leads.proofs} />
    </>
  )
}

const Lines = ({ items }: { items: { title: string; text: string }[] }) => items.map(item => (
  <div key={item.title} className={s.line}><div className={s.strong}>{item.title}</div><div className={s.small}>{item.text}</div></div>
))

/** The brief drawn as a case for a decision: the evidence first, then the claims, then how to hold the conversation. */
export function CaseBrief({ brief }: { brief: Case }) {
  return (
    <div className={s.page}>
      <section className={`boe-panel ${s.message}`} aria-label="The message">
        <div className={s.heroMain}>
          <div className={s.kicker}>The one message for this meeting</div>
          <h1 className={s.messageText}>{brief.message}</h1>
          <p className={s.small}>{brief.subtitle}</p>
          <div className={s.beforeBox}>
            <div className={s.sideTitle}><Tag tag={{ text: 'Expert check', tone: 'wait' }} /> Before you start</div>
            <ul className={s.checkList}>{brief.before.map(line => <li key={line}>{line}</li>)}</ul>
          </div>
          {brief.evidence && (
            <a href={brief.evidence.url} target="_blank" rel="noopener noreferrer" className={`${s.proofLink} ${s.evidence}`}>{brief.evidence.text}<span className="sr-only"> (opens in a new tab)</span></a>
          )}
        </div>
        {brief.headline && (
          <div className={s.heroSide}>
            <div className={s.sideTitle}>{brief.headline.title}</div>
            {brief.headline.items.map(item => (
              <div key={item.label} className={s.headline}>
                <span>{item.label}<small>{item.note}</small></span>
                <b className={item.tone === 'bad' ? s.down : item.tone === 'good' ? s.up : undefined}>{item.value}</b>
              </div>
            ))}
          </div>
        )}
      </section>

      {brief.trend && <section className="boe-panel" aria-label={brief.trend.title}><Head title={brief.trend.title} note={brief.trend.note} /><Trend trend={brief.trend} /></section>}
      {brief.quarters && <section className="boe-panel" aria-label={brief.quarters.title}><Head title={brief.quarters.title} note={brief.quarters.note} /><Quarters quarters={brief.quarters} /></section>}
      {brief.leads && <section className="boe-panel" aria-label={brief.leads.title}><Head title={brief.leads.title} note="Not to scale" /><Leads leads={brief.leads} /></section>}

      {brief.findings && (
        <section className="boe-panel" aria-label="What else went wrong">
          <Head title="What else went wrong, biggest first" note="Each with the report behind it" />
          {brief.findings.map(item => (
            <article key={item.title} className={s.claim}>
              <div className={s.claimTop}><h3 className={s.claimTitle}>{item.title}</h3><Tag tag={item.tag} /></div>
              <p className={s.findingNumber}>{item.number}</p>
              {item.example && <p className={s.small}>{item.example}</p>}
              <Proofs proofs={item.proofs} />
            </article>
          ))}
        </section>
      )}

      {brief.base && (
        <section className="boe-panel" aria-label={brief.base.title}>
          <Head title={brief.base.title} note={brief.base.note} />
          <Table head={brief.base.head} rows={brief.base.rows} highlightFirst />
          <Takeaway text={brief.base.takeaway} />
          <Proofs proofs={brief.base.proofs} />
        </section>
      )}

      {brief.risers && (
        <section className="boe-panel" aria-label={brief.risers.title}>
          <Head title={brief.risers.title} note={brief.risers.note} />
          <div className={s.risers}>
            {brief.risers.rows.map(row => (
              <div key={row.site} className={s.riser}>
                <div className={s.riseValue}><span className={s.muted}>{row.from}</span> → <b className={s.up}>{row.to}</b></div>
                <div className={s.strong}>{row.site}</div>
                <div className={s.small}>{row.text}</div>
              </div>
            ))}
          </div>
          <Takeaway text={brief.risers.fair} label="Be fair" />
          <Proofs proofs={brief.risers.proofs} />
        </section>
      )}

      {brief.claims && (
        <section className="boe-panel" aria-label="The claims, tested">
          <Head title="The claims, tested" note="Our data, what Google says, and what to say" />
          {brief.claims.map(claim => (
            <article key={claim.claim} className={s.claim}>
              <div className={s.claimTop}><h3 className={s.claimTitle}>&ldquo;{claim.claim}&rdquo;</h3><Tag tag={claim.tag} /></div>
              <div className={s.claimCols}>
                <div><div className={s.miniHead}>Our data</div><ul className={s.bullets}>{claim.data.map(line => <li key={line}>{line}</li>)}</ul></div>
                <div><div className={s.miniHead}>What Google and research say</div><ul className={s.bullets}>{claim.research.map(line => <li key={line}>{line}</li>)}</ul></div>
              </div>
              <div className={s.say}><b>Say:</b> {claim.say}</div>
              <Proofs proofs={claim.proofs} />
            </article>
          ))}
        </section>
      )}

      {brief.hisPlan && (
        <section className="boe-panel" aria-label={brief.hisPlan.title}>
          <Head title={brief.hisPlan.title} note={brief.hisPlan.note} />
          <PhoneTableCards className={`${s.tableWrapFlat} ${s.padded}`}>
            <table className={`${s.table} ${s.caseTable} ${s.planTable}`}>
              <thead><tr><th>His plan says</th><th>What the data says</th><th>Verdict</th></tr></thead>
              <tbody>{brief.hisPlan.rows.map(row => <tr key={row.point}><td>{row.point}</td><td>{row.answer}</td><td><Tag tag={row.tag} /></td></tr>)}</tbody>
            </table>
          </PhoneTableCards>
          <Proofs proofs={brief.hisPlan.proofs} />
        </section>
      )}

      {brief.missed && (
        <section className="boe-panel" aria-label="What was missed or done wrong">
          <Head title="What was missed or done wrong" note="Each one checked against Google's data" />
          <div className={s.missed}>
            {brief.missed.map(item => (
              <div key={item.title} className={s.missItem}>
                <div className={s.moveTop}><span className={s.strong}>{item.title}</span><Tag tag={item.tag} /></div>
                <div className={s.small}>{item.text}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {brief.counters && (
        <section className="boe-panel" aria-label="If he says, you answer">
          <Head title="If he says… you answer" note="Agree where he is right; it makes the rest stronger" />
          {brief.counters.map(row => (
            <div key={row.says} className={s.counter}><div className={s.saysText}>&ldquo;{row.says}&rdquo;</div><div><div className={s.small}>{row.answer}</div><Proofs proofs={row.proofs} /></div></div>
          ))}
        </section>
      )}

      {brief.freelance && (
        <section className="boe-panel" aria-label={brief.freelance.title}>
          <Head title={brief.freelance.title} note={brief.freelance.note} />
          {brief.freelance.rows.map(row => (
            <div key={row.title} className={s.line}>
              <div className={s.strong}>{row.title}</div>
              <div className={s.small}>{row.text}</div>
              <Proofs proofs={row.proofs} />
            </div>
          ))}
        </section>
      )}

      <section className={s.two} aria-label="Credit and fairness">
        <div className="boe-panel"><Head title="Give credit first" note="True, and worth saying" /><Lines items={brief.credit} /></div>
        <div className="boe-panel"><Head title="Be fair: not on him" /><Lines items={brief.fair} /></div>
      </section>

      {brief.plan && (
        <section className="boe-panel" aria-label={brief.plan.title}>
          <Head title={brief.plan.title} note={brief.plan.note} />
          <Table head={['Work', 'Who', 'When']} rows={brief.plan.rows.map(r => [r.task, r.who, r.when])} />
          <ul className={`${s.bullets} ${s.risks}`}>{brief.plan.risks.map(line => <li key={line}>{line}</li>)}</ul>
        </section>
      )}

      {brief.talk && (
        <section className="boe-panel" aria-label={brief.talk.title}>
          <Head title={brief.talk.title} note={brief.talk.note} />
          <ol className={s.talk}>
            {brief.talk.steps.map((step, i) => (
              <li key={step.title}>
                <span className={s.number}>{i + 1}</span>
                <div>
                  <div className={s.strong}>{step.title}</div>
                  <div className={s.small}>{step.text}</div>
                  {step.say && <div className={s.sayLine}>&ldquo;{step.say}&rdquo;</div>}
                </div>
              </li>
            ))}
          </ol>
          <div className={`${s.two} ${s.talkTwo}`}>
            <div className={s.careBox}><div className={s.miniHead}>Avoid</div><ul className={s.bullets}>{brief.talk.avoid.map(line => <li key={line}>{line}</li>)}</ul></div>
            <div className={s.careBox}><div className={s.miniHead}>Look after him, and the site</div><ul className={s.bullets}>{brief.talk.care.map(line => <li key={line}>{line}</li>)}</ul></div>
          </div>
        </section>
      )}

      <Proof proof={brief.proof} />
      <p className={s.foot}>{brief.foot}{brief.sources?.length ? ` Sources. ${brief.sources.join(' ')}` : ''}</p>
    </div>
  )
}
