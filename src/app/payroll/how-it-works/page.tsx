'use client'

// How Payroll Works — the whole calculation, for somebody who has never seen one.
//
// This replaces the accordion that used to sit at the bottom of Payroll Result
// Detail. An explanation folded into the corner of a working screen competes
// with the figures it explains and gets read by nobody; given its own page it
// can take the space to actually answer the question.
//
// THE RULE THIS PAGE LIVES BY
// ---------------------------
// Not one number is typed into this file. Every threshold, rate, divisor,
// formula and worked example comes from src/lib/payroll/rules.ts — the same
// constants engine.ts calculates with. A page that says "45 minutes" while the
// engine charges an hour is worse than no page at all, so the only way to change
// what this says is to change what the engine does.
//
// It reads no payroll record for anybody, which is what lets every employee see
// it (see PayrollGuard in ../layout.tsx).

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { colors } from '@/lib/tokens'
import {
  SALARY_FLOW,
  RULE_CARDS,
  RULE_GROUP_LABELS,
  RULE_GROUP_ORDER,
  EXAMPLE_DEDUCTIONS,
  EXAMPLE_DEDUCTION_TOTAL,
  EXAMPLE_MONTHLY_SALARY,
  NOT_CALCULATED,
  PER_DAY_DIVISOR,
  GLOSSARY,
  EXAMPLE_SETTLEMENT,
  type SalaryStep,
} from '@/lib/payroll/rules'
import { fmtMoney, fmtSigned } from '@/lib/payroll/settlement'
import { AskAboutSalary } from './AskAboutSalary'

// The three figures that are conclusions rather than ingredients get the accent;
// everything else stays quiet so the page has a shape when skimmed.
const ACCENT = '#4F6FD0'

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

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="How Payroll Works"
      subtitle="Every figure on your payslip, and where it comes from."
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 860 }}>
        <BackLink onClick={() => router.back()} />

        <Intro />

        {/* ── The salary, step by step ──────────────────────────────────── */}
        <SectionTitle
          title="Your salary, step by step"
          note="Read top to bottom. Each step uses the one above it."
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {SALARY_FLOW.map((step, i) => (
            <SalaryStepCard key={step.key} step={step} index={i + 1} />
          ))}
        </div>

        {/* ── A worked deduction ────────────────────────────────────────── */}
        <SectionTitle
          title="What deductions look like"
          note={`An example only, on a monthly salary of ${fmtMoney(EXAMPLE_MONTHLY_SALARY)}. Your own figures are on your payslip.`}
        />
        <ExampleDeductions />

        {/* ── The whole calculation, one month ──────────────────────────── */}
        <SectionTitle
          title="A full month, worked through"
          note="One example from gross salary to what carries into next month. Your own figures are on your payslip."
        />
        <WorkedSettlement />

        {/* ── Adjustments ───────────────────────────────────────────────── */}
        <SectionTitle
          title="Understanding adjustments"
          note="Four things an adjustment can be. Every one carries a written reason you can see."
        />
        <AdjustmentCases />

        {/* ── Payment ───────────────────────────────────────────────────── */}
        <SectionTitle
          title="What happens after payment"
          note="Your closing balance depends on how much was actually paid."
        />
        <PaymentCases />

        {/* ── Settlement, worked ────────────────────────────────────────── */}
        <SectionTitle
          title="Where next month's Previous Balance comes from"
          note="This month's closing balance opens your next payroll month."
        />
        <CarryForwardExample />

        {/* ── The rules ─────────────────────────────────────────────────── */}
        <SectionTitle
          title="The rules in full"
          note="Every rule payroll actually applies. If a rule is not here, payroll does not do it."
        />
        {RULE_GROUP_ORDER.map(group => {
          const cards = RULE_CARDS.filter(c => c.group === group)
          if (cards.length === 0) return null
          return (
            <div key={group} style={{ marginBottom: 18 }}>
              <GroupLabel>{RULE_GROUP_LABELS[group]}</GroupLabel>
              <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
                {cards.map((card, i) => (
                  <div key={card.key} style={{ padding: '11px 15px', borderTop: i > 0 ? `1px solid ${colors.border}` : 'none' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>{card.title}</div>
                    <div style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.55, marginTop: 3 }}>{card.body}</div>
                    {card.detail && (
                      <div style={{ fontSize: 12, color: '#8C94A6', lineHeight: 1.5, marginTop: 4 }}>{card.detail}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}

        {/* ── The edges ─────────────────────────────────────────────────── */}
        <SectionTitle title="What BOE payroll does not calculate" />
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
          {NOT_CALCULATED.map((line, i) => (
            <div
              key={i}
              style={{
                padding: '11px 15px', fontSize: 12.5, color: '#5B6474', lineHeight: 1.55,
                borderTop: i > 0 ? `1px solid ${colors.border}` : 'none',
              }}
            >
              {line}
            </div>
          ))}
        </div>

        {/* ── Glossary ──────────────────────────────────────────────────── */}
        <SectionTitle title="Glossary" note="Every term on your payslip, in one line each." />
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
          {GLOSSARY.map((entry, i) => (
            <div
              key={entry.term}
              style={{ padding: '10px 15px', borderTop: i > 0 ? `1px solid ${colors.border}` : 'none' }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#111318' }}>{entry.term}</div>
              <div style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.55, marginTop: 2 }}>{entry.meaning}</div>
            </div>
          ))}
        </div>

        {/* ── Ask ───────────────────────────────────────────────────────── */}
        <AskAboutSalary token={token} />

        <div style={{
          marginTop: 18, marginBottom: 8, padding: '12px 15px', borderRadius: 10,
          background: 'rgba(0,0,0,0.025)', fontSize: 12.5, color: '#5B6474', lineHeight: 1.6,
        }}>
          Something on your payslip look wrong? Open the month in My Payroll and use
          <strong style={{ color: '#3D4455' }}> Raise Issue</strong>. It goes to your admin with the
          month attached, and it does not change your salary by itself.
        </div>
      </div>
    </AttendancePayrollLayout>
  )
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: 0,
        color: '#8C94A6', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 4,
        marginBottom: 16,
      }}
    >
      ← Back
    </button>
  )
}

function Intro() {
  return (
    <div style={{
      background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 12,
      padding: '16px 18px', marginBottom: 4,
    }}>
      <div style={{ fontSize: 13.5, color: '#3D4455', lineHeight: 1.65 }}>
        Your salary is worked out from your attendance, one day at a time, and then settled
        against anything left over from last month. Nothing is estimated and nothing is
        rounded off at the end — every figure below traces back to a specific day or a
        specific entry made by an admin, with a reason attached.
      </div>
      <div style={{ fontSize: 12.5, color: '#8C94A6', lineHeight: 1.6, marginTop: 9 }}>
        Your daily rate is your monthly salary ÷ {PER_DAY_DIVISOR} — {PER_DAY_DIVISOR} being the
        working days in a six-day week month.
      </div>
    </div>
  )
}

function SectionTitle({ title, note }: { title: string; note?: string }) {
  return (
    <div style={{ margin: '26px 0 11px' }}>
      <div style={{ fontSize: 15.5, fontWeight: 700, color: '#111318', letterSpacing: '-0.01em' }}>
        {title}
      </div>
      {note && (
        <div style={{ fontSize: 12.5, color: '#8C94A6', marginTop: 3, lineHeight: 1.5 }}>{note}</div>
      )}
    </div>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.09em', color: '#8C94A6', marginBottom: 7,
    }}>
      {children}
    </div>
  )
}

const SIGN_NOTE: Record<NonNullable<SalaryStep['sign']>, string> = {
  positive: 'Always adds',
  negative: 'Always subtracts',
  signed:   'Can be + or −',
}

function SalaryStepCard({ step, index }: { step: SalaryStep; index: number }) {
  return (
    <div style={{
      background: '#fff',
      border: `1px solid ${step.emphasis ? 'rgba(79,111,208,0.35)' : colors.border}`,
      borderRadius: 10, padding: '13px 15px',
      display: 'flex', gap: 13, alignItems: 'flex-start',
    }}>
      <span style={{
        flexShrink: 0, width: 22, height: 22, borderRadius: 999,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: step.emphasis ? 'rgba(79,111,208,0.11)' : 'rgba(0,0,0,0.04)',
        color: step.emphasis ? ACCENT : '#6B7280',
        fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
      }}>
        {index}
      </span>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 13.5, fontWeight: 700,
            color: step.emphasis ? ACCENT : '#111318',
          }}>
            {step.label}
          </span>
          {step.sign && (
            <span style={{ fontSize: 11, color: '#8C94A6', fontWeight: 500 }}>
              {SIGN_NOTE[step.sign]}
            </span>
          )}
        </div>

        <div style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.6, marginTop: 4 }}>
          {step.body}
        </div>

        {step.formula && (
          <div style={{
            marginTop: 8, padding: '7px 11px', borderRadius: 7,
            background: 'rgba(0,0,0,0.03)',
            fontSize: 12, color: '#3D4455', fontWeight: 500,
            fontVariantNumeric: 'tabular-nums', lineHeight: 1.5,
          }}>
            {step.formula}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The deduction example.
 *
 * Every amount is computed in rules.ts from the engine's own divisors, so this
 * table cannot drift away from what the engine would actually charge.
 */
function ExampleDeductions() {
  return (
    <div style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden' }}>
      {EXAMPLE_DEDUCTIONS.map((line, i) => (
        <div
          key={line.label}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12,
            padding: '10px 15px', borderTop: i > 0 ? `1px solid ${colors.border}` : 'none',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, color: '#3D4455', fontWeight: 500 }}>{line.label}</div>
            <div style={{ fontSize: 11.5, color: '#8C94A6', marginTop: 1 }}>{line.detail}</div>
          </div>
          <div style={{
            fontSize: 13, fontWeight: 600, color: '#DC2626',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>
            −{fmtMoney(line.amount)}
          </div>
        </div>
      ))}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12,
        padding: '12px 15px', borderTop: '1px solid rgba(0,0,0,0.11)', background: 'rgba(0,0,0,0.015)',
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#3D4455' }}>Attendance Deduction</span>
        <span style={{
          fontSize: 14, fontWeight: 700, color: '#DC2626',
          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        }}>
          −{fmtMoney(EXAMPLE_DEDUCTION_TOTAL)}
        </span>
      </div>
    </div>
  )
}

/**
 * One month, end to end, as a progressive calculation.
 *
 * Not a table: the point is that each figure is produced by the one above it, so
 * the rows are grouped into the three stages the payslip itself uses, with a
 * rule under each conclusion. Every value comes from EXAMPLE_SETTLEMENT in
 * rules.ts, where it is computed from four inputs — so this cannot drift from
 * the arithmetic the settlement tests assert.
 */
function WorkedSettlement() {
  const e = EXAMPLE_SETTLEMENT

  return (
    <div style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <WorkedStage title="What the month earned">
        <ExampleLine label="Gross Salary"          value={fmtMoney(e.gross_salary)} />
        <ExampleLine label="Attendance Deductions" value={`−${fmtMoney(e.attendance_deductions)}`} tone="#DC2626" />
        <WorkedRule />
        <ExampleLine label="Salary After Attendance" value={fmtMoney(e.salary_after_attendance)} strong />
      </WorkedStage>

      <WorkedStage title="What was added or recovered">
        <ExampleLine label="Previous Balance"      value={fmtSigned(e.carry_forward)}   tone="#16A34A" />
        <ExampleLine label="Travel reimbursement"  value={fmtSigned(e.other_addition)}  tone="#16A34A" />
        <ExampleLine label="Advance recovery"      value={fmtSigned(e.other_deduction)} tone="#DC2626" />
        <WorkedRule />
        <ExampleLine label="Net Adjustments" value={fmtSigned(e.net_adjustments)} strong />
      </WorkedStage>

      <WorkedStage title="What BOE settled" accent>
        <ExampleLine label="Salary After Attendance" value={fmtMoney(e.salary_after_attendance)} />
        <ExampleLine label="Net Adjustments"         value={fmtSigned(e.net_adjustments)} tone="#16A34A" />
        <WorkedRule />
        <ExampleLine label="Salary Payable" value={fmtMoney(e.salary_payable)} strong />
        <div style={{ height: 6 }} />
        <ExampleLine label="Amount Paid" value={`−${fmtMoney(e.amount_paid)}`} />
        <WorkedRule />
        <ExampleLine label="Balance Carried Forward" value={fmtSigned(e.closing_balance)} strong />
        <div style={{ fontSize: 11.5, color: '#5B6474', marginTop: 8, lineHeight: 1.5 }}>
          {fmtMoney(e.closing_balance)} is still pending from BOE, and becomes the Previous Balance
          on next month&rsquo;s payslip.
        </div>
      </WorkedStage>
    </div>
  )
}

function WorkedStage({
  title, accent, children,
}: { title: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      padding: '12px 15px 14px',
      borderTop: `1px solid ${colors.border}`,
      background: accent ? 'rgba(79,111,208,0.04)' : undefined,
    }}>
      <div style={{
        fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.09em', color: accent ? ACCENT : '#8C94A6', marginBottom: 5,
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function WorkedRule() {
  return <div style={{ height: 1, background: 'rgba(0,0,0,0.13)', margin: '8px 0 7px' }} />
}

/**
 * The four shapes an adjustment takes.
 *
 * Split by DIRECTION and by SOURCE, because those are the two things employees
 * conflate: a negative adjustment is not an attendance deduction, and a previous
 * balance is not this month's reimbursement.
 */
function AdjustmentCases() {
  const cases = [
    {
      label: 'Previous Balance, positive',
      amount: '+₹2,000.00',
      tone: '#16A34A',
      body: 'Last month BOE paid you less than it owed. The shortfall is added to this month, so you receive it now.',
    },
    {
      label: 'Previous Balance, negative',
      amount: '−₹1,500.00',
      tone: '#DC2626',
      body: 'Last month you were paid more than the month earned — an advance, or an overpayment. It is recovered from this month.',
    },
    {
      label: 'Other Adjustment, positive',
      amount: '+₹800.00',
      tone: '#16A34A',
      body: 'Something owed to you for this month — a travel reimbursement, an approved incentive, a correction in your favour.',
    },
    {
      label: 'Other Adjustment, negative',
      amount: '−₹500.00',
      tone: '#DC2626',
      body: 'Something being recovered this month — an advance, or a correction. This is not an attendance deduction: it has nothing to do with your punches.',
    },
  ]

  return (
    <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}>
      {cases.map(c => (
        <div key={c.label} style={{
          background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 10, padding: '13px 15px',
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#111318' }}>{c.label}</span>
            <span style={{
              fontSize: 13, fontWeight: 700, color: c.tone,
              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
            }}>
              {c.amount}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: '#5B6474', lineHeight: 1.55, marginTop: 5 }}>{c.body}</div>
        </div>
      ))}
      <div style={{
        gridColumn: '1 / -1', padding: '11px 14px', borderRadius: 9,
        background: 'rgba(0,0,0,0.028)', fontSize: 12.5, color: '#5B6474', lineHeight: 1.6,
      }}>
        Every manual adjustment records who entered it, when, and why. The reason appears on your
        payslip beside the amount — you should never see a figure here without one.
      </div>
    </div>
  )
}

/**
 * The four payment outcomes, including the one that is not an amount.
 *
 * "Not recorded" is listed alongside the three arithmetic cases because it is
 * the one employees misread as ₹0 — and the consequence is different: nothing is
 * carried forward at all until somebody records the payment.
 */
function PaymentCases() {
  const payable = 25_000
  const cases = [
    {
      label: 'Paid in full',
      paid: fmtMoney(25_000),
      balance: fmtSigned(0),
      tone: '#16A34A',
      body: 'The month is fully settled. Nothing carries into next month.',
    },
    {
      label: 'Paid less than payable',
      paid: fmtMoney(22_000),
      balance: fmtSigned(3_000),
      tone: '#16A34A',
      body: 'BOE still owes you the difference. It is added to next month as your Previous Balance.',
    },
    {
      label: 'Paid more than payable',
      paid: fmtMoney(28_000),
      balance: fmtSigned(-3_000),
      tone: '#DC2626',
      body: 'You have been paid in advance. The difference is recovered from next month.',
    },
    {
      label: 'Payment not recorded',
      paid: 'Not recorded',
      balance: '—',
      tone: '#8C94A6',
      body: 'Nobody has entered what was paid yet, so there is no closing balance and nothing carries forward. This is different from a recorded payment of ₹0, which would mean the whole amount is still owed.',
    },
  ]

  return (
    <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}>
      {cases.map(c => (
        <div key={c.label} style={{
          background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 10, padding: '13px 15px',
        }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#111318', marginBottom: 7 }}>{c.label}</div>
          <ExampleLine label="Salary Payable" value={fmtMoney(payable)} />
          <ExampleLine label="Amount Paid"    value={c.paid} />
          <WorkedRule />
          <ExampleLine label="Balance Carried Forward" value={c.balance} tone={c.tone} strong />
          <div style={{ fontSize: 11.5, color: '#5B6474', lineHeight: 1.5, marginTop: 7 }}>{c.body}</div>
        </div>
      ))}
    </div>
  )
}

/**
 * Carry-forward, shown as two consecutive months.
 *
 * The one thing employees ask about that a formula does not answer: where the
 * number on next month's payslip came from. Deliberately round figures — this is
 * a worked illustration, not a rate table, and it is labelled as one.
 */
function CarryForwardExample() {
  const julyPayable = 25_000
  const julyPaid    = 23_000
  const julyClosing = julyPayable - julyPaid

  return (
    <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
      <div style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <div style={{
          padding: '9px 15px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.08em', color: '#8C94A6', borderBottom: `1px solid ${colors.border}`,
        }}>
          July
        </div>
        <div style={{ padding: '11px 15px 13px' }}>
          <ExampleLine label="Salary Payable" value={fmtMoney(julyPayable)} />
          <ExampleLine label="Amount Paid"    value={fmtMoney(julyPaid)} />
          <div style={{ height: 1, background: 'rgba(0,0,0,0.12)', margin: '9px 0 8px' }} />
          <ExampleLine label="Balance Carried Forward" value={fmtSigned(julyClosing)} strong />
          <div style={{ fontSize: 11.5, color: '#5B6474', marginTop: 8, lineHeight: 1.5 }}>
            {fmtMoney(julyClosing)} was not paid in July, so BOE still owes it.
          </div>
        </div>
      </div>

      <div style={{ background: '#fff', border: `1px solid rgba(79,111,208,0.35)`, borderRadius: 10, overflow: 'hidden' }}>
        <div style={{
          padding: '9px 15px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.08em', color: ACCENT, borderBottom: `1px solid ${colors.border}`,
        }}>
          August
        </div>
        <div style={{ padding: '11px 15px 13px' }}>
          <ExampleLine label="Previous Balance" value={fmtSigned(julyClosing)} strong />
          <div style={{ fontSize: 11.5, color: '#5B6474', marginTop: 8, lineHeight: 1.5 }}>
            July&rsquo;s closing balance becomes August&rsquo;s opening balance, and August&rsquo;s
            payslip records that it came from July.
          </div>
          <div style={{ fontSize: 11.5, color: '#8C94A6', marginTop: 7, lineHeight: 1.5 }}>
            Had July been <em>over</em>paid instead, this line would be negative — money already
            received, recovered here.
          </div>
          {/* The case that is easy to get wrong, said plainly: an unknown is not
              a zero, and nothing is carried across from a month nobody has
              settled yet. */}
          <div style={{ fontSize: 11.5, color: '#8C94A6', marginTop: 7, lineHeight: 1.5 }}>
            And had July&rsquo;s payment simply not been recorded yet, this line would be
            <strong style={{ color: '#5B6474' }}> ₹0.00</strong> — a month with no recorded payment
            has no confirmed balance, so nothing is carried across until it does.
          </div>
        </div>
      </div>
    </div>
  )
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
