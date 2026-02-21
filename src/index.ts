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
 * Stripe Connect multi-tenant scoping:
 *   All endpoints accept a `Stripe-Account` header (or `stripeAccount` field in
 *   request body) to scope API calls to a connected account. This enables
 *   per-tenant billing where each tenant has their own Stripe account linked
 *   via Stripe Connect.
 *
 * Capnweb RPC clients (e.g. `payments.do` SDK) use the RPC fallback.
 */

import Stripe from 'stripe'
import { env } from 'cloudflare:workers'
import { RPC } from 'rpc.do'

// ---------------------------------------------------------------------------
// Lazy Stripe + RPC init
// ---------------------------------------------------------------------------

let _stripe: Stripe | null = null
let _rpc: ReturnType<typeof RPC> | null = null

function getStripe(): Stripe {
  if (!_stripe) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured. Run: wrangler secret put STRIPE_SECRET_KEY')
    }
    _stripe = new Stripe(env.STRIPE_SECRET_KEY)
  }
  return _stripe
}

function getRpc(): ReturnType<typeof RPC> {
  if (!_rpc) {
    _rpc = RPC(getStripe())
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

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message
    .replace(/sk_\S+/gi, '[REDACTED]')
    .replace(/whsec_\S+/gi, '[REDACTED]')
    .replace(/acct_\S+/gi, '[ACCT_REDACTED]')
    .slice(0, 200)
}

function stripeErrorStatus(err: unknown): number {
  if (err instanceof Stripe.errors.StripeError) {
    if (err.type === 'StripeCardError') return 400
    if (err.type === 'StripeInvalidRequestError') return 400
    if (err.type === 'StripeAuthenticationError') return 401
    if (err.type === 'StripeRateLimitError') return 429
  }
  return 500
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
function getConnectOptions(request: Request, body?: Record<string, unknown>): Stripe.RequestOptions | undefined {
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
      webhooks: 'POST /webhooks',
    },
  })
})

// --- Customers ---

route('POST', '/customers', async (request) => {
  const body = await parseBody<{ email?: string; name?: string; metadata?: Record<string, string>; stripeAccount?: string }>(request)
  const opts = getConnectOptions(request, body)
  const customer = await getStripe().customers.create(stripConnectField(body), opts)
  return json(customer, 201)
})

route('GET', '/customers/:id', async (request, params) => {
  const opts = getConnectOptions(request)
  const customer = await getStripe().customers.retrieve(params.id, opts)
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
  const body = await parseBody<{ customer: string; items: Array<{ price: string }>; metadata?: Record<string, string>; stripeAccount?: string }>(request)
  const opts = getConnectOptions(request, body)
  const subscription = await getStripe().subscriptions.create(stripConnectField(body), opts)
  return json(subscription, 201)
})

route('GET', '/subscriptions/:id', async (request, params) => {
  const opts = getConnectOptions(request)
  const subscription = await getStripe().subscriptions.retrieve(params.id, opts)
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
  const opts = getConnectOptions(request)
  const charge = await getStripe().charges.retrieve(params.id, opts)
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
  const opts = getConnectOptions(request)
  const invoice = await getStripe().invoices.retrieve(params.id, opts)
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
  const product = await getStripe().products.create(stripConnectField(body) as Stripe.ProductCreateParams, opts)
  return json(product, 201)
})

route('GET', '/products/:id', async (request, params) => {
  const opts = getConnectOptions(request)
  const product = await getStripe().products.retrieve(params.id, opts)
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
  const price = await getStripe().prices.create(stripConnectField(body) as Stripe.PriceCreateParams, opts)
  return json(price, 201)
})

route('GET', '/prices/:id', async (request, params) => {
  const opts = getConnectOptions(request)
  const price = await getStripe().prices.retrieve(params.id, opts)
  return json(price)
})

// --- Refunds ---

route('POST', '/refunds', async (request) => {
  const body = await parseBody<{ payment_intent?: string; charge?: string; amount?: number; reason?: string; stripeAccount?: string }>(request)
  const opts = getConnectOptions(request, body)
  const refund = await getStripe().refunds.create(stripConnectField(body) as Stripe.RefundCreateParams, opts)
  return json(refund, 201)
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

  // Log the event — include connected account if present
  const account = (event as unknown as { account?: string }).account
  console.log(`[webhook] ${event.type} ${event.id}${account ? ` account=${account}` : ''}`)

  return json({ received: true, type: event.type, account })
})

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, envArg: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname

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
