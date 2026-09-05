'use client'

import { useCallback, useRef, useState } from 'react'
import { Loader2, Share2 } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { buildReviewMessage } from '@/lib/customerReviews/internalTest'
import { AWAITING_IMAGES_LABEL } from '@/lib/customerReviews/reviewTypes'
import {
  MANUAL_ATTACH_INSTRUCTION,
  downloadFileName,
  isShareableReview,
  shareCapability,
} from '@/lib/customerReviews/sharing'
import { testCategoryLabel, type TestCard } from '@/lib/customerReviews/types'

/**
 * The two things this control needs of an image, and nothing else.
 *
 * DELIBERATELY NARROWER THAN EITHER ROW TYPE. A per-card `review_image`
 * (TestCardPhoto) and a project group image (ReviewGroupImage) are different
 * records in different tables in different buckets; what they have in common is
 * an object key and a decoded MIME type, which is all a share sheet wants.
 * Naming that overlap is what lets ONE share path serve both without a branch
 * on which kind it was handed.
 */
export type ShareableImage = { storage_path: string; mime_type: string }

const AWAITING_IMAGES_MESSAGE =
  `${AWAITING_IMAGES_LABEL}. This image review cannot be shared until an administrator `
  + 'attaches a project with photographs in it.'

// ── Handing an approved review to the share sheet ────────────────────────────
//
// WHAT THIS DOES. It gathers the review's text and its attached images and
// hands both to `navigator.share`. The operating system opens its own sheet;
// the person picks WhatsApp, picks a recipient, and presses send.
//
// WHAT IT DOES NOT DO, AND CANNOT
//   * IT DOES NOT SEND ANYTHING. There is no WhatsApp Business API in this
//     repository, no Meta credential, no template and no outbound request in
//     this file. Every word of copy below is written to avoid implying
//     otherwise: the button says "Share review", the success state says the
//     sheet was opened, and nothing anywhere says "sent".
//   * THE IMAGES AN IMAGE REVIEW CARRIES ARE ITS PROJECT GROUP'S. The old
//     per-card `review_image` attachment plays no part in an image review:
//     the caller reads the group through its own RLS and hands the files
//     here. A text review still carries whatever per-card images it has.
//   * IT DOES NOT TOUCH A PENDING DRAFT, OR AN IMAGE REVIEW WITH NO PROJECT.
//     isShareableReview() is asked first and the control is not rendered at all
//     when the answer is no. Nothing about a review awaiting approval leaves
//     this application, and an image review whose photographs are not ready
//     cannot be shared as text alone — which would send a review about how
//     something LOOKS with nothing to look at.
//   * IT DOES NOT MAKE ANYTHING PUBLIC. The images are fetched through
//     short-lived signed URLs, in the browser, under the same policy that
//     governs reading the card. No public URL is minted and nothing is uploaded
//     anywhere.
//
// ── THE TWO PATHS, AND WHY THE FALLBACK IS NOT A LESSER ONE ────────────────
//
// `canShare` IS ASKED BEFORE `share`, with the real files. A browser that has
// `share` but cannot take these files does not fail gracefully on its own — it
// rejects, sometimes after the sheet has already flickered open.
//
// When files cannot go, the fallback does the two things the share sheet would
// have done, separately: the text goes to the clipboard and the images are
// saved to the device. It deliberately does NOT fall back to a text-only share,
// because that would send a review about furniture without the pictures of it,
// silently, and the sender would never know. See shareCapability().
//
// THE EXISTING TEXT-ONLY WHATSAPP WORKFLOW IS UNTOUCHED. WhatsAppLaunch still
// asks the server for a wa.me link for a booked card with no images involved.
// This is a different control for a different moment, and neither replaces the
// other.

const SIGNED_URL_TTL_SECONDS = 300

type ShareState =
  | { kind: 'idle' }
  | { kind: 'working' }
  /** The sheet was opened. NOT "sent" — we cannot know that, and never claim it. */
  | { kind: 'opened' }
  /** Text copied and images saved; the person finishes the job by hand. */
  | { kind: 'manual' }
  | { kind: 'error'; message: string }

export function ShareReviewButton({
  supabase,
  card,
  images,
  bucket,
  groupUsable,
}: {
  supabase: SupabaseClient
  card: TestCard
  /**
   * The images that go out with this review. Live only — the caller's query
   * filters removals out.
   *
   * FOR AN IMAGE REVIEW THESE ARE THE PROJECT GROUP'S, and that is the whole of
   * this control's contract with the rest of the module: a project image group
   * is the authoritative source for an image review, and the old per-card
   * `review_image` attachment plays no part in it. For a text review they are
   * whatever per-card images a verifier attached, exactly as before.
   */
  images: ShareableImage[]
  /** Which private bucket `images` live in. The two kinds do not share one. */
  bucket: string
  /**
   * For an image review: the group exists, is not archived and holds a live
   * image. Passed rather than assumed, because this is the one control that
   * must not admit a review it cannot actually deliver.
   */
  groupUsable?: boolean
}) {
  const [state, setState] = useState<ShareState>({ kind: 'idle' })
  const inFlight = useRef(false)

  // THE GATE, ASKED BEFORE ANYTHING IS RENDERED. A pending draft has no share
  // control at all — not a disabled one, which would be a thing to try to
  // enable. An image review whose project is missing, archived or empty is
  // refused here too, for the same reason and by the same function.
  const shareable = isShareableReview(card, groupUsable)

  const run = useCallback(async () => {
    if (inFlight.current) return
    // Re-asked at the moment of action, not only at render. The row may have
    // been refreshed since this button was drawn.
    if (!isShareableReview(card, groupUsable)) {
      // TWO REASONS, AND THEY NEED DIFFERENT SENTENCES. An unapproved review is
      // waiting for a verifier to read it; an image review whose project is
      // missing, archived or empty is waiting for somebody to attach usable
      // photographs. Telling the second person the first sentence would send
      // them to ask the wrong question.
      setState({
        kind: 'error',
        message: card.review_type === 'image'
          ? AWAITING_IMAGES_MESSAGE
          : 'Only an approved review can be shared.',
      })
      return
    }
    inFlight.current = true
    setState({ kind: 'working' })

    try {
      const text = buildReviewMessage({
        title: card.test_title,
        body: card.test_body,
        categoryLabel: testCategoryLabel(card.test_category),
        reference: card.card_ref,
      })
      const title = card.test_title

      const files = await loadImageFiles(supabase, card, bucket, images)

      // ── AN IMAGE REVIEW NEVER GOES OUT AS TEXT ALONE ────────────────────
      //
      // isShareableReview() has already said this review HAS usable project
      // images. If none of them actually loaded — an expired signature, a
      // dropped connection, an object removed between the read and now — then
      // the thing we are about to hand over is not the thing the candidate was
      // asked to post.
      //
      // shareCapability() would answer `text` for an empty file list, which is
      // exactly right for a text review and exactly wrong here: the share sheet
      // reports nothing back, so the candidate would send a review about how
      // something LOOKS with nothing to look at and have no way to notice.
      // Refusing is the honest outcome, and it is recoverable — pressing Share
      // again re-signs the URLs.
      if (card.review_type === 'image' && files.length === 0) {
        setState({
          kind: 'error',
          // NOTE THE WORDING, and it is not incidental: this component may not
          // contain the word "sent" anywhere outside "press send yourself",
          // because no state here can know whether a message left anybody's
          // phone. reviewSharing.test.ts enforces that bluntly, on purpose —
          // so the sentence says what this code actually observed.
          message: 'The project images for this review could not be loaded, so nothing was shared — '
            + 'an image review never goes out as text alone. Check your connection and try again.',
        })
        return
      }

      const capability = shareCapability(
        typeof navigator === 'undefined' ? undefined : (navigator as unknown as Parameters<typeof shareCapability>[0]),
        { title, text, files },
      )

      if (capability.kind === 'files' || capability.kind === 'text') {
        try {
          await navigator.share(
            capability.kind === 'files' ? { title, text, files } : { title, text },
          )
          setState({ kind: 'opened' })
          return
        } catch (err) {
          // A DISMISSED SHEET IS NOT A FAILURE. The user closing the share sheet
          // rejects with AbortError, and reporting that as an error would tell
          // somebody their deliberate choice went wrong.
          if (err instanceof DOMException && err.name === 'AbortError') {
            setState({ kind: 'idle' })
            return
          }
          // Anything else falls through to the manual path rather than dead-ending.
        }
      }

      await copyAndDownload(text, files)
      setState({ kind: 'manual' })
    } catch {
      setState({ kind: 'error', message: 'That review could not be prepared for sharing. Try again.' })
    } finally {
      inFlight.current = false
    }
  }, [supabase, card, images, bucket, groupUsable])

  if (!shareable) return null

  const working = state.kind === 'working'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={run}
          disabled={working}
          className="boe-btn boe-btn-primary"
          style={{ fontSize: '12px', padding: '9px 14px', minHeight: '44px' }}
        >
          {working
            ? <Loader2 size={13} strokeWidth={2.4} style={{ animation: 'boe-spin 0.8s linear infinite' }} />
            : <Share2 size={13} strokeWidth={2} />}
          {working ? 'Preparing…' : 'Share review'}
        </button>
        <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.45 }}>
          {/*
            SAYS WHERE THE IMAGES CAME FROM, not just how many. A candidate
            sharing an image review is posting one project's photographs, and
            the sentence beside the button is where they can check that before
            the share sheet takes over.
          */}
          {images.length === 0
            ? 'The review text.'
            : card.review_type === 'image'
              ? `The review and its ${images.length} project image${images.length === 1 ? '' : 's'}.`
              : `The review and its ${images.length} image${images.length === 1 ? '' : 's'}.`}
        </span>
      </div>

      {/*
        role="status" so every outcome is announced. The wording is chosen so
        that no state claims a message was sent — because none of them knows.
      */}
      <span role="status" style={{ fontSize: '11px', lineHeight: 1.55, color: state.kind === 'error' ? colors.red : colors.tertiary }}>
        {state.kind === 'opened'
          ? 'Your share sheet was opened. Choose WhatsApp and the recipient there, then press send yourself — BOE does not send anything for you.'
          : state.kind === 'manual'
            ? MANUAL_ATTACH_INSTRUCTION
            : state.kind === 'error'
              ? state.message
              : ' '}
      </span>
    </div>
  )
}

/**
 * The attached images, as Files the share sheet will accept.
 *
 * Fetched in the BROWSER through short-lived signed URLs, which are governed by
 * the same SELECT policy that decides who may read the card. A viewer who has
 * lost access gets no URL and therefore no file — the same answer the rest of
 * the module gives.
 *
 * AN IMAGE THAT WILL NOT LOAD IS SKIPPED, not fatal. Four images and one
 * expired signature should share three images, not refuse the review.
 */
async function loadImageFiles(
  supabase: SupabaseClient,
  card: TestCard,
  bucket: string,
  images: ShareableImage[],
): Promise<File[]> {
  if (images.length === 0) return []

  const paths = images.map(i => i.storage_path)
  const { data } = await supabase.storage
    .from(bucket)
    .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
  if (!data) return []

  const files: File[] = []
  for (let index = 0; index < data.length; index++) {
    const signed = data[index]?.signedUrl
    if (!signed) continue
    try {
      const response = await fetch(signed)
      if (!response.ok) continue
      const blob = await response.blob()
      const image = images[index]
      files.push(new File([blob], downloadFileName(card.card_ref, index, image.mime_type), {
        type: image.mime_type,
      }))
    } catch {
      // One unreadable object does not stop the others.
    }
  }
  return files
}

/**
 * The fallback: the text on the clipboard, the images on the device.
 *
 * Both halves are attempted independently, because a clipboard refused by
 * permission policy should not cost somebody their images.
 */
async function copyAndDownload(text: string, files: File[]) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
  } catch {
    // Reported through the instruction sentence rather than as a separate
    // failure — the person can still select the review text on screen.
  }

  for (const file of files) {
    const url = URL.createObjectURL(file)
    try {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.name
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } finally {
      // Revoked on the next tick: revoking synchronously can cancel the
      // download the click has only just started.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }
  }
}
