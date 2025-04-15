
import axios from 'axios';
import {
    anythingLLMBaseUrl,
    anythingLLMApiKey,
    WORKSPACE_LIST_CACHE_KEY,
    WORKSPACE_LIST_CACHE_TTL,
    redisUrl,
    // Import config needed for determineInitialWorkspace
    enableUserWorkspaces,
    userWorkspaceMapping,
    workspaceMapping,
    fallbackWorkspace
} from '../config.js';
// Import from other services ONLY if absolutely necessary, prefer passing data
import { redisClient, isRedisReady } from './redisService.js'; // OK for caching
import { getAnythingLLMThreadMapping as dbGetMapping, storeAnythingLLMThreadMapping as dbStoreMapping } from './dbService.js'; // Import DB functions

// Cache for available workspace slugs
let availableWorkspacesCache = null;
let cacheTimestamp = 0;

/**
 * =============================================================================
 *                      WORKSPACE MANAGEMENT & CACHING
 * =============================================================================
 */

/**
 * Fetches the list of available workspace slugs from AnythingLLM API.
 * Implements in-memory and Redis caching.
 * @returns {Promise<string[]>} An array of available workspace slugs.
 */
export async function getWorkspaces() {
    const now = Date.now();

    // 1. Check in-memory cache
    if (availableWorkspacesCache && (now - cacheTimestamp < WORKSPACE_LIST_CACHE_TTL * 1000)) {
        // console.log(`[LLM Service/getWorkspaces] In-memory cache HIT.`); // Too verbose
        return availableWorkspacesCache;
    }

    // 2. Check Redis cache
    if (isRedisReady && redisClient) {
        try {
            const cachedData = await redisClient.get(WORKSPACE_LIST_CACHE_KEY);
            if (cachedData) {
                const slugs = JSON.parse(cachedData);
                console.log(`[LLM Service/getWorkspaces] Redis cache HIT (${slugs.length} slugs).`);
                availableWorkspacesCache = slugs; cacheTimestamp = now; // Update memory cache
                return slugs;
            }
             console.log(`[LLM Service/getWorkspaces] Redis cache MISS.`);
        } catch (err) { console.error(`[Redis Error] Get workspace cache failed:`, err); }
    }

    // 3. Fetch from API
    if (!anythingLLMBaseUrl || !anythingLLMApiKey) { console.error("[LLM Service/getWorkspaces] LLM not configured."); return []; }

    console.log(`[LLM Service/getWorkspaces] Fetching workspaces from API...`);
    try {
        const response = await axios.get(`${anythingLLMBaseUrl}/api/v1/workspaces`, {
            headers: { 'Accept': 'application/json', Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 10000,
        });
        if (response.data?.workspaces && Array.isArray(response.data.workspaces)) {
            const slugs = response.data.workspaces.map(ws => ws.slug).filter(slug => typeof slug === 'string' && slug.trim());
            console.log(`[LLM Service/getWorkspaces] API returned ${slugs.length} slugs.`);
            availableWorkspacesCache = slugs; cacheTimestamp = now; // Update memory cache
            // Update Redis cache async
            if (isRedisReady && redisClient && slugs.length > 0) {
                redisClient.set(WORKSPACE_LIST_CACHE_KEY, JSON.stringify(slugs), { EX: WORKSPACE_LIST_CACHE_TTL })
                    .then(() => console.log(`[LLM Service/getWorkspaces] Updated Redis cache.`))
                    .catch(cacheErr => console.error(`[Redis Error] Set workspace cache failed:`, cacheErr));
            }
            return slugs;
        } else { console.error('[LLM Service/getWorkspaces] Invalid API response structure:', response.data); }
    } catch (error) { console.error('[LLM Service/getWorkspaces] API fetch failed:', error.response?.data || error.message); }

    console.warn("[LLM Service/getWorkspaces] Failed to get slugs from API/cache. Returning empty list.");
    return [];
}

/**
 * Determines the initial AnythingLLM workspace slug for a new thread based on config priority.
 * Priority: User Mapping > Channel Mapping > Fallback Workspace
 * @param {string} userId - Slack User ID
 * @param {string} channelId - Slack Channel ID
 * @returns {string | null} The determined workspace slug or null if none found/configured.
 */
export function determineInitialWorkspace(userId, channelId) {
    let targetWorkspace = null;
    // 1. User Mapping
    if (enableUserWorkspaces && userWorkspaceMapping && typeof userWorkspaceMapping === 'object') {
        const userMapped = userWorkspaceMapping[userId];
        if (typeof userMapped === 'string' && userMapped.trim()) { targetWorkspace = userMapped.trim(); console.log(`[Workspace Logic] User map ${userId}: ${targetWorkspace}`); }
        else if (userMapped) { console.warn(`[Workspace Logic] Invalid user map value for ${userId}: "${userMapped}".`); }
    }
    // 2. Channel Mapping
    if (!targetWorkspace && workspaceMapping && typeof workspaceMapping === 'object') {
        const channelMapped = workspaceMapping[channelId];
         if (typeof channelMapped === 'string' && channelMapped.trim()) { targetWorkspace = channelMapped.trim(); console.log(`[Workspace Logic] Channel map ${channelId}: ${targetWorkspace}`); }
         else if (channelMapped){ console.warn(`[Workspace Logic] Invalid channel map value for ${channelId}: "${channelMapped}".`); }
    }
    // 3. Fallback Workspace
    if (!targetWorkspace) {
        if (typeof fallbackWorkspace === 'string' && fallbackWorkspace.trim()) { targetWorkspace = fallbackWorkspace.trim(); console.log(`[Workspace Logic] Using fallback: ${targetWorkspace}`); }
        else { console.warn(`[Workspace Logic] No user/channel map & no valid fallback.`); }
    }
    console.log(`[Workspace Logic] Determined initial workspace: ${targetWorkspace}`);
    return targetWorkspace;
}

/**
 * =============================================================================
 *                          ANYTHINGLLM THREAD MANAGEMENT
 * =============================================================================
 */

/**
 * Creates a new thread in a specific AnythingLLM workspace via API.
 * @param {string} workspaceSlug - The target workspace slug.
 * @returns {Promise<string | null>} The new thread slug, or null on error.
 */
export async function createNewAnythingLLMThread(workspaceSlug) {
    if (!workspaceSlug) { console.error("[LLM Service/createThread] Workspace slug required."); return null; }
    if (!anythingLLMBaseUrl || !anythingLLMApiKey) { console.error("[LLM Service/createThread] LLM not configured."); return null; }

    console.log(`[LLM Service/createThread] Creating thread in workspace: ${workspaceSlug}...`);
    try {
        const response = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${workspaceSlug}/thread/new`, {}, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}`, 'Accept': 'application/json' }, timeout: 15000
        });
        if (response.data?.thread?.slug) {
            console.log(`[LLM Service/createThread] Created thread slug: ${response.data.thread.slug}`);
            return response.data.thread.slug;
        } else { console.error('[LLM Service/createThread] Unexpected response structure:', response.data); return null; }
    } catch (error) { console.error(`[LLM Error - Create Thread - Sphere: ${workspaceSlug}]`, error.response?.data || error.message); return null; }
}

/**
 * Retrieves the AnythingLLM thread mapping for a given Slack thread from the database.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} slackThreadTs - The starting timestamp of the Slack thread.
 * @returns {Promise<{anythingllm_thread_slug: string, anythingllm_workspace_slug: string} | null>} Mapping object or null.
 */
export async function getAnythingLLMThreadMapping(channelId, slackThreadTs) {
    // Wrapper around the dbService function for potential future logic here
    return dbGetMapping(channelId, slackThreadTs);
}

/**
 * Stores a new mapping between a Slack thread and an AnythingLLM thread in the database.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} slackThreadTs - The starting timestamp of the Slack thread.
 * @param {string} workspaceSlug - The AnythingLLM workspace slug.
 * @param {string} anythingLLMThreadSlug - The AnythingLLM thread slug.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
export async function storeAnythingLLMThreadMapping(channelId, slackThreadTs, workspaceSlug, anythingLLMThreadSlug) {
     // Wrapper around the dbService function
    return dbStoreMapping(channelId, slackThreadTs, workspaceSlug, anythingLLMThreadSlug);
}


/**
 * =============================================================================
 *                          MAIN LLM QUERY FUNCTION
 * =============================================================================
 */

/**
 * Queries the AnythingLLM API (workspace chat or thread chat).
 * @param {string} workspaceSlug - Workspace slug (required).
 * @param {string | null} threadSlug - Thread slug (optional).
 * @param {string} inputText - The user query/prompt (required).
 * @param {string} [mode='chat'] - LLM mode ('chat' or 'query').
 * @param {Array} [attachments=[]] - Attachments (future use).
 * @returns {Promise<string>} The text response from the LLM. Returns empty string "" if no textResponse found.
 * @throws {Error} If required parameters missing or API call fails critically.
 */
export async function queryLlm(workspaceSlug, threadSlug, inputText, mode = 'chat', attachments = []) {
    console.log(`[LLM Service/queryLlm] Query: Ws=${workspaceSlug}, Thr=${threadSlug || 'None'}, Mode=${mode}`);

    if (!anythingLLMBaseUrl || !anythingLLMApiKey) throw new Error('LLM Service not configured.');
    if (!workspaceSlug) throw new Error('Workspace slug required for LLM query.');
    if (!inputText?.trim()) throw new Error('Input text required for LLM query.');

    const endpointUrl = threadSlug
        ? `${anythingLLMBaseUrl}/api/v1/workspace/${workspaceSlug}/thread/${threadSlug}/chat`
        : `${anythingLLMBaseUrl}/api/v1/workspace/${workspaceSlug}/chat`;
    // console.log(`[LLM Service/queryLlm] Endpoint: ${endpointUrl}`);

    const requestBody = { message: inputText, mode: mode };

    try {
        const llmResponse = await axios.post(endpointUrl, requestBody, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}`, 'Content-Type': 'application/json' },
            timeout: 90000, // 90s
        });

        if (llmResponse.data?.textResponse === undefined || llmResponse.data?.textResponse === null) {
            console.warn('[LLM Service/queryLlm] LLM response missing textResponse field.', llmResponse.data);
            return ""; // Return empty string for missing response
        }
        return llmResponse.data.textResponse;

    } catch (error) { /* ... Same detailed error handling ... */
        let eDetails = error.message; if (error.response) { console.error(`[LLM Error Data ${error.response.status}]:`, error.response.data); eDetails = `Status ${error.response.status}: ${JSON.stringify(error.response.data)}`; } else if (error.request) { console.error('[LLM Error Req]: No response'); eDetails = 'No response from LLM server.'; } else { console.error('[LLM Error Msg]:', error.message); } console.error('[LLM Error Cfg]:', error.config);
        const eMsg = `LLM query failed Ws=${workspaceSlug} Thr=${threadSlug}: ${eDetails}`; console.error(`[LLM Error Full Context]`, eMsg); throw new Error(eMsg);
    }
}

console.log(`[LLM Service] Initialized.`);
