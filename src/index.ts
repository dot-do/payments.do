/**
 * @dotdo/worker-stripe - Stripe SDK as RPC worker
 *
 * Exposes Stripe via multi-transport RPC:
 * - Workers RPC: env.PAYMENTS.fetch('/api/customers.create', ...)
 * - REST: POST /api/customers.create
 * - CapnWeb: WebSocket RPC
 * - MCP: JSON-RPC 2.0
 *
 * Stripe SDK is lazy-initialized on first request so the worker
 * can be deployed before STRIPE_SECRET_KEY secret is configured.
 */

import Stripe from 'stripe'
import { env } from 'cloudflare:workers'
import { RPC } from 'rpc.do'

let _handler: ReturnType<typeof RPC> | null = null

function getHandler() {
  if (!_handler) {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY)
    _handler = RPC(stripe)
  }
  return _handler
}

export default {
  async fetch(request: Request, envArg: unknown, ctx: ExecutionContext): Promise<Response> {
    return getHandler().fetch(request, envArg, ctx)
  },
}
