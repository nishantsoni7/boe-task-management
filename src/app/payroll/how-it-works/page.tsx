'use client'

// How Payroll Works — the whole calculation, for somebody who has never seen one.
//
// SHAPE OF THE PAGE
// -----------------
// A calculation JOURNEY, not an essay. The eight step titles alone tell the
// story; everything below them is detail for the person who wants it. On desktop
// the journey sits in a two-thirds column with a guide rail beside it, so the
// width is used and the summary stays next to the explanation. On mobile the
// rail falls into the reading order after the journey it summarises.
//
// THE RULE THIS PAGE LIVES BY
// ---------------------------
// Not one number is typed into this file. Every threshold, rate, divisor and
// worked figure comes from ./guideContent, which derives them from the constants
// engine.ts and classification.ts calculate with. The only way to change what
// this page says is to change what the engine does.
//
// It reads no payroll record for anybody, which is what lets every employee see
// it (see PayrollGuard in ../layout.tsx).

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowRight, CalendarDays, ClipboardCheck, Coins, FileCheck2,
  Scale, Sigma, UploadCloud, Wallet,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { colors } from '@/lib/tokens'
import {
  RULE_CARDS,
  RULE_GROUP_LABELS,
  RULE_GROUP_ORDER,
  NOT_CALCULATED,
  GLOSSARY,
  SALARY_FLOW,
  EXAMPLE_SETTLEMENT,
  EXAMPLE_DEDUCTIONS,
  EXAMPLE_DEDUCTION_TOTAL,
  EXAMPLE_MONTHLY_SALARY,
  PER_DAY_DIVISOR,
} from '@/lib/payroll/rules'
import { fmtMoney, fmtSigned } from '@/lib/payroll/settlement'
import {
  ATTENDANCE_STATES,
  FORMULA_STRIP,
  ISSUE_FLOW,
  JOURNEY,
  KEY_NUMBERS,
  LEGACY_STATE_NOTE,
  PARAMETERS,
  SECTIONS,
  WHAT_CHANGES_PAY,
  guideActionsFor,
  type GuideAction,
  type JourneyStep,
} from './guideContent'
import { PaidLeaveAbsorption, PayableDaysWeek, SalaryFunnel, ToneGlyph } from './GuideVisuals'
import { AskAboutSalary } from './AskAboutSalary'

const ACCENT = '#4F6FD0'

/** One icon per journey step, from the module's existing icon library. */
const STEP_ICONS = [
  UploadCloud, ClipboardCheck, CalendarDays, Coins, Sigma, Scale, Wallet, FileCheck2,
] as const

export default function HowPayrollWorksPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [token,   setToken]   = useState('')
  const [loading, setLoading] = useState(true)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      setToken(session.access_token)

      const { data: prof } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      setProfile(prof ?? null)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  // Which onward links this person is offered. A usability split only — the
  // guards, the route handlers and RLS are what actually refuse access.
  const isAdmin = profile?.role === 'admin'
  const actions = guideActionsFor(!!isAdmin)

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="How Payroll Works"
      subtitle="Every figure on your payslip, and where it comes from."
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 1180 }}>

        {/* The shell prints the page title as a styled div, so the document has
            no h1 of its own. Supplying one here — hidden, because it would
            otherwise be the same words twice — puts the section h2s under a
            heading rather than starting the outline at level 2. */}
        <h1 className="payroll-guide-sr-only">How Payroll Works</h1>

        <Hero />

        {/* ── The journey, with the guide rail beside it ─────────────────── */}
        <div className="payroll-guide-layout" style={{ marginTop: 18 }}>
          <main style={{ minWidth: 0 }}>
            <SectionHeading
              id="journey"
              title="How a month is calculated"
              note="Eight steps. Each one uses the result of the one above it."
            />
            <div className="payroll-guide-steps">
              {JOURNEY.map((step, i) => (
                <JourneyStepRow
                  key={step.id}
                  step={step}
                  index={i + 1}
                  last={i === JOURNEY.length - 1}
                  extra={
                    step.id === 'payable-days' ? <PayableDaysWeek />
                    : step.id === 'deductions' ? <DeductionRates />
                    : step.id === 'paid-leave' ? <PaidLeaveAbsorption />
                    : step.id === 'payable'    ? <SalaryFunnel />
                    : null
                  }
                />
              ))}
            </div>
          </main>

          <GuideRail actions={actions} />
        </div>

        {/* ── A month, worked through ────────────────────────────────────── */}
        <SectionHeading
          id="example"
          title="A month, worked through"
          note="An example, so the arithmetic can be followed. These are not your figures — yours are on your payslip."
        />
        <WorkedExample />

        {/* ── What each day counts as ────────────────────────────────────── */}
        <SectionHeading
          id="states"
          title="What each day counts as"
          note="Every state a working day can be in, and what it does to the month."
        />
        <AttendanceStateTable />

        {/* ── The rules that affect pay ──────────────────────────────────── */}
        <SectionHeading
          id="parameters"
          title="The rules that affect pay"
          note="The attendance condition, what it costs, and whether review can change it. A flag is not automatically a deduction."
        />
        <ParameterTable />

        {/* ── If something looks wrong ───────────────────────────────────── */}
        <SectionHeading
          id="issues"
          title="If something looks wrong"
          note="How a month gets checked, and what happens when you report a problem."
        />
        <IssueFlow />
        <ActionRow actions={actions} />

        {/* ── Reference ──────────────────────────────────────────────────── */}
        <SectionHeading
          id="reference"
          title="Full rules and glossary"
          note="Every rule payroll actually applies. If a rule is not here, payroll does not do it."
        />
        <RuleReference />

        <SubHeading>What BOE payroll does not calculate</SubHeading>
        <Panel>
          {NOT_CALCULATED.map((line, i) => (
            <Row key={line} first={i === 0}>
              <span style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.55 }}>{line}</span>
            </Row>
          ))}
        </Panel>

        <SubHeading>Glossary</SubHeading>
        <Panel>
          {GLOSSARY.map((entry, i) => (
            <Row key={entry.term} first={i === 0}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#111318' }}>{entry.term}</div>
              <div style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.55, marginTop: 2 }}>
                {entry.meaning}
              </div>
            </Row>
          ))}
        </Panel>

        <AskAboutSalary token={token} />
      </div>
    </AttendancePayrollLayout>
  )
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

/**
 * Compact by design. The page title is already in the shell header, so this adds
 * one sentence, the formula, and the caveat that matters most — that the figures
 * come from REVIEWED attendance and APPROVED adjustments, not raw punches.
 */
function Hero() {
  return (
    <section style={{
      background: '#fff', border: `1px solid ${colors.border}`,
      borderRadius: 12, padding: '16px 18px',
    }}>
      <p style={{ margin: 0, fontSize: 13.5, color: '#3D4455', lineHeight: 1.6, maxWidth: 760 }}>
        Your salary is worked out from your attendance, one day at a time, and then settled against
        anything left over from last month. Every figure traces back to a specific day or to an
        entry an admin made with a reason attached.
      </p>

      <div className="payroll-guide-formula" style={{ marginTop: 14 }}>
        {FORMULA_STRIP.map((item, i) => (
          <div key={item.label} className="payroll-guide-formula-item" style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
            {i > 0 && (
              <span aria-hidden="true" style={{
                display: 'flex', alignItems: 'center', fontSize: 15,
                fontWeight: 700, color: '#A8B0BF', flexShrink: 0,
              }}>
                {item.op}
              </span>
            )}
            <div style={{
              flex: 1, minWidth: 0, borderRadius: 9, padding: '9px 12px',
              background: i === FORMULA_STRIP.length - 1 ? 'rgba(79,111,208,0.07)' : 'rgba(0,0,0,0.028)',
              border: `1px solid ${i === FORMULA_STRIP.length - 1 ? 'rgba(79,111,208,0.28)' : 'transparent'}`,
            }}>
              <div style={{
                fontSize: 12.5, fontWeight: 700,
                color: i === FORMULA_STRIP.length - 1 ? ACCENT : '#111318',
              }}>
                {item.label}
              </div>
              <div style={{ fontSize: 11, color: '#8C94A6', lineHeight: 1.45, marginTop: 2 }}>
                {item.note}
              </div>
            </div>
          </div>
        ))}
      </div>

      <p style={{
        margin: '12px 0 0', fontSize: 11.5, color: '#8C94A6', lineHeight: 1.55,
      }}>
        Payroll runs on <strong style={{ color: '#5B6474' }}>reviewed</strong> attendance and{' '}
        <strong style={{ color: '#5B6474' }}>approved</strong> adjustments — not on raw punches. A
        month that has already been generated keeps the rules it was calculated with.
      </p>
    </section>
  )
}

// ─── The journey ──────────────────────────────────────────────────────────────

function JourneyStepRow({
  step, index, last, extra,
}: { step: JourneyStep; index: number; last: boolean; extra: React.ReactNode }) {
  const Icon = STEP_ICONS[index - 1] ?? Sigma

  return (
    <div className="payroll-guide-step">
      {/* Marker and connector. Decorative — the number is repeated in the heading. */}
      <div className="payroll-guide-step-rail" aria-hidden="true">
        <span style={{
          width: 26, height: 26, borderRadius: 999, flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(79,111,208,0.10)', color: ACCENT,
          fontSize: 11.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        }}>
          {index}
        </span>
        {!last && <span className="payroll-guide-step-line" />}
      </div>

      <div style={{ minWidth: 0, paddingBottom: last ? 0 : 14 }}>
        <h3 style={{
          margin: 0, fontSize: 14, fontWeight: 700, color: '#111318',
          display: 'flex', alignItems: 'center', gap: 8, letterSpacing: '-0.01em',
        }}>
          <Icon size={15} strokeWidth={1.9} color={ACCENT} aria-hidden="true" />
          <span>Step {index} · {step.title}</span>
        </h3>

        <p style={{ margin: '5px 0 0', fontSize: 12.5, color: '#5B6474', lineHeight: 1.6 }}>
          {step.summary}
        </p>

        {/* Input → result. The chain that makes this a journey rather than cards. */}
        <div className="payroll-guide-io" style={{ marginTop: 9 }}>
          <IoBox label="Uses" value={step.input} />
          <span aria-hidden="true" style={{ display: 'flex', justifyContent: 'center', color: '#A8B0BF' }}>
            <ArrowRight size={14} strokeWidth={2} />
          </span>
          <IoBox label="Produces" value={step.result} accent />
        </div>

        {step.why && (
          <p style={{
            margin: '9px 0 0', padding: '8px 11px', borderRadius: 8,
            background: 'rgba(0,0,0,0.025)', fontSize: 11.5, color: '#5B6474', lineHeight: 1.55,
          }}>
            <strong style={{ color: '#3D4455', fontWeight: 600 }}>Why this matters. </strong>
            {step.why}
          </p>
        )}

        {extra && <div style={{ marginTop: 11 }}>{extra}</div>}
      </div>
    </div>
  )
}

/**
 * What each rule costs, at one example salary.
 *
 * Sits inside the deduction step rather than in its own section: the rates mean
 * nothing until you know what they are rates OF, and everything until you do.
 * Every amount is computed in rules.ts from the engine's own divisors and
 * rounded exactly as the engine rounds a real line, so this table cannot drift
 * from what would actually be charged.
 */
function DeductionRates() {
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 9, overflow: 'hidden', background: '#fff' }}>
      <div style={{
        padding: '8px 13px', fontSize: 11, color: '#8C94A6', lineHeight: 1.5,
        borderBottom: `1px solid ${colors.border}`, background: 'rgba(0,0,0,0.015)',
      }}>
        An example, on a monthly salary of{' '}
        <strong style={{ color: '#5B6474' }}>{fmtMoney(EXAMPLE_MONTHLY_SALARY)}</strong> — that is{' '}
        {fmtMoney(EXAMPLE_MONTHLY_SALARY / PER_DAY_DIVISOR)} a day.
      </div>
      {EXAMPLE_DEDUCTIONS.map(line => (
        <div
          key={line.label}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12,
            padding: '8px 13px', borderTop: `1px solid ${colors.border}`,
          }}
        >
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, color: '#3D4455', fontWeight: 500 }}>
              {line.label}
            </span>
            <span style={{ display: 'block', fontSize: 11, color: '#8C94A6' }}>{line.detail}</span>
          </span>
          <span style={{
            fontSize: 12.5, fontWeight: 600, color: '#DC2626',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>
            −{fmtMoney(line.amount)}
          </span>
        </div>
      ))}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12,
        padding: '9px 13px', borderTop: '1px solid rgba(0,0,0,0.11)', background: 'rgba(0,0,0,0.015)',
      }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: '#3D4455' }}>Attendance Deduction</span>
        <span style={{
          fontSize: 13, fontWeight: 700, color: '#DC2626',
          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        }}>
          −{fmtMoney(EXAMPLE_DEDUCTION_TOTAL)}
        </span>
      </div>
    </div>
  )
}

function IoBox({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{
      minWidth: 0, borderRadius: 8, padding: '7px 10px',
      background: accent ? 'rgba(79,111,208,0.06)' : 'rgba(0,0,0,0.028)',
    }}>
      <div style={{
        fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.08em', color: accent ? ACCENT : '#8C94A6',
      }}>
        {label}
      </div>
      <div style={{ fontSize: 12, color: '#3D4455', lineHeight: 1.45, marginTop: 2 }}>{value}</div>
    </div>
  )
}

// ─── The guide rail ───────────────────────────────────────────────────────────

/**
 * The right column. Not decoration and never empty: a compact restatement of the
 * calculation, the numbers that move a salary, where to go next, and a jump list.
 *
 * On mobile this falls in after the journey it summarises, which is where it
 * reads naturally — a recap rather than a preamble.
 */
function GuideRail({ actions }: { actions: GuideAction[] }) {
  return (
    <aside style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Every figure on a payslip, in the order it is worked out — read
          straight from SALARY_FLOW so the rail cannot list a figure the payslip
          does not have, or omit one it does. The three conclusions carry their
          formula; the rest are ingredients. */}
      <RailCard title="At a glance">
        <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {SALARY_FLOW.map(step => (
            <li
              key={step.key}
              style={{
                padding: '4px 0',
                borderTop: step.emphasis ? '1px solid rgba(0,0,0,0.07)' : undefined,
                marginTop: step.emphasis ? 3 : 0,
                paddingTop: step.emphasis ? 6 : 4,
              }}
            >
              <span style={{
                fontSize: 12, lineHeight: 1.4,
                color: step.emphasis ? '#111318' : '#5B6474',
                fontWeight: step.emphasis ? 700 : 400,
              }}>
                {step.label}
              </span>
              {step.emphasis && step.formula && (
                <span style={{
                  display: 'block', fontSize: 10.5, color: '#8C94A6',
                  lineHeight: 1.4, marginTop: 1,
                }}>
                  {step.formula}
                </span>
              )}
            </li>
          ))}
        </ol>
      </RailCard>

      <RailCard title="The numbers that decide your pay">
        {KEY_NUMBERS.map((n, i) => (
          <div
            key={n.label}
            style={{
              padding: '6px 0',
              borderTop: i > 0 ? '1px solid rgba(0,0,0,0.06)' : undefined,
            }}
          >
            <div style={{ fontSize: 11, color: '#8C94A6' }}>{n.label}</div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#111318', lineHeight: 1.4 }}>
              {n.value}
            </div>
            {n.note && <div style={{ fontSize: 11, color: '#8C94A6', lineHeight: 1.4 }}>{n.note}</div>}
          </div>
        ))}
        <p style={{ margin: '8px 0 0', fontSize: 10.5, color: '#A8B0BF', lineHeight: 1.5 }}>
          The standard rules. A month already generated keeps the rules it was calculated with.
        </p>
      </RailCard>

      {/* The legend for the marks used in the week strip and the day-state
          table. Shape first, colour second — the four silhouettes survive
          greyscale, which is the point of having them at all. */}
      <RailCard title="Reading the day marks">
        {([
          { tone: 'good',    text: 'A full day, fully paid' },
          { tone: 'half',    text: 'Half a payable day' },
          { tone: 'caution', text: 'Something payroll charged for' },
          { tone: 'neutral', text: 'Paid, but not a working day' },
        ] as const).map(entry => (
          <div key={entry.tone} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <ToneGlyph tone={entry.tone} size={11} />
            <span style={{ fontSize: 11.5, color: '#5B6474', lineHeight: 1.4 }}>{entry.text}</span>
          </div>
        ))}
      </RailCard>

      <RailCard title="What can change my salary?">
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {WHAT_CHANGES_PAY.map(item => (
            <li key={item} style={{ fontSize: 12, color: '#5B6474', lineHeight: 1.5, marginBottom: 4 }}>
              {item}
            </li>
          ))}
        </ul>
      </RailCard>

      <RailCard title="Where to go next">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {actions.map(action => (
            <Link
              key={action.href}
              href={action.href}
              className="payroll-guide-link"
              style={{
                display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none',
                padding: '8px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.028)',
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#111318' }}>
                  {action.label}
                </span>
                <span style={{ display: 'block', fontSize: 11, color: '#8C94A6', lineHeight: 1.4 }}>
                  {action.note}
                </span>
              </span>
              <ArrowRight size={14} strokeWidth={2} color="#A8B0BF" aria-hidden="true" style={{ marginLeft: 'auto', flexShrink: 0 }} />
            </Link>
          ))}
        </div>
      </RailCard>

      <RailCard title="On this page">
        <nav style={{ display: 'flex', flexDirection: 'column' }}>
          {SECTIONS.map(section => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="payroll-guide-jump"
              style={{
                fontSize: 12, color: '#5B6474', textDecoration: 'none',
                padding: '5px 0', display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <span aria-hidden="true" style={{ color: '#C3C9D4' }}>·</span>
              {section.label}
            </a>
          ))}
        </nav>
      </RailCard>

    </aside>
  )
}

function RailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      background: '#fff', border: `1px solid ${colors.border}`,
      borderRadius: 10, padding: '12px 14px',
    }}>
      <h2 style={{
        margin: '0 0 8px', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.09em', color: '#8C94A6',
      }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

// ─── Worked example ───────────────────────────────────────────────────────────

/**
 * One month end to end, from EXAMPLE_SETTLEMENT.
 *
 * Every derived line there is COMPUTED from four inputs and asserted by
 * settlement.test.ts, so the arithmetic on this page cannot drift from the
 * arithmetic the engine performs. Labelled as an example in the section note and
 * again in the footer, so it can never read as the signed-in employee's salary.
 */
function WorkedExample() {
  const e = EXAMPLE_SETTLEMENT

  return (
    <div style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <Stage title="What the month earned">
        <ExampleLine label="Gross Salary"           value={fmtMoney(e.gross_salary)} />
        <ExampleLine label="Attendance Deductions"  value={`−${fmtMoney(e.attendance_deductions)}`} tone="#DC2626" />
        <Divider />
        <ExampleLine label="Salary After Attendance" value={fmtMoney(e.salary_after_attendance)} strong />
      </Stage>

      <Stage title="What was added or recovered">
        <ExampleLine label="Previous Balance"      value={fmtSigned(e.carry_forward)}   tone="#16A34A" />
        <ExampleLine label="Travel reimbursement"  value={fmtSigned(e.other_addition)}  tone="#16A34A" />
        <ExampleLine label="Advance recovery"      value={fmtSigned(e.other_deduction)} tone="#DC2626" />
        <Divider />
        <ExampleLine label="Net Adjustments" value={fmtSigned(e.net_adjustments)} strong />
      </Stage>

      <Stage title="What BOE settled" accent>
        <ExampleLine label="Salary After Attendance" value={fmtMoney(e.salary_after_attendance)} />
        <ExampleLine label="Net Adjustments"         value={fmtSigned(e.net_adjustments)} tone="#16A34A" />
        <Divider />
        <ExampleLine label="Salary Payable" value={fmtMoney(e.salary_payable)} strong />
        <div style={{ height: 6 }} />
        <ExampleLine label="Amount Paid" value={`−${fmtMoney(e.amount_paid)}`} />
        <Divider />
        <ExampleLine label="Balance Carried Forward" value={fmtSigned(e.closing_balance)} strong />
        <p style={{ margin: '8px 0 0', fontSize: 11.5, color: '#5B6474', lineHeight: 1.55 }}>
          {fmtMoney(e.closing_balance)} is still pending from BOE, and becomes the Previous Balance
          on next month&rsquo;s payslip. Had nothing been paid <em>and no payment recorded</em>, there
          would be no balance at all — an unrecorded month carries nothing forward.
        </p>
        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#A8B0BF', lineHeight: 1.5 }}>
          This example carries paise because it predates the whole-rupee rule. A month generated
          today is rounded line by line, and every total is the sum of those rounded lines.
        </p>
      </Stage>
    </div>
  )
}

function Stage({ title, accent, children }: { title: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      padding: '12px 15px 14px',
      borderTop: `1px solid ${colors.border}`,
      background: accent ? 'rgba(79,111,208,0.04)' : undefined,
    }}>
      <h3 style={{
        margin: '0 0 5px', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.09em', color: accent ? ACCENT : '#8C94A6',
      }}>
        {title}
      </h3>
      {children}
    </div>
  )
}

function Divider() {
  return <div aria-hidden="true" style={{ height: 1, background: 'rgba(0,0,0,0.13)', margin: '8px 0 7px' }} />
}

function ExampleLine({
  label, value, strong, tone,
}: { label: string; value: string; strong?: boolean; tone?: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: 12, padding: '4px 0',
    }}>
      <span style={{ fontSize: 12.5, color: strong ? '#3D4455' : '#6B7280', fontWeight: strong ? 600 : 400 }}>
        {label}
      </span>
      {/* Colour is a second signal only — the sign is already in the string, so
          these read correctly in greyscale. */}
      <span style={{
        fontSize: strong ? 13.5 : 13, fontWeight: strong ? 700 : 600,
        color: tone ?? '#111318', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  )
}

// ─── Attendance states ────────────────────────────────────────────────────────

function AttendanceStateTable() {
  return (
    <>
      <div style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 10 }}>
        <div className="payroll-guide-scroll">
          <table className="payroll-guide-table">
            <caption className="payroll-guide-sr-only">
              Attendance states, what each counts as, its effect on salary, and whether an admin can correct it.
            </caption>
            <thead>
              <tr>
                <th scope="col">Day state</th>
                <th scope="col">Counts as</th>
                <th scope="col">What it means</th>
                <th scope="col">Effect on salary</th>
                <th scope="col">Can review change it?</th>
              </tr>
            </thead>
            <tbody>
              {ATTENDANCE_STATES.map(s => (
                <tr key={s.classification}>
                  <th scope="row" style={{ fontWeight: 600, fontSize: 12.5, color: '#111318', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <ToneGlyph tone={s.tone} />
                      {s.label}
                    </span>
                  </th>
                  <td style={{
                    fontSize: 12.5, fontWeight: 600, color: '#3D4455',
                    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                  }}>
                    {s.payableLabel}
                  </td>
                  <td style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.5 }}>{s.meaning}</td>
                  <td style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.5 }}>{s.salaryEffect}</td>
                  <td style={{ fontSize: 12.5, color: s.correctable ? '#3D4455' : '#8C94A6', lineHeight: 1.5 }}>
                    {s.correctable ? 'Yes — an admin can restate the day' : 'Not applicable'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 11.5, color: '#8C94A6', lineHeight: 1.55 }}>
        {LEGACY_STATE_NOTE}
      </p>
    </>
  )
}

// ─── Parameters ───────────────────────────────────────────────────────────────

function ParameterTable() {
  return (
    <div style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 10 }}>
      <div className="payroll-guide-scroll">
        <table className="payroll-guide-table">
          <caption className="sr-only">
            Payroll rules: the attendance condition, its salary effect, and whether an admin can change it.
          </caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Attendance condition</th>
              <th scope="col">Salary effect</th>
              <th scope="col">Admin review</th>
            </tr>
          </thead>
          <tbody>
            {PARAMETERS.map(p => (
              <tr key={p.rule}>
                <th scope="row" style={{ fontWeight: 600, fontSize: 12.5, color: '#111318' }}>{p.rule}</th>
                <td style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.5 }}>{p.condition}</td>
                <td style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.5 }}>{p.effect}</td>
                <td style={{ fontSize: 12, color: '#8C94A6', lineHeight: 1.5 }}>{p.adminCanChange}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Issue flow ───────────────────────────────────────────────────────────────

function IssueFlow() {
  return (
    <div className="payroll-guide-flow">
      {ISSUE_FLOW.map((step, i) => {
        const mine = step.actor === 'you'
        return (
          <div
            key={step.title}
            style={{
              background: '#fff', borderRadius: 10, padding: '11px 13px',
              border: `1px solid ${mine ? 'rgba(79,111,208,0.28)' : colors.border}`,
              minWidth: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
              <span aria-hidden="true" style={{
                width: 18, height: 18, borderRadius: 999, flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: mine ? 'rgba(79,111,208,0.12)' : 'rgba(0,0,0,0.05)',
                color: mine ? ACCENT : '#8C94A6', fontSize: 10, fontWeight: 700,
              }}>
                {i + 1}
              </span>
              <span style={{
                fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.07em', color: mine ? ACCENT : '#A8B0BF',
              }}>
                {mine ? 'You' : 'Admin'}
              </span>
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#111318', lineHeight: 1.35 }}>
              {step.title}
            </div>
            <div style={{ fontSize: 11.5, color: '#5B6474', lineHeight: 1.5, marginTop: 3 }}>
              {step.body}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ActionRow({ actions }: { actions: GuideAction[] }) {
  return (
    <div className="payroll-guide-grid-2" style={{ marginTop: 10 }}>
      {actions.map(action => (
        <Link
          key={action.href}
          href={action.href}
          className="payroll-guide-link"
          style={{
            display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none',
            background: '#fff', border: `1px solid ${colors.border}`,
            borderRadius: 10, padding: '12px 14px',
          }}
        >
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#111318' }}>
              {action.label}
            </span>
            <span style={{ display: 'block', fontSize: 11.5, color: '#8C94A6', lineHeight: 1.45 }}>
              {action.note}
            </span>
          </span>
          <ArrowRight size={15} strokeWidth={2} color={ACCENT} aria-hidden="true" style={{ marginLeft: 'auto', flexShrink: 0 }} />
        </Link>
      ))}
    </div>
  )
}

// ─── Reference ────────────────────────────────────────────────────────────────

function RuleReference() {
  return (
    <>
      {RULE_GROUP_ORDER.map(group => {
        const cards = RULE_CARDS.filter(c => c.group === group)
        if (cards.length === 0) return null
        return (
          <div key={group} style={{ marginBottom: 16 }}>
            <SubHeading>{RULE_GROUP_LABELS[group]}</SubHeading>
            <Panel>
              {cards.map((card, i) => (
                <Row key={card.key} first={i === 0}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>{card.title}</div>
                  <div style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.55, marginTop: 3 }}>
                    {card.body}
                  </div>
                  {card.detail && (
                    <div style={{ fontSize: 12, color: '#8C94A6', lineHeight: 1.5, marginTop: 4 }}>
                      {card.detail}
                    </div>
                  )}
                </Row>
              ))}
            </Panel>
          </div>
        )
      })}
    </>
  )
}

// ─── Shared pieces ────────────────────────────────────────────────────────────

function SectionHeading({ id, title, note }: { id: string; title: string; note?: string }) {
  return (
    <div id={id} style={{ margin: '28px 0 12px', scrollMarginTop: 84 }}>
      <h2 style={{
        margin: 0, fontSize: 16, fontWeight: 700, color: '#111318', letterSpacing: '-0.01em',
      }}>
        {title}
      </h2>
      {note && (
        <p style={{ margin: '3px 0 0', fontSize: 12.5, color: '#8C94A6', lineHeight: 1.5, maxWidth: 720 }}>
          {note}
        </p>
      )}
    </div>
  )
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      margin: '18px 0 7px', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.09em', color: '#8C94A6',
    }}>
      {children}
    </h3>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      {children}
    </div>
  )
}

function Row({ children, first }: { children: React.ReactNode; first: boolean }) {
  return (
    <div style={{ padding: '11px 15px', borderTop: first ? 'none' : `1px solid ${colors.border}` }}>
      {children}
    </div>
  )
}
