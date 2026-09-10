# payments.do

Stripe Connect as a managed .do service. Part of the dot-do ecosystem.

## Architecture

- `src/index.ts` — RPC worker entry (wraps Stripe SDK via @dotdo/rpc)
- `src/stripe.ts` — StripeDO Durable Object (charges, subscriptions, usage, transfers, webhooks)
- `src/sdk.ts` — Client SDK (`import { payments } from 'payments.do'`)
- `test/` — Vitest tests for each Stripe module

## Commands

```bash
pnpm dev          # Local dev (wrangler dev)
pnpm deploy       # Deploy to Cloudflare
pnpm test         # Run tests
pnpm typecheck    # Type check
```

## Service Binding

Other workers bind the `PaymentsInternal` Workers RPC entrypoint
(`src/index.ts`; contract in `src/rpc-types.ts`, copy it into the consumer):
```jsonc
{ "binding": "PAYMENTS", "service": "payments-do", "entrypoint": "PaymentsInternal" }
```

Usage: `await env.PAYMENTS.createSubscription({ customer: 'cus_123', items: [{ price: 'price_123' }] })`

The binding is the authorization boundary: only Workers on this account can
hold it, the entrypoint has no `fetch` handler and no bearer, and the
connected-account pivot is the explicit `stripeAccount` input field — never a
header. Deploy this worker before any consumer that binds the entrypoint.

The REST pass-through routes remain on the default export behind the bearer
gate (see "Caller auth" below) with `PAYMENTS_API_TOKEN` deliberately unset,
so from the public hostname only `POST /webhooks` and `GET /checkout` answer.

## SDK Usage

```typescript
import { payments } from 'payments.do'
await payments.charges.create({ amount: 2000, currency: 'usd', customer: 'cus_123' })
```

## Vin estate checkout (PW-5)

`GET /checkout?sku=…&vin=…&door=…&return_to=…` is the vin estate's thin
first-dollar front (`src/checkout.ts`): closed SKU table → Stripe Checkout
Session → 303. `POST /webhooks` forwards PAID vin sessions (metadata
`estate: "vin"`) to `VIN_SETTLE_URL` with the PaymentIntent id as
`settlement_ref`; a configured-but-failed forward answers 500 so Stripe
redelivers.

## Caller auth (payments.do#2)

`src/index.ts` gates every request before route matching. The public
allowlist is exactly `POST /webhooks` (Stripe-Signature verified) and
`GET /checkout` (buyer browser navigation). Everything else — every Stripe
pass-through route, `GET /`, `POST /import`, the RPC fallback — answers
`401 { "error": "unauthorized", "code": … }` unless the request carries
`Authorization: Bearer <PAYMENTS_API_TOKEN>` (constant-time compared).
The token is deliberately never configured, so those routes are 401 for
everyone; the gate stays so that state is fail-closed rather than absent.

- `PAYMENTS_API_TOKEN` unset → fail closed: 401 on every gated route, logged once.
- The Stripe Connect pivot (`Stripe-Account` header / `stripeAccount` body
  field) is honored only for authenticated callers; an unauthenticated
  request carrying `Stripe-Account` is refused even on a public route.

Rollout: `wrangler secret put PAYMENTS_API_TOKEN` → give the same value to
each consumer that binds `payments-do` and have it send the header →
deploy this worker → verify (`curl -i https://payments.do/` is 401;
with the bearer it is 200).

## Secrets

- `STRIPE_SECRET_KEY` — Stripe API key (required; founder act)
- `STRIPE_WEBHOOK_SECRET` — webhook signing secret (required for /webhooks; founder act)
- `VIN_SETTLE_TOKEN` — bearer for the vin settlement forward (optional; founder act)
- `PAYMENTS_API_TOKEN` — inbound caller bearer for every gated route (required; founder act; unset → 401 everywhere except /webhooks and /checkout)
