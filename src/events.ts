// ULID generation (simplified — timestamp + random, Crockford base32)
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function ulid(timestamp = Date.now()): string {
  let t = timestamp
  let timeStr = ''
  for (let i = 0; i < 10; i++) {
    timeStr = ENCODING[t % 32] + timeStr
    t = Math.floor(t / 32)
  }
  let randStr = ''
  for (let i = 0; i < 16; i++) {
    randStr += ENCODING[Math.floor(Math.random() * 32)]
  }
  return timeStr + randStr
}

export interface NormalizedEvent {
  id: string
  ns: string
  type: string
  event: string
  source: string
  data: {
    provider: string
    entity: string
    action: string
    id: string
    eventType: string
    payload: Record<string, unknown>
  }
  actor: Record<string, unknown>
  meta: Record<string, unknown>
}

/**
 * Map Stripe event type (e.g. 'customer.subscription.created') to entity + action.
 * Stripe events follow: {entity}.{action} or {entity}.{sub_entity}.{action}
 */
function parseStripeEventType(eventType: string): { entity: string; action: string } {
  const parts = eventType.split('.')
  if (parts.length >= 3) {
    // e.g. customer.subscription.created → entity=subscription, action=created
    return { entity: parts.slice(0, -1).join('_'), action: parts[parts.length - 1] }
  }
  if (parts.length === 2) {
    return { entity: parts[0], action: parts[1] }
  }
  return { entity: eventType, action: 'unknown' }
}

export function buildStripeEvent(input: {
  ns: string
  stripeEventType: string
  stripeEventId: string
  entityId: string
  payload: Record<string, unknown>
  account?: string
}): NormalizedEvent {
  const { entity, action } = parseStripeEventType(input.stripeEventType)
  return {
    id: ulid(),
    ns: input.ns,
    type: 'webhook',
    event: `stripe.${entity}.${action}`,
    source: 'stripe',
    data: {
      provider: 'stripe',
      entity,
      action,
      id: input.entityId,
      eventType: input.stripeEventType,
      payload: input.payload,
    },
    actor: input.account ? { id: input.account, source: 'stripe' } : {},
    meta: {},
  }
}

export function buildImportEvent(input: {
  ns: string
  entityType: string
  entityId: string
  payload: Record<string, unknown>
}): NormalizedEvent {
  return {
    id: ulid(),
    ns: input.ns,
    type: 'webhook',
    event: `stripe.${input.entityType}.imported`,
    source: 'stripe',
    data: {
      provider: 'stripe',
      entity: input.entityType,
      action: 'imported',
      id: input.entityId,
      eventType: 'import',
      payload: input.payload,
    },
    actor: {},
    meta: {},
  }
}

/**
 * Emit a batch of normalized events to the EVENTS service binding.
 * Catches errors — event emission should not break the caller.
 */
export async function emitStripeEvents(events: NormalizedEvent[], eventsBinding: unknown): Promise<void> {
  if (!events.length) return
  try {
    const svc = eventsBinding as { ingest: (events: Array<Record<string, unknown>>) => Promise<void> }
    await svc.ingest(events as unknown as Array<Record<string, unknown>>)
  } catch (err) {
    console.error('[payments.do] Failed to emit events:', err)
  }
}
