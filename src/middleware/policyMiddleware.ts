/**
 * Payment Policy Middleware for x402-starter-kit
 *
 * Provides configurable payment controls that run between payment verification
 * and settlement. Supports per-transaction limits, hourly/daily rate limits,
 * payer allowlists/blocklists, and custom policy functions.
 */

/**
 * Configuration for the payment policy middleware.
 */
export interface PolicyConfig {
  /** Maximum USDC amount allowed per single transaction (e.g., '1.00') */
  maxPerTransaction?: string;
  /** Maximum total USDC amount allowed per payer per hour (e.g., '10.00') */
  maxPerHour?: string;
  /** Maximum total USDC amount allowed per payer per day (e.g., '50.00') */
  maxPerDay?: string;
  /** Allowlist of payer addresses. If set, only these addresses can pay. */
  allowedPayers?: string[];
  /** Blocklist of payer addresses. These addresses are always rejected. */
  blockedPayers?: string[];
  /** Custom policy function for advanced use cases. */
  customPolicy?: (context: PolicyContext) => Promise<PolicyResult> | PolicyResult;
}

/**
 * Context passed to the policy middleware for evaluation.
 */
export interface PolicyContext {
  /** The payer's wallet address */
  payer: string;
  /** The payment amount in atomic units (e.g., micro-USDC) */
  amount: string;
  /** The network identifier (CAIP-2 or legacy format) */
  network: string;
  /** The asset contract address */
  asset: string;
  /** The recipient (merchant) address */
  payTo: string;
  /** Timestamp of the payment request (ms since epoch) */
  timestamp: number;
}

/**
 * Result of a policy evaluation.
 */
export interface PolicyResult {
  /** Whether the payment is allowed */
  allowed: boolean;
  /** Reason for denial (only set when allowed is false) */
  reason?: string;
}

/**
 * A recorded transaction for rate-limiting purposes.
 */
interface TransactionRecord {
  payer: string;
  amount: string;
  timestamp: number;
}

/**
 * Payment policy middleware that evaluates payment requests against
 * configurable rules before settlement proceeds.
 */
export class PaymentPolicyMiddleware {
  private readonly config: PolicyConfig;
  private readonly transactions: TransactionRecord[] = [];
  private readonly normalizedAllowed: string[] | undefined;
  private readonly normalizedBlocked: string[] | undefined;

  constructor(config: PolicyConfig) {
    this.config = config;
    this.normalizedAllowed = config.allowedPayers?.map((a) => a.toLowerCase());
    this.normalizedBlocked = config.blockedPayers?.map((a) => a.toLowerCase());
  }

  /**
   * Evaluate a payment request against all configured policies.
   * Returns { allowed: true } if all checks pass, or { allowed: false, reason }
   * on the first failing check.
   */
  async evaluate(context: PolicyContext): Promise<PolicyResult> {
    const normalizedPayer = context.payer.toLowerCase();

    // 1. Blocklist check
    if (this.normalizedBlocked && this.normalizedBlocked.includes(normalizedPayer)) {
      return { allowed: false, reason: 'Payer address is blocked by policy' };
    }

    // 2. Allowlist check
    if (this.normalizedAllowed && !this.normalizedAllowed.includes(normalizedPayer)) {
      return { allowed: false, reason: 'Payer address is not in the allowed list' };
    }

    // 3. Per-transaction limit
    if (this.config.maxPerTransaction !== undefined) {
      const maxAtomic = usdcToAtomic(this.config.maxPerTransaction);
      if (BigInt(context.amount) > maxAtomic) {
        return {
          allowed: false,
          reason: `Transaction amount exceeds per-transaction limit of ${this.config.maxPerTransaction} USDC`,
        };
      }
    }

    // 4. Hourly rate limit
    if (this.config.maxPerHour !== undefined) {
      const maxAtomic = usdcToAtomic(this.config.maxPerHour);
      const oneHourAgo = context.timestamp - 60 * 60 * 1000;
      const hourlyTotal = this.sumTransactions(normalizedPayer, oneHourAgo);
      if (hourlyTotal + BigInt(context.amount) > maxAtomic) {
        return {
          allowed: false,
          reason: `Payment would exceed hourly limit of ${this.config.maxPerHour} USDC`,
        };
      }
    }

    // 5. Daily rate limit
    if (this.config.maxPerDay !== undefined) {
      const maxAtomic = usdcToAtomic(this.config.maxPerDay);
      const oneDayAgo = context.timestamp - 24 * 60 * 60 * 1000;
      const dailyTotal = this.sumTransactions(normalizedPayer, oneDayAgo);
      if (dailyTotal + BigInt(context.amount) > maxAtomic) {
        return {
          allowed: false,
          reason: `Payment would exceed daily limit of ${this.config.maxPerDay} USDC`,
        };
      }
    }

    // 6. Custom policy
    if (this.config.customPolicy) {
      const customResult = await this.config.customPolicy(context);
      if (!customResult.allowed) {
        return customResult;
      }
    }

    return { allowed: true };
  }

  /**
   * Record a transaction after successful settlement.
   * This updates the internal sliding window used for rate limiting.
   */
  recordTransaction(context: PolicyContext): void {
    this.transactions.push({
      payer: context.payer.toLowerCase(),
      amount: context.amount,
      timestamp: context.timestamp,
    });

    // Prune records older than 24 hours to avoid unbounded growth
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    while (this.transactions.length > 0 && this.transactions[0].timestamp < cutoff) {
      this.transactions.shift();
    }
  }

  /**
   * Sum transaction amounts for a given payer since the specified cutoff time.
   */
  private sumTransactions(normalizedPayer: string, sinceTimestamp: number): bigint {
    let total = BigInt(0);
    for (const record of this.transactions) {
      if (record.payer === normalizedPayer && record.timestamp >= sinceTimestamp) {
        total += BigInt(record.amount);
      }
    }
    return total;
  }
}

/**
 * Convert a human-readable USDC string (e.g., '1.00') to atomic units (micro-USDC).
 * USDC has 6 decimal places.
 */
function usdcToAtomic(usdcString: string): bigint {
  const parts = usdcString.split('.');
  const whole = parts[0];
  const frac = (parts[1] || '').padEnd(6, '0').slice(0, 6);
  return BigInt(whole + frac);
}

/**
 * Factory function to create a configured payment policy middleware instance.
 *
 * @example
 * ```typescript
 * import { createPolicyMiddleware } from './middleware/policyMiddleware.js';
 *
 * const policy = createPolicyMiddleware({
 *   maxPerTransaction: '1.00',   // max 1 USDC per transaction
 *   maxPerHour: '10.00',         // max 10 USDC per hour per payer
 *   maxPerDay: '50.00',          // max 50 USDC per day per payer
 *   blockedPayers: ['0xBAD...'], // block specific addresses
 * });
 * ```
 */
export function createPolicyMiddleware(config: PolicyConfig): PaymentPolicyMiddleware {
  return new PaymentPolicyMiddleware(config);
}
