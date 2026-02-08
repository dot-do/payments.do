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

## Secrets

- `STRIPE_SECRET_KEY` — Stripe API key (required)
