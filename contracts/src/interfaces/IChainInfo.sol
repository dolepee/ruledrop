// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface IChainInfo {
    struct ChainInfo {
        uint64 chainKey;
        uint64 chainId;
        bytes chainName;
        uint8 chainEncoding;
    }

    struct ChainInfoResult {
        ChainInfo info;
        bool exists;
    }

    struct HeightHashResult {
        uint64 height;
        bytes32 hash;
        bool isAttestation;
        bool exists;
    }

    function get_latest_attestation_height_and_hash(uint64 chainKey)
        external
        view
        returns (HeightHashResult memory result);

    function get_chain_by_key(uint64 chainKey) external view returns (ChainInfoResult memory result);
}
