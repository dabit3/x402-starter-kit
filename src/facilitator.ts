import { base58 } from '@scure/base';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Facilitator } from '@x402/core/facilitator';

// Polyfill BigInt serialization for JSON.stringify (required for Solana transactions)
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
  Network,
} from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { toFacilitatorSvmSigner } from '@x402/svm';
import { registerExactSvmScheme } from '@x402/svm/exact/facilitator';
import dotenv from 'dotenv';
import express from 'express';
import { createWalletClient, http, publicActions, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  base,
  baseSepolia,
  polygon,
  polygonAmoy,
  avalanche,
  avalancheFuji,
  iotex,
  sei,
  seiTestnet,
} from 'viem/chains';

dotenv.config();

// Configuration
const PORT = process.env.FACILITATOR_PORT || '4022';

// Network configuration
const EVM_NETWORK = process.env.FACILITATOR_EVM_NETWORK || 'base-sepolia';
const SVM_NETWORK = process.env.FACILITATOR_SVM_NETWORK || 'solana-devnet';

// Map network names to viem chains
const VIEM_CHAINS: Record<string, Chain> = {
  'base': base,
  'base-sepolia': baseSepolia,
  'polygon': polygon,
  'polygon-amoy': polygonAmoy,
  'avalanche': avalanche,
  'avalanche-fuji': avalancheFuji,
  'iotex': iotex,
  'sei': sei,
  'sei-testnet': seiTestnet,
};

// Map network names to CAIP-2 format
const NETWORK_TO_CAIP2: Record<string, string> = {
  'base': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  'polygon': 'eip155:137',
  'polygon-amoy': 'eip155:80002',
  'avalanche': 'eip155:43114',
  'avalanche-fuji': 'eip155:43113',
  'iotex': 'eip155:4689',
  'sei': 'eip155:1329',
  'sei-testnet': 'eip155:1328',
  'solana': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};

// Reverse map: CAIP-2 to legacy network name
const CAIP2_TO_LEGACY: Record<string, string> = Object.fromEntries(
  Object.entries(NETWORK_TO_CAIP2).map(([legacy, caip2]) => [caip2, legacy])
);

function getEvmCaip2Network(network: string): Network {
  if (network.startsWith('eip155:')) return network as Network;
  return (NETWORK_TO_CAIP2[network] || `eip155:${network}`) as Network;
}

function getSvmCaip2Network(network: string): Network {
  if (network.startsWith('solana:')) return network as Network;
  return (NETWORK_TO_CAIP2[network] || network) as Network;
}

/**
 * Parse payment errors and provide helpful, actionable error messages.
 * Handles common Solana and EVM payment failures.
 */
function parsePaymentError(error: unknown, network?: string): {
  message: string;
  suggestion: string;
  code: string;
} {
  const errorStr = error instanceof Error ? error.message : String(error);
  const errorJson = JSON.stringify(error);
  const isSolana = network?.startsWith('solana:') || errorStr.includes('solana') || errorStr.includes('Solana');
  
  // Solana-specific errors
  if (errorStr.includes('InvalidAccountData') || errorJson.includes('InvalidAccountData')) {
    return {
      code: 'INVALID_ACCOUNT_DATA',
      message: 'One or more Solana accounts are not properly initialized',
      suggestion: isSolana 
        ? `🔧 FIX: One of the wallets is missing a USDC token account (ATA).
   
   Check these accounts:
   1. Client wallet - needs USDC ATA + USDC balance
   2. Merchant wallet (payTo) - needs USDC ATA
   3. Facilitator wallet - needs USDC ATA + SOL for fees
   
   To create a USDC ATA on devnet:
     spl-token create-account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --owner <WALLET_ADDRESS>
   
   Or use: https://spl-token-faucet.com for devnet USDC`
        : 'Ensure all wallet accounts have the required token accounts initialized.',
    };
  }

  if (errorStr.includes('InsufficientFunds') || errorStr.includes('insufficient lamports') || 
      (errorStr.includes('Insufficient') && errorStr.includes('SOL'))) {
    return {
      code: 'INSUFFICIENT_SOL',
      message: 'Not enough SOL for transaction fees',
      suggestion: isSolana 
        ? `🔧 FIX: The transaction fee payer needs more SOL.
   
   For devnet, get SOL from: https://faucet.solana.com
   For mainnet, you need to purchase SOL.
   
   Recommended: At least 0.01 SOL for transaction fees.`
        : 'Ensure the fee payer wallet has enough native tokens for gas fees.',
    };
  }

  if (errorStr.includes('insufficient funds') || errorStr.includes('exceeds balance') ||
      errorStr.includes('Insufficient USDC') || errorStr.includes('insufficient token')) {
    return {
      code: 'INSUFFICIENT_USDC',
      message: 'Not enough USDC tokens for the payment',
      suggestion: isSolana 
        ? `🔧 FIX: The client wallet doesn't have enough USDC.
   
   Required amount: Check the payment requirements.
   
   For devnet USDC:
     - Use spl-token-faucet.com to get test USDC
     - Or manually mint devnet USDC tokens
   
   For mainnet: Purchase USDC and transfer to your wallet.`
        : 'Ensure the payer wallet has sufficient USDC balance.',
    };
  }

  if (errorStr.includes('AccountNotFound') || errorStr.includes('account not found')) {
    return {
      code: 'ACCOUNT_NOT_FOUND',
      message: 'Required account does not exist on-chain',
      suggestion: isSolana 
        ? `🔧 FIX: The wallet account doesn't exist on the network.
   
   For a new wallet, you need to:
   1. Fund it with some SOL first (this creates the account)
   2. Create the USDC token account
   
   For devnet: https://faucet.solana.com`
        : 'Ensure the wallet exists and has been funded.',
    };
  }

  if (errorStr.includes('BlockhashNotFound') || errorStr.includes('blockhash not found') ||
      errorStr.includes('TransactionExpiredBlockheightExceeded')) {
    return {
      code: 'TRANSACTION_EXPIRED',
      message: 'Transaction expired before it could be processed',
      suggestion: `🔧 FIX: The transaction took too long and expired.
   
   This can happen due to:
   - Network congestion
   - Slow RPC node
   - Transaction created too long ago
   
   Try again with a fresh transaction.`,
    };
  }

  if (errorStr.includes('simulation failed') || errorStr.includes('transaction_simulation_failed')) {
    // Try to extract more specific error from simulation
    const instructionErrorMatch = errorJson.match(/InstructionError.*?"(\w+)"/);
    if (instructionErrorMatch) {
      const innerError = instructionErrorMatch[1];
      const innerResult = parsePaymentError(new Error(innerError), network);
      if (innerResult.code !== 'UNKNOWN_ERROR') {
        return innerResult;
      }
    }
    
    return {
      code: 'SIMULATION_FAILED',
      message: 'Transaction simulation failed before sending',
      suggestion: `🔧 FIX: The transaction would fail if sent. Common causes:
   
   1. Missing token accounts (ATAs)
   2. Insufficient token balance
   3. Insufficient SOL for fees
   4. Invalid transaction parameters
   
   Check all wallet balances and token accounts.`,
    };
  }

  // EVM-specific errors
  if (errorStr.includes('insufficient funds for gas') || errorStr.includes('gas required exceeds allowance')) {
    return {
      code: 'INSUFFICIENT_GAS',
      message: 'Not enough native tokens for gas fees',
      suggestion: `🔧 FIX: The wallet needs more native tokens (ETH/MATIC/etc.) for gas.
   
   For testnets, use a faucet to get test tokens.
   For mainnet, ensure sufficient balance for gas fees.`,
    };
  }

  if (errorStr.includes('transfer amount exceeds balance') || errorStr.includes('ERC20: transfer amount exceeds balance')) {
    return {
      code: 'INSUFFICIENT_ERC20',
      message: 'Not enough USDC tokens for the transfer',
      suggestion: `🔧 FIX: The payer wallet doesn't have enough USDC.
   
   Check the wallet USDC balance and ensure it covers:
   - Payment amount
   - Any fees`,
    };
  }

  if (errorStr.includes('execution reverted') || errorStr.includes('transaction reverted')) {
    return {
      code: 'TRANSACTION_REVERTED',
      message: 'Transaction was reverted by the smart contract',
      suggestion: `🔧 FIX: The smart contract rejected the transaction. Common causes:
   
   1. Invalid signature or authorization
   2. Expired authorization (check validBefore timestamp)
   3. Already used nonce
   4. Insufficient allowance`,
    };
  }

  // Generic fallback
  return {
    code: 'UNKNOWN_ERROR',
    message: errorStr,
    suggestion: 'Check the error details above for more information.',
  };
}

async function startFacilitator() {
  const hasEvmKey = !!process.env.EVM_PRIVATE_KEY;
  const hasSvmKey = !!process.env.SVM_PRIVATE_KEY;

  // Validate that at least one key is provided
  if (!hasEvmKey && !hasSvmKey) {
    console.error('❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required');
    console.error('');
    console.error('   To enable EVM payments:');
    console.error('     EVM_PRIVATE_KEY=0x...');
    console.error('     FACILITATOR_EVM_NETWORK=base-sepolia  (optional, default: base-sepolia)');
    console.error('');
    console.error('   To enable Solana payments:');
    console.error('     SVM_PRIVATE_KEY=<base58 or JSON array>');
    console.error('     FACILITATOR_SVM_NETWORK=solana-devnet  (optional, default: solana-devnet)');
    console.error('');
    console.error('   You can set both to enable EVM + Solana payments.');
    process.exit(1);
  }

  // Initialize the x402 Facilitator with lifecycle hooks for logging
  const facilitator = new x402Facilitator()
    .onBeforeVerify(async (context) => {
      console.log('🔍 Verifying payment...', {
        network: context.requirements.network,
        amount: context.requirements.amount,
        payTo: context.requirements.payTo,
      });
    })
    .onAfterVerify(async (context) => {
      console.log('✅ Payment verified:', {
        isValid: context.result.isValid,
        payer: context.result.payer,
      });
    })
    .onVerifyFailure(async (context) => {
      const parsed = parsePaymentError(context.error, context.requirements?.network);
      console.log('\n❌ Verify failure:');
      console.log(`   Code: ${parsed.code}`);
      console.log(`   Message: ${parsed.message}`);
      if (parsed.code !== 'UNKNOWN_ERROR') {
        console.log(`\n${parsed.suggestion}`);
      }
    })
    .onBeforeSettle(async (context) => {
      console.log('💰 Settling payment...', {
        network: context.requirements.network,
        amount: context.requirements.amount,
      });
    })
    .onAfterSettle(async (context) => {
      console.log('✅ Payment settled:', {
        success: context.result.success,
        transaction: context.result.transaction,
        network: context.result.network,
      });
    })
    .onSettleFailure(async (context) => {
      const parsed = parsePaymentError(context.error, context.requirements?.network);
      console.log('\n❌ Settle failure:');
      console.log(`   Code: ${parsed.code}`);
      console.log(`   Message: ${parsed.message}`);
      if (parsed.code !== 'UNKNOWN_ERROR') {
        console.log(`\n${parsed.suggestion}`);
      }
    });

  // Track enabled networks for health endpoint
  let evmCaip2: Network | null = null;
  let svmCaip2: Network | null = null;
  let evmAddress: string | null = null;
  let svmAddress: string | null = null;

  // =========================================================================
  // Initialize EVM if key is provided
  // =========================================================================
  if (hasEvmKey) {
    const evmRpcUrl = process.env.FACILITATOR_EVM_RPC_URL;
    // Support both legacy names and CAIP-2 format for network config
    const evmLegacyNetwork = CAIP2_TO_LEGACY[EVM_NETWORK] ?? EVM_NETWORK;
    const viemChain = VIEM_CHAINS[evmLegacyNetwork];
    
    if (!viemChain && !evmRpcUrl) {
      console.error(`❌ Unknown EVM network "${EVM_NETWORK}" and no FACILITATOR_EVM_RPC_URL provided`);
      console.error('   Supported networks: base, base-sepolia, polygon, polygon-amoy, avalanche, avalanche-fuji, iotex, sei, sei-testnet');
      console.error('   Or use CAIP-2 format: eip155:8453, eip155:84532, etc.');
      process.exit(1);
    }

    const evmPrivateKey = process.env.EVM_PRIVATE_KEY!.startsWith('0x')
      ? process.env.EVM_PRIVATE_KEY as `0x${string}`
      : `0x${process.env.EVM_PRIVATE_KEY}` as `0x${string}`;
    
    const evmAccount = privateKeyToAccount(evmPrivateKey);
    evmAddress = evmAccount.address;
    console.log(`💼 EVM Facilitator account: ${evmAccount.address}`);

    // Create a Viem client with both wallet and public capabilities
    const viemClient = createWalletClient({
      account: evmAccount,
      chain: viemChain,
      transport: http(evmRpcUrl),
    }).extend(publicActions);

    // Create EVM signer for facilitator
    const evmSigner = toFacilitatorEvmSigner({
      getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
      address: evmAccount.address,
      readContract: (args: {
        address: `0x${string}`;
        abi: readonly unknown[];
        functionName: string;
        args?: readonly unknown[];
      }) =>
        viemClient.readContract({
          ...args,
          args: args.args || [],
        }),
      verifyTypedData: (args: {
        address: `0x${string}`;
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
        signature: `0x${string}`;
      }) => viemClient.verifyTypedData(args as any),
      writeContract: (args: {
        address: `0x${string}`;
        abi: readonly unknown[];
        functionName: string;
        args: readonly unknown[];
      }) =>
        viemClient.writeContract({
          ...args,
          chain: viemChain,
          args: args.args || [],
        } as any),
      sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
        viemClient.sendTransaction({
          ...args,
          chain: viemChain,
        } as any),
      waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
        viemClient.waitForTransactionReceipt(args),
    });

    // Register EVM scheme
    evmCaip2 = getEvmCaip2Network(EVM_NETWORK);
    registerExactEvmScheme(facilitator, {
      signer: evmSigner,
      networks: evmCaip2,
    });
    console.log(`🔗 Registered EVM network: ${evmCaip2}`);
  }

  // =========================================================================
  // Initialize SVM if key is provided
  // =========================================================================
  if (hasSvmKey) {
    let svmKeyBytes: Uint8Array;
    const svmKey = process.env.SVM_PRIVATE_KEY!;
    
    // Try to decode SVM private key from various formats
    try {
      if (svmKey.startsWith('[')) {
        // JSON array format
        svmKeyBytes = new Uint8Array(JSON.parse(svmKey));
      } else {
        // Base58 format (default Solana format)
        svmKeyBytes = base58.decode(svmKey);
      }
    } catch (error) {
      console.error('❌ Failed to decode SVM_PRIVATE_KEY');
      console.error('   Supported formats: Base58, JSON array');
      process.exit(1);
    }
    
    const svmAccount = await createKeyPairSignerFromBytes(svmKeyBytes);
    svmAddress = svmAccount.address;
    console.log(`💼 SVM Facilitator account: ${svmAccount.address}`);

    // Create SVM signer for facilitator
    const svmSigner = toFacilitatorSvmSigner(svmAccount);

    // Register SVM scheme
    svmCaip2 = getSvmCaip2Network(SVM_NETWORK);
    registerExactSvmScheme(facilitator, {
      signer: svmSigner,
      networks: svmCaip2,
    });
    console.log(`🔗 Registered SVM network: ${svmCaip2}`);
  }

  // =========================================================================
  // Initialize Express app
  // =========================================================================
  const app = express();
  app.use(express.json());

  /**
   * POST /verify
   * Verify a payment against requirements
   */
  app.post('/verify', async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };

      if (!paymentPayload || !paymentRequirements) {
        return res.status(400).json({
          error: 'Missing paymentPayload or paymentRequirements',
        });
      }

      const response: VerifyResponse = await facilitator.verify(
        paymentPayload,
        paymentRequirements,
      );

      res.json(response);
    } catch (error) {
      const network = req.body?.paymentRequirements?.network || req.body?.paymentPayload?.network;
      const parsed = parsePaymentError(error, network);
      
      console.error('\n❌ Verify endpoint error:');
      console.error(`   Code: ${parsed.code}`);
      console.error(`   Message: ${parsed.message}`);
      if (parsed.code !== 'UNKNOWN_ERROR') {
        console.error(`\n${parsed.suggestion}`);
      }

      res.status(500).json({
        error: parsed.message,
        code: parsed.code,
        suggestion: parsed.suggestion,
        rawError: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /settle
   * Settle a payment on-chain
   */
  app.post('/settle', async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body;

      if (!paymentPayload || !paymentRequirements) {
        return res.status(400).json({
          error: 'Missing paymentPayload or paymentRequirements',
        });
      }

      const response: SettleResponse = await facilitator.settle(
        paymentPayload as PaymentPayload,
        paymentRequirements as PaymentRequirements,
      );

      res.json(response);
    } catch (error) {
      const network = req.body?.paymentRequirements?.network || req.body?.paymentPayload?.network;
      const parsed = parsePaymentError(error, network);
      
      console.error('\n❌ Settle endpoint error:');
      console.error(`   Code: ${parsed.code}`);
      console.error(`   Message: ${parsed.message}`);
      if (parsed.code !== 'UNKNOWN_ERROR') {
        console.error(`\n${parsed.suggestion}`);
      }

      // Check if this was an abort from hook
      if (
        error instanceof Error &&
        error.message.includes('Settlement aborted:')
      ) {
        return res.json({
          success: false,
          errorReason: error.message.replace('Settlement aborted: ', ''),
          network: network || 'unknown',
        } as SettleResponse);
      }

      res.status(500).json({
        error: parsed.message,
        code: parsed.code,
        suggestion: parsed.suggestion,
        rawError: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /supported
   * Get supported payment kinds and extensions
   */
  app.get('/supported', async (req, res) => {
    try {
      const response = facilitator.getSupported();
      res.json(response);
    } catch (error) {
      console.error('Supported error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /health
   * Health check endpoint
   */
  app.get('/health', (req, res) => {
    const networks: Record<string, any> = {};
    
    if (evmCaip2) {
      networks.evm = {
        network: evmCaip2,
        address: evmAddress,
      };
    }
    
    if (svmCaip2) {
      networks.svm = {
        network: svmCaip2,
        address: svmAddress,
      };
    }

    res.json({
      status: 'healthy',
      service: 'x402-facilitator',
      networks,
    });
  });

  // Start the server
  app.listen(parseInt(PORT), () => {
    console.log(`\n✅ x402 Facilitator running on http://localhost:${PORT}`);
    console.log(`📖 Health check: http://localhost:${PORT}/health`);
    console.log(`🔗 Supported: http://localhost:${PORT}/supported`);
    console.log(`\n🌐 Enabled networks:`);
    if (evmCaip2) {
      console.log(`   ✅ EVM: ${evmCaip2} (${EVM_NETWORK})`);
    } else {
      console.log(`   ❌ EVM: Not configured (set EVM_PRIVATE_KEY to enable)`);
    }
    if (svmCaip2) {
      console.log(`   ✅ SVM: ${svmCaip2} (${SVM_NETWORK})`);
    } else {
      console.log(`   ❌ SVM: Not configured (set SVM_PRIVATE_KEY to enable)`);
    }
    console.log(`\n💡 To use this facilitator, set in your .env:`);
    console.log(`   FACILITATOR_URL=http://localhost:${PORT}`);
  });
}

startFacilitator().catch((error) => {
  console.error('❌ Failed to start facilitator:', error);
  process.exit(1);
});
