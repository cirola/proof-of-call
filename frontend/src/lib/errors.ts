import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import { formatDateTime, formatStake } from "./format";

/**
 * Custom revert errors, turned into something a person can act on.
 *
 * Both contracts revert with named custom errors carrying their arguments, which
 * is most of the work already done — but a wallet shows the user
 * `LaterRoundAvailable(0x8f0…, 18446744073709551621, 1735689600, 1735686000)`,
 * and there is no way to tell from that whether the fix is to retry, to wait, or
 * that the stake is already gone.
 *
 * The three that matter most are the round-lookup errors. All three are
 * recoverable by retrying with a different round id, which is exactly what the
 * user cannot guess and the message has to say.
 */

interface Decoded {
  /** What the user should read. */
  message: string;
  /** True when retrying the same action can plausibly succeed. */
  retryable: boolean;
}

function seconds(value: unknown): string {
  return formatDateTime(Number(value));
}

function decodeNamed(name: string, args: readonly unknown[]): Decoded | undefined {
  switch (name) {
    // ---- commit ----
    case "CommitmentAlreadyUsed":
      return {
        message:
          "You have already committed this exact prediction with this exact salt. " +
          "Change any field, or commit again to get a fresh salt.",
        retryable: false,
      };
    case "StakeBelowMinimum":
      return {
        message: `The stake is below the protocol minimum of ${formatStake(BigInt(String(args[1] ?? 0n)))}.`,
        retryable: false,
      };
    case "DeadlineTooSoon":
      return {
        message: `That deadline is sooner than the protocol allows. The earliest is ${seconds(args[1])}.`,
        retryable: false,
      };
    case "DeadlineTooLate":
      return {
        message: `That deadline is further out than the protocol allows. The latest is ${seconds(args[1])}.`,
        retryable: false,
      };
    case "EnforcedPause":
      return {
        message:
          "New commits are paused. Open calls are unaffected — reveals and forfeits still work.",
        retryable: true,
      };

    // ---- reveal and forfeit ----
    case "TooEarlyToReveal":
      return {
        message: `The deadline has not passed yet. Revealing opens at ${seconds(args[1])}.`,
        retryable: true,
      };
    case "RevealWindowClosed":
      return {
        message:
          `The reveal window closed at ${seconds(args[1])}. This call can now only be forfeited, ` +
          "and the stake goes to the treasury.",
        retryable: false,
      };
    case "RevealWindowStillOpen":
      return {
        message: `This call cannot be forfeited until its reveal window closes at ${seconds(args[1])}.`,
        retryable: true,
      };
    case "CallNotOpen":
      return {
        message: "This call has already been settled. Settled calls are permanent.",
        retryable: false,
      };
    case "NotAnalyst":
      return {
        message: "Only the account that committed a call can reveal it. Connect that wallet.",
        retryable: false,
      };
    case "CommitmentMismatch":
      return {
        message:
          "The parameters do not hash to the stored commitment. The salt or one of the fields " +
          "does not match what was committed — check the vault entry, or import your backup.",
        retryable: false,
      };
    case "CallNotFound":
      return { message: "No call exists with that id.", retryable: false };
    case "StakeTransferFailed":
      return {
        message:
          "The stake could not be sent to its recipient — the address rejected the transfer. " +
          "A contract wallet that cannot receive plain ETH cannot be paid out.",
        retryable: false,
      };

    // ---- settlement round lookup: all three are round-id problems ----
    case "LaterRoundAvailable":
      return {
        message:
          "That round is not the last one before the deadline — a later one also qualifies, and " +
          "the resolver only accepts the latest. Re-run the round search and try again.",
        retryable: true,
      };
    case "RoundAfterTimestamp":
      return {
        message:
          "That round was published after the deadline. Settlement uses the last round at or " +
          "before it. Re-run the round search and try again.",
        retryable: true,
      };
    case "StaleRoundForTimestamp":
      return {
        message:
          "The closest round before the deadline is older than this feed's staleness threshold. " +
          "The feed had no fresh price at the deadline, so the call cannot be settled.",
        retryable: false,
      };
    case "RoundNotComplete":
      return {
        message: "That round has no answer yet. Re-run the round search and try again.",
        retryable: true,
      };
    case "StalePrice":
      return {
        message:
          "The price feed has stopped updating. Settlement fails closed — try again once it recovers.",
        retryable: true,
      };
    case "FeedNotConfigured":
      return {
        message:
          "No price feed is configured for that asset, so the call can never be revealed. " +
          "It will forfeit when the window closes.",
        retryable: false,
      };
    case "NonPositivePrice":
      return {
        message: "The feed reported a non-positive price and the read was rejected.",
        retryable: true,
      };
    case "FutureTimestamp":
      return {
        message: "The feed reported a timestamp in the future and the read was rejected.",
        retryable: true,
      };

    // ---- access control ----
    case "AccessControlUnauthorizedAccount":
      return {
        message: "The connected account does not hold the role this action needs.",
        retryable: false,
      };

    default:
      return undefined;
  }
}

/**
 * Any thrown value from a wagmi write or read, as a message and a retry hint.
 *
 * A rejection in the wallet is separated out because it is not a failure: the
 * user changed their mind, and showing them a red error box for it is noise.
 */
export function describeError(error: unknown): Decoded {
  if (error instanceof BaseError) {
    const rejected = error.walk((candidate) => candidate instanceof UserRejectedRequestError);
    if (rejected) return { message: "Transaction rejected in the wallet.", retryable: true };

    const reverted = error.walk((candidate) => candidate instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? reverted.reason;
      if (name) {
        const decoded = decodeNamed(name, reverted.data?.args ?? []);
        if (decoded) return decoded;
        return { message: `The contract rejected the transaction: ${name}.`, retryable: false };
      }
    }

    return { message: error.shortMessage || error.message, retryable: true };
  }

  if (error instanceof Error) return { message: error.message, retryable: true };
  return { message: "Something went wrong.", retryable: true };
}

/** The message alone, for the many call sites that do not care about retryability. */
export function errorMessage(error: unknown): string {
  return describeError(error).message;
}
