# Creditcoin Testnet Deployment

Deployment date: August 13, 2026

Network:

- Creditcoin testnet
- Chain ID: `102031`
- RPC: `https://rpc.cc3-testnet.creditcoin.network`
- Explorer: `https://creditcoin-testnet.blockscout.com`

## Contracts

| Contract | Address | Deployment transaction |
| --- | --- | --- |
| `EvmV1Decoder` | `0x8182E6D90F53Fdc261510A949915842a09dFC42a` | `0x8f6f3509351e107c27d1484239a064a85504c0473e80c1b4602554cb489626b2` |
| `USDCTransferPredicateV1` | `0x094Ba0AA23e19E117DdFdB17327cD5626354B380` | `0xf3913a48075fc4080ebcd4ab65e353e0f7fa14ce3bdd964cbb963f38ae64c78a` |
| `AttestcoinClaimVerifier` | `0x0B2b11a186f0CeF058f6A4A1352406477AB7627c` | `0x9f571a20facd3971d3dc246e85dbd34303069f510742658f9d1f190cf7a72fe3` |
| `RuleDropPool` | `0x6f8dE7e1599A0c8D38eB25996cB841a4920ed999` | `0x08e2df968ddbfcebe31dde8121180d60588e7e9bf1305ea2d094f021fb883cd3` |

Each address has nonempty deployed bytecode. The verifier is configured with Creditcoin's native query verifier at `0x0000000000000000000000000000000000000FD2`; the pool reads source-chain state through `0x0000000000000000000000000000000000000FD3`.

## Live Campaign 1

- Creation transaction: `0x3aa269dae1435c6dd737a139269d87d946d8b496f8bbd81f041c256573eed640`
- Funded pool: `10 tCTC`
- Source chain: Ethereum mainnet, Attestcoin chain key `3`
- Canonical token: Ethereum mainnet USDC
- Required action: direct successful `transfer(address,uint256)`
- Recipient: `0x9fEAcC0d3BC179B6022B4aAf96F7a8217F422642`
- Minimum amount: `1,000 USDC`
- Source block range: `25,049,872` to `25,049,872`
- Registration deadline: `1786730502`
- Withdrawal deadline: `1786903302`

Historical source transaction:

- Ethereum transaction: `0x7e6c853f85d4db4040206d7d49e1327b009894f7f0b8cba7c5c1fab640bd1227`
- Source block: `25,049,872`
- Claimant: `0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF`
- Amount: `1,000 USDC`
- The transaction predates the RuleDrop campaign.

The campaign is intentionally narrow and exists to prove the complete mainnet-history claim path. Claim registration evidence will be appended after the historical sender submits the live proof.
