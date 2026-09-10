/**
 * Caller auth gate for payments.do (dot-do/payments.do#2)
 *
 * Every route except the explicit public allowlist requires
 * `Authorization: Bearer <PAYMENTS_API_TOKEN>`. Tested at the worker's
 * `fetch` seam with the Stripe SDK mocked so no gated request can reach
 * Stripe without the gate letting it through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockEnv, mockCustomersCreate, mockCustomersRetrieve, mockWebhooksConstructEvent } = vi.hoisted(() => ({
  mockEnv: {
    STRIPE_SECRET_KEY: 'sk_test_mock',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_mock',
    PAYMENTS_API_TOKEN: 'tok_test_caller_secret',
  } as Record<string, string | undefined>,
  mockCustomersCreate: vi.fn(),
  mockCustomersRetrieve: vi.fn(),
  mockWebhooksConstructEvent: vi.fn(),
}))

vi.mock('stripe', () => {
  class MockStripeError extends Error {
    type: string
    constructor(message: string, type: string) {
      super(message)
      this.type = type
    }
  }
  const MockStripe = vi.fn().mockImplementation(() => ({
    customers: { create: mockCustomersCreate, retrieve: mockCustomersRetrieve },
    webhooks: { constructEvent: mockWebhooksConstructEvent },
  }))
  ;(MockStripe as unknown as { errors: unknown }).errors = { StripeError: MockStripeError }
  return { default: MockStripe, Stripe: MockStripe }
})

vi.mock('cloudflare:workers', () => ({ env: mockEnv, WorkerEntrypoint: class {} }))

vi.mock('rpc.do', () => ({
  RPC: vi.fn().mockReturnValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ rpc: true }), { status: 200 })),
  }),
}))

let worker: { default: { fetch: (request: Request, envArg?: unknown, ctx?: unknown) => Promise<Response> } }

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  mockEnv.PAYMENTS_API_TOKEN = 'tok_test_caller_secret'
  worker = await import('../src/index.js')
})

function request(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Request {
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...headers }
    init.body = JSON.stringify(body)
  }
  return new Request(`https://payments.do${path}`, init)
}

describe('gated route without a bearer', () => {
  it('answers 401 with a typed body and never calls Stripe', async () => {
    const res = await worker.default.fetch(request('GET', '/customers/cus_123'))

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="payments.do"')
    const body = (await res.json()) as { error: string; code: string }
    expect(body).toEqual({ error: 'unauthorized', code: 'missing_bearer' })
    expect(mockCustomersRetrieve).not.toHaveBeenCalled()
  })

  it('refuses a wrong bearer without calling Stripe', async () => {
    const res = await worker.default.fetch(request('GET', '/customers/cus_123', { Authorization: 'Bearer tok_wrong' }))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'invalid_bearer' })
    expect(mockCustomersRetrieve).not.toHaveBeenCalled()
  })

  it('gates the RPC fallback for unmatched paths too', async () => {
    const res = await worker.default.fetch(request('POST', '/rpc'))
    expect(res.status).toBe(401)
  })
})

describe('gated route with the correct bearer', () => {
  it('passes through to Stripe', async () => {
    mockCustomersCreate.mockResolvedValue({ id: 'cus_new', email: 'alice@example.com' })

    const res = await worker.default.fetch(
      request('POST', '/customers', { Authorization: 'Bearer tok_test_caller_secret' }, { email: 'alice@example.com' }),
    )

    expect(res.status).toBe(201)
    expect((await res.json()).id).toBe('cus_new')
    expect(mockCustomersCreate).toHaveBeenCalledWith({ email: 'alice@example.com' }, undefined)
  })
})

describe('public allowlist', () => {
  it('POST /webhooks still works without a bearer (Stripe-Signature is its auth)', async () => {
    mockWebhooksConstructEvent.mockReturnValue({ id: 'evt_1', type: 'charge.succeeded', data: { object: { id: 'ch_1' } } })

    const res = await worker.default.fetch(
      new Request('https://payments.do/webhooks', { method: 'POST', headers: { 'Stripe-Signature': 'sig' }, body: '{"id":"evt_1"}' }),
    )

    expect(res.status).toBe(200)
    expect((await res.json()).received).toBe(true)
  })

  it('GET /checkout reaches its handler without a bearer', async () => {
    // No sku → the checkout handler's own 400, proving the gate let it through.
    const res = await worker.default.fetch(request('GET', '/checkout'))
    expect(res.status).toBe(400)
  })
})

describe('Stripe Connect pivot', () => {
  it('refuses a Stripe-Account header on a public route without a bearer', async () => {
    const res = await worker.default.fetch(request('GET', '/checkout', { 'Stripe-Account': 'acct_victim' }))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'connect_requires_auth' })
  })

  it('forwards the pivot for an authenticated caller', async () => {
    mockCustomersRetrieve.mockResolvedValue({ id: 'cus_1' })

    const res = await worker.default.fetch(
      request('GET', '/customers/cus_1', { Authorization: 'Bearer tok_test_caller_secret', 'Stripe-Account': 'acct_tenant' }),
    )

    expect(res.status).toBe(200)
    expect(mockCustomersRetrieve).toHaveBeenCalledWith('cus_1', { stripeAccount: 'acct_tenant' })
  })
})

describe('PAYMENTS_API_TOKEN unset', () => {
  it('fails closed with 401 on every gated route, even with a bearer, and logs once', async () => {
    mockEnv.PAYMENTS_API_TOKEN = undefined
    vi.resetModules()
    worker = await import('../src/index.js')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const first = await worker.default.fetch(request('GET', '/', { Authorization: 'Bearer anything' }))
    const second = await worker.default.fetch(request('GET', '/customers/cus_123'))

    expect(first.status).toBe(401)
    expect(await first.json()).toEqual({ error: 'unauthorized', code: 'token_unconfigured' })
    expect(second.status).toBe(401)
    expect(mockCustomersRetrieve).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toContain('PAYMENTS_API_TOKEN')
    errorSpy.mockRestore()
  })
})
