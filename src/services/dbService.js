import pg from 'pg';
import { databaseUrl } from '../config.js';

export let dbPool = null; // Initialize as null

if (databaseUrl) {
    console.log("[DB Service] Configuring Database Pool...");
    try {
        const pool = new pg.Pool({
            connectionString: databaseUrl,
            // Example pool options (adjust as needed)
             ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, // Basic SSL for production often needed
            max: 10, // Max number of clients in the pool
            idleTimeoutMillis: 30000, // Close idle clients after 30s
            connectionTimeoutMillis: 5000, // Timeout for acquiring connection
        });

        pool.on('error', (err, client) => {
            console.error('[DB Service] Unexpected idle DB client error:', err);
            // Consider logging client details if available for debugging
        });
        pool.on('connect', (client) => { /* console.log('[DB Service] DB client connected.'); */ }); // Too verbose
        pool.on('acquire', (client) => { /* console.log('[DB Service] DB client acquired.'); */ }); // Too verbose
        pool.on('remove', (client) => { /* console.log('[DB Service] DB client removed.'); */ }); // Too verbose

        // Test connection on startup
        pool.query('SELECT NOW()')
            .then(res => console.log('[DB Service] Database pool connection test successful:', res.rows[0].now))
            .catch(err => console.error('[DB Service] Database pool connection test FAILED:', err));

        dbPool = pool; // Assign after setup

    } catch(initError) {
         console.error("[DB Service] Failed to initialize DB pool:", initError);
         dbPool = null;
    }

} else {
    console.warn("[DB Service] DATABASE_URL not provided. Database features disabled. Using dummy pool.");
    dbPool = { // Dummy pool implementation
        query: async (...args) => { console.warn("[DB Dummy] pool.query called:", args); return { rows: [], rowCount: 0, command: 'SELECT', fields: [] }; },
        connect: async () => { console.warn("[DB Dummy] pool.connect called."); return { query: async (...args) => { console.warn("[DB Dummy] client.query called:", args); return { rows: [], rowCount: 0, command: 'SELECT', fields: [] }; }, release: () => {} }; },
        end: async () => { console.log("[DB Dummy] pool.end() called."); }
    };
}

// === Feedback Repository Logic ===

/**
 * Stores feedback data in the database.
 * @param {object} feedbackData - Object containing feedback details. Requires keys matching DB columns.
 * @returns {Promise<number | null>} The ID of the inserted feedback row, or null on failure/DB disabled.
 */
export async function storeFeedback(feedbackData) {
    if (!dbPool || !databaseUrl) {
        console.warn("[DB Service/Feedback] DB unavailable, logging feedback to console:", JSON.stringify(feedbackData));
        return null;
    }
    const query = `
        INSERT INTO feedback (feedback_value, user_id, channel_id, bot_message_ts, original_user_message_ts, action_id, sphere_slug, bot_message_text, original_user_message_text)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id;`;
    // Ensure all expected keys exist, defaulting to null if missing
    const values = [
        feedbackData.feedback_value ?? null, feedbackData.user_id ?? null, feedbackData.channel_id ?? null,
        feedbackData.bot_message_ts ?? null, feedbackData.original_user_message_ts ?? null,
        feedbackData.action_id ?? null, feedbackData.sphere_slug ?? null,
        feedbackData.bot_message_text ?? null, feedbackData.original_user_message_text ?? null
    ];

    try {
        console.log(`[DB Service/Feedback] Storing: User=${values[1]}, Val=${values[0]}, Sphere=${values[6]}`);
        const result = await dbPool.query(query, values);
        if (result.rows?.[0]?.id) {
             const insertedId = result.rows[0].id;
             console.log(`[DB Service/Feedback] Feedback saved with ID: ${insertedId}`);
             return insertedId;
        } else {
             console.warn('[DB Service/Feedback] Insert successful, but no ID returned.');
             return null;
        }
    } catch (err) {
        console.error('[DB Service/Feedback] DB Error storing feedback:', err.message, err.detail); // Log more detail
        return null;
    }
}


// === Thread Mapping Repository Logic ===

/**
 * Retrieves the AnythingLLM thread mapping for a given Slack thread from the database.
 * Updates the last_accessed_at timestamp on successful retrieval.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} slackThreadTs - The starting timestamp of the Slack thread.
 * @returns {Promise<{anythingllm_thread_slug: string, anythingllm_workspace_slug: string} | null>} Mapping object or null.
 */
export async function getAnythingLLMThreadMapping(channelId, slackThreadTs) {
    if (!dbPool || !databaseUrl) { console.warn("[DB Service/ThreadMap] DB unavailable."); return null; }
    if (!channelId || !slackThreadTs) { console.warn("[DB Service/ThreadMap] Missing channelId or slackThreadTs for get mapping."); return null; }

    const selectQuery = `SELECT anythingllm_thread_slug, anythingllm_workspace_slug FROM slack_anythingllm_threads WHERE slack_channel_id = $1 AND slack_thread_ts = $2;`;
    const updateAccessTimeQuery = `UPDATE slack_anythingllm_threads SET last_accessed_at = CURRENT_TIMESTAMP WHERE slack_channel_id = $1 AND slack_thread_ts = $2;`;

    let client = null;
    try {
        client = await dbPool.connect(); // Use a client for potential transactionality (though not strictly needed here)
        const result = await client.query(selectQuery, [channelId, slackThreadTs]);

        if (result.rows.length > 0) {
            const mapping = result.rows[0];
            console.log(`[DB Service/ThreadMap] Found mapping for ${channelId}:${slackThreadTs}`);
            // Update access time async (fire and forget)
            client.query(updateAccessTimeQuery, [channelId, slackThreadTs])
                .then(updateResult => { if (updateResult.rowCount === 0) console.warn(`[DB/ThreadMap] Update access time failed for existing map ${channelId}:${slackThreadTs}`); })
                .catch(err => console.error("[DB/ThreadMap] Bg update access time failed:", err));
            return mapping;
        } else {
            // console.log(`[DB Service/ThreadMap] No mapping found for Slack ${channelId}:${slackThreadTs}`); // Can be noisy
            return null;
        }
    } catch (err) {
        console.error("[DB Service/ThreadMap] DB Error getting mapping:", err.message);
        return null;
    } finally {
        if (client) client.release(); // Always release the client
    }
}

/**
 * Stores or updates a mapping between a Slack thread and an AnythingLLM thread in the database.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} slackThreadTs - The starting timestamp of the Slack thread.
 * @param {string} workspaceSlug - The AnythingLLM workspace slug.
 * @param {string} anythingLLMThreadSlug - The AnythingLLM thread slug.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
export async function storeAnythingLLMThreadMapping(channelId, slackThreadTs, workspaceSlug, anythingLLMThreadSlug) {
    if (!dbPool || !databaseUrl) { console.warn("[DB Service/ThreadMap] DB unavailable."); return false; }
     if (!channelId || !slackThreadTs || !workspaceSlug || !anythingLLMThreadSlug) {
         console.error("[DB Service/ThreadMap] Missing required parameters for store mapping.");
         return false;
     }

    // Use ON CONFLICT DO UPDATE for robustness
    const query = `
        INSERT INTO slack_anythingllm_threads
            (slack_channel_id, slack_thread_ts, anythingllm_workspace_slug, anythingllm_thread_slug, created_at, last_accessed_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (slack_channel_id, slack_thread_ts)
        DO UPDATE SET
            anythingllm_workspace_slug = EXCLUDED.anythingllm_workspace_slug,
            anythingllm_thread_slug = EXCLUDED.anythingllm_thread_slug,
            last_accessed_at = CURRENT_TIMESTAMP;
    `;
    try {
        const result = await dbPool.query(query, [channelId, slackThreadTs, workspaceSlug, anythingLLMThreadSlug]);
        console.log(`[DB Service/ThreadMap] Stored/Updated mapping for ${channelId}:${slackThreadTs}. Rows affected: ${result.rowCount}`);
        return result.rowCount > 0;
    } catch (err) {
        console.error("[DB Service/ThreadMap] DB Error storing mapping:", err.message, err.detail);
        return false;
    }
}

console.log(`[DB Service] Initialized. DB Pool ${dbPool ? 'Created' : 'Disabled'}`);
