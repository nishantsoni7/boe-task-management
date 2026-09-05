import type { TestCard } from './types'
import { AWAITING_IMAGES_LABEL, imageReadiness } from './reviewTypes'

// THE NEXT STEP, IN WORDS — what this person should do with this review now.
//
// Every screen in the module already knows the card's status; what a person
// at a phone needs is the one sentence that follows from it: "Open WhatsApp
// and send it", "Confirm you sent it", "Attach your screenshot", "Ready to
// verify". This file writes that sentence from the card and the viewer, and
// nothing else. It decides no permission and performs no action — the
// browser-side mirrors in ./status decide what buttons exist, and the
// database decides what happens.
//
// The five facts the module keeps apart stay apart here: booked, opened,
// sent, submitted, verified are five different sentences.

export type NextStepTone = 'act' | 'wait' | 'done' | 'attention'

export type NextStep = {
  /** The short headline: "Open WhatsApp", "Waiting for verification". */
  headline: string
  /** One sentence of guidance. Null when the headline is enough. */
  hint: string | null
  /**
   * act        this person has something to do
   * attention  this person has something to fix (a returned review)
   * wait       somebody else's move
   * done       nothing further
   */
  tone: NextStepTone
}

export type NextStepViewer = {
  userId: string | null
  canUse: boolean
  canVerify: boolean
}

type StepCard = Pick<
  TestCard,
  'status' | 'booked_by' | 'whatsapp_opened_at' | 'sent_confirmed_at' | 'returned_at' | 'return_reason' | 'deleted_at'
  // Readiness is a sentence a person reads, so the two columns it is written
  // from travel with the row that the sentence is about.
  | 'review_type' | 'image_group_id'
>

/**
 * What to do next, for this viewer.
 *
 * `hasScreenshot` is passed in where the screen knows it (the detail page);
 * a list tile does not, and gets the sentence that covers both halves.
 */
export function nextStepFor(
  card: StepCard,
  viewer: NextStepViewer,
  hasScreenshot?: boolean,
): NextStep {
  if (card.deleted_at) {
    return { headline: 'Deleted', hint: 'A verifier removed this review from the workflow.', tone: 'done' }
  }

  const mine = !!viewer.userId && card.booked_by === viewer.userId

  switch (card.status) {
    case 'pending_approval':
      return viewer.canVerify
        ? { headline: 'Approve or edit this draft', hint: 'Candidates cannot see it until it has been approved.', tone: 'act' }
        : { headline: 'Awaiting approval', hint: null, tone: 'wait' }

    case 'available': {
      // AN IMAGE REVIEW WITHOUT ITS PROJECT IS NOT A THING TO ACT ON, and
      // saying "View, then book it" beside a Book button that refuses would be
      // the worst of both. Whose move it is decides the tone: the candidate is
      // waiting, the verifier is the person who has to do something.
      if (imageReadiness(card) === 'awaiting_images') {
        return viewer.canVerify
          ? {
              headline: 'Attach the project images',
              hint: 'This image review cannot be booked until a project group is attached to it.',
              tone: 'attention',
            }
          : {
              headline: AWAITING_IMAGES_LABEL,
              hint: 'An administrator is preparing the project photographs for this review.',
              tone: 'wait',
            }
      }
      return viewer.canUse
        ? { headline: 'View, then book it', hint: 'Read the full review before you take it.', tone: 'act' }
        : { headline: 'Available to candidates', hint: null, tone: 'wait' }
    }

    case 'booked': {
      if (!mine) {
        return {
          headline: card.sent_confirmed_at ? 'Sent · awaiting the screenshot and submission' : 'Booked · not sent yet',
          hint: viewer.canVerify ? 'The candidate holding it is still working on it.' : null,
          tone: 'wait',
        }
      }
      // The holder's own path, in the order it happens.
      if (card.returned_at && card.sent_confirmed_at) {
        return {
          headline: 'Returned — fix and resubmit',
          hint: card.return_reason ? `Verifier: ${card.return_reason}` : 'Check the verifier’s note, attach the evidence again and submit.',
          tone: 'attention',
        }
      }
      if (!card.whatsapp_opened_at) {
        return { headline: 'Open WhatsApp and send it', hint: 'Enter the number, send the message, then come back and confirm you sent it.', tone: 'act' }
      }
      if (!card.sent_confirmed_at) {
        return { headline: 'Confirm you sent it', hint: 'Only after you actually pressed send in WhatsApp.', tone: 'act' }
      }
      if (hasScreenshot === false) {
        return { headline: 'Attach your screenshot', hint: 'A screenshot of the message you sent, then submit for verification.', tone: 'act' }
      }
      if (hasScreenshot === true) {
        return { headline: 'Submit for verification', hint: 'Your evidence is attached — hand it to a verifier.', tone: 'act' }
      }
      return { headline: 'Attach your screenshot and submit', hint: 'A screenshot of the message you sent, then submit for verification.', tone: 'act' }
    }

    case 'submitted':
      if (viewer.canVerify) {
        return { headline: 'Ready to verify', hint: 'Check the screenshot, then verify — or return it with a reason.', tone: 'act' }
      }
      return { headline: 'Waiting for verification', hint: 'A verifier will check your screenshot. You will see the credit once it is verified.', tone: 'wait' }

    case 'verified':
      return { headline: 'Verified', hint: 'The credit is on the tester’s ledger.', tone: 'done' }
  }
}

/** The four stages a booked review moves through, and how far this card has come. */
export const REVIEW_STAGES = ['Booked', 'Sent', 'Submitted', 'Verified'] as const

export function stageIndex(card: Pick<TestCard, 'status' | 'sent_confirmed_at'>): number {
  if (card.status === 'verified') return 4
  if (card.status === 'submitted') return 3
  if (card.status === 'booked') return card.sent_confirmed_at ? 2 : 1
  return 0
}
