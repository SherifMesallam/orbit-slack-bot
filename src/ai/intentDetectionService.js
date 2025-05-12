// src/ai/intentDetectionService.js
// Service to detect user intent and potentially suggest a workspace.

// --- Configuration ---
// You will need to add 'intentProvider' to your src/config.js later.
// Example: export const intentProvider = process.env.INTENT_PROVIDER || 'none'; // 'gemini', 'none', etc.
import { intentProvider as configuredProvider } from '../config.js';

// --- Provider Imports ---
// Import specific providers. Ensure these files exist and export detectIntent.
import * as geminiProvider from './intentProviders/geminiIntentProvider.js';
import * as noneProvider from './intentProviders/noneIntentProvider.js';

// --- Provider Registry ---
// Maps configuration keys to the imported provider modules.
const providers = {
    gemini: geminiProvider,
    none: noneProvider,
    // Register other intent detection providers here
    // 'dialogflow': dialogflowProvider,
};

/**
 * Detects the intent and potentially suggests a workspace based on the user query.
 * Selects the appropriate provider based on configuration ('intentProvider' in config.js).
 *
 * @param {string} query - The user's input query text.
 * @param {string[]} [availableIntents=[]] - Optional: List of possible intents the provider might constrain itself to.
 * @param {string[]} [availableWorkspaces=[]] - Optional: List of available workspace slugs the provider might use for suggestions.
 * @returns {Promise<{ intent: string | null, confidence: number, suggestedWorkspace: string | null, rankedWorkspaces: Array }>}
 * - intent: The detected intent string, or null if none detected/applicable.
 * - confidence: A numerical score (e.g., 0-1) indicating the provider's confidence, 0 if none.
 * - suggestedWorkspace: A workspace slug suggested by the provider, or null.
 * - rankedWorkspaces: An array of workspace suggestions with confidence scores.
 */
export async function detectIntentAndWorkspace(query, availableIntents = [], availableWorkspaces = []) {
    // Determine which provider to use based on config, default to 'none'.
    const providerKey = configuredProvider || 'none';
    const provider = providers[providerKey];

    // Validate the selected provider module.
    if (!provider || typeof provider.detectIntent !== 'function') {
        console.warn(`[Intent Service] Configured provider '${providerKey}' is not registered or does not export 'detectIntent'. Falling back to 'none'.`);
        // Fallback explicitly to noneProvider's detectIntent function.
        return providers.none.detectIntent(query, availableIntents, availableWorkspaces);
    }

    try {
        console.log(`[Intent Service] Using intent provider: ${providerKey}`);

        // Call the selected provider's detection function.
        // Each provider's detectIntent function must return the defined object structure.
        const result = await provider.detectIntent(query, availableIntents, availableWorkspaces);

        // Validate the structure returned by the provider.
        if (typeof result !== 'object' || result === null ||
            !result.hasOwnProperty('intent') || // intent can be null, but key must exist
            typeof result.confidence !== 'number' ||
            !result.hasOwnProperty('suggestedWorkspace')) { // suggestedWorkspace can be null, but key must exist
             console.error(`[Intent Service] Provider '${providerKey}' returned an invalid result structure:`, result);
             // Return a default safe response if the provider's result is malformed.
            return { intent: null, confidence: 0, suggestedWorkspace: null, rankedWorkspaces: [], rankedIntents: [] };
        }

        // Ensure confidence is within a reasonable range (optional, but good practice)
        result.confidence = Math.max(0, Math.min(1, result.confidence || 0)); // Clamp between 0 and 1

        // Ensure rankedWorkspaces exists in the result
        if (!result.hasOwnProperty('rankedWorkspaces') || !Array.isArray(result.rankedWorkspaces)) {
            result.rankedWorkspaces = [];
        }
        
        // Ensure rankedIntents exists in the result
        if (!result.hasOwnProperty('rankedIntents') || !Array.isArray(result.rankedIntents)) {
            result.rankedIntents = [];
        }

        console.log(`[Intent Service] Provider '${providerKey}' result: Intent=${result.intent}, Confidence=${result.confidence.toFixed(2)}, SuggestedWs=${result.suggestedWorkspace}, RankedWs=${JSON.stringify(result.rankedWorkspaces)}, RankedIntents=${JSON.stringify(result.rankedIntents)}`);
        return result;

    } catch (error) {
        // Catch errors during the provider's execution.
        console.error(`[Intent Service] Error executing intent detection with provider '${providerKey}':`, error);
        // Return a default safe response on error.
        return { intent: null, confidence: 0, suggestedWorkspace: null, rankedWorkspaces: [], rankedIntents: [] };
    }
}

console.log("[Intent Detection Service] Initialized.");
