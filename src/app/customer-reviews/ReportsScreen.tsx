'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import type { SupabaseClient } from '@supabase/supabase-js'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { ReviewSheet } from '@/components/customerReviews/ReviewSheet'
import { ReviewBadge } from '@/components/customerReviews/ReviewPieces'
import { StackedBarChart } from '@/components/customerReviews/ReviewCharts'
import styles from './reports.module.css'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { formatCredits, reviewMonthLabel } from '@/lib/boeCredits/ledger'
import { istDateOf } from '@/lib/istDate'
import {
  CUSTOM_REVIEW_TYPE_LABELS,
  CUSTOM_SUBMISSION_STATUS_META,
  customSubmissionErrorMessage,
  formatSubmissionDay,
} from '@/lib/customerReviews/customSubmissions'
import { REVIEW_TYPE_META } from '@/lib/customerReviews/types'
import {
  FOCUS_LABELS,
  NO_REPORT_FILTERS,
  REPORT_PAGE_SIZE,
  contributors,
  monthChoices,
  parseReportList,
  parseReviewReport,
  reconciliationProblems,
  shortDay,
  type EmployeeRow,
  type ReportFilters,
  type ReportFocus,
  type ReviewReport,
  type ReviewStatusKey,
  type ReviewTypeKey,
} from '@/lib/customerReviews/reviewReport'

// ── Reports: the verifier's dashboard ────────────────────────────────────────
//
// One server-side aggregate (customer_review_report) feeds every card, chart and
// table on this page, so they cannot disagree; the page checks that they
// reconcile and says so instead of drawing a dashboard whose parts contradict each
// other. No review text or screenshot is downloaded to build a total: the list
// behind a card is one page of references, status, type and dates.
//
// SUBMITTED AND REWARD-ELIGIBLE ARE SEPARATE NUMBERS and both are shown. A review
// is exactly one type (text or image), so text + image = submitted.
//
// A card or an employee row opens the matching list. The database checks
// customer_review_requests.verify on every call; the redirect below only avoids
// showing a non-verifier a page that would refuse them.

const STATUS_OPTIONS: { value: ReviewStatusKey; label: string }[] = [
  { value: 'pending_verification', label: 'Pending Approval' },
  { value: 'approved',             label: 'Approved' },
  { value: 'rejected',             label: 'Rejected' },
]

type OpenList = { focus: ReportFocus; employee: string | null; employeeName: string | null }

const selectStyle: React.CSSProperties = {
  width: '100%', minHeight: '44px', padding: '8px 10px', borderRadius: '8px', fontSize: '13px',
  border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.primary, fontFamily: 'inherit',
}

async function fetchReport(supabase: SupabaseClient, f: ReportFilters): Promise<ReviewReport> {
  const { data, error } = await supabase.rpc('customer_review_report', {
    p_month: f.month, p_employee: f.employee, p_type: f.type, p_status: f.status,
  })
  if (error) throw new Error(customSubmissionErrorMessage(error.message, 'The report could not be loaded.'))
  const report = parseReviewReport(data)
  if (!report) throw new Error('The report came back in a shape this screen does not understand.')
  return report
}

export function ReportsScreen() {
  const { supabase, profile, caps, loading, signOut } = useCustomerReviews()
  const router = useRouter()
  const [filters, setFilters] = useState<ReportFilters>(NO_REPORT_FILTERS)
  const [open, setOpen] = useState<OpenList | null>(null)

  useEffect(() => {
    if (loading) return
    if (!caps.canVerify) router.replace('/customer-reviews')
  }, [loading, caps.canVerify, router])

  const query = useQuery({
    queryKey: ['customer-reviews', 'report', filters],
    enabled: !loading && caps.canVerify,
    queryFn: () => fetchReport(supabase, filters),
    staleTime: 30 * 1000,
    retry: false,
  })

  const report = query.data ?? null
  const problems = useMemo(() => (report ? reconciliationProblems(report) : []), [report])
  const month = filters.month ?? report?.current_month ?? null

  if (loading) return <LoadingScreen />

  const set = (patch: Partial<ReportFilters>) => setFilters(prev => ({ ...prev, ...patch }))

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="Reports"
      subtitle="Custom reviews submitted, by month, type and employee"
      canVerify={caps.canVerify}
      onSignOut={signOut}
    >
      <div style={{ maxWidth: '1120px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <Filters report={report} filters={filters} onChange={set} onReset={() => setFilters(NO_REPORT_FILTERS)} />

        {query.isPending ? (
          <p role="status" style={{ margin: 0, fontSize: '12.5px', color: colors.muted }}>Loading the report…</p>
        ) : query.isError || !report ? (
          <div role="alert" style={{
            padding: '14px 16px', borderRadius: '10px', border: '1px solid #FECACA', background: '#FEF2F2', color: '#B91C1C',
            fontSize: '13px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>{query.error instanceof Error ? query.error.message : 'The report could not be loaded.'}</span>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => { void query.refetch() }} style={{ minHeight: '44px', padding: '7px 14px', fontSize: '12.5px' }}>
              Try again
            </button>
          </div>
        ) : problems.length > 0 ? (
          <div role="alert" style={{ padding: '14px 16px', borderRadius: '10px', border: '1px solid #FECACA', background: '#FEF2F2', color: '#B91C1C', fontSize: '13px' }}>
            The report&rsquo;s figures do not agree with each other, so it is not shown ({problems[0]}). Refresh and try again; if it persists, tell an administrator.
          </div>
        ) : (
          <ReportBody
            report={report}
            monthLabel={month ? reviewMonthLabel(month) : ''}
            onOpen={(focus, employee, employeeName) => setOpen({ focus, employee: employee ?? null, employeeName: employeeName ?? null })}
          />
        )}
      </div>

      {open && report && (
        <ReviewListSheet
          supabase={supabase}
          filters={filters}
          month={report.month}
          open={open}
          monthLabel={reviewMonthLabel(report.month)}
          onClose={() => setOpen(null)}
        />
      )}
    </CustomerReviewsLayout>
  )
}

function Filters({
  report, filters, onChange, onReset,
}: {
  report: ReviewReport | null
  filters: ReportFilters
  onChange: (patch: Partial<ReportFilters>) => void
  onReset: () => void
}) {
  const current = report?.current_month ?? null
  const months = current ? monthChoices(current) : []
  const active = filters.employee != null || filters.type != null || filters.status != null || filters.month != null
  return (
    <section aria-label="Filters" style={{
      display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))', alignItems: 'end',
    }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 600, color: colors.secondary }}>
        Month
        <select
          value={filters.month ?? ''}
          onChange={e => onChange({ month: e.target.value === '' ? null : e.target.value })}
          style={selectStyle}
        >
          <option value="">Current month</option>
          {months.slice(1).map(m => <option key={m} value={m}>{reviewMonthLabel(m)}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 600, color: colors.secondary }}>
        Employee
        <select value={filters.employee ?? ''} onChange={e => onChange({ employee: e.target.value === '' ? null : e.target.value })} style={selectStyle}>
          <option value="">All employees</option>
          {(report?.employees ?? []).map(e => <option key={e.employee_id} value={e.employee_id}>{e.name}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 600, color: colors.secondary }}>
        Type
        <select value={filters.type ?? ''} onChange={e => onChange({ type: (e.target.value || null) as ReviewTypeKey | null })} style={selectStyle}>
          <option value="">Text and Image</option>
          <option value="text">Text Review</option>
          <option value="image">Image Review</option>
        </select>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 600, color: colors.secondary }}>
        Status
        <select value={filters.status ?? ''} onChange={e => onChange({ status: (e.target.value || null) as ReviewStatusKey | null })} style={selectStyle}>
          <option value="">Any status</option>
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {active && (
        <button type="button" className="boe-btn boe-btn-ghost" onClick={onReset} style={{ minHeight: '44px', padding: '8px 14px', fontSize: '12.5px' }}>
          Clear filters
        </button>
      )}
    </section>
  )
}

const card: React.CSSProperties = {
  padding: '12px 14px', borderRadius: '10px', border: `1px solid ${colors.borderSoft}`, background: colors.base, minWidth: 0,
}
const h2: React.CSSProperties = {
  margin: '0 0 8px', fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: colors.primary,
}

function ReportBody({
  report, monthLabel, onOpen,
}: {
  report: ReviewReport
  monthLabel: string
  onOpen: (focus: ReportFocus, employee?: string, employeeName?: string) => void
}) {
  const s = report.summary
  const top = contributors(report.employees)
  const empty = s.submitted === 0

  return (
    <>
      <section aria-label={`${monthLabel} summary`} style={{
        display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 170px), 1fr))',
      }}>
        <MetricCard label="Total submitted" value={s.submitted} note={`${monthLabel} · not deleted`} onClick={() => onOpen('all')} />
        <MetricCard label="Text reviews" value={s.text} note={`${s.eligible_text} reward-eligible`} onClick={() => onOpen('text')} />
        <MetricCard label="Image reviews" value={s.image} note={`${s.eligible_image} reward-eligible`} onClick={() => onOpen('image')} />
        <MetricCard
          label="Possible duplicates awaiting a decision"
          value={s.duplicates_open}
          note={s.duplicates_open === 0 ? 'Nothing waiting' : 'Open to decide'}
          tone={s.duplicates_open > 0 ? 'amber' : undefined}
          onClick={() => onOpen('duplicates')}
        />
      </section>

      <section aria-label="Reward-eligible" style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: '8px 24px', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => onOpen('eligible')}
          style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', minHeight: '44px' }}
        >
          <div style={{ fontSize: '12px', color: colors.secondary }}>Reward-eligible reviews</div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
            {s.eligible} <span style={{ fontSize: '12.5px', fontWeight: 500, color: colors.muted }}>of {s.submitted} submitted</span>
          </div>
        </button>
        <Figure label="Review credits" value={formatCredits(s.credits)} />
        <Figure label={`Review points (credits × ${report.points_per_credit})`} value={String(s.points)} />
        <p style={{ margin: 0, flex: '1 1 260px', fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
          Eligible means approved with a live credit: not deleted, reversed or lost to a closed month. Points are for {monthLabel} only and start again next month.
        </p>
      </section>

      {empty && (
        <p style={{ margin: 0, padding: '14px 16px', borderRadius: '10px', border: `1px dashed ${colors.border}`, color: colors.muted, fontSize: '13px' }}>
          No reviews were submitted in {monthLabel} for these filters.
        </p>
      )}

      <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))' }}>
        <section style={card}>
          <h2 style={h2}>Daily · {monthLabel}</h2>
          <StackedBarChart
            title={`Daily reviews, ${monthLabel}`}
            description={`${s.submitted} reviews submitted in ${monthLabel}: ${s.text} text and ${s.image} image, one bar per day.`}
            bars={report.daily.map(d => ({ key: d.day, label: shortDay(d.day), text: d.text, image: d.image }))}
            tickEvery={5}
          />
        </section>
        <section style={card}>
          <h2 style={h2}>Monthly history</h2>
          <StackedBarChart
            title="Monthly reviews, last 12 months"
            description="Reviews submitted in each of the last twelve months, split into text and image."
            bars={report.history.map(m => ({ key: m.month, label: reviewMonthLabel(m.month, { year: false }).slice(0, 3), text: m.text, image: m.image }))}
            tickEvery={1}
          />
          <p style={{ margin: '6px 0 0', fontSize: '11.5px', color: colors.muted }}>
            Reward-eligible by month: {report.history.map(m => `${reviewMonthLabel(m.month, { year: false }).slice(0, 3)} ${m.eligible}`).join(' · ')}
          </p>
        </section>
      </div>

      <section style={card}>
        <h2 style={h2}>By type and status</h2>
        <ul className={styles.narrowList}>
          {report.categories.map(c => (
            <li key={c.type} className={styles.rowCard}>
              <h3 className={styles.rowTitle} style={{ color: REVIEW_TYPE_META[c.type].color }}>{CUSTOM_REVIEW_TYPE_LABELS[c.type]}</h3>
              <dl className={styles.facts}>
                <div><dt>Pending</dt><dd>{c.pending}</dd></div>
                <div><dt>Approved</dt><dd>{c.approved}</dd></div>
                <div><dt>Rejected</dt><dd>{c.rejected}</dd></div>
                <div><dt>Submitted</dt><dd>{c.submitted}</dd></div>
                <div><dt>Eligible</dt><dd>{c.eligible}</dd></div>
                <div><dt>Credits</dt><dd>{formatCredits(c.credits)}</dd></div>
              </dl>
            </li>
          ))}
        </ul>
        <div className={styles.wideOnly} style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px', minWidth: '520px' }}>
            <thead>
              <tr>
                {['Type', 'Pending', 'Approved', 'Rejected', 'Submitted', 'Eligible', 'Credits'].map((h, i) => (
                  <th key={h} scope="col" style={th(i === 0)}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.categories.map(c => (
                <tr key={c.type}>
                  <th scope="row" style={{ ...td(true), fontWeight: 700, color: REVIEW_TYPE_META[c.type].color }}>{CUSTOM_REVIEW_TYPE_LABELS[c.type]}</th>
                  <td style={td(false)}>{c.pending}</td>
                  <td style={td(false)}>{c.approved}</td>
                  <td style={td(false)}>{c.rejected}</td>
                  <td style={td(false)}>{c.submitted}</td>
                  <td style={td(false)}>{c.eligible}</td>
                  <td style={td(false)}>{formatCredits(c.credits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ margin: '6px 0 0', fontSize: '11.5px', color: colors.muted }}>
          Custom reviews are classified by review type only; there is no other category.
        </p>
      </section>

      <section style={card}>
        <h2 style={h2}>Contributors · {monthLabel}</h2>
        <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', marginBottom: '10px' }}>
          {top.allTied ? (
            <p style={{ margin: 0, fontSize: '12.5px', color: colors.secondary }}>
              Every employee is on {report.employees[0]?.submitted ?? 0} submitted {report.employees[0]?.submitted === 1 ? 'review' : 'reviews'}.
            </p>
          ) : (
            <>
              <ContributorNote label="Highest" rows={top.highest} />
              <ContributorNote label="Lowest" rows={top.lowest} />
            </>
          )}
        </div>
        <ul className={styles.narrowList}>
          {report.employees.map(e => (
            <li key={e.employee_id} className={styles.rowCard}>
              <button
                type="button"
                onClick={() => onOpen('all', e.employee_id, e.name)}
                style={{
                  background: 'none', border: 0, padding: '6px 0', minHeight: '44px', cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'inherit', fontSize: '13px', fontWeight: 700, color: colors.primary, overflowWrap: 'anywhere',
                  textDecoration: 'underline', textDecorationColor: colors.borderSoft,
                }}
              >
                {e.name}
              </button>
              <dl className={styles.facts}>
                <div><dt>Submitted</dt><dd>{e.submitted}</dd></div>
                <div><dt>Eligible</dt><dd>{e.eligible}</dd></div>
                <div><dt>Text</dt><dd>{e.text}</dd></div>
                <div><dt>Image</dt><dd>{e.image}</dd></div>
                <div><dt>Credits</dt><dd>{formatCredits(e.credits)}</dd></div>
                <div><dt>Points</dt><dd>{e.points}</dd></div>
              </dl>
            </li>
          ))}
          <li className={styles.rowCard}>
            <h3 className={styles.rowTitle}>Total</h3>
            <dl className={styles.facts}>
              <div><dt>Submitted</dt><dd>{s.submitted}</dd></div>
              <div><dt>Eligible</dt><dd>{s.eligible}</dd></div>
              <div><dt>Text</dt><dd>{s.text}</dd></div>
              <div><dt>Image</dt><dd>{s.image}</dd></div>
              <div><dt>Credits</dt><dd>{formatCredits(s.credits)}</dd></div>
              <div><dt>Points</dt><dd>{s.points}</dd></div>
            </dl>
          </li>
        </ul>
        <div className={styles.wideOnly} style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px', minWidth: '640px' }}>
            <thead>
              <tr>
                {['Employee', 'Submitted', 'Text', 'Image', 'Eligible', 'Credits', 'Points'].map((h, i) => (
                  <th key={h} scope="col" style={th(i === 0)}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.employees.map(e => (
                <tr key={e.employee_id}>
                  <th scope="row" style={td(true)}>
                    <button
                      type="button"
                      onClick={() => onOpen('all', e.employee_id, e.name)}
                      style={{
                        background: 'none', border: 0, padding: '6px 0', minHeight: '44px', cursor: 'pointer',
                        fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600, color: colors.primary, textAlign: 'left',
                        textDecoration: 'underline', textDecorationColor: colors.borderSoft,
                      }}
                    >
                      {e.name}
                    </button>
                  </th>
                  <td style={td(false)}>{e.submitted}</td>
                  <td style={td(false)}>{e.text}</td>
                  <td style={td(false)}>{e.image}</td>
                  <td style={td(false)}>{e.eligible}</td>
                  <td style={td(false)}>{formatCredits(e.credits)}</td>
                  <td style={td(false)}>{e.points}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" style={{ ...td(true), fontWeight: 700 }}>Total</th>
                <td style={{ ...td(false), fontWeight: 700 }}>{s.submitted}</td>
                <td style={{ ...td(false), fontWeight: 700 }}>{s.text}</td>
                <td style={{ ...td(false), fontWeight: 700 }}>{s.image}</td>
                <td style={{ ...td(false), fontWeight: 700 }}>{s.eligible}</td>
                <td style={{ ...td(false), fontWeight: 700 }}>{formatCredits(s.credits)}</td>
                <td style={{ ...td(false), fontWeight: 700 }}>{s.points}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </>
  )
}

function th(left: boolean): React.CSSProperties {
  return {
    padding: '6px 10px', textAlign: left ? 'left' : 'right', fontSize: '11px', fontWeight: 700, letterSpacing: '0.03em',
    textTransform: 'uppercase', color: colors.secondary, borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap',
  }
}
function td(left: boolean): React.CSSProperties {
  return {
    padding: '4px 10px', textAlign: left ? 'left' : 'right', color: colors.primary, fontWeight: 400,
    borderBottom: `1px solid ${colors.borderSoft}`, fontVariantNumeric: 'tabular-nums',
  }
}

function MetricCard({
  label, value, note, tone, onClick,
}: { label: string; value: number; note: string; tone?: 'amber'; onClick: () => void }) {
  const amber = tone === 'amber'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${value}. Open the list.`}
      style={{
        ...card, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', minHeight: '44px',
        borderColor: amber ? '#FDE68A' : colors.borderSoft, background: amber ? '#FFFBEB' : colors.base,
      }}
    >
      <div style={{ fontSize: '11.5px', fontWeight: 600, color: amber ? '#92400E' : colors.secondary, lineHeight: 1.35 }}>{label}</div>
      <div style={{ fontSize: '26px', fontWeight: 700, color: amber ? '#92400E' : colors.primary, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: '11.5px', color: colors.muted }}>{note}</div>
    </button>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '12px', color: colors.secondary }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

function ContributorNote({ label, rows }: { label: string; rows: EmployeeRow[] }) {
  if (rows.length === 0) return null
  const count = rows[0].submitted
  return (
    <div style={{ fontSize: '12.5px', lineHeight: 1.5, color: colors.primary }}>
      <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: colors.secondary }}>
        {label}{rows.length > 1 ? ` · ${rows.length} tied` : ''}
      </div>
      <div style={{ overflowWrap: 'anywhere' }}>
        {rows.map(r => r.name).join(', ')} — {count} {count === 1 ? 'review' : 'reviews'}
      </div>
    </div>
  )
}

// ─── The list behind a card or a row ──────────────────────────────────────────

function ReviewListSheet({
  supabase, filters, month, monthLabel, open, onClose,
}: {
  supabase: SupabaseClient
  filters: ReportFilters
  month: string
  monthLabel: string
  open: OpenList
  onClose: () => void
}) {
  const [offset, setOffset] = useState(0)
  const employee = open.employee ?? filters.employee

  const list = useQuery({
    queryKey: ['customer-reviews', 'report-list', month, employee, filters.type, filters.status, open.focus, offset],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('customer_review_report_list', {
        p_month: month, p_employee: employee, p_type: filters.type, p_status: filters.status,
        p_focus: open.focus, p_limit: REPORT_PAGE_SIZE, p_offset: offset,
      })
      if (error) throw new Error(customSubmissionErrorMessage(error.message, 'The list could not be loaded.'))
      const parsed = parseReportList(data)
      if (!parsed) throw new Error('The list came back in a shape this screen does not understand.')
      return parsed
    },
    retry: false,
    placeholderData: prev => prev,
  })

  const data = list.data
  const from = data && data.total > 0 ? data.offset + 1 : 0
  const to = data ? Math.min(data.offset + data.rows.length, data.total) : 0

  return (
    <ReviewSheet
      title={FOCUS_LABELS[open.focus]}
      subtitle={`${monthLabel}${open.employeeName ? ` · ${open.employeeName}` : ''}`}
      maxWidth="720px"
      onClose={onClose}
      footer={data && data.total > REPORT_PAGE_SIZE ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: colors.secondary }}>Showing {from}–{to} of {data.total}</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="boe-btn boe-btn-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - REPORT_PAGE_SIZE))}
              style={{ minHeight: '44px', padding: '7px 14px', fontSize: '12.5px' }}>Previous</button>
            <button type="button" className="boe-btn boe-btn-ghost" disabled={to >= data.total} onClick={() => setOffset(offset + REPORT_PAGE_SIZE)}
              style={{ minHeight: '44px', padding: '7px 14px', fontSize: '12.5px' }}>Next</button>
          </div>
        </div>
      ) : undefined}
    >
      {list.isPending ? (
        <p role="status" style={{ margin: 0, fontSize: '12.5px', color: colors.muted }}>Loading reviews…</p>
      ) : list.isError || !data ? (
        <p role="alert" style={{ margin: 0, fontSize: '12.5px', color: colors.red }}>
          {list.error instanceof Error ? list.error.message : 'The list could not be loaded.'}
        </p>
      ) : data.rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: '13px', color: colors.muted }}>Nothing matches.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {data.rows.map(r => (
            <li key={r.id} style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                  <strong style={{ fontSize: '13px', color: colors.primary }}>{r.employee_name}</strong>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: REVIEW_TYPE_META[r.review_type].color }}>{CUSTOM_REVIEW_TYPE_LABELS[r.review_type]}</span>
                  <ReviewBadge meta={CUSTOM_SUBMISSION_STATUS_META[r.status]} />
                  {r.duplicate_open && <span style={{ fontSize: '11px', fontWeight: 700, color: '#92400E' }}>Possible duplicate</span>}
                  {r.reward_held && <span style={{ fontSize: '11px', fontWeight: 600, color: '#3B5BC0' }}>Edited · awaiting re-approval</span>}
                </div>
                <div style={{ fontSize: '12px', color: colors.secondary, fontVariantNumeric: 'tabular-nums' }}>
                  {r.submission_ref} · Submitted {formatSubmissionDay(istDateOf(r.submitted_at))} · Published {formatSubmissionDay(r.published_on)}
                </div>
              </div>
              <div style={{ fontSize: '12px', color: r.eligible ? '#047857' : colors.muted, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {r.eligible ? `Eligible · ${formatCredits(r.credits)} · ${r.points} pts` : 'Not eligible'}
              </div>
              <Link href={`/customer-reviews/custom?submission=${r.id}`} className="boe-btn boe-btn-ghost"
                style={{ minHeight: '44px', padding: '7px 14px', fontSize: '12.5px', display: 'inline-flex', alignItems: 'center' }}>
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ReviewSheet>
  )
}
