// src/ai/intentProviders/noneIntentProvider.js
// Default provider that performs no intent detection. It acts as a passthrough,
// but suggests a workspace based on #mention or keyword matching.

import { fallbackWorkspace } from "../../config.js";
// Import the new service function
import { getDynamicWorkspaceKeywordMap } from '../../services/index.js'; // Adjusted path

// Uncomment and use the static keyword map
const staticWorkspaceKeywordMap = {
	"gravityformssquare": ["gravityformssquare", "square", "square payments", "square add-on"],
	"gravityformsstripe": ["gravityformsstripe", "stripe", "stripe payments", "stripe add-on"],
	"gravityformsppcp": ["gravityformsppcp", "ppcp", "gravityforms paypal", "paypal", "paypal payments"],
	"gravityforms": ["gravityforms", "core", "the main add-on", "gravityforms core"],
	"gravityflow": ["gravityflow", "flow", "flow add-on"],
	"gravitypackages": ["gravitypackages", "packages", " packages add-on"],
  "gravityforms2checkout": ["2checkout", "2checkout add-on"],
  "gravityformssaleforce": ["saleforce", "saleforce add-on"],
  "gravityformssignature": ["signature", "signature add-on"],
  "gravityformspaypal": ["paypal standard", "legacy paypal addon"]
};

/**
 * Default "provider" that always returns null intent and confidence 0.
 * This effectively disables intent detection when selected via configuration.
 *
 * @param {string} query - The user's input query.
 * @param {string[]} [availableIntents=[]] - List of possible intents (ignored).
 * @param {string[]} [availableWorkspaces=[]] - List of available workspace slugs (used by findBestKeyword indirectly if map keys align with these).
 * @returns {Promise<{ intent: string | null, confidence: number, suggestedWorkspace: string | null }>}
 * Always returns intent: null, confidence: 0, suggestedWorkspace based on logic.
 */
export async function detectIntent(query, availableIntents = [], availableWorkspaces = []) {
	console.log("[None Intent Provider] Executed.");
	const workSpaceRegex = /#(\w+)/; // # followed by one or more word characters (captured)
	const match = workSpaceRegex.exec(query);
	let suggestedWsFromHash = match ? match[1] : null;

	let finalSuggestedWorkspace = null;

	if (suggestedWsFromHash) {
		console.log(`[None Intent Provider] Workspace from #mention: ${suggestedWsFromHash}`);
		finalSuggestedWorkspace = suggestedWsFromHash;
	} else {
		console.log("[None Intent Provider] No #mention for workspace. Attempting static keyword map first.");
		// Try static map first
		const wsFromStaticMap = findBestKeyword(query, staticWorkspaceKeywordMap, null); // Pass null as default to see if it finds anything specific

		if (wsFromStaticMap) { // If static map yields any result (even if it might be a fallback defined within it, though current one doesn't have that)
			console.log(`[None Intent Provider] Workspace from static map: ${wsFromStaticMap}`);
			finalSuggestedWorkspace = wsFromStaticMap;
		} else {
			console.log("[None Intent Provider] No specific match from static map. Attempting dynamic keyword map.");
			const dynamicKeywordMap = await getDynamicWorkspaceKeywordMap();

			if (dynamicKeywordMap && Object.keys(dynamicKeywordMap).length > 0) {
				const workspaceFromKeywords = findBestKeyword(query, dynamicKeywordMap, fallbackWorkspace); // Dynamic map uses global fallback
				if (workspaceFromKeywords) { // workspaceFromKeywords could be the fallbackWorkspace itself
					console.log(`[None Intent Provider] Workspace from dynamic keywords: ${workspaceFromKeywords}`);
					finalSuggestedWorkspace = workspaceFromKeywords;
				} else {
					// This case should be rare if fallbackWorkspace is always defined and findBestKeyword returns it
					console.log("[None Intent Provider] Dynamic map processing or fallback failed. Defaulting to global fallback.");
					finalSuggestedWorkspace = fallbackWorkspace;
				}
			} else {
				console.warn("[None Intent Provider] Dynamic keyword map is empty or unavailable. Using global fallback workspace.");
				finalSuggestedWorkspace = fallbackWorkspace;
			}
		}
	}

	// Ensure the final suggested workspace is validated against availableWorkspaces by the calling service (workspaceService.determineWorkspace)
	// This provider only suggests; determineWorkspace confirms availability.
	return { intent: null, confidence: 0, suggestedWorkspace: finalSuggestedWorkspace };
}

/**
 * Finds the keyword map key with the highest weight based on occurrences
 * of its associated search terms within a given text block.
 * Returns a default value if inputs are invalid, no keywords are found,
 * or if there is a tie for the highest weight.
 *
 * @param {string} text - The block of text to search within.
 * @param {object} keywordMap - An object where keys are the identifiers to return,
 * and values are arrays of search terms (strings).
 * Example:
 * {
 *   "key1": ["search term a", "search term b"],
 *   "key2": ["search term c", "search term d"]
 * }
 * @param {*} [defaultValue=null] - The value to return if no match is found,
 * if inputs are invalid, or in case of a tie. Defaults to null if not provided.
 * @returns {string|*} The key from keywordMap with the uniquely highest calculated weight,
 * or the defaultValue.
 */
function findBestKeyword(text, keywordMap, defaultValue = null) {
	// --- Input Validation ---
	if (!text || typeof text !== 'string' || !keywordMap || typeof keywordMap !== 'object' || Object.keys(keywordMap).length === 0) {
		console.warn("[findBestKeyword] Invalid input provided or empty keywordMap. Returning default value.");
		return defaultValue;
	}

	const weights = {};
	let maxWeight = 0; // Variable to store the highest weight found
	const lowerCaseText = text.toLowerCase(); // Ensure case-insensitive search

	// --- Calculate Weights --- 
	// Iterate over each key (potential workspace) in the keywordMap
	for (const key in keywordMap) {
		if (Object.hasOwnProperty.call(keywordMap, key)) {
			weights[key] = 0; // Initialize weight for this key
			const searchTerms = keywordMap[key]; // Get the array of search terms for this key
			if (Array.isArray(searchTerms)) {
				searchTerms.forEach(term => { // For each search term
					if (typeof term === 'string' && term.length > 0) {
						const lowerCaseTerm = term.toLowerCase();
						try {
							// Create a global, case-insensitive regex for the term
							const regex = new RegExp(escapeRegExp(lowerCaseTerm), 'gi');
							const matches = lowerCaseText.match(regex); // Find all occurrences
							if (matches) {
								weights[key] += matches.length; // Add number of occurrences to weight
							}
						} catch (e) {
							console.error(`[findBestKeyword] Error creating RegExp for term: "${term}". Skipping. Error: ${e.message}`);
						}
					}
				});
			} else {
				 console.warn(`[findBestKeyword] Value for key "${key}" in keywordMap is not an array. Skipping key.`);
			}
		}
	}

	// --- Pass 1: Find the Maximum Weight ---
	// Find the highest score (weight) achieved by any key
	for (const key in weights) {
		if (Object.hasOwnProperty.call(weights, key)) {
			if (weights[key] > maxWeight) {
				maxWeight = weights[key];
			}
		}
	}

	// --- Handle No Matches ---
	// If the highest weight is 0, it means no keywords were found or matched in the text.
	if (maxWeight === 0) {
		console.log("[findBestKeyword] No keywords found or matched. Returning default value.");
		return defaultValue;
	}

	// --- Pass 2: Check for Ties at the Maximum Weight ---
	let maxWeightCount = 0;       // Counter for keys that have the maximum weight
	let keyWithMaxWeight = null;  // To store the key if it's the unique winner

	for (const key in weights) {
		 if (Object.hasOwnProperty.call(weights, key)) {
			 // Check if this key's weight equals the highest weight found
			 if (weights[key] === maxWeight) {
				 maxWeightCount++;
				 keyWithMaxWeight = key; // Store the key; will be overwritten if multiple keys have max weight, but that's handled next
			 }
		 }
	}

	// --- Return Based on Tie Check ---
	// If more than one key achieved the max weight, it's considered a tie.
	if (maxWeightCount > 1) {
		console.log(`[findBestKeyword] Tie detected (${maxWeightCount} keys) for max weight ${maxWeight}. Returning default value.`);
		return defaultValue; // Return default value in case of a tie
	} else {
		// Otherwise, maxWeightCount must be 1 (since we handled maxWeight=0 earlier),
		// meaning there is a unique winner.
		console.log(`[findBestKeyword] Unique winner: ${keyWithMaxWeight} with weight ${maxWeight}.`);
		return keyWithMaxWeight; // Return the single key that had the max weight
	}
}

// Helper function to escape special regex characters ---
function escapeRegExp(string) {
	// $& means the whole matched string
	// Correcting the replacement string back to \\$& for proper escaping.
	return string.replace(/[.*+?^${}()|[\]\\\\]/g, '\\$&');
}

console.log("[None Intent Provider] Initialized with dynamic keyword map capability.");
