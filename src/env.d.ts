/**
 * Worker environment for payments.do (augments Cloudflare.Env, which is what
 * `import { env } from 'cloudflare:workers'` is typed as).
 *
 * Secrets — set by the FOUNDER on the deployed Worker, never committed:
 *   wrangler secret put STRIPE_SECRET_KEY       (PW-5 step 1)
 *   wrangler secret put STRIPE_WEBHOOK_SECRET   (PW-5 step 1)
 *   wrangler secret put VIN_SETTLE_TOKEN        (bearer for the vin ledger confirm forward)
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
    }
  }
}
