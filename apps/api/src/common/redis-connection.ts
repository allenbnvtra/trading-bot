/**
 * Builds an ioredis-compatible connection options object from REDIS_URL for
 * BullMQ's producer side (BullModule.forRoot / registerQueue). The worker
 * builds an equivalent object from the same REDIS_URL for its consumer
 * side — see apps/worker/src/common/redis-connection.ts — so both ends of
 * the "backtest-run" queue always agree on where Redis is.
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
    // BullMQ's blocking commands (BRPOPLPUSH etc.) require this to be null;
    // it disables ioredis's own retry limit so bullmq can manage retries.
    maxRetriesPerRequest: null,
  };
}
