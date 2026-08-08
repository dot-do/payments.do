/**
 * /checkout?sku=deal — the vin estate's VARIABLE-AMOUNT deal-settlement front
 * (the buy pillar's cash-to-close; vin apis.vin deal lifecycle).
 *
 * The fixed-price legs (src/checkout.ts) price from a closed table. A vehicle
 * deal's cash-to-close is desked per deal, so its price CANNOT live in a
 * table here — and it may NEVER ride the query string (client input prices
 * nothing). Instead the amount comes from the deal's own posted OFFER:
 *
 *   1. The deal door (closed table: apis.vin) mints a payment link and posts
 *      the OFFER at GET https://{door}/buy/deals/{deal}/checkout.json —
 *      status, the standing paymentLink id, and settle.amount_total in cents.
 *   2. This front fetches that OFFER server-side, verifies the asked link IS
 *      the standing OPEN link, and prices the Stripe Checkout Session from
 *      settle.amount_total. A superseded / expired / settled link refuses —
 *      a re-desk changes the numbers, so a stale link never collects them.
 *   3. {deal, payment_link, vin, door} ride as metadata on the session AND
 *      its PaymentIntent; the PaymentIntent id is the settlement_ref.
 *
 * The settlement leg: `checkout.session.completed` events whose metadata
 * carries `estate: "vin", kind: "deal"` forward to the deal's OWN settle
 * door — POST https://{door}/buy/deals/{deal}/settle (bearer
 * VIN_SETTLE_TOKEN) with { order_id, settlement_ref, amount_total,
 * currency }. The estate refuses any amount that disagrees with the desked
 * cash-to-close (refused, never repriced) and dedupes by order_id. A failed
 * forward answers Stripe 500 so the event redelivers (at-least-once).
 */
import type Stripe from 'stripe'

// ---------------------------------------------------------------------------
// The closed deal-door table — which hosts may post a deal OFFER this front
// will price from. Closed like the SKU table: an unknown door refuses, it
// never fetches. (This is the amount-integrity boundary: the OFFER source URL
// is constructed from this table + validated ids, never from client input.)
// ---------------------------------------------------------------------------

export const DEAL_SKU = 'deal'

export const VIN_DEAL_DOORS: ReadonlySet<string> = new Set(['apis.vin'])

/**
 * Stripe Checkout's card ceiling ($999,999.99) — and a sanity ceiling for a
 * cash-to-close. An OFFER above it refuses honestly rather than failing
 * opaquely at Stripe.
 */
export const MAX_DEAL_AMOUNT_CENTS = 99_999_999

const VIN_TOKEN = /^[A-HJ-NPR-Z0-9]{17}$/
const DEAL_ID = /^deal_[A-Za-z0-9]{1,32}$/
const PAYMENT_LINK_ID = /^paymentlink_[A-Za-z0-9]{1,32}$/

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export interface VinDealCheckoutIntent {
  /** The deal id (`deal_…`) — the correlation object the settlement lands on. */
  deal: string
  /** The payment-link id (`paymentlink_…`) the OFFER minted — must be the standing OPEN link. */
  link: string
  vin: string
  /** The offering deal door, e.g. "apis.vin" — member of the closed table. */
  door: string
  /** Where the buyer returns — https on the door's own host. */
  returnTo: string
}

export type ParsedVinDealCheckout =
  | { ok: true; intent: VinDealCheckoutIntent }
  | { ok: false; error: string }

/** Validate /checkout?sku=deal query params into a deal-checkout intent, or refuse. */
export function parseVinDealCheckout(url: URL): ParsedVinDealCheckout {
  const refuse = (error: string): ParsedVinDealCheckout => ({ ok: false, error })
  if (url.searchParams.get('sku') !== DEAL_SKU) return refuse('not a deal checkout')
  const deal = url.searchParams.get('deal') ?? ''
  const link = url.searchParams.get('link') ?? ''
  const vin = (url.searchParams.get('vin') ?? '').toUpperCase()
  const door = (url.searchParams.get('door') ?? '').toLowerCase()
  const returnTo = url.searchParams.get('return_to') ?? ''

  if (!DEAL_ID.test(deal)) return refuse('deal must be a deal_… id')
  if (!PAYMENT_LINK_ID.test(link)) return refuse('link must be a paymentlink_… id — mint the OFFER first (POST /buy/deals/{dealId}/checkout on the deal door)')
  if (!VIN_TOKEN.test(vin)) return refuse('vin must be a 17-character VIN token')
  if (!VIN_DEAL_DOORS.has(door)) {
    return refuse(`unknown deal door "${door}" — the deal-door table is closed; this front prices only from a door it knows`)
  }
  let parsedReturn: URL
  try {
    parsedReturn = new URL(returnTo)
  } catch {
    return refuse('return_to must be an absolute URL')
  }
  if (parsedReturn.protocol !== 'https:' || parsedReturn.host !== door) {
    return refuse('return_to must be https on the offering door — checkout never redirects off the estate')
  }
  return { ok: true, intent: { deal, link, vin, door, returnTo } }
}

// ---------------------------------------------------------------------------
// The OFFER fetch — the ONLY price authority for a deal checkout
// ---------------------------------------------------------------------------

/** The priced OFFER as read from the deal door. */
export interface VinDealOffer {
  /** The desked cash-to-close in integer cents, from settle.amount_total. */
  amountCents: number
  currency: 'usd'
}

export type FetchedVinDealOffer =
  | { ok: true; offer: VinDealOffer }
  | { ok: false; error: string; status: number }

/** The deal door's OFFER address — built from the CLOSED door table + validated ids only. */
export function vinDealOfferUrl(intent: VinDealCheckoutIntent): string {
  return `https://${intent.door}/buy/deals/${intent.deal}/checkout.json?link=${intent.link}`
}

/**
 * Fetch the deal's posted OFFER from its door and verify it prices THIS link:
 * the page must answer OK with status "open", name the asked paymentLink as
 * the standing one, name the same VIN, and post an integer-cents USD
 * amount within the ceiling. Anything else refuses — never guesses.
 */
export async function fetchVinDealOffer(
  intent: VinDealCheckoutIntent,
  fetcher: typeof fetch = fetch
): Promise<FetchedVinDealOffer> {
  const refuse = (error: string, status = 409): FetchedVinDealOffer => ({ ok: false, error, status })
  let res: Response
  try {
    res = await fetcher(vinDealOfferUrl(intent), { headers: { accept: 'application/json' } })
  } catch (err) {
    return refuse(`the deal door did not answer: ${err instanceof Error ? err.message : String(err)}`, 502)
  }
  if (!res.ok) {
    return refuse(`the deal door answered ${res.status} for this OFFER — nothing to price`, 502)
  }
  let page: Record<string, unknown>
  try {
    page = (await res.json()) as Record<string, unknown>
  } catch {
    return refuse('the deal door answered non-JSON — nothing to price', 502)
  }
  const status = typeof page.status === 'string' ? page.status : ''
  if (status !== 'open') {
    return refuse(
      `this payment link is not open on the deal door (status: ${status || 'unknown'}) — ` +
        'a superseded, expired, or settled link never collects; mint a fresh OFFER (POST /buy/deals/{dealId}/checkout)'
    )
  }
  if (page.paymentLink !== intent.link) {
    return refuse('the deal door names a different standing payment link — this link never collects')
  }
  if (typeof page.vin === 'string' && page.vin.toUpperCase() !== intent.vin) {
    return refuse('the OFFER names a different VIN than this checkout')
  }
  const settle = (page.settle ?? null) as Record<string, unknown> | null
  const amount = settle?.amount_total
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return refuse('the OFFER posts no integer-cents amount_total — nothing to price', 502)
  }
  if (amount > MAX_DEAL_AMOUNT_CENTS) {
    return refuse(`the OFFER's cash-to-close (${amount} cents) exceeds this front's card ceiling (${MAX_DEAL_AMOUNT_CENTS}) — settle off-rail`)
  }
  const currency = typeof settle?.currency === 'string' ? settle.currency.toLowerCase() : ''
  if (currency !== 'usd') {
    return refuse(`the OFFER posts currency "${currency}" — this front settles USD only`)
  }
  return { ok: true, offer: { amountCents: amount, currency: 'usd' } }
}

// ---------------------------------------------------------------------------
// Checkout Session build — priced from the fetched OFFER only
// ---------------------------------------------------------------------------

export function vinDealCheckoutSessionParams(
  intent: VinDealCheckoutIntent,
  offer: VinDealOffer
): Stripe.Checkout.SessionCreateParams {
  const metadata = {
    estate: 'vin',
    kind: 'deal',
    sku: DEAL_SKU,
    deal: intent.deal,
    payment_link: intent.link,
    vin: intent.vin,
    door: intent.door,
  }
  // Literal {CHECKOUT_SESSION_ID} — Stripe substitutes it; URLSearchParams
  // would percent-encode the braces, so the query string is concatenated.
  const sep = intent.returnTo.includes('?') ? '&' : '?'
  return {
    mode: 'payment',
    client_reference_id: intent.deal,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: offer.currency,
          unit_amount: offer.amountCents,
          product_data: {
            name: `Cash to close — VIN ${intent.vin}`,
            description: `Vehicle deal ${intent.deal} settlement as desked on ${intent.door}. Amount as posted on the deal's OFFER.`,
          },
        },
      },
    ],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${intent.returnTo}${sep}settled={CHECKOUT_SESSION_ID}`,
    cancel_url: intent.returnTo,
  }
}

// ---------------------------------------------------------------------------
// Settlement forward — the webhook's deal leg
// ---------------------------------------------------------------------------

/** The compact settlement confirmation the deal door receives. */
export interface VinDealSettlement {
  deal: string
  payment_link: string
  vin: string
  door: string
  /** The Checkout Session id (`cs_…`) — the deal door's idempotency/order key. */
  order_id: string
  /** The object that MOVED the money (`pi_…`) — the settlement_ref. */
  settlement_ref: string
  amount_total: number | null
  currency: string | null
  livemode: boolean
}

/**
 * Read a `checkout.session.completed` payload; return the deal settlement
 * when it is a PAID vin-estate DEAL session, else null. (Fixed-price vin
 * sessions carry no `kind` and stay on the src/checkout.ts leg.)
 */
export function vinDealSettlementFromSession(
  session: Record<string, unknown>,
  livemode: boolean
): VinDealSettlement | null {
  const metadata = (session.metadata ?? null) as Record<string, string> | null
  if (metadata?.estate !== 'vin' || metadata?.kind !== 'deal') return null
  if (session.payment_status !== 'paid') return null
  const pi = session.payment_intent
  const settlementRef =
    typeof pi === 'string' ? pi : ((pi as { id?: string } | null)?.id ?? String(session.id))
  return {
    deal: metadata.deal ?? '',
    payment_link: metadata.payment_link ?? '',
    vin: metadata.vin ?? '',
    door: metadata.door ?? '',
    order_id: String(session.id),
    settlement_ref: settlementRef,
    amount_total: typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: typeof session.currency === 'string' ? session.currency : null,
    livemode,
  }
}

export interface VinDealForwardResult {
  forwarded: boolean
  /** Set when the endpoint answered non-2xx. */
  status?: number
  /** Set when the forward was refused locally (bad metadata) or threw. */
  reason?: string
}

/**
 * POST the settlement confirmation to the deal door's own settle leg —
 * https://{door}/buy/deals/{deal}/settle, bearer VIN_SETTLE_TOKEN. The door
 * is re-validated against the closed table at forward time (metadata is
 * ours, but money code re-checks). A failing forward → the caller answers
 * Stripe 500 so the webhook redelivers; the door dedupes by order_id.
 */
export async function forwardVinDealSettlement(
  settlement: VinDealSettlement,
  cfg: { token?: string },
  fetcher: typeof fetch = fetch
): Promise<VinDealForwardResult> {
  if (!VIN_DEAL_DOORS.has(settlement.door)) {
    return { forwarded: false, reason: `unknown deal door "${settlement.door}" — refused` }
  }
  if (!DEAL_ID.test(settlement.deal)) {
    return { forwarded: false, reason: 'malformed deal id — refused' }
  }
  if (settlement.amount_total === null || !Number.isInteger(settlement.amount_total)) {
    return { forwarded: false, reason: 'session carries no integer amount_total — refused' }
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`
  const body = {
    order_id: settlement.order_id,
    settlement_ref: settlement.settlement_ref,
    amount_total: settlement.amount_total,
    currency: settlement.currency ?? 'usd',
  }
  try {
    const res = await fetcher(`https://${settlement.door}/buy/deals/${settlement.deal}/settle`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) return { forwarded: false, status: res.status }
    return { forwarded: true, status: res.status }
  } catch (err) {
    return { forwarded: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
