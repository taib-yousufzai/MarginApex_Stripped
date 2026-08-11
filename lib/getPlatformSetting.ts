import { getRedisClient } from '@/lib/redis';

export async function getPlatformSetting(
  key: string,
  fallback: string,
): Promise<string> {
  const envVal = process.env[key];
  if (envVal) return envVal;

  try {
    const redis = getRedisClient();
    if (redis) {
      const val = await redis.get(`platform:${key}`);
      if (val) return val;
    }
  } catch (err) {
    // Ignore Redis errors, fallback to default
  }

  return fallback;
}

export async function setPlatformSetting(key: string, value: string): Promise<void> {
  try {
    const redis = getRedisClient();
    if (redis) {
      await redis.set(`platform:${key}`, value);
    }
  } catch (err) {
    console.error(`[setPlatformSetting] Failed to set platform:${key}`, err);
  }
}
