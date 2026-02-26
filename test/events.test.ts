import { describe, it, expect } from 'vitest'
import { buildStripeEvent, buildImportEvent } from '../src/events'

describe('Stripe Event Builder', () => {
  it('builds a webhook event from stripe event type', () => {
    const event = buildStripeEvent({
      ns: 'acct_123',
      stripeEventType: 'customer.subscription.created',
      stripeEventId: 'evt_123',
      entityId: 'sub_abc',
      payload: { id: 'sub_abc', status: 'active' },
      account: 'acct_123',
    })

    expect(event.type).toBe('webhook')
    expect(event.event).toBe('stripe.customer_subscription.created')
    expect(event.source).toBe('stripe')
    expect(event.data.provider).toBe('stripe')
    expect(event.data.entity).toBe('customer_subscription')
    expect(event.data.action).toBe('created')
    expect(event.data.id).toBe('sub_abc')
    expect(event.id).toMatch(/^[0-9A-Z]{26}$/)
  })

  it('builds a simple two-part event type', () => {
    const event = buildStripeEvent({
      ns: 'default',
      stripeEventType: 'charge.succeeded',
      stripeEventId: 'evt_456',
      entityId: 'ch_xyz',
      payload: { id: 'ch_xyz', amount: 2000 },
    })

    expect(event.event).toBe('stripe.charge.succeeded')
    expect(event.data.entity).toBe('charge')
    expect(event.data.action).toBe('succeeded')
  })

  it('builds an import event', () => {
    const event = buildImportEvent({
      ns: 'default',
      entityType: 'customer',
      entityId: 'cus_abc',
      payload: { id: 'cus_abc', email: 'test@example.com' },
    })

    expect(event.event).toBe('stripe.customer.imported')
    expect(event.data.action).toBe('imported')
    expect(event.data.entity).toBe('customer')
    expect(event.source).toBe('stripe')
  })
})
