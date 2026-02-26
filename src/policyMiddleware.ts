/**
 * Payment Policy Middleware for x402
 *
 * Provides configurable payment controls that run between payment verification
 * and settlement. Supports per-transaction limits, daily budgets, recipient
 * whitelisting, and rate limiting.
 *
 * Usage:
 *   import { createPolicyMiddleware } from './policyMiddleware.js';
 *
 *   const policy = createPolicyMiddleware({
 *     maxPerTransaction: '1.00',
 *     dailyBudget: '50.00',
 *     allowedRecipients: ['0x...'],
 *     rateLimitPerMinute: 10,
 *   });
 *
 *   // In your payment flow, after verification:
 *   const result = await policy.evaluate({ amount, recipient, payer, network, asset });
 *   if (!result.allowed) {
 *     // reject payment
 *   }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Human-readable USDC amount string, e.g. "1.00" */
type UsdcAmount = string;

/**
 * Configuration accepted by {@link createPolicyMiddleware}.
 */
export interface PolicyConfig {
  /** Maximum USDC amount per single transaction (human-readable, e.g. "1.00"). */
  maxPerTransaction?: UsdcAmount;

  /** Maximum total USDC that may be spent in a rolling 24-hour window. */
  dailyBudget?: UsdcAmount;

  /** If set, only these recipient addresses are allowed (case-insensitive). */
  allowedRecipients?: string[];

  /** Maximum number of transactions allowed per minute. */
  rateLimitPerMinute?: number;

  /**
   * Optional custom policy function.  Receives the request context and must
   * return `true` (allow) or `false` (deny).  May be async.
   */
  customPolicy?: (request: PolicyRequest) => boolean | Promise<boolean>;

  /**
   * Override the default in-memory store with a custom implementation
   * (e.g. backed by Redis).
   */
  store?: PolicyStore;
}

/**
 * Data provided to each policy evaluation.
 */
export interface PolicyRequest {
  /** Atomic (on-chain) amount as a string, e.g. "100000" for 0.10 USDC. */
  amount: string;
  /** Recipient (payTo) address. */
  recipient: string;
  /** Payer address (may be empty if unknown). */
  payer?: string;
  /** Network identifier (CAIP-2 or legacy name). */
  network: string;
  /** Asset contract address. */
  asset: string;
}

/**
 * Result returned by a policy evaluation.
 */
export interface PolicyResult {
  /** Whether the payment is allowed to proceed. */
  allowed: boolean;
  /** Human-readable reason when the payment is denied. */
  reason?: string;
}

/**
 * Pluggable store interface for stateful policies (daily budget, rate limit).
 * The default implementation is {@link InMemoryPolicyStore}.
 */
export interface PolicyStore {
  /**
   * Record that a transaction of `amount` (atomic units) occurred at
   * `timestamp` (epoch ms).
   */
  recordTransaction(amount: string, timestamp: number): Promise<void>;

  /** Return the sum of all recorded amounts in the last `windowMs` ms. */
  getTotalInWindow(windowMs: number): Promise<string>;

  /** Return the count of transactions in the last `windowMs` ms. */
  getCountInWindow(windowMs: number): Promise<number>;

  /** Clear all recorded data. */
  reset(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The public handle returned by createPolicyMiddleware
// ---------------------------------------------------------------------------

export interface PolicyMiddleware {
  /** Evaluate a payment request against all configured policies. */
  evaluate(request: PolicyRequest): Promise<PolicyResult>;

  /**
   * Record a transaction after it has been settled so that stateful policies
   * (daily budget, rate limit) are kept up-to-date.
   */
  recordTransaction(request: PolicyRequest): Promise<void>;

  /** Reset the internal store (useful for testing). */
  resetStore(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USDC_DECIMALS = 6;
const ONE_MINUTE_MS = 60_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a human-readable USDC string ("1.00") to atomic units ("1000000").
 */
export function toAtomicUnits(human: string): bigint {
  const parts = human.split('.');
  const whole = parts[0] ?? '0';
  let frac = parts[1] ?? '';
  // Pad / truncate fractional part to USDC_DECIMALS digits
  frac = frac.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS);
  return BigInt(whole) * BigInt(10 ** USDC_DECIMALS) + BigInt(frac);
}

/**
 * Convert atomic units to a human-readable USDC string.
 */
export function fromAtomicUnits(atomic: string): string {
  const val = BigInt(atomic);
  const divisor = BigInt(10 ** USDC_DECIMALS);
  const whole = val / divisor;
  const frac = val % divisor;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0');
  return `${whole}.${fracStr}`;
}

// ---------------------------------------------------------------------------
// InMemoryPolicyStore
// ---------------------------------------------------------------------------

interface TxRecord {
  amount: string;
  timestamp: number;
}

/**
 * Simple in-memory store suitable for single-process starter deployments.
 * For production, implement {@link PolicyStore} backed by Redis or similar.
 */
export class InMemoryPolicyStore implements PolicyStore {
  private records: TxRecord[] = [];

  async recordTransaction(amount: string, timestamp: number): Promise<void> {
    this.records.push({ amount, timestamp });
    // Prune records older than 24 h to avoid unbounded growth
    const cutoff = timestamp - ONE_DAY_MS;
    this.records = this.records.filter((r) => r.timestamp >= cutoff);
  }

  async getTotalInWindow(windowMs: number): Promise<string> {
    const cutoff = Date.now() - windowMs;
    let total = BigInt(0);
    for (const r of this.records) {
      if (r.timestamp >= cutoff) {
        total += BigInt(r.amount);
      }
    }
    return total.toString();
  }

  async getCountInWindow(windowMs: number): Promise<number> {
    const cutoff = Date.now() - windowMs;
    return this.records.filter((r) => r.timestamp >= cutoff).length;
  }

  async reset(): Promise<void> {
    this.records = [];
  }
}

// ---------------------------------------------------------------------------
// createPolicyMiddleware
// ---------------------------------------------------------------------------

/**
 * Create a {@link PolicyMiddleware} instance from the given configuration.
 *
 * All policy checks run in order; the first violation short-circuits and the
 * payment is denied.  If any policy check throws, the payment is **denied**
 * (fail-closed).
 *
 * @example
 * ```ts
 * const policy = createPolicyMiddleware({
 *   maxPerTransaction: '1.00',
 *   dailyBudget: '50.00',
 *   allowedRecipients: ['0xabc...'],
 *   rateLimitPerMinute: 10,
 * });
 * ```
 */
export function createPolicyMiddleware(config: PolicyConfig): PolicyMiddleware {
  const store: PolicyStore = config.store ?? new InMemoryPolicyStore();

  async function evaluate(request: PolicyRequest): Promise<PolicyResult> {
    try {
      // 1. Allowed recipients check
      if (config.allowedRecipients && config.allowedRecipients.length > 0) {
        const normalised = config.allowedRecipients.map((a) => a.toLowerCase());
        if (!normalised.includes(request.recipient.toLowerCase())) {
          return {
            allowed: false,
            reason: `Recipient ${request.recipient} is not in the allowed recipients list`,
          };
        }
      }

      // 2. Max per transaction check
      if (config.maxPerTransaction !== undefined) {
        const maxAtomic = toAtomicUnits(config.maxPerTransaction);
        const requestAtomic = BigInt(request.amount);
        if (requestAtomic > maxAtomic) {
          return {
            allowed: false,
            reason: `Transaction amount ${fromAtomicUnits(request.amount)} USDC exceeds per-transaction limit of ${config.maxPerTransaction} USDC`,
          };
        }
      }

      // 3. Rate limit check
      if (config.rateLimitPerMinute !== undefined) {
        const count = await store.getCountInWindow(ONE_MINUTE_MS);
        if (count >= config.rateLimitPerMinute) {
          return {
            allowed: false,
            reason: `Rate limit exceeded: ${count} transactions in the last minute (limit: ${config.rateLimitPerMinute})`,
          };
        }
      }

      // 4. Daily budget check
      if (config.dailyBudget !== undefined) {
        const budgetAtomic = toAtomicUnits(config.dailyBudget);
        const spentStr = await store.getTotalInWindow(ONE_DAY_MS);
        const spent = BigInt(spentStr);
        const requestAtomic = BigInt(request.amount);
        if (spent + requestAtomic > budgetAtomic) {
          return {
            allowed: false,
            reason: `Daily budget exceeded: already spent ${fromAtomicUnits(spentStr)} USDC of ${config.dailyBudget} USDC daily limit`,
          };
        }
      }

      // 5. Custom policy check
      if (config.customPolicy) {
        const allowed = await config.customPolicy(request);
        if (!allowed) {
          return {
            allowed: false,
            reason: 'Denied by custom policy',
          };
        }
      }

      return { allowed: true };
    } catch (error) {
      // Fail-closed: if any policy check errors, deny the payment
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        allowed: false,
        reason: `Policy evaluation error (defaulting to deny): ${message}`,
      };
    }
  }

  async function recordTransaction(request: PolicyRequest): Promise<void> {
    await store.recordTransaction(request.amount, Date.now());
  }

  async function resetStore(): Promise<void> {
    await store.reset();
  }

  return { evaluate, recordTransaction, resetStore };
}
