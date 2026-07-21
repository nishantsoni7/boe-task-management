'use client'

import { ReceivedPaymentsView } from '../ReceivedPaymentsView'

// The suspense work queue: received payments with neither an Order nor an Order
// Request. Linking one here moves it to /finance/received/linked.
export default function NonLinkedPaymentsPage() {
  return <ReceivedPaymentsView mode="unlinked" />
}
