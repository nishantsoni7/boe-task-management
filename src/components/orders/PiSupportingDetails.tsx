'use client'

import type { SupabaseClient } from '@supabase/supabase-js'
import { PiHighlightRemark } from './PiHighlightRemark'
import { PiDraftAttachments, PiSentColumns, useSentWithPi, type SupportingState } from './PiSupportingDocuments'

export const SUPPORTING_DETAILS_TITLE = 'Supporting details'

/**
 * SUPPORTING DETAILS: the optional things around a PI, in one row of three
 * areas — Order highlight (40%), Client PO (30%) and Design files (30%) — above
 * Internal order details.
 *
 * Nothing here is needed to submit. Each part keeps the door it always had: the
 * files go through the staging table and the highlight through its own RPC. The
 * billing percentage no longer lives here; it is in Internal order details.
 * PRESENTATION AND ORCHESTRATION ONLY: `canEditFiles` and `canEditHighlight` are
 * the page's can_edit_order_submission answers and every RPC re-derives them.
 *
 * Locked (with management): the same three areas, read-only — no Add, no Save.
 */
export function PiSupportingDetails({
  supabase, submissionId, rowVersion, canEditFiles, canEditHighlight, locked, supporting, submittedAt,
  onSaved, onHighlightRead,
}: {
  supabase: SupabaseClient
  submissionId: string
  rowVersion: number | null
  /** Client PO and Design Files: only while the PI is a draft or returned. */
  canEditFiles: boolean
  /** The Order highlight: can_edit_order_submission, as the page resolved it. */
  canEditHighlight: boolean
  locked: boolean
  supporting: SupportingState
  submittedAt: string | null
  onSaved: () => void | Promise<void>
  onHighlightRead: (state: { available: boolean; remark: string | null } | null) => void
}) {
  const sent = useSentWithPi(supabase, submissionId, submittedAt)
  // Before the migration that lets the database remember files, none are offered.
  const filesOffered = locked ? true : supporting.stagedReadable

  return (
    <section
      id="pi-supporting-details"
      aria-label={SUPPORTING_DETAILS_TITLE}
      className="pi-form-card pi-supporting"
    >
      <div className="pi-form-card-head">
        <h2 className="pi-form-card-title">{SUPPORTING_DETAILS_TITLE}</h2>
      </div>

      <div className="pi-support-row" data-files={filesOffered ? 'on' : 'off'}>
        <div className="pi-support-col pi-support-highlight">
          <PiHighlightRemark
            supabase={supabase}
            submissionId={submissionId}
            canEdit={canEditHighlight && !locked}
            rowVersion={rowVersion}
            onSaved={() => { void onSaved() }}
            onRead={onHighlightRead}
            bare
          />
        </div>
        {locked
          ? <PiSentColumns shown={sent} />
          : <PiDraftAttachments supabase={supabase} state={supporting} canEdit={canEditFiles} />}
      </div>
    </section>
  )
}
