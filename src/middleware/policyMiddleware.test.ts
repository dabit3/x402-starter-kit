import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPolicyMiddleware,
  PaymentPolicyMiddleware,
  type PolicyContext,
} from './policyMiddleware.js';

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    payer: '0xABCDEF1234567890abcdef1234567890ABCDEF12',
    amount: '100000', // 0.10 USDC in atomic units (6 decimals)
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: '0xMerchant',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('PaymentPolicyMiddleware', () => {
  describe('createPolicyMiddleware', () => {
    it('should return a PaymentPolicyMiddleware instance', () => {
      const mw = createPolicyMiddleware({});
      assert.ok(mw instanceof PaymentPolicyMiddleware);
    });
  });

  describe('no config (pass-through)', () => {
    it('should allow all payments when no policy is configured', async () => {
      const mw = createPolicyMiddleware({});
      const result = await mw.evaluate(makeContext());
      assert.deepStrictEqual(result, { allowed: true });
    });
  });

  describe('blockedPayers', () => {
    let mw: PaymentPolicyMiddleware;

    beforeEach(() => {
      mw = createPolicyMiddleware({
        blockedPayers: ['0xBLOCKED1111111111111111111111111111111111'],
      });
    });

    it('should block a payer on the blocklist', async () => {
      const result = await mw.evaluate(
        makeContext({ payer: '0xBLOCKED1111111111111111111111111111111111' })
      );
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'Payer address is blocked by policy');
    });

    it('should block case-insensitively', async () => {
      const result = await mw.evaluate(
        makeContext({ payer: '0xblocked1111111111111111111111111111111111' })
      );
      assert.equal(result.allowed, false);
    });

    it('should allow a payer not on the blocklist', async () => {
      const result = await mw.evaluate(makeContext());
      assert.equal(result.allowed, true);
    });
  });

  describe('allowedPayers', () => {
    let mw: PaymentPolicyMiddleware;

    beforeEach(() => {
      mw = createPolicyMiddleware({
        allowedPayers: ['0xALLOWED1111111111111111111111111111111111'],
      });
    });

    it('should allow a payer on the allowlist', async () => {
      const result = await mw.evaluate(
        makeContext({ payer: '0xALLOWED1111111111111111111111111111111111' })
      );
      assert.equal(result.allowed, true);
    });

    it('should reject a payer not on the allowlist', async () => {
      const result = await mw.evaluate(makeContext());
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'Payer address is not in the allowed list');
    });
  });

  describe('maxPerTransaction', () => {
    let mw: PaymentPolicyMiddleware;

    beforeEach(() => {
      mw = createPolicyMiddleware({ maxPerTransaction: '1.00' });
    });

    it('should allow a transaction at the limit', async () => {
      const result = await mw.evaluate(makeContext({ amount: '1000000' })); // 1.00 USDC
      assert.equal(result.allowed, true);
    });

    it('should allow a transaction below the limit', async () => {
      const result = await mw.evaluate(makeContext({ amount: '500000' })); // 0.50 USDC
      assert.equal(result.allowed, true);
    });

    it('should reject a transaction above the limit', async () => {
      const result = await mw.evaluate(makeContext({ amount: '1000001' })); // 1.000001 USDC
      assert.equal(result.allowed, false);
      assert.match(result.reason!, /per-transaction limit/);
    });
  });

  describe('maxPerHour', () => {
    it('should allow first transaction within hourly limit', async () => {
      const mw = createPolicyMiddleware({ maxPerHour: '1.00' });
      const result = await mw.evaluate(makeContext({ amount: '500000' }));
      assert.equal(result.allowed, true);
    });

    it('should reject when hourly total would exceed limit', async () => {
      const mw = createPolicyMiddleware({ maxPerHour: '1.00' });
      const now = Date.now();

      // Record a previous transaction of 0.60 USDC
      mw.recordTransaction(makeContext({ amount: '600000', timestamp: now - 1000 }));

      // Try another 0.50 USDC (total 1.10 > 1.00 limit)
      const result = await mw.evaluate(makeContext({ amount: '500000', timestamp: now }));
      assert.equal(result.allowed, false);
      assert.match(result.reason!, /hourly limit/);
    });

    it('should not count transactions older than 1 hour', async () => {
      const mw = createPolicyMiddleware({ maxPerHour: '1.00' });
      const now = Date.now();

      // Record a transaction from 2 hours ago
      mw.recordTransaction(makeContext({ amount: '900000', timestamp: now - 2 * 60 * 60 * 1000 }));

      // Should be allowed since the old transaction is outside the window
      const result = await mw.evaluate(makeContext({ amount: '500000', timestamp: now }));
      assert.equal(result.allowed, true);
    });
  });

  describe('maxPerDay', () => {
    it('should reject when daily total would exceed limit', async () => {
      const mw = createPolicyMiddleware({ maxPerDay: '5.00' });
      const now = Date.now();

      // Record 4.80 USDC worth of transactions
      mw.recordTransaction(makeContext({ amount: '2400000', timestamp: now - 1000 }));
      mw.recordTransaction(makeContext({ amount: '2400000', timestamp: now - 500 }));

      // Try another 0.30 USDC (total 5.10 > 5.00 limit)
      const result = await mw.evaluate(makeContext({ amount: '300000', timestamp: now }));
      assert.equal(result.allowed, false);
      assert.match(result.reason!, /daily limit/);
    });

    it('should not count transactions older than 24 hours', async () => {
      const mw = createPolicyMiddleware({ maxPerDay: '5.00' });
      const now = Date.now();

      // Record a transaction from 25 hours ago
      mw.recordTransaction(makeContext({ amount: '4900000', timestamp: now - 25 * 60 * 60 * 1000 }));

      const result = await mw.evaluate(makeContext({ amount: '500000', timestamp: now }));
      assert.equal(result.allowed, true);
    });
  });

  describe('customPolicy', () => {
    it('should call the custom policy function', async () => {
      const mw = createPolicyMiddleware({
        customPolicy: (ctx) => {
          if (ctx.network === 'eip155:1') {
            return { allowed: false, reason: 'Mainnet payments disabled' };
          }
          return { allowed: true };
        },
      });

      const allowed = await mw.evaluate(makeContext({ network: 'eip155:84532' }));
      assert.equal(allowed.allowed, true);

      const blocked = await mw.evaluate(makeContext({ network: 'eip155:1' }));
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.reason, 'Mainnet payments disabled');
    });

    it('should support async custom policy', async () => {
      const mw = createPolicyMiddleware({
        customPolicy: async () => {
          return { allowed: true };
        },
      });

      const result = await mw.evaluate(makeContext());
      assert.equal(result.allowed, true);
    });
  });

  describe('combined policies', () => {
    it('should check blocklist before allowlist', async () => {
      const addr = '0xBOTH1111111111111111111111111111111111111';
      const mw = createPolicyMiddleware({
        allowedPayers: [addr],
        blockedPayers: [addr],
      });

      // Should be blocked because blocklist takes precedence
      const result = await mw.evaluate(makeContext({ payer: addr }));
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'Payer address is blocked by policy');
    });

    it('should enforce all limits together', async () => {
      const mw = createPolicyMiddleware({
        maxPerTransaction: '2.00',
        maxPerHour: '5.00',
        maxPerDay: '10.00',
      });
      const now = Date.now();

      // Transaction within per-tx limit but will exceed hourly if accumulated
      mw.recordTransaction(makeContext({ amount: '4000000', timestamp: now - 1000 }));

      // 1.50 USDC: within per-tx limit of 2.00 but 4.00 + 1.50 = 5.50 > 5.00 hourly
      const result = await mw.evaluate(makeContext({ amount: '1500000', timestamp: now }));
      assert.equal(result.allowed, false);
      assert.match(result.reason!, /hourly limit/);
    });
  });

  describe('recordTransaction', () => {
    it('should prune records older than 24 hours', async () => {
      const mw = createPolicyMiddleware({ maxPerDay: '100.00' });
      const now = Date.now();

      // Record an old transaction (26 hours ago)
      mw.recordTransaction(makeContext({ amount: '50000000', timestamp: now - 26 * 60 * 60 * 1000 }));

      // Record a recent one
      mw.recordTransaction(makeContext({ amount: '1000000', timestamp: now }));

      // The old one should have been pruned, so daily total is just 1.00 USDC
      const result = await mw.evaluate(makeContext({ amount: '1000000', timestamp: now }));
      assert.equal(result.allowed, true);
    });
  });
});
