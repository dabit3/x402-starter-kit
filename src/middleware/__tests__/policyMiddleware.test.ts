/**
 * Tests for Payment Policy Middleware
 *
 * Run with: npm run build && node dist/middleware/__tests__/policyMiddleware.test.js
 */

import {
  createPolicyMiddleware,
  PaymentPolicyMiddleware,
  usdcToAtomic,
  type PolicyContext,
} from '../index.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${message}`);
  }
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
    failed++;
    console.error(`  ❌ FAIL: ${message} (did not throw)`);
  } catch {
    passed++;
    console.log(`  ✅ ${message}`);
  }
}

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    payer: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    amount: '100000', // 0.10 USDC in atomic units
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: '0x1234567890123456789012345678901234567890',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================
// usdcToAtomic tests
// ============================================================
console.log('\n--- usdcToAtomic ---');

assert(usdcToAtomic('1.00') === BigInt(1_000_000), 'converts 1.00 USDC to 1000000');
assert(usdcToAtomic('0.10') === BigInt(100_000), 'converts 0.10 USDC to 100000');
assert(usdcToAtomic('0.000001') === BigInt(1), 'converts smallest unit');
assert(usdcToAtomic('100') === BigInt(100_000_000), 'converts whole number without decimals');
assert(usdcToAtomic('1.123456') === BigInt(1_123_456), 'converts 6 decimal places exactly');
assertThrows(() => usdcToAtomic('1.1234567'), 'throws when more than 6 decimals are provided');
assertThrows(() => usdcToAtomic('abc'), 'throws on non-numeric input');
assertThrows(() => usdcToAtomic('-1.00'), 'throws on negative amounts');

// ============================================================
// createPolicyMiddleware factory
// ============================================================
console.log('\n--- createPolicyMiddleware factory ---');

const mw = createPolicyMiddleware({ maxPerTransaction: '1.00' });
assert(mw instanceof PaymentPolicyMiddleware, 'factory returns PaymentPolicyMiddleware instance');

// ============================================================
// Blocklist tests
// ============================================================
console.log('\n--- Blocklist ---');

async function testBlocklist() {
  const policy = createPolicyMiddleware({
    blockedPayers: ['0xBLOCKED1234567890ABCDEF1234567890ABCDEF12'],
  });

  const blocked = await policy.evaluate(
    makeContext({ payer: '0xBLOCKED1234567890ABCDEF1234567890ABCDEF12' })
  );
  assert(!blocked.allowed, 'blocks a listed payer');
  assert(blocked.reason === 'Payer address is blocked by policy', 'provides correct block reason');

  const allowed = await policy.evaluate(
    makeContext({ payer: '0xALLOWED1234567890ABCDEF1234567890ABCDEF12' })
  );
  assert(allowed.allowed, 'allows a non-listed payer');
}

// ============================================================
// Blocklist case-insensitivity
// ============================================================
console.log('\n--- Blocklist case-insensitivity ---');

async function testBlocklistCaseInsensitive() {
  const policy = createPolicyMiddleware({
    blockedPayers: ['0xABCDEF'],
  });

  const result = await policy.evaluate(makeContext({ payer: '0xabcdef' }));
  assert(!result.allowed, 'blocks payer regardless of case');
}

// ============================================================
// Allowlist tests
// ============================================================
console.log('\n--- Allowlist ---');

async function testAllowlist() {
  const policy = createPolicyMiddleware({
    allowedPayers: ['0xALLOWED1234567890ABCDEF1234567890ABCDEF12'],
  });

  const allowed = await policy.evaluate(
    makeContext({ payer: '0xALLOWED1234567890ABCDEF1234567890ABCDEF12' })
  );
  assert(allowed.allowed, 'allows a listed payer');

  const denied = await policy.evaluate(
    makeContext({ payer: '0xNOTLISTED1234567890ABCDEF1234567890ABCDE' })
  );
  assert(!denied.allowed, 'denies an unlisted payer');
  assert(denied.reason === 'Payer address is not in the allowed list', 'provides correct allowlist reason');
}

// ============================================================
// Per-transaction limit
// ============================================================
console.log('\n--- Per-transaction limit ---');

async function testPerTransactionLimit() {
  const policy = createPolicyMiddleware({
    maxPerTransaction: '1.00', // 1 USDC = 1000000 atomic
  });

  const under = await policy.evaluate(makeContext({ amount: '500000' })); // 0.50 USDC
  assert(under.allowed, 'allows amount under limit');

  const exact = await policy.evaluate(makeContext({ amount: '1000000' })); // exactly 1.00 USDC
  assert(exact.allowed, 'allows amount at exact limit');

  const over = await policy.evaluate(makeContext({ amount: '1000001' })); // 1.000001 USDC
  assert(!over.allowed, 'blocks amount over limit');
  assert(
    over.reason!.includes('per-transaction limit'),
    'provides per-transaction limit reason'
  );
}

// ============================================================
// Hourly rate limit
// ============================================================
console.log('\n--- Hourly rate limit ---');

async function testHourlyRateLimit() {
  const policy = createPolicyMiddleware({
    maxPerHour: '1.00', // 1 USDC per hour
  });

  const payer = '0xPAYER1234567890ABCDEF1234567890ABCDEF1234';
  const now = Date.now();

  // Record two past transactions totaling 0.80 USDC
  policy.recordTransaction(
    makeContext({ payer, amount: '400000', timestamp: now - 10 * 60 * 1000 }) // 10 min ago
  );
  policy.recordTransaction(
    makeContext({ payer, amount: '400000', timestamp: now - 5 * 60 * 1000 }) // 5 min ago
  );

  // Another 0.20 should be fine (total = 1.00)
  const allowed = await policy.evaluate(
    makeContext({ payer, amount: '200000', timestamp: now })
  );
  assert(allowed.allowed, 'allows payment within hourly limit');

  // Another 0.01 should be blocked (total would be 1.01)
  const blocked = await policy.evaluate(
    makeContext({ payer, amount: '210000', timestamp: now })
  );
  assert(!blocked.allowed, 'blocks payment exceeding hourly limit');
  assert(blocked.reason!.includes('hourly limit'), 'provides hourly limit reason');
}

// ============================================================
// Daily rate limit
// ============================================================
console.log('\n--- Daily rate limit ---');

async function testDailyRateLimit() {
  const policy = createPolicyMiddleware({
    maxPerDay: '5.00', // 5 USDC per day
  });

  const payer = '0xPAYER1234567890ABCDEF1234567890ABCDEF1234';
  const now = Date.now();

  // Record a past transaction of 4.90 USDC from 12 hours ago
  policy.recordTransaction(
    makeContext({ payer, amount: '4900000', timestamp: now - 12 * 60 * 60 * 1000 })
  );

  // 0.10 more should be fine (total = 5.00)
  const allowed = await policy.evaluate(
    makeContext({ payer, amount: '100000', timestamp: now })
  );
  assert(allowed.allowed, 'allows payment within daily limit');

  // 0.11 would exceed (total = 5.01)
  const blocked = await policy.evaluate(
    makeContext({ payer, amount: '110000', timestamp: now })
  );
  assert(!blocked.allowed, 'blocks payment exceeding daily limit');
  assert(blocked.reason!.includes('daily limit'), 'provides daily limit reason');
}

// ============================================================
// Custom policy
// ============================================================
console.log('\n--- Custom policy ---');

async function testCustomPolicy() {
  const policy = createPolicyMiddleware({
    customPolicy: (ctx) => {
      if (ctx.network.startsWith('solana:')) {
        return { allowed: false, reason: 'Solana payments temporarily disabled' };
      }
      return { allowed: true };
    },
  });

  const evmResult = await policy.evaluate(makeContext({ network: 'eip155:84532' }));
  assert(evmResult.allowed, 'allows EVM payment via custom policy');

  const solResult = await policy.evaluate(
    makeContext({ network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' })
  );
  assert(!solResult.allowed, 'blocks Solana payment via custom policy');
  assert(
    solResult.reason === 'Solana payments temporarily disabled',
    'provides custom policy reason'
  );
}

// ============================================================
// Async custom policy
// ============================================================
console.log('\n--- Async custom policy ---');

async function testAsyncCustomPolicy() {
  const policy = createPolicyMiddleware({
    customPolicy: async () => {
      // Simulate async check
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { allowed: true };
    },
  });

  const result = await policy.evaluate(makeContext());
  assert(result.allowed, 'works with async custom policy');
}

// ============================================================
// Combined policies
// ============================================================
console.log('\n--- Combined policies ---');

async function testCombinedPolicies() {
  const policy = createPolicyMiddleware({
    maxPerTransaction: '2.00',
    maxPerHour: '5.00',
    blockedPayers: ['0xBLOCKED'],
    allowedPayers: [
      '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
      '0xALLOWED',
    ],
  });

  // Blocked payer is checked first
  const blockedResult = await policy.evaluate(makeContext({ payer: '0xBLOCKED' }));
  assert(!blockedResult.allowed, 'blocklist takes precedence');
  assert(
    blockedResult.reason === 'Payer address is blocked by policy',
    'returns blocklist reason even if allowlist also applies'
  );

  // Allowed + under limits
  const okResult = await policy.evaluate(makeContext({ amount: '500000' }));
  assert(okResult.allowed, 'allows when all policies pass');

  // Over per-tx limit
  const overTx = await policy.evaluate(makeContext({ amount: '3000000' }));
  assert(!overTx.allowed, 'blocks when per-tx limit exceeded in combined config');
}

// ============================================================
// No config = everything allowed
// ============================================================
console.log('\n--- Empty config ---');

async function testEmptyConfig() {
  const policy = createPolicyMiddleware({});
  const result = await policy.evaluate(makeContext());
  assert(result.allowed, 'allows everything with empty config');
}

// ============================================================
// Rate limit isolation between payers
// ============================================================
console.log('\n--- Payer isolation ---');

async function testPayerIsolation() {
  const policy = createPolicyMiddleware({
    maxPerHour: '1.00',
  });

  const now = Date.now();
  const payerA = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const payerB = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  // Payer A uses up their limit
  policy.recordTransaction(
    makeContext({ payer: payerA, amount: '1000000', timestamp: now - 60000 })
  );

  // Payer A should be blocked
  const aResult = await policy.evaluate(
    makeContext({ payer: payerA, amount: '100000', timestamp: now })
  );
  assert(!aResult.allowed, 'blocks payer A who exceeded limit');

  // Payer B should still be fine
  const bResult = await policy.evaluate(
    makeContext({ payer: payerB, amount: '100000', timestamp: now })
  );
  assert(bResult.allowed, 'allows payer B whose limit is independent');
}

// ============================================================
// Run all tests
// ============================================================
async function runAllTests() {
  await testBlocklist();
  await testBlocklistCaseInsensitive();
  await testAllowlist();
  await testPerTransactionLimit();
  await testHourlyRateLimit();
  await testDailyRateLimit();
  await testCustomPolicy();
  await testAsyncCustomPolicy();
  await testCombinedPolicies();
  await testEmptyConfig();
  await testPayerIsolation();

  console.log(`\n=============================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`=============================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
