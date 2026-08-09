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
import { PayrollLayout } from '@/components/layout/PayrollLayout'
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
  type SalaryStep,
} from '@/lib/payroll/rules'
import { fmtMoney, fmtSigned } from '@/lib/payroll/settlement'

// The three figures that are conclusions rather than ingredients get the accent;
// everything else stays quiet so the page has a shape when skimmed.
const ACCENT = '#4F6FD0'

export default function HowPayrollWorksPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

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
    <PayrollLayout
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

        {/* ── Settlement, worked ────────────────────────────────────────── */}
        <SectionTitle
          title="Carry forward, worked through"
          note="What happens when a month is not paid exactly."
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

        <div style={{
          marginTop: 18, marginBottom: 8, padding: '12px 15px', borderRadius: 10,
          background: 'rgba(0,0,0,0.025)', fontSize: 12.5, color: '#5B6474', lineHeight: 1.6,
        }}>
          Something on your payslip look wrong? Open the month in My Payroll and use
          <strong style={{ color: '#3D4455' }}> Raise Issue</strong>. It goes to your admin with the
          month attached, and it does not change your salary by itself.
        </div>
      </div>
    </PayrollLayout>
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

function ExampleLine({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: 12, padding: '4px 0',
    }}>
      <span style={{ fontSize: 12.5, color: strong ? '#3D4455' : '#6B7280', fontWeight: strong ? 600 : 400 }}>
        {label}
      </span>
      <span style={{
        fontSize: strong ? 13.5 : 13, fontWeight: strong ? 700 : 600,
        color: '#111318', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  )
}
