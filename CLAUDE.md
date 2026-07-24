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

Other workers bind to this service:
```jsonc
{ "binding": "PAYMENTS", "service": "payments-do" }
```

Usage: `await env.PAYMENTS.charges.create({ amount, currency, customer })`

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

## Secrets

- `STRIPE_SECRET_KEY` — Stripe API key (required; founder act)
- `STRIPE_WEBHOOK_SECRET` — webhook signing secret (required for /webhooks; founder act)
- `VIN_SETTLE_TOKEN` — bearer for the vin settlement forward (optional; founder act)
