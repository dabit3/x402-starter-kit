import express from 'express';
import dotenv from 'dotenv';

// Polyfill BigInt serialization for JSON.stringify (required for Solana transactions)
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

import { ExampleService } from './ExampleService.js';
import { MerchantExecutor, type MerchantExecutorOptions } from './MerchantExecutor.js';
import type { PaymentPayload } from '@x402/core/types';
import {
  EventQueue,
  Message,
  RequestContext,
  Task,
  TaskState,
} from './x402Types.js';
import {
  createPolicyMiddleware,
  type PaymentPolicyMiddleware,
  type PolicyConfig,
} from './middleware/index.js';

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const PAY_TO_ADDRESS = process.env.PAY_TO_ADDRESS;
const NETWORK = process.env.NETWORK || 'base-sepolia';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const FACILITATOR_API_KEY = process.env.FACILITATOR_API_KEY;
const SERVICE_URL =
  process.env.SERVICE_URL || `http://localhost:${PORT}/process`;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const SETTLEMENT_MODE_ENV = process.env.SETTLEMENT_MODE?.toLowerCase();
const ASSET_ADDRESS = process.env.ASSET_ADDRESS;
const ASSET_NAME = process.env.ASSET_NAME;
const EXPLORER_URL = process.env.EXPLORER_URL;
const CHAIN_ID = process.env.CHAIN_ID
  ? Number.parseInt(process.env.CHAIN_ID, 10)
  : undefined;
const AI_PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const EIGENAI_BASE_URL =
  process.env.EIGENAI_BASE_URL || 'https://eigenai.eigencloud.xyz/v1';
const EIGENAI_API_KEY = process.env.EIGENAI_API_KEY;
const AI_MODEL = process.env.AI_MODEL;
const AI_TEMPERATURE = process.env.AI_TEMPERATURE
  ? Number.parseFloat(process.env.AI_TEMPERATURE)
  : undefined;
const AI_MAX_TOKENS = process.env.AI_MAX_TOKENS
  ? Number.parseInt(process.env.AI_MAX_TOKENS, 10)
  : undefined;
const AI_SEED = process.env.AI_SEED
  ? Number.parseInt(process.env.AI_SEED, 10)
  : undefined;

// Payment policy configuration (all optional)
const POLICY_MAX_PER_TX = process.env.POLICY_MAX_PER_TRANSACTION;
const POLICY_MAX_PER_HOUR = process.env.POLICY_MAX_PER_HOUR;
const POLICY_MAX_PER_DAY = process.env.POLICY_MAX_PER_DAY;
const POLICY_ALLOWED_PAYERS = process.env.POLICY_ALLOWED_PAYERS;
const POLICY_BLOCKED_PAYERS = process.env.POLICY_BLOCKED_PAYERS;

// Supported networks - both legacy names and CAIP-2 format
const SUPPORTED_NETWORKS: string[] = [
  // Legacy names (will be converted to CAIP-2)
  'base',
  'base-sepolia',
  'polygon',
  'polygon-amoy',
  'avalanche',
  'avalanche-fuji',
  'iotex',
  'sei',
  'sei-testnet',
  'peaq',
  'solana',
  'solana-devnet',
  // CAIP-2 format (eip155:chainId)
  'eip155:8453',      // Base
  'eip155:84532',     // Base Sepolia
  'eip155:137',       // Polygon
  'eip155:80002',     // Polygon Amoy
  'eip155:43114',     // Avalanche
  'eip155:43113',     // Avalanche Fuji
  'eip155:4689',      // IoTeX
  'eip155:1329',      // Sei
  'eip155:1328',      // Sei Testnet
  'eip155:3338',      // Peaq
];

// Validate environment variables
if (AI_PROVIDER === 'openai') {
  if (!OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY is required when AI_PROVIDER=openai');
    process.exit(1);
  }
} else if (AI_PROVIDER === 'eigenai') {
  if (!EIGENAI_API_KEY && !OPENAI_API_KEY) {
    console.error('❌ EIGENAI_API_KEY (or OPENAI_API_KEY fallback) is required when AI_PROVIDER=eigenai');
    process.exit(1);
  }
} else {
  console.error(
    `❌ AI_PROVIDER "${AI_PROVIDER}" is not supported. Supported providers: openai, eigenai`
  );
  process.exit(1);
}

if (!PAY_TO_ADDRESS) {
  console.error('❌ PAY_TO_ADDRESS is required');
  process.exit(1);
}

// Check if network is in CAIP-2 format or legacy format
const isValidNetwork = SUPPORTED_NETWORKS.includes(NETWORK) || NETWORK.includes(':');
if (!isValidNetwork) {
  console.error(
    `❌ NETWORK "${NETWORK}" is not supported. Use legacy names (base, base-sepolia, etc.) or CAIP-2 format (eip155:8453, etc.)`
  );
  process.exit(1);
}

let settlementMode: 'facilitator' | 'direct';
if (SETTLEMENT_MODE_ENV === 'local' || SETTLEMENT_MODE_ENV === 'direct') {
  settlementMode = 'direct';
} else if (SETTLEMENT_MODE_ENV === 'facilitator') {
  settlementMode = 'facilitator';
} else if (FACILITATOR_URL) {
  settlementMode = 'facilitator';
} else if (PRIVATE_KEY) {
  settlementMode = 'direct';
} else {
  settlementMode = 'facilitator';
}

if (settlementMode === 'direct' && !PRIVATE_KEY) {
  console.error('❌ SETTLEMENT_MODE=local requires PRIVATE_KEY to be configured');
  process.exit(1);
}

const exampleService = new ExampleService({
  provider: AI_PROVIDER === 'eigenai' ? 'eigenai' : 'openai',
  apiKey: AI_PROVIDER === 'openai' ? OPENAI_API_KEY : undefined,
  baseUrl:
    AI_PROVIDER === 'eigenai'
      ? EIGENAI_BASE_URL
      : OPENAI_BASE_URL || undefined,
  defaultHeaders:
    AI_PROVIDER === 'eigenai'
      ? { 'x-api-key': (EIGENAI_API_KEY || OPENAI_API_KEY)! }
      : undefined,
  payToAddress: PAY_TO_ADDRESS,
  network: NETWORK,
  model:
    AI_MODEL ??
    (AI_PROVIDER === 'eigenai' ? 'gpt-oss-120b-f16' : 'gpt-4o-mini'),
  temperature: AI_TEMPERATURE ?? 0.7,
  maxTokens: AI_MAX_TOKENS ?? 500,
  seed: AI_PROVIDER === 'eigenai' ? AI_SEED : undefined,
});

// Initialize the example service (replace with your own service)
const merchantOptions: MerchantExecutorOptions = {
  payToAddress: PAY_TO_ADDRESS,
  network: NETWORK,
  price: 0.1,
  facilitatorUrl: FACILITATOR_URL,
  facilitatorApiKey: FACILITATOR_API_KEY,
  resourceUrl: SERVICE_URL,
  settlementMode,
  rpcUrl: RPC_URL,
  privateKey: PRIVATE_KEY,
  assetAddress: ASSET_ADDRESS,
  assetName: ASSET_NAME,
  explorerUrl: EXPLORER_URL,
  chainId: CHAIN_ID,
};

const merchantExecutor = new MerchantExecutor(merchantOptions);

// Initialize optional payment policy middleware
const policyConfig: PolicyConfig = {
  ...(POLICY_MAX_PER_TX && { maxPerTransaction: POLICY_MAX_PER_TX }),
  ...(POLICY_MAX_PER_HOUR && { maxPerHour: POLICY_MAX_PER_HOUR }),
  ...(POLICY_MAX_PER_DAY && { maxPerDay: POLICY_MAX_PER_DAY }),
  ...(POLICY_ALLOWED_PAYERS && {
    allowedPayers: POLICY_ALLOWED_PAYERS.split(',').map((a) => a.trim()),
  }),
  ...(POLICY_BLOCKED_PAYERS && {
    blockedPayers: POLICY_BLOCKED_PAYERS.split(',').map((a) => a.trim()),
  }),
};

const hasPolicyConfig = Object.keys(policyConfig).length > 0;
let policyMiddleware: PaymentPolicyMiddleware | undefined;
if (hasPolicyConfig) {
  policyMiddleware = createPolicyMiddleware(policyConfig);
  console.log('\u{1F6E1}\uFE0F  Payment policy middleware enabled');
  if (policyConfig.maxPerTransaction) console.log(`   Max per transaction: $${policyConfig.maxPerTransaction} USDC`);
  if (policyConfig.maxPerHour) console.log(`   Max per hour: $${policyConfig.maxPerHour} USDC`);
  if (policyConfig.maxPerDay) console.log(`   Max per day: $${policyConfig.maxPerDay} USDC`);
  if (policyConfig.allowedPayers) console.log(`   Allowed payers: ${policyConfig.allowedPayers.length} address(es)`);
  if (policyConfig.blockedPayers) console.log(`   Blocked payers: ${policyConfig.blockedPayers.length} address(es)`);
}

// Initialize the merchant executor (async for facilitator mode)
async function initializeMerchant() {
  await merchantExecutor.initialize();
}

if (settlementMode === 'direct') {
  console.log('🧩 Using local settlement (direct EIP-3009 via RPC)');
  if (RPC_URL) {
    console.log(`🔌 RPC endpoint: ${RPC_URL}`);
  } else {
    console.log('🔌 RPC endpoint: using default for selected network');
  }
} else if (FACILITATOR_URL) {
  console.log(`🌐 Using custom facilitator: ${FACILITATOR_URL}`);
} else {
  console.log('🌐 Using default facilitator: https://x402.org/facilitator');
  console.log('⚠️  Note: Default facilitator only supports TESTNETS');
  console.log('   For mainnet, run your own facilitator: npm run start:facilitator');
  console.log('   Then set FACILITATOR_URL=http://localhost:4022');
}

console.log('🚀 x402 v2 Payment API initialized');
console.log(`💰 Payment address: ${PAY_TO_ADDRESS}`);
console.log(`🌐 Network: ${NETWORK}`);
console.log(`💵 Price per request: $0.10 USDC`);

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'x402-payment-api',
    version: '2.0.0',
    x402Version: 2,
    payment: {
      address: PAY_TO_ADDRESS,
      network: NETWORK,
      price: '$0.10',
    },
  });
});

/**
 * Main endpoint to process paid requests
 * This endpoint accepts A2A-compatible task submissions with x402 payments
 */
app.post('/process', async (req, res) => {
  try {
    console.log('\n📥 Received request');
    console.log('Request body:', JSON.stringify(req.body, null, 2));

    // Parse the incoming request
    const { message, taskId, contextId, metadata } = req.body;

    if (!message) {
      return res.status(400).json({
        error: 'Missing message in request body',
      });
    }

    // Create a task from the request
    const task: Task = {
      id: taskId || `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      contextId: contextId || `context-${Date.now()}`,
      status: {
        state: TaskState.INPUT_REQUIRED,
        message: message,
      },
      metadata: metadata || {},
    };

    // Create request context
    const context: RequestContext = {
      taskId: task.id,
      contextId: task.contextId,
      currentTask: task,
      message: message,
    };

    // Create event queue to collect responses
    const events: Task[] = [];
    const eventQueue: EventQueue = {
      enqueueEvent: async (event: Task) => {
        events.push(event);
      },
    };

    const paymentPayload = message.metadata?.['x402.payment.payload'] as
      | PaymentPayload
      | undefined;
    const paymentStatus = message.metadata?.['x402.payment.status'];

    // IMPORTANT - Check if payment is missing or not yet submitted
    // If not, we return a payment-required response with the payment requirements embedded in the task metadata.
    // This follows the A2A pattern where payment requirements are communicated through message metadata.
    if (!paymentPayload || paymentStatus !== 'payment-submitted') {
      const paymentRequired = merchantExecutor.createPaymentRequiredResponse();

      const responseMessage: Message = {
        messageId: `msg-${Date.now()}`,
        role: 'agent',
        parts: [
          {
            kind: 'text',
            text: 'Payment required. Please submit payment to continue.',
          },
        ],
        metadata: {
          'x402.payment.required': paymentRequired,
          'x402.payment.status': 'payment-required',
        },
      };

      task.status.state = TaskState.INPUT_REQUIRED;
      task.status.message = responseMessage;
      task.metadata = {
        ...(task.metadata || {}),
        'x402.payment.required': paymentRequired,
        'x402.payment.status': 'payment-required',
      };

      events.push(task);
      console.log('💰 Payment required for request processing');

      return res.json({
        success: false,
        error: 'Payment Required',
        task,
        events,
      });
    }

    // Verify the payment signature and authorization details (amount, recipient, timing) against the payment requirements.
    // This ensures the payment is cryptographically valid and matches what the merchant expects before processing the request.
    const verifyResult = await merchantExecutor.verifyPayment(paymentPayload);

    if (!verifyResult.isValid) {
      const errorReason = verifyResult.invalidReason || 'Invalid payment';
      task.status.state = TaskState.FAILED;
      task.status.message = {
        messageId: `msg-${Date.now()}`,
        role: 'agent',
        parts: [
          {
            kind: 'text',
            text: `Payment verification failed: ${errorReason}`,
          },
        ],
        metadata: {
          'x402.payment.status': 'payment-rejected',
          'x402.payment.error': errorReason,
        },
      };
      task.metadata = {
        ...(task.metadata || {}),
        'x402.payment.status': 'payment-rejected',
        'x402.payment.error': errorReason,
      };

      events.push(task);

      return res.status(402).json({
        error: 'Payment verification failed',
        reason: errorReason,
        task,
        events,
      });
    }

    task.metadata = {
      ...(task.metadata || {}),
      'x402_payment_verified': true,
      'x402.payment.status': 'payment-verified',
      ...(verifyResult.payer ? { 'x402.payment.payer': verifyResult.payer } : {}),
    };

    // Evaluate payment against policy middleware (if configured)
    if (policyMiddleware) {
      const policyContext = {
        payer: verifyResult.payer || 'unknown',
        amount: merchantExecutor.getPaymentRequirements().amount,
        network: merchantExecutor.getPaymentRequirements().network,
        asset: merchantExecutor.getPaymentRequirements().asset,
        payTo: merchantExecutor.getPaymentRequirements().payTo,
        timestamp: Date.now(),
      };

      const policyResult = await policyMiddleware.evaluate(policyContext);

      if (!policyResult.allowed) {
        console.log(`\u{1F6E1}\uFE0F  Payment blocked by policy: ${policyResult.reason}`);
        task.status.state = TaskState.FAILED;
        task.status.message = {
          messageId: `msg-${Date.now()}`,
          role: 'agent',
          parts: [
            {
              kind: 'text',
              text: `Payment blocked by policy: ${policyResult.reason}`,
            },
          ],
          metadata: {
            'x402.payment.status': 'payment-rejected',
            'x402.policy.reason': policyResult.reason,
          },
        };
        task.metadata = {
          ...(task.metadata || {}),
          'x402.payment.status': 'payment-rejected',
          'x402.policy.reason': policyResult.reason,
        };

        events.push(task);

        return res.status(403).json({
          error: 'Payment blocked by policy',
          reason: policyResult.reason,
          task,
          events,
        });
      }
    }

    // Execute the AI agent's core logic to process the user's request.
    // This calls the LLM (e.g., OpenAI) with the conversation context and streams
    // the response back through the event queue, updating the task with the AI's reply.
    await exampleService.execute(context, eventQueue);

    // Settle the payment on-chain by executing the transferWithAuthorization transaction.
    // This submits the signed authorization to the blockchain, transferring USDC from the payer
    // to the merchant's wallet. Returns settlement result with transaction hash and status.
    const settlement = await merchantExecutor.settlePayment(paymentPayload);

    // Update the task metadata with the payment status and settlement result.
    // This includes the transaction hash (if successful) and any error reason (if failed).
    task.metadata = {
      ...(task.metadata || {}),
      'x402.payment.status': settlement.success ? 'payment-completed' : 'payment-failed',
      ...(settlement.transaction
        ? { 'x402.payment.receipts': [settlement] }
        : {}),
      ...(settlement.errorReason
        ? { 'x402.payment.error': settlement.errorReason }
        : {}),
    };

    // Record the transaction in policy middleware for rate-limit tracking
    if (policyMiddleware && settlement.success) {
      policyMiddleware.recordTransaction({
        payer: verifyResult.payer || 'unknown',
        amount: merchantExecutor.getPaymentRequirements().amount,
        network: merchantExecutor.getPaymentRequirements().network,
        asset: merchantExecutor.getPaymentRequirements().asset,
        payTo: merchantExecutor.getPaymentRequirements().payTo,
        timestamp: Date.now(),
      });
    }

    if (events.length === 0) {
      events.push(task);
    }

    console.log('📤 Sending response\n');

    // Return the final response to the client, including the success/failure status,
    // the final task (with AI response and payment status), and the settlement result.
    // This completes the A2A flow by sending the AI's response back to the client.
    return res.json({
      success: settlement.success,
      task: events[events.length - 1],
      events,
      settlement,
    });
  } catch (error: any) {
    console.error('❌ Error processing request:', error);

    return res.status(500).json({
      error: error.message || 'Internal server error',
    });
  }
});

/**
 * Simple test endpoint to try the agent
 */
app.post('/test', async (req, res) => {
  const message: Message = {
    messageId: `msg-${Date.now()}`,
    role: 'user',
    parts: [
      {
        kind: 'text',
        text: req.body.text || 'Hello, tell me a joke!',
      },
    ],
  };

  try {
    const response = await fetch(`http://localhost:${PORT}/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// Start the server with async initialization
async function startServer() {
  await initializeMerchant();
  
  app.listen(PORT, () => {
    console.log(`\n✅ Server running on http://localhost:${PORT}`);
    console.log(`📖 Health check: http://localhost:${PORT}/health`);
    console.log(`🧪 Test endpoint: POST http://localhost:${PORT}/test`);
    console.log(`🚀 Main endpoint: POST http://localhost:${PORT}/process\n`);
  });
}

startServer().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
