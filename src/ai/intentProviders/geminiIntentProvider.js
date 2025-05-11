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
import { geminiApiKey, geminiModelName } from '../../config.js';

// --- Constants ---
// Use the configured model name
const MODEL_NAME = geminiModelName;
// Define safety settings to block harmful content. Adjust thresholds as necessary.
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];
// Default response structure in case of errors or invalid responses
const defaultErrorResponse = { 
    intent: null, 
    confidence: 0, 
    suggestedWorkspace: null,
    rankedWorkspaces: []
};

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
    // Optimized intent detection instructions
    const intentList = availableIntents.length > 0
        ? `You MUST classify this query into EXACTLY ONE of these intent categories AND NOTHING ELSE:

---------- ALLOWED INTENT CATEGORIES (EXCLUSIVE LIST) ----------

${availableIntents.map((intent, index) => {
    let description = "";
    switch(intent) {
        case "technical_question":
            description = "Queries about code functionality, implementation details, debugging, or technical how-to.";
            break;
        case "best_practices_question":
            description = "Queries about optimal approaches, coding standards, design patterns, or recommended ways to implement something.";
            break;
        case "historical_knowledge":
            description = "Queries about past decisions, previous discussions, or organizational memory.";
            break;
        case "bot_abilities":
            description = "Queries about what the bot can do, access, or help with.";
            break;
        case "docs":
            description = "Queries about documentation, usage instructions, or explanatory content.";
            break;
        case "greeting":
            description = "Simple greetings, introductions, or conversation starters.";
            break;
        default:
            description = "Category for this intent type.";
    }
    return `${index + 1}. ${intent}\n   ${description}`;
}).join('\n\n')}

---------- CLASSIFICATION RULES ----------

- YOU MUST ONLY USE THE INTENT CATEGORIES LISTED ABOVE. No variations or custom intents allowed.
- Choose EXACTLY ONE intent from the list above that best matches the query.
- If the query fits multiple categories, select the PRIMARY intent.
- If uncertain, classify based on what the user is PRIMARILY asking for.
- If the query doesn't fit any category well, use "technical_question" as the default.
- Ignore formal greeting parts of queries when determining intent.
- For simple greetings with no other content, use the "greeting" intent.

Your classification must be precise and consistent, using ONLY the exact intent names listed above.`
        : 'Determine the most appropriate intent that describes the user query.';

    // Workspace suggestion instructions
    const workspaceList = availableWorkspaces.length > 0
        ? `Consider which workspaces from this list would be most relevant to the query: [${availableWorkspaces.join(', ')}].
        
Analyze the query's topic and rank the most relevant workspaces in order of relevance. Include only workspaces that have meaningful relevance to the query. IMPORTANT: You MUST include at least one workspace in your rankedWorkspaces array.`
        : 'Use all for the suggested workspace.';

    // The core prompt instructing the model on its task and desired output format.
    const prompt = `
Analyze the following user query: "${query}"

Your task is to:
1. ${intentList}
2. Estimate your confidence in this classification (a number strictly between 0.0 and 1.0).
3. ${workspaceList}

Respond ONLY with a single, valid JSON object containing exactly these keys:
- "intent" (string or null): The classified intent from the allowed list
- "confidence" (number): Your confidence score between 0.0 and 1.0
- "suggestedWorkspace" (string): The primary (most relevant) workspace
- "rankedWorkspaces" (array): List of relevant workspaces with confidence scores. Each item must be an object with "name" and "confidence" properties. Always include at least one workspace.

Do not include any other text, explanations, or markdown formatting like \`\`\`json.

Example valid responses:
{"intent": "technical_question", "confidence": 0.85, "suggestedWorkspace": "all", "rankedWorkspaces": [{"name": "all", "confidence": 0.85}, {"name": "gravityforms", "confidence": 0.65}, {"name": "gravityformsstripe", "confidence": 0.40}, {"name": "another-workspace", "confidence": 0.30}]}
{"intent": "best_practices_question", "confidence": 0.7, "suggestedWorkspace": "gravityformsstipe", "rankedWorkspaces": [{"name": "gravityformsstipe", "confidence": 0.7}, {"name": "gravityforms", "confidence": 0.6}]}
{"intent": "bot_abilities", "confidence": 0.95, "suggestedWorkspace": "all", "rankedWorkspaces": [{"name": "all", "confidence": 0.95}]}
{"intent": "docs", "confidence": 0.82, "suggestedWorkspace": "gravityforms", "rankedWorkspaces": [{"name": "gravityforms", "confidence": 0.82}, {"name": "all", "confidence": 0.45}, {"name": "documentation", "confidence": 0.38}]}
{"intent": null, "confidence": 0.1, "suggestedWorkspace": "gravityforms", "rankedWorkspaces": [{"name": "gravityforms", "confidence": 0.1}]}

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
            parsedResult.hasOwnProperty('suggestedWorkspace') && typeof parsedResult.suggestedWorkspace === 'string' &&
            parsedResult.hasOwnProperty('rankedWorkspaces') && Array.isArray(parsedResult.rankedWorkspaces) &&
            parsedResult.rankedWorkspaces.every(item => typeof item === 'object' && typeof item.name === 'string' && typeof item.confidence === 'number')) {
             // Validate and clamp confidence score
            let confidence = parsedResult.confidence;
            if (isNaN(confidence) || confidence < 0 || confidence > 1) {
                console.warn(`[Gemini Intent Provider] Confidence score (${confidence}) out of range (0-1). Clamping.`);
                confidence = Math.max(0, Math.min(1, confidence || 0));
            }

            // Ensure intent is valid and in the allowed list
            let finalIntent = null;
            if (typeof parsedResult.intent === 'string' && parsedResult.intent.trim()) {
                const trimmedIntent = parsedResult.intent.trim();
                
                // Check if the intent is in our allowed list
                if (availableIntents.length > 0 && !availableIntents.includes(trimmedIntent)) {
                    console.warn(`[Gemini Intent Provider] Received invalid intent "${trimmedIntent}" not in allowed list. Using default.`);
                    // Use technical_question as a default if available, otherwise null
                    finalIntent = availableIntents.includes("technical_question") ? "technical_question" : null;
                } else {
                    finalIntent = trimmedIntent;
                }
            }

            // Ensure suggestedWorkspace is a string or null
            const finalWorkspace = (typeof parsedResult.suggestedWorkspace === 'string' && parsedResult.suggestedWorkspace.trim()) 
                ? parsedResult.suggestedWorkspace.trim() 
                : null;
            
            // Process rankedWorkspaces or create default if missing/invalid
            let rankedWorkspaces = [];
            if (Array.isArray(parsedResult.rankedWorkspaces) && 
                parsedResult.rankedWorkspaces.every(item => 
                    typeof item === 'object' && 
                    typeof item.name === 'string' && 
                    typeof item.confidence === 'number')) {
                // Valid array format, just use it
                rankedWorkspaces = parsedResult.rankedWorkspaces;
            } else if (finalWorkspace) {
                // Create a default entry with just the primary workspace
                rankedWorkspaces = [{ 
                    name: finalWorkspace, 
                    confidence: confidence
                }];
                console.warn(`[Gemini Intent Provider] Missing or invalid rankedWorkspaces. Created default with primary workspace.`);
            }

            console.log(`[Gemini Intent Provider] Parsed result: Intent=${finalIntent}, Conf=${confidence.toFixed(2)}, SugWS=${finalWorkspace}, RankedWS=${JSON.stringify(rankedWorkspaces)}`);
            return {
                intent: finalIntent,
                confidence: confidence,
                suggestedWorkspace: finalWorkspace,
                rankedWorkspaces: rankedWorkspaces
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
