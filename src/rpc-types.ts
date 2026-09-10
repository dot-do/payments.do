/**
 * Contract of the `PaymentsInternal` Workers RPC entrypoint (src/index.ts).
 *
 * Deliberately dependency-free so a consumer that does not link this package
 * can copy the file verbatim (headless.ly does) and type its binding as
 * `Service<PaymentsInternalApi>`. Return types name only the fields a consumer
 * relies on; the full Stripe object is what crosses the wire at runtime.
 *
 * The connected-account pivot is the explicit `stripeAccount` field on every
 * input — it is never read from a header on this surface.
 */

/** Stripe Connect scoping. Omit `stripeAccount` to act on the platform account. */
export interface ConnectScope {
  stripeAccount?: string
}

export interface CreateCustomerInput extends ConnectScope {
  email?: string
  name?: string
  metadata?: Record<string, string>
}

export interface CreateSubscriptionInput extends ConnectScope {
  customer: string
  items: Array<{ price: string }>
  metadata?: Record<string, string>
}

export interface RetrieveInput extends ConnectScope {
  id: string
}

/** The subset of any Stripe object every consumer can rely on. */
export interface StripeObjectRef {
  id: string
  object: string
}

export interface SubscriptionRef extends StripeObjectRef {
  status: string
}

/** One method per operation the service-binding consumers perform. */
export interface PaymentsInternalApi {
  createCustomer(input: CreateCustomerInput): Promise<StripeObjectRef>
  createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionRef>
  getCustomer(input: RetrieveInput): Promise<StripeObjectRef>
  getSubscription(input: RetrieveInput): Promise<SubscriptionRef>
  getInvoice(input: RetrieveInput): Promise<StripeObjectRef>
  getCharge(input: RetrieveInput): Promise<StripeObjectRef>
  getProduct(input: RetrieveInput): Promise<StripeObjectRef>
  getPrice(input: RetrieveInput): Promise<StripeObjectRef>
}
