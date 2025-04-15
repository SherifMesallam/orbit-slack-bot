import { createClient } from 'redis';
import { redisUrl, DUPLICATE_EVENT_REDIS_PREFIX, DUPLICATE_EVENT_TTL } from '../config.js';

export let redisClient = null; // Initialize as null
export let isRedisReady = false;

if (redisUrl) {
    console.log("[Redis Service] Configuring Redis Client...");
    try {
        const client = createClient({
            url: redisUrl,
            socket: {
                reconnectStrategy: retries => {
                    const delay = Math.min(retries * 100 + Math.random() * 100, 3000);
                    console.log(`[Redis Service] Reconnect attempt ${retries}, delay ${delay.toFixed(0)}ms`);
                    return delay;
                }
            },
            pingInterval: 5000 // Send PING periodically
        });

        client.on('error', err => {
            console.error('[Redis Service] Redis Client Error:', err.message || err);
            isRedisReady = false;
        });
        client.on('connect', () => console.log('[Redis Service] Redis connecting...'));
        client.on('ready', () => {
            console.log('[Redis Service] Redis client connected and ready!');
            isRedisReady = true;
        });
        client.on('end', () => {
            console.log('[Redis Service] Redis connection closed.');
            isRedisReady = false;
        });
        client.on('reconnecting', () => console.log('[Redis Service] Redis reconnecting...'));

        redisClient = client; // Assign client

        // Initiate connection async
        redisClient.connect().catch(err => {
            console.error("[Redis Service] Initial Redis connection failed:", err.message || err);
        });

    } catch (initError) {
         console.error("[Redis Service] Failed to initialize Redis client object:", initError);
         redisClient = null; isRedisReady = false;
    }

} else {
    console.warn("[Redis Service] REDIS_URL not provided. Redis features (deduplication) disabled. Using dummy client.");
    redisClient = { // Dummy client implementation
        get: async () => null, set: async () => null, del: async () => 0,
        quit: async () => {}, isOpen: false, isReady: false,
        on: () => {}, connect: async () => { isRedisReady = false; }
    };
    isRedisReady = false;
}

/**
 * Checks if an event ID has been seen recently using Redis SET NX.
 * @param {string} eventId - The unique ID of the event.
 * @returns {Promise<boolean>} True if the event is a duplicate, false otherwise or on error/disabled.
 */
export async function isDuplicateRedis(eventId) {
    if (!isRedisReady || !redisClient || !eventId) {
        if (!redisClient && redisUrl) console.warn("[Redis Dedupe] Redis client not ready or unavailable.");
        return false; // Assume not duplicate if Redis isn't functional
    }
    const key = `${DUPLICATE_EVENT_REDIS_PREFIX}${eventId}`;
    try {
        const result = await redisClient.set(key, '1', { NX: true, EX: DUPLICATE_EVENT_TTL });
        const isDuplicate = (result === null); // SET NX returns null if key already exists
        if (isDuplicate) { console.log(`[Redis Dedupe] Duplicate event: ${eventId}`); }
        return isDuplicate;
    } catch (error) {
        console.error(`[Redis Dedupe] Error for key ${key}:`, error);
        return false; // Fail open (assume not duplicate) on Redis error
    }
}

console.log(`[Redis Service] Initialized. Redis Ready: ${isRedisReady}`);
