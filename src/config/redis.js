import Redis from 'ioredis';

// In-memory fallback map for dev without Redis server
class MemoryStore {
  constructor() {
    this.store = new Map();
  }
  async setex(key, ttlSeconds, value) {
    this.store.set(key, value);
    setTimeout(() => this.store.delete(key), ttlSeconds * 1000);
    return 'OK';
  }
  async get(key) {
    return this.store.get(key) || null;
  }
  async del(key) {
    this.store.delete(key);
    return 1;
  }
  async lpush(key, value) {
    let list = this.store.get(key);
    if (!Array.isArray(list)) list = [];
    list.unshift(value);
    this.store.set(key, list);
    return list.length;
  }
  async ltrim(key, start, stop) {
    let list = this.store.get(key);
    if (Array.isArray(list)) {
      this.store.set(key, list.slice(start, stop + 1));
    }
    return 'OK';
  }
  async lrange(key, start, stop) {
    let list = this.store.get(key);
    if (!Array.isArray(list)) return [];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async expire(key, ttlSeconds) {
    setTimeout(() => this.store.delete(key), ttlSeconds * 1000);
    return 1;
  }
}

let redisClient = null;
let redisSub = null;
let isFallback = false;

export function getRedis() {
  if (!redisClient) throw new Error('Redis not initialized');
  return redisClient;
}

export function getRedisSub() {
  if (isFallback) return redisClient;
  if (!redisSub) throw new Error('Redis sub client not initialized');
  return redisSub;
}

export async function connectRedis() {
  try {
    const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: true,
      retryStrategy: () => null, // don't loop retries on fail
    });

    const sub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: true,
      retryStrategy: () => null,
    });

    client.on('error', () => {});
    sub.on('error', () => {});

    await client.connect();
    await sub.connect();

    redisClient = client;
    redisSub = sub;
    isFallback = false;
    console.log('✅ Redis connected');
    return redisClient;
  } catch (err) {
    console.warn('⚠️ Redis not found on localhost:6379. Using high-performance in-memory cache fallback.');
    redisClient = new MemoryStore();
    redisSub = redisClient;
    isFallback = true;
    return redisClient;
  }
}

export default { getRedis, connectRedis };
