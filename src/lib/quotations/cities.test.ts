import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CITY_NAMES, stateOfCity } from './cities'
import { SUPPLY_STATES, gstModeForState } from './math'

describe('the delivery city fills in the state', () => {
  test('a well-known city gives its state, however it is typed', () => {
    assert.equal(stateOfCity('Jodhpur'), 'Rajasthan')
    assert.equal(stateOfCity('  hyderabad '), 'Telangana')
    assert.equal(stateOfCity('NAVI   MUMBAI'), 'Maharashtra')
    assert.equal(stateOfCity('Dubai'), 'Outside India (export)')
  })
  test('any other city, and an empty box, give nothing, so the state is left as it is', () => {
    assert.equal(stateOfCity('Aurangabad'), null, 'two states have one')
    assert.equal(stateOfCity('Smalltown'), null)
    assert.equal(stateOfCity(''), null)
    assert.equal(stateOfCity(undefined), null)
  })
  test('the tax follows: a Rajasthan city is CGST + SGST, any other city IGST', () => {
    assert.equal(gstModeForState(stateOfCity('Jaipur')), 'cgst_sgst')
    assert.equal(gstModeForState(stateOfCity('Mumbai')), 'igst')
  })
  test('every name is offered once, and every state it gives is one the Delivery state box knows', () => {
    assert.equal(new Set(CITY_NAMES.map(c => c.toLowerCase())).size, CITY_NAMES.length, 'no city listed twice')
    for (const c of CITY_NAMES) assert.ok((SUPPLY_STATES as readonly string[]).includes(stateOfCity(c) ?? ''), c)
  })
})
