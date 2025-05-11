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
    // Optimized intent detection instructions
    const intentList = availableIntents.length > 0
        ? `You must classify this query into EXACTLY ONE of these intent categories:

---------- INTENT CATEGORIES ----------

1. technical_question
   Queries about code functionality, implementation details, debugging, or technical how-to.
   Examples: "How does the merge tags system work?", "Is there a method to check if a form is conversational?", 
   "Why does the validation fail when using conditional logic?", "How can I debug this JS error in the form editor?"

2. best_practices_question
   Queries about optimal approaches, coding standards, design patterns, or recommended ways to implement something.
   Examples: "What's the best way to extend the form editor?", "Should I use hooks or filters for this?",
   "What's our standard pattern for implementing new field types?", "How should I structure this new feature?"

3. historical_knowledge
   Queries about past decisions, previous discussions, or organizational memory.
   Examples: "Didn't we discuss this issue last month?", "Why did we implement it this way originally?",
   "Was there a PR about the notification system?", "What was our conclusion about the API rate limits?"

4. bot_abilities
   Queries about what the bot can do, access, or help with.
   Examples: "Can you help with PR reviews?", "Do you have access to the docs repository?",
   "Are you able to summarize issues?", "Can you explain code from private repositories?"

5. docs
   Queries about documentation, usage instructions, or explanatory content.
   Examples: "How do I use conditional logic in forms?", "What does the gravity_form() function do?",
   "Is there documentation for the REST API?", "How do customers use the survey add-on?"

6. greeting
   Simple greetings, introductions, or conversation starters.
   Examples: "Hello", "Hi there", "Hey Orbit", "Good morning", "What's up?", "How are you?", 
   "Nice to meet you", "Can you help me?"

---------- CLASSIFICATION RULES ----------

- Choose EXACTLY ONE intent that best matches the query.
- If the query fits multiple categories, select the PRIMARY intent.
- If uncertain, classify based on what the user is PRIMARILY asking for.
- If the query doesn't fit any category well, respond with intent: null.
- Ignore formal greeting parts of queries when determining intent.
- For simple greetings with no other content, use the "greeting" intent.

Your classification should be precise and consistent.`
        : 'Determine the most appropriate intent that describes the user query.';

    // Workspace suggestion instructions
    const workspaceList = availableWorkspaces.length > 0
        ? `Suggest the single most relevant workspace for this query based on its topic, choosing ONLY from this list: [${availableWorkspaces.join(', ')}].`
        : 'Use all for the suggested workspace.';

    // The core prompt instructing the model on its task and desired output format.
    const prompt = `
Analyze the following user query: "${query}"

Your task is to:
1. ${intentList}
2. Estimate your confidence in this classification (a number strictly between 0.0 and 1.0).
3. ${workspaceList}

Respond ONLY with a single, valid JSON object containing exactly three keys: "intent" (string or null), "confidence" (number between 0.0 and 1.0), and "suggestedWorkspace" (string). Do not include any other text, explanations, or markdown formatting like \`\`\`json.

Example valid responses:
{"intent": "technical_question", "confidence": 0.85, "suggestedWorkspace": all}
{"intent": "best_practices_question", "confidence": 0.7, "suggestedWorkspace": gravityformsstipe}
{"intent": "greeting", "confidence": 0.5, "suggestedWorkspace": gravityforms}
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
