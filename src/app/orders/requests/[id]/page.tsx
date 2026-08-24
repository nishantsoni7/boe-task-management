'use client'

// /orders/requests/[id] — a retired Order Request's detail route.
//
// Every Order Request notification ever sent carries a request id and deep-links
// here (src/lib/notificationMeta.ts), so this route stays answerable. It shows
// the retirement, offers PI Drafts, and — where the request was converted before
// the retirement and the reader can already open the resulting Order — offers
// that Order too. It offers no action that would restart the workflow.

import { useParams } from 'next/navigation'
import { RetiredWorkflowNotice } from '../RetiredWorkflowNotice'

export default function RetiredOrderRequestDetailPage() {
  const params = useParams()
  const id = typeof params.id === 'string' ? params.id : undefined
  return <RetiredWorkflowNotice requestId={id} />
}
