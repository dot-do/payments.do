/**
 * /checkout?sku=deal — the vin estate variable-amount deal leg.
 *
 * Two layers under test:
 *   1. The pure module (src/deal-checkout.ts): closed deal-door table, query
 *      validation, OFFER fetch-and-verify (the ONLY price authority),
 *      Checkout Session params, deal-settlement extraction, settle forward.
 *   2. The routes (src/index.ts): GET /checkout?sku=deal → OFFER fetch → 303
 *      to Stripe Checkout; POST /webhooks forwards PAID vin deal sessions to
 *      the deal door's own settle leg and answers Stripe 500 on failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MAX_DEAL_AMOUNT_CENTS,
  VIN_DEAL_DOORS,
  fetchVinDealOffer,
  forwardVinDealSettlement,
  parseVinDealCheckout,
  vinDealCheckoutSessionParams,
  vinDealOfferUrl,
  vinDealSettlementFromSession,
} from '../src/deal-checkout'
import { vinSettlementFromSession } from '../src/checkout'

// ---------------------------------------------------------------------------
// Worker mocks (used by the route layer only) — the checkout.test.ts pattern
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VIN = '1FTFW1E55PFA10001'
const DEAL = 'deal_Ab12Cd34'
const LINK = 'paymentlink_Ef56Gh78'
const RETURN_TO = `https://apis.vin/buy/deals/${DEAL}/checkout`

const DEAL_QS =
  `sku=deal&deal=${DEAL}&link=${LINK}&vin=${VIN}&door=apis.vin&return_to=${encodeURIComponent(RETURN_TO)}`

function dealUrl(qs: string = DEAL_QS): URL {
  return new URL(`https://payments.do/checkout?${qs}`)
}

const intent = { deal: DEAL, link: LINK, vin: VIN, door: 'apis.vin', returnTo: RETURN_TO }

/** The deal door's OFFER page (apis.vin GET /buy/deals/{id}/checkout.json). */
function offerPage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'OK',
    status: 'open',
    deal: DEAL,
    vin: VIN,
    paymentLink: LINK,
    settle: { path: `/buy/deals/${DEAL}/settle`, amount_total: 3_250_000, currency: 'usd' },
    ...overrides,
  }
}

function offerResponse(page: Record<string, unknown> = offerPage()): Response {
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// The closed deal-door table
// ---------------------------------------------------------------------------

describe('VIN_DEAL_DOORS — the closed table', () => {
  it('posts exactly the deal doors this front prices from', () => {
    expect([...VIN_DEAL_DOORS].sort()).toEqual(['apis.vin'])
  })
})

// ---------------------------------------------------------------------------
// parseVinDealCheckout
// ---------------------------------------------------------------------------

describe('parseVinDealCheckout', () => {
  it('accepts a well-formed deal checkout query', () => {
    expect(parseVinDealCheckout(dealUrl())).toEqual({ ok: true, intent })
  })

  it('refuses a door outside the closed deal-door table', () => {
    const qs = DEAL_QS.replace(/apis\.vin/g, 'other.vin')
    const parsed = parseVinDealCheckout(dealUrl(qs))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('closed')
  })

  it('refuses a malformed deal id', () => {
    const parsed = parseVinDealCheckout(dealUrl(DEAL_QS.replace(`deal=${DEAL}`, 'deal=../../etc')))
    expect(parsed.ok).toBe(false)
  })

  it('refuses a malformed payment-link id — mint the OFFER first', () => {
    const parsed = parseVinDealCheckout(dealUrl(DEAL_QS.replace(`link=${LINK}`, 'link=whatever')))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('paymentlink_')
  })

  it('refuses a malformed VIN token', () => {
    const parsed = parseVinDealCheckout(dealUrl(DEAL_QS.replace(new RegExp(VIN, 'g'), 'NOT-A-VIN')))
    expect(parsed.ok).toBe(false)
  })

  it('refuses a return_to off the door host — no open redirect', () => {
    const qs = DEAL_QS.replace(encodeURIComponent(RETURN_TO), encodeURIComponent('https://evil.example.com/x'))
    expect(parseVinDealCheckout(dealUrl(qs)).ok).toBe(false)
  })

  it('refuses a non-https return_to', () => {
    const qs = DEAL_QS.replace(encodeURIComponent('https://'), encodeURIComponent('http://'))
    expect(parseVinDealCheckout(dealUrl(qs)).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// fetchVinDealOffer — the only price authority
// ---------------------------------------------------------------------------

describe('fetchVinDealOffer', () => {
  it('fetches the OFFER from the closed-table door address, never client input', () => {
    expect(vinDealOfferUrl(intent)).toBe(
      `https://apis.vin/buy/deals/${DEAL}/checkout.json?link=${LINK}`,
    )
  })

  it('accepts an open OFFER naming this link and prices in integer cents', async () => {
    const fetcher = vi.fn().mockResolvedValue(offerResponse())
    const fetched = await fetchVinDealOffer(intent, fetcher as unknown as typeof fetch)
    expect(fetched).toEqual({ ok: true, offer: { amountCents: 3_250_000, currency: 'usd' } })
    expect(fetcher).toHaveBeenCalledWith(vinDealOfferUrl(intent), { headers: { accept: 'application/json' } })
  })

  it.each(['superseded', 'expired', 'settled'])('refuses a %s link — a stale link never collects', async (status) => {
    const fetcher = vi.fn().mockResolvedValue(offerResponse(offerPage({ status })))
    const fetched = await fetchVinDealOffer(intent, fetcher as unknown as typeof fetch)
    expect(fetched.ok).toBe(false)
    if (!fetched.ok) expect(fetched.error).toContain(status)
  })

  it('refuses when the door names a different standing link', async () => {
    const fetcher = vi.fn().mockResolvedValue(offerResponse(offerPage({ paymentLink: 'paymentlink_Other1' })))
    const fetched = await fetchVinDealOffer(intent, fetcher as unknown as typeof fetch)
    expect(fetched.ok).toBe(false)
  })

  it('refuses when the OFFER names a different VIN', async () => {
    const fetcher = vi.fn().mockResolvedValue(offerResponse(offerPage({ vin: '1HGCM82633A004352' })))
    const fetched = await fetchVinDealOffer(intent, fetcher as unknown as typeof fetch)
    expect(fetched.ok).toBe(false)
  })

  it('refuses a non-integer or missing amount — never guesses', async () => {
    for (const amount_total of [12.5, '3250000', undefined, 0, -1]) {
      const fetcher = vi.fn().mockResolvedValue(
        offerResponse(offerPage({ settle: { amount_total, currency: 'usd' } })),
      )
      const fetched = await fetchVinDealOffer(intent, fetcher as unknown as typeof fetch)
      expect(fetched.ok).toBe(false)
    }
  })

  it('refuses an amount above the card ceiling', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      offerResponse(offerPage({ settle: { amount_total: MAX_DEAL_AMOUNT_CENTS + 1, currency: 'usd' } })),
    )
    const fetched = await fetchVinDealOffer(intent, fetcher as unknown as typeof fetch)
    expect(fetched.ok).toBe(false)
    if (!fetched.ok) expect(fetched.error).toContain('ceiling')
  })

  it('refuses a non-USD OFFER', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      offerResponse(offerPage({ settle: { amount_total: 3_250_000, currency: 'eur' } })),
    )
    const fetched = await fetchVinDealOffer(intent, fetcher as unknown as typeof fetch)
    expect(fetched.ok).toBe(false)
  })

  it('refuses when the door answers non-2xx or non-JSON or throws', async () => {
    const notFound = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }))
    expect((await fetchVinDealOffer(intent, notFound as unknown as typeof fetch)).ok).toBe(false)

    const notJson = vi.fn().mockResolvedValue(new Response('<html>', { status: 200 }))
    expect((await fetchVinDealOffer(intent, notJson as unknown as typeof fetch)).ok).toBe(false)

    const down = vi.fn().mockRejectedValue(new Error('network down'))
    const fetched = await fetchVinDealOffer(intent, down as unknown as typeof fetch)
    expect(fetched.ok).toBe(false)
    if (!fetched.ok) expect(fetched.status).toBe(502)
  })
})

// ---------------------------------------------------------------------------
// vinDealCheckoutSessionParams
// ---------------------------------------------------------------------------

describe('vinDealCheckoutSessionParams', () => {
  const offer = { amountCents: 3_250_000, currency: 'usd' as const }

  it('prices from the fetched OFFER and carries the deal correlation on session AND PaymentIntent', () => {
    const params = vinDealCheckoutSessionParams(intent, offer)
    expect(params.mode).toBe('payment')
    expect(params.client_reference_id).toBe(DEAL)
    expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(3_250_000)
    const metadata = {
      estate: 'vin',
      kind: 'deal',
      sku: 'deal',
      deal: DEAL,
      payment_link: LINK,
      vin: VIN,
      door: 'apis.vin',
    }
    expect(params.metadata).toEqual(metadata)
    expect(params.payment_intent_data?.metadata).toEqual(metadata)
  })

  it('returns the buyer to the deal checkout page with the literal {CHECKOUT_SESSION_ID} placeholder', () => {
    const params = vinDealCheckoutSessionParams(intent, offer)
    expect(params.success_url).toBe(`${RETURN_TO}?settled={CHECKOUT_SESSION_ID}`)
    expect(params.cancel_url).toBe(RETURN_TO)
  })
})

// ---------------------------------------------------------------------------
// vinDealSettlementFromSession
// ---------------------------------------------------------------------------

const paidDealSession = {
  id: 'cs_test_deal_1',
  payment_status: 'paid',
  payment_intent: 'pi_test_deal_2',
  amount_total: 3_250_000,
  currency: 'usd',
  metadata: {
    estate: 'vin',
    kind: 'deal',
    sku: 'deal',
    deal: DEAL,
    payment_link: LINK,
    vin: VIN,
    door: 'apis.vin',
  },
}

describe('vinDealSettlementFromSession', () => {
  it('extracts the deal settlement: session id as order_id, PaymentIntent as settlement_ref', () => {
    expect(vinDealSettlementFromSession(paidDealSession, false)).toEqual({
      deal: DEAL,
      payment_link: LINK,
      vin: VIN,
      door: 'apis.vin',
      order_id: 'cs_test_deal_1',
      settlement_ref: 'pi_test_deal_2',
      amount_total: 3_250_000,
      currency: 'usd',
      livemode: false,
    })
  })

  it('ignores non-deal vin sessions (the fixed-price leg keeps them)', () => {
    const sticker = {
      ...paidDealSession,
      metadata: { estate: 'vin', sku: 'sticker', vin: VIN, door: 'sticker.vin' },
    }
    expect(vinDealSettlementFromSession(sticker, false)).toBeNull()
  })

  it('ignores unpaid deal sessions', () => {
    expect(vinDealSettlementFromSession({ ...paidDealSession, payment_status: 'unpaid' }, false)).toBeNull()
  })

  it('and the fixed-price extractor ignores deal sessions — no double forward', () => {
    expect(vinSettlementFromSession(paidDealSession, false)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// forwardVinDealSettlement
// ---------------------------------------------------------------------------

describe('forwardVinDealSettlement', () => {
  const settlement = {
    deal: DEAL,
    payment_link: LINK,
    vin: VIN,
    door: 'apis.vin',
    order_id: 'cs_test_deal_1',
    settlement_ref: 'pi_test_deal_2',
    amount_total: 3_250_000,
    currency: 'usd',
    livemode: false,
  }

  it('POSTs the compact settle body to the deal door with the bearer', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const result = await forwardVinDealSettlement(settlement, { token: 'tok_test' }, fetcher as unknown as typeof fetch)
    expect(result).toEqual({ forwarded: true, status: 200 })
    expect(fetcher).toHaveBeenCalledWith(`https://apis.vin/buy/deals/${DEAL}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_test' },
      body: JSON.stringify({
        order_id: 'cs_test_deal_1',
        settlement_ref: 'pi_test_deal_2',
        amount_total: 3_250_000,
        currency: 'usd',
      }),
    })
  })

  it('refuses a door outside the closed table — money code re-checks its own metadata', async () => {
    const fetcher = vi.fn()
    const result = await forwardVinDealSettlement(
      { ...settlement, door: 'evil.example.com' },
      { token: 'tok_test' },
      fetcher as unknown as typeof fetch,
    )
    expect(result.forwarded).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses a session with no integer amount_total', async () => {
    const fetcher = vi.fn()
    const result = await forwardVinDealSettlement(
      { ...settlement, amount_total: null },
      {},
      fetcher as unknown as typeof fetch,
    )
    expect(result.forwarded).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports a non-2xx answer without throwing', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }))
    const result = await forwardVinDealSettlement(settlement, {}, fetcher as unknown as typeof fetch)
    expect(result).toEqual({ forwarded: false, status: 401 })
  })

  it('reports a thrown fetch as not forwarded', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'))
    const result = await forwardVinDealSettlement(settlement, {}, fetcher as unknown as typeof fetch)
    expect(result.forwarded).toBe(false)
    expect(result.reason).toBe('network down')
  })
})

// ---------------------------------------------------------------------------
// GET /checkout?sku=deal — the route
// ---------------------------------------------------------------------------

describe('GET /checkout?sku=deal', () => {
  it('fetches the OFFER, prices the session from it, and answers 303 to Stripe', async () => {
    const worker = await loadWorker()
    const fetchMock = vi.fn().mockResolvedValue(offerResponse())
    vi.stubGlobal('fetch', fetchMock)
    mockSessionsCreate.mockResolvedValue({ id: 'cs_test_deal_1', url: 'https://checkout.stripe.com/c/pay/cs_test_deal_1' })

    const res = await worker.default.fetch(new Request(dealUrl().toString()))

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/cs_test_deal_1')
    expect(fetchMock).toHaveBeenCalledWith(
      `https://apis.vin/buy/deals/${DEAL}/checkout.json?link=${LINK}`,
      { headers: { accept: 'application/json' } },
    )
    const params = mockSessionsCreate.mock.calls[0][0]
    expect(params.line_items[0].price_data.unit_amount).toBe(3_250_000)
    expect(params.metadata.deal).toBe(DEAL)
    expect(params.metadata.payment_link).toBe(LINK)
  })

  it('refuses a stale link with the door-stated status — no session minted', async () => {
    const worker = await loadWorker()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(offerResponse(offerPage({ status: 'superseded' }))))

    const res = await worker.default.fetch(new Request(dealUrl().toString()))

    expect(res.status).toBe(409)
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  it('refuses an unknown deal door with 400 before any fetch', async () => {
    const worker = await loadWorker()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await worker.default.fetch(
      new Request(dealUrl(DEAL_QS.replace(/apis\.vin/g, 'other.vin')).toString()),
    )

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockSessionsCreate).not.toHaveBeenCalled()
  })

  it('answers 503 naming the founder act while unconfigured — before any OFFER fetch', async () => {
    const worker = await loadWorker({ STRIPE_SECRET_KEY: undefined })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await worker.default.fetch(new Request(dealUrl().toString()))

    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /webhooks — the deal settlement leg
// ---------------------------------------------------------------------------

function webhookRequest(event: Record<string, unknown>): Request {
  return new Request('https://payments.do/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=mock' },
    body: JSON.stringify(event),
  })
}

const completedDealEvent = {
  id: 'evt_test_deal_1',
  type: 'checkout.session.completed',
  livemode: false,
  data: { object: paidDealSession },
}

describe('POST /webhooks — vin deal settlement forward', () => {
  it('forwards a PAID deal session to the deal door settle leg, NOT the fixed-price /_settle', async () => {
    const worker = await loadWorker({ VIN_SETTLE_URL: 'https://all.vin/_settle', VIN_SETTLE_TOKEN: 'tok_test' })
    mockWebhooksConstructEvent.mockReturnValue(completedDealEvent)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await worker.default.fetch(webhookRequest(completedDealEvent))

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      vin_deal: { deal: string; order_id: string; settlement_ref: string; forwarded: boolean }
    }
    expect(body.vin_deal).toEqual({
      deal: DEAL,
      order_id: 'cs_test_deal_1',
      settlement_ref: 'pi_test_deal_2',
      forwarded: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://apis.vin/buy/deals/${DEAL}/settle`)
    expect(init.headers.Authorization).toBe('Bearer tok_test')
    const forwarded = JSON.parse(init.body)
    expect(forwarded).toEqual({
      order_id: 'cs_test_deal_1',
      settlement_ref: 'pi_test_deal_2',
      amount_total: 3_250_000,
      currency: 'usd',
    })
  })

  it('answers 500 when the deal forward fails, so Stripe redelivers', async () => {
    const worker = await loadWorker({ VIN_SETTLE_TOKEN: 'tok_test' })
    mockWebhooksConstructEvent.mockReturnValue(completedDealEvent)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })))

    const res = await worker.default.fetch(webhookRequest(completedDealEvent))

    expect(res.status).toBe(500)
  })

  it('leaves fixed-price vin sessions on the existing /_settle leg', async () => {
    const worker = await loadWorker({ VIN_SETTLE_URL: 'https://all.vin/_settle', VIN_SETTLE_TOKEN: 'tok_test' })
    const stickerEvent = {
      ...completedDealEvent,
      data: {
        object: {
          ...paidDealSession,
          metadata: { estate: 'vin', sku: 'sticker', vin: VIN, door: 'sticker.vin' },
        },
      },
    }
    mockWebhooksConstructEvent.mockReturnValue(stickerEvent)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await worker.default.fetch(webhookRequest(stickerEvent))

    expect(res.status).toBe(200)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://all.vin/_settle')
  })
})
