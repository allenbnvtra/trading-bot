/**
 * Builds an ioredis-compatible connection options object from REDIS_URL for
 * BullMQ's consumer side (@Processor's registerQueue connection). See
 * apps/api/src/common/redis-connection.ts for the producer-side equivalent
 * — both must agree on where Redis is, since REDIS_URL is the single
 * source of truth for that.
 */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  maxRetriesPerRequest: null;
}

export function createRedisConnectionOptions(): RedisConnectionOptions {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    password: url.password || undefined,
    // BullMQ's blocking commands require this to be null so it can manage
    // its own retry behavior instead of ioredis's.
    maxRetriesPerRequest: null,
  };
}
