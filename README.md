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

A fresh direct-Uniswap lifecycle completed on August 22, 2026:

- Included status-0 route: [`0x5ef2…3722`](https://sepolia.etherscan.io/tx/0x5ef2e6e47da2892774967c69aa48814d4db08141d76e53418ad7886d67683722)
- Next-block settled retry: [`0xb6f5…766b`](https://sepolia.etherscan.io/tx/0xb6f516f52d0286bf274ae63a000df67583250c13d3645e6ce5e80ae40716766b)
- Creditcoin release: [`0xbc44…0e84`](https://creditcoin-testnet.blockscout.com/tx/0xbc44875c384fa4a9a67a7cdfd390d2322db84570c60e54fe65fed1e0b7a40e84)
- Source-to-credit time: 477 seconds.

A separate cold visitor run used only the public HTTP surface and a disposable wallet:

- Included status-0 route: [`0x06b4…90a2`](https://sepolia.etherscan.io/tx/0x06b4c1df16a075587fcd1192090afa05200e55e8c3e8c0f3728b446d1dbc90a2)
- Next-block settled retry: [`0xffbd…0c7b`](https://sepolia.etherscan.io/tx/0xffbd4b44f5fc22949cf0ac8829da7dc4b0cf7bb8a3d9ae483811ff903d710c7b)
- Creditcoin release: [`0x00f0…f56b0`](https://creditcoin-testnet.blockscout.com/tx/0x00f033e14dc4c6583f17dc0571f463b89ffa7f53519d467c2f54bc01249f56b0)

Both executions used test assets and founder-funded service credits. They prove engineering and public-chain causality, not customer demand.

## Contracts

- `RetryCreditUniversalRouterPoolV2`: pre-funded drafts, a distinct visitor beneficiary, committed source transactions, fixed release, refunds, and replay consumption.
- `AttestcoinRetryCreditUniversalRouterVerifierV2`: native batch verification and source identity derivation.
- `RetryCreditUniversalRouterPredicateV2`: canonical signed-router decoding, beneficiary-bound retry correlation, receipt ordering, and exact settlement evidence.
- `EvmV1Decoder`: strict Attestcoin EVM receipt decoding.

The previous RuleDrop contracts remain in the repository as an archived proof-engine predecessor. They are not the current product or public release claim.

## Public service

The relayed V2 service authenticates one short-lived wallet challenge, pre-funds the Creditcoin service credit, signs two official Universal Router routes from a separate service wallet, and commits the signed source transactions on Creditcoin before either is broadcast. It then executes the bounded Sepolia retry with the visitor as the test-USDC recipient, waits for Attestcoin finality, simulates the exact release, and submits through an isolated relayer. The visitor wallet never deposits an asset or approves a token; the same address receives the settled test-USDC and the Creditcoin credit. Durable authorization, source commitments, and replay state remain onchain.

Public sponsorship is capped per deployment and fails closed when the service wallet or reserve is unavailable. The relayed V2 allocation remains disabled until its reviewed deployment completes fresh end-to-end release and restart checks.

## Local verification

```bash
npm install
npm test
npm run build
```

The repository covers the V1 evidence path and the V2 relayed path, including malformed proofs, route mutations, source identity drift, replay, unauthenticated infrastructure, distinct beneficiary binding, restart-safe source commitments, and sponsor/relayer separation.

## Truth boundary

Attestcoin proves an authorized included failure and a later exact settlement. It does **not** prove the human-readable revert reason, organic user loss, exact gas expenditure, or an insurance event. The first route in this pilot is a disclosed controlled stale-route test.
