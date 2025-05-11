// src/ai/intentProviders/noneIntentProvider.js
// Default provider that performs no intent detection. It acts as a passthrough.

import { fallbackWorkspace } from "../../config.js";

const workspaceKeywordMap = {
  "gravityformssquare": ["gravityformssquare", "square", "square payments", "square add-on"],
  "gravityformsstripe": ["gravityformsstripe", "stripe", "stripe payments", "stripe add-on"],
  "gravityformsppcp": ["gravityformsppcp", "ppcp", "gravityforms paypal", "paypal", "paypal payments"],
  "gravityforms": ["gravityforms", "core", "the main add-on", "gravityforms core"],
  "gravityflow": ["gravityflow", "flow", "flow add-on"],
  "gravitypackages": ["gravitypackages", "packages", " packages add-on"],
};

/**
 * Default "provider" that always returns null intent and confidence 0.
 * This effectively disables intent detection when selected via configuration.
 *
 * @param {string} query - The user's input query (ignored).
 * @param {string[]} [availableIntents=[]] - List of possible intents (ignored).
 * @param {string[]} [availableWorkspaces=[]] - List of available workspace slugs (ignored).
 * @returns {Promise<{ intent: string | null, confidence: number, suggestedWorkspace: string | null, rankedWorkspaces: Array }>}
 * Always returns intent: null, confidence: 0, suggestedWorkspace based on simple heuristics, and rankedWorkspaces with matching workspaces.
 */
export async function detectIntent(query, availableIntents = [], availableWorkspaces = []) {
	console.log("[None Intent Provider] Executed (no detection performed).");
	const workSpaceRegex = /#(\w+)/; // # followed by one or more word characters (captured)
	const match = workSpaceRegex.exec( query );
	let workspace =  match ? match[1] : null;

	if ( null == workspace ) {
		workspace = findBestKeyword( query, workspaceKeywordMap, fallbackWorkspace );
	}
	
	// Create simple rankedWorkspaces array
	const rankedWorkspaces = [];
	if (workspace) {
		rankedWorkspaces.push({ name: workspace, confidence: 0.5 });
	}
	
	// This provider explicitly returns the neutral "no detection" result.
	return { 
		intent: null, 
		confidence: 0, 
		suggestedWorkspace: workspace,
		rankedWorkspaces: rankedWorkspaces
	};
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
 * "key1": ["search term a", "search term b"],
 * "key2": ["search term c", "search term d"]
 * }
 * @param {*} [defaultValue=null] - The value to return if no match is found,
 * if inputs are invalid, or in case of a tie. Defaults to null if not provided.
 * @returns {string|*} The key from keywordMap with the uniquely highest calculated weight,
 * or the defaultValue.
 */
function findBestKeyword(text, keywordMap, defaultValue = null) {
  // --- Input Validation ---
  if (!text || typeof text !== 'string' || !keywordMap || typeof keywordMap !== 'object' || Object.keys(keywordMap).length === 0) {
    console.error("Invalid input provided. Returning default value.");
    return defaultValue;
  }

  // --- Helper function to escape special regex characters ---
  function escapeRegExp(string) {
    // $& means the whole matched string
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const weights = {};
  let maxWeight = 0; // Variable to store the highest weight found
  const lowerCaseText = text.toLowerCase(); // Ensure case-insensitive search

  // --- Calculate Weights --- (Same as before)
  for (const key in keywordMap) {
    if (Object.hasOwnProperty.call(keywordMap, key)) {
      weights[key] = 0;
      const searchTerms = keywordMap[key];
      if (Array.isArray(searchTerms)) {
        searchTerms.forEach(term => {
          if (typeof term === 'string' && term.length > 0) {
            const lowerCaseTerm = term.toLowerCase();
            try {
              const regex = new RegExp(escapeRegExp(lowerCaseTerm), 'gi');
              const matches = lowerCaseText.match(regex);
              if (matches) {
                weights[key] += matches.length;
              }
            } catch (e) {
              console.error(`Error creating RegExp for term: "${term}". Skipping term. Error: ${e}`);
            }
          }
        });
      } else {
         console.warn(`Value for key "${key}" is not an array. Skipping key.`);
      }
    }
  }

  // --- Pass 1: Find the Maximum Weight ---
  // Find the highest score achieved by any key
  for (const key in weights) {
    if (Object.hasOwnProperty.call(weights, key)) {
      if (weights[key] > maxWeight) {
        maxWeight = weights[key];
      }
    }
  }

  // --- Handle No Matches ---
  // If the highest weight is 0, no keywords were found. Return default.
  if (maxWeight === 0) {
    console.log("No keywords found or matched in the text. Returning default value.");
    return defaultValue;
  }

  // --- Pass 2: Check for Ties at the Maximum Weight ---
  let maxWeightCount = 0;       // Counter for keys matching the max weight
  let keyWithMaxWeight = null;  // To store the key if it's the unique winner

  for (const key in weights) {
     if (Object.hasOwnProperty.call(weights, key)) {
         // Check if this key's weight equals the highest weight found
         if (weights[key] === maxWeight) {
             maxWeightCount++;
             keyWithMaxWeight = key; // Store the key - will be overwritten if multiple keys have max weight
         }
     }
  }

  // --- Return Based on Tie Check ---
  // If more than one key achieved the max weight, it's a tie.
  if (maxWeightCount > 1) {
    console.log(`Tie detected (${maxWeightCount} keys) for maximum weight ${maxWeight}. Returning default value.`);
    return defaultValue; // Return default value in case of a tie
  } else {
    // Otherwise, maxWeightCount must be 1 (since we handled maxWeight=0 earlier),
    // so we have a unique winner.
    return keyWithMaxWeight; // Return the single key that had the max weight
  }
}


console.log("[None Intent Provider] Initialized.");
