
import { WebClient } from '@slack/web-api';
import { createEventAdapter } from '@slack/events-api';
import { botToken, signingSecret } from '../config.js';

// --- Slack Clients Initialization ---
export let slackClient = null;
export let slackEvents = null;

if (botToken && signingSecret) {
    try {
        // Initialize WebClient for API calls
        slackClient = new WebClient(botToken);
        console.log("[Slack Service] WebClient initialized.");

        // Initialize Events API Adapter for receiving events
        slackEvents = createEventAdapter(signingSecret, {
            includeBody: true, // Useful for event deduplication using event_id
            includeHeaders: true, // Useful for debugging signature verification
        });
        console.log("[Slack Service] Events Adapter initialized.");

        // Optional: Verify authentication on startup
        slackClient.auth.test()
            .then(result => {
                if (result.ok) {
                    console.log(`[Slack Service] Auth test successful: Bot ID ${result.bot_id}, User ID ${result.user_id}, Team ${result.team}`);
                } else {
                    console.error(`[Slack Service] Auth test failed: ${result.error}`);
                }
            })
            .catch(error => {
                 console.error("[Slack Service] Auth test API call failed:", error.message);
                 // Consider if this should prevent startup
            });

    } catch (error) {
        console.error("[Slack Service] Failed to initialize Slack clients:", error);
        slackClient = null;
        slackEvents = null;
    }
} else {
    console.error("[Slack Service] SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET missing. Slack functionality disabled.");
    // Create dummy clients to prevent null errors elsewhere, but functionality will be broken
    slackClient = {
        chat: { postMessage: async (...args) => { console.error("Slack dummy chat.postMessage:", args); return { ok: false, error: 'client_not_initialized' }; }, update: async (...args) => { console.error("Slack dummy chat.update:", args); return { ok: false, error: 'client_not_initialized' }; }, delete: async (...args) => { console.error("Slack dummy chat.delete:", args); return { ok: false, error: 'client_not_initialized' }; } },
        conversations: { history: async (...args) => { console.error("Slack dummy conv.history:", args); return { ok: false, error: 'client_not_initialized', messages: [] }; }, replies: async (...args) => { console.error("Slack dummy conv.replies:", args); return { ok: false, error: 'client_not_initialized', messages: [] }; }, info: async (...args) => { console.error("Slack dummy conv.info:", args); return { ok: false, error: 'client_not_initialized' }; } },
        users: { info: async (...args) => { console.error("Slack dummy users.info:", args); return { ok: false, error: 'client_not_initialized' }; } },
        auth: { test: async () => { console.error("Slack dummy auth.test called"); return { ok: false, error: 'client_not_initialized' }; } },
        views: { open: async (...args) => { console.error("Slack dummy views.open:", args); return { ok: false, error: 'client_not_initialized' }; } } // Add other methods as needed
    };
    slackEvents = { // Dummy event adapter
        requestListener: () => (req, res) => { console.error("Slack dummy event listener called"); res.status(503).send("Slack Service Unavailable"); },
        on: (eventName, listener) => { console.warn(`Slack dummy event adapter ignoring listener for '${eventName}'`); }
    };
}

// --- Slack API Helper Functions ---

/**
 * Posts a message to Slack, handling potential errors.
 * @param {string} channelId - Channel ID or User ID (for DM).
 * @param {string} text - Fallback text content for notifications.
 * @param {Array} [blocks] - Optional Slack Blocks array for rich formatting.
 * @param {string} [threadTs] - Optional thread timestamp to reply within a thread.
 * @returns {Promise<object|null>} The Slack API response object (incl. ts) or null on failure.
 */
export async function postSlackMessage(channelId, text, blocks = null, threadTs = null) {
    if (!slackClient || typeof slackClient.chat?.postMessage !== 'function') {
        console.error("[Slack Service/Post] Slack client invalid or postMessage unavailable.");
        return null;
    }
    if (!channelId || !text) {
        console.error("[Slack Service/Post] Missing channelId or text for postSlackMessage.");
        return null;
    }

    try {
        const args = { channel: channelId, text: text };
        if (blocks && Array.isArray(blocks)) args.blocks = blocks;
        if (threadTs) args.thread_ts = threadTs;

        const result = await slackClient.chat.postMessage(args);

        if (result.ok) {
            // console.log(`[Slack Service/Post] Message posted to ${channelId}${threadTs ? ` (in thread ${threadTs})` : ''} (ts: ${result.ts})`);
            return result; // Contains { ok: true, ts: '...', message: { ... } }
        } else {
            console.error(`[Slack Service/Post] Error posting to ${channelId}: ${result.error}`);
            return null;
        }
    } catch (error) {
        console.error(`[Slack Service/Post] API/Network error posting to ${channelId}:`, error.data?.error || error.message);
        return null;
    }
}

/**
 * Updates an existing Slack message.
 * @param {string} channelId - Channel where the message exists.
 * @param {string} ts - Timestamp of the message to update.
 * @param {string} text - New fallback text content.
 * @param {Array} [blocks] - Optional: New Slack blocks array. If omitted, blocks are removed.
 * @returns {Promise<object|null>} The Slack API response object or null on failure.
 */
export async function updateSlackMessage(channelId, ts, text, blocks = null) {
     if (!slackClient || typeof slackClient.chat?.update !== 'function') {
        console.error("[Slack Service/Update] Slack client invalid or update unavailable.");
        return null;
    }
     if (!channelId || !ts || !text) {
        console.error("[Slack Service/Update] Missing channelId, ts, or text for updateSlackMessage.");
        return null;
    }

     try {
        const args = { channel: channelId, ts: ts, text: text };
        // Pass blocks only if it's a non-empty array, otherwise Slack might keep old blocks
        if (blocks && Array.isArray(blocks)) {
            args.blocks = blocks;
        } else {
            // Explicitly clear blocks if not provided or empty
            args.blocks = [];
        }

        const result = await slackClient.chat.update(args);

        if (result.ok) {
            // console.log(`[Slack Service/Update] Message ${ts} updated in ${channelId}.`);
            return result; // Contains { ok: true, ts: '...', ... }
        } else {
            console.error(`[Slack Service/Update] Error updating ${ts} in ${channelId}: ${result.error}`);
            return null;
        }
     } catch (error) {
         console.error(`[Slack Service/Update] API/Network error updating ${ts} in ${channelId}:`, error.data?.error || error.message);
         return null;
     }
}

/**
 * Deletes a Slack message.
 * @param {string} channelId - Channel where the message exists.
 * @param {string} ts - Timestamp of the message to delete.
 * @returns {Promise<object|null>} The Slack API response object or null on failure.
 */
export async function deleteSlackMessage(channelId, ts) {
    if (!slackClient || typeof slackClient.chat?.delete !== 'function') {
        console.error("[Slack Service/Delete] Slack client invalid or delete unavailable.");
        return null;
    }
     if (!channelId || !ts) {
        console.error("[Slack Service/Delete] Missing channelId or ts for deleteSlackMessage.");
        return null;
    }

    try {
        const result = await slackClient.chat.delete({ channel: channelId, ts: ts });
        if (result.ok) {
            // console.log(`[Slack Service/Delete] Message ${ts} deleted from ${channelId}.`);
            return result; // Contains { ok: true, ts: '...' }
        } else {
            console.error(`[Slack Service/Delete] Error deleting ${ts} from ${channelId}: ${result.error}`);
            return null;
        }
    } catch (error) {
        console.error(`[Slack Service/Delete] API/Network error deleting ${ts} from ${channelId}:`, error.data?.error || error.message);
        return null;
    }
}

/**
 * Fetches conversation history (channel or thread replies).
 * @param {string} channelId - The channel ID.
 * @param {string} [threadTs] - Optional thread timestamp to fetch replies instead of channel history.
 * @param {string} [latest] - Optional 'latest' timestamp boundary for channel history.
 * @param {number} [limit=20] - Max messages to return per page (API default is 100, max 1000).
 * @param {boolean} [fetchAll=false] - If true, attempts to fetch all pages (use with caution!).
 * @returns {Promise<Array|null>} Array of message objects or null on failure.
 */
export async function fetchSlackHistory(channelId, threadTs = null, latest = null, limit = 100, fetchAll = false) {
    if (!slackClient) { console.error("[Slack Service/History] Slack client not initialized."); return null; }
    if (!channelId) { console.error("[Slack Service/History] Missing channelId."); return null; }

    const messages = [];
    let cursor = undefined;
    let hasMore = true;
    let method = threadTs ? 'conversations.replies' : 'conversations.history';
    let args = threadTs
        ? { channel: channelId, ts: threadTs, limit: Math.min(limit, 1000) } // replies limit max 1000
        : { channel: channelId, latest: latest, limit: Math.min(limit, 1000), inclusive: false }; // history limit max 1000

    console.log(`[Slack Service/History] Fetching ${method} for ${channelId}${threadTs ? '/'+threadTs : ''}`);

    try {
        while (hasMore) {
            if (cursor) args.cursor = cursor;

            const result = threadTs
                ? await slackClient.conversations.replies(args)
                : await slackClient.conversations.history(args);

            if (result.ok && result.messages) {
                messages.push(...result.messages);
                // Check for pagination
                if (fetchAll && result.response_metadata?.next_cursor) {
                    cursor = result.response_metadata.next_cursor;
                    hasMore = true;
                     console.log(`[Slack Service/History] Fetched page, next cursor: ${cursor}`);
                     await new Promise(resolve => setTimeout(resolve, 1100)); // Slack Tier 2 rate limit (50+/min) -> ~1.1s delay
                } else {
                    hasMore = false; // No more pages or fetchAll is false
                }
            } else {
                console.error(`[Slack Service/History] API Error fetching history: ${result.error || 'Unknown error'}`);
                return null; // Return null on API error
            }
            // Safety break if fetchAll is true but something goes wrong
            if (fetchAll && !hasMore) break;
             if (!fetchAll) break; // Exit loop if not fetching all pages
        }

        console.log(`[Slack Service/History] Fetched total ${messages.length} messages.`);
        return messages;

    } catch (error) {
        console.error(`[Slack Service/History] Network/API error fetching history:`, error.data?.error || error.message);
        return null;
    }
}


console.log(`[Slack Service] Initialized. Client: ${slackClient ? 'OK' : 'FAIL'}, Events: ${slackEvents ? 'OK' : 'FAIL'}`);
