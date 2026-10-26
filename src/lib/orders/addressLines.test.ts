import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { addressForCopy, sameAddress, splitAddress } from './addressLines'

const STORED = 'Building No./Flat No.: 160 Name Of Premises/Building: Tiverton Bungalow Road/Street: Coonoor Road Nearby Landmark: opposite Eye Foundation Locality/Sub Locality: Thalayathimund City/Town/Village: Ooty District: The Nilgiris State: Tamil Nadu PIN Code: 6430'

describe('splitAddress', () => {
  test('breaks the portal text at each label, in order, with the dialog\'s words', () => {
    assert.deepEqual(splitAddress(STORED), [
      { label: 'Flat / building', value: '160' },
      { label: 'Premises', value: 'Tiverton Bungalow' },
      { label: 'Road', value: 'Coonoor Road' },
      { label: 'Landmark', value: 'opposite Eye Foundation' },
      { label: 'Locality', value: 'Thalayathimund' },
      { label: 'City', value: 'Ooty' },
      { label: 'District', value: 'The Nilgiris' },
      { label: 'State', value: 'Tamil Nadu' },
      { label: 'PIN', value: '6430' },
    ])
  })

  test('a label with nothing after it is dropped, not shown empty', () => {
    const lines = splitAddress('Building No./Flat No.: 12 Nearby Landmark: Locality/Sub Locality: Civil Lines City/Town/Village: Jaipur')
    assert.deepEqual(lines?.map(l => l.label), ['Flat / building', 'Locality', 'City'])
  })

  test('anything that is not this shape comes back null, so the stored text is shown as it is', () => {
    assert.equal(splitAddress('9 Dock Lane, Nashik'), null)
    assert.equal(splitAddress('Ship to: City/Town/Village: Pune'), null, 'text before the first label would be lost')
    assert.equal(splitAddress('State: Goa'), null, 'one label is not enough to be sure')
    assert.equal(splitAddress(null), null)
    assert.equal(splitAddress('   '), null)
  })
})

describe('addressForCopy and sameAddress', () => {
  test('copies labelled lines when it splits, the stored text when it does not, with the name first', () => {
    assert.equal(addressForCopy('Acme', 'City/Town/Village: Ooty District: The Nilgiris'), 'Acme\nCity: Ooty\nDistrict: The Nilgiris')
    assert.equal(addressForCopy(null, '9 Dock Lane, Nashik'), '9 Dock Lane, Nashik')
    assert.equal(addressForCopy('Acme', null), 'Acme')
  })

  test('two addresses are the same ignoring case and spacing; an empty one is never the same as another empty one', () => {
    assert.equal(sameAddress('1 Bill Road,  Jaipur', '1 bill road, jaipur'), true)
    assert.equal(sameAddress('1 Bill Road', '9 Dock Lane'), false)
    assert.equal(sameAddress(null, null), false)
  })
})
