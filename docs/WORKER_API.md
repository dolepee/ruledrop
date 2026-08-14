# RuleDrop Worker API

The worker packages claimant-supplied Ethereum evidence and simulates the resulting RuleDrop transaction. It is not an eligibility oracle: the Creditcoin contracts remain the only authority that can approve a claim.

## Run locally

```bash
cp .env.example .env
npm run worker
```

Environment variables are read from the process. Use the deployment platform's environment configuration or load `.env` before starting the process.

`RULEDROP_POOL_VERSION=1` selects the current live contract ABI. Set it to `2` only with a deployed V2 pool address. The worker deliberately does not infer contract versions from failed calls.

For production, set at least two comma-separated Ethereum mainnet RPC URLs in `ETHEREUM_RPC_URLS`, set `ALLOWED_ORIGIN` to the public application origin, and bind `HOST=0.0.0.0` behind an HTTPS reverse proxy.

## Routes

### `GET /health`

Returns service and destination-network identity.

### `GET /api/campaigns/:campaignId`

Returns the current onchain campaign state and derived registration/withdrawal availability.

Add `?claimant=0x...` to include that wallet's registration and withdrawal state.

### `GET /api/campaigns/latest`

Reads `campaignCount()` and returns the newest campaign. The public application uses this route so publishing a replacement campaign does not require a frontend rebuild.

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
2. Reads the versioned claim template and, for V2 interaction claims, its exact target, selector, and event requirements.
3. Looks up the Ethereum transaction through configured fallback RPCs.
4. Rejects obvious sender, target, function, status, and block-range mismatches.
5. Builds and caches the Attestcoin proof with bounded retries.
6. Simulates the template-specific registration function from the exact claimant address.
7. Returns zero-value transaction calldata only after the simulation passes.

Stable failures use `{ error: { code, message, requestId } }`. A proof-builder or RPC outage returns `503`; deterministic campaign or eligibility failures use `4xx` responses.

## Trust boundary

Worker checks are fail-fast conveniences, not authority. A compromised worker cannot register an ineligible wallet because `RuleDropPool`, `AttestcoinClaimVerifier`, and the selected versioned predicate repeat the complete proof and semantic validation onchain.
