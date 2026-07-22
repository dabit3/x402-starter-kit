/**
 * Env-gated payment bounds checked before facilitator verify/settle.
 * Unset config → no bounds (prior behavior). No third-party brand deps.
 */

export type PaymentBoundsConfig = {
  /** Max amount in atomic units (e.g. USDC micro-units). */
  maxPaymentAmount?: bigint;
  /** If non-empty, network must be listed (exact match after trim). */
  networkAllowlist?: string[];
  /**
   * Expected merchant payTo. When enforcePayToMatch is true and payload
   * includes payTo, it must match (EVM addresses compared case-insensitively).
   */
  expectedPayTo?: string;
  /** When true, reject payload payTo mismatch vs expectedPayTo/merchant. */
  enforcePayToMatch?: boolean;
};

export type PaymentBoundFields = {
  amount?: string;
  payTo?: string;
  network?: string;
};

export type PaymentBoundsFailure = {
  ok: false;
  reason: string;
};

export type PaymentBoundsSuccess = { ok: true };

export type PaymentBoundsResult = PaymentBoundsSuccess | PaymentBoundsFailure;

function splitCsv(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAtomicAmount(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw === '') return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  try {
    return BigInt(trimmed);
  } catch {
    return undefined;
  }
}

/** Normalize EVM 0x addresses for comparison; leave other formats as-is. */
export function normalizePayTo(payTo: string): string {
  if (payTo.startsWith('0x') || payTo.startsWith('0X')) {
    return payTo.toLowerCase();
  }
  return payTo;
}

/**
 * Parse bounds from process env.
 * Returns null when no bound knobs are set — PAY_TO_ADDRESS alone does not
 * enable bounds (server always requires it; prior verify/settle path preserved).
 */
export function parsePaymentBoundsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  defaults?: { expectedPayTo?: string }
): PaymentBoundsConfig | null {
  const maxRaw = env.MAX_PAYMENT_AMOUNT?.trim();
  let maxPaymentAmount: bigint | undefined;
  if (maxRaw) {
    maxPaymentAmount = parseAtomicAmount(maxRaw);
    if (maxPaymentAmount === undefined) {
      throw new Error(
        `MAX_PAYMENT_AMOUNT must be a non-negative integer (atomic units), got: ${maxRaw}`
      );
    }
  }

  const networkAllowlist = splitCsv(env.NETWORK_ALLOWLIST);
  const expectedPayTo =
    env.PAY_TO_ADDRESS?.trim() || defaults?.expectedPayTo?.trim() || undefined;

  const enforceExplicitTrue = env.ENFORCE_PAYTO_MATCH === 'true';
  const enforceExplicitFalse = env.ENFORCE_PAYTO_MATCH === 'false';

  const hasMax = maxPaymentAmount !== undefined;
  const hasNet = networkAllowlist.length > 0;

  if (!hasMax && !hasNet && !enforceExplicitTrue) {
    return null;
  }

  return {
    maxPaymentAmount,
    networkAllowlist: hasNet ? networkAllowlist : undefined,
    expectedPayTo,
    enforcePayToMatch: enforceExplicitFalse
      ? false
      : enforceExplicitTrue || hasMax || hasNet,
  };
}

/**
 * Evaluate amount / network / payTo bounds against merchant + optional payload fields.
 * Prefer merchant requirements for amount/network; use payload payTo when present.
 */
export function evaluatePaymentBounds(
  config: PaymentBoundsConfig,
  merchant: PaymentBoundFields,
  payload?: PaymentBoundFields
): PaymentBoundsResult {
  const amount = merchant.amount ?? payload?.amount;
  const network = merchant.network ?? payload?.network;
  const payloadPayTo = payload?.payTo;
  const merchantPayTo = merchant.payTo ?? config.expectedPayTo;

  if (config.maxPaymentAmount !== undefined) {
    if (!amount) {
      return {
        ok: false,
        reason: 'payment amount missing while MAX_PAYMENT_AMOUNT is set',
      };
    }
    const amt = parseAtomicAmount(amount);
    if (amt === undefined) {
      return {
        ok: false,
        reason: `payment amount is not a valid integer atomic unit: ${amount}`,
      };
    }
    if (amt > config.maxPaymentAmount) {
      return {
        ok: false,
        reason: `amount ${amount} exceeds MAX_PAYMENT_AMOUNT (${config.maxPaymentAmount.toString()})`,
      };
    }
  }

  if (config.networkAllowlist?.length) {
    if (!network) {
      return {
        ok: false,
        reason: 'network missing while NETWORK_ALLOWLIST is set',
      };
    }
    if (!config.networkAllowlist.includes(network)) {
      return {
        ok: false,
        reason: `network "${network}" not in NETWORK_ALLOWLIST`,
      };
    }
  }

  if (config.enforcePayToMatch && payloadPayTo) {
    const expected = config.expectedPayTo ?? merchantPayTo;
    if (expected) {
      if (normalizePayTo(payloadPayTo) !== normalizePayTo(expected)) {
        return {
          ok: false,
          reason: 'payload payTo does not match merchant PAY_TO_ADDRESS',
        };
      }
    }
  }

  return { ok: true };
}

/** Extract common bound fields from an x402 payment payload (best-effort). */
export function fieldsFromPaymentPayload(payload: unknown): PaymentBoundFields {
  const p = payload as {
    accepted?: { payTo?: string; network?: string; amount?: string };
    payload?: { authorization?: { to?: string; value?: string } };
  };
  return {
    payTo: p?.accepted?.payTo ?? p?.payload?.authorization?.to ?? undefined,
    network: p?.accepted?.network,
    amount:
      p?.accepted?.amount ?? p?.payload?.authorization?.value ?? undefined,
  };
}
