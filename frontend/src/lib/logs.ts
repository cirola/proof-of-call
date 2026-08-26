import type { AbiEvent, Address, Log, PublicClient } from "viem";

/**
 * `eth_getLogs` against endpoints that will not answer the whole range.
 *
 * Public Sepolia RPCs cap a log query at a few thousand blocks and answer an
 * over-wide range with an error rather than with a truncated result — so a naive
 * `fromBlock: 0n` query does not return partial data, it returns nothing at all.
 * Chunking is not an optimization here; it is the difference between a
 * leaderboard and an empty page.
 *
 * The chunk halves itself on a range error and gives up after a few attempts,
 * so an endpoint with a tighter cap than the default is discovered rather than
 * configured.
 */

const DEFAULT_CHUNK = 9_000n;
const MIN_CHUNK = 500n;

export async function getLogsInChunks<TEvent extends AbiEvent>(
  client: PublicClient,
  params: {
    address: Address;
    event: TEvent;
    fromBlock: bigint;
    toBlock: bigint;
  },
): Promise<Log<bigint, number, false, TEvent, true>[]> {
  const collected: Log<bigint, number, false, TEvent, true>[] = [];

  let cursor = params.fromBlock;
  let chunk = DEFAULT_CHUNK;

  while (cursor <= params.toBlock) {
    const end = cursor + chunk - 1n > params.toBlock ? params.toBlock : cursor + chunk - 1n;

    try {
      const logs = await client.getLogs({
        address: params.address,
        event: params.event,
        fromBlock: cursor,
        toBlock: end,
        strict: true,
      });
      collected.push(...(logs as Log<bigint, number, false, TEvent, true>[]));
      cursor = end + 1n;
    } catch (error) {
      if (chunk <= MIN_CHUNK) throw error;
      chunk = chunk / 2n;
    }
  }

  return collected;
}
