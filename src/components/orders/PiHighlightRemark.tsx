'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Lock, Star } from 'lucide-react'
import { colors } from '@/lib/tokens'
import {
  HIGHLIGHT_REMARK_COLUMN,
  HIGHLIGHT_REMARK_EMPTY,
  HIGHLIGHT_REMARK_MAX,
  HIGHLIGHT_REMARK_NOTE,
  HIGHLIGHT_REMARK_OPTIONAL,
  HIGHLIGHT_REMARK_PLACEHOLDER,
  HIGHLIGHT_REMARK_RPC,
  HIGHLIGHT_REMARK_TAG,
  HIGHLIGHT_REMARK_TITLE,
  ORDER_HIGHLIGHT_LABEL,
  highlightRemarkProblem,
  highlightRemarkSaveFailure,
  normalizeHighlightRemark,
  readHighlightRemark,
} from '@/lib/orders/highlightRemark'

// ── The PI draft's editor ─────────────────────────────────────────────────────

/**
 * THE ORDER HIGHLIGHT, ON THE PI DRAFT. Optional; an internal note for whoever
 * works the Confirmed Order. Presentation only: `canEdit` is the page's
 * can_edit_order_submission answer, and the RPC re-derives it.
 *
 * A viewer who may not edit sees the remark as text, or nothing at all when
 * there is none — an empty labelled box would only say "nobody wrote one".
 */
export function PiHighlightRemarkView({
  remark, canEdit, draft, onDraftChange, onSave, saving, failure, saved, bare = false,
}: {
  remark: string | null
  canEdit: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSave: () => void
  saving: boolean
  failure: string | null
  saved: boolean
  /** Drawn inside a card that already frames it: no border or padding of its own. */
  bare?: boolean
}) {
  if (!canEdit && remark === null) return null
  const problem = highlightRemarkProblem(draft)
  const dirty = normalizeHighlightRemark(draft) !== remark
  const id = 'pi-highlight-remark'
  return (
    <section className={bare ? 'pi-detail-highlight pi-detail-highlight--bare' : 'pi-detail-highlight'} aria-label={HIGHLIGHT_REMARK_TITLE}>
      <div className="pi-detail-highlight-head">
        <label htmlFor={canEdit ? id : undefined} className="pi-detail-highlight-title">
          {HIGHLIGHT_REMARK_TITLE}
        </label>
        <span className="pi-detail-internal-tag" title={HIGHLIGHT_REMARK_NOTE}>
          <Lock size={10} strokeWidth={2.2} aria-hidden />
          {HIGHLIGHT_REMARK_TAG}
        </span>
        {canEdit && <span className="pi-detail-highlight-optional">{HIGHLIGHT_REMARK_OPTIONAL}</span>}
      </div>

      {canEdit ? (
        <>
          <textarea
            id={id}
            className="pi-detail-highlight-input"
            rows={bare ? 2 : 3}
            value={draft}
            placeholder={HIGHLIGHT_REMARK_PLACEHOLDER}
            disabled={saving}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}-note`}
            onChange={e => onDraftChange(e.target.value)}
          />
          <div className="pi-detail-highlight-foot">
            <span id={`${id}-note`} className="pi-detail-highlight-note">{HIGHLIGHT_REMARK_NOTE}</span>
            <span className="pi-detail-highlight-count" aria-hidden>
              {draft.trim().length}/{HIGHLIGHT_REMARK_MAX}
            </span>
            <button
              type="button"
              className="boe-btn boe-btn-ghost"
              disabled={saving || !dirty || !!problem}
              onClick={onSave}
            >
              {saving ? 'Saving…' : 'Save highlight'}
            </button>
          </div>
          {problem && <div role="alert" className="pi-detail-highlight-error">{problem}</div>}
          {!problem && failure && <div role="alert" className="pi-detail-highlight-error">{failure}</div>}
          {!problem && !failure && saved && !dirty && (
            <div role="status" className="pi-detail-highlight-saved">Saved</div>
          )}
        </>
      ) : (
        <>
          <p className="pi-detail-highlight-text">{remark ?? HIGHLIGHT_REMARK_EMPTY}</p>
          <span className="pi-detail-highlight-note">{HIGHLIGHT_REMARK_NOTE}</span>
        </>
      )}
    </section>
  )
}

type RemarkRead = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; remark: string | null }

/** Reads the one column, tolerating a database that does not have it yet. */
function useHighlightRemark(supabase: SupabaseClient, submissionId: string | null, refreshKey: unknown) {
  const [read, setRead] = useState<RemarkRead>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    void (async () => {
      if (!submissionId) { setRead({ kind: 'unavailable' }); return }
      try {
        const { data, error } = await supabase
          .from('order_submissions')
          .select(HIGHLIGHT_REMARK_COLUMN)
          .eq('id', submissionId)
          .maybeSingle()
        if (!live) return
        setRead(error || !data ? { kind: 'unavailable' } : { kind: 'ready', remark: readHighlightRemark(data) })
      } catch {
        if (live) setRead({ kind: 'unavailable' })
      }
    })()
    return () => { live = false }
  }, [supabase, submissionId, refreshKey])
  return [read, setRead] as const
}

/**
 * The draft page's highlight: reads its own column and saves through its own
 * RPC, so the page's main read never depends on this migration being applied.
 * `refreshKey` is the PI's row_version; `onSaved` lets the page re-read, so
 * the next write elsewhere carries the new version.
 */
export function PiHighlightRemark({ supabase, submissionId, canEdit, rowVersion, onSaved, onRead, bare = false }: {
  supabase: SupabaseClient
  submissionId: string
  canEdit: boolean
  rowVersion: number | null
  onSaved: () => void
  /**
   * What the box last read, so the page's checklist can say whether the
   * optional highlight is still empty without reading the column a second time.
   * Null while it is loading.
   */
  onRead?: (state: { available: boolean; remark: string | null } | null) => void
  bare?: boolean
}) {
  const [read, setRead] = useHighlightRemark(supabase, submissionId, rowVersion)
  useEffect(() => {
    onRead?.(read.kind === 'ready' ? { available: true, remark: read.remark }
      : read.kind === 'unavailable' ? { available: false, remark: null } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read])
  // NULL UNTIL SOMEBODY TYPES: the box shows what is stored, and a re-read
  // never overwrites text that has not been saved.
  const [edited, setEdited] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const stored = read.kind === 'ready' ? read.remark : null
  const draft = edited ?? stored ?? ''

  if (read.kind !== 'ready') return null

  const save = async () => {
    if (saving) return
    setSaving(true)
    setFailure(null)
    setSaved(false)
    try {
      const { error } = await supabase.rpc(HIGHLIGHT_REMARK_RPC, {
        p_submission_id: submissionId,
        p_remark: normalizeHighlightRemark(draft),
        p_expected_version: rowVersion,
      })
      if (error) { setFailure(highlightRemarkSaveFailure(error)); return }
      setRead({ kind: 'ready', remark: normalizeHighlightRemark(draft) })
      setEdited(null)
      setSaved(true)
      onSaved()
    } catch (error) {
      setFailure(highlightRemarkSaveFailure(error as { message?: string }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <PiHighlightRemarkView
      remark={stored}
      canEdit={canEdit}
      draft={draft}
      onDraftChange={value => { setEdited(value); setSaved(false); setFailure(null) }}
      onSave={() => void save()}
      saving={saving}
      failure={failure}
      saved={saved}
      bare={bare}
    />
  )
}

// ── The Confirmed Order's banner ──────────────────────────────────────────────

/**
 * THE HIGHLIGHT, AT THE TOP OF THE CONFIRMED ORDER. Read-only: it was written on
 * the PI before approval and is read from that PI row, under the Order viewer's
 * own RLS. Nothing is drawn when there is none, or when it cannot be read.
 */
export function OrderHighlightRemarkBanner({ remark }: { remark: string | null }) {
  if (!remark) return null
  return (
    <section className="order-highlight" aria-label={ORDER_HIGHLIGHT_LABEL} style={{
      display: 'flex', gap: '12px', alignItems: 'flex-start',
      border: `1px solid ${colors.amber}`, background: colors.amberTint,
      borderRadius: '10px', padding: '12px 16px', minWidth: 0,
    }}>
      <Star size={16} color={colors.amber} aria-hidden style={{ flexShrink: 0, marginTop: '2px' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: colors.primary, letterSpacing: '0.02em' }}>
            {ORDER_HIGHLIGHT_LABEL}
          </span>
          <span className="pi-detail-internal-tag" title={HIGHLIGHT_REMARK_NOTE}>
            <Lock size={10} strokeWidth={2.2} aria-hidden />
            BOE only
          </span>
        </div>
        <p style={{
          margin: 0, fontSize: '14px', fontWeight: 600, lineHeight: 1.45, color: colors.primary,
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        }}>
          {remark}
        </p>
      </div>
    </section>
  )
}

/** The Confirmed Order's read of the PI's highlight. */
export function OrderHighlightRemark({ supabase, submissionId, refreshKey }: {
  supabase: SupabaseClient
  submissionId: string | null
  refreshKey?: unknown
}) {
  const [read] = useHighlightRemark(supabase, submissionId, refreshKey)
  return <OrderHighlightRemarkBanner remark={read.kind === 'ready' ? read.remark : null} />
}
