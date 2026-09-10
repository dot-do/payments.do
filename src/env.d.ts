/**
 * Worker environment for payments.do (augments Cloudflare.Env, which is what
 * `import { env } from 'cloudflare:workers'` is typed as).
 *
 * Secrets — set by the FOUNDER on the deployed Worker, never committed:
 *   wrangler secret put STRIPE_SECRET_KEY       (PW-5 step 1)
 *   wrangler secret put STRIPE_WEBHOOK_SECRET   (PW-5 step 1)
 *   wrangler secret put VIN_SETTLE_TOKEN        (bearer for the vin ledger confirm forward)
 *
 * Deliberately NOT set: PAYMENTS_API_TOKEN. Unset, every REST route outside
 * the public allowlist answers 401, which is the intended permanent state —
 * consumers use the `PaymentsInternal` RPC entrypoint over a service binding
 * (src/rpc-types.ts) instead of HTTP (payments.do#2).
 *
 * Vars (wrangler.jsonc):
 *   VIN_SETTLE_URL — the vin estate settlement-confirm endpoint the webhook
 *   forwards vin checkout settlements to; unset → forward is skipped (logged).
 */
export {}

declare global {
  namespace Cloudflare {
    interface Env {
      /** Stripe platform secret key (secret; founder act). */
      STRIPE_SECRET_KEY?: string
      /** Stripe webhook signing secret (secret; founder act). */
      STRIPE_WEBHOOK_SECRET?: string
      /** Events pipeline service binding (wrangler.jsonc `services`). */
      EVENTS?: unknown
      /** Vin estate settlement-confirm endpoint (var; unset → skip forward). */
      VIN_SETTLE_URL?: string
      /** Bearer token for the vin settlement forward (secret; founder act). */
      VIN_SETTLE_TOKEN?: string
      /**
       * Inbound caller bearer for the REST pass-through routes. Deliberately
       * unset (fail closed, 401): consumers call the `PaymentsInternal` RPC
       * entrypoint over a service binding instead. Kept only so the gate in
       * src/index.ts stays fail-closed rather than absent.
       */
      PAYMENTS_API_TOKEN?: string
    }
  }
}
