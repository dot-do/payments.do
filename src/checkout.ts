/**
 * /checkout — the thin first-dollar checkout front for the vin estate
 * (platform-wiring ADR PW-5 step 2; vin beads vin-zik / vin-c2p.7; vin
 * integration-queue item 19).
 *
 * The vin estate relay (vin site src/relay.ts) points every gatefold OFFER's
 * `settle.checkoutUrl` at:
 *
 *   {payments.do}/checkout?sku=…&vin=…&door=…&return_to=…
 *
 * This module turns that GET into a Stripe Checkout Session:
 *
 *   - The SKU table is CLOSED and lives here as config, mirroring the vin
 *     relay's closed table (sticker $12; VHR $19.99 fresh / $9.99 cached).
 *     The request never carries a price, so a tampered query string cannot
 *     reprice an offer — an unknown SKU refuses, it never guesses.
 *   - {sku, vin, door} ride as metadata on BOTH the Checkout Session and its
 *     PaymentIntent. The PaymentIntent id is the settlement object the vin
 *     ledger records as `settlement_ref` (vin ledger-events §4.4: no money
 *     event without a settlement_ref).
 *   - On completion the buyer returns to `return_to` — the exact door URL
 *     they were reading — with `?settled={CHECKOUT_SESSION_ID}` appended so
 *     the door can render the purchased artifact (vin premium-gate §1.6:
 *     checkout return renders full). Cancel returns to `return_to` unchanged.
 *   - `return_to` must be https on the offering door's own host, and the door
 *     must be a .vin host: this front never redirects off the estate that
 *     posted the OFFER (open-redirect guard).
 *
 * The settlement leg: the Stripe webhook terminates on payments.do (vin
 * two-route doctrine — never on a door). `checkout.session.completed` events
 * whose metadata carries `estate: "vin"` are forwarded as a compact
 * settlement confirmation to VIN_SETTLE_URL (bearer VIN_SETTLE_TOKEN), where
 * the estate's confirmRelaySettlement lands the money events. A configured-
 * but-failed forward returns 500 to Stripe so the event redelivers
 * (at-least-once; the estate side dedupes by order_id).
 */
import type Stripe from 'stripe'

// ---------------------------------------------------------------------------
// The closed vin SKU table — prices are config, never computed per call.
// Mirrors vin site src/relay.ts RELAY_SKUS; reprice only at posted windows.
// ---------------------------------------------------------------------------

export interface VinCheckoutSku {
  /** Line-item name as the buyer sees it on Stripe Checkout. */
  name: string
  /** Posted price in cents. The number is the number. */
  unitAmount: number
  /** Line-item description; the VIN is appended at session build. */
  description: string
}

export const VIN_CHECKOUT_SKUS: Record<string, VinCheckoutSku> = {
  sticker: {
    name: 'Original window sticker',
    unitAmount: 1200,
    description: 'Factory build, options, pricing as posted. Print and permalink included.',
  },
  vhr: {
    name: 'Vehicle history report — fresh pull',
    unitAmount: 1999,
    description: 'Full vehicle history: records, photos over time, window sticker, value.',
  },
  'vhr-cached': {
    name: 'Vehicle history report — cached',
    unitAmount: 999,
    description: 'Cached vehicle history report; last pull timestamp posted.',
  },
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

const VIN_TOKEN = /^[A-HJ-NPR-Z0-9]{17}$/
const DOOR_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.vin$/

export interface VinCheckoutIntent {
  sku: string
  vin: string
  /** The offering door host, e.g. "sticker.vin". */
  door: string
  /** Where the buyer returns — https on the door's own host. */
  returnTo: string
}

export type ParsedVinCheckout =
  | { ok: true; intent: VinCheckoutIntent }
  | { ok: false; error: string }

/** Validate /checkout query params into a checkout intent, or refuse. */
export function parseVinCheckout(url: URL): ParsedVinCheckout {
  const sku = url.searchParams.get('sku') ?? ''
  const vin = (url.searchParams.get('vin') ?? '').toUpperCase()
  const door = (url.searchParams.get('door') ?? '').toLowerCase()
  const returnTo = url.searchParams.get('return_to') ?? ''

  if (!VIN_CHECKOUT_SKUS[sku]) {
    return { ok: false, error: `unknown sku "${sku}" — the SKU table is closed; this front never guesses a price` }
  }
  if (!VIN_TOKEN.test(vin)) {
    return { ok: false, error: 'vin must be a 17-character VIN token' }
  }
  if (!DOOR_HOST.test(door)) {
    return { ok: false, error: 'door must be a .vin host' }
  }
  let parsedReturn: URL
  try {
    parsedReturn = new URL(returnTo)
  } catch {
    return { ok: false, error: 'return_to must be an absolute URL' }
  }
  if (parsedReturn.protocol !== 'https:' || parsedReturn.host !== door) {
    return { ok: false, error: 'return_to must be https on the offering door — checkout never redirects off the estate' }
  }
  return { ok: true, intent: { sku, vin, door, returnTo } }
}

// ---------------------------------------------------------------------------
// Checkout Session build
// ---------------------------------------------------------------------------

/**
 * Build the Stripe Checkout Session params for one vin checkout intent.
 * Amount and copy come from the closed table only.
 */
export function vinCheckoutSessionParams(intent: VinCheckoutIntent): Stripe.Checkout.SessionCreateParams {
  const sku = VIN_CHECKOUT_SKUS[intent.sku]
  if (!sku) throw new Error(`unknown sku "${intent.sku}" — the SKU table is closed`)
  const metadata = { estate: 'vin', sku: intent.sku, vin: intent.vin, door: intent.door }
  // Literal {CHECKOUT_SESSION_ID} — Stripe substitutes it; URLSearchParams
  // would percent-encode the braces, so the query string is concatenated.
  const sep = intent.returnTo.includes('?') ? '&' : '?'
  return {
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: sku.unitAmount,
          product_data: {
            name: sku.name,
            description: `${sku.description} VIN ${intent.vin}.`,
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
// Settlement forward — the webhook's vin leg
// ---------------------------------------------------------------------------

/** The compact settlement confirmation the vin estate receives. */
export interface VinSettlement {
  sku: string
  vin: string
  door: string
  /** The Checkout Session id (`cs_…`) — the estate's order/dedupe key. */
  order_id: string
  /** The object that MOVED the money (`pi_…`) — vin ledger-events §4.4 settlement_ref. */
  settlement_ref: string
  amount_total: number | null
  currency: string | null
  livemode: boolean
}

/**
 * Read a `checkout.session.completed` payload; return the settlement
 * confirmation when it is a PAID vin-estate session, else null.
 */
export function vinSettlementFromSession(
  session: Record<string, unknown>,
  livemode: boolean
): VinSettlement | null {
  const metadata = (session.metadata ?? null) as Record<string, string> | null
  if (metadata?.estate !== 'vin') return null
  // Deal sessions (kind=deal) settle on the deal door's own settle leg
  // (src/deal-checkout.ts) — never on the fixed-price /_settle forward, whose
  // closed SKU table would refuse them.
  if (metadata.kind === 'deal') return null
  if (session.payment_status !== 'paid') return null
  const pi = session.payment_intent
  const settlementRef =
    typeof pi === 'string' ? pi : ((pi as { id?: string } | null)?.id ?? String(session.id))
  return {
    sku: metadata.sku ?? '',
    vin: metadata.vin ?? '',
    door: metadata.door ?? '',
    order_id: String(session.id),
    settlement_ref: settlementRef,
    amount_total: typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: typeof session.currency === 'string' ? session.currency : null,
    livemode,
  }
}

export interface VinForwardResult {
  forwarded: boolean
  /** Set when the endpoint answered non-2xx. */
  status?: number
  /** Set when the forward was skipped (no URL) or threw. */
  reason?: string
}

/**
 * POST the settlement confirmation to the vin estate. No URL configured →
 * skip (the events pipeline still carries the raw Stripe event); configured
 * but failing → the caller answers Stripe 500 so the webhook redelivers.
 */
export async function forwardVinSettlement(
  settlement: VinSettlement,
  cfg: { url?: string; token?: string },
  fetcher: typeof fetch = fetch
): Promise<VinForwardResult> {
  if (!cfg.url) return { forwarded: false, reason: 'VIN_SETTLE_URL unset' }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`
  try {
    const res = await fetcher(cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(settlement),
    })
    if (!res.ok) return { forwarded: false, status: res.status }
    return { forwarded: true, status: res.status }
  } catch (err) {
    return { forwarded: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
