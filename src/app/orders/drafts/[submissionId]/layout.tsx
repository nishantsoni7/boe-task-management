// A PI DRAFT'S PAGE IS PREPARED ONCE, THEN SERVED FROM THE CACHE (2026-10-22).
//
// Same reasoning, same mechanism as src/app/orders/[id]/layout.tsx: the page is a client component
// that reads its data in the browser under the reader's own access, so its server output is the
// same for every draft. Left dynamic, every open waited for a server function before the first data
// read could leave, and the link's prefetch could not help. An empty generateStaticParams makes Next
// prepare each draft the first time it is asked for and keep it.
//
// Nothing private is cached: there is no draft data in the server output, and anything that read
// cookies or headers on the server would make Next refuse to cache the route at all.

export function generateStaticParams() {
  return []
}

export default function PiDraftRecordLayout({ children }: { children: React.ReactNode }) {
  return children
}
