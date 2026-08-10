'use client'

// The payroll guide's illustrations.
//
// Every one of these explains a rule, a relationship or a calculation. None is
// decoration: the funnel shows how four figures produce a fifth, the week strip
// shows how a day becomes a payable-day value, and the leave diagram shows the
// one thing about paid leave employees get wrong — that it settles the EARLIEST
// item of the month rather than the largest.
//
// Built from CSS and inline SVG. No image is fetched, no dependency is added,
// and no emoji is used as an icon: the module already has lucide-react.
//
// ACCESSIBILITY
// -------------
// A purely decorative graphic is aria-hidden, so a screen reader is not read a
// list of meaningless shapes. Anything carrying information states that
// information in text too — colour is never the only signal, which is why every
// day cell prints its payable value in words beside its tone.

import type { AttendanceState } from './guideContent'

// The same three tones Payroll Result Detail uses for a day, so a state looks
// the same here as on the screen this page explains.
export const TONE_COLOR: Record<AttendanceState['tone'], string> = {
  good:    '#059669',
  caution: '#B45309',
  half:    '#7C5CD6',
  neutral: '#8C94A6',
}

/**
 * A tone's shape, so the states are distinguishable without colour.
 *
 * Filled circle / half circle / hollow circle / dash — four silhouettes that
 * survive greyscale, colour blindness and a bad projector.
 */
export function ToneGlyph({ tone, size = 12 }: { tone: AttendanceState['tone']; size?: number }) {
  const color = TONE_COLOR[tone]

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
      {tone === 'good' && <circle cx="12" cy="12" r="10" fill={color} />}
      {tone === 'half' && (
        <>
          <circle cx="12" cy="12" r="10" fill="none" stroke={color} strokeWidth="3" />
          <path d="M12 2 A10 10 0 0 1 12 22 Z" fill={color} />
        </>
      )}
      {tone === 'caution' && <circle cx="12" cy="12" r="10" fill="none" stroke={color} strokeWidth="3" />}
      {tone === 'neutral' && <rect x="3" y="10" width="18" height="4" rx="2" fill={color} />}
    </svg>
  )
}

// ─── A week, as payroll reads it ──────────────────────────────────────────────

type WeekCell = { day: string; label: string; payable: string; tone: AttendanceState['tone'] }

/**
 * One week, showing how each day becomes a payable-day value.
 *
 * This is the step that has no formula and is therefore hardest to describe in
 * a sentence: seven days in, "4½ payable days" out. The cells are an
 * illustration of the rule, labelled as such — not anybody's real week.
 */
export function PayableDaysWeek() {
  const cells: WeekCell[] = [
    { day: 'Mon', label: 'Full Present', payable: '1',   tone: 'good' },
    { day: 'Tue', label: 'Full Present', payable: '1',   tone: 'good' },
    { day: 'Wed', label: 'Half Day',     payable: '½',   tone: 'half' },
    { day: 'Thu', label: 'Absent',       payable: '0',   tone: 'caution' },
    { day: 'Fri', label: 'Missing Punch', payable: '1',  tone: 'caution' },
    { day: 'Sat', label: 'Full Present', payable: '1',   tone: 'good' },
    { day: 'Sun', label: 'Weekly Off',   payable: '—',   tone: 'neutral' },
  ]

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 5 }}>
        {cells.map(cell => (
          <div
            key={cell.day}
            title={cell.label}
            style={{
              border: `1px solid ${cell.tone === 'neutral' ? 'rgba(0,0,0,0.08)' : `${TONE_COLOR[cell.tone]}33`}`,
              background: cell.tone === 'neutral' ? 'rgba(0,0,0,0.02)' : `${TONE_COLOR[cell.tone]}0D`,
              borderRadius: 8,
              padding: '7px 4px 8px',
              textAlign: 'center',
              minWidth: 0,
            }}
          >
            <div style={{ fontSize: 9.5, fontWeight: 700, color: '#8C94A6', letterSpacing: '0.05em' }}>
              {cell.day.toUpperCase()}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '5px 0 4px' }}>
              <ToneGlyph tone={cell.tone} size={13} />
            </div>
            <div style={{
              fontSize: 12.5, fontWeight: 700, color: '#111318',
              fontVariantNumeric: 'tabular-nums', lineHeight: 1,
            }}>
              {cell.payable}
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: '#5B6474', marginTop: 8, lineHeight: 1.55 }}>
        An illustration of the rule, not a real week. Six working days here, worth{' '}
        <strong style={{ color: '#3D4455' }}>4½ payable days</strong> — the half day counts as
        half, the absence as none, and the missing punch still counts as a present day. Sunday is
        not a working day at all.
      </div>
    </div>
  )
}

// ─── The salary funnel ────────────────────────────────────────────────────────

/**
 * Gross salary narrowing to Salary Payable.
 *
 * The one relationship the whole page is about, as a shape: the bar gets shorter
 * when attendance takes from it, and moves either way when adjustments are
 * applied. Proportions are illustrative and the figures are named, not numbered,
 * so nothing here can be mistaken for somebody's salary.
 */
export function SalaryFunnel() {
  const stages = [
    { label: 'Gross Salary',            width: '100%', color: '#4F6FD0', note: 'what the month starts at' },
    { label: '− Attendance Deductions', width: '82%',  color: '#B45309', note: 'what attendance cost' },
    { label: '± Net Adjustments',       width: '92%',  color: '#059669', note: 'balance brought forward, additions, recoveries' },
    { label: '= Salary Payable',        width: '92%',  color: '#111318', note: 'what BOE settles' },
  ]

  return (
    <div
      role="img"
      aria-label="Gross salary is reduced by attendance deductions, then moved up or down by net adjustments, to give salary payable."
    >
      {stages.map((stage, i) => (
        <div key={stage.label} style={{ marginBottom: i === stages.length - 1 ? 0 : 9 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            gap: 10, marginBottom: 4, flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#3D4455' }}>{stage.label}</span>
            <span style={{ fontSize: 11, color: '#8C94A6' }}>{stage.note}</span>
          </div>
          <div aria-hidden="true" style={{ height: 8, background: 'rgba(0,0,0,0.05)', borderRadius: 999 }}>
            <div style={{
              width: stage.width, height: '100%', borderRadius: 999,
              background: stage.color, opacity: i === stages.length - 1 ? 1 : 0.75,
            }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Paid leave absorption ────────────────────────────────────────────────────

/**
 * What the month's allowance settles, and what it does not.
 *
 * The misunderstanding this exists for: the allowance is spent on the EARLIEST
 * item it can cover, not the most expensive one. An employee absent on the 3rd
 * and again on the 24th has the 3rd covered, and the covered line stays on the
 * payslip showing ₹0 rather than disappearing.
 */
export function PaidLeaveAbsorption() {
  const items = [
    { date: '3 Jul',  label: 'Absent', outcome: 'covered', amount: '₹0' },
    { date: '24 Jul', label: 'Absent', outcome: 'charged', amount: 'one day’s pay' },
  ]

  return (
    <div
      role="img"
      aria-label="The month's paid leave covers the earliest absence, charging it zero; a later absence in the same month is charged in full."
    >
      {items.map(item => {
        const covered = item.outcome === 'covered'
        return (
          <div
            key={item.date}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 12px', borderRadius: 8, marginBottom: 7,
              border: `1px solid ${covered ? 'rgba(5,150,105,0.28)' : 'rgba(0,0,0,0.08)'}`,
              background: covered ? 'rgba(5,150,105,0.06)' : '#fff',
            }}
          >
            <span style={{
              fontSize: 11, fontWeight: 700, color: '#8C94A6',
              fontVariantNumeric: 'tabular-nums', minWidth: 46,
            }}>
              {item.date}
            </span>
            <span style={{ fontSize: 12.5, color: '#3D4455', fontWeight: 500 }}>{item.label}</span>
            <span style={{
              marginLeft: 'auto', fontSize: 12, fontWeight: 700,
              color: covered ? '#059669' : '#B45309', whiteSpace: 'nowrap',
            }}>
              {covered ? `Company paid · ${item.amount}` : `Charged · ${item.amount}`}
            </span>
          </div>
        )
      })}
      <div style={{ fontSize: 11.5, color: '#5B6474', lineHeight: 1.55, marginTop: 2 }}>
        The allowance settles the <strong style={{ color: '#3D4455' }}>earliest</strong> item of the
        month it can cover — not the largest. The covered line stays on your payslip showing ₹0, so
        the month still adds up.
      </div>
    </div>
  )
}
