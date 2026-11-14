// THIS RECORD PAGE IS PREPARED ONCE, THEN SERVED FROM THE CACHE (2026-11-14).
//
// Same recipe and same safety argument as src/app/orders/[id]/layout.tsx: the page is a client
// component that reads its data in the browser under the signed-in person's own access, so what the
// server sends is identical for every reader. Without this, a route with a dynamic segment is rendered
// by a server function in Tokyo on EVERY open (about 0.46 s from India, with the odd cold start);
// with it, the page is prepared the first time an address is asked for and then served from the
// edge cache (about 0.27 s). Nothing private is cached, and if anything under this route ever read
// cookies or headers on the server Next would refuse to cache it. Guard:
// src/lib/performance/recordPagesCached.test.ts.

export function generateStaticParams() {
  return []
}

export default function RecordLayout({ children }: { children: React.ReactNode }) {
  return children
}
