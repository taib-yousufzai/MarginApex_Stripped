/**
 * Normalizes option contract depth (Bid / Ask) against Last Traded Price (LTP)
 * to prevent stale or impossible order-book depth display while preserving
 * valid exchange depth.
 */
export function normalizeOptionQuoteDepth(
  ltp: number,
  rawBid: number,
  rawAsk: number
): { bid: number; ask: number } {
  // If no LTP or no depth available, return raw values (or 0 / 0 for no depth)
  if (!ltp || ltp <= 0) return { bid: rawBid > 0 ? rawBid : 0, ask: rawAsk > 0 ? rawAsk : 0 };
  if ((!rawBid || rawBid <= 0) && (!rawAsk || rawAsk <= 0)) {
    return { bid: 0, ask: 0 };
  }

  let bid = rawBid > 0 ? rawBid : 0;
  let ask = rawAsk > 0 ? rawAsk : 0;

  // 1. If LTP is strictly within a balanced, valid exchange spread (bid <= ltp <= ask),
  //    and the ask is not disproportionately stale relative to the bid-to-ltp distance:
  if (bid > 0 && ask > 0 && bid <= ltp && ltp <= ask) {
    const bidDistance = ltp - bid;
    const askDistance = ask - ltp;

    // A spread is valid and preserved if ask is reasonably balanced relative to bid distance.
    // If ask is disproportionately far above LTP (e.g. LTP 2724, Bid 2713, Ask 2857),
    // the ask is stale relative to the trade that just executed at LTP.
    const maxReasonableAskDistance = Math.max(bidDistance * 3, 50);
    if (askDistance <= maxReasonableAskDistance) {
      return { bid, ask };
    }
  }

  // 2. Normalize Ask:
  //    - If LTP < Ask (outside valid spread or ask is stale): Ask is capped to LTP.
  //    - If LTP > Ask (LTP above Ask): Ask is stale below LTP and becomes LTP.
  if (ask > 0) {
    if (ltp < ask) {
      ask = ltp;
    } else if (ltp > ask) {
      ask = ltp;
    }
  }

  // 3. Normalize Bid:
  //    - If Bid > LTP: Bid cannot be higher than LTP, so Bid becomes LTP.
  if (bid > 0) {
    if (bid > ltp) {
      bid = ltp;
    }
  }

  // 4. Preserve Bid <= Ask invariant:
  if (bid > 0 && ask > 0 && bid > ask) {
    ask = bid;
  }

  return { bid, ask };
}
