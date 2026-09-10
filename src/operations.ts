/**
 * Stripe operations shared by the public REST surface and the
 * `PaymentsInternal` RPC entrypoint (both in src/index.ts). Each Stripe call
 * lives here exactly once; the two entry points differ only in how a caller
 * reaches it and how the connected-account pivot arrives (REST: header or
 * body field, gated; RPC: the explicit `stripeAccount` input field).
 */

import Stripe from 'stripe'
import { env } from 'cloudflare:workers'
import type { ConnectScope, CreateCustomerInput, CreateSubscriptionInput, RetrieveInput } from './rpc-types'

// ---------------------------------------------------------------------------
// Lazy Stripe init
// ---------------------------------------------------------------------------

let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!_stripe) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured. Run: wrangler secret put STRIPE_SECRET_KEY')
    }
    _stripe = new Stripe(env.STRIPE_SECRET_KEY)
  }
  return _stripe
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message
    .replace(/sk_\S+/gi, '[REDACTED]')
    .replace(/whsec_\S+/gi, '[REDACTED]')
    .replace(/acct_\S+/gi, '[ACCT_REDACTED]')
    .slice(0, 200)
}

export function stripeErrorStatus(err: unknown): number {
  if (err instanceof Stripe.errors.StripeError) {
    if (err.type === 'StripeCardError') return 400
    if (err.type === 'StripeInvalidRequestError') return 400
    if (err.type === 'StripeAuthenticationError') return 401
    if (err.type === 'StripeRateLimitError') return 429
  }
  return 500
}

/**
 * What an RPC caller sees when Stripe refuses: the sanitized message (no
 * secret key, webhook secret or account id) and the HTTP status the REST
 * surface would have answered with. Only `name` and `message` survive the
 * RPC boundary; `status` is for in-process callers.
 */
export class PaymentsError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'PaymentsError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Connected-account pivot as an explicit argument — never read from a header here. */
function requestOptions({ stripeAccount }: ConnectScope): Stripe.RequestOptions | undefined {
  return stripeAccount ? { stripeAccount } : undefined
}

export async function createCustomer(input: CreateCustomerInput): Promise<Stripe.Customer> {
  const { stripeAccount, ...params } = input
  return getStripe().customers.create(params, requestOptions({ stripeAccount }))
}

export async function createSubscription(input: CreateSubscriptionInput): Promise<Stripe.Subscription> {
  const { stripeAccount, ...params } = input
  return getStripe().subscriptions.create(params, requestOptions({ stripeAccount }))
}

export async function getCustomer({ id, ...scope }: RetrieveInput): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
  return getStripe().customers.retrieve(id, requestOptions(scope))
}

export async function getSubscription({ id, ...scope }: RetrieveInput): Promise<Stripe.Subscription> {
  return getStripe().subscriptions.retrieve(id, requestOptions(scope))
}

export async function getInvoice({ id, ...scope }: RetrieveInput): Promise<Stripe.Invoice> {
  return getStripe().invoices.retrieve(id, requestOptions(scope))
}

export async function getCharge({ id, ...scope }: RetrieveInput): Promise<Stripe.Charge> {
  return getStripe().charges.retrieve(id, requestOptions(scope))
}

export async function getProduct({ id, ...scope }: RetrieveInput): Promise<Stripe.Product> {
  return getStripe().products.retrieve(id, requestOptions(scope))
}

export async function getPrice({ id, ...scope }: RetrieveInput): Promise<Stripe.Price> {
  return getStripe().prices.retrieve(id, requestOptions(scope))
}
