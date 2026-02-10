/**
 * REST API integration tests for payments.do
 *
 * Tests the REST endpoint layer that integration dispatch relies on:
 *   POST /customers → stripe.customers.create()
 *   POST /subscriptions → stripe.subscriptions.create()
 *   GET / → health check
 *
 * Uses a mock Stripe SDK injected via module-level state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock Stripe SDK
// ---------------------------------------------------------------------------

const mockCustomersCreate = vi.fn()
const mockCustomersRetrieve = vi.fn()
const mockSubscriptionsCreate = vi.fn()
const mockSubscriptionsRetrieve = vi.fn()
const mockSubscriptionsCancel = vi.fn()
const mockChargesCreate = vi.fn()
const mockChargesRetrieve = vi.fn()
const mockWebhooksConstructEvent = vi.fn()

vi.mock('stripe', () => {
  class MockStripeError extends Error {
    type: string
    constructor(message: string, type: string) {
      super(message)
      this.type = type
    }
  }

  const MockStripe = vi.fn().mockImplementation(() => ({
    customers: {
      create: mockCustomersCreate,
      retrieve: mockCustomersRetrieve,
    },
    subscriptions: {
      create: mockSubscriptionsCreate,
      retrieve: mockSubscriptionsRetrieve,
      cancel: mockSubscriptionsCancel,
    },
    charges: {
      create: mockChargesCreate,
      retrieve: mockChargesRetrieve,
    },
    webhooks: {
      constructEvent: mockWebhooksConstructEvent,
    },
  }))

  MockStripe.errors = { StripeError: MockStripeError }

  return { default: MockStripe, Stripe: MockStripe }
})

vi.mock('cloudflare:workers', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_mock',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_mock',
  },
}))

vi.mock('rpc.do', () => ({
  RPC: vi.fn().mockReturnValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ rpc: true }), { status: 200 })),
  }),
}))

// ---------------------------------------------------------------------------
// Import the worker (after mocks)
// ---------------------------------------------------------------------------

// We need to dynamically import after mocks are set up
let worker: { default: { fetch: (request: Request, envArg?: unknown, ctx?: unknown) => Promise<Response> } }

beforeEach(async () => {
  vi.clearAllMocks()
  // Reset module state
  vi.resetModules()
  worker = await import('../src/index.js')
})

function makeRequest(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return new Request(`https://payments.do${path}`, init)
}

async function fetchJSON(method: string, path: string, body?: unknown) {
  const res = await worker.default.fetch(makeRequest(method, path, body))
  const data = await res.json()
  return { status: res.status, data }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET / — Health check', () => {
  it('returns API discovery with ready status', async () => {
    const { status, data } = await fetchJSON('GET', '/')
    expect(status).toBe(200)
    expect(data.api).toBe('payments.do')
    expect(data.status).toBe('ready')
    expect(data.endpoints.customers).toBeDefined()
    expect(data.endpoints.subscriptions).toBeDefined()
  })
})

describe('POST /customers — Create customer', () => {
  it('creates a Stripe customer and returns 201', async () => {
    mockCustomersCreate.mockResolvedValue({
      id: 'cus_test123',
      email: 'alice@example.com',
      name: 'Alice',
    })

    const { status, data } = await fetchJSON('POST', '/customers', {
      email: 'alice@example.com',
      name: 'Alice',
      metadata: { contactId: 'contact_1' },
    })

    expect(status).toBe(201)
    expect(data.id).toBe('cus_test123')
    expect(data.email).toBe('alice@example.com')
    expect(mockCustomersCreate).toHaveBeenCalledWith({
      email: 'alice@example.com',
      name: 'Alice',
      metadata: { contactId: 'contact_1' },
    })
  })

  it('returns 400 for invalid JSON body', async () => {
    const request = new Request('https://payments.do/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    })

    const res = await worker.default.fetch(request)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Invalid JSON')
  })
})

describe('GET /customers/:id — Retrieve customer', () => {
  it('retrieves a Stripe customer', async () => {
    mockCustomersRetrieve.mockResolvedValue({
      id: 'cus_test456',
      email: 'bob@example.com',
    })

    const { status, data } = await fetchJSON('GET', '/customers/cus_test456')
    expect(status).toBe(200)
    expect(data.id).toBe('cus_test456')
    expect(mockCustomersRetrieve).toHaveBeenCalledWith('cus_test456')
  })
})

describe('POST /subscriptions — Create subscription', () => {
  it('creates a Stripe subscription and returns 201', async () => {
    mockSubscriptionsCreate.mockResolvedValue({
      id: 'sub_test789',
      customer: 'cus_test123',
      status: 'active',
      items: { data: [{ id: 'si_1', price: { id: 'price_pro' } }] },
    })

    const { status, data } = await fetchJSON('POST', '/subscriptions', {
      customer: 'cus_test123',
      items: [{ price: 'price_pro' }],
    })

    expect(status).toBe(201)
    expect(data.id).toBe('sub_test789')
    expect(data.status).toBe('active')
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
      customer: 'cus_test123',
      items: [{ price: 'price_pro' }],
    })
  })
})

describe('GET /subscriptions/:id — Retrieve subscription', () => {
  it('retrieves a Stripe subscription', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_test789',
      status: 'active',
    })

    const { status, data } = await fetchJSON('GET', '/subscriptions/sub_test789')
    expect(status).toBe(200)
    expect(data.id).toBe('sub_test789')
  })
})

describe('DELETE /subscriptions/:id — Cancel subscription', () => {
  it('cancels a Stripe subscription', async () => {
    mockSubscriptionsCancel.mockResolvedValue({
      id: 'sub_test789',
      status: 'canceled',
    })

    const { status, data } = await fetchJSON('DELETE', '/subscriptions/sub_test789')
    expect(status).toBe(200)
    expect(data.status).toBe('canceled')
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_test789')
  })
})

describe('POST /charges — Create charge', () => {
  it('creates a Stripe charge and returns 201', async () => {
    mockChargesCreate.mockResolvedValue({
      id: 'ch_test',
      amount: 2000,
      currency: 'usd',
      status: 'succeeded',
    })

    const { status, data } = await fetchJSON('POST', '/charges', {
      amount: 2000,
      currency: 'usd',
      customer: 'cus_test123',
    })

    expect(status).toBe(201)
    expect(data.id).toBe('ch_test')
    expect(data.amount).toBe(2000)
  })
})

describe('POST /webhooks — Webhook handling', () => {
  it('returns 400 without Stripe-Signature header', async () => {
    const request = new Request('https://payments.do/webhooks', {
      method: 'POST',
      body: '{}',
    })

    const res = await worker.default.fetch(request)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Missing Stripe-Signature')
  })

  it('verifies and processes valid webhook', async () => {
    mockWebhooksConstructEvent.mockReturnValue({
      id: 'evt_test',
      type: 'charge.succeeded',
      data: { object: { id: 'ch_test' } },
    })

    const request = new Request('https://payments.do/webhooks', {
      method: 'POST',
      headers: { 'Stripe-Signature': 'sig_valid' },
      body: '{"id":"evt_test"}',
    })

    const res = await worker.default.fetch(request)
    expect(res.status).toBe(200)
    const data = await res.json() as { received: boolean; type: string }
    expect(data.received).toBe(true)
    expect(data.type).toBe('charge.succeeded')
  })

  it('returns 400 for invalid signature', async () => {
    mockWebhooksConstructEvent.mockImplementation(() => {
      throw new Error('Invalid signature')
    })

    const request = new Request('https://payments.do/webhooks', {
      method: 'POST',
      headers: { 'Stripe-Signature': 'sig_invalid' },
      body: '{}',
    })

    const res = await worker.default.fetch(request)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Webhook verification failed')
  })
})

describe('Unmatched routes — RPC fallback', () => {
  it('falls through to RPC for unknown paths', async () => {
    const { status, data } = await fetchJSON('POST', '/rpc')
    expect(status).toBe(200)
    expect(data.rpc).toBe(true)
  })
})

describe('Error sanitization', () => {
  it('redacts Stripe secret keys in error messages', async () => {
    mockCustomersCreate.mockRejectedValue(new Error('Invalid API key: sk_test_12345 is not valid'))

    const { status, data } = await fetchJSON('POST', '/customers', { email: 'test@test.com' })
    expect(status).toBe(500)
    expect(data.error).not.toContain('sk_test_12345')
    expect(data.error).toContain('[REDACTED]')
  })
})
