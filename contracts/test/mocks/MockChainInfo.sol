// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IChainInfo} from "../../src/interfaces/IChainInfo.sol";

contract MockChainInfo is IChainInfo {
    HeightHashResult private latest;

    constructor(uint64 height) {
        latest = HeightHashResult({height: height, hash: keccak256("attestation"), isAttestation: true, exists: true});
    }

    function setLatest(uint64 height, bool exists) external {
        latest.height = height;
        latest.exists = exists;
    }

    function get_latest_attestation_height_and_hash(uint64) external view returns (HeightHashResult memory result) {
        return latest;
    }
}

