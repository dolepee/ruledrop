# RuleDrop Worker API

The worker packages claimant-supplied Ethereum evidence and simulates the resulting RuleDrop transaction. It is not an eligibility oracle: the Creditcoin contracts remain the only authority that can approve a claim.

## Run locally

```bash
cp .env.example .env
npm run worker
```

Environment variables are read from the process. Use the deployment platform's environment configuration or load `.env` before starting the process.

For production, set at least two comma-separated Ethereum mainnet RPC URLs in `ETHEREUM_RPC_URLS`, set `ALLOWED_ORIGIN` to the public application origin, and bind `HOST=0.0.0.0` behind an HTTPS reverse proxy.

## Routes

### `GET /health`

Returns service and destination-network identity.

### `GET /api/campaigns/:campaignId`

Returns the current onchain campaign state and derived registration/withdrawal availability.

Add `?claimant=0x...` to include that wallet's registration and withdrawal state.

### `POST /api/campaigns/:campaignId/prepare-claim`

Request:

```json
{
  "transactionHash": "0x...",
  "claimant": "0x..."
}
```

The worker:

1. Reads the immutable campaign rule from Creditcoin.
2. Looks up the Ethereum transaction through configured fallback RPCs.
3. Rejects obvious sender, token, function, status, and block-range mismatches.
4. Builds and caches the Attestcoin proof with bounded retries.
5. Simulates `registerClaim` from the exact claimant address.
6. Returns zero-value transaction calldata only after the simulation passes.

Stable failures use `{ error: { code, message, requestId } }`. A proof-builder or RPC outage returns `503`; deterministic campaign or eligibility failures use `4xx` responses.

## Trust boundary

Worker checks are fail-fast conveniences, not authority. A compromised worker cannot register an ineligible wallet because `RuleDropPool`, `AttestcoinClaimVerifier`, and `USDCTransferPredicateV1` repeat the complete proof and semantic validation onchain.
