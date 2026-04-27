// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title DeadDrop — two-sided escrow for atomic digital goods exchange.
/// @notice Two parties deposit encrypted payloads (referenced by IPFS CID),
///         an arbiter (Lit flow's vault PKP) verifies both sides via AI,
///         then signs a release so both parties can decrypt each other's payload.
///         Optional ETH stakes incentivize honest participation.
/// @dev Deployed on Base mainnet: 0xC72c5462F6B78e50eBe2BBFccd1992C663e15054
///      State lives entirely on-chain. Payloads live on IPFS (encrypted).
///      The arbiter is stateless — it re-derives decryption keys deterministically.
contract DeadDrop {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    enum DropStatus { Created, Joined, Depositing, Ready, Released, Refunded, Cancelled }

    struct Drop {
        address partyA;
        address partyB;
        address arbiter;        // flow's vault PKP
        bytes32 criteriaHash;   // keccak256 of the criteria JSON
        bytes32 commitmentA;    // keccak256(bytes(cidA))
        bytes32 commitmentB;    // keccak256(bytes(cidB))
        string  cidA;           // IPFS CID of encrypted payload A
        string  cidB;           // IPFS CID of encrypted payload B
        uint256 stakeA;         // optional ETH stake from party A
        uint256 stakeB;         // optional ETH stake from party B
        uint256 deadline;       // block.timestamp after which refund is allowed
        DropStatus status;
    }

    uint256 public nextDropId;
    mapping(uint256 => Drop) public drops;

    event DropCreated(uint256 indexed dropId, address indexed partyA, address arbiter, bytes32 criteriaHash, uint256 stake, uint256 deadline);
    event DropJoined(uint256 indexed dropId, address indexed partyB, uint256 stake);
    event PayloadDeposited(uint256 indexed dropId, address indexed party, bytes32 commitment, string cid);
    event DropReleased(uint256 indexed dropId, address indexed partyA, address indexed partyB);
    event DropRefunded(uint256 indexed dropId);
    event DropCancelled(uint256 indexed dropId);

    /// @notice Create a new dead drop. Caller is party A.
    /// @param arbiter       Address that can authorize release (the flow's vault PKP).
    /// @param criteriaHash  keccak256 of the JSON criteria string (for on-chain reference).
    /// @param timeoutSeconds Seconds from now until refund is allowed.
    function createDrop(
        address arbiter,
        bytes32 criteriaHash,
        uint256 timeoutSeconds
    ) external payable returns (uint256 dropId) {
        require(arbiter != address(0), "Invalid arbiter");
        require(timeoutSeconds >= 1 hours, "Timeout too short");

        dropId = nextDropId++;
        Drop storage d = drops[dropId];
        d.partyA = msg.sender;
        d.arbiter = arbiter;
        d.criteriaHash = criteriaHash;
        d.stakeA = msg.value;
        d.deadline = block.timestamp + timeoutSeconds;
        d.status = DropStatus.Created;

        emit DropCreated(dropId, msg.sender, arbiter, criteriaHash, msg.value, d.deadline);
    }

    /// @notice Join an existing drop as party B.
    /// @param dropId The drop to join.
    function joinDrop(uint256 dropId) external payable {
        Drop storage d = drops[dropId];
        require(d.status == DropStatus.Created, "Drop not open for joining");
        require(msg.sender != d.partyA, "Cannot join own drop");

        d.partyB = msg.sender;
        d.stakeB = msg.value;
        d.status = DropStatus.Joined;

        emit DropJoined(dropId, msg.sender, msg.value);
    }

    /// @notice Deposit an encrypted payload's IPFS CID and commitment hash.
    /// @param dropId    The drop to deposit into.
    /// @param commitment keccak256(bytes(cid)) — verified against the CID.
    /// @param cid       IPFS CID of the encrypted payload.
    function deposit(
        uint256 dropId,
        bytes32 commitment,
        string calldata cid
    ) external {
        Drop storage d = drops[dropId];
        require(
            d.status == DropStatus.Joined || d.status == DropStatus.Depositing,
            "Drop not accepting deposits"
        );
        require(bytes(cid).length > 0, "Empty CID");
        require(commitment == keccak256(bytes(cid)), "Commitment mismatch");

        if (msg.sender == d.partyA) {
            require(d.commitmentA == bytes32(0), "Already deposited");
            d.commitmentA = commitment;
            d.cidA = cid;
        } else if (msg.sender == d.partyB) {
            require(d.commitmentB == bytes32(0), "Already deposited");
            d.commitmentB = commitment;
            d.cidB = cid;
        } else {
            revert("Not a party to this drop");
        }

        emit PayloadDeposited(dropId, msg.sender, commitment, cid);

        // Advance state
        if (d.commitmentA != bytes32(0) && d.commitmentB != bytes32(0)) {
            d.status = DropStatus.Ready;
        } else if (d.status == DropStatus.Joined) {
            d.status = DropStatus.Depositing;
        }
    }

    /// @notice Release the drop after arbiter verification. Requires a valid
    ///         EIP-191 signature from the arbiter over the release message.
    ///         Returns ETH stakes to their respective owners.
    /// @param dropId   The drop to release.
    /// @param signature EIP-191 signature from the arbiter.
    function releaseDrop(
        uint256 dropId,
        bytes calldata signature
    ) external {
        Drop storage d = drops[dropId];
        require(d.status == DropStatus.Ready, "Drop not ready for release");

        // Verify arbiter signature: keccak256("DEAD_DROP_RELEASE", dropId, partyA, partyB, chainId)
        bytes32 messageHash = keccak256(
            abi.encodePacked("DEAD_DROP_RELEASE", dropId, d.partyA, d.partyB, block.chainid)
        );
        address signer = messageHash.toEthSignedMessageHash().recover(signature);
        require(signer == d.arbiter, "Invalid arbiter signature");

        d.status = DropStatus.Released;

        emit DropReleased(dropId, d.partyA, d.partyB);

        // Return stakes
        if (d.stakeA > 0) {
            (bool okA, ) = payable(d.partyA).call{value: d.stakeA}("");
            require(okA, "Stake A transfer failed");
        }
        if (d.stakeB > 0) {
            (bool okB, ) = payable(d.partyB).call{value: d.stakeB}("");
            require(okB, "Stake B transfer failed");
        }
    }

    /// @notice Refund both parties' stakes after the deadline has passed.
    ///         Either party can call this.
    /// @param dropId The drop to refund.
    function refundDrop(uint256 dropId) external {
        Drop storage d = drops[dropId];
        require(
            d.status == DropStatus.Created ||
            d.status == DropStatus.Joined ||
            d.status == DropStatus.Depositing ||
            d.status == DropStatus.Ready,
            "Drop not refundable"
        );
        require(block.timestamp >= d.deadline, "Deadline not reached");
        require(
            msg.sender == d.partyA || msg.sender == d.partyB,
            "Not a party to this drop"
        );

        d.status = DropStatus.Refunded;

        emit DropRefunded(dropId);

        if (d.stakeA > 0) {
            (bool okA, ) = payable(d.partyA).call{value: d.stakeA}("");
            require(okA, "Stake A refund failed");
        }
        if (d.stakeB > 0) {
            (bool okB, ) = payable(d.partyB).call{value: d.stakeB}("");
            require(okB, "Stake B refund failed");
        }
    }

    /// @notice Cancel a drop before both deposits are in. Only the creator can cancel.
    /// @param dropId The drop to cancel.
    function cancelDrop(uint256 dropId) external {
        Drop storage d = drops[dropId];
        require(msg.sender == d.partyA, "Only creator can cancel");
        require(
            d.status == DropStatus.Created ||
            d.status == DropStatus.Joined ||
            d.status == DropStatus.Depositing,
            "Too late to cancel"
        );

        d.status = DropStatus.Cancelled;

        emit DropCancelled(dropId);

        // Return all stakes
        if (d.stakeA > 0) {
            (bool okA, ) = payable(d.partyA).call{value: d.stakeA}("");
            require(okA, "Stake A refund failed");
        }
        if (d.stakeB > 0) {
            (bool okB, ) = payable(d.partyB).call{value: d.stakeB}("");
            require(okB, "Stake B refund failed");
        }
    }

    /// @notice View a drop's details.
    function getDrop(uint256 dropId) external view returns (
        address partyA,
        address partyB,
        address arbiter,
        bytes32 criteriaHash,
        bytes32 commitmentA,
        bytes32 commitmentB,
        string memory cidA,
        string memory cidB,
        uint256 stakeA,
        uint256 stakeB,
        uint256 deadline,
        DropStatus status
    ) {
        Drop storage d = drops[dropId];
        return (
            d.partyA, d.partyB, d.arbiter, d.criteriaHash,
            d.commitmentA, d.commitmentB, d.cidA, d.cidB,
            d.stakeA, d.stakeB, d.deadline, d.status
        );
    }
}
