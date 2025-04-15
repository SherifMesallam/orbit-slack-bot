// src/ai/intentProviders/noneIntentProvider.js
// Default provider that performs no intent detection. It acts as a passthrough.

/**
 * Default "provider" that always returns null intent and confidence 0.
 * This effectively disables intent detection when selected via configuration.
 *
 * @param {string} query - The user's input query (ignored).
 * @param {string[]} [availableIntents=[]] - List of possible intents (ignored).
 * @param {string[]} [availableWorkspaces=[]] - List of available workspace slugs (ignored).
 * @returns {Promise<{ intent: string | null, confidence: number, suggestedWorkspace: string | null }>}
 * Always returns intent: null, confidence: 0, suggestedWorkspace: null.
 */
export async function detectIntent(query, availableIntents = [], availableWorkspaces = []) {
    console.log("[None Intent Provider] Executed (no detection performed).");
    // This provider explicitly returns the neutral "no detection" result.
    return { intent: null, confidence: 0, suggestedWorkspace: null };
}

console.log("[None Intent Provider] Initialized.");
