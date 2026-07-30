/**
 * performanceLoadState — behavioural tests
 *
 * The case that matters is the one that was wrong in production: a failed
 * request left the progress loader on screen at 90% forever, because the
 * loader was keyed on "no data yet" rather than "still loading".
 *
 * Run:
 *   npx tsx --test src/lib/performanceLoadState.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyHttpStatus, toLoadError, isTerminal, shouldShowLoader,
  nextProgress, isRetryable, shouldRedirectToLogin, isEmptyResult,
  LOAD_ERROR_MESSAGE, PROGRESS_CEILING,
  type LoadState,
} from './performanceLoadState'

const loading: LoadState = { phase: 'loading' }
const ready:   LoadState = { phase: 'ready' }

describe('classifyHttpStatus', () => {
  test('401 is an auth failure', () => {
    assert.equal(classifyHttpStatus(401), 'auth')
  })
  test('403 is a management-only restriction', () => {
    assert.equal(classifyHttpStatus(403), 'forbidden')
  })
  test('400 is a bad request, not a server fault', () => {
    assert.equal(classifyHttpStatus(400), 'invalid')
  })
  test('500 and other unexpected statuses are server faults', () => {
    assert.equal(classifyHttpStatus(500), 'server')
    assert.equal(classifyHttpStatus(502), 'server')
    assert.equal(classifyHttpStatus(418), 'server')
  })
})

describe('the loader always clears — the 90% freeze regression', () => {
  test('a loading state shows the loader', () => {
    assert.equal(shouldShowLoader(loading, false), true)
  })

  test('a successful state clears the loader', () => {
    assert.equal(shouldShowLoader(ready, false), false)
  })

  test('EVERY error kind clears the loader', () => {
    // This is the regression. A 500 from the team endpoint used to leave the
    // loader up because `data` was still null.
    for (const kind of ['auth', 'forbidden', 'invalid', 'server', 'network'] as const) {
      assert.equal(
        shouldShowLoader(toLoadError(kind), false), false,
        `${kind} must not keep the loader on screen`,
      )
    }
  })

  test('once dismissed the loader never returns, even on a refetch', () => {
    assert.equal(shouldShowLoader(loading, true), false)
  })
})

describe('nextProgress', () => {
  test('advances while loading', () => {
    assert.equal(nextProgress(10, loading, 5), 15)
  })

  test('is capped while loading so it cannot claim completion early', () => {
    assert.equal(nextProgress(88, loading, 10), PROGRESS_CEILING)
    assert.equal(nextProgress(PROGRESS_CEILING, loading, 10), PROGRESS_CEILING)
  })

  test('completes on success', () => {
    assert.equal(nextProgress(37, ready, 5), 100)
  })

  test('completes on failure rather than stalling at the ceiling', () => {
    assert.equal(nextProgress(PROGRESS_CEILING, toLoadError('server'), 5), 100)
    assert.equal(nextProgress(12, toLoadError('forbidden'), 5), 100)
  })
})

describe('isTerminal', () => {
  test('loading is not terminal; ready and error are', () => {
    assert.equal(isTerminal(loading), false)
    assert.equal(isTerminal(ready), true)
    assert.equal(isTerminal(toLoadError('network')), true)
  })
})

describe('error messages never leak database internals', () => {
  test('no message mentions a column, table, SQL or Postgres error code', () => {
    const forbidden = /\b(column|table|select|postgres|sqlstate|relation)\b|users\.|42703|exit_date/i
    for (const [kind, message] of Object.entries(LOAD_ERROR_MESSAGE)) {
      assert.ok(
        !forbidden.test(message),
        `${kind} message leaks an internal: ${message}`,
      )
    }
  })

  test('the generic server failure is the short usable line the owner asked for', () => {
    assert.equal(LOAD_ERROR_MESSAGE.server, 'Team Performance could not be loaded.')
  })

  test('403 states the restriction in management terms', () => {
    assert.match(LOAD_ERROR_MESSAGE.forbidden, /restricted to management/i)
  })
})

describe('isRetryable', () => {
  test('server and network failures offer a retry', () => {
    assert.equal(isRetryable('server'), true)
    assert.equal(isRetryable('network'), true)
  })

  test('authorization and validation failures do not — retrying cannot help', () => {
    assert.equal(isRetryable('auth'), false)
    assert.equal(isRetryable('forbidden'), false)
    assert.equal(isRetryable('invalid'), false)
  })
})

describe('shouldRedirectToLogin', () => {
  test('only 401 bounces to login; 403 stays and explains', () => {
    assert.equal(shouldRedirectToLogin('auth'), true)
    assert.equal(shouldRedirectToLogin('forbidden'), false)
    assert.equal(shouldRedirectToLogin('server'), false)
  })
})

describe('empty data is an empty state, not a failure', () => {
  test('a successful response with no employees is empty', () => {
    assert.equal(isEmptyResult(ready, 0), true)
  })

  test('a successful response with employees is not empty', () => {
    assert.equal(isEmptyResult(ready, 3), false)
  })

  test('a still-loading state is never reported as empty', () => {
    assert.equal(isEmptyResult(loading, 0), false)
  })

  test('a failed request is never reported as empty', () => {
    assert.equal(isEmptyResult(toLoadError('server'), 0), false)
  })
})
