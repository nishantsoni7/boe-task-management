import { fetchHeadlines } from '@/lib/dailySplash/headlines'

// A short list of public headlines for the home-page splash.
//
// Open to any caller ON PURPOSE: it returns only what the publishers already
// publish, reads nothing from BOE One and takes no input. Upstream feeds are
// read at most once an hour (see fetchHeadlines) and the answer is cached at the
// edge, so the number of people opening the app does not change the load.
export async function GET() {
  const items = await fetchHeadlines()
  return Response.json(
    { items },
    {
      headers: {
        // An empty answer (every feed down) is kept only briefly so it retries soon.
        'Cache-Control': items.length > 0
          ? 'public, s-maxage=3600, stale-while-revalidate=21600'
          : 'public, s-maxage=300',
      },
    },
  )
}
