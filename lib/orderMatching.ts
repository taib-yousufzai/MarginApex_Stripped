import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient } from './adminClient.ts';
import { telemetry } from './metrics.ts';
import { checkAndExecuteAccountLiquidation } from './liquidationEngine.ts';
import { calculateCarryBrokerage } from './trading/BrokerageCalculator';
import { isContractExpired } from './contractExpiry.ts';
import { calculateFloatingPnl, calculateExitPrice } from './floatingPnl.ts';

export interface Quote {
  id: string; // e.g. "NSE:INFY"
  last_price: number;
}

export class InMemoryMatchingEngine {
  public isInitialized = false;
  public activeOrders = new Map<string, any>();
  public activePositions = new Map<string, any>();
  public userProfiles = new Map<string, any>();
  public segmentSettings = new Map<string, any>();
  public tradingHours = new Map<string, any>();

  // Per-user liquidation guard: prevents a second liquidation attempt from
  // starting while the first one is still closing positions.  The Set stores
  // user IDs that are currently being liquidated.
  private liquidationInProgress = new Set<string>();

  public async initialize() {
    const admin = getAdminClient();

    const dbStart = performance.now();
    // 1. Fetch pending orders, open positions, and trading hours
    const [ordersRes, positionsRes, tradingHoursRes] = await Promise.all([
      admin.from('orders').select('*').eq('status', 'PENDING'),
      admin.from('positions').select('*').eq('status', 'open'),
      admin.from('trading_hours').select('*').eq('is_active', true)
    ]);

    const pendingOrders = ordersRes.data ?? [];
    const openPositions = positionsRes.data ?? [];
    const tradingHoursData = tradingHoursRes.data ?? [];

    this.tradingHours.clear();
    for (const th of tradingHoursData) {
      this.tradingHours.set(th.id, th);
    }

    this.activeOrders.clear();
    for (const order of pendingOrders) {
      this.activeOrders.set(order.id, order);
    }

    this.activePositions.clear();
    for (const pos of openPositions) {
      this.activePositions.set(pos.id, pos);
    }

    // 2. Fetch user profiles and segment settings for involved users
    const userIds = Array.from(new Set([
      ...pendingOrders.map(o => o.user_id),
      ...openPositions.map(p => p.user_id)
    ]));

    this.segmentSettings.clear();
    this.userProfiles.clear();

    if (userIds.length > 0) {
      // Fetch profiles to determine which users are scalpers
      const [segSettingsRes, scalperSegSettingsRes, profilesRes] = await Promise.all([
        admin
          .from('segment_settings')
          .select('user_id, segment, side, entry_buffer, bid_buffer, exit_buffer, carry_commission_type, carry_commission_value, commission_type, commission_value')
          .in('user_id', userIds),
        admin
          .from('scalper_segment_settings')
          .select('user_id, segment, side, entry_buffer, bid_buffer, exit_buffer, carry_commission_type, carry_commission_value, commission_type, commission_value')
          .in('user_id', userIds),
        admin
          .from('profiles')
          .select('id, balance, auto_sqoff, trading_mode')
          .in('id', userIds)
      ]);

      // Build a set of scalper user IDs so we know which settings table to prefer
      const scalperUserIds = new Set<string>();
      if (profilesRes.data) {
        const dataArr = Array.isArray(profilesRes.data) ? profilesRes.data : [profilesRes.data];
        for (const p of dataArr) {
          if (p && p.id) {
            this.userProfiles.set(p.id, p);
            if (p.trading_mode === 'scalper') scalperUserIds.add(p.id);
          } else if (p && userIds.length === 1) {
            this.userProfiles.set(userIds[0], p);
          }
        }
      }

      // Load standard segment settings (for non-scalpers)
      if (segSettingsRes.data) {
        for (const s of segSettingsRes.data) {
          if (scalperUserIds.has(s.user_id)) continue; // scalper — will be overridden below
          const key = `${s.user_id}|${s.segment}|${s.side}`;
          this.segmentSettings.set(key, {
            entry_buffer: Number(s.entry_buffer ?? 0.3),
            bid_buffer: Number(s.bid_buffer ?? 0.3),
            exit_buffer: Number(s.exit_buffer ?? 0.17),
            carry_commission_type: s.carry_commission_type || null,
            carry_commission_value: s.carry_commission_value != null ? Number(s.carry_commission_value) : null,
            commission_type: s.commission_type || null,
            commission_value: s.commission_value != null ? Number(s.commission_value) : null,
          });
        }
      }

      // Load scalper segment settings (for scalpers), overriding standard ones
      if (scalperSegSettingsRes.data) {
        for (const s of scalperSegSettingsRes.data) {
          if (!scalperUserIds.has(s.user_id)) continue; // not a scalper — skip
          const key = `${s.user_id}|${s.segment}|${s.side}`;
          this.segmentSettings.set(key, {
            entry_buffer: Number(s.entry_buffer ?? 0.3),
            bid_buffer: Number(s.bid_buffer ?? 0.3),
            exit_buffer: Number(s.exit_buffer ?? 0.17),
            carry_commission_type: s.carry_commission_type || null,
            carry_commission_value: s.carry_commission_value != null ? Number(s.carry_commission_value) : null,
            commission_type: s.commission_type || null,
            commission_value: s.commission_value != null ? Number(s.commission_value) : null,
          });
        }
      }
    }

    telemetry.recordDbCall('read', performance.now() - dbStart);
    this.isInitialized = true;
  }

  public setupRealtimeSync() {
    const admin = getAdminClient();

    admin
      .channel('matching-engine-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        const row = (payload.new || payload.old) as any;
        if (!row || !row.id) return;
        if (row.status === 'PENDING') {
          this.activeOrders.set(row.id, row);
        } else {
          this.activeOrders.delete(row.id);
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, (payload) => {
        const row = (payload.new || payload.old) as any;
        if (!row || !row.id) return;
        if (row.status === 'open') {
          this.activePositions.set(row.id, row);
          // If this user's profile isn't cached yet, fetch it immediately so the
          // liquidation check isn't silently skipped on the next price tick.
          // This happens when a user opens their first position after the engine
          // initialized (userProfiles is only seeded at startup for known users).
          if (row.user_id && !this.userProfiles.has(row.user_id)) {
            const admin = getAdminClient();
            (async () => {
              const { data } = await admin
                .from('profiles')
                .select('id, balance, auto_sqoff')
                .eq('id', row.user_id)
                .single();
              if (data && data.id) {
                this.userProfiles.set(data.id, data);
              }
            })();
          }
        } else {
          this.activePositions.delete(row.id);
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
        const row = payload.new as any;
        if (row && row.id) {
          this.userProfiles.set(row.id, row);
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'segment_settings' }, (payload) => {
        const row = payload.new as any;
        if (row && row.user_id) {
          const key = `${row.user_id}|${row.segment}|${row.side}`;
          // Only apply if user is not a scalper (scalper settings come from scalper table)
          const profile = this.userProfiles.get(row.user_id);
          if (!profile || profile.trading_mode !== 'scalper') {
            this.segmentSettings.set(key, {
              entry_buffer: Number(row.entry_buffer ?? 0.3),
              bid_buffer: Number(row.bid_buffer ?? 0.3),
              exit_buffer: Number(row.exit_buffer ?? 0.17),
              carry_commission_type: row.carry_commission_type || null,
              carry_commission_value: row.carry_commission_value != null ? Number(row.carry_commission_value) : null,
              commission_type: row.commission_type || null,
              commission_value: row.commission_value != null ? Number(row.commission_value) : null,
            });
          }
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scalper_segment_settings' }, (payload) => {
        const row = payload.new as any;
        if (row && row.user_id) {
          const key = `${row.user_id}|${row.segment}|${row.side}`;
          // Only apply if user IS a scalper
          const profile = this.userProfiles.get(row.user_id);
          if (profile && profile.trading_mode === 'scalper') {
            this.segmentSettings.set(key, {
              entry_buffer: Number(row.entry_buffer ?? 0.3),
              bid_buffer: Number(row.bid_buffer ?? 0.3),
              exit_buffer: Number(row.exit_buffer ?? 0.17),
              carry_commission_type: row.carry_commission_type || null,
              carry_commission_value: row.carry_commission_value != null ? Number(row.carry_commission_value) : null,
              commission_type: row.commission_type || null,
              commission_value: row.commission_value != null ? Number(row.commission_value) : null,
            });
          }
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trading_hours' }, (payload) => {
        const row = payload.new as any;
        if (row && row.id && row.is_active) {
          this.tradingHours.set(row.id, row);
        } else if (row && row.id && !row.is_active) {
          this.tradingHours.delete(row.id);
        }
      })
      .subscribe();
  }

  /**
   * Periodic balance sync — runs every 5 seconds.
   * Fetches balance + auto_sqoff for ALL users who currently have open positions
   * in a single batched DB query. This is the safety net for Realtime misses
   * (Railway restarts, network blips) without doing a per-tick DB read.
   * One query per 5 seconds regardless of how many users are active.
   */
  public startBalanceSync() {
    const admin = getAdminClient();
    setInterval(async () => {
      const userIds = Array.from(
        new Set(Array.from(this.activePositions.values()).map((p: any) => p.user_id))
      );
      if (userIds.length === 0) return;

      try {
        const { data } = await admin
          .from('profiles')
          .select('id, balance, auto_sqoff, trading_mode')
          .in('id', userIds);

        if (data) {
          for (const profile of data) {
            if (profile?.id) this.userProfiles.set(profile.id, profile);
          }
        }
      } catch {
        // Non-fatal — Realtime will catch up
      }
    }, 5000);
  }

  public async process(quotes: Quote[]) {
    const start = performance.now();
    const admin = getAdminClient();

    // Build lookup map of prices
    const pricesMap = new Map<string, number>();
    for (const quote of quotes) {
      pricesMap.set(quote.id, quote.last_price);
    }

    const pendingOrders = Array.from(this.activeOrders.values());
    const openPositions = Array.from(this.activePositions.values());

    // Compute current IST time in HH:mm for EOD square-off
    const now = new Date();
    const istTimeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' });

    const mapSegmentToTradingHoursId = (segment: string) => {
      const seg = (segment || '').toUpperCase();
      if (seg.includes('MCX')) return 'mcx';
      if (seg.includes('CDS') || seg.includes('FOREX')) return 'forex';
      if (seg.includes('COMEX') || seg.includes('COI')) return 'comex';
      if (seg.includes('CRYPTO') || seg === 'USDT') return 'crypto';
      if (seg.includes('BSE')) return 'bse';
      return 'nse'; // Default for NSE-EQ, INDEX-OPT, NFO, etc.
    };

    // 1. PROCESS PENDING ORDERS
    if (pendingOrders.length > 0) {
      for (const order of pendingOrders) {
        const symbolKey = order.kite_instrument || order.symbol;
        const ltp = pricesMap.get(symbolKey);

        if (ltp === undefined || ltp <= 0) {
          continue;
        }

        let shouldTrigger = false;

        const orderType = order.order_type;
        const side = order.side;
        const triggerPrice = order.trigger_price ? Number(order.trigger_price) : null;
        const limitPrice = order.price ? Number(order.price) : null;

        if (orderType === 'LIMIT' && limitPrice !== null) {
          if (side === 'BUY' && ltp <= limitPrice) {
            shouldTrigger = true;
          } else if (side === 'SELL' && ltp >= limitPrice) {
            shouldTrigger = true;
          }
        } else if ((orderType === 'SL' || orderType === 'SLM') && triggerPrice !== null) {
          if (side === 'BUY' && ltp >= triggerPrice) {
            shouldTrigger = true;
          } else if (side === 'SELL' && ltp <= triggerPrice) {
            shouldTrigger = true;
          }
        } else if (orderType === 'GTT') {
          if (triggerPrice !== null) {
            const ltpAtEntry = order.ltp_at_entry ? Number(order.ltp_at_entry) : null;
            if (side === 'BUY') {
              if (ltpAtEntry !== null && ltpAtEntry < triggerPrice) {
                if (ltp >= triggerPrice) shouldTrigger = true;
              } else {
                if (ltp <= triggerPrice) shouldTrigger = true;
              }
            } else if (side === 'SELL') {
              if (ltpAtEntry !== null && ltpAtEntry > triggerPrice) {
                if (ltp <= triggerPrice) shouldTrigger = true;
              } else {
                if (ltp >= triggerPrice) shouldTrigger = true;
              }
            }
          }

          const stopLoss = order.stop_loss ? Number(order.stop_loss) : null;
          const target = order.target ? Number(order.target) : null;
          if (triggerPrice === null) {
            if (!shouldTrigger && stopLoss !== null) {
              if (side === 'BUY') {
                if (ltp >= stopLoss) shouldTrigger = true;
              } else if (side === 'SELL') {
                if (ltp <= stopLoss) shouldTrigger = true;
              }
            }
            if (!shouldTrigger && target !== null) {
              if (side === 'BUY') {
                if (ltp <= target) shouldTrigger = true;
              } else if (side === 'SELL') {
                if (ltp >= target) shouldTrigger = true;
              }
            }
          }
        }

        if (shouldTrigger) {
          // For exit orders only: verify an opposing open position exists in memory
          // (Entry orders are always allowed — each creates its own position row)
          if (order.is_exit) {
            const existingPos = openPositions.filter((p) => p.symbol === order.symbol);
            if (order.side === 'BUY') {
              if (!existingPos.some((p) => p.side === 'SELL')) continue;
            } else if (order.side === 'SELL') {
              if (!existingPos.some((p) => p.side === 'BUY')) continue;
            }
          }

          // ─── Apply entry/exit buffers (same logic as orders/route.ts) ───
          // fillPrice stays as raw LTP for the user's position record.
          // bufferFee = absolute price difference * qty, charged as BUFFER_FEE_DEBIT.
          const buySetting = this.segmentSettings.get(`${order.user_id}|${order.segment}|BUY`);
          const sellSetting = this.segmentSettings.get(`${order.user_id}|${order.segment}|SELL`);
          const buyEntryBuffer = (buySetting?.entry_buffer ?? 0.3) / 100;
          const buyBidBuffer = (buySetting?.bid_buffer ?? 0.3) / 100;
          const buyExitBuffer = (buySetting?.exit_buffer ?? 0.17) / 100;
          const sellEntryBuffer = (sellSetting?.entry_buffer ?? 0.3) / 100;
          const sellBidBuffer = (sellSetting?.bid_buffer ?? 0.3) / 100;
          const sellExitBuffer = (sellSetting?.exit_buffer ?? 0.17) / 100;

          let priceWithBuffer = ltp;
          if (order.side === 'BUY') {
            priceWithBuffer = order.is_exit
              ? ltp * (1 + sellExitBuffer)   // closing SELL/short: ask + SELL exit_buffer
              : ltp * (1 + buyEntryBuffer);   // long entry: ask + BUY entry_buffer
          } else {
            priceWithBuffer = order.is_exit
              ? ltp * (1 - buyExitBuffer)    // closing BUY/long: bid - BUY exit_buffer
              : ltp * (1 - sellEntryBuffer); // short entry: bid - SELL entry_buffer
          }

          // Fill price is the actual execution price (ask for BUY, bid for SELL).
          // Buffer is baked into the fill price so avg_price reflects what the user paid.
          const bufferFee = 0;
          const executionFillPrice = Math.max(0.01, Math.round(priceWithBuffer * 100) / 100);

          // Trigger Executed Order Write (Business Event)
          const dbStart = performance.now();
          const { error: updateOrderErr } = await admin
            .from('orders')
            .update({
              status: 'EXECUTED',
              fill_price: executionFillPrice,
              buffer_fee: bufferFee,
              updated_at: new Date().toISOString(),
            })
            .eq('id', order.id);

          telemetry.recordDbCall('write', performance.now() - dbStart);

          if (updateOrderErr) {
            console.error(`[Order Matching] Failed to update order ${order.id} to EXECUTED:`, updateOrderErr);
            continue;
          }

          // Update memory cache immediately
          this.activeOrders.delete(order.id);

          const rpcStart = performance.now();
          const { error: rpcErr } = await admin.rpc('process_executed_position', {
            p_order_id: order.id,
          });

          telemetry.recordDbCall('write', performance.now() - rpcStart);
          telemetry.recordTriggerExecution(performance.now() - rpcStart);

          if (rpcErr) {
            console.error(`[Order Matching] Failed to process executed position for order ${order.id}:`, rpcErr);
          }

          let finalBrokerage = 0;
          let marginStr = '';
          try {
            const { data: ordCheck } = await admin.from('orders').select('brokerage, product_type').eq('id', order.id).maybeSingle();
            if (ordCheck) finalBrokerage = Number(ordCheck.brokerage || 0);

            // Fetch missing leverage details from the profile or just fallback to generic approximations
            // Since we don't have intraday_leverage fetched here, we'll approximate based on generic rules
            const leverage = ordCheck?.product_type === 'CARRY' ? 5 : 50;
            const requiredMargin = (order.qty * executionFillPrice) / leverage + finalBrokerage;
            marginStr = ` | Margin Req: ₹${requiredMargin.toFixed(2)} | Bkg: ₹${finalBrokerage.toFixed(2)} | Buf: ₹0.00`;
          } catch (e) {
            console.error(e);
          }

          const auditStart = performance.now();
          await admin.from('act_logs').insert({
            type: 'ORDER_EXECUTION',
            user_id: order.user_id,
            target_user_id: order.user_id,
            symbol: order.symbol,
            qty: order.qty,
            price: executionFillPrice,
            reason: `${orderType} Order Triggered @ ${ltp}${marginStr}`,
          });
          telemetry.recordDbCall('write', performance.now() - auditStart);
        }
      }
    }

    // 2. PROCESS OPEN POSITIONS — ACCOUNT-LEVEL LIQUIDATION
    if (openPositions.length > 0) {
      const userOpenPositions: Record<string, any[]> = {};
      for (const pos of openPositions) {
        if (!userOpenPositions[pos.user_id]) {
          userOpenPositions[pos.user_id] = [];
        }
        userOpenPositions[pos.user_id].push(pos);
      }

      const closedPositionIds = new Set<string>();

      for (const [userId, userPositions] of Object.entries(userOpenPositions)) {
        // ── In-flight guard ──────────────────────────────────────────────────
        // If we're already in the middle of closing this user's positions from
        // a previous tick batch, skip — don't start a second concurrent attempt.
        if (this.liquidationInProgress.has(userId)) continue;

        let cachedProfile = this.userProfiles.get(userId);

        // ── Balance freshness strategy ───────────────────────────────────────
        // The Realtime subscription (setupRealtimeSync) keeps userProfiles up-to-
        // date: every time sync_profile_balance fires in the DB (on any transaction
        // INSERT/UPDATE/DELETE), it updates profiles.balance, and Supabase Realtime
        // pushes that change to us within ~100-200ms.
        //
        // So for users already in the cache, the Realtime-maintained balance is
        // accurate enough — we don't need a DB round-trip on every tick.
        //
        // Exception: if the profile isn't in the cache at all (user just opened
        // their first position after the engine initialised, or realtime missed the
        // initial event), we do a one-time live fetch to seed the cache.
        // After that, realtime keeps it fresh.
        if (!cachedProfile) {
          try {
            const { data: freshProfile } = await admin
              .from('profiles')
              .select('id, balance, auto_sqoff')
              .eq('id', userId)
              .single();

            if (freshProfile && freshProfile.id) {
              this.userProfiles.set(freshProfile.id, freshProfile);
              cachedProfile = freshProfile;
            }
          } catch {
            // Non-fatal — skip this user for this tick
          }
        }

        // ── Live balance: trust Realtime-maintained cache ─────────────────
        // The profiles Realtime subscription (setupRealtimeSync) updates
        // userProfiles within ~100-200ms of any balance change (deposit, PnL, etc).
        // The 5-second periodic sync (startBalanceSync) self-heals any missed
        // Realtime events without hammering the DB on every tick.
        let balance = Number(cachedProfile.balance || 0);
        const autoSqoffPercent = Number(cachedProfile.auto_sqoff ?? 90);
        if (autoSqoffPercent <= 0) continue;

        // Resolve LTP for each position and compute total floating PnL (account-level)
        let totalFloatingPnl = 0;
        const positionsWithLtp: any[] = [];

        for (const pos of userPositions) {
          let ltp = pricesMap.get(pos.symbol);

          if (ltp === undefined) {
            for (const key of pricesMap.keys()) {
              if (
                key === pos.symbol || 
                key.endsWith(`:${pos.symbol}`) || 
                key === `${pos.symbol}USDT`
              ) {
                ltp = pricesMap.get(key);
                break;
              }
            }
          }

          if (ltp === undefined || ltp <= 0) {
            ltp = Number(pos.ltp ?? pos.entry_price);
            // Only warn when the symbol is a live (non-expired) contract.
            // Expired futures simply have no feed — that's expected, not a bug.
            if (!isContractExpired(pos.symbol)) {
              // Removed console.warn to prevent Railway log rate limiting
              // console.warn(
              //   `[OrderMatching] No live LTP for ${pos.symbol} (user ${userId}). ` +
              //     `Using fallback ltp=${ltp}. Check ticker subscription.`
              // );
            }
          }

          const entryPrice = Number(pos.entry_price ?? pos.avg_price);
          const qty = Number(pos.qty_open ?? 0);

          // Guard: if entry_price is missing/NaN, skip this position from PnL
          // computation.  NaN would poison totalFloatingPnl → NaN > threshold
          // is always false → triggers a false liquidation.
          if (isNaN(entryPrice) || isNaN(qty) || qty <= 0) {
            console.warn(
              `[OrderMatching] Skipping position ${pos.id} (${pos.symbol}): ` +
              `invalid entryPrice=${entryPrice} or qty=${qty}`,
            );
            positionsWithLtp.push({ ...pos, ltp, qty_open: qty, entry_price: entryPrice });
            continue;
          }

          // exit_buffer is stored as a percentage in the DB (e.g. 0.17 = 0.17%), divide by 100
          const buyExitBufferPct = this.segmentSettings.get(`${userId}|${pos.settlement}|BUY`)?.exit_buffer ?? 0.17;
          const sellExitBufferPct = this.segmentSettings.get(`${userId}|${pos.settlement}|SELL`)?.exit_buffer ?? 0.17;

          // Liquidation PnL is calculated based on Bid price (exit-buffer-adjusted)
          const pnl = calculateFloatingPnl({
            side: pos.side,
            ltp,
            entryPrice,
            qty,
            exitBufferPct: pos.side === 'BUY' ? buyExitBufferPct : sellExitBufferPct,
          });

          totalFloatingPnl += pnl;
          positionsWithLtp.push({ ...pos, ltp, qty_open: qty, entry_price: entryPrice });
        }

        // Account-level liquidation: check total PnL against -(balance × auto_sqoff%)
        // Wrap in in-flight guard: mark this user as being liquidated so concurrent
        // tick batches don't start a second liquidation while the first is still
        // closing positions (each close_position RPC takes ~50-200ms).
        this.liquidationInProgress.add(userId);
        let liquidationResult;
        try {
          liquidationResult = await checkAndExecuteAccountLiquidation(
            userId,
            balance,
            autoSqoffPercent,
            positionsWithLtp,
            totalFloatingPnl,
            this.segmentSettings,
            admin,
          );
        } finally {
          this.liquidationInProgress.delete(userId);
        }

        if (liquidationResult.liquidated) {
          // Mark all user positions as closed for downstream SL/TP/EOD processing
          for (const pos of userPositions) {
            closedPositionIds.add(pos.id);
            this.activePositions.delete(pos.id);
          }
          telemetry.recordTriggerExecution(0);
        }
      }

      // 5. PROCESS STOP LOSS AND TARGET FOR REMAINING OPEN POSITIONS
      // Collect all positions that need closing first, then fire RPCs in parallel
      const positionsToClose: Array<{ pos: any; ltp: number; exitPrice: number; closeReason: string; carryBrokerage: number }> = [];

      for (const pos of openPositions) {
        if (closedPositionIds.has(pos.id)) continue;

        let ltp = pricesMap.get(pos.symbol);

        if (ltp === undefined) {
          for (const key of pricesMap.keys()) {
            if (key === pos.symbol || key.endsWith(`:${pos.symbol}`)) {
              ltp = pricesMap.get(key);
              break;
            }
          }
        }

        if (ltp === undefined || ltp <= 0) continue;

        let shouldClose = false;
        let closeReason = 'AUTO_LIQUIDATION';

        const stopLoss = pos.stop_loss ? Number(pos.stop_loss) : (pos.sl ? Number(pos.sl) : null);
        const target = pos.target ? Number(pos.target) : (pos.tp ? Number(pos.tp) : null);
        const side = pos.side;

        if (stopLoss !== null && stopLoss > 0) {
          if (side === 'BUY' && ltp <= stopLoss) { shouldClose = true; closeReason = 'STOP_LOSS'; }
          else if (side === 'SELL' && ltp >= stopLoss) { shouldClose = true; closeReason = 'STOP_LOSS'; }
        }

        if (!shouldClose && target !== null && target > 0) {
          if (side === 'BUY' && ltp >= target) { shouldClose = true; closeReason = 'TARGET_HIT'; }
          else if (side === 'SELL' && ltp <= target) { shouldClose = true; closeReason = 'TARGET_HIT'; }
        }

        if (!shouldClose && pos.product_type === 'INTRADAY') {
          const thId = mapSegmentToTradingHoursId(pos.settlement);
          const th = this.tradingHours.get(thId);
          if (th && th.end_time && istTimeStr >= th.end_time) {
            shouldClose = true;
            closeReason = 'SYSTEM_ACTION';
          }
        }

        if (shouldClose) {
          const segSettingForClose = this.segmentSettings.get(`${pos.user_id}|${pos.settlement}|${pos.side}`);
          const exitBufferPct = segSettingForClose?.exit_buffer ?? 0.17;
          const exitPrice = calculateExitPrice({ side: pos.side, ltp, exitBufferPct });

          const carryBrokerage = calculateCarryBrokerage({
            productType: pos.product_type,
            qty: Number(pos.qty_open),
            entryPrice: Number(pos.entry_price),
            carryCommissionType: segSettingForClose?.carry_commission_type,
            carryCommissionValue: segSettingForClose?.carry_commission_value,
            commissionType: segSettingForClose?.commission_type,
            commissionValue: segSettingForClose?.commission_value,
          });

          positionsToClose.push({ pos, ltp, exitPrice, closeReason, carryBrokerage });
        }
      }

      // Fire all SL/TP/EOD closes in parallel
      if (positionsToClose.length > 0) {
        const closeStart = performance.now();
        await Promise.all(positionsToClose.map(async ({ pos, ltp, exitPrice, closeReason, carryBrokerage }) => {
          const { error: closeRpcErr } = await admin.rpc('close_position', {
            p_position_id: pos.id,
            p_user_id: pos.user_id,
            p_ltp: ltp,
            p_exit_price: exitPrice,
            p_closed_by: closeReason,
            p_brokerage: carryBrokerage,
          });

          if (closeRpcErr) {
            console.error(`[Order Matching] Failed to close position ${pos.id} (${closeReason}):`, closeRpcErr);
          } else {
            this.activePositions.delete(pos.id);
          }
        }));
        telemetry.recordDbCall('write', performance.now() - closeStart);
        telemetry.recordTriggerExecution(performance.now() - closeStart);
      }
    }

    const duration = performance.now() - start;
    telemetry.recordMatchingEngine(pendingOrders.length, openPositions.length, duration);
  }
}

export const matchingEngine = new InMemoryMatchingEngine();

export async function processPendingOrdersAndPositions(quotes: Quote[]): Promise<void> {
  if (!quotes || quotes.length === 0) return;

  if (!matchingEngine.isInitialized || process.env.NODE_ENV === 'test') {
    await matchingEngine.initialize();
  }

  await matchingEngine.process(quotes);
}


