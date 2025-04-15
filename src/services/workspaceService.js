// src/services/workspaceService.js
// Handles retrieval and determination of AnythingLLM workspaces.

import axios from 'axios';
import {
    anythingLLMBaseUrl,
    anythingLLMApiKey,
    WORKSPACE_LIST_CACHE_KEY,
    WORKSPACE_LIST_CACHE_TTL,
    redisUrl, // Needed for checking if Redis is configured
    enableUserWorkspaces,
    userWorkspaceMapping,
    workspaceMapping,
    fallbackWorkspace
} from '../config.js';
import { redisClient, isRedisReady } from './redisService.js'; // Needed for cache operations

// In-memory cache for available workspace slugs
let availableWorkspacesCache = null;
let cacheTimestamp = 0;

/**
 * =============================================================================
 * WORKSPACE MANAGEMENT & CACHING
 * =============================================================================
 */

/**
 * Fetches the list of available workspace slugs from AnythingLLM API.
 * Implements in-memory and Redis caching.
 * @param {boolean} [useCache=true] - Whether to use cache or force refresh.
 * @returns {Promise<string[]>} An array of available workspace slugs.
 */
export async function getWorkspaces(useCache = true) {
    const now = Date.now();

    // 1. Check in-memory cache
    if (useCache && availableWorkspacesCache && (now - cacheTimestamp < WORKSPACE_LIST_CACHE_TTL * 1000)) {
        // console.log(`[Workspace Service/getWorkspaces] In-memory cache HIT.`);
        return availableWorkspacesCache;
    }

    // 2. Check Redis cache
    if (useCache && isRedisReady && redisClient) { // Check if redisClient is ready
        try {
            const cachedData = await redisClient.get(WORKSPACE_LIST_CACHE_KEY);
            if (cachedData) {
                const slugs = JSON.parse(cachedData);
                console.log(`[Workspace Service/getWorkspaces] Redis cache HIT (${slugs.length} slugs).`);
                availableWorkspacesCache = slugs; cacheTimestamp = now; // Update memory cache
                return slugs;
            }
             console.log(`[Workspace Service/getWorkspaces] Redis cache MISS.`);
        } catch (err) { console.error(`[Redis Error] Get workspace cache failed:`, err); }
    }

    // 3. Fetch from API
    if (!anythingLLMBaseUrl || !anythingLLMApiKey) {
        console.error("[Workspace Service/getWorkspaces] LLM API URL or Key not configured.");
        return []; // Cannot fetch without config
    }

    console.log(`[Workspace Service/getWorkspaces] Fetching workspaces from API: ${anythingLLMBaseUrl}/api/v1/workspaces`);
    try {
        const response = await axios.get(`${anythingLLMBaseUrl}/api/v1/workspaces`, {
            headers: { 'Accept': 'application/json', Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 10000, // 10 second timeout
        });

        // Validate response structure
        if (response.data?.workspaces && Array.isArray(response.data.workspaces)) {
            const slugs = response.data.workspaces
                .map(ws => ws.slug)
                .filter(slug => typeof slug === 'string' && slug.trim()); // Ensure slugs are valid strings

            console.log(`[Workspace Service/getWorkspaces] API returned ${slugs.length} slugs.`);
            availableWorkspacesCache = slugs; cacheTimestamp = now; // Update memory cache

            // Update Redis cache async (only if redis is ready and slugs exist)
            if (isRedisReady && redisClient && slugs.length > 0) {
                redisClient.set(WORKSPACE_LIST_CACHE_KEY, JSON.stringify(slugs), { EX: WORKSPACE_LIST_CACHE_TTL })
                    .then(() => console.log(`[Workspace Service/getWorkspaces] Updated Redis cache.`))
                    .catch(cacheErr => console.error(`[Redis Error] Set workspace cache failed:`, cacheErr));
            }
            return slugs;
        } else {
            console.error('[Workspace Service/getWorkspaces] Invalid API response structure received:', response.data);
            return []; // Return empty on invalid structure
        }
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.response?.statusText || error.message;
        console.error(`[Workspace Service/getWorkspaces] API fetch failed: ${errorMsg}`);
        return []; // Return empty on API error
    }
}


/**
 * Determines the final workspace slug based on suggested workspace, user/channel mappings, and fallback.
 * Priority: Suggested (if valid) > User Mapping > Channel Mapping > Fallback
 * @param {object} params - Parameters object.
 * @param {string | null} params.suggestedWorkspace - Workspace suggested by intent detection or other means.
 * @param {string} params.userId - Slack User ID.
 * @param {string} params.channelId - Slack Channel ID.
 * @param {boolean} [useCache=true] - Passed to getWorkspaces.
 * @returns {Promise<string | null>} The determined workspace slug or null if none could be determined.
 */
export async function determineWorkspace({ suggestedWorkspace, userId, channelId, useCache = true }) {
    console.log(`[Workspace Service/determine] Starting determination for User=${userId}, Chan=${channelId}, Suggested=${suggestedWorkspace || 'None'}`);
    let targetWorkspace = null;
    const available = await getWorkspaces(useCache); // Get currently available workspaces
    const availableSet = new Set(available); // Use Set for efficient O(1) lookup

    // If no workspaces are available at all, we cannot determine one.
    if (available.length === 0) {
        console.error("[Workspace Service/determine] No available workspaces found from API or cache. Cannot determine workspace.");
        return null;
    }

    // --- Step 1: Check Suggested Workspace ---
    if (suggestedWorkspace && typeof suggestedWorkspace === 'string') {
        const trimmedSuggestion = suggestedWorkspace.trim();
        if (trimmedSuggestion && availableSet.has(trimmedSuggestion)) {
            console.log(`[Workspace Service/determine] Using valid suggested workspace: ${trimmedSuggestion}`);
            return trimmedSuggestion; // Return early if suggested is valid and available
        } else if (trimmedSuggestion) {
            // Log if suggestion was provided but invalid/unavailable
            console.warn(`[Workspace Service/determine] Suggested workspace '${trimmedSuggestion}' is not in the available list: [${available.join(', ')}]. Ignoring suggestion.`);
        }
    }

    // --- Step 2: Check User Mapping (if suggested wasn't valid/provided) ---
    if (enableUserWorkspaces && userWorkspaceMapping && typeof userWorkspaceMapping === 'object' && userId) {
        const userMapped = userWorkspaceMapping[userId];
        if (typeof userMapped === 'string') {
            const trimmedUserMap = userMapped.trim();
            if (trimmedUserMap && availableSet.has(trimmedUserMap)) {
                targetWorkspace = trimmedUserMap;
                console.log(`[Workspace Service/determine] User map ${userId} found valid workspace: ${targetWorkspace}`);
            } else if (trimmedUserMap) {
                // Log if user map points to an invalid/unavailable workspace
                console.warn(`[Workspace Service/determine] User map ${userId} points to invalid/unavailable workspace '${trimmedUserMap}' (Available: [${available.join(',')}]). Ignoring.`);
            }
        } else if (userMapped !== undefined && userMapped !== null) {
             // Log if the mapping value itself is not a string
             console.warn(`[Workspace Service/determine] Invalid user map value type for ${userId}: "${userMapped}" (Expected string).`);
        }
    }

    // --- Step 3: Check Channel Mapping (if no valid suggested or user map found) ---
    if (!targetWorkspace && workspaceMapping && typeof workspaceMapping === 'object' && channelId) {
        const channelMapped = workspaceMapping[channelId];
         if (typeof channelMapped === 'string') {
             const trimmedChannelMap = channelMapped.trim();
             if (trimmedChannelMap && availableSet.has(trimmedChannelMap)) {
                 targetWorkspace = trimmedChannelMap;
                 console.log(`[Workspace Service/determine] Channel map ${channelId} found valid workspace: ${targetWorkspace}`);
             } else if (trimmedChannelMap) {
                  // Log if channel map points to an invalid/unavailable workspace
                 console.warn(`[Workspace Service/determine] Channel map ${channelId} points to invalid/unavailable workspace '${trimmedChannelMap}' (Available: [${available.join(',')}]). Ignoring.`);
             }
         } else if (channelMapped !== undefined && channelMapped !== null) {
             // Log if the mapping value itself is not a string
             console.warn(`[Workspace Service/determine] Invalid channel map value type for ${channelId}: "${channelMapped}" (Expected string).`);
         }
    }

    // --- Step 4: Use Fallback Workspace (if nothing else found) ---
    if (!targetWorkspace) {
        if (typeof fallbackWorkspace === 'string') {
            const trimmedFallback = fallbackWorkspace.trim();
             if (trimmedFallback && availableSet.has(trimmedFallback)) {
                 targetWorkspace = trimmedFallback;
                 console.log(`[Workspace Service/determine] Using valid fallback workspace: ${targetWorkspace}`);
             } else if (trimmedFallback) {
                 // This is a critical configuration error if fallback is set but invalid/unavailable
                 console.error(`[Workspace Service/determine] CRITICAL: Configured fallback workspace '${trimmedFallback}' is NOT in the available list! [${available.join(',')}]`);
                 targetWorkspace = null; // Indicate failure explicitly
             } else {
                 // Fallback workspace is configured but is an empty string
                 console.log(`[Workspace Service/determine] Fallback workspace is configured but empty. No fallback applied.`);
             }
        } else {
             // Fallback workspace is not configured or not a string
             console.log(`[Workspace Service/determine] No user/channel map found, and no valid fallback workspace configured.`);
        }
    }

    // --- Final Check and Return ---
    if (!targetWorkspace) {
        console.error(`[Workspace Service/determine] FAILED to determine a valid workspace for User=${userId}, Chan=${channelId}, Suggested=${suggestedWorkspace || 'None'}. Check mappings, fallback, and workspace availability.`);
    }

    console.log(`[Workspace Service/determine] Final determined workspace: ${targetWorkspace || 'None'}`);
    return targetWorkspace; // Returns the slug string or null
}

console.log(`[Workspace Service] Initialized.`);

