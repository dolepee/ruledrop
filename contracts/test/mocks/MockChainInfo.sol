// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IChainInfo} from "../../src/interfaces/IChainInfo.sol";

contract MockChainInfo is IChainInfo {
    HeightHashResult private latest;
    ChainInfoResult private source;

    constructor(uint64 height) {
        latest = HeightHashResult({height: height, hash: keccak256("attestation"), isAttestation: true, exists: true});
        source = ChainInfoResult({
            info: ChainInfo({chainKey: 3, chainId: 1, chainName: bytes("Ethereum"), chainEncoding: 1}), exists: true
        });
    }

    function setLatest(uint64 height, bool exists) external {
        latest.height = height;
        latest.exists = exists;
    }

    function setLatestAttestation(uint64 height, bool isAttestation, bool exists) external {
        latest.height = height;
        latest.isAttestation = isAttestation;
        latest.exists = exists;
    }

    function setSource(uint64 chainKey, uint64 chainId, uint8 chainEncoding, bool exists) external {
        source = ChainInfoResult({
            info: ChainInfo({
                chainKey: chainKey,
                chainId: chainId,
                chainName: bytes("configured source"),
                chainEncoding: chainEncoding
            }),
            exists: exists
        });
    }

    function get_latest_attestation_height_and_hash(uint64) external view returns (HeightHashResult memory result) {
        return latest;
    }

    function get_chain_by_key(uint64) external view returns (ChainInfoResult memory result) {
        return source;
    }
}
