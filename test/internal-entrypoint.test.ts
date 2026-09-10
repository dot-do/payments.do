/**
 * PaymentsInternal — the service-binding RPC surface (dot-do/payments.do#2).
 *
 * Typed methods over a mocked Stripe SDK: no fetch handler, no bearer, the
 * connected-account pivot only as an explicit input field. Alongside, the
 * public default export stays fail-closed for every pass-through route while
 * the same environment serves those operations over RPC.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockEnv, stripeMock } = vi.hoisted(() => ({
  mockEnv: { STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: 'whsec_test_mock' } as Record<string, string | undefined>,
  stripeMock: {
    customers: { create: vi.fn(), retrieve: vi.fn() },
    subscriptions: { create: vi.fn(), retrieve: vi.fn() },
    invoices: { retrieve: vi.fn() },
    charges: { retrieve: vi.fn() },
    products: { retrieve: vi.fn() },
    prices: { retrieve: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  },
}))

vi.mock('stripe', () => {
  class MockStripeError extends Error {
    type: string
    constructor(message: string, type: string) {
      super(message)
      this.type = type
    }
  }
  const MockStripe = vi.fn().mockImplementation(() => stripeMock)
  ;(MockStripe as unknown as { errors: unknown }).errors = { StripeError: MockStripeError }
  return { default: MockStripe, Stripe: MockStripe }
})

vi.mock('cloudflare:workers', () => ({
  env: mockEnv,
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}))

vi.mock('rpc.do', () => ({ RPC: vi.fn().mockReturnValue({ fetch: vi.fn() }) }))

type Worker = typeof import('../src/index.js')
let worker: Worker
let internal: InstanceType<Worker['PaymentsInternal']>

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  // The intended permanent state: no caller bearer configured anywhere.
  delete mockEnv.PAYMENTS_API_TOKEN
  worker = await import('../src/index.js')
  internal = new worker.PaymentsInternal({} as ExecutionContext, mockEnv as never)
})

function request(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Request {
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...headers }
    init.body = JSON.stringify(body)
  }
  return new Request(`https://payments.do${path}`, init)
}

describe('PaymentsInternal shape', () => {
  it('is an RPC class with typed methods and no fetch handler', () => {
    expect((internal as unknown as { fetch?: unknown }).fetch).toBeUndefined()
    for (const method of ['createCustomer', 'createSubscription', 'getCustomer', 'getSubscription', 'getInvoice', 'getCharge', 'getProduct', 'getPrice']) {
      expect(typeof (internal as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })
})

describe('createCustomer', () => {
  it('creates on the platform account and returns the Stripe object', async () => {
    stripeMock.customers.create.mockResolvedValue({ id: 'cus_new', object: 'customer', email: 'alice@example.com' })

    const result = await internal.createCustomer({ email: 'alice@example.com', name: 'Alice', metadata: { contactId: 'contact_1' } })

    expect(stripeMock.customers.create).toHaveBeenCalledWith(
      { email: 'alice@example.com', name: 'Alice', metadata: { contactId: 'contact_1' } },
      undefined,
    )
    expect(result).toEqual({ id: 'cus_new', object: 'customer', email: 'alice@example.com' })
  })

  it('pivots to a connected account only via the explicit input field', async () => {
    stripeMock.customers.create.mockResolvedValue({ id: 'cus_acct', object: 'customer' })

    await internal.createCustomer({ email: 'bob@example.com', stripeAccount: 'acct_tenant' })

    expect(stripeMock.customers.create).toHaveBeenCalledWith({ email: 'bob@example.com' }, { stripeAccount: 'acct_tenant' })
  })
})

describe('createSubscription', () => {
  it('creates the subscription for a customer and price', async () => {
    stripeMock.subscriptions.create.mockResolvedValue({ id: 'sub_new', object: 'subscription', status: 'active' })

    const result = await internal.createSubscription({ customer: 'cus_1', items: [{ price: 'price_1' }] })

    expect(stripeMock.subscriptions.create).toHaveBeenCalledWith({ customer: 'cus_1', items: [{ price: 'price_1' }] }, undefined)
    expect(result.status).toBe('active')
  })

  it('scopes to the connected account when asked', async () => {
    stripeMock.subscriptions.create.mockResolvedValue({ id: 'sub_acct', object: 'subscription', status: 'active' })

    await internal.createSubscription({ customer: 'cus_1', items: [{ price: 'price_1' }], stripeAccount: 'acct_tenant' })

    expect(stripeMock.subscriptions.create).toHaveBeenCalledWith(
      { customer: 'cus_1', items: [{ price: 'price_1' }] },
      { stripeAccount: 'acct_tenant' },
    )
  })
})

describe('retrieve methods', () => {
  const cases: Array<[keyof Worker['PaymentsInternal']['prototype'], keyof typeof stripeMock, string]> = [
    ['getCustomer', 'customers', 'cus_1'],
    ['getSubscription', 'subscriptions', 'sub_1'],
    ['getInvoice', 'invoices', 'in_1'],
    ['getCharge', 'charges', 'ch_1'],
    ['getProduct', 'products', 'prod_1'],
    ['getPrice', 'prices', 'price_1'],
  ]

  it.each(cases)('%s retrieves by id on the platform account', async (method, resource, id) => {
    const retrieve = (stripeMock[resource] as { retrieve: ReturnType<typeof vi.fn> }).retrieve
    retrieve.mockResolvedValue({ id, object: resource.slice(0, -1) })

    const result = await (internal[method] as (input: { id: string }) => Promise<{ id: string }>)({ id })

    expect(retrieve).toHaveBeenCalledWith(id, undefined)
    expect(result.id).toBe(id)
  })

  it.each(cases)('%s forwards the explicit connected-account scope', async (method, resource, id) => {
    const retrieve = (stripeMock[resource] as { retrieve: ReturnType<typeof vi.fn> }).retrieve
    retrieve.mockResolvedValue({ id, object: resource.slice(0, -1) })

    await (internal[method] as (input: { id: string; stripeAccount?: string }) => Promise<unknown>)({ id, stripeAccount: 'acct_tenant' })

    expect(retrieve).toHaveBeenCalledWith(id, { stripeAccount: 'acct_tenant' })
  })
})

describe('errors crossing the RPC boundary', () => {
  it('rethrows Stripe failures as PaymentsError with secrets redacted', async () => {
    stripeMock.customers.retrieve.mockRejectedValue(new Error('Invalid API key sk_test_supersecret for acct_platform'))

    const failure = await internal.getCustomer({ id: 'cus_missing' }).catch((err: unknown) => err as Error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure.name).toBe('PaymentsError')
    expect(failure.message).not.toContain('sk_test_supersecret')
    expect(failure.message).not.toContain('acct_platform')
    expect(failure.message).toContain('[REDACTED]')
  })

  it('reports the missing platform key without contacting Stripe', async () => {
    delete mockEnv.STRIPE_SECRET_KEY
    vi.resetModules()
    worker = await import('../src/index.js')
    internal = new worker.PaymentsInternal({} as ExecutionContext, mockEnv as never)

    await expect(internal.createCustomer({ email: 'x@example.com' })).rejects.toThrow(/STRIPE_SECRET_KEY is not configured/)
    expect(stripeMock.customers.create).not.toHaveBeenCalled()
    mockEnv.STRIPE_SECRET_KEY = 'sk_test_mock'
  })
})

describe('public export with no bearer configured (the permanent state)', () => {
  it('answers 401 token_unconfigured on a pass-through route while RPC serves the same operation', async () => {
    stripeMock.customers.retrieve.mockResolvedValue({ id: 'cus_1', object: 'customer' })

    const res = await worker.default.fetch(request('GET', '/customers/cus_1'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'token_unconfigured' })
    expect(stripeMock.customers.retrieve).not.toHaveBeenCalled()

    const viaRpc = await internal.getCustomer({ id: 'cus_1' })
    expect(viaRpc.id).toBe('cus_1')
    expect(stripeMock.customers.retrieve).toHaveBeenCalledTimes(1)
  })

  it('refuses a pass-through write even with a bearer, since no token is configured', async () => {
    const res = await worker.default.fetch(request('POST', '/customers', { Authorization: 'Bearer anything' }, { email: 'x@example.com' }))
    expect(res.status).toBe(401)
    expect(stripeMock.customers.create).not.toHaveBeenCalled()
  })

  it('refuses the Stripe-Account pivot on a public route', async () => {
    const res = await worker.default.fetch(request('GET', '/checkout', { 'Stripe-Account': 'acct_evil' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', code: 'connect_requires_auth' })
  })

  it('still processes POST /webhooks (Stripe-Signature is its auth)', async () => {
    stripeMock.webhooks.constructEvent.mockReturnValue({ id: 'evt_1', type: 'charge.succeeded', data: { object: { id: 'ch_1' } } })

    const res = await worker.default.fetch(
      new Request('https://payments.do/webhooks', { method: 'POST', headers: { 'Stripe-Signature': 'sig' }, body: '{"id":"evt_1"}' }),
    )

    expect(res.status).toBe(200)
    expect((await res.json()).received).toBe(true)
  })

  it('still reaches the GET /checkout handler', async () => {
    // No sku → the handler's own 400, proving the gate let it through.
    const res = await worker.default.fetch(request('GET', '/checkout'))
    expect(res.status).toBe(400)
  })
})
