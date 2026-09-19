'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { noteListReturn } from '@/hooks/useListScrollRestore'
import { returnLabelFor, returnPathFrom } from '@/lib/navigation/recordReturn'

type Props = {
  /** Where to go when the record was not opened from a list that said so. */
  fallbackHref: string
  className?: string
}

/**
 * The Back control on an Order or PI record — A LINK TO A NAMED PLACE.
 *
 * It goes to the `returnTo` the opening list handed over (validated by
 * safeReturnPath), so the reader lands on the same tab, filters and page they
 * left, and it names that place: "Back to Confirmed Payments". Without a
 * `returnTo` it goes to the record's own list. It can never leave the app, which
 * router.back() did whenever the record was the first page in the tab.
 *
 * noteListReturn() marks the navigation as a return, so a list that restores
 * its scroll position on Back does so here too.
 */
function BackLinkInner({ fallbackHref, className }: Props) {
  const target = returnPathFrom(useSearchParams()) ?? fallbackHref
  return (
    <Link href={target} className={className} onClick={() => noteListReturn()}>
      <ArrowLeft size={13} strokeWidth={2} aria-hidden="true" /> {returnLabelFor(target)}
    </Link>
  )
}

export function RecordBackLink(props: Props) {
  // useSearchParams needs a Suspense boundary; its fallback is the same link to
  // the record's own list, so the control is never missing.
  return (
    <Suspense fallback={
      <Link href={props.fallbackHref} className={props.className}>
        <ArrowLeft size={13} strokeWidth={2} aria-hidden="true" /> {returnLabelFor(props.fallbackHref)}
      </Link>
    }>
      <BackLinkInner {...props} />
    </Suspense>
  )
}
