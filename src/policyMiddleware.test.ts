/**
 * Tests for the Payment Policy Middleware.
 *
 * Run with:  npm run test:policy
 *   (which compiles first, then runs with node --test)
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPolicyMiddleware,
  toAtomicUnits,
  fromAtomicUnits,
  InMemoryPolicyStore,
  type PolicyMiddleware,
  type PolicyRequest,
} from './policyMiddleware.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    amount: '100000', // 0.10 USDC in atomic units
    recipient: '0xRecipientAddress',
    payer: '0xPayerAddress',
    network: 'base-sepolia',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit conversion tests
// ---------------------------------------------------------------------------

describe('toAtomicUnits', () => {
  it('converts whole numbers', () => {
    assert.equal(toAtomicUnits('1'), BigInt(1_000_000));
    assert.equal(toAtomicUnits('50'), BigInt(50_000_000));
  });

  it('converts fractional amounts', () => {
    assert.equal(toAtomicUnits('1.00'), BigInt(1_000_000));
    assert.equal(toAtomicUnits('0.10'), BigInt(100_000));
    assert.equal(toAtomicUnits('0.01'), BigInt(10_000));
    assert.equal(toAtomicUnits('1.50'), BigInt(1_500_000));
  });

  it('handles high-precision input', () => {
    // Truncates beyond 6 decimals
    assert.equal(toAtomicUnits('1.1234567'), BigInt(1_123_456));
  });

  it('handles zero', () => {
    assert.equal(toAtomicUnits('0'), BigInt(0));
    assert.equal(toAtomicUnits('0.00'), BigInt(0));
  });
});

describe('fromAtomicUnits', () => {
  it('converts atomic to human-readable', () => {
    assert.equal(fromAtomicUnits('1000000'), '1.000000');
    assert.equal(fromAtomicUnits('100000'), '0.100000');
    assert.equal(fromAtomicUnits('0'), '0.000000');
  });
});

// ---------------------------------------------------------------------------
// InMemoryPolicyStore tests
// ---------------------------------------------------------------------------

describe('InMemoryPolicyStore', () => {
  let store: InMemoryPolicyStore;

  beforeEach(() => {
    store = new InMemoryPolicyStore();
  });

  it('records and sums transactions in window', async () => {
    const now = Date.now();
    await store.recordTransaction('100000', now);
    await store.recordTransaction('200000', now);

    const total = await store.getTotalInWindow(60_000);
    assert.equal(total, '300000');
  });

  it('counts transactions in window', async () => {
    const now = Date.now();
    await store.recordTransaction('100000', now);
    await store.recordTransaction('200000', now);
    await store.recordTransaction('300000', now);

    const count = await store.getCountInWindow(60_000);
    assert.equal(count, 3);
  });

  it('excludes old records from window', async () => {
    const twoMinutesAgo = Date.now() - 120_000;
    const now = Date.now();
    await store.recordTransaction('100000', twoMinutesAgo);
    await store.recordTransaction('200000', now);

    const total = await store.getTotalInWindow(60_000);
    assert.equal(total, '200000');

    const count = await store.getCountInWindow(60_000);
    assert.equal(count, 1);
  });

  it('resets all data', async () => {
    await store.recordTransaction('100000', Date.now());
    await store.reset();

    const total = await store.getTotalInWindow(60_000);
    assert.equal(total, '0');
  });
});

// ---------------------------------------------------------------------------
// createPolicyMiddleware tests
// ---------------------------------------------------------------------------

describe('createPolicyMiddleware', () => {
  describe('with no policies configured', () => {
    it('allows all requests', async () => {
      const policy = createPolicyMiddleware({});
      const result = await policy.evaluate(makeRequest());
      assert.equal(result.allowed, true);
    });
  });

  // -----------------------------------------------------------------------
  // allowedRecipients
  // -----------------------------------------------------------------------
  describe('allowedRecipients', () => {
    let policy: PolicyMiddleware;

    beforeEach(() => {
      policy = createPolicyMiddleware({
        allowedRecipients: ['0xAllowedAddr1', '0xAllowedAddr2'],
      });
    });

    it('allows a whitelisted recipient', async () => {
      const result = await policy.evaluate(
        makeRequest({ recipient: '0xAllowedAddr1' }),
      );
      assert.equal(result.allowed, true);
    });

    it('allows case-insensitive match', async () => {
      const result = await policy.evaluate(
        makeRequest({ recipient: '0xallowedaddr1' }),
      );
      assert.equal(result.allowed, true);
    });

    it('denies a non-whitelisted recipient', async () => {
      const result = await policy.evaluate(
        makeRequest({ recipient: '0xUnknown' }),
      );
      assert.equal(result.allowed, false);
      assert.ok(result.reason?.includes('not in the allowed recipients list'));
    });
  });

  // -----------------------------------------------------------------------
  // maxPerTransaction
  // -----------------------------------------------------------------------
  describe('maxPerTransaction', () => {
    let policy: PolicyMiddleware;

    beforeEach(() => {
      policy = createPolicyMiddleware({
        maxPerTransaction: '1.00', // 1 USDC = 1000000 atomic
      });
    });

    it('allows a transaction at the limit', async () => {
      const result = await policy.evaluate(
        makeRequest({ amount: '1000000' }),
      );
      assert.equal(result.allowed, true);
    });

    it('allows a transaction below the limit', async () => {
      const result = await policy.evaluate(
        makeRequest({ amount: '500000' }),
      );
      assert.equal(result.allowed, true);
    });

    it('denies a transaction above the limit', async () => {
      const result = await policy.evaluate(
        makeRequest({ amount: '1000001' }),
      );
      assert.equal(result.allowed, false);
      assert.ok(result.reason?.includes('exceeds per-transaction limit'));
    });
  });

  // -----------------------------------------------------------------------
  // rateLimitPerMinute
  // -----------------------------------------------------------------------
  describe('rateLimitPerMinute', () => {
    let policy: PolicyMiddleware;

    beforeEach(() => {
      policy = createPolicyMiddleware({
        rateLimitPerMinute: 3,
      });
    });

    it('allows requests within the limit', async () => {
      // Record 2 previous transactions
      await policy.recordTransaction(makeRequest());
      await policy.recordTransaction(makeRequest());

      const result = await policy.evaluate(makeRequest());
      assert.equal(result.allowed, true);
    });

    it('denies requests exceeding the limit', async () => {
      // Record 3 previous transactions (hitting the limit)
      await policy.recordTransaction(makeRequest());
      await policy.recordTransaction(makeRequest());
      await policy.recordTransaction(makeRequest());

      const result = await policy.evaluate(makeRequest());
      assert.equal(result.allowed, false);
      assert.ok(result.reason?.includes('Rate limit exceeded'));
    });
  });

  // -----------------------------------------------------------------------
  // dailyBudget
  // -----------------------------------------------------------------------
  describe('dailyBudget', () => {
    let policy: PolicyMiddleware;

    beforeEach(() => {
      policy = createPolicyMiddleware({
        dailyBudget: '1.00', // 1 USDC daily
      });
    });

    it('allows when under budget', async () => {
      await policy.recordTransaction(makeRequest({ amount: '500000' }));
      const result = await policy.evaluate(makeRequest({ amount: '400000' }));
      assert.equal(result.allowed, true);
    });

    it('denies when over budget', async () => {
      // Already spent 0.90 USDC
      await policy.recordTransaction(makeRequest({ amount: '900000' }));
      // Trying to spend another 0.20 USDC (total would be 1.10)
      const result = await policy.evaluate(makeRequest({ amount: '200000' }));
      assert.equal(result.allowed, false);
      assert.ok(result.reason?.includes('Daily budget exceeded'));
    });

    it('allows exactly at the budget', async () => {
      await policy.recordTransaction(makeRequest({ amount: '500000' }));
      const result = await policy.evaluate(makeRequest({ amount: '500000' }));
      assert.equal(result.allowed, true);
    });
  });

  // -----------------------------------------------------------------------
  // customPolicy
  // -----------------------------------------------------------------------
  describe('customPolicy', () => {
    it('allows when custom policy returns true', async () => {
      const policy = createPolicyMiddleware({
        customPolicy: () => true,
      });
      const result = await policy.evaluate(makeRequest());
      assert.equal(result.allowed, true);
    });

    it('denies when custom policy returns false', async () => {
      const policy = createPolicyMiddleware({
        customPolicy: () => false,
      });
      const result = await policy.evaluate(makeRequest());
      assert.equal(result.allowed, false);
      assert.ok(result.reason?.includes('custom policy'));
    });

    it('supports async custom policies', async () => {
      const policy = createPolicyMiddleware({
        customPolicy: async (req) => {
          // Only allow requests on base-sepolia
          return req.network === 'base-sepolia';
        },
      });

      const allowed = await policy.evaluate(makeRequest({ network: 'base-sepolia' }));
      assert.equal(allowed.allowed, true);

      const denied = await policy.evaluate(makeRequest({ network: 'polygon' }));
      assert.equal(denied.allowed, false);
    });
  });

  // -----------------------------------------------------------------------
  // Fail-closed behaviour
  // -----------------------------------------------------------------------
  describe('fail-closed on errors', () => {
    it('denies when a custom policy throws', async () => {
      const policy = createPolicyMiddleware({
        customPolicy: () => {
          throw new Error('Boom');
        },
      });
      const result = await policy.evaluate(makeRequest());
      assert.equal(result.allowed, false);
      assert.ok(result.reason?.includes('Policy evaluation error'));
      assert.ok(result.reason?.includes('Boom'));
    });

    it('denies when the store throws', async () => {
      const brokenStore = {
        recordTransaction: async () => {},
        getTotalInWindow: async (): Promise<string> => {
          throw new Error('store down');
        },
        getCountInWindow: async (): Promise<number> => {
          throw new Error('store down');
        },
        reset: async () => {},
      };

      const policy = createPolicyMiddleware({
        dailyBudget: '50.00',
        store: brokenStore,
      });

      const result = await policy.evaluate(makeRequest());
      assert.equal(result.allowed, false);
      assert.ok(result.reason?.includes('Policy evaluation error'));
    });
  });

  // -----------------------------------------------------------------------
  // Combined policies
  // -----------------------------------------------------------------------
  describe('combined policies', () => {
    it('enforces all policies together', async () => {
      const policy = createPolicyMiddleware({
        maxPerTransaction: '1.00',
        dailyBudget: '5.00',
        allowedRecipients: ['0xRecipientAddress'],
        rateLimitPerMinute: 10,
      });

      // Should pass: valid recipient, amount under limit, under budget
      const ok = await policy.evaluate(makeRequest({ amount: '500000' }));
      assert.equal(ok.allowed, true);

      // Should fail: bad recipient
      const badRecip = await policy.evaluate(
        makeRequest({ amount: '500000', recipient: '0xEvil' }),
      );
      assert.equal(badRecip.allowed, false);

      // Should fail: over per-tx limit
      const overTx = await policy.evaluate(
        makeRequest({ amount: '2000000' }),
      );
      assert.equal(overTx.allowed, false);
    });
  });

  // -----------------------------------------------------------------------
  // resetStore
  // -----------------------------------------------------------------------
  describe('resetStore', () => {
    it('clears recorded transactions', async () => {
      const policy = createPolicyMiddleware({
        dailyBudget: '1.00',
      });

      await policy.recordTransaction(makeRequest({ amount: '900000' }));

      // Would exceed budget
      let result = await policy.evaluate(makeRequest({ amount: '200000' }));
      assert.equal(result.allowed, false);

      // Reset and try again
      await policy.resetStore();
      result = await policy.evaluate(makeRequest({ amount: '200000' }));
      assert.equal(result.allowed, true);
    });
  });
});
