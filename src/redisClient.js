import Redis from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

redis.on('error', (err) => console.error('[redis] error:', err.message));
redis.on('connect', () => console.log('[redis] connected'));
