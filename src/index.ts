/**
 * payments.do — Stripe as a managed .do service
 *
 * REST API for service binding consumers (e.g. db.headless.ly integration dispatch):
 *   POST /customers          → stripe.customers.create()
 *   GET  /customers/:id      → stripe.customers.retrieve()
 *   POST /subscriptions      → stripe.subscriptions.create()
 *   GET  /subscriptions/:id  → stripe.subscriptions.retrieve()
 *   DELETE /subscriptions/:id → stripe.subscriptions.cancel()
 *   POST /charges            → stripe.charges.create()
 *   POST /webhooks           → Stripe webhook verification + processing
 *   GET  /                   → Health check / discovery
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
      r.paramNames.forEach((name, i) => { params[name] = match[i + 1] })
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
    version: '0.1.0',
    status: hasKey ? 'ready' : 'unconfigured',
    endpoints: {
      customers: { create: 'POST /customers', retrieve: 'GET /customers/:id' },
      subscriptions: { create: 'POST /subscriptions', retrieve: 'GET /subscriptions/:id', cancel: 'DELETE /subscriptions/:id' },
      charges: { create: 'POST /charges', retrieve: 'GET /charges/:id' },
      webhooks: 'POST /webhooks',
    },
  })
})

// --- Customers ---

route('POST', '/customers', async (request) => {
  const body = await parseBody<{ email?: string; name?: string; metadata?: Record<string, string> }>(request)
  const customer = await getStripe().customers.create(body)
  return json(customer, 201)
})

route('GET', '/customers/:id', async (_request, params) => {
  const customer = await getStripe().customers.retrieve(params.id)
  return json(customer)
})

// --- Subscriptions ---

route('POST', '/subscriptions', async (request) => {
  const body = await parseBody<{ customer: string; items: Array<{ price: string }>; metadata?: Record<string, string> }>(request)
  const subscription = await getStripe().subscriptions.create(body)
  return json(subscription, 201)
})

route('GET', '/subscriptions/:id', async (_request, params) => {
  const subscription = await getStripe().subscriptions.retrieve(params.id)
  return json(subscription)
})

route('DELETE', '/subscriptions/:id', async (_request, params) => {
  const subscription = await getStripe().subscriptions.cancel(params.id)
  return json(subscription)
})

// --- Charges ---

route('POST', '/charges', async (request) => {
  const body = await parseBody<{ amount: number; currency: string; customer?: string; description?: string; metadata?: Record<string, string> }>(request)
  const charge = await getStripe().charges.create(body)
  return json(charge, 201)
})

route('GET', '/charges/:id', async (_request, params) => {
  const charge = await getStripe().charges.retrieve(params.id)
  return json(charge)
})

// --- Invoices ---

route('POST', '/invoices', async (request) => {
  const body = await parseBody<Record<string, unknown>>(request)
  const invoice = await getStripe().invoices.create(body as Stripe.InvoiceCreateParams)
  return json(invoice, 201)
})

route('GET', '/invoices/:id', async (_request, params) => {
  const invoice = await getStripe().invoices.retrieve(params.id)
  return json(invoice)
})

// --- Products ---

route('POST', '/products', async (request) => {
  const body = await parseBody<Record<string, unknown>>(request)
  const product = await getStripe().products.create(body as Stripe.ProductCreateParams)
  return json(product, 201)
})

route('GET', '/products/:id', async (_request, params) => {
  const product = await getStripe().products.retrieve(params.id)
  return json(product)
})

// --- Prices ---

route('POST', '/prices', async (request) => {
  const body = await parseBody<Record<string, unknown>>(request)
  const price = await getStripe().prices.create(body as Stripe.PriceCreateParams)
  return json(price, 201)
})

route('GET', '/prices/:id', async (_request, params) => {
  const price = await getStripe().prices.retrieve(params.id)
  return json(price)
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

  // Log the event (could forward to events.do in the future)
  console.log(`[webhook] ${event.type} ${event.id}`)

  return json({ received: true, type: event.type })
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
