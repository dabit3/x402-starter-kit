import { ethers } from 'ethers';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme, registerExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme, registerExactSvmScheme } from '@x402/svm/exact/server';
import type {
  PaymentPayload,
  PaymentRequirements,
  Network,
} from '@x402/core/types';

// NOTE: The default x402 facilitator only supports TESTNETS
// For mainnet support, you need to run your own facilitator or use direct settlement (EVM only)
const DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';

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

const TRANSFER_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

export type SettlementMode = 'facilitator' | 'direct';

// Map legacy network names to eip155 CAIP-2 format
const NETWORK_MAP: Record<string, string> = {
  'base': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  'polygon': 'eip155:137',
  'polygon-amoy': 'eip155:80002',
  'avalanche': 'eip155:43114',
  'avalanche-fuji': 'eip155:43113',
  'iotex': 'eip155:4689',
  'sei': 'eip155:1329',
  'sei-testnet': 'eip155:1328',
  'peaq': 'eip155:3338',
  'solana': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};

// Reverse map: CAIP-2 to legacy network name
const CAIP2_TO_LEGACY: Record<string, string> = Object.fromEntries(
  Object.entries(NETWORK_MAP).map(([legacy, caip2]) => [caip2, legacy])
);

type LegacyNetwork =
  | 'base'
  | 'base-sepolia'
  | 'polygon'
  | 'polygon-amoy'
  | 'avalanche-fuji'
  | 'avalanche'
  | 'iotex'
  | 'sei'
  | 'sei-testnet'
  | 'peaq'
  | 'solana-devnet'
  | 'solana';

const BUILT_IN_NETWORKS: Record<
  LegacyNetwork,
  {
    chainId?: number;
    assetAddress: string;
    assetName: string;
    explorer?: string;
  }
> = {
  base: {
    chainId: 8453,
    assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    assetName: 'USD Coin',
    explorer: 'https://basescan.org',
  },
  'base-sepolia': {
    chainId: 84532,
    assetAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    assetName: 'USDC',
    explorer: 'https://sepolia.basescan.org',
  },
  polygon: {
    chainId: 137,
    assetAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    assetName: 'USD Coin',
    explorer: 'https://polygonscan.com',
  },
  'polygon-amoy': {
    chainId: 80002,
    assetAddress: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
    assetName: 'USDC',
    explorer: 'https://amoy.polygonscan.com',
  },
  'avalanche-fuji': {
    chainId: 43113,
    assetAddress: '0x5425890298aed601595a70AB815c96711a31Bc65',
    assetName: 'USD Coin',
    explorer: 'https://testnet.snowtrace.io',
  },
  avalanche: {
    chainId: 43114,
    assetAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    assetName: 'USD Coin',
    explorer: 'https://snowtrace.io',
  },
  iotex: {
    chainId: 4689,
    assetAddress: '0xcdf79194c6c285077a58da47641d4dbe51f63542',
    assetName: 'Bridged USDC',
    explorer: 'https://iotexscan.io',
  },
  sei: {
    chainId: 1329,
    assetAddress: '0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392',
    assetName: 'USDC',
    explorer: 'https://sei.explorers.guru',
  },
  'sei-testnet': {
    chainId: 1328,
    assetAddress: '0x4fcf1784b31630811181f670aea7a7bef803eaed',
    assetName: 'USDC',
    explorer: 'https://testnet.sei.explorers.guru',
  },
  peaq: {
    chainId: 3338,
    assetAddress: '0xbbA60da06c2c5424f03f7434542280FCAd453d10',
    assetName: 'USDC',
    explorer: 'https://scan.peaq.network',
  },
  'solana-devnet': {
    assetAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    assetName: 'USDC',
    explorer: 'https://explorer.solana.com/?cluster=devnet',
  },
  solana: {
    assetAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    assetName: 'USDC',
    explorer: 'https://explorer.solana.com',
  },
};

export interface MerchantExecutorOptions {
  payToAddress: string;
  network: string; // Can be legacy format or new CAIP-2 format
  price: number;
  facilitatorUrl?: string;
  facilitatorApiKey?: string;
  resourceUrl?: string;
  settlementMode?: SettlementMode;
  rpcUrl?: string;
  privateKey?: string;
  assetAddress?: string;
  assetName?: string;
  explorerUrl?: string;
  chainId?: number;
}

export interface VerifyResult {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}

export interface SettlementResult {
  success: boolean;
  transaction?: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

export class MerchantExecutor {
  private requirements: PaymentRequirements;
  private readonly explorerUrl?: string;
  private readonly mode: SettlementMode;
  private readonly facilitatorUrl?: string;
  private readonly facilitatorApiKey?: string;
  private settlementProvider?: ethers.JsonRpcProvider;
  private settlementWallet?: ethers.Wallet;
  private readonly network: Network;
  private readonly legacyNetwork: string;
  private readonly assetName: string;
  private readonly chainId?: number;
  private resourceServer?: x402ResourceServer;

  constructor(options: MerchantExecutorOptions) {
    // Convert legacy network name to CAIP-2 format if needed
    // Also resolve CAIP-2 input to legacy name for built-in config lookup
    const legacyKey = CAIP2_TO_LEGACY[options.network] ?? options.network;
    this.legacyNetwork = legacyKey;
    this.network = this.toCAIP2Network(options.network);

    // Look up built-in config by legacy name
    const builtinConfig = BUILT_IN_NETWORKS[
      legacyKey as LegacyNetwork
    ] as (typeof BUILT_IN_NETWORKS)[LegacyNetwork] | undefined;

    const assetAddress =
      options.assetAddress ?? builtinConfig?.assetAddress;
    const assetName = options.assetName ?? builtinConfig?.assetName;
    const chainId = options.chainId ?? builtinConfig?.chainId;
    const explorerUrl = options.explorerUrl ?? builtinConfig?.explorer;

    if (!assetAddress) {
      throw new Error(
        `Asset address must be provided for network "${options.network}". Set ASSET_ADDRESS in the environment.`
      );
    }

    if (!assetName) {
      throw new Error(
        `Asset name must be provided for network "${options.network}". Set ASSET_NAME in the environment.`
      );
    }

    this.assetName = assetName;
    this.chainId = chainId;
    this.explorerUrl = explorerUrl;

    // Build x402 v2 payment requirements
    this.requirements = {
      scheme: 'exact',
      network: this.network,
      asset: assetAddress,
      payTo: options.payToAddress,
      amount: this.getAtomicAmount(options.price),
      maxTimeoutSeconds: 600,
      extra: {
        name: assetName,
        version: '2',
      },
    };

    this.mode =
      options.settlementMode ??
      (options.facilitatorUrl || !options.privateKey ? 'facilitator' : 'direct');

    if (this.mode === 'direct') {
      if (options.network === 'solana' || options.network === 'solana-devnet' ||
          this.network.startsWith('solana:')) {
        throw new Error(
          'Direct settlement is only supported on EVM networks.'
        );
      }

      if (!options.privateKey) {
        throw new Error(
          'Direct settlement requires PRIVATE_KEY to be configured.'
        );
      }

      const normalizedKey = options.privateKey.startsWith('0x')
        ? options.privateKey
        : `0x${options.privateKey}`;

      const rpcUrl = options.rpcUrl || this.getDefaultRpcUrl(options.network);

      if (!rpcUrl) {
        throw new Error(
          `Direct settlement requires an RPC URL for network "${options.network}".`
        );
      }

      if (typeof chainId !== 'number') {
        throw new Error(
          `Direct settlement requires a numeric CHAIN_ID for network "${options.network}".`
        );
      }

      try {
        this.settlementProvider = new ethers.JsonRpcProvider(rpcUrl);
        this.settlementWallet = new ethers.Wallet(
          normalizedKey,
          this.settlementProvider
        );
        console.log('⚡ Local settlement enabled via RPC provider');
      } catch (error) {
        throw new Error(
          `Failed to initialize direct settlement: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } else {
      this.facilitatorUrl = options.facilitatorUrl || DEFAULT_FACILITATOR_URL;
      this.facilitatorApiKey = options.facilitatorApiKey;
    }
  }

  /**
   * Initialize the resource server (async initialization for facilitator mode)
   */
  async initialize(): Promise<void> {
    if (this.mode === 'facilitator') {
      const facilitatorClient = new HTTPFacilitatorClient({
        url: this.facilitatorUrl!,
        ...(this.facilitatorApiKey && {
          headers: { Authorization: `Bearer ${this.facilitatorApiKey}` },
        }),
      });

      this.resourceServer = new x402ResourceServer(facilitatorClient);
      
      // Register EVM scheme (eip155:* covers all EVM chains)
      registerExactEvmScheme(this.resourceServer);
      
      // Register SVM scheme (solana:* covers Solana mainnet and devnet)
      registerExactSvmScheme(this.resourceServer);

      try {
        await this.resourceServer.initialize();
        console.log('✅ x402 Resource Server initialized with facilitator');
      } catch (error) {
        // Non-fatal: facilitator might not be reachable yet, but we can still start
        console.warn('⚠️  Could not initialize with facilitator (will retry on first request)');
      }

      // For Solana networks, fetch the feePayer from the facilitator
      if (this.network.startsWith('solana:')) {
        await this.fetchSolanaFeePayer();
      }
    }
  }

  /**
   * Fetch the feePayer address from the facilitator for Solana networks
   */
  private async fetchSolanaFeePayer(): Promise<void> {
    try {
      const response = await fetch(`${this.facilitatorUrl}/supported`, {
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        console.warn('⚠️  Could not fetch facilitator supported kinds for feePayer');
        console.warn('   Solana payments will not work until facilitator is available');
        return;
      }

      const supported = await response.json() as {
        kinds?: Array<{
          scheme: string;
          network: string;
          extra?: { feePayer?: string };
        }>;
      };

      // Find a matching Solana network
      const solanaKind = supported.kinds?.find(
        (k) => k.network === this.network || k.network.startsWith('solana:')
      );

      if (solanaKind?.extra?.feePayer) {
        // Update requirements with feePayer
        this.requirements = {
          ...this.requirements,
          extra: {
            ...this.requirements.extra,
            feePayer: solanaKind.extra.feePayer,
          },
        };
        console.log(`💰 Solana feePayer set: ${solanaKind.extra.feePayer}`);
      } else {
        console.warn('⚠️  Facilitator did not provide a feePayer for Solana');
        console.warn('   Make sure your facilitator has SVM_PRIVATE_KEY configured');
        console.warn('   Solana payments will not work until feePayer is available');
      }
    } catch (error) {
      // More user-friendly error message
      if ((error as any)?.cause?.code === 'ECONNREFUSED') {
        console.warn('⚠️  Facilitator not reachable at', this.facilitatorUrl);
        console.warn('   Start the facilitator first: npm run start:facilitator');
        console.warn('   Or set FACILITATOR_URL to point to your running facilitator');
      } else {
        console.warn('⚠️  Failed to fetch feePayer from facilitator:', 
          error instanceof Error ? error.message : error);
      }
      console.warn('   Solana payments will not work until facilitator is available');
    }
  }

  private toCAIP2Network(network: string): Network {
    // If already in CAIP-2 format, return as-is
    if (network.includes(':')) {
      return network as Network;
    }
    // Convert legacy format to CAIP-2
    const caip2 = NETWORK_MAP[network];
    if (!caip2) {
      throw new Error(
        `Unknown network "${network}". Use CAIP-2 format (e.g., eip155:8453) or a supported legacy name.`
      );
    }
    return caip2 as Network;
  }

  getPaymentRequirements(): PaymentRequirements {
    return this.requirements;
  }

  createPaymentRequiredResponse() {
    return {
      x402Version: 2,
      accepts: [this.requirements],
      error: 'Payment required for service: /process-request',
      resource: {
        description: 'AI request processing service',
        mimeType: 'application/json',
      },
    };
  }

  async verifyPayment(payload: PaymentPayload): Promise<VerifyResult> {
    console.log('\n🔍 Verifying payment...');
    console.log(`   Network: ${(payload as any).accepted?.network || this.network}`);
    console.log(`   Scheme: ${(payload as any).accepted?.scheme || 'exact'}`);
    console.log(`   From: ${(payload.payload as any).authorization?.from}`);
    console.log(`   To: ${this.requirements.payTo}`);
    console.log(`   Amount: ${this.requirements.amount}`);

    try {
      const result =
        this.mode === 'direct'
          ? this.verifyPaymentLocally(payload, this.requirements)
          : await this.callFacilitator<VerifyResult>('verify', payload);

      console.log('\n📋 Verification result:');
      console.log(`   Valid: ${result.isValid}`);
      if (!result.isValid) {
        console.log(`   ❌ Reason: ${result.invalidReason}`);
      }

      return result;
    } catch (error) {
      const parsed = parsePaymentError(error, this.network);
      console.error(`\n❌ Verification failed:`);
      console.error(`   Code: ${parsed.code}`);
      console.error(`   Message: ${parsed.message}`);
      if (parsed.code !== 'UNKNOWN_ERROR') {
        console.error(`\n${parsed.suggestion}`);
      }
      return {
        isValid: false,
        invalidReason: parsed.message,
      };
    }
  }

  async settlePayment(payload: PaymentPayload): Promise<SettlementResult> {
    console.log('\n💰 Settling payment...');
    console.log(`   Network: ${this.network}`);
    console.log(`   Amount: ${this.requirements.amount} (micro units)`);
    console.log(`   Pay to: ${this.requirements.payTo}`);

    try {
      const result =
        this.mode === 'direct'
          ? await this.settleOnChain(payload, this.requirements)
          : await this.callFacilitator<SettlementResult>('settle', payload);

      console.log('\n✅ Payment settlement result:');
      console.log(`   Success: ${result.success}`);
      console.log(`   Network: ${result.network}`);
      if (result.transaction) {
        console.log(`   Transaction: ${result.transaction}`);
        if (this.explorerUrl) {
          console.log(
            `   Explorer: ${this.explorerUrl}/tx/${result.transaction}`
          );
        }
      }
      if (result.payer) {
        console.log(`   Payer: ${result.payer}`);
      }
      if (result.errorReason) {
        console.log(`   Error: ${result.errorReason}`);
      }

      return result;
    } catch (error) {
      const parsed = parsePaymentError(error, this.network);
      console.error(`\n❌ Settlement failed:`);
      console.error(`   Code: ${parsed.code}`);
      console.error(`   Message: ${parsed.message}`);
      if (parsed.code !== 'UNKNOWN_ERROR') {
        console.error(`\n${parsed.suggestion}`);
      }
      return {
        success: false,
        network: this.network,
        errorReason: parsed.message,
      };
    }
  }

  private verifyPaymentLocally(
    payload: PaymentPayload,
    requirements: PaymentRequirements
  ): VerifyResult {
    const exactPayload = payload.payload as any;
    const authorization = exactPayload?.authorization;
    const signature = exactPayload?.signature;

    if (!authorization || !signature) {
      return {
        isValid: false,
        invalidReason: 'Missing payment authorization data',
      };
    }

    // Handle v2 payload structure (accepted field) or v1 structure (network field)
    const payloadNetwork = (payload as any).accepted?.network || (payload as any).network;
    if (payloadNetwork !== requirements.network) {
      return {
        isValid: false,
        invalidReason: `Network mismatch: ${payloadNetwork} vs ${requirements.network}`,
      };
    }

    if (
      authorization.to?.toLowerCase() !== requirements.payTo.toLowerCase()
    ) {
      return {
        isValid: false,
        invalidReason: 'Authorization recipient does not match payment requirement',
      };
    }

    try {
      const requiredAmount = BigInt(requirements.amount);
      const authorizedAmount = BigInt(authorization.value);
      if (authorizedAmount < requiredAmount) {
        return {
          isValid: false,
          invalidReason: 'Authorized amount is less than required amount',
        };
      }
    } catch {
      return {
        isValid: false,
        invalidReason: 'Invalid payment amount provided',
      };
    }

    const validAfterNum = Number(authorization.validAfter ?? 0);
    const validBeforeNum = Number(authorization.validBefore ?? 0);
    if (Number.isNaN(validAfterNum) || Number.isNaN(validBeforeNum)) {
      return {
        isValid: false,
        invalidReason: 'Invalid authorization timing fields',
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (validAfterNum > now) {
      return {
        isValid: false,
        invalidReason: 'Payment authorization is not yet valid',
      };
    }
    if (validBeforeNum <= now) {
      return {
        isValid: false,
        invalidReason: 'Payment authorization has expired',
      };
    }

    try {
      const domain = this.buildEip712Domain(requirements);
      const recovered = ethers.verifyTypedData(
        domain,
        TRANSFER_AUTH_TYPES,
        {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value,
          validAfter: authorization.validAfter,
          validBefore: authorization.validBefore,
          nonce: authorization.nonce,
        },
        signature
      );

      if (recovered.toLowerCase() !== authorization.from.toLowerCase()) {
        return {
          isValid: false,
          invalidReason: 'Signature does not match payer address',
        };
      }

      return {
        isValid: true,
        payer: recovered,
      };
    } catch (error) {
      return {
        isValid: false,
        invalidReason: `Signature verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  private async settleOnChain(
    payload: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<SettlementResult> {
    if (!this.settlementWallet) {
      return {
        success: false,
        network: requirements.network,
        errorReason: 'Settlement wallet not configured',
      };
    }

    const exactPayload = payload.payload as any;
    const authorization = exactPayload?.authorization;
    const signature = exactPayload?.signature;

    if (!authorization || !signature) {
      return {
        success: false,
        network: requirements.network,
        errorReason: 'Missing payment authorization data',
      };
    }

    try {
      const usdcContract = new ethers.Contract(
        requirements.asset,
        [
          'function transferWithAuthorization(' +
            'address from,' +
            'address to,' +
            'uint256 value,' +
            'uint256 validAfter,' +
            'uint256 validBefore,' +
            'bytes32 nonce,' +
            'uint8 v,' +
            'bytes32 r,' +
            'bytes32 s' +
          ') external returns (bool)',
        ],
        this.settlementWallet
      );

      const parsedSignature = ethers.Signature.from(signature);
      const tx = await usdcContract.transferWithAuthorization(
        authorization.from,
        authorization.to,
        authorization.value,
        authorization.validAfter,
        authorization.validBefore,
        authorization.nonce,
        parsedSignature.v,
        parsedSignature.r,
        parsedSignature.s
      );

      const receipt = await tx.wait();
      const success = receipt?.status === 1;

      return {
        success,
        transaction: receipt?.hash,
        network: requirements.network,
        payer: authorization.from,
        errorReason: success ? undefined : 'Transaction reverted',
      };
    } catch (error) {
      return {
        success: false,
        network: requirements.network,
        payer: authorization.from,
        errorReason:
          error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getAtomicAmount(priceUsd: number): string {
    const atomicUnits = Math.floor(priceUsd * 1_000_000);
    return atomicUnits.toString();
  }

  private buildHeaders() {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.facilitatorApiKey) {
      headers.Authorization = `Bearer ${this.facilitatorApiKey}`;
    }

    return headers;
  }

  private async callFacilitator<T>(
    endpoint: 'verify' | 'settle',
    payload: PaymentPayload
  ): Promise<T> {
    if (!this.facilitatorUrl) {
      throw new Error('Facilitator URL is not configured.');
    }

    const response = await fetch(`${this.facilitatorUrl}/${endpoint}`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: this.requirements,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Facilitator ${endpoint} failed (${response.status}): ${
          text || response.statusText
        }`
      );
    }

    return (await response.json()) as T;
  }

  private buildEip712Domain(requirements: PaymentRequirements) {
    return {
      name: (requirements.extra?.name as string) || this.assetName,
      version: (requirements.extra?.version as string) || '2',
      chainId: this.chainId,
      verifyingContract: requirements.asset,
    };
  }

  private getDefaultRpcUrl(network: string): string | undefined {
    switch (network) {
      case 'base':
        return 'https://mainnet.base.org';
      case 'base-sepolia':
        return 'https://sepolia.base.org';
      case 'polygon':
        return 'https://polygon-rpc.com';
      case 'polygon-amoy':
        return 'https://rpc-amoy.polygon.technology';
      case 'avalanche':
        return 'https://api.avax.network/ext/bc/C/rpc';
      case 'avalanche-fuji':
        return 'https://api.avax-test.network/ext/bc/C/rpc';
      case 'iotex':
        return 'https://rpc.ankr.com/iotex';
      case 'sei':
        return 'https://sei-rpc.publicnode.com';
      case 'sei-testnet':
        return 'https://sei-testnet-rpc.publicnode.com';
      case 'peaq':
        return 'https://erpc.peaq.network';
      default:
        return undefined;
    }
  }
}
