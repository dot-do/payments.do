/**
 * payments.do — Stripe as a managed .do service
 *
 * REST API for service binding consumers (e.g. db.headless.ly integration dispatch):
 *   POST   /customers               → stripe.customers.create()
 *   GET    /customers/:id           → stripe.customers.retrieve()
 *   PATCH  /customers/:id           → stripe.customers.update()
 *   POST   /subscriptions           → stripe.subscriptions.create()
 *   GET    /subscriptions/:id       → stripe.subscriptions.retrieve()
 *   PATCH  /subscriptions/:id       → stripe.subscriptions.update()
 *   DELETE /subscriptions/:id       → stripe.subscriptions.cancel()
 *   POST   /subscriptions/:id/pause → pause via pause_collection
 *   POST   /subscriptions/:id/resume → resume via clearing pause_collection
 *   POST   /charges                 → stripe.charges.create()
 *   GET    /charges/:id             → stripe.charges.retrieve()
 *   POST   /invoices                → stripe.invoices.create()
 *   GET    /invoices/:id            → stripe.invoices.retrieve()
 *   POST   /invoices/:id/finalize   → stripe.invoices.finalizeInvoice()
 *   POST   /invoices/:id/void       → stripe.invoices.voidInvoice()
 *   POST   /products                → stripe.products.create()
 *   GET    /products/:id            → stripe.products.retrieve()
 *   PATCH  /products/:id            → stripe.products.update()
 *   POST   /prices                  → stripe.prices.create()
 *   GET    /prices/:id              → stripe.prices.retrieve()
 *   POST   /refunds                 → stripe.refunds.create()
 *   POST   /webhooks                → Stripe webhook verification + processing
 *   GET    /                        → Health check / discovery
 *
 * Caller authentication (dot-do/payments.do#2):
 *   Every route except the PUBLIC_ROUTES allowlist (`POST /webhooks`,
 *   `GET /checkout`) requires `Authorization: Bearer <PAYMENTS_API_TOKEN>`.
 *   That secret is deliberately never set, so every gated route answers 401
 *   (fail closed): the public hostname serves only the two public routes.
 *
 * Service-binding consumers use the `PaymentsInternal` RPC entrypoint
 * (exported below; src/rpc-types.ts is its contract) — typed methods, no
 * fetch handler, no bearer. Only Workers on this account can bind it, so the
 * binding itself is the authorization boundary.
 *
 * Stripe Connect multi-tenant scoping (authenticated callers only):
 *   Gated endpoints accept a `Stripe-Account` header (or `stripeAccount` field
 *   in request body) to scope API calls to a connected account. This enables
 *   per-tenant billing where each tenant has their own Stripe account linked
 *   via Stripe Connect. The pivot is refused on unauthenticated requests.
 *
 * Capnweb RPC clients (e.g. `payments.do` SDK) use the RPC fallback (gated).
 */

import Stripe from 'stripe'
import { timingSafeEqual } from 'node:crypto'
import { env, WorkerEntrypoint } from 'cloudflare:workers'
import { RPC } from 'rpc.do'
import * as ops from './operations'
import { getStripe, sanitizeError, stripeErrorStatus } from './operations'
import type {
  CreateCustomerInput,
  CreateSubscriptionInput,
  PaymentsInternalApi,
  RetrieveInput,
  StripeObjectRef,
  SubscriptionRef,
} from './rpc-types'
import { buildStripeEvent, buildImportEvent, emitStripeEvents } from './events'
import type { NormalizedEvent } from './events'
import {
  forwardVinSettlement,
  parseVinCheckout,
  vinCheckoutSessionParams,
  vinSettlementFromSession,
} from './checkout'

// ---------------------------------------------------------------------------
// Lazy Stripe + RPC init
// ---------------------------------------------------------------------------

/** The RPC fallback's runtime surface — rpc.do 0.2.x no longer types `fetch`. */
interface RpcFallback {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>
}

let _rpc: RpcFallback | null = null

function getRpc(): RpcFallback {
  if (!_rpc) {
    // rpc.do 0.2.x retyped RPC() around transports; the deployed capnweb
    // fallback wraps the Stripe SDK object directly (runtime contract
    // unchanged) — cast across the drift rather than fork the surface.
    _rpc = RPC(getStripe() as unknown as Parameters<typeof RPC>[0]) as unknown as RpcFallback
  }
  return _rpc
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status)
}

async function parseBody<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Stripe Connect scoping
// ---------------------------------------------------------------------------

/**
 * Extract the Stripe Connect account ID for request scoping.
 *
 * Resolution priority:
 *   1. `Stripe-Account` request header (standard Stripe convention)
 *   2. `stripeAccount` field in parsed request body (for programmatic callers)
 *
 * When a connected account is specified, all Stripe API calls are scoped to
 * that account via the `stripeAccount` request option, which sets the
 * `Stripe-Account` header on outbound API calls.
 *
 * Returns Stripe request options with `stripeAccount` set, or undefined
 * if no connected account is specified (platform account is used).
 */
function getConnectOptions(request: Request, body?: { stripeAccount?: unknown }): Stripe.RequestOptions | undefined {
  // Priority 1: Stripe-Account header (standard Stripe convention)
  const headerAccount = request.headers.get('Stripe-Account')
  if (headerAccount) {
    return { stripeAccount: headerAccount }
  }

  // Priority 2: stripeAccount in body (for programmatic callers)
  const bodyAccount = body?.stripeAccount as string | undefined
  if (bodyAccount) {
    return { stripeAccount: bodyAccount }
  }

  return undefined
}

/** The connected account a gated REST request pivots to, if any (header, then body field). */
function connectAccount(request: Request, body?: { stripeAccount?: unknown }): string | undefined {
  return getConnectOptions(request, body)?.stripeAccount
}

/**
 * Strip the `stripeAccount` field from a body object before passing to Stripe.
 * This prevents Stripe from treating it as an unknown parameter.
 */
function stripConnectField<T extends Record<string, unknown>>(body: T): Omit<T, 'stripeAccount'> {
  if (!('stripeAccount' in body)) return body
  const { stripeAccount: _, ...rest } = body
  return rest as Omit<T, 'stripeAccount'>
}

// ---------------------------------------------------------------------------
// Caller auth gate (dot-do/payments.do#2)
// ---------------------------------------------------------------------------

/**
 * Routes reachable without `Authorization: Bearer <PAYMENTS_API_TOKEN>`.
 * Every other path — every Stripe pass-through route, the health check, and
 * the RPC fallback — is gated. Keep this list as small as possible and name
 * the reason for each entry.
 */
const PUBLIC_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  // Called by Stripe, which cannot carry our bearer; authenticated by the
  // Stripe-Signature header (webhooks.constructEvent, STRIPE_WEBHOOK_SECRET).
  { method: 'POST', path: '/webhooks' },
  // Buyer-facing first-dollar front (vin gatefold → 303 to Stripe Checkout):
  // a browser navigation with no way to hold a credential. Safe to expose
  // because the amount comes from the closed SKU table, never the query.
  { method: 'GET', path: '/checkout' },
]

/** JSON body of every 401 the gate emits. */
export interface AuthErrorBody {
  error: 'unauthorized'
  code: 'missing_bearer' | 'invalid_bearer' | 'token_unconfigured' | 'connect_requires_auth'
}

function isPublicRoute(method: string, pathname: string): boolean {
  return PUBLIC_ROUTES.some((r) => r.method === method && r.path === pathname)
}

function unauthorized(code: AuthErrorBody['code']): Response {
  const body: AuthErrorBody = { error: 'unauthorized', code }
  return Response.json(body, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="payments.do"' } })
}

/** Constant-time string equality; length mismatch short-circuits (length is not secret). */
function tokensEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  if (ab.byteLength !== bb.byteLength) return false
  return timingSafeEqual(ab, bb)
}

let warnedTokenUnconfigured = false

/**
 * Decide whether the caller may reach a gated route.
 *
 * Fails CLOSED: when PAYMENTS_API_TOKEN is unset every gated route answers 401
 * (logged once), so a deploy that forgets the secret cannot reopen the hole.
 */
function authenticateCaller(request: Request): { ok: true } | { ok: false; code: AuthErrorBody['code'] } {
  const expected = env.PAYMENTS_API_TOKEN
  if (!expected) {
    if (!warnedTokenUnconfigured) {
      warnedTokenUnconfigured = true
      console.error('[auth] PAYMENTS_API_TOKEN is not configured; refusing every gated route. Run: wrangler secret put PAYMENTS_API_TOKEN')
    }
    return { ok: false, code: 'token_unconfigured' }
  }
  const header = request.headers.get('Authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  if (!match) return { ok: false, code: 'missing_bearer' }
  if (!tokensEqual(match[1], expected)) return { ok: false, code: 'invalid_bearer' }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

type Handler = (request: Request, params: Record<string, string>) => Promise<Response>

interface Route {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: Handler
}

const routes: Route[] = []

function route(method: string, path: string, handler: Handler) {
  const paramNames: string[] = []
  const pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name)
    return '([^/]+)'
  })
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler })
}

function matchRoute(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue
    const match = pathname.match(r.pattern)
    if (match) {
      const params: Record<string, string> = {}
      r.paramNames.forEach((name, i) => {
        params[name] = match[i + 1]
      })
      return { handler: r.handler, params }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// REST Routes
// ---------------------------------------------------------------------------

// Health check / discovery
route('GET', '/', async () => {
  const hasKey = !!env.STRIPE_SECRET_KEY
  return json({
    api: 'payments.do',
    version: '0.2.0',
    status: hasKey ? 'ready' : 'unconfigured',
    connect: 'Pass Stripe-Account header to scope API calls to a connected account',
    endpoints: {
      customers: { create: 'POST /customers', retrieve: 'GET /customers/:id', update: 'PATCH /customers/:id' },
      subscriptions: {
        create: 'POST /subscriptions',
        retrieve: 'GET /subscriptions/:id',
        update: 'PATCH /subscriptions/:id',
        cancel: 'DELETE /subscriptions/:id',
        pause: 'POST /subscriptions/:id/pause',
        resume: 'POST /subscriptions/:id/resume',
      },
      charges: { create: 'POST /charges', retrieve: 'GET /charges/:id' },
      invoices: {
        create: 'POST /invoices',
        retrieve: 'GET /invoices/:id',
        finalize: 'POST /invoices/:id/finalize',
        void: 'POST /invoices/:id/void',
      },
      products: { create: 'POST /products', retrieve: 'GET /products/:id', update: 'PATCH /products/:id' },
      prices: { create: 'POST /prices', retrieve: 'GET /prices/:id' },
      refunds: { create: 'POST /refunds' },
      checkout: 'GET /checkout?sku=…&vin=…&door=…&return_to=… → 303 to Stripe Checkout (vin estate gatefold; PW-5)',
      webhooks: 'POST /webhooks',
    },
  })
})

// --- Customers ---

route('POST', '/customers', async (request) => {
  const body = await parseBody<CreateCustomerInput>(request)
  const customer = await ops.createCustomer({ ...body, stripeAccount: connectAccount(request, body) })
  return json(customer, 201)
})

route('GET', '/customers/:id', async (request, params) => {
  const customer = await ops.getCustomer({ id: params.id, stripeAccount: connectAccount(request) })
  return json(customer)
})

route('PATCH', '/customers/:id', async (request, params) => {
  const body = await parseBody<Record<string, unknown>>(request)
  const opts = getConnectOptions(request, body)
  const customer = await getStripe().customers.update(params.id, stripConnectField(body) as Stripe.CustomerUpdateParams, opts)
  return json(customer)
})

// --- Subscriptions ---

route('POST', '/subscriptions', async (request) => {
  const body = await parseBody<CreateSubscriptionInput>(request)
  const subscription = await ops.createSubscription({ ...body, stripeAccount: connectAccount(request, body) })
  return json(subscription, 201)
})

route('GET', '/subscriptions/:id', async (request, params) => {
  const subscription = await ops.getSubscription({ id: params.id, stripeAccount: connectAccount(request) })
  return json(subscription)
})

route('DELETE', '/subscriptions/:id', async (request, params) => {
  const opts = getConnectOptions(request)
  const subscription = await getStripe().subscriptions.cancel(params.id, undefined, opts)
  return json(subscription)
})

route('PATCH', '/subscriptions/:id', async (request, params) => {
  const body = await parseBody<Record<string, unknown>>(request)
  const opts = getConnectOptions(request, body)
  const subscription = await getStripe().subscriptions.update(params.id, stripConnectField(body) as Stripe.SubscriptionUpdateParams, opts)
  return json(subscription)
})

// Pause a subscription (set pause_collection)
route('POST', '/subscriptions/:id/pause', async (request, params) => {
  const opts = getConnectOptions(request)
  const subscription = await getStripe().subscriptions.update(
    params.id,
    {
      pause_collection: { behavior: 'void' },
    },
    opts,
  )
  return json(subscription)
})

// Resume a paused subscription (clear pause_collection)
route('POST', '/subscriptions/:id/resume', async (request, params) => {
  const opts = getConnectOptions(request)
  const subscription = await getStripe().subscriptions.update(
    params.id,
    {
      pause_collection: '',
    } as unknown as Stripe.SubscriptionUpdateParams,
    opts,
  )
  return json(subscription)
})

// --- Charges ---

route('POST', '/charges', async (request) => {
  const body = await parseBody<{
    amount: number
    currency: string
    customer?: string
    description?: string
    metadata?: Record<string, string>
    stripeAccount?: string
  }>(request)
  const opts = getConnectOptions(request, body)
  const charge = await getStripe().charges.create(stripConnectField(body), opts)
  return json(charge, 201)
})

route('GET', '/charges/:id', async (request, params) => {
  const charge = await ops.getCharge({ id: params.id, stripeAccount: connectAccount(request) })
  return json(charge)
})

// --- Invoices ---

route('POST', '/invoices', async (request) => {
  const body = await parseBody<Record<string, unknown>>(request)
  const opts = getConnectOptions(request, body)
  const invoice = await getStripe().invoices.create(stripConnectField(body) as Stripe.InvoiceCreateParams, opts)
  return json(invoice, 201)
})

route('GET', '/invoices/:id', async (request, params) => {
  const invoice = await ops.getInvoice({ id: params.id, stripeAccount: connectAccount(request) })
  return json(invoice)
})

route('POST', '/invoices/:id/finalize', async (request, params) => {
  const opts = getConnectOptions(request)
  const invoice = await getStripe().invoices.finalizeInvoice(params.id, undefined, opts)
  return json(invoice)
})

route('POST', '/invoices/:id/void', async (request, params) => {
  const opts = getConnectOptions(request)
  const invoice = await getStripe().invoices.voidInvoice(params.id, undefined, opts)
  return json(invoice)
})

// --- Products ---

route('POST', '/products', async (request) => {
  const body = await parseBody<Record<string, unknown>>(request)
  const opts = getConnectOptions(request, body)
  const product = await getStripe().products.create(stripConnectField(body) as unknown as Stripe.ProductCreateParams, opts)
  return json(product, 201)
})

route('GET', '/products/:id', async (request, params) => {
  const product = await ops.getProduct({ id: params.id, stripeAccount: connectAccount(request) })
  return json(product)
})

route('PATCH', '/products/:id', async (request, params) => {
  const body = await parseBody<Record<string, unknown>>(request)
  const opts = getConnectOptions(request, body)
  const product = await getStripe().products.update(params.id, stripConnectField(body) as Stripe.ProductUpdateParams, opts)
  return json(product)
})

// --- Prices ---

route('POST', '/prices', async (request) => {
  const body = await parseBody<Record<string, unknown>>(request)
  const opts = getConnectOptions(request, body)
  const price = await getStripe().prices.create(stripConnectField(body) as unknown as Stripe.PriceCreateParams, opts)
  return json(price, 201)
})

route('GET', '/prices/:id', async (request, params) => {
  const price = await ops.getPrice({ id: params.id, stripeAccount: connectAccount(request) })
  return json(price)
})

// --- Refunds ---

route('POST', '/refunds', async (request) => {
  const body = await parseBody<{ payment_intent?: string; charge?: string; amount?: number; reason?: string; stripeAccount?: string }>(request)
  const opts = getConnectOptions(request, body)
  const refund = await getStripe().refunds.create(stripConnectField(body) as Stripe.RefundCreateParams, opts)
  return json(refund, 201)
})

// --- Baseline Import ---

route('POST', '/import', async (request) => {
  const body = await parseBody<{ ns?: string }>(request)
  const ns = body.ns || request.headers.get('x-tenant') || 'default'
  const stripe = getStripe()
  const events: NormalizedEvent[] = []

  // Import customers
  for await (const customer of stripe.customers.list({ limit: 100 })) {
    events.push(buildImportEvent({ ns, entityType: 'customer', entityId: customer.id, payload: customer as unknown as Record<string, unknown> }))
  }

  // Import subscriptions
  for await (const sub of stripe.subscriptions.list({ limit: 100, status: 'all' })) {
    events.push(buildImportEvent({ ns, entityType: 'subscription', entityId: sub.id, payload: sub as unknown as Record<string, unknown> }))
  }

  // Import products
  for await (const product of stripe.products.list({ limit: 100 })) {
    events.push(buildImportEvent({ ns, entityType: 'product', entityId: product.id, payload: product as unknown as Record<string, unknown> }))
  }

  // Import prices
  for await (const price of stripe.prices.list({ limit: 100 })) {
    events.push(buildImportEvent({ ns, entityType: 'price', entityId: price.id, payload: price as unknown as Record<string, unknown> }))
  }

  // Import invoices (last 1000)
  for await (const invoice of stripe.invoices.list({ limit: 100 })) {
    events.push(buildImportEvent({ ns, entityType: 'invoice', entityId: invoice.id, payload: invoice as unknown as Record<string, unknown> }))
    if (events.length > 5000) break // Safety limit
  }

  // Emit in batches of 100
  if (env.EVENTS) {
    const BATCH_SIZE = 100
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      await emitStripeEvents(events.slice(i, i + BATCH_SIZE), env.EVENTS)
    }
  }

  const counts: Record<string, number> = {}
  for (const e of events) {
    const t = e.data.entity
    counts[t] = (counts[t] || 0) + 1
  }

  return json({ imported: true, total: events.length, counts })
})

// --- Vin estate checkout (vin platform-wiring ADR PW-5; vin beads vin-zik) ---

// The thin first-dollar front: the vin gatefold's OFFER links here; this GET
// becomes a Stripe Checkout Session and answers 303 to Stripe's hosted page.
// Prices come from the closed table in src/checkout.ts — the query string
// never carries a price. Refusals are 400 with the reason stated.
route('GET', '/checkout', async (request) => {
  const parsed = parseVinCheckout(new URL(request.url))
  if (!parsed.ok) {
    return error(parsed.error, 400)
  }
  if (!env.STRIPE_SECRET_KEY) {
    // Deployed but unconfigured — activation is a founder act (PW-5 step 1).
    return error('payments.do is deployed but unconfigured. Founder act: wrangler secret put STRIPE_SECRET_KEY', 503)
  }
  const session = await getStripe().checkout.sessions.create(vinCheckoutSessionParams(parsed.intent))
  if (!session.url) {
    return error('Stripe created the session but returned no redirect URL', 502)
  }
  return new Response(null, { status: 303, headers: { Location: session.url } })
})

// --- Webhooks ---

route('POST', '/webhooks', async (request) => {
  const signature = request.headers.get('Stripe-Signature')
  if (!signature) {
    return error('Missing Stripe-Signature header', 400)
  }

  const webhookSecret = env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) {
    return error('Webhook secret not configured', 500)
  }

  const payload = await request.text()

  let event: Stripe.Event
  try {
    event = getStripe().webhooks.constructEvent(payload, signature, webhookSecret)
  } catch (err) {
    return error(`Webhook verification failed: ${sanitizeError(err)}`, 400)
  }

  // Extract entity ID from the event data object
  const account = (event as unknown as { account?: string }).account
  const dataObj = event.data.object as unknown as Record<string, unknown>
  const entityId = (dataObj.id as string) || event.id

  console.log(`[webhook] ${event.type} ${event.id}${account ? ` account=${account}` : ''}`)

  // Emit normalized event to EVENTS pipeline
  const ns = account || 'default'
  const normalized = buildStripeEvent({
    ns,
    stripeEventType: event.type,
    stripeEventId: event.id,
    entityId,
    payload: dataObj,
    account: account || undefined,
  })

  if (env.EVENTS) {
    await emitStripeEvents([normalized], env.EVENTS)
  }

  // The vin settlement leg (PW-5 step 2 / vin-zik): a PAID vin-estate checkout
  // session forwards a compact settlement confirmation — Checkout Session id
  // as order_id, PaymentIntent id as settlement_ref (vin ledger-events §4.4)
  // — to VIN_SETTLE_URL. Unset URL → skip (the events pipeline above still
  // carries the raw Stripe event); configured but failing → 500 so Stripe
  // redelivers (at-least-once; the estate dedupes by order_id).
  if (event.type === 'checkout.session.completed') {
    const settlement = vinSettlementFromSession(dataObj, event.livemode)
    if (settlement) {
      const forward = await forwardVinSettlement(settlement, {
        url: env.VIN_SETTLE_URL,
        token: env.VIN_SETTLE_TOKEN,
      })
      if (env.VIN_SETTLE_URL && !forward.forwarded) {
        console.log(`[webhook] vin settlement forward failed (${forward.status ?? forward.reason}) — answering 500 so Stripe redelivers`)
        return error('vin settlement forward failed — Stripe will redeliver', 500)
      }
      return json({
        received: true,
        type: event.type,
        account,
        vin: { order_id: settlement.order_id, settlement_ref: settlement.settlement_ref, forwarded: forward.forwarded },
      })
    }
  }

  return json({ received: true, type: event.type, account })
})

// ---------------------------------------------------------------------------
// Internal RPC entrypoint (service-binding consumers)
// ---------------------------------------------------------------------------

/** Run one operation for an RPC caller; Stripe failures cross the boundary sanitized. */
async function rpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    throw new ops.PaymentsError(sanitizeError(err), stripeErrorStatus(err))
  }
}

/**
 * The surface service-binding consumers call (dot-do/payments.do#2):
 *
 *   { "binding": "PAYMENTS", "service": "payments-do", "entrypoint": "PaymentsInternal" }
 *
 * Only Workers on this Cloudflare account can bind it, so the binding is the
 * authorization boundary — no bearer, and deliberately no `fetch` handler:
 * a consumer holding this binding can call these methods and nothing else.
 * The connected-account pivot is the explicit `stripeAccount` input field;
 * headers never reach this class. Contract: src/rpc-types.ts.
 */
export class PaymentsInternal extends WorkerEntrypoint<Cloudflare.Env> implements PaymentsInternalApi {
  createCustomer(input: CreateCustomerInput): Promise<StripeObjectRef> {
    return rpc(() => ops.createCustomer(input))
  }
  createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionRef> {
    return rpc(() => ops.createSubscription(input))
  }
  getCustomer(input: RetrieveInput): Promise<StripeObjectRef> {
    return rpc(() => ops.getCustomer(input))
  }
  getSubscription(input: RetrieveInput): Promise<SubscriptionRef> {
    return rpc(() => ops.getSubscription(input))
  }
  getInvoice(input: RetrieveInput): Promise<StripeObjectRef> {
    return rpc(() => ops.getInvoice(input))
  }
  getCharge(input: RetrieveInput): Promise<StripeObjectRef> {
    return rpc(() => ops.getCharge(input))
  }
  getProduct(input: RetrieveInput): Promise<StripeObjectRef> {
    return rpc(() => ops.getProduct(input))
  }
  getPrice(input: RetrieveInput): Promise<StripeObjectRef> {
    return rpc(() => ops.getPrice(input))
  }
}

// ---------------------------------------------------------------------------
// Worker entry point (public HTTP surface)
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, envArg: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname

    // Caller auth gate — runs before any route (including the RPC fallback)
    // so nothing below can reach Stripe without a bearer, except the
    // PUBLIC_ROUTES allowlist.
    if (!isPublicRoute(request.method, pathname)) {
      const auth = authenticateCaller(request)
      if (!auth.ok) return unauthorized(auth.code)
    } else if (request.headers.get('Stripe-Account') && !authenticateCaller(request).ok) {
      // Connected-account pivot is for authenticated callers only. Public
      // routes never read it (checkout has no body; the webhook body is a
      // Stripe-signed event), but refuse it here so that stays true if the
      // allowlist ever grows.
      return unauthorized('connect_requires_auth')
    }

    // Try REST routes first
    const matched = matchRoute(request.method, pathname)
    if (matched) {
      try {
        return await matched.handler(request, matched.params)
      } catch (err) {
        if (err instanceof SyntaxError) {
          return error('Invalid JSON in request body', 400)
        }
        return json({ error: sanitizeError(err) }, stripeErrorStatus(err))
      }
    }

    // Fall through to RPC for capnweb protocol clients
    try {
      return await getRpc().fetch(request, envArg, ctx)
    } catch (err) {
      // If Stripe isn't configured, return a helpful error
      if (!env.STRIPE_SECRET_KEY) {
        return error('STRIPE_SECRET_KEY is not configured. Run: wrangler secret put STRIPE_SECRET_KEY', 503)
      }
      return json({ error: sanitizeError(err) }, 500)
    }
  },
}
