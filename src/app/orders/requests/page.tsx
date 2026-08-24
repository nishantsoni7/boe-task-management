'use client'

// /orders/requests — the retired Order Request list.
//
// The list, its tabs, its counts, its create action and its conversion controls
// are gone: Orders now start from a PI upload and reach Confirmed only through
// approval. What remains is an explanation and one way forward, so an old
// bookmark or a link in somebody's message lands somewhere that makes sense
// rather than on a 404.

import { RetiredWorkflowNotice } from './RetiredWorkflowNotice'

export default function RetiredOrderRequestsPage() {
  return <RetiredWorkflowNotice />
}
