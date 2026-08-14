# RuleDrop

**Rules, not lists.**

Live application: [ruledrop.dolepee.com](https://ruledrop.dolepee.com)

RuleDrop turns verified Ethereum mainnet history into open, funded claims on Creditcoin. A protocol, DAO, or merchant funds an immutable obligation; any wallet that proves the exact historical action through Attestcoin can establish its own inclusion and withdraw after finalization.

The current live V1 deployment supports one deliberately narrow predicate: a direct, successful Ethereum mainnet USDC `transfer(address,uint256)` to an exact recipient, above an exact amount, inside an immutable historical block range.

The repository's V2 implementation expands the same engine for compensation, rebates, and recovery grants with:

- Reviewed direct-transfer and contract-interaction claim templates.
- Exact target, selector, event emitter, event signature, and claimant-topic binding.
- Equal and capped source-amount-weighted pro-rata settlement.
- A version-aware worker that preserves the live V1 path until V2 is separately deployed and verified.

V2 source code is not presented as live deployment evidence. See [product direction](docs/PRODUCT_DIRECTION_2026-08-14.md) and [deployment evidence](docs/DEPLOYMENTS.md).

## Why Attestcoin is load-bearing

Without Attestcoin, a sponsor or indexer must author the eligibility list. RuleDrop instead verifies claimant-supplied Ethereum evidence through Creditcoin's native verifier and independently checks receipt success, transaction sender and target, canonical calldata, USDC event origin, recipient, amount, block range, and replay state.

The proof builder is untrusted for integrity. It can delay a claim, but it cannot approve one.

## Live feasibility evidence

On August 13, 2026, Creditcoin testnet chain `102031` reported:

- Ethereum mainnet at source chain key `3`
- Latest attested Ethereum block `25,747,630`
- A valid proof for historical mainnet transaction `0x7e6c853f85d4db4040206d7d49e1327b009894f7f0b8cba7c5c1fab640bd1227`
- Native `0x0FD2` verification succeeded in `896 ms`
- The same proof registered its historical sender in live campaign `1` through Creditcoin transaction `0x6470d1850b4444a0627cc997bacc982af8757bb2682bf272422e0100f871de5e`

The source transaction predates RuleDrop and directly transferred canonical Ethereum USDC from the claimant wallet. Its live Creditcoin receipt contains both the native verifier event and RuleDrop's `ClaimRegistered` event.

The RuleDrop contracts and a fully funded `10 tCTC` campaign are also live on Creditcoin testnet. See [deployment evidence](docs/DEPLOYMENTS.md) for contract addresses, transaction hashes, and the exact campaign rule.

## Contracts

- `RuleDropPool`: fully funded immutable claims, versioned templates, pro-rata settlement policies, permissionless finalization, and pull withdrawals.
- `AttestcoinClaimVerifier`: native proof verification and source transaction replay identity.
- `USDCTransferPredicateV1`: exact direct-USDC transfer semantics.
- `ContractInteractionPredicateV1`: exact direct contract call and claimant-bound event semantics.

## Application worker

The Node worker reads live campaign state, uses fallback Ethereum RPCs for early validation, retries and caches Attestcoin proofs, and returns claim calldata only after the exact onchain call simulates successfully. See [the worker API](docs/WORKER_API.md).

The application and worker run as one Docker service on Render behind the stable `ruledrop.dolepee.com` hostname. `/health` exposes destination-network identity for provider monitoring.

## Local verification

```bash
npm install
forge test
npm test
npm run verify:mainnet-gate
```

## Claim boundaries

RuleDrop proves qualifying wallets, not unique humans. The hackathon deployment is testnet-only, unaudited, and does not claim general Sybil resistance.
