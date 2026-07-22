/**
 * Drives the real MerchantExecutor verify/settle entry points with bounds set
 * so the facilitator is never called — proves the hot-path gate runs first.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MerchantExecutor } from './MerchantExecutor.js';
import type { PaymentPayload } from '@x402/core/types';

function minimalPayload(overrides?: {
  payTo?: string;
  network?: string;
  amount?: string;
}): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: overrides?.network ?? 'eip155:84532',
      asset: '0xasset',
      payTo: overrides?.payTo ?? '0xAbC0000000000000000000000000000000000001',
      amount: overrides?.amount ?? '100000',
    },
    payload: {
      authorization: {
        from: '0xpayer',
        to: overrides?.payTo ?? '0xAbC0000000000000000000000000000000000001',
        value: overrides?.amount ?? '100000',
      },
      signature: '0xsig',
    },
  } as unknown as PaymentPayload;
}

describe('MerchantExecutor payment bounds hot path', () => {
  it('verifyPayment rejects over-max amount without calling facilitator', async () => {
    // price 0.1 USD → 100000 atomic; max 50 → reject before network I/O
    const merchant = new MerchantExecutor({
      payToAddress: '0xAbC0000000000000000000000000000000000001',
      network: 'base-sepolia',
      price: 0.1,
      paymentBounds: {
        maxPaymentAmount: 50n,
        expectedPayTo: '0xAbC0000000000000000000000000000000000001',
        enforcePayToMatch: true,
      },
    });

    const result = await merchant.verifyPayment(minimalPayload());
    assert.equal(result.isValid, false);
    assert.match(String(result.invalidReason), /MAX_PAYMENT_AMOUNT/);
  });

  it('settlePayment rejects over-max amount without calling facilitator', async () => {
    const merchant = new MerchantExecutor({
      payToAddress: '0xAbC0000000000000000000000000000000000001',
      network: 'base-sepolia',
      price: 0.1,
      paymentBounds: { maxPaymentAmount: 50n },
    });

    const result = await merchant.settlePayment(minimalPayload());
    assert.equal(result.success, false);
    assert.match(String(result.errorReason), /MAX_PAYMENT_AMOUNT/);
  });

  it('verifyPayment rejects network not on allowlist', async () => {
    const merchant = new MerchantExecutor({
      payToAddress: '0xAbC0000000000000000000000000000000000001',
      network: 'base-sepolia',
      price: 0.1,
      paymentBounds: {
        networkAllowlist: ['eip155:1'],
      },
    });

    const result = await merchant.verifyPayment(minimalPayload());
    assert.equal(result.isValid, false);
    assert.match(String(result.invalidReason), /NETWORK_ALLOWLIST/);
  });

  it('verifyPayment rejects payTo mismatch when enforce enabled', async () => {
    const merchant = new MerchantExecutor({
      payToAddress: '0xAbC0000000000000000000000000000000000001',
      network: 'base-sepolia',
      price: 0.1,
      paymentBounds: {
        maxPaymentAmount: 1_000_000n,
        expectedPayTo: '0xAbC0000000000000000000000000000000000001',
        enforcePayToMatch: true,
      },
    });

    const result = await merchant.verifyPayment(
      minimalPayload({ payTo: '0xdead000000000000000000000000000000000000' })
    );
    assert.equal(result.isValid, false);
    assert.match(String(result.invalidReason), /payTo/);
  });

  it('leaves prior path open when paymentBounds unset (no early bounds reject)', async () => {
    // Without bounds, verify will attempt facilitator and fail network — not a bounds reason.
    const merchant = new MerchantExecutor({
      payToAddress: '0xAbC0000000000000000000000000000000000001',
      network: 'base-sepolia',
      price: 0.1,
      facilitatorUrl: 'http://127.0.0.1:9', // closed port → fast fail
    });

    const result = await merchant.verifyPayment(minimalPayload());
    assert.equal(result.isValid, false);
    // Must NOT be a MAX_PAYMENT_AMOUNT / bounds message
    assert.doesNotMatch(String(result.invalidReason ?? ''), /MAX_PAYMENT_AMOUNT|NETWORK_ALLOWLIST|payTo does not match/);
  });
});
