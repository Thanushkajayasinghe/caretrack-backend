import { getRedis } from '../config/redis.js';

const LATEST_KEY_PREFIX = 'child:latest:';
const TRAIL_KEY_PREFIX = 'child:trail:';
const TTL_SECONDS = 86400; // 24 hours
const MAX_TRAIL_POINTS = 100;

/**
 * Cache child's latest location point and append to the active trail.
 * Completely safe: catches all errors so Redis issues never break the main app.
 */
export async function cacheLocation(childId, data) {
  if (!childId || !data || data.lat == null || data.lng == null) return;

  try {
    const redis = getRedis();
    if (!redis) return;

    const payload = {
      lat: Number(data.lat),
      lng: Number(data.lng),
      accuracy: data.accuracy != null ? Number(data.accuracy) : null,
      speed: data.speed != null ? Number(data.speed) : 0,
      heading: data.heading != null ? Number(data.heading) : null,
      altitude: data.altitude != null ? Number(data.altitude) : null,
      battery_level: data.batteryLevel ?? data.battery_level ?? null,
      is_charging: data.isCharging ?? data.is_charging ?? null,
      recorded_at: data.recordedAt || data.recorded_at || new Date().toISOString(),
      cached_at: new Date().toISOString(),
    };

    const str = JSON.stringify(payload);
    const latestKey = `${LATEST_KEY_PREFIX}${childId}`;
    const trailKey = `${TRAIL_KEY_PREFIX}${childId}`;

    // 1. Save latest location with 24h TTL
    if (typeof redis.setex === 'function') {
      await redis.setex(latestKey, TTL_SECONDS, str).catch(() => {});
    }

    // 2. Append to trail list (LPUSH + LTRIM)
    if (typeof redis.lpush === 'function') {
      await redis.lpush(trailKey, str).catch(() => {});
      if (typeof redis.ltrim === 'function') {
        await redis.ltrim(trailKey, 0, MAX_TRAIL_POINTS - 1).catch(() => {});
      }
      if (typeof redis.expire === 'function') {
        await redis.expire(trailKey, TTL_SECONDS).catch(() => {});
      }
    }
  } catch (err) {
    // Fail silently — DB write has already succeeded
    console.warn('⚠️ [Redis LocationCache] Failed to cache location:', err.message);
  }
}

/**
 * Get latest known location from Redis cache.
 * Returns location object or null if cache miss or error.
 */
export async function getCachedLatestLocation(childId) {
  if (!childId) return null;

  try {
    const redis = getRedis();
    if (!redis || typeof redis.get !== 'function') return null;

    const raw = await redis.get(`${LATEST_KEY_PREFIX}${childId}`);
    if (!raw) return null;

    return JSON.parse(raw);
  } catch (err) {
    console.warn('⚠️ [Redis LocationCache] Failed to get cached location:', err.message);
    return null;
  }
}

/**
 * Get recent trail points from Redis cache.
 * Returns array of points in chronological order (oldest to newest) or null.
 */
export async function getCachedTrail(childId, limit = 100) {
  if (!childId) return null;

  try {
    const redis = getRedis();
    if (!redis || typeof redis.lrange !== 'function') return null;

    const count = Math.min(limit, MAX_TRAIL_POINTS) - 1;
    const items = await redis.lrange(`${TRAIL_KEY_PREFIX}${childId}`, 0, count);
    if (!items || items.length === 0) return null;

    // Items from LPUSH are in reverse chronological order (newest first)
    // Reverse them to chronological order (oldest to newest) for maps
    const parsed = items.map((i) => JSON.parse(i)).reverse();
    return parsed;
  } catch (err) {
    console.warn('⚠️ [Redis LocationCache] Failed to get cached trail:', err.message);
    return null;
  }
}

/**
 * Update cached battery & charging state in the child's latest location cache.
 * Ensures status heartbeats immediately reflect in Redis without waiting for a new GPS fix.
 */
export async function updateCachedDeviceStatus(childId, { batteryLevel, isCharging, lastSeen, speed, activityType } = {}) {
  if (!childId) return;

  try {
    const redis = getRedis();
    if (!redis || typeof redis.get !== 'function' || typeof redis.setex !== 'function') return;

    const key = `${LATEST_KEY_PREFIX}${childId}`;
    const raw = await redis.get(key);
    if (!raw) return;

    const data = JSON.parse(raw);
    if (batteryLevel !== undefined && batteryLevel !== null) {
      data.battery_level = Number(batteryLevel);
    }
    if (isCharging !== undefined && isCharging !== null) {
      data.is_charging = Boolean(isCharging);
    }
    if (speed !== undefined && speed !== null) {
      data.speed = Number(speed);
    }
    if (activityType) {
      data.activityType = activityType;
    }
    if (lastSeen) {
      data.last_seen = lastSeen;
    }
    data.cached_at = new Date().toISOString();

    await redis.setex(key, TTL_SECONDS, JSON.stringify(data)).catch(() => {});
  } catch (err) {
    console.warn('⚠️ [Redis LocationCache] Failed to update cached device status:', err.message);
  }
}

export default {
  cacheLocation,
  getCachedLatestLocation,
  getCachedTrail,
  updateCachedDeviceStatus,
};
