# Product Direction: Open Cross-Chain Claims

## Decision

RuleDrop's current retroactive-reward framing is too narrow and too easily mistaken for an airdrop-hunter tool. Preserve the live Attestcoin proof path, but build the product as a cross-chain claims protocol.

The product promise is:

> If a funded public rule says you are owed, prove the source-chain event and collect without depending on an operator's private list.

The public name remains provisional until a uniqueness check is complete. `RuleDrop` is the current repository and contract lineage, not the final product category.

## Buyer And User

The buyer is a protocol, merchant, DAO, issuer, creator, or ecosystem treasury that needs to settle obligations arising from activity on another chain.

The user is a customer, protocol participant, contributor, or affected wallet claiming a funded entitlement. The product is not designed or marketed for airdrop farming.

## Product Surfaces

One claims engine supports three coherent surfaces:

1. **Compensation:** a protocol funds restitution for wallets that interacted with an affected contract or operation during an immutable historical window.
2. **Rebates:** a merchant or protocol refunds part of a qualifying historical payment or fee.
3. **Migration and recovery grants:** an ecosystem rewards wallets that prove an approved burn, bridge, repayment, or migration action.

The hackathon flagship is compensation because independent inclusion is most valuable when omission is contested. The external pilot may use a rebate if it provides faster access to a real sponsor and at least ten qualifying wallets.

## Core Mechanism

Every claim is defined by four immutable components:

1. A supported, versioned source-event predicate.
2. A source-chain block window.
3. A fully funded destination reserve.
4. A payout policy.

The claimant supplies the source transaction. Attestcoin proves inclusion and continuity. The application verifies successful execution and exact transaction semantics. Creditcoin records eligibility and settles the funded entitlement.

The proof builder and discovery index are convenience services, not authorities.

## Hackathon Scope

Build a coherent protocol, not an arbitrary predicate platform.

### Predicate Templates

1. `DirectERC20TransferV1`: exact token, sender, recipient, minimum amount, and source block window. This is already live.
2. `ContractInteractionV1`: successful direct call by the claimant to an exact contract and selector inside a source block window, with an optional required event signature and emitter.
3. `BatchActivityV1`: up to ten qualifying source transactions verified as one bounded activity set, used for cumulative rebates or loyalty thresholds.

Sponsors cannot upload arbitrary predicate contracts in the MVP. Only reviewed, versioned templates can create claims.

### Payout Policies

1. Equal pro-rata pool after registration closes.
2. Fixed amount per valid claimant with the maximum liability fully reserved at creation.
3. Amount-weighted pro-rata distribution for batch activity, subject to an immutable per-wallet cap.

### Settlement Assets

Support native tCTC and one allowlisted testnet ERC20. Do not accept arbitrary payout tokens in the MVP.

## Winning Buyer Journey

The first screen leads with the obligation, not the proof machinery:

> You qualify for this funded compensation pool. Prove the Ethereum transaction and claim your share.

The path is:

1. Open a public claim page.
2. Connect the same source wallet.
3. Find or paste the qualifying Ethereum transaction.
4. See the exact rule and funded reserve.
5. Generate and simulate the proof.
6. Register the entitlement on Creditcoin.
7. Withdraw after finalization.

The proof bytes, native verifier events, and architecture remain available in an expandable technical view.

## Why This Can Win

The product is broader than a campaign tool but narrower than a generic oracle framework:

- It settles funded obligations, not speculative eligibility.
- Claimants can establish their own inclusion.
- Sponsors cannot edit the rule, cancel the reserve, cap claimants after launch, or privately adjudicate valid claims.
- Attestcoin is load-bearing because source-chain evidence changes Creditcoin entitlement state.
- The live Ethereum-mainnet-to-Creditcoin proof demonstrates a real historical fact rather than a transaction manufactured by the project.
- Multiple claim templates show repeatability without diluting the flagship journey.

The defensible category is **open cross-chain claims settlement**.

## Competitive Boundary

Brevis Incentra and similar systems already provide sophisticated continuous incentive computation. The project must not claim to invent trustless historical rewards.

The narrower wedge is claimant-supplied semantic proof inside a fully funded, immutable claims process where no sponsor-authored eligibility set is final authority.

For small, uncontested cohorts, a Merkle distributor remains cheaper and simpler. This protocol is justified where independent inclusion, public reserves, and deterministic settlement matter.

## Demo Structure

1. Open a funded compensation claim and show the amount owed.
2. Use a real historical Ethereum mainnet transaction to register live on Creditcoin.
3. Show the claimant count and reserved liability change.
4. Submit a semantically invalid transaction and show deterministic rejection.
5. Show a finalized pool and withdrawal.
6. Briefly show rebate and migration templates as repeat uses of the same engine.

The useful result must appear in the first 30 seconds. Contract architecture follows it.

## External Validation Gate

By August 26, secure all of the following:

1. One external sponsor or organization willing to endorse a real claim rule.
2. At least ten contactable wallets with qualifying historical source events.
3. A funded public testnet reserve.
4. At least ten live Attestcoin registrations within 72 hours.
5. At least five completed withdrawals.
6. One sponsor statement explaining why open claimant inclusion is useful.

If a compensation sponsor is unavailable, use a merchant or creator rebate pilot. Do not manufacture an incident or describe founder-controlled wallets as external validation.

For direct-USDC candidates, independently audit the cohort before outreach:

```bash
npm run cohort:discover -- \
  --recipient 0x... \
  --start 25000000 \
  --end 25100000 \
  --minimum-usdc 10
```

The command uses Ethereum Blockscout for discovery by default, or accepts `--rpc`/`ETHEREUM_RPC_URLS` for direct log queries. It filters canonical USDC transfers, verifies that each transaction directly called `transfer(address,uint256)`, and deduplicates qualifying source wallets. Discovery remains nonauthoritative; the Creditcoin contract verifies every eventual claim.

## Immediate Build Order

1. Preserve and regression-test the existing live `DirectERC20TransferV1` path.
2. Refactor campaign storage around immutable predicate and payout-policy identifiers.
3. Add `ContractInteractionV1` with adversarial receipt, selector, emitter, sender, and replay tests.
4. Add fixed and capped weighted payout accounting with full-liability funding checks.
5. Prove the batch path before adding `BatchActivityV1` to the public product.
6. Replace airdrop language in the application with claims, obligations, reserves, and settlement.
7. Build the compensation-first buyer journey.
8. Recruit the external pilot before polishing secondary screens.

## Stop Conditions

Stop widening and return to the proven single-transfer engine if any of these occurs:

1. Additional predicates weaken semantic verification or cannot be adversarially tested.
2. Batch proof payloads are operationally unsuitable on Creditcoin testnet.
3. Multiple payout policies threaten completion of the flagship flow.
4. No external sponsor and cohort are identified by August 26.

Breadth is useful only if every added surface uses the same verified claims engine and remains reproducible by a cold judge.
