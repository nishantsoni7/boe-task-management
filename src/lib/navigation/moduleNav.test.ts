/**
 * Orders and Finance: which sidebar entry is lit, and what the header says
 * while a route loads. Pure rules — see moduleNav.ts.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { activeFinanceNav, activeOrdersNav, pendingModuleTitle } from './moduleNav'

const ORDER_ID = '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'

describe('the Orders entry a path belongs to', () => {
  test('each destination lights itself', () => {
    assert.equal(activeOrdersNav('/orders'), 'dashboard')
    assert.equal(activeOrdersNav('/orders/drafts'), 'drafts')
    assert.equal(activeOrdersNav('/orders/all'), 'confirmed')
  })

  test('a record lights the list it belongs to — it used to light nothing', () => {
    assert.equal(activeOrdersNav(`/orders/${ORDER_ID}`), 'confirmed', 'an Order is a Confirmed Order')
    assert.equal(activeOrdersNav(`/orders/drafts/${ORDER_ID}`), 'drafts', 'a PI record is in PI Drafts')
    assert.equal(activeOrdersNav('/orders/import'), 'drafts', 'Upload PI is the start of the PI Drafts workflow')
  })

  test('the dashboard is lit only on the dashboard', () => {
    assert.equal(activeOrdersNav('/orders/'), 'dashboard', 'a trailing slash is the same place')
    assert.notEqual(activeOrdersNav('/orders/all'), 'dashboard')
  })

  test('the retired workflow and Notifications light no primary entry', () => {
    assert.equal(activeOrdersNav('/orders/requests'), null)
    assert.equal(activeOrdersNav(`/orders/requests/${ORDER_ID}`), null)
    assert.equal(activeOrdersNav('/orders/notifications'), null, 'Notifications lights its own entry')
  })

  test('another module lights nothing here', () => {
    for (const path of ['/finance', '/finance/received', '/tasks/my', '/', '/ordersx']) {
      assert.equal(activeOrdersNav(path), null, path)
    }
  })

  test('query strings and fragments do not change the answer', () => {
    assert.equal(activeOrdersNav('/orders/all?status=running#top'), 'confirmed')
  })
})

describe('the Finance entry a path belongs to', () => {
  test('each destination lights itself — including its sub-routes, which used to light nothing', () => {
    assert.equal(activeFinanceNav('/finance'), 'requests')
    assert.equal(activeFinanceNav('/finance/received'), 'confirmed')
    assert.equal(activeFinanceNav('/finance/received/linked'), 'confirmed')
    assert.equal(activeFinanceNav('/finance/received/unlinked'), 'confirmed')
  })

  test('the retired Payments to Verify page lights Payment Requests, the records it shows', () => {
    assert.equal(activeFinanceNav('/finance/payments-to-verify'), 'requests')
  })

  test('Expenses lights itself, and so does its quick-entry route', () => {
    // Money going out — a third Finance section, not a third view of the
    // payments. /finance/expenses/new is a step of the same section, so
    // somebody who arrived there from a phone's home screen still sees where
    // they are in the module.
    assert.equal(activeFinanceNav('/finance/expenses'), 'expenses')
    assert.equal(activeFinanceNav('/finance/expenses/new'), 'expenses')
  })

  test('Notifications and other modules light no primary entry', () => {
    assert.equal(activeFinanceNav('/finance/notifications'), null)
    assert.equal(activeFinanceNav('/orders'), null)
  })
})

describe('the header while a route is still loading says what the page will say', () => {
  test('Orders', () => {
    assert.equal(pendingModuleTitle('/orders'), 'Orders')
    assert.equal(pendingModuleTitle('/orders/drafts'), 'PI Drafts')
    assert.equal(pendingModuleTitle(`/orders/drafts/${ORDER_ID}`), 'PI Draft')
    assert.equal(pendingModuleTitle('/orders/all'), 'Confirmed Orders')
    assert.equal(pendingModuleTitle('/orders/import'), 'Upload PI')
    assert.equal(pendingModuleTitle(`/orders/${ORDER_ID}`), 'Confirmed Order')
    assert.equal(pendingModuleTitle('/orders/notifications'), 'Notifications')
  })

  test('Finance', () => {
    assert.equal(pendingModuleTitle('/finance'), 'Payment Requests')
    assert.equal(pendingModuleTitle('/finance/received'), 'Confirmed Payments')
    assert.equal(pendingModuleTitle('/finance/payments-to-verify'), 'Payments to Verify')
    assert.equal(pendingModuleTitle('/finance/expenses'), 'Expenses')
    // The quick-entry route's own heading, so the shell does not say "Expenses"
    // for a frame and then change once the page lands.
    assert.equal(pendingModuleTitle('/finance/expenses/new'), 'Add Expense')
    assert.equal(pendingModuleTitle('/finance/notifications'), 'Notifications')
  })
})
