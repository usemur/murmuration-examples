// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title EscrowBounty — generic escrow with arbiter-signed release.
/// @notice Depositor locks ETH, arbiter (a Lit flow's vault PKP) signs a
///         release message, claimant calls releaseBounty with the signature.
///         The contract knows nothing about GitHub — it just holds funds and
///         verifies EIP-191 signatures from the arbiter.
/// @dev Deployed on Base mainnet: 0x926470ef334b72c6eBDF540a434316e87a7Aa562
contract EscrowBounty {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    enum BountyStatus { Open, Released, Refunded }

    struct Bounty {
        address depositor;
        address arbiter;        // flow's vault PKP address
        string  issueUrl;       // for reference only
        uint256 amount;
        uint256 deadline;       // block.timestamp after which depositor can refund
        BountyStatus status;
    }

    uint256 public nextBountyId;
    mapping(uint256 => Bounty) public bounties;

    event BountyCreated(uint256 indexed bountyId, address indexed depositor, address arbiter, string issueUrl, uint256 amount, uint256 deadline);
    event BountyReleased(uint256 indexed bountyId, address indexed recipient, uint256 amount);
    event BountyRefunded(uint256 indexed bountyId, address indexed depositor, uint256 amount);

    /// @notice Create a new bounty. Caller sends ETH as the reward.
    /// @param issueUrl     Reference URL (e.g. GitHub issue) — stored on-chain for transparency.
    /// @param arbiter      Address that can authorize release (the flow's vault PKP).
    /// @param timeoutSeconds Seconds from now until the depositor can reclaim funds.
    function createBounty(
        string calldata issueUrl,
        address arbiter,
        uint256 timeoutSeconds
    ) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "Must deposit ETH");
        require(arbiter != address(0), "Invalid arbiter");
        require(timeoutSeconds >= 1 hours, "Timeout too short");

        bountyId = nextBountyId++;
        bounties[bountyId] = Bounty({
            depositor: msg.sender,
            arbiter: arbiter,
            issueUrl: issueUrl,
            amount: msg.value,
            deadline: block.timestamp + timeoutSeconds,
            status: BountyStatus.Open
        });

        emit BountyCreated(bountyId, msg.sender, arbiter, issueUrl, msg.value, block.timestamp + timeoutSeconds);
    }

    /// @notice Release bounty funds to a recipient. Requires a valid EIP-191
    ///         signature from the arbiter over (bountyId, recipient, chainId).
    /// @param bountyId   The bounty to release.
    /// @param recipient  Where to send the ETH.
    /// @param signature  EIP-191 signature from the arbiter.
    function releaseBounty(
        uint256 bountyId,
        address payable recipient,
        bytes calldata signature
    ) external {
        Bounty storage b = bounties[bountyId];
        require(b.status == BountyStatus.Open, "Bounty not open");
        require(recipient != address(0), "Invalid recipient");

        // Verify arbiter signature: keccak256("BOUNTY_RELEASE", bountyId, recipient, chainId)
        bytes32 messageHash = keccak256(
            abi.encodePacked("BOUNTY_RELEASE", bountyId, recipient, block.chainid)
        );
        address signer = messageHash.toEthSignedMessageHash().recover(signature);
        require(signer == b.arbiter, "Invalid arbiter signature");

        b.status = BountyStatus.Released;
        uint256 amount = b.amount;

        emit BountyReleased(bountyId, recipient, amount);
        (bool ok, ) = recipient.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    /// @notice Refund bounty to depositor after the deadline has passed.
    /// @param bountyId The bounty to refund.
    function refundBounty(uint256 bountyId) external {
        Bounty storage b = bounties[bountyId];
        require(b.status == BountyStatus.Open, "Bounty not open");
        require(msg.sender == b.depositor, "Only depositor");
        require(block.timestamp >= b.deadline, "Deadline not reached");

        b.status = BountyStatus.Refunded;
        uint256 amount = b.amount;

        emit BountyRefunded(bountyId, b.depositor, amount);
        (bool ok, ) = payable(b.depositor).call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    /// @notice View a bounty's details.
    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        return bounties[bountyId];
    }
}
