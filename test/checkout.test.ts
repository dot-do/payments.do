/**
 * /checkout — the vin estate first-dollar front (PW-5 step 2; vin-zik).
 *
 * Two layers under test:
 *   1. The pure module (src/checkout.ts): closed SKU table, query validation,
 *      Checkout Session params, settlement extraction, settlement forward.
 *   2. The routes (src/index.ts): GET /checkout → 303 to Stripe Checkout;
 *      POST /webhooks forwards PAID vin sessions to VIN_SETTLE_URL and
 *      answers Stripe 500 when a configured forward fails (redelivery).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  VIN_CHECKOUT_SKUS,
  parseVinCheckout,
  vinCheckoutSessionParams,
  vinSettlementFromSession,
  forwardVinSettlement,
} from '../src/checkout'

// ---------------------------------------------------------------------------
// Worker mocks (used by the route layer only)
// ---------------------------------------------------------------------------

const mockSessionsCreate = vi.fn()
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
    checkout: { sessions: { create: mockSessionsCreate } },
    webhooks: { constructEvent: mockWebhooksConstructEvent },
  })) as unknown as { errors: { StripeError: typeof MockStripeError } }

  MockStripe.errors = { StripeError: MockStripeError }

  return { default: MockStripe, Stripe: MockStripe }
})

vi.mock('rpc.do', () => ({
  RPC: vi.fn().mockReturnValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ rpc: true }), { status: 200 })),
  }),
}))

const mockEnv: Record<string, unknown> = {}

vi.mock('cloudflare:workers', () => ({ env: mockEnv }))

type Worker = { default: { fetch: (request: Request, envArg?: unknown, ctx?: unknown) => Promise<Response> } }

/** Reset module state and load the worker with the given env. */
async function loadWorker(envOverrides: Record<string, unknown> = {}): Promise<Worker> {
  vi.resetModules()
  for (const key of Object.keys(mockEnv)) delete mockEnv[key]
  Object.assign(
    mockEnv,
    { STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: 'whsec_test_mock' },
    envOverrides,
  )
  return (await import('../src/index.js')) as Worker
}

const CHECKOUT_QS = 'sku=sticker&vin=1FTFW1E55PFA10001&door=sticker.vin&return_to=https%3A%2F%2Fsticker.vin%2F1FTFW1E55PFA10001'

function checkoutUrl(qs: string = CHECKOUT_QS): URL {
  return new URL(`https://payments.do/checkout?${qs}`)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// The closed SKU table
// ---------------------------------------------------------------------------

describe('VIN_CHECKOUT_SKUS — the closed table', () => {
  it('posts exactly the ratified W1 consumer rungs, in cents', () => {
    expect(Object.keys(VIN_CHECKOUT_SKUS).sort()).toEqual(['sticker', 'vhr', 'vhr-cached'])
    expect(VIN_CHECKOUT_SKUS.sticker.unitAmount).toBe(1200)
    expect(VIN_CHECKOUT_SKUS.vhr.unitAmount).toBe(1999)
    expect(VIN_CHECKOUT_SKUS['vhr-cached'].unitAmount).toBe(999)
  })
})

// ---------------------------------------------------------------------------
// parseVinCheckout
// ---------------------------------------------------------------------------

describe('parseVinCheckout', () => {
  it('accepts a well-formed vin checkout query', () => {
    const parsed = parseVinCheckout(checkoutUrl())
    expect(parsed).toEqual({
      ok: true,
      intent: {
        sku: 'sticker',
        vin: '1FTFW1E55PFA10001',
        door: 'sticker.vin',
        returnTo: 'https://sticker.vin/1FTFW1E55PFA10001',
      },
    })
  })

  it('refuses an unknown SKU — the table is closed', () => {
    const parsed = parseVinCheckout(checkoutUrl(CHECKOUT_QS.replace('sku=sticker', 'sku=mystery')))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('closed')
  })

  it('refuses a malformed VIN token', () => {
    const parsed = parseVinCheckout(checkoutUrl(CHECKOUT_QS.replace(/1FTFW1E55PFA10001/g, 'NOT-A-VIN')))
    expect(parsed.ok).toBe(false)
  })

  it('refuses a door off the .vin estate', () => {
    const url = checkoutUrl(
      'sku=sticker&vin=1FTFW1E55PFA10001&door=evil.example.com&return_to=https%3A%2F%2Fevil.example.com%2F1FTFW1E55PFA10001',
    )
    const parsed = parseVinCheckout(url)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('.vin')
  })

  it('refuses a return_to on a different host — no open redirect', () => {
    const url = checkoutUrl(
      'sku=sticker&vin=1FTFW1E55PFA10001&door=sticker.vin&return_to=https%3A%2F%2Fother.vin%2F1FTFW1E55PFA10001',
    )
    const parsed = parseVinCheckout(url)
    expect(parsed.ok).toBe(false)
  })

  it('refuses a non-https return_to', () => {
    const url = checkoutUrl(
      'sku=sticker&vin=1FTFW1E55PFA10001&door=sticker.vin&return_to=http%3A%2F%2Fsticker.vin%2F1FTFW1E55PFA10001',
    )
    const parsed = parseVinCheckout(url)
    expect(parsed.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// vinCheckoutSessionParams
// ---------------------------------------------------------------------------

describe('vinCheckoutSessionParams', () => {
  const intent = {
    sku: 'vhr',
    vin: '1FTFW1E55PFA10001',
    door: 'vhr.vin',
    returnTo: 'https://vhr.vin/1FTFW1E55PFA10001',
  }

  it('prices from the closed table and carries {sku, vin, door} on session AND PaymentIntent', () => {
    const params = vinCheckoutSessionParams(intent)
    expect(params.mode).toBe('payment')
    expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(1999)
    const metadata = { estate: 'vin', sku: 'vhr', vin: '1FTFW1E55PFA10001', door: 'vhr.vin' }
    expect(params.metadata).toEqual(metadata)
    expect(params.payment_intent_data?.metadata).toEqual(metadata)
  })

  it('returns the buyer to the door with the literal {CHECKOUT_SESSION_ID} placeholder', () => {
    const params = vinCheckoutSessionParams(intent)
    expect(params.success_url).toBe('https://vhr.vin/1FTFW1E55PFA10001?settled={CHECKOUT_SESSION_ID}')
    expect(params.cancel_url).toBe('https://vhr.vin/1FTFW1E55PFA10001')
  })

  it('throws on an unknown SKU rather than guessing a price', () => {
    expect(() => vinCheckoutSessionParams({ ...intent, sku: 'mystery' })).toThrow(/closed/)
  })
})

// ---------------------------------------------------------------------------
// vinSettlementFromSession
// ---------------------------------------------------------------------------

describe('vinSettlementFromSession', () => {
  const paidSession = {
    id: 'cs_test_123',
    payment_status: 'paid',
    payment_intent: 'pi_test_456',
    amount_total: 1200,
    currency: 'usd',
    metadata: { estate: 'vin', sku: 'sticker', vin: '1FTFW1E55PFA10001', door: 'sticker.vin' },
  }

  it('extracts the settlement: session id as order_id, PaymentIntent as settlement_ref', () => {
    const settlement = vinSettlementFromSession(paidSession, false)
    expect(settlement).toEqual({
      sku: 'sticker',
      vin: '1FTFW1E55PFA10001',
      door: 'sticker.vin',
      order_id: 'cs_test_123',
      settlement_ref: 'pi_test_456',
      amount_total: 1200,
      currency: 'usd',
      livemode: false,
    })
  })

  it('reads an expanded PaymentIntent object', () => {
    const settlement = vinSettlementFromSession(
      { ...paidSession, payment_intent: { id: 'pi_expanded_789' } },
      true,
    )
    expect(settlement?.settlement_ref).toBe('pi_expanded_789')
    expect(settlement?.livemode).toBe(true)
  })

  it('ignores sessions that are not vin-estate', () => {
    expect(vinSettlementFromSession({ ...paidSession, metadata: { sku: 'sticker' } }, false)).toBeNull()
    expect(vinSettlementFromSession({ ...paidSession, metadata: undefined }, false)).toBeNull()
  })

  it('ignores unpaid sessions', () => {
    expect(vinSettlementFromSession({ ...paidSession, payment_status: 'unpaid' }, false)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// forwardVinSettlement
// ---------------------------------------------------------------------------

describe('forwardVinSettlement', () => {
  const settlement = {
    sku: 'sticker',
    vin: '1FTFW1E55PFA10001',
    door: 'sticker.vin',
    order_id: 'cs_test_123',
    settlement_ref: 'pi_test_456',
    amount_total: 1200,
    currency: 'usd',
    livemode: false,
  }

  it('skips when no URL is configured', async () => {
    const fetcher = vi.fn()
    const result = await forwardVinSettlement(settlement, {}, fetcher as unknown as typeof fetch)
    expect(result.forwarded).toBe(false)
    expect(result.reason).toContain('VIN_SETTLE_URL')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('POSTs the settlement with the bearer token', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const result = await forwardVinSettlement(
      settlement,
      { url: 'https://all.vin/_settle', token: 'tok_test' },
      fetcher as unknown as typeof fetch,
    )
    expect(result).toEqual({ forwarded: true, status: 200 })
    expect(fetcher).toHaveBeenCalledWith('https://all.vin/_settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_test' },
      body: JSON.stringify(settlement),
    })
  })

  it('reports a non-2xx answer without throwing', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }))
    const result = await forwardVinSettlement(
      settlement,
      { url: 'https://all.vin/_settle' },
      fetcher as unknown as typeof fetch,
    )
    expect(result).toEqual({ forwarded: false, status: 503 })
  })

  it('reports a thrown fetch as not forwarded', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'))
    const result = await forwardVinSettlement(
      settlement,
      { url: 'https://all.vin/_settle' },
      fetcher as unknown as typeof fetch,
    )
    expect(result.forwarded).toBe(false)
    expect(result.reason).toBe('network down')
  })
})

// ---------------------------------------------------------------------------
// GET /checkout — the route
// ---------------------------------------------------------------------------

describe('GET /checkout', () => {
  it('creates a Checkout Session from the closed table and answers 303 to Stripe', async () => {
    const worker = await loadWorker()
    mockSessionsCreate.mockResolvedValue({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' })

    const res = await worker.default.fetch(new Request(checkoutUrl().toString()))

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/cs_test_123')
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1)
    const params = mockSessionsCreate.mock.calls[0][0]
    expect(params.line_items[0].price_data.unit_amount).toBe(1200)
    expect(params.metadata).toEqual({ estate: 'vin', sku: 'sticker', vin: '1FTFW1E55PFA10001', door: 'sticker.vin' })
    expect(params.payment_intent_data.metadata).toEqual(params.metadata)
  })

  it('refuses an unknown SKU with 400 — never a guessed price', async () => {
    const worker = await loadWorker()
    const res = await worker.default.fetch(
      new Request(checkoutUrl(CHECKOUT_QS.replace('sku=sticker', 'sku=mystery')).toString()),
    )
    expect(res.status).toBe(400)
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  it('refuses an off-estate return_to with 400', async () => {
    const worker = await loadWorker()
    const res = await worker.default.fetch(
      new Request(
        checkoutUrl(
          'sku=sticker&vin=1FTFW1E55PFA10001&door=sticker.vin&return_to=https%3A%2F%2Fevil.example.com%2Fx',
        ).toString(),
      ),
    )
    expect(res.status).toBe(400)
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  it('answers 503 naming the founder act while unconfigured', async () => {
    const worker = await loadWorker({ STRIPE_SECRET_KEY: undefined })
    const res = await worker.default.fetch(new Request(checkoutUrl().toString()))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('wrangler secret put STRIPE_SECRET_KEY')
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /webhooks — the vin settlement leg
// ---------------------------------------------------------------------------

function webhookRequest(event: Record<string, unknown>): Request {
  return new Request('https://payments.do/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=mock' },
    body: JSON.stringify(event),
  })
}

const completedEvent = {
  id: 'evt_test_1',
  type: 'checkout.session.completed',
  livemode: false,
  data: {
    object: {
      id: 'cs_test_123',
      payment_status: 'paid',
      payment_intent: 'pi_test_456',
      amount_total: 1200,
      currency: 'usd',
      metadata: { estate: 'vin', sku: 'sticker', vin: '1FTFW1E55PFA10001', door: 'sticker.vin' },
    },
  },
}

describe('POST /webhooks — vin settlement forward', () => {
  it('forwards a PAID vin session to VIN_SETTLE_URL with the settlement_ref', async () => {
    const worker = await loadWorker({ VIN_SETTLE_URL: 'https://all.vin/_settle', VIN_SETTLE_TOKEN: 'tok_test' })
    mockWebhooksConstructEvent.mockReturnValue(completedEvent)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await worker.default.fetch(webhookRequest(completedEvent))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { vin: { order_id: string; settlement_ref: string; forwarded: boolean } }
    expect(body.vin).toEqual({ order_id: 'cs_test_123', settlement_ref: 'pi_test_456', forwarded: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://all.vin/_settle')
    expect(init.headers.Authorization).toBe('Bearer tok_test')
    expect(JSON.parse(init.body).settlement_ref).toBe('pi_test_456')
  })

  it('answers 500 when the configured forward fails, so Stripe redelivers', async () => {
    const worker = await loadWorker({ VIN_SETTLE_URL: 'https://all.vin/_settle' })
    mockWebhooksConstructEvent.mockReturnValue(completedEvent)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })))

    const res = await worker.default.fetch(webhookRequest(completedEvent))

    expect(res.status).toBe(500)
  })

  it('acks without forwarding when VIN_SETTLE_URL is unset', async () => {
    const worker = await loadWorker()
    mockWebhooksConstructEvent.mockReturnValue(completedEvent)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await worker.default.fetch(webhookRequest(completedEvent))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { vin: { forwarded: boolean } }
    expect(body.vin.forwarded).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('leaves non-vin checkout sessions on the normal ack path', async () => {
    const worker = await loadWorker({ VIN_SETTLE_URL: 'https://all.vin/_settle' })
    const foreign = {
      ...completedEvent,
      data: { object: { ...completedEvent.data.object, metadata: { tenant: 'acme' } } },
    }
    mockWebhooksConstructEvent.mockReturnValue(foreign)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await worker.default.fetch(webhookRequest(foreign))

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.vin).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
