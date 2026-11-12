import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readSignupEvent } from './connectSignup'

const META = 'https://www.facebook.com'
const msg = (event: string, data: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data })

describe('readSignupEvent: what Meta\'s Embedded Signup pop-up reports', () => {
  test('the WhatsApp Business app finish is the only success', () => {
    assert.deepEqual(
      readSignupEvent(META, msg('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', { waba_id: '111', phone_number_id: 222 })),
      { kind: 'finished', wabaId: '111', phoneNumberId: '222' },
    )
    // An object (not a JSON string) is read the same way.
    assert.deepEqual(
      readSignupEvent(META, { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: '9' } }),
      { kind: 'finished', wabaId: '9', phoneNumberId: '' },
    )
  })

  test('a finish without an account ID is an error, not a success', () => {
    assert.equal(readSignupEvent(META, msg('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'))?.kind, 'error')
  })

  test('the plain Cloud API finish (number taken off the phone) is refused as the wrong flow', () => {
    for (const event of ['FINISH', 'FINISH_ONLY_WABA', 'FINISH_GRANT_ONLY_API_ACCESS']) {
      assert.deepEqual(readSignupEvent(META, msg(event, { waba_id: '1', phone_number_id: '2' })), { kind: 'wrong-flow', event })
    }
  })

  test('cancel and error carry Meta\'s own step and text', () => {
    assert.deepEqual(readSignupEvent(META, msg('CANCEL', { current_step: 'PHONE_NUMBER_SETUP' })),
      { kind: 'cancelled', step: 'PHONE_NUMBER_SETUP' })
    assert.deepEqual(readSignupEvent(META, msg('ERROR', { error_message: 'Number not eligible' })),
      { kind: 'error', message: 'Number not eligible' })
  })

  test('anything not from Meta\'s pop-up is ignored', () => {
    const ok = msg('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', { waba_id: '1' })
    assert.equal(readSignupEvent('https://evilfacebook.com', ok), null)
    assert.equal(readSignupEvent('https://facebook.com.example.org', ok), null)
    assert.equal(readSignupEvent('https://boeone.vercel.app', ok), null)
    assert.equal(readSignupEvent('not a url', ok), null)
    assert.equal(readSignupEvent(META, JSON.stringify({ type: 'OTHER', event: 'FINISH' })), null)
    assert.equal(readSignupEvent(META, '{not json'), null)
    assert.equal(readSignupEvent(META, null), null)
    // Meta's apex domain is accepted as well as its subdomains.
    assert.equal(readSignupEvent('https://facebook.com', ok)?.kind, 'finished')
  })
})
