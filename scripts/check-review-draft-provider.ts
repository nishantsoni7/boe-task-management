/**
 * THE ONE THING THE REST OF THE VERIFICATION CANNOT PROVE.
 *
 *   ANTHROPIC_API_KEY=... npx tsx scripts/check-review-draft-provider.ts
 *   ANTHROPIC_API_KEY=... npx tsx scripts/check-review-draft-provider.ts --guidance "..."
 *
 * Everything downstream of the model is already proven: the validator against a
 * corpus, the batch function against a live Postgres, the atomicity, the
 * concurrency. What is NOT proven is the provider request itself — whether the
 * real endpoint, with the real key and the real prompts, returns twenty drafts
 * this module's own validator accepts.
 *
 * This makes exactly that one call and nothing else.
 *
 * WHAT IT WILL NOT DO
 *   * It never touches a database. It has no Supabase client and no connection
 *     string, so it cannot insert a card, create a batch, or read one.
 *   * It never writes a file and never opens a browser.
 *   * It makes ONE request. No retry, no loop, no second attempt on a refusal,
 *     because every call is billable and a script that retries on its own is a
 *     script that can spend without being asked.
 *   * It does not print the key, and does not print the key's length.
 *
 * WHY THIS RATHER THAN PRESSING THE BUTTON ON A PREVIEW. A preview deployment
 * shares production's database, where 20261023000000 is not applied and the
 * sixteen cards are still available — so the route refuses at the pool check
 * (409) long before it reaches the provider, and pressing the button proves
 * nothing about the model. That refusal is correct behaviour, which is exactly
 * why it cannot be the test. This exercises the provider half in isolation, on
 * the same prompts and the same validator the route uses.
 *
 * READING THE RESULT
 *   exit 0  the provider returned twenty drafts and validateDrafts accepted
 *           them. The generation path is proven end to end.
 *   exit 1  the provider answered but the output was refused. The batch would
 *           have been rejected and nothing inserted — the guard worked, and the
 *           printed reason says which draft and why.
 *   exit 2  the call itself failed: no key, bad key, network, rate limit. The
 *           HTTP status is printed; the body is not, because a provider error
 *           body can carry request detail.
 */

import {
  DRAFTS_PER_BATCH,
  GENERATION_MODEL,
  buildSystemPrompt,
  buildUserPrompt,
  validateDrafts,
  validateGuidance,
} from '../src/lib/customerReviews/draftGeneration'

async function main(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set. Nothing was called.')
    return 2
  }

  const flagAt = process.argv.indexOf('--guidance')
  const guidance = flagAt > -1 && process.argv[flagAt + 1]
    ? process.argv[flagAt + 1]
    : 'Hospitality furniture for hotels, restaurants, cafes and resorts. Mix bulk orders and customised work. Vary the length, the tone and the subject across design coordination, quality, customisation, packaging, delivery, communication and issue resolution.'

  const checked = validateGuidance(guidance)
  if (!checked.ok) {
    console.error(`The guidance is not valid: ${checked.error}`)
    return 2
  }

  console.log(`model     ${GENERATION_MODEL}`)
  console.log(`guidance  ${checked.guidance.slice(0, 100)}${checked.guidance.length > 100 ? '…' : ''}`)
  console.log(`asking for ${DRAFTS_PER_BATCH} drafts — ONE call, no retry\n`)

  let response
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      GENERATION_MODEL,
        max_tokens: 8000,
        system:     buildSystemPrompt(),
        messages:   [{ role: 'user', content: buildUserPrompt(checked.guidance) }],
      }),
    })
  } catch (error) {
    console.error(`The request did not complete: ${error instanceof Error ? error.name : 'unknown error'}`)
    return 2
  }

  if (!response.ok) {
    // The status, never the body: a provider error body can echo request detail.
    console.error(`The provider answered ${response.status}. Nothing was validated.`)
    return 2
  }

  const payload = await response.json()

  if (payload.stop_reason === 'refusal') {
    console.error('The model refused the request. The route treats this as a failed batch and inserts nothing.')
    return 1
  }

  type Block = { type: string; text?: string }
  const text = ((payload.content ?? []) as Block[])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')

  const result = validateDrafts(text)

  if (!result.ok) {
    console.error(`REFUSED by validateDrafts: ${result.error}`)
    console.error('The route would have returned 502 and inserted nothing. The guard held.')
    return 1
  }

  console.log(`ACCEPTED — ${result.drafts.length} drafts, all valid.\n`)
  for (const [i, draft] of result.drafts.entries()) {
    console.log(`${String(i + 1).padStart(2)}. [${draft.category}] ${draft.title}`)
    console.log(`    ${draft.body.length} chars — ${draft.body.slice(0, 96)}…`)
  }

  const usage = payload.usage ?? {}
  console.log(`\ntokens    in ${usage.input_tokens ?? '?'}, out ${usage.output_tokens ?? '?'} (one call)`)
  console.log('No database was contacted and nothing was written.')

  return 0
}

main().then(code => { process.exitCode = code })
