# RuleDrop

**Rules, not lists.**

RuleDrop turns verified Ethereum mainnet history into permissionless rewards on Creditcoin. A sponsor fully funds an immutable rule; any wallet that proves the exact historical action through Attestcoin can register and withdraw its equal pro-rata share after registration closes.

The MVP supports one deliberately narrow predicate: a direct, successful Ethereum mainnet USDC `transfer(address,uint256)` to an exact recipient, above an exact amount, inside an immutable historical block range.

## Why Attestcoin is load-bearing

Without Attestcoin, a sponsor or indexer must author the eligibility list. RuleDrop instead verifies claimant-supplied Ethereum evidence through Creditcoin's native verifier and independently checks receipt success, transaction sender and target, canonical calldata, USDC event origin, recipient, amount, block range, and replay state.

The proof builder is untrusted for integrity. It can delay a claim, but it cannot approve one.

## Live feasibility evidence

On August 13, 2026, Creditcoin testnet chain `102031` reported:

- Ethereum mainnet at source chain key `3`
- Latest attested Ethereum block `25,747,630`
- A valid proof for historical mainnet transaction `0x7e6c853f85d4db4040206d7d49e1327b009894f7f0b8cba7c5c1fab640bd1227`
- Native `0x0FD2` verification succeeded in `896 ms`

The source transaction predates RuleDrop and directly transferred canonical Ethereum USDC from the claimant wallet.

The RuleDrop contracts and a fully funded `10 tCTC` campaign are also live on Creditcoin testnet. See [deployment evidence](docs/DEPLOYMENTS.md) for contract addresses, transaction hashes, and the exact campaign rule.

## Contracts

- `RuleDropPool`: fully funded immutable campaigns, registration, permissionless finalization, and pull withdrawals.
- `AttestcoinClaimVerifier`: native proof verification and source transaction replay identity.
- `USDCTransferPredicateV1`: exact direct-USDC transfer semantics.

## Local verification

```bash
npm install
forge test
npm run verify:mainnet-gate
```

## Claim boundaries

RuleDrop proves qualifying wallets, not unique humans. The hackathon deployment is testnet-only, unaudited, and does not claim general Sybil resistance.
