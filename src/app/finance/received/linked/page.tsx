'use client'

import { ReceivedPaymentsView } from '../ReceivedPaymentsView'

// Received payments already attached to a business record — a Confirmed Order,
// or an Order Request still awaiting conversion (20260698's linkage, which
// transfers itself to the Order on conversion).
export default function LinkedPaymentsPage() {
  return <ReceivedPaymentsView mode="linked" />
}
