'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Loader2, Sparkles } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { ReviewSheet } from './ReviewSheet'
import { MAX_GUIDANCE } from '@/lib/customerReviews/draftGeneration'
import { imageReviewsFor, textReviewsFor } from '@/lib/customerReviews/reviewTypes'
import {
  BOE_PRODUCT_CATEGORIES,
  DEFAULT_GENERATION_SETTINGS,
  MAX_BATCH_SIZE,
  MAX_ISSUE_CONTEXT,
  MAX_LOCATIONS,
  MAX_PROJECTS,
  MAX_WORDS_CEILING,
  MIN_BATCH_SIZE,
  MIN_WORDS_FLOOR,
  REVIEW_FOCUSES,
  REVIEW_FOCUS_META,
  buildGenerationPlan,
  percentageToCount,
  planTotals,
  validateGenerationSettings,
  type GenerationSettings,
  type ReviewFocus,
} from '@/lib/customerReviews/generationSettings'

// The generation control: a button, and a sheet behind it.
//
// WHO SEES IT: the caller renders it only when caps.canVerify, which is the
// RESOLVED `verify` permission and never a role. That is the weakest of the
// three checks — a screen can be lied to — and the route and the database
// function both ask again. It is here so somebody without the permission is not
// shown a button that would refuse them.
//
// WHY IT IS A SHEET AND NOT A PANEL. It used to be a permanently open section
// at the top of the list, above the tabs, on every visit for every verifier.
// Generation happens once in a while and reading pending drafts happens
// constantly, so the rare thing was occupying the space the frequent thing
// needed — particularly on a phone, where it pushed the list below the fold.
//
// THE POOL RULE IS GONE. The button used to be disabled until every available
// review had been booked, because a generated draft went straight to
// candidates and scarcity was the only brake. Approval is the brake now: the
// drafts land in Pending approval, where no candidate can see them.
//
// ── THE FORM, AND WHY IT IS NOT ONE LONG COLUMN ────────────────────────────
//
// There are now four groups of controls where there used to be one paragraph.
// Two of them — how many reviews, and how they should read — are answered every
// time, so they are open. Two of them — the real facts a batch may refer to,
// and the perspective mix — have working defaults and are answered occasionally,
// so they are folded away with their current state summarised on the header.
// A verifier who wants the old behaviour types a paragraph, presses Continue
// and gets twelve drafts, exactly as before.
//
// NOTHING HERE IS A CONTROL IN THE SECURITY SENSE. Every bound below is applied
// again by validateGenerationSettings() inside the route before a claim is
// taken, and the batch size and composition are checked a third time by
// create_customer_review_draft_batch(). The min/max attributes exist so a
// person is stopped at the point of typing rather than after a round trip.
//
// WHAT IT STILL DOES NOT DO. No editing of a draft, no regeneration of a single
// one, no scheduling, no history, no filters. One button, one batch, one
// confirmation.

type Props = {
  supabase: SupabaseClient
  /** Called after a successful batch so the list can reload. */
  onGenerated: () => void
}

type Phase =
  | { kind: 'writing' }
  | { kind: 'confirming' }
  | { kind: 'working' }
  | { kind: 'failed'; message: string }

type Employee = { id: string; full_name: string | null; position: string | null }

// ─── Small shared pieces, in the module's existing visual language ────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '11px', fontWeight: 600,
  color: colors.secondary, marginBottom: '4px',
}

const helpStyle: React.CSSProperties = {
  margin: 0, fontSize: '11px', color: colors.tertiary, lineHeight: 1.5,
}

function NumberField({
  id, label, value, min, max, disabled, onChange, suffix,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  disabled: boolean
  onChange: (next: number) => void
  suffix?: string
}) {
  return (
    <div style={{ flex: '1 1 110px', minWidth: 0 }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <input
          id={id}
          className="boe-input"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          // AN EMPTY BOX IS NOT ZERO. Clearing the field mid-edit would
          // otherwise snap the value to 0 and fail validation while somebody is
          // still typing the second digit; it holds the last number instead.
          onChange={e => {
            const next = Number(e.target.value)
            if (e.target.value === '' || !Number.isFinite(next)) return
            onChange(Math.trunc(next))
          }}
          style={{ minHeight: '40px' }}
        />
        {suffix && (
          <span style={{ fontSize: '11px', color: colors.tertiary, whiteSpace: 'nowrap' }}>{suffix}</span>
        )}
      </div>
    </div>
  )
}

/**
 * A percentage, with the number of reviews it works out to shown beside it.
 *
 * THE DERIVED COUNT IS THE POINT OF THE CONTROL. "25%" means three reviews in a
 * batch of twelve and five in a batch of twenty, and an administrator setting a
 * distribution is thinking in reviews rather than in percent. It is computed
 * with percentageToCount() — the same function the plan is built with — so the
 * number shown here is the number that will actually be asked for.
 */
function PercentField({
  id, label, value, batchSize, disabled, onChange, unit = 'reviews',
}: {
  id: string
  label: string
  value: number
  batchSize: number
  disabled: boolean
  onChange: (next: number) => void
  unit?: string
}) {
  const count = percentageToCount(batchSize, value)
  return (
    <div style={{ flex: '1 1 150px', minWidth: 0 }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <input
          id={id}
          className="boe-input"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          step={5}
          value={value}
          disabled={disabled}
          onChange={e => {
            const next = Number(e.target.value)
            if (e.target.value === '' || !Number.isFinite(next)) return
            onChange(Math.min(100, Math.max(0, Math.trunc(next))))
          }}
          style={{ minHeight: '40px' }}
        />
        <span style={{
          fontSize: '11px', color: colors.tertiary, whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
        }}>
          % · ≈{count} {unit}
        </span>
      </div>
    </div>
  )
}

function Section({
  title, summary, open, onToggle, children,
}: {
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
          padding: '10px 12px', minHeight: '44px', background: colors.raised,
          border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '12px', fontWeight: 700, color: colors.primary }}>{title}</span>
        <span style={{
          marginLeft: 'auto', fontSize: '11px', color: colors.tertiary,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {summary}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2.2}
          style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', color: colors.tertiary }}
        />
      </button>
      {open && (
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {children}
        </div>
      )}
    </div>
  )
}

/** A tick-list of short labels. Used for products and for team members. */
function CheckList({
  options, selected, disabled, onToggle,
}: {
  options: { key: string; label: string; note?: string }[]
  selected: ReadonlySet<string>
  disabled: boolean
  onToggle: (key: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
      {options.map(option => {
        const on = selected.has(option.key)
        return (
          <button
            key={option.key}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onToggle(option.key)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px',
              padding: '7px 10px', minHeight: '36px', borderRadius: '6px',
              border: `1px solid ${on ? '#C4B5FD' : colors.border}`,
              background: on ? '#F5F3FF' : '#FFFFFF',
              color: on ? '#5B21B6' : colors.secondary,
              fontSize: '11.5px', fontWeight: on ? 700 : 500,
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {option.label}
            {option.note && (
              <span style={{ fontWeight: 400, color: on ? '#7C3AED' : colors.muted }}>
                {option.note}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── The control ──────────────────────────────────────────────────────────────

export function GenerateDrafts({ supabase, onGenerated }: Props) {
  const [open, setOpen] = useState(false)
  const [guidance, setGuidance] = useState('')
  const [settings, setSettings] = useState<GenerationSettings>(DEFAULT_GENERATION_SETTINGS)
  const [phase, setPhase] = useState<Phase>({ kind: 'writing' })
  const [done, setDone] = useState<number | null>(null)
  const [showReferences, setShowReferences] = useState(false)
  const [showMix, setShowMix] = useState(false)

  const [candidates, setCandidates] = useState<Employee[]>([])
  const [staffPool, setStaffPool] = useState<Employee[]>([])

  // State is too slow to stop a double click, and two clicks racing is exactly
  // what the request key exists to survive. This stops the second REQUEST; the
  // key stops the second BATCH.
  const running = useRef(false)
  /**
   * THE KEY THAT MAKES A REPEATED TAP HARMLESS, minted when the verifier
   * presses the confirmation and reused by every retry of THAT submission.
   *
   * It is generated here rather than by the route on purpose: a route that
   * minted its own key would give a retried request a new one, which is exactly
   * the case the key exists to catch. Cleared on success, so the next
   * deliberate generation is a different request and is allowed to proceed.
   */
  const requestKey = useRef<string | null>(null)

  const trimmed = guidance.trim()

  // ── The two uses of the active employee directory ────────────────────────
  //
  // THE CANDIDATE FIELD IS GENERATION CONTEXT, NOT ASSIGNMENT. Naming somebody
  // here only records who the batch is intended for so their name can be
  // preselected later; it does not assign reviews or grant module access. For
  // that reason every active, non-deleted employee is shown here rather than
  // only employees who currently resolve Review Workflow `use`.
  //
  // FINAL ASSIGNMENT REMAINS STRICT. AssignBatch still loads
  // customer_review_assignable_employees(), and assign_customer_review_batch()
  // resolves `use` again inside the database before writing assigned_to.
  //
  // A TEAM MEMBER TO MENTION uses the same active directory. The Co-Founder and
  // the Operations Manager are people a review may legitimately refer to even
  // when they are not candidates for review work.
  useEffect(() => {
    if (!open) return
    let active = true
    const startFetch = () => {
      void (async () => {
        const { data: directory } = await supabase
          .from('users')
          .select('id, full_name, position, is_deleted')
          .eq('is_active', true)
          .order('full_name')
        if (!active) return
        const rows = (directory ?? []) as (Employee & { is_deleted: boolean | null })[]
        const activeNamed = rows.filter(r => !r.is_deleted && r.full_name)
        setCandidates(activeNamed)
        setStaffPool(activeNamed)
      })()
    }
    startFetch()
    return () => { active = false }
  }, [supabase, open])

  const close = useCallback(() => {
    if (running.current) return
    setOpen(false)
    setPhase({ kind: 'writing' })
  }, [])

  const patch = useCallback((next: Partial<GenerationSettings>) => {
    setSettings(current => ({ ...current, ...next }))
    setPhase(current => (current.kind === 'failed' ? { kind: 'writing' } : current))
  }, [])

  // THE SAME VALIDATION THE ROUTE RUNS, on every keystroke, so an impossible
  // combination is named before anybody presses anything. It is not a
  // substitute for the server's copy — it is the same function, and the server
  // calls it on the request body regardless of what happened here.
  const checked = useMemo(() => validateGenerationSettings(settings), [settings])
  const plan = useMemo(
    () => (checked.ok ? buildGenerationPlan(checked.settings) : null),
    [checked],
  )
  const totals = plan ? planTotals(plan) : null

  const size = settings.batchSize

  const generate = useCallback(async () => {
    if (running.current) return
    running.current = true
    if (!requestKey.current) requestKey.current = crypto.randomUUID()
    setPhase({ kind: 'working' })
    try {
      const response = await fetch('/api/customer-reviews/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guidance: trimmed, requestKey: requestKey.current, settings }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        setPhase({ kind: 'failed', message: body?.error ?? 'That did not work. Please try again.' })
        return
      }
      setGuidance('')
      requestKey.current = null
      setDone(body?.created ?? size)
      setOpen(false)
      setPhase({ kind: 'writing' })
      onGenerated()
    } catch {
      setPhase({ kind: 'failed', message: 'That did not work. Check your connection and try again.' })
    } finally {
      running.current = false
    }
  }, [trimmed, settings, size, onGenerated])

  const working = phase.kind === 'working'
  const confirming = phase.kind === 'confirming'
  const blocked = trimmed.length === 0 || !checked.ok

  const referenceSummary = [
    settings.locations.filter(Boolean).length ? `${settings.locations.filter(Boolean).length} cities` : null,
    settings.projects.filter(Boolean).length ? `${settings.projects.filter(Boolean).length} projects` : null,
    settings.products.length ? `${settings.products.length} products` : null,
    settings.staff.length ? `${settings.staff.length} people` : null,
  ].filter(Boolean).join(' · ') || 'Nothing specific'

  const mixSummary = REVIEW_FOCUSES
    .filter(f => settings.focusPct[f] > 0)
    .map(f => `${REVIEW_FOCUS_META[f].label} ${settings.focusPct[f]}%`)
    .join(' · ') || 'No preference'

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => { setDone(null); setOpen(true) }}
          className="boe-btn boe-btn-primary"
          style={{ fontSize: '12px', padding: '9px 16px', minHeight: '44px' }}
        >
          <Sparkles size={14} strokeWidth={2.2} />
          Generate drafts
        </button>
        {done !== null && (
          <span role="status" style={{ fontSize: '12px', color: '#166534', fontWeight: 600 }}>
            {done} drafts created. They are waiting for your approval.
          </span>
        )}
      </div>

      {open && (
        <ReviewSheet
          title={`Generate ${size} review drafts`}
          subtitle="They will wait for your approval. No candidate can see them until you approve."
          onClose={close}
          maxWidth="560px"
          dismissOnBackdrop={false}
          footer={
            confirming ? (
              <>
                <button
                  type="button"
                  onClick={generate}
                  disabled={working}
                  className="boe-btn boe-btn-primary"
                  style={{ flex: '1 1 auto', justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
                >
                  {working && <Loader2 size={14} strokeWidth={2.4} style={{ animation: 'boe-spin 0.8s linear infinite' }} />}
                  {working ? 'Drafting…' : `Yes, create ${size} drafts`}
                </button>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: 'writing' })}
                  disabled={working}
                  className="boe-btn boe-btn-ghost"
                  style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
                >
                  Back
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: 'confirming' })}
                  disabled={blocked}
                  className="boe-btn boe-btn-primary"
                  style={{ flex: '1 1 auto', justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
                >
                  Continue
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="boe-btn boe-btn-ghost"
                  style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
                >
                  Cancel
                </button>
              </>
            )
          }
        >
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <NumberField
              id="review-count"
              label="Number of reviews"
              value={settings.batchSize}
              min={MIN_BATCH_SIZE}
              max={MAX_BATCH_SIZE}
              disabled={working}
              onChange={next => patch({ batchSize: next })}
              suffix={`${MIN_BATCH_SIZE}–${MAX_BATCH_SIZE}`}
            />
            <div style={{ flex: '2 1 220px', minWidth: 0 }}>
              <label htmlFor="review-candidate" style={labelStyle}>Candidate (optional)</label>
              <select
                id="review-candidate"
                className="boe-input"
                value={settings.intendedFor ?? ''}
                disabled={working}
                onChange={e => patch({ intendedFor: e.target.value || null })}
                style={{ minHeight: '40px' }}
              >
                <option value="">Decide when assigning</option>
                {candidates.map(c => (
                  <option key={c.id} value={c.id}>{c.full_name ?? 'Unnamed'}</option>
                ))}
              </select>
            </div>
          </div>
          <p style={helpStyle}>
            {textReviewsFor(size)} text and {imageReviewsFor(size)} image reviews. Choosing a
            candidate here does not assign anything and shows them nothing — it selects their
            name for you at the assignment step, after you approve.
          </p>

          <label htmlFor="review-guidance" style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>
            Review guidance
          </label>
          <p id="review-guidance-help" style={helpStyle}>
            Describe the tone, the product type, the project context and the subjects to
            cover — for example “restaurant banquette seating for a mid-range chain, warm
            and practical, covering delivery and after-sales”. Do not include a customer’s
            name or any real project detail you would not want written down.
          </p>

          <textarea
            id="review-guidance"
            aria-describedby="review-guidance-help"
            value={guidance}
            onChange={e => {
              setGuidance(e.target.value)
              if (phase.kind === 'failed') setPhase({ kind: 'writing' })
            }}
            maxLength={MAX_GUIDANCE}
            rows={5}
            disabled={working}
            placeholder="Describe the reviews you want drafted…"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: '8px',
              border: `1px solid ${colors.border}`, fontSize: '13px', lineHeight: 1.55,
              fontFamily: 'inherit', resize: 'vertical', minHeight: '96px',
            }}
          />
          <div style={{ fontSize: '11px', color: colors.muted, textAlign: 'right', marginTop: '-8px' }}>
            {guidance.length} / {MAX_GUIDANCE}
          </div>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <NumberField
              id="review-min-words"
              label="Minimum words"
              value={settings.minWords}
              min={MIN_WORDS_FLOOR}
              max={MAX_WORDS_CEILING}
              disabled={working}
              onChange={next => patch({ minWords: next })}
            />
            <NumberField
              id="review-max-words"
              label="Maximum words"
              value={settings.maxWords}
              min={MIN_WORDS_FLOOR}
              max={MAX_WORDS_CEILING}
              disabled={working}
              onChange={next => patch({ maxWords: next })}
            />
            <PercentField
              id="review-hinglish"
              label="Hinglish"
              value={settings.hinglishPct}
              batchSize={size}
              disabled={working}
              onChange={next => patch({ hinglishPct: next })}
            />
          </div>
          <p style={helpStyle}>
            Lengths vary across the range rather than clustering in the middle. The
            remaining {100 - settings.hinglishPct}% are written in English.
          </p>

          <Section
            title="Real facts a review may use"
            summary={referenceSummary}
            open={showReferences}
            onToggle={() => setShowReferences(v => !v)}
          >
            <p style={helpStyle}>
              Only what you put here can be named. Anything you leave empty is never
              invented — a review with no city writes around the question instead.
            </p>

            <div>
              <span style={labelStyle}>Cities (up to {MAX_LOCATIONS})</span>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {Array.from({ length: MAX_LOCATIONS }, (_, i) => (
                  <input
                    key={i}
                    className="boe-input"
                    aria-label={`City ${i + 1}`}
                    value={settings.locations[i] ?? ''}
                    disabled={working}
                    placeholder={`City ${i + 1}`}
                    maxLength={60}
                    onChange={e => {
                      const next = [...settings.locations]
                      while (next.length < MAX_LOCATIONS) next.push('')
                      next[i] = e.target.value
                      patch({ locations: next })
                    }}
                    style={{ flex: '1 1 110px', minWidth: 0, minHeight: '40px' }}
                  />
                ))}
              </div>
            </div>
            <PercentField
              id="review-location-pct"
              label="Reviews mentioning a city"
              value={settings.locationPct}
              batchSize={size}
              disabled={working}
              onChange={next => patch({ locationPct: next })}
            />

            <div>
              <span style={labelStyle}>Projects (up to {MAX_PROJECTS})</span>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {Array.from({ length: MAX_PROJECTS }, (_, i) => (
                  <input
                    key={i}
                    className="boe-input"
                    aria-label={`Project name ${i + 1}`}
                    value={settings.projects[i] ?? ''}
                    disabled={working}
                    placeholder={`Project name ${i + 1}`}
                    maxLength={60}
                    onChange={e => {
                      const next = [...settings.projects]
                      while (next.length < MAX_PROJECTS) next.push('')
                      next[i] = e.target.value
                      patch({ projects: next })
                    }}
                    style={{ flex: '1 1 150px', minWidth: 0, minHeight: '40px' }}
                  />
                ))}
              </div>
            </div>
            <PercentField
              id="review-project-pct"
              label="Reviews mentioning a project"
              value={settings.projectPct}
              batchSize={size}
              disabled={working}
              onChange={next => patch({ projectPct: next })}
            />

            <div>
              <span style={labelStyle}>Products supplied</span>
              <CheckList
                options={BOE_PRODUCT_CATEGORIES.map(p => ({ key: p, label: p }))}
                selected={new Set(settings.products)}
                disabled={working}
                onToggle={key => patch({
                  products: settings.products.includes(key)
                    ? settings.products.filter(p => p !== key)
                    : [...settings.products, key],
                })}
              />
            </div>

            <div>
              <span style={labelStyle}>Team members who were actually involved</span>
              {staffPool.length === 0 ? (
                <p style={helpStyle}>No active employees could be loaded.</p>
              ) : (
                <CheckList
                  options={staffPool.map(p => ({
                    key: p.id,
                    label: p.full_name ?? 'Unnamed',
                    note: p.position ?? undefined,
                  }))}
                  selected={new Set(
                    staffPool
                      .filter(p => settings.staff.some(s => s.name === (p.full_name ?? '')))
                      .map(p => p.id),
                  )}
                  disabled={working}
                  onToggle={id => {
                    const person = staffPool.find(p => p.id === id)
                    if (!person) return
                    const name = person.full_name ?? ''
                    patch({
                      staff: settings.staff.some(s => s.name === name)
                        ? settings.staff.filter(s => s.name !== name)
                        : [...settings.staff, { name, role: person.position ?? '' }],
                    })
                  }}
                />
              )}
            </div>
            <PercentField
              id="review-staff-pct"
              label="Reviews mentioning a team member"
              value={settings.staffPct}
              batchSize={size}
              disabled={working}
              onChange={next => patch({ staffPct: next })}
            />
          </Section>

          <Section
            title="Review mix"
            summary={mixSummary}
            open={showMix}
            onToggle={() => setShowMix(v => !v)}
          >
            <p style={helpStyle}>
              What the reviews talk about. Each one is a separate share of the batch, not a
              slice of one pie — they can add up to more than 100%, and where two overlap the
              same review covers both subjects. Product 70% and Service 50% of {size} means{' '}
              {percentageToCount(size, 70)} and {percentageToCount(size, 50)} reviews, with
              some of them doing both. Leave them at 0 to let the subjects vary on their own.
            </p>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              {REVIEW_FOCUSES.map(focus => (
                <PercentField
                  key={focus}
                  id={`review-focus-${focus}`}
                  label={REVIEW_FOCUS_META[focus].label}
                  value={settings.focusPct[focus]}
                  batchSize={size}
                  disabled={working}
                  onChange={next => patch({
                    focusPct: { ...settings.focusPct, [focus]: next } as Record<ReviewFocus, number>,
                  })}
                />
              ))}
            </div>

            <div>
              <label htmlFor="review-issue" style={labelStyle}>
                A real issue and how it was resolved (optional)
              </label>
              <textarea
                id="review-issue"
                value={settings.issueContext}
                disabled={working}
                maxLength={MAX_ISSUE_CONTEXT}
                rows={3}
                placeholder="What actually went wrong, what was done about it, and how it ended…"
                onChange={e => patch({ issueContext: e.target.value })}
                style={{
                  width: '100%', padding: '9px 11px', borderRadius: '8px',
                  border: `1px solid ${colors.border}`, fontSize: '12.5px', lineHeight: 1.5,
                  fontFamily: 'inherit', resize: 'vertical', minHeight: '64px',
                }}
              />
            </div>
            <PercentField
              id="review-issue-pct"
              label="Reviews covering that issue"
              value={settings.issuePct}
              batchSize={size}
              disabled={working}
              onChange={next => patch({ issuePct: next })}
            />
            <p style={helpStyle}>
              A complaint is never invented. Leave the notes empty and this stays at 0.
            </p>
          </Section>

          {!checked.ok && (
            <p role="alert" style={{ margin: 0, fontSize: '12px', color: '#991B1B', lineHeight: 1.55 }}>
              {checked.error}
            </p>
          )}

          {confirming && (
            <div style={{
              display: 'grid', gap: '8px', padding: '12px',
              border: '1px solid #DDD6FE', borderRadius: '8px', background: '#F5F3FF',
            }}>
              <strong style={{ fontSize: '12px', color: '#4C1D95' }}>
                This creates exactly {size} drafts, pending your approval.
              </strong>
              {totals && (
                <p style={{ margin: 0, fontSize: '11.5px', color: '#5B21B6', lineHeight: 1.6 }}>
                  {textReviewsFor(size)} text · {imageReviewsFor(size)} image ·{' '}
                  {totals.hinglish} Hinglish · {totals.english} English
                  {REVIEW_FOCUSES.filter(f => totals.focus[f] > 0).map(f =>
                    ` · ${totals.focus[f]} ${REVIEW_FOCUS_META[f].label.toLowerCase()}`).join('')}
                  {totals.location > 0 ? ` · ${totals.location} mention a city` : ''}
                  {totals.project > 0 ? ` · ${totals.project} mention a project` : ''}
                  {totals.staff > 0 ? ` · ${totals.staff} name a colleague` : ''}
                  {totals.issue > 0 ? ` · ${totals.issue} cover the issue` : ''}
                  {' '}· {settings.minWords}–{settings.maxWords} words
                </p>
              )}
              <p style={{ margin: 0, fontSize: '12px', color: '#4C1D95', lineHeight: 1.55 }}>
                No candidate can see any of them until you approve. You can edit a draft&rsquo;s
                words yourself, regenerate the whole set from new feedback, or approve them
                one at a time.
              </p>
            </div>
          )}

          {working && (
            <p role="status" style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
              Drafting {size} reviews… this usually takes well under a minute.
              Nothing is created unless all {size} pass their checks.
            </p>
          )}

          {phase.kind === 'failed' && (
            <p role="alert" style={{ margin: 0, fontSize: '12px', color: '#991B1B', lineHeight: 1.55 }}>
              {phase.message} Nothing was created, and your guidance is still here — press
              the button again to retry the same request.
            </p>
          )}
        </ReviewSheet>
      )}
    </>
  )
}
