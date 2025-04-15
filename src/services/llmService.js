// src/services/llmService.js
// Handles interactions with the AnythingLLM API for querying and thread management.

import axios from 'axios';
import {
    anythingLLMBaseUrl,
    anythingLLMApiKey
} from '../config.js';
// Import DB functions directly used for thread mapping
import { getAnythingLLMThreadMapping as dbGetMapping, storeAnythingLLMThreadMapping as dbStoreMapping } from './dbService.js';

/**
 * =============================================================================
 * ANYTHINGLLM THREAD MANAGEMENT
 * =============================================================================
 */

/**
 * Creates a new thread in a specific AnythingLLM workspace via API.
 * @param {string} workspaceSlug - The target workspace slug.
 * @returns {Promise<string | null>} The new thread slug, or null on error.
 */
export async function createNewAnythingLLMThread(workspaceSlug) {
    if (!workspaceSlug) {
        console.error("[LLM Service/createThread] Workspace slug required.");
        return null;
    }
    if (!anythingLLMBaseUrl || !anythingLLMApiKey) {
        console.error("[LLM Service/createThread] LLM API URL or Key not configured.");
        return null;
    }

    console.log(`[LLM Service/createThread] Creating thread in workspace: ${workspaceSlug}...`);
    const url = `${anythingLLMBaseUrl}/api/v1/workspace/${workspaceSlug}/thread/new`;
    try {
        const response = await axios.post(url, {}, { // Empty body for new thread endpoint
            headers: {
                Authorization: `Bearer ${anythingLLMApiKey}`,
                'Accept': 'application/json'
            },
            timeout: 15000 // 15 second timeout
        });

        // Validate successful response and presence of thread slug
        if (response.status === 200 && response.data?.thread?.slug) {
            console.log(`[LLM Service/createThread] Created thread slug: ${response.data.thread.slug}`);
            return response.data.thread.slug;
        } else {
            console.error('[LLM Service/createThread] Unexpected successful response structure or missing slug:', response.data);
            return null;
        }
    } catch (error) {
         // Log detailed error information
         const status = error.response?.status;
         const errorMsg = error.response?.data?.message || error.response?.data || error.message;
         console.error(`[LLM Error - Create Thread - Workspace: ${workspaceSlug}] Status: ${status || 'N/A'}, Message: ${errorMsg}`);
         return null; // Return null on any error during thread creation
     }
}

/**
 * Retrieves the AnythingLLM thread mapping for a given Slack thread from the database.
 * Wrapper around the dbService function.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} slackThreadTs - The starting timestamp of the Slack thread.
 * @returns {Promise<{anythingllm_thread_slug: string, anythingllm_workspace_slug: string} | null>} Mapping object or null.
 */
export async function getAnythingLLMThreadMapping(channelId, slackThreadTs) {
    // Delegates directly to the database service function.
    // Add any pre/post processing or error handling specific to this service if needed in future.
    return dbGetMapping(channelId, slackThreadTs);
}

/**
 * Stores or updates a mapping between a Slack thread and an AnythingLLM thread in the database.
 * Wrapper around the dbService function.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} slackThreadTs - The starting timestamp of the Slack thread.
 * @param {string} workspaceSlug - The AnythingLLM workspace slug.
 * @param {string} anythingLLMThreadSlug - The AnythingLLM thread slug.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
export async function storeAnythingLLMThreadMapping(channelId, slackThreadTs, workspaceSlug, anythingLLMThreadSlug) {
    // Delegates directly to the database service function.
    // Add any pre/post processing or error handling specific to this service if needed in future.
    return dbStoreMapping(channelId, slackThreadTs, workspaceSlug, anythingLLMThreadSlug);
}


/**
 * =============================================================================
 * MAIN LLM QUERY FUNCTION
 * =============================================================================
 */

/**
 * Queries the AnythingLLM API (workspace chat or thread chat).
 * @param {string} workspaceSlug - Workspace slug (required).
 * @param {string | null} threadSlug - Thread slug (optional). If provided, chat happens in thread.
 * @param {string} inputText - The user query/prompt (required).
 * @param {string} [mode='chat'] - LLM mode ('chat' or 'query').
 * @param {Array} [attachments=[]] - Attachments (currently unused, placeholder for future).
 * @returns {Promise<string>} The text response from the LLM. Returns empty string "" if no textResponse found or on error.
 */
export async function queryLlm(workspaceSlug, threadSlug, inputText, mode = 'chat', attachments = []) {
    console.log(`[LLM Service/queryLlm] Query: Ws=${workspaceSlug}, Thr=${threadSlug || 'None'}, Mode=${mode}`);

    // --- Input Validation ---
    if (!anythingLLMBaseUrl || !anythingLLMApiKey) {
        console.error('[LLM Service/queryLlm] LLM Service API URL or Key not configured.');
        return ""; // Return empty string if essential config is missing
    }
    if (!workspaceSlug) {
         console.error('[LLM Service/queryLlm] Workspace slug is required for LLM query.');
         return "";
    }
    if (!inputText || typeof inputText !== 'string' || !inputText.trim()) {
         console.warn('[LLM Service/queryLlm] Input text is empty or invalid.');
         return ""; // Return empty string for empty/invalid input
    }

    // --- Determine Endpoint ---
    const endpointUrl = threadSlug
        ? `${anythingLLMBaseUrl}/api/v1/workspace/${workspaceSlug}/thread/${threadSlug}/chat`
        : `${anythingLLMBaseUrl}/api/v1/workspace/${workspaceSlug}/chat`;

    // --- Prepare Request ---
    const requestBody = { message: inputText, mode: mode };
    // Future: Handle attachments if/when API supports them
    // if (attachments && attachments.length > 0) { requestBody.attachments = attachments; }

    // --- API Call ---
    try {
        const llmResponse = await axios.post(endpointUrl, requestBody, {
            headers: {
                Authorization: `Bearer ${anythingLLMApiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 90000, // 90s timeout
        });

        // --- Process Response ---
        // Check specifically for textResponse, allowing it to be an empty string
        if (llmResponse.status === 200 && (llmResponse.data?.textResponse !== undefined && llmResponse.data?.textResponse !== null)) {
             // Ensure the response is treated as a string before returning
             return String(llmResponse.data.textResponse);
        } else {
             // Log unexpected successful response structure
             console.warn(`[LLM Service/queryLlm] LLM response status ${llmResponse.status} missing textResponse field or has unexpected structure.`, llmResponse.data);
             return ""; // Return empty string for missing response field or unexpected structure
        }

    } catch (error) {
        // --- Error Handling ---
        let eDetails = error.message;
        const status = error.response?.status;
        if (error.response) {
            // Log detailed error response data if available
            console.error(`[LLM Error Data ${status}]:`, error.response.data);
            eDetails = `Status ${status}: ${error.response.data?.message || JSON.stringify(error.response.data)}`;
        } else if (error.request) {
            // Error occurred during the request setup or no response was received
            console.error('[LLM Error Req]: No response received from LLM server.');
            eDetails = 'No response from LLM server (check network or API URL).';
        } else {
            // Other errors (e.g., setup issues)
            console.error('[LLM Error Msg]:', error.message);
        }
        const eMsg = `LLM query failed Ws=${workspaceSlug} Thr=${threadSlug || 'None'}: ${eDetails}`;
        console.error(`[LLM Error Full Context]`, eMsg);

        // Return empty string on error to prevent downstream crashes, error is logged.
        return "";
    }
}

console.log(`[LLM Service] Initialized.`);
