# RetryCredit

**The retry pays for the failure.**

RetryCredit is a pre-funded execution credit for signed DeFi routes. A trader submits an authorized Uniswap route that is included and fails, then settles the same funded action with a refreshed signed route. One native Attestcoin batch proves both Ethereum receipts before Creditcoin releases the fixed service credit exactly once.

The current public pilot is deliberately narrow:

- Ethereum Sepolia source chain and Creditcoin Testnet settlement.
- Official Uniswap Universal Router 2.1.1.
- One WETH → Circle test-USDC fee-500 route.
- One bounded sponsor-funded credit per visitor wallet.
- A relayed testnet route: the visitor signs only to name the wallet that receives both test-USDC output and the Creditcoin credit.
- Test assets only; no mainnet value, insurance, or exact gas reimbursement.

## Why Attestcoin is load-bearing

The Creditcoin release requires one native Attestcoin batch containing both ordered source receipts. The verifier enforces:

1. The same service executor, visitor beneficiary, funded action, official router, input amount, and signed intent.
2. A status-0 receipt followed by a status-1 receipt in a bounded source window.
3. A newer route nonce, quote marker, deadline, and improved minimum output.
4. One exact Uniswap pool `Swap` and one exact Circle test-USDC transfer to the trader.
5. One-time query, pair, action, and service-credit consumption.

Remove Attestcoin and the Creditcoin pool cannot authorize the release. The proof builder is not trusted for integrity: every candidate batch is checked locally and then simulated against the exact funded pool before the relayer may submit it.

## Public evidence

A fresh lifecycle completed through the deployed public HTTPS service on August 22, 2026:

- Included status-0 route: [`0x9cb8…ee07`](https://sepolia.etherscan.io/tx/0x9cb81e134e33f32b702786589510948d097ae98d0ef3ffec4c631a1288a0ee07)
- Next-block settled retry: [`0x81e9…f9b0`](https://sepolia.etherscan.io/tx/0x81e96116c5b3e050a1b4ac6d1cea611817e7d028636003e7aa6d12f5c412f9b0)
- Creditcoin release: [`0xb787…7cdf`](https://creditcoin-testnet.blockscout.com/tx/0xb787581b58bab15bc4e8e78389c6d0d4bb362896d265bdbe2263df7d7eb77cdf)
- Source-to-credit time: 552 seconds.
- Public replay returned the same release and produced no second `CreditReleased` event.

The execution used test assets and a founder-funded service credit. It proves public causability and public-chain execution, not independent adoption or customer demand.

## Contracts

- `RetryCreditUniversalRouterPoolV2`: pre-funded drafts, a distinct visitor beneficiary, committed source transactions, fixed release, refunds, and replay consumption.
- `AttestcoinRetryCreditUniversalRouterVerifierV2`: native batch verification and source identity derivation.
- `RetryCreditUniversalRouterPredicateV2`: canonical signed-router decoding, beneficiary-bound retry correlation, receipt ordering, and exact settlement evidence.
- `EvmV1Decoder`: strict Attestcoin EVM receipt decoding.

The previous RuleDrop contracts remain in the repository as an archived proof-engine predecessor. They are not the current product or public release claim.

## Public service

The reviewed V3 pilot authenticates one short-lived wallet challenge, pre-funds the Creditcoin service credit, signs two official Universal Router routes from a separate service wallet, and commits the exact raw signed source transactions on Creditcoin before either is broadcast. It then executes the bounded Sepolia retry with the visitor as the test-USDC recipient, waits for Attestcoin finality, simulates the exact release, and submits through an isolated relayer. The visitor wallet never deposits an asset or approves a token; the same address receives the settled test-USDC and the Creditcoin credit. Durable authorization, source commitments, and replay state remain onchain.

The V3 pilot is enabled at pool `0x81b5d955F4EbfaE02FF6346cf368A2c4347248A1` after two fresh end-to-end releases with distinct beneficiaries and a service restart. Public sponsorship remains founder-funded, testnet-only, capped per deployment, and fails closed when the service wallet or reserve is unavailable.

## Local verification

```bash
npm install
npm test
npm run build
```

The repository covers the V1 evidence path and the V2 relayed path, including malformed proofs, route mutations, source identity drift, replay, unauthenticated infrastructure, distinct beneficiary binding, restart-safe source commitments, and sponsor/relayer separation.

## Truth boundary

Attestcoin proves an authorized included failure and a later exact settlement. It does **not** prove the human-readable revert reason, organic user loss, exact gas expenditure, or an insurance event. The first route in this pilot is a disclosed controlled stale-route test.
