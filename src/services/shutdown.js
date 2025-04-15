
// src/services/shutdown.js
// Handles graceful shutdown of initialized service clients.

import { redisClient } from './redisService.js';
import { dbPool } from './dbService.js';
// Import other clients if they need explicit shutdown (e.g., some WebSocket clients)

/**
 * Gracefully shuts down connected services like Redis and Database pools.
 * @param {string} signal - The signal received (e.g., 'SIGTERM', 'SIGINT').
 */
export async function shutdownServices(signal) {
    console.log(`[Shutdown] ${signal} signal received: closing service connections.`);

    const shutdownPromises = [];

    // Shutdown Redis
    if (redisClient && redisClient.isOpen) { // Check if client exists and is connected
        console.log('[Shutdown] Quitting Redis client...');
        shutdownPromises.push(
            redisClient.quit()
                .then(() => console.log('[Shutdown] Redis connection closed gracefully.'))
                .catch(err => console.error('[Shutdown] Error closing Redis connection:', err))
        );
    } else {
        console.log('[Shutdown] Redis client not connected or not initialized, skipping quit.');
    }

    // Shutdown Database Pool
    // Check if pool exists and has an end method (dummy pool doesn't)
    if (dbPool && typeof dbPool.end === 'function') {
        console.log('[Shutdown] Closing database pool...');
        shutdownPromises.push(
            dbPool.end()
                .then(() => console.log('[Shutdown] Database pool closed gracefully.'))
                .catch(err => console.error('[Shutdown] Error closing Database pool:', err))
        );
    } else {
         console.log('[Shutdown] Database pool not initialized or is dummy, skipping end.');
    }

    // Add shutdown logic for other services here if needed

    // Wait for all shutdown operations to complete (or timeout)
    console.log(`[Shutdown] Waiting for ${shutdownPromises.length} service(s) to close...`);
    try {
        await Promise.all(shutdownPromises);
        console.log('[Shutdown] All services shut down successfully.');
    } catch (error) {
        // This catch might not be strictly necessary if individual catches handle errors,
        // but it's a safety net.
        console.error('[Shutdown] Error during aggregate service shutdown:', error);
    }
}

console.log("[Shutdown Service] Initialized.");
