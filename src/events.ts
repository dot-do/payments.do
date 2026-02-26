import { ulid, emitEvents, type NormalizedEvent } from '@dotdo/events-sdk'

export type { NormalizedEvent }

/**
 * Map Stripe event type (e.g. 'customer.subscription.created') to entity + action.
 * Stripe events follow: {entity}.{action} or {entity}.{sub_entity}.{action}
 */
export function parseStripeEventType(eventType: string): { entity: string; action: string } {
  const parts = eventType.split('.')
  if (parts.length >= 3) {
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

export async function emitStripeEvents(events: NormalizedEvent[], eventsBinding: unknown): Promise<void> {
  return emitEvents(events, eventsBinding, 'payments.do')
}
