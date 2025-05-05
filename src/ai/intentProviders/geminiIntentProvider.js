// src/ai/intentProviders/geminiIntentProvider.js
// Intent detection provider using Google Generative AI (Gemini).

// --- Required Imports ---
// Ensure you have installed the library: npm install @google/generative-ai
import {
    GoogleGenerativeAI,
    HarmCategory,
    HarmBlockThreshold
} from "@google/generative-ai";
// Ensure geminiApiKey is configured and exported from your config file
import { geminiApiKey } from '../../config.js';

// --- Constants ---
// Adjust model name as needed. Consider newer models like gemini-1.5-flash-latest if available/suitable.
const MODEL_NAME = "gemini-2.5-pro-preview-03-25";
// Define safety settings to block harmful content. Adjust thresholds as necessary.
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];
// Default response structure in case of errors or invalid responses
const defaultErrorResponse = { intent: null, confidence: 0, suggestedWorkspace: null };

/**
 * Detects intent and suggests a workspace using the Gemini API.
 *
 * @param {string} query - The user's input query.
 * @param {string[]} [availableIntents=[]] - List of possible intents to guide classification.
 * @param {string[]} [availableWorkspaces=[]] - List of available workspace slugs for suggestion.
 * @returns {Promise<{ intent: string | null, confidence: number, suggestedWorkspace: string | null }>}
 */
export async function detectIntent(query, availableIntents = [], availableWorkspaces = []) {
	console.log( availableWorkspaces );
    // --- 1. Check Configuration ---
    if (!geminiApiKey) {
        console.error("[Gemini Intent Provider] Error: GEMINI_API_KEY is not configured in src/config.js or environment variables.");
        return defaultErrorResponse;
    }

    // --- 2. Initialize Client ---
    let model;
    try {
        const genAI = new GoogleGenerativeAI(geminiApiKey);
        model = genAI.getGenerativeModel({ model: MODEL_NAME, safetySettings });
    } catch (initError) {
        console.error("[Gemini Intent Provider] Failed to initialize GoogleGenerativeAI client:", initError);
        return defaultErrorResponse;
    }

    // --- 3. Construct Prompt ---
    // Dynamically create lists for the prompt, providing guidance to the model.
    const intentList = availableIntents.length > 0
        ? `Choose ONLY from the following list if applicable: [${availableIntents.join(', ')}]. If none apply, determine the most fitting intent.`
        : 'Determine the most fitting intent.';
    const workspaceList = availableWorkspaces.length > 0
        ? `Suggest the single most relevant workspace for this query based on its topic, choosing ONLY from this list: [${availableWorkspaces.join(', ')}].`
        : 'Use all for the suggested workspace.';

    // The core prompt instructing the model on its task and desired output format.
    const prompt = `
Analyze the following user query: "${query}"

Your task is to:
1. Classify the user's primary intent. ${intentList}
2. Estimate your confidence in this classification (a number strictly between 0.0 and 1.0).
3. ${workspaceList}

Respond ONLY with a single, valid JSON object containing exactly three keys: "intent" (string or null), "confidence" (number between 0.0 and 1.0), and "suggestedWorkspace" (string ). Do not include any other text, explanations, or markdown formatting like \`\`\`json.

Example valid responses:
{"intent": "github_issue_lookup", "confidence": 0.85, "suggestedWorkspace": all}
{"intent": "general_knowledge_question", "confidence": 0.7, "suggestedWorkspace": gravityformsstipe}
{"intent": null, "confidence": 0.1, "suggestedWorkspace": gravityforms}

User Query: "${query}"

JSON Response:
`;

	console.log( prompt );

    // --- 4. Call Gemini API ---
    let responseText = '';
    try {
        console.log("[Gemini Intent Provider] Sending prompt to Gemini model:", MODEL_NAME);
        const result = await model.generateContent(prompt);
        // Access the response text safely
        responseText = result?.response?.text ? result.response.text() : '';
        console.log("[Gemini Intent Provider] Raw response received:", responseText);

        // Check for empty response which might indicate blocked content or other issues
        if (!responseText) {
             console.warn("[Gemini Intent Provider] Received empty response from Gemini. This might indicate blocked content due to safety settings or other API issues.");
             return defaultErrorResponse;
        }

    } catch (apiError) {
        console.error("[Gemini Intent Provider] API call failed:", apiError);
        // Check if the error includes response data (e.g., safety blocks)
        if (apiError.response) {
            console.error("Gemini API Error Response Data:", apiError.response);
        }
        return defaultErrorResponse;
    }

    // --- 5. Parse and Validate Response ---
    try {
        // Clean potential markdown fences and trim whitespace
        let cleanedText = responseText.trim();
        if (cleanedText.startsWith('```json')) {
            cleanedText = cleanedText.substring(7);
        }
        if (cleanedText.endsWith('```')) {
            cleanedText = cleanedText.substring(0, cleanedText.length - 3);
        }
        cleanedText = cleanedText.trim();

        // Attempt to parse the cleaned text as JSON
        const parsedResult = JSON.parse(cleanedText);

        // Validate the parsed structure
        if (typeof parsedResult === 'object' && parsedResult !== null &&
            parsedResult.hasOwnProperty('intent') && // Key must exist, value can be null
            parsedResult.hasOwnProperty('confidence') && typeof parsedResult.confidence === 'number' &&
            parsedResult.hasOwnProperty('suggestedWorkspace')) // Key must exist, value can be null
        {
             // Validate and clamp confidence score
            let confidence = parsedResult.confidence;
            if (isNaN(confidence) || confidence < 0 || confidence > 1) {
                console.warn(`[Gemini Intent Provider] Confidence score (${confidence}) out of range (0-1). Clamping.`);
                confidence = Math.max(0, Math.min(1, confidence || 0));
            }

            // Ensure intent and suggestedWorkspace are strings or null
            const finalIntent = (typeof parsedResult.intent === 'string' && parsedResult.intent.trim()) ? parsedResult.intent.trim() : null;
            const finalWorkspace = (typeof parsedResult.suggestedWorkspace === 'string' && parsedResult.suggestedWorkspace.trim()) ? parsedResult.suggestedWorkspace.trim() : null;

            console.log(`[Gemini Intent Provider] Parsed result: Intent=${finalIntent}, Conf=${confidence.toFixed(2)}, SugWS=${finalWorkspace}`);
            return {
                intent: finalIntent,
                confidence: confidence,
                suggestedWorkspace: finalWorkspace
            };
        } else {
            // Log if the parsed structure is invalid
            console.error("[Gemini Intent Provider] Parsed JSON response lacks required keys or has incorrect types:", parsedResult);
            return defaultErrorResponse;
        }
    } catch (parseError) {
        // Log if JSON parsing fails
        console.error("[Gemini Intent Provider] Failed to parse JSON response from Gemini:", parseError, "\nRaw text received:", responseText);
        return defaultErrorResponse;
    }
}

console.log("[Gemini Intent Provider] Initialized.");
