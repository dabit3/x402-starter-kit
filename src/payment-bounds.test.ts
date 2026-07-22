import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePaymentBounds,
  fieldsFromPaymentPayload,
  normalizePayTo,
  parsePaymentBoundsFromEnv,
} from './payment-bounds.js';

describe('normalizePayTo', () => {
  it('lowercases EVM addresses', () => {
    assert.equal(normalizePayTo('0xAbC'), '0xabc');
  });

  it('leaves non-0x addresses unchanged', () => {
    assert.equal(normalizePayTo('SoLanaAddr'), 'SoLanaAddr');
  });
});

describe('parsePaymentBoundsFromEnv', () => {
  it('returns null when no bound knobs are set', () => {
    assert.equal(parsePaymentBoundsFromEnv({ PAY_TO_ADDRESS: '0xabc' }), null);
  });

  it('parses MAX_PAYMENT_AMOUNT and NETWORK_ALLOWLIST', () => {
    const cfg = parsePaymentBoundsFromEnv({
      MAX_PAYMENT_AMOUNT: '100000',
      NETWORK_ALLOWLIST: 'eip155:84532, solana-devnet',
      PAY_TO_ADDRESS: '0xAbC',
    });
    assert.ok(cfg);
    assert.equal(cfg!.maxPaymentAmount, 100000n);
    assert.deepEqual(cfg!.networkAllowlist, ['eip155:84532', 'solana-devnet']);
    assert.equal(cfg!.expectedPayTo, '0xAbC');
  });

  it('throws on non-integer MAX_PAYMENT_AMOUNT', () => {
    assert.throws(
      () => parsePaymentBoundsFromEnv({ MAX_PAYMENT_AMOUNT: '1.5' }),
      /MAX_PAYMENT_AMOUNT/
    );
  });

  it('enables payTo-only mode when ENFORCE_PAYTO_MATCH=true', () => {
    const cfg = parsePaymentBoundsFromEnv({
      ENFORCE_PAYTO_MATCH: 'true',
      PAY_TO_ADDRESS: '0xabc',
    });
    assert.ok(cfg);
    assert.equal(cfg!.enforcePayToMatch, true);
    assert.equal(cfg!.expectedPayTo, '0xabc');
  });
});

describe('evaluatePaymentBounds', () => {
  const merchant = {
    amount: '100000',
    payTo: '0xAbC',
    network: 'eip155:84532',
  };

  it('allows when under max and on allowlist', () => {
    const result = evaluatePaymentBounds(
      {
        maxPaymentAmount: 200000n,
        networkAllowlist: ['eip155:84532'],
        expectedPayTo: '0xabc',
        enforcePayToMatch: true,
      },
      merchant,
      { payTo: '0xABC' }
    );
    assert.equal(result.ok, true);
  });

  it('rejects amount above max before facilitator would be called', () => {
    const result = evaluatePaymentBounds(
      { maxPaymentAmount: 50n },
      merchant
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /exceeds MAX_PAYMENT_AMOUNT/);
    }
  });

  it('rejects network not on allowlist', () => {
    const result = evaluatePaymentBounds(
      { networkAllowlist: ['eip155:1'] },
      merchant
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /NETWORK_ALLOWLIST/);
    }
  });

  it('rejects payload payTo mismatch when enforce enabled', () => {
    const result = evaluatePaymentBounds(
      {
        maxPaymentAmount: 1_000_000n,
        expectedPayTo: '0xabc',
        enforcePayToMatch: true,
      },
      merchant,
      { payTo: '0xdead' }
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /payTo/);
    }
  });

  it('does not apply max when config has no max', () => {
    const result = evaluatePaymentBounds({}, { amount: '999999999999' });
    assert.equal(result.ok, true);
  });
});

describe('fieldsFromPaymentPayload', () => {
  it('reads accepted and authorization fallbacks', () => {
    const fields = fieldsFromPaymentPayload({
      accepted: { payTo: '0x1', network: 'eip155:8453', amount: '10' },
    });
    assert.equal(fields.payTo, '0x1');
    assert.equal(fields.network, 'eip155:8453');
    assert.equal(fields.amount, '10');
  });
});
