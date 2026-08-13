# Ethereum mainnet proof gate

Date: August 13, 2026

## Result

GREEN.

Creditcoin testnet chain `102031` reported Ethereum mainnet as source chain key `3`. The hosted proof builder generated a proof for a pre-existing direct USDC transfer from the project wallet, and Creditcoin's native `0x0FD2` verifier accepted it.

Source transaction:

`0x7e6c853f85d4db4040206d7d49e1327b009894f7f0b8cba7c5c1fab640bd1227`

Observed source fields:

- Ethereum block: `25,049,872`
- Transaction index: `142`
- Transaction target: canonical Ethereum mainnet USDC
- Selector: `0xa9059cbb`
- Sender: `0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF`
- Amount: `1,000 USDC`
- Source transaction predates RuleDrop implementation.

First measured run:

- Proof generation: `6,440 ms`
- Native verification: `896 ms`
- Merkle siblings: `8`
- Continuity roots: `129`

These are timestamped testnet observations, not service guarantees.

## Reproduce

```bash
npm run verify:mainnet-gate
```

The script performs read-only calls. It queries chain configuration and latest attestation, requests the public proof, and verifies it through the native precompile without signing a transaction.

