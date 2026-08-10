import { getAdminClient } from '@/lib/adminClient';

export interface MarketHours {
  start_time: string;
  end_time: string;
  is_active: boolean;
}

export interface SegmentSetting {
  id: string;
  entry_buffer?: number;
  exit_buffer?: number;
  max_lot?: number;
  profit_hold_sec?: number;
  loss_hold_sec?: number;
  max_profit?: number;
  max_loss?: number;
  brokerage_per_unit?: number; // fallback
  margin_multiplier?: number;
}

export interface BrokerageConfig {
  intraday_charge: number;
  carry_charge: number;
  gtt_charge: number;
}

// In-memory cache for configurations to prevent DB spam on high-frequency trading bursts.
// This cache is short-lived (60 seconds) to ensure changes in the DB propagate quickly.
const CACHE_TTL_MS = 60 * 1000;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

class ConfigurationServiceClass {
  private cache = new Map<string, CacheEntry<any>>();

  private getCached<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  private setCached<T>(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Retrieves the market trading hours for a specific segment ID.
   */
  async getMarketHours(segmentId: string): Promise<MarketHours | null> {
    if (!segmentId || segmentId === 'crypto') return null;

    const cacheKey = `market_hours_${segmentId}`;
    const cached = this.getCached<MarketHours>(cacheKey);
    if (cached) return cached;

    const admin = getAdminClient();
    const { data, error } = await admin
      .from('trading_hours')
      .select('start_time, end_time, is_active')
      .eq('id', segmentId)
      .maybeSingle();

    if (error) {
      console.error(`[ConfigurationService] Failed to fetch market hours for segment ${segmentId}:`, error);
      return null;
    }
    if (!data) return null;

    this.setCached(cacheKey, data);
    return data;
  }

  /**
   * Retrieves segment-wide configurations (buffers, lot limits, scalping timers).
   */
  async getSegmentSettings(dbSegment: string): Promise<SegmentSetting | null> {
    const cacheKey = `segment_settings_${dbSegment}`;
    const cached = this.getCached<SegmentSetting>(cacheKey);
    if (cached) return cached;

    const admin = getAdminClient();
    const { data, error } = await admin
      .from('segment_settings')
      .select('*')
      .eq('segment', dbSegment)
      .maybeSingle();

    if (error) {
      console.error(`[ConfigurationService] Failed to fetch segment settings for ${dbSegment}:`, error);
      return null;
    }
    if (!data) {
      console.warn(`[ConfigurationService] No settings found for segment: ${dbSegment}`);
      return null;
    }

    this.setCached(cacheKey, data);
    return data;
  }

  /**
   * Resolves the brokerage configuration for a specific user and segment.
   * Checks for user-specific overrides, then segment defaults.
   */
  async getBrokerageConfig(userId: string, dbSegment: string, profileGroupId?: string): Promise<BrokerageConfig> {
    const cacheKey = `brokerage_${userId}_${dbSegment}`;
    const cached = this.getCached<BrokerageConfig>(cacheKey);
    if (cached) return cached;

    const admin = getAdminClient();
    
    // Default fallback values
    let intraday = 0;
    let carry = 0;
    let gtt = 0;

    // TODO: In the future, this can query a `brokerage_groups` or `user_brokerage_overrides` table.
    // For now, it queries the base segment_settings as a fallback.
    const segmentSettings = await this.getSegmentSettings(dbSegment);
    if (segmentSettings) {
      const baseCharge = Number(segmentSettings.brokerage_per_unit || 0);
      intraday = baseCharge;
      carry = baseCharge;
      gtt = baseCharge;
    }

    const config = {
      intraday_charge: intraday,
      carry_charge: carry,
      gtt_charge: gtt,
    };

    this.setCached(cacheKey, config);
    return config;
  }

  constructor() {
    this.initPubSubListener();
  }

  private async initPubSubListener() {
    try {
      const { createRedisPubSubClient, isRedisMock } = require('@/lib/redis');
      if (isRedisMock()) return;

      const pubsub = createRedisPubSubClient();
      pubsub.subscribe('config:invalidate');
      pubsub.on('message', (channel: string) => {
        if (channel === 'config:invalidate') {
          this.clearCache();
        }
      });
    } catch (err) {
      console.warn('[ConfigurationService] Failed to initialize Pub/Sub invalidation listener:', err);
    }
  }

  /**
   * Optional: Clear cache if an admin pushes an update.
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Caches whether shadow mode is globally enabled.
   */
  async isShadowModeEnabled(): Promise<boolean> {
    const cacheKey = 'shadow_mode_enabled';
    const cached = this.getCached<boolean>(cacheKey);
    if (cached !== null) return cached;

    const admin = getAdminClient();
    const { data } = await admin
      .from('shadow_mode_config')
      .select('enabled')
      .eq('id', 1)
      .maybeSingle();

    const enabled = data?.enabled ?? false;
    this.setCached(cacheKey, enabled);
    return enabled;
  }
}

export const ConfigurationService = new ConfigurationServiceClass();
