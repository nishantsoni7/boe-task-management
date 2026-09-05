'use client'

// BOE Credits — the employee's own page.
//
// FIVE THINGS, IN THE ORDER A PERSON ASKS THEM:
//   1. how many can I spend?            the balance, with the pending figure
//   2. what can I use them for?         attendance and salary, at today's prices
//   3. how is this month going?         verified reviews against the target
//   4. what happened recently?          the history, explained in words
//   5. how does it all work?            the guide
//
// Every read here derives the employee from the bearer token (the ledger
// route pins a non-admin to their own ledger; the settings are readable by
// every employee), so there is no employee id on this page to tamper with.
// Nothing here writes: covering a day and applying credits to payroll are
// done on the payslip they belong to.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { BookOpen, CalendarCheck, ChevronRight, Coins, MessageSquareHeart, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { formatRupees } from '@/lib/payroll/money'
import { istToday, istMonthStart } from '@/lib/istDate'
import { formatCredits, reviewMonthLabel, REWARD_STATUS_LABELS, creditTransactionTone } from '@/lib/boeCredits/ledger'
import { DEFAULT_BOE_CREDIT_SETTINGS, formatCreditValue } from '@/lib/boeCredits/settings'
import { CREDITS_GUIDE_PATH } from '@/lib/boeCredits/paths'
import type { BoeCreditSettings, CreditReviewMonth } from '@/lib/boeCredits/types'
import type { CreditHistoryRow } from '@/components/boeCredits/CreditHistoryModal'

type Ledger = {
  available_credits: number
  provisional_credits: number
  spendable_credits: number
  transactions: CreditHistoryRow[]
  review_months: CreditReviewMonth[]
}

const ACCENT = '#4F6FD0'

const card: React.CSSProperties = {
  background: '#fff', borderRadius: 12, border: `1px solid ${colors.border}`, overflow: 'hidden',
}

const eyebrow: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: colors.muted,
}

function stamp(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  pending:   { bg: 'rgba(232,160,48,0.14)', fg: '#92400E' },
  available: { bg: 'rgba(5,150,105,0.12)',  fg: '#047857' },
  lapsed:    { bg: 'rgba(220,38,38,0.10)',  fg: '#B91C1C' },
  reversed:  { bg: 'rgba(140,148,166,0.16)', fg: '#4B5563' },
}

export default function MyCreditsPage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [ledger,   setLedger]   = useState<Ledger | null>(null)
  const [settings, setSettings] = useState<BoeCreditSettings>(DEFAULT_BOE_CREDIT_SETTINGS)
  const [failed,   setFailed]   = useState(false)
  const [showAll,  setShowAll]  = useState(false)

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
      if (!prof) { router.push('/login'); return }
      setProfile(prof as UserProfile)
      setLoading(false)

      const auth = { authorization: `Bearer ${session.access_token}` }
      // Both reads together; neither depends on the other.
      const [ledgerRes, settingsRes] = await Promise.all([
        fetch('/api/boe-credits/ledger?limit=200', { headers: auth }).catch(() => null),
        fetch('/api/boe-credits/settings', { headers: auth }).catch(() => null),
      ])
      if (ledgerRes && ledgerRes.ok) setLedger(await ledgerRes.json().catch(() => null))
      else setFailed(true)
      if (settingsRes && settingsRes.ok) {
        const json = await settingsRes.json().catch(() => null)
        if (json?.settings) setSettings(json.settings as BoeCreditSettings)
      }
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const thisMonth = istMonthStart(istToday())
  const month = ledger?.review_months.find(m => m.review_month === thisMonth) ?? null
  const target = month?.minimum_reviews_snapshot ?? settings.minimum_monthly_reviews
  const done = month?.qualifying_review_count ?? 0
  const rows = ledger?.transactions ?? []
  const shownRows = showAll ? rows : rows.slice(0, 6)
  const exampleCredits = 5

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="BOE Credits"
      subtitle="Earned from verified review work. Use them on your payslip."
      onSignOut={handleSignOut}
      actions={
        <Link href={CREDITS_GUIDE_PATH} className="boe-btn boe-btn-ghost" style={{ fontSize: 12.5, padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <BookOpen size={14} strokeWidth={1.9} /> How credits work
        </Link>
      }
    >
      <div style={{ maxWidth: 880, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── 1. Balance ─────────────────────────────────────────────────── */}
        <section aria-labelledby="credits-balance" style={{ ...card, border: '1px solid rgba(79,111,208,0.28)' }}>
          <div style={{ padding: '16px 18px', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ minWidth: 160 }}>
              <div id="credits-balance" style={eyebrow}>Spendable now</div>
              <div style={{ fontSize: 34, fontWeight: 700, color: colors.primary, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', marginTop: 4 }}>
                {failed ? '—' : ledger == null ? '…' : ledger.spendable_credits.toLocaleString('en-IN')}
                <span style={{ fontSize: 14, fontWeight: 600, color: colors.tertiary, marginLeft: 6 }}>credits</span>
              </div>
            </div>
            {ledger && ledger.provisional_credits > 0 && (
              <div>
                <div style={eyebrow}>Pending this month&rsquo;s target</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#92400E', fontVariantNumeric: 'tabular-nums', marginTop: 4 }}>
                  {ledger.provisional_credits.toLocaleString('en-IN')}
                </div>
              </div>
            )}
            {ledger && (
              <div>
                <div style={eyebrow}>Total recorded</div>
                <div style={{ fontSize: 20, fontWeight: 600, color: colors.tertiary, fontVariantNumeric: 'tabular-nums', marginTop: 4 }}>
                  {ledger.available_credits.toLocaleString('en-IN')}
                </div>
              </div>
            )}
            <div style={{ marginLeft: 'auto', fontSize: 12, color: colors.muted, maxWidth: 260, lineHeight: 1.5 }}>
              {failed
                ? 'Your credits could not be loaded right now.'
                : '1 credit = ' + formatCreditValue(settings.credit_value) + ' on your salary. Unused credits never expire.'}
            </div>
          </div>
        </section>

        {/* ── 2. What you can use them for ───────────────────────────────── */}
        <section aria-labelledby="credits-uses">
          <h2 id="credits-uses" style={{ ...eyebrow, margin: '0 0 8px' }}>What you can use them for</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 12 }}>
            <UseTile
              icon={<CalendarCheck size={16} strokeWidth={1.9} color={ACCENT} />}
              title="Cover an attendance deduction"
              lines={[
                `Half Day · ${formatCredits(settings.half_day_redemption_credits)}`,
                `Full Day / Absent · ${formatCredits(settings.full_day_redemption_credits)}`,
              ]}
              note="On your payslip, next to the deduction. The day is settled at ₹0."
              href="/my-payroll"
              cta="Open My Payroll"
            />
            <UseTile
              icon={<Wallet size={16} strokeWidth={1.9} color={ACCENT} />}
              title="Add to your salary"
              lines={[
                `1 credit = ${formatCreditValue(settings.credit_value)}`,
                `${exampleCredits} credits = +${formatRupees(exampleCredits * settings.credit_value)} on Salary Payable`,
              ]}
              note="On your payslip, while the month is unlocked. No deduction needed."
              href="/my-payroll"
              cta="Open My Payroll"
            />
          </div>
        </section>

        {/* ── 3. This month's review target ──────────────────────────────── */}
        <section aria-labelledby="credits-month" style={card}>
          <div style={{ padding: '14px 18px', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div id="credits-month" style={eyebrow}>{reviewMonthLabel(thisMonth)} · review target</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {Array.from({ length: Math.max(target, done) }, (_, i) => (
                  <span
                    key={i}
                    aria-hidden="true"
                    style={{
                      width: 26, height: 26, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12, fontWeight: 700,
                      background: i < done ? 'rgba(5,150,105,0.14)' : 'rgba(0,0,0,0.05)',
                      color: i < done ? '#047857' : '#A9AFBD',
                      border: i < done ? '1px solid rgba(5,150,105,0.35)' : '1px dashed rgba(0,0,0,0.15)',
                    }}
                  >
                    {i < done ? '✓' : i + 1}
                  </span>
                ))}
                <span style={{ fontSize: 13, fontWeight: 600, color: colors.primary, marginLeft: 4 }}>
                  {done} of {target} verified
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: '#5B6474', marginTop: 8, lineHeight: 1.5 }}>
                {month?.status === 'qualified'
                  ? 'Monthly target completed — this month’s review credits are available to spend.'
                  : month?.status === 'lapsed'
                    ? 'This month closed below the target, so its review credits lapsed. Older credits were not affected.'
                    : done === 0
                      // BOTH REWARDS WHEN THEY DIFFER. Naming one number for
                      // "verified reviews" would be telling somebody doing
                      // image reviews the wrong figure.
                      ? `${settings.review_reward_credits === settings.image_review_reward_credits
                          ? `Verified reviews earn ${formatCredits(settings.review_reward_credits)} each.`
                          : `A verified text review earns ${formatCredits(settings.review_reward_credits)} and an image review ${formatCredits(settings.image_review_reward_credits)}.`
                        } Reach ${target} in a month and that month’s credits become spendable.`
                      : `${target - done} more verified ${target - done === 1 ? 'review' : 'reviews'} and this month’s ${formatCredits(month?.earned_review_credits ?? 0)} become spendable.`}
              </div>
            </div>
            <Link href="/customer-reviews" className="boe-btn boe-btn-ghost" style={{ fontSize: 12.5, padding: '7px 14px', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
              <MessageSquareHeart size={14} strokeWidth={1.9} /> Review Workflow
            </Link>
          </div>
        </section>

        {/* ── 4. Recent activity ─────────────────────────────────────────── */}
        <section aria-labelledby="credits-activity" style={card}>
          <div style={{ padding: '12px 18px', borderBottom: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
            <h2 id="credits-activity" style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: colors.primary }}>Recent activity</h2>
            {rows.length > 6 && (
              <button type="button" onClick={() => setShowAll(v => !v)} style={{ background: 'none', border: 'none', color: ACCENT, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                {showAll ? 'Show fewer' : `Show all ${rows.length}`}
              </button>
            )}
          </div>
          {ledger == null && !failed ? (
            <div style={{ padding: '18px', fontSize: 13, color: colors.muted }} aria-busy="true">Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: '24px 18px', fontSize: 13, color: colors.muted, lineHeight: 1.6 }}>
              No credits yet. Book a review in the Review Workflow, send it, submit your screenshot, and a verified
              review earns{' '}
              {settings.review_reward_credits === settings.image_review_reward_credits
                ? formatCredits(settings.review_reward_credits)
                : `${formatCredits(settings.review_reward_credits)} for a text review or ${formatCredits(settings.image_review_reward_credits)} for an image review`}.
            </div>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: '4px 18px' }}>
              {shownRows.map((row, i) => {
                const tone = creditTransactionTone(row)
                return (
                  <li key={row.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0', borderBottom: i < shownRows.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none' }}>
                    <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: tone.dot, marginTop: 7, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: colors.primary }}>{row.title ?? 'Credits'}</span>
                        {row.status && (
                          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 8px', borderRadius: 20, background: STATUS_TONE[row.status]?.bg, color: STATUS_TONE[row.status]?.fg, whiteSpace: 'nowrap' }}>
                            {REWARD_STATUS_LABELS[row.status]}
                          </span>
                        )}
                      </div>
                      {row.detail && <div style={{ fontSize: 12, color: '#5B6474', marginTop: 2 }}>{row.detail}</div>}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: row.credits < 0 ? '#B91C1C' : '#047857', fontVariantNumeric: 'tabular-nums' }}>
                        {formatCredits(row.credits, { signed: true })}
                      </div>
                      <div style={{ fontSize: 11, color: colors.muted, whiteSpace: 'nowrap' }}>
                        {stamp(row.created_at)}{typeof row.balance_after === 'number' ? ` · ${row.balance_after} after` : ''}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </section>

        {/* ── 5. How it works ────────────────────────────────────────────── */}
        <Link
          href={CREDITS_GUIDE_PATH}
          style={{
            ...card, padding: '14px 18px', textDecoration: 'none',
            display: 'flex', alignItems: 'center', gap: 12,
          }}
        >
          <Coins size={18} strokeWidth={1.9} color={ACCENT} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: colors.primary }}>How BOE Credits work</div>
            <div style={{ fontSize: 12, color: '#5B6474', marginTop: 2 }}>
              Earning, the monthly target, attendance and salary, and what happens when a month closes — with today&rsquo;s numbers.
            </div>
          </div>
          <ChevronRight size={16} color={colors.muted} />
        </Link>
      </div>
    </AttendancePayrollLayout>
  )
}

function UseTile({ icon, title, lines, note, href, cta }: {
  icon: React.ReactNode; title: string; lines: string[]; note: string; href: string; cta: string
}) {
  return (
    <div style={{ ...card, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {icon}
        <span style={{ fontSize: 13.5, fontWeight: 700, color: colors.primary }}>{title}</span>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#3D4455', lineHeight: 1.6 }}>
        {lines.map(l => <li key={l}>{l}</li>)}
      </ul>
      <div style={{ fontSize: 11.5, color: colors.muted, lineHeight: 1.5 }}>{note}</div>
      <Link href={href} style={{ fontSize: 12.5, fontWeight: 600, color: ACCENT, textDecoration: 'none', marginTop: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {cta} <ChevronRight size={14} />
      </Link>
    </div>
  )
}
