'use client'

// "How Attendance & Payroll Is Calculated" — the whole system in a minute.
//
// Collapsed by default. Payroll Result Detail is a working screen and an
// explanation that is always open competes with the figures it explains; opened,
// it should answer the question completely enough that nobody has to ask twice.
//
// Everything rendered here comes from src/lib/payroll/rules.ts, which is where
// the engine's own constants live. There is no hand-written rule text in this
// file and there must not be: a rule card that says "45 minutes" while the
// engine charges an hour is worse than no rule card at all.

import { useId, useState } from 'react'
import { colors } from '@/lib/tokens'
import { CALCULATION_FLOW, RULE_CARDS, RULE_GROUP_LABELS, type RuleGroup } from '@/lib/payroll/rules'

const GROUP_ORDER: RuleGroup[] = ['day', 'deduction', 'leave', 'process']

export function CalculationRulesSection() {
  const [open, setOpen] = useState(false)
  const panelId = useId()

  return (
    <section
      style={{
        background: '#fff', borderRadius: 12,
        border: '1px solid rgba(0,0,0,0.08)', overflow: 'hidden',
        marginTop: 20,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, padding: '15px 20px', background: 'transparent', border: 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ minWidth: 0 }}>
          <span style={{
            display: 'block', fontSize: 14, fontWeight: 700, color: '#111318',
            letterSpacing: '-0.01em',
          }}>
            How Attendance &amp; Payroll Is Calculated
          </span>
          <span style={{ display: 'block', fontSize: 12.5, color: '#8C94A6', marginTop: 3 }}>
            The rules behind every figure on this page.
          </span>
        </span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
          fontSize: 12.5, fontWeight: 600, color: '#4F6FD0',
        }}>
          {open ? 'Hide' : 'View calculation rules'}
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {open && (
        <div id={panelId} style={{ padding: '0 20px 20px', borderTop: '1px solid rgba(0,0,0,0.06)' }}>

          {/* ── The sequence ────────────────────────────────────────────────
              Punch to payslip, in five steps. Read this and the rest of the
              section is detail rather than news. */}
          <div style={{ padding: '16px 0 4px' }}>
            {CALCULATION_FLOW.map((step, i) => (
              <div key={step.key}>
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                  padding: '9px 12px', borderRadius: 9,
                  background: i === CALCULATION_FLOW.length - 1 ? 'rgba(5,150,105,0.07)' : 'rgba(0,0,0,0.025)',
                }}>
                  <span style={{
                    flexShrink: 0, width: 20, height: 20, borderRadius: 999,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: '#fff', border: '1px solid rgba(0,0,0,0.12)',
                    fontSize: 10.5, fontWeight: 700, color: '#6B7280',
                  }}>
                    {i + 1}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{
                      display: 'block', fontSize: 11, fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.08em',
                      color: i === CALCULATION_FLOW.length - 1 ? '#047857' : '#3D4455',
                    }}>
                      {step.label}
                    </span>
                    <span style={{ display: 'block', fontSize: 12.5, color: '#6B7280', marginTop: 2, lineHeight: 1.5 }}>
                      {step.body}
                    </span>
                  </span>
                </div>
                {i < CALCULATION_FLOW.length - 1 && (
                  <div aria-hidden="true" style={{
                    height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#C6CCD8', fontSize: 12, lineHeight: 1,
                  }}>
                    ↓
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* ── The rules themselves ────────────────────────────────────── */}
          {GROUP_ORDER.map(group => {
            const cards = RULE_CARDS.filter(c => c.group === group)
            if (cards.length === 0) return null
            return (
              <div key={group} style={{ marginTop: 20 }}>
                <div style={{
                  fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: '0.09em', color: '#8C94A6', marginBottom: 8,
                }}>
                  {RULE_GROUP_LABELS[group]}
                </div>
                <div style={{
                  border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden',
                }}>
                  {cards.map((card, i) => (
                    <div
                      key={card.key}
                      style={{
                        padding: '10px 14px',
                        borderTop: i > 0 ? `1px solid ${colors.border}` : 'none',
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>{card.title}</div>
                      <div style={{ fontSize: 12.5, color: '#6B7280', lineHeight: 1.55, marginTop: 2 }}>
                        {card.body}
                      </div>
                      {card.detail && (
                        <div style={{ fontSize: 12, color: '#8C94A6', lineHeight: 1.5, marginTop: 4 }}>
                          {card.detail}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

          {/* Honest about the edges rather than silent about them. */}
          <div style={{
            marginTop: 16, padding: '10px 14px', borderRadius: 9,
            background: 'rgba(0,0,0,0.025)', fontSize: 12, color: '#6B7280', lineHeight: 1.55,
          }}>
            BOE payroll does not calculate overtime, tax or bonuses. Anything owed from an
            earlier month appears as an adjustment, listed separately above.
          </div>
        </div>
      )}
    </section>
  )
}
