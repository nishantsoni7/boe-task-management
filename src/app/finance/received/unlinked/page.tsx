'use client'

import { ReceivedPaymentsView } from '../ReceivedPaymentsView'

// Received payments linked to neither an Order nor an Order Request —
// order_id IS NULL AND order_request_id IS NULL. The genuinely unallocated
// queue: money that arrived with nothing pointing at it, and the only set that
// needs someone to act. Linking one here moves it to /finance/received/linked.
export default function NonLinkedPaymentsPage() {
  return <ReceivedPaymentsView mode="unlinked" />
}
