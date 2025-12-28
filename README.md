![x402 Starter Kit](header.jpg)

# x402 Starter Kit

A starter kit for building paid APIs using the x402 v2 payment protocol with support for both EVM and Solana networks.

## Overview

This starter kit demonstrates how to build paid APIs using x402 v2. It:

1. Receives API requests
2. Requires payment (in this example of $0.10 USDC) before processing
3. Verifies and settles payments through a facilitator (default: [https://x402.org/facilitator](https://docs.cdp.coinbase.com/x402/network-support#x402-org-facilitator) for testnets, or your own local facilitator for mainnets)
4. Processes requests (using OpenAI/EigenAI as configurable examples)
5. Returns responses after payment is confirmed

## Architecture

The API consists of four main components:

- **ExampleService**: Example service logic that processes requests using OpenAI or EigenAI (replace with your own service implementation)
- **MerchantExecutor**: Handles payment requirements, verification, and settlement (supports both EVM and Solana)
- **Server**: Express HTTP server that orchestrates payment validation and request processing
- **Facilitator** (optional): Facilitator server for mainnet support or custom networks

## Prerequisites

- Node.js 18 or higher
- A wallet address to receive USDC payments
- An OpenAI or EigenAI API key (for the example implementation - replace with your own API)
- For testing: A wallet with USDC and gas tokens on your chosen network

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp env.example .env
```

Edit `.env` and fill in your values:

```env
# =============================================================================
# Server Configuration
# =============================================================================
PORT=3000

# Your wallet address to receive payments (no private key needed!)
PAY_TO_ADDRESS=0xYourWalletAddress

# Network to use for payments
# Legacy names: base, base-sepolia, polygon, polygon-amoy, avalanche, avalanche-fuji,
#               iotex, sei, sei-testnet, peaq, solana, solana-devnet
# CAIP-2 format: eip155:8453, eip155:84532, solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
NETWORK=base-sepolia

# =============================================================================
# AI Provider Configuration
# =============================================================================
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-openai-api-key

# Alternative: EigenAI
# AI_PROVIDER=eigenai
# EIGENAI_API_KEY=your-eigenai-api-key

# =============================================================================
# Settlement Mode
# =============================================================================
# Options: "facilitator" (default) or "direct" (EVM only)
SETTLEMENT_MODE=facilitator

# For custom/local facilitator (required for mainnets):
# FACILITATOR_URL=http://localhost:4022

# For direct settlement (EVM only, no facilitator needed):
# SETTLEMENT_MODE=direct
# PRIVATE_KEY=0xYourMerchantPrivateKey

# =============================================================================
# Test Client Configuration
# =============================================================================
# EVM test client (for npm run test)
# EVM_CLIENT_PRIVATE_KEY=0xYourTestWalletPrivateKey

# Solana test client (for npm run test:solana)
# SOLANA_CLIENT_PRIVATE_KEY=YourBase58SolanaKeypair

# =============================================================================
# Local Facilitator Configuration (npm run start:facilitator)
# =============================================================================
# Required for mainnet support - the facilitator settles payments on-chain

# FACILITATOR_PORT=4022
# EVM_PRIVATE_KEY=0xFacilitatorEvmKey
# SVM_PRIVATE_KEY=FacilitatorSolanaKeypair
# FACILITATOR_EVM_NETWORK=base-sepolia
# FACILITATOR_SVM_NETWORK=solana-devnet
```

## Quickstart

### For Testnets (Simple)

Just run the server - it uses the default facilitator automatically:

```bash
npm run dev
```

### For Mainnets (Requires Custom Facilitator)

The default facilitator at `https://x402.org/facilitator` only supports **testnets**. For mainnet, you need a facilitator that supports your network - this can be a local facilitator you run yourself, or an external hosted facilitator service.

#### Option 1: Run Your Own Facilitator


**Terminal 1 - Start the Facilitator:**
```bash
npm run start:facilitator
```

**Terminal 2 - Start the Server:**
```bash
FACILITATOR_URL=http://localhost:4022 npm run start
```

#### Option 2: Use an External Facilitator

If you have access to a hosted facilitator that supports mainnet:

```bash
FACILITATOR_URL=https://your-mainnet-facilitator.example.com npm run start
```

**Note:** Some facilitators do not require API keys to get started. For example, PayAI, x402rs, Heurist, Corbits, and other public facilitators can be used without additional authentication.

**Some Available Facilitators (No API key required):**

- [PayAI](https://facilitator.payai.network)
- [x402rs](https://facilitator.x402.rs)
- [Heurist](https://facilitator.heurist.xyz)
- [Corbits](https://facilitator.corbits.dev)

#### Option 3: Direct Settlement (EVM Only)

Skip the facilitator entirely and settle directly on-chain (requires merchant private key):

```bash
SETTLEMENT_MODE=direct PRIVATE_KEY=0xYourMerchantKey npm run start

```

### Running Tests

```bash
# Test EVM payments
npm run test

# Test Solana payments
npm run test:solana
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Build and start the server |
| `npm run start` | Start the server (production) |
| `npm run start:facilitator` | Start the local facilitator |
| `npm run build` | Build TypeScript |
| `npm run test` | Run EVM test client |
| `npm run test:solana` | Run Solana test client |
| `npm run setup:solana` | Setup Solana wallets (create ATAs) |
| `npm run clean` | Remove build artifacts |

## Environment Variables Reference

### Server (Merchant)

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `PAY_TO_ADDRESS` | Yes | Wallet address to receive payments |
| `NETWORK` | No | Network for payments (default: base-sepolia) |
| `SETTLEMENT_MODE` | No | `facilitator` (default) or `direct` |
| `FACILITATOR_URL` | No | Custom facilitator URL |
| `PRIVATE_KEY` | For direct mode | Merchant key for direct settlement |

### AI Provider

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_PROVIDER` | No | `openai` (default) or `eigenai` |
| `OPENAI_API_KEY` | For OpenAI | OpenAI API key |
| `EIGENAI_API_KEY` | For EigenAI | EigenAI API key |
| `AI_MODEL` | No | Model to use |
| `AI_TEMPERATURE` | No | Temperature setting |
| `AI_MAX_TOKENS` | No | Max tokens |

### Test Clients

| Variable | Description |
|----------|-------------|
| `EVM_CLIENT_PRIVATE_KEY` | EVM wallet for test payments |
| `SOLANA_CLIENT_PRIVATE_KEY` | Solana wallet for test payments |
| `AGENT_URL` | Server URL (default: http://localhost:3000) |

### Local Facilitator

| Variable | Required | Description |
|----------|----------|-------------|
| `FACILITATOR_PORT` | No | Facilitator port (default: 4022) |
| `EVM_PRIVATE_KEY` | Yes | EVM key for settling payments |
| `SVM_PRIVATE_KEY` | Yes | Solana key for settling payments |
| `FACILITATOR_EVM_NETWORK` | No | EVM network (default: base-sepolia) |
| `FACILITATOR_SVM_NETWORK` | No | Solana network (default: solana-devnet) |

## Network Support

### Testnets (Default Facilitator)

| Network | Config Value | Supported |
|---------|-------------|-----------|
| Base Sepolia | `base-sepolia` | ✅ |
| Polygon Amoy | `polygon-amoy` | ✅ |
| Avalanche Fuji | `avalanche-fuji` | ✅ |
| Solana Devnet | `solana-devnet` | ✅ |

### Mainnets (Requires Custom Facilitator or Direct Settlement)

| Network | Config Value | Custom Facilitator | Direct Settlement |
|---------|-------------|-------------------|-------------------|
| Base | `base` | ✅ | ✅ |
| Polygon | `polygon` | ✅ | ✅ |
| Avalanche | `avalanche` | ✅ | ✅ |
| Solana | `solana` | ✅ | ❌ |

## Usage

### Health Check

```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "healthy",
  "service": "x402-payment-api",
  "version": "2.0.0",
  "x402Version": 2,
  "payment": {
    "address": "0xYourAddress...",
    "network": "base-sepolia",
    "price": "$0.10"
  }
}
```

### Making a Request

```bash
curl -X POST http://localhost:3000/process \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "parts": [{ "kind": "text", "text": "What is 2+2?" }]
    }
  }'
```

This returns payment requirements. To complete the flow, use the test clients or implement x402 payment signing.

## How It Works

### Payment Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   CLIENT        │     │     SERVER      │     │   FACILITATOR   │
│                 │     │                 │     │                 │
│ 1. Request      │────▶│ 2. Return       │     │                 │
│                 │     │    payment      │     │                 │
│                 │◀────│    requirements │     │                 │
│                 │     │                 │     │                 │
│ 3. Sign payment │     │                 │     │                 │
│                 │     │                 │     │                 │
│ 4. Submit       │────▶│ 5. Verify       │────▶│ 6. Check sig    │
│    payment      │     │                 │◀────│                 │
│                 │     │                 │     │                 │
│                 │     │ 7. Process      │     │                 │
│                 │     │    request      │     │                 │
│                 │     │                 │     │                 │
│                 │     │ 8. Settle       │────▶│ 9. Submit tx    │
│                 │◀────│                 │◀────│    on-chain     │
│ 10. Response    │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Key Roles

| Role | What They Need | Purpose |
|------|---------------|---------|
| **Client (Payer)** | Private key + USDC | Signs payment authorization |
| **Server (Payee)** | Just an address | Receives USDC payments |
| **Facilitator** | Private key + gas | Settles transactions on-chain |

## Project Structure

```
x402-starter/
├── src/
│   ├── server.ts              # Express server and endpoints
│   ├── ExampleService.ts      # Example AI service (replace with your own)
│   ├── MerchantExecutor.ts    # Payment verification & settlement
│   ├── facilitator.ts         # Local facilitator server
│   ├── testClient.ts          # EVM test client
│   ├── testClientSolana.ts    # Solana test client
│   ├── setupSolanaWallets.ts   # Solana wallet setup tool
│   └── x402Types.ts           # Shared types
├── env.example                # Example environment configuration
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### "PAY_TO_ADDRESS is required"

Set `PAY_TO_ADDRESS` in your `.env` file to your wallet address.

### "OPENAI_API_KEY is required"

Set `OPENAI_API_KEY` in your `.env` file, or use `AI_PROVIDER=eigenai` with `EIGENAI_API_KEY`.

### Payment verification fails

- Check you're using the correct network
- Verify the client wallet has USDC
- For facilitator mode, ensure the facilitator is running and reachable
- For direct mode, ensure `PRIVATE_KEY` has gas tokens

### "Default facilitator only supports TESTNETS"

For mainnets, you need to:
1. Run your own facilitator: `npm run start:facilitator`, or
2. Use an external facilitator that supports mainnet, or
3. Use direct settlement (EVM only): `SETTLEMENT_MODE=direct`

### Solana payments not working

- Ensure server is configured with `NETWORK=solana-devnet` or `NETWORK=solana`
- For mainnet, use a facilitator with `SVM_PRIVATE_KEY` configured
- Client needs `SOLANA_CLIENT_PRIVATE_KEY` with USDC + SOL for fees

### Solana Wallet Setup

Solana requires **Associated Token Accounts (ATAs)** for each wallet to hold USDC. Unlike EVM, you can't just send tokens to any address - the receiving account must exist first.

Run the setup tool to check and create missing ATAs:

```bash
npm run setup:solana
```

This will:
1. Check SOL balance for all configured wallets
2. Check if USDC ATAs exist
3. Automatically create missing ATAs (if a funded wallet is available)
4. Show helpful instructions for any issues

**Required wallets for Solana payments:**

| Wallet | Needs ATA? | Needs USDC? | Needs SOL? |
|--------|------------|-------------|------------|
| Client | ✅ Yes | ✅ Yes (to pay) | ✅ Minimal |
| Merchant | ✅ Yes | ❌ No | ✅ Minimal |
| Facilitator | ✅ Yes | ❌ No | ✅ Yes (for tx fees) |

**Getting devnet tokens:**
- SOL: https://faucet.solana.com
- USDC: https://spl-token-faucet.com


## Security Considerations

- Never commit your `.env` file
- Keep private keys secure
- Use testnet for development
- The merchant (server) only needs an address - no private key required to receive payments
- Facilitator keys should be separate from merchant keys

## Next Steps

- Replace the example OpenAI service with your own API logic
- Deploy the facilitator for mainnet payments
- Add support for different payment tiers
- Implement caching and rate limiting
- Add monitoring and analytics

## License

MIT

## Resources

- [x402 Protocol Documentation](https://docs.cdp.coinbase.com/x402)
- [@x402/core on npm](https://www.npmjs.com/package/@x402/core)
- [@x402/evm on npm](https://www.npmjs.com/package/@x402/evm)
- [@x402/svm on npm](https://www.npmjs.com/package/@x402/svm)
