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
    rankedWorkspaces: [],
    rankedIntents: []
};

// Help Gemini understand the different intents with examples
const intentExamples = `
EXAMPLES:

# github_release_info intent examples:
- "What's the latest version of gravityforms?" → github_release_info
- "When was the last update for stripe addon?" → github_release_info
- "What is the latest core release?" → github_release_info
- "Has there been a new version of PayPal released?" → github_release_info
- "Tell me about the most recent Gravity Forms update" → github_release_info
- "What's new in the latest release?" → github_release_info
- "When did gravityforms last update?" → github_release_info
- "Is there a new version of the Stripe add-on?" → github_release_info
- "What changed in version 2.8?" → github_release_info
- "Release notes for Gravity Forms" → github_release_info
- "When will the next version of Gravity Forms be released?" → github_release_info
- "What's included in the latest core update?" → github_release_info
- "Give me information about the current version of core" → github_release_info
- "Has Gravity Forms core been updated recently?" → github_release_info
- "Tell me about the most recent core release" → github_release_info
- "I want to know about the latest version" → github_release_info
- "What version of Gravity Forms am I supposed to be running?" → github_release_info
- "Check if there's a new release available for Gravity Forms" → github_release_info
- "Are there any recent updates to the PayPal addon?" → github_release_info
- "What's the current stable release of Gravity Forms?" → github_release_info

# github_api_query intent examples:
- "Find all issues labeled bugs" → github_api_query
- "Get a list of open pull requests" → github_api_query
- "Find issues assigned to John" → github_api_query
- "Show me issues with the enhancement label" → github_api_query
- "Search for repositories with 'gravity' in the name" → github_api_query
- "Fetch all issues created in the last month" → github_api_query
- "List all branches in the gravityforms repo" → github_api_query
- "Get the contributors for the Stripe add-on" → github_api_query
- "Find pull requests that mention webhooks" → github_api_query
- "Show me closed issues from last week" → github_api_query
- "How many open issues are there in the gravityforms repo?" → github_api_query
- "Can you check if there are any pull requests waiting for review?" → github_api_query
- "I need to see all bugs reported in the last week" → github_api_query
- "Could you look up issues related to payment processing?" → github_api_query
- "Show me issues mentioning PayPal" → github_api_query
- "Retrieve all issues with high priority" → github_api_query
- "What's the most commented issue in the repo?" → github_api_query
- "Find issues that haven't been updated in a month" → github_api_query
- "Get me a list of all issues tagged as 'needs help'" → github_api_query
- "How many pull requests were merged last month?" → github_api_query

# github_pr_review intent examples:
- "Review PR 123 in the gravityforms repo" → github_pr_review
- "Can you look at pull request #456?" → github_pr_review
- "Analyze the changes in PR 789" → github_pr_review
- "Summarize what PR #234 is doing" → github_pr_review
- "What's in pull request 567?" → github_pr_review
- "Check if PR 890 has any issues" → github_pr_review
- "Review the Stripe integration pull request" → github_pr_review
- "Is pull request 345 ready to be merged?" → github_pr_review
- "Explain what PR #678 is trying to accomplish" → github_pr_review
- "Help me understand this pull request" → github_pr_review

# github_issue_analysis intent examples:
- "Analyze issue #456" → github_issue_analysis
- "Explain GitHub issue 789" → github_issue_analysis
- "What's happening with issue #123?" → github_issue_analysis
- "Summarize the problem in issue 567" → github_issue_analysis
- "Help me understand issue #890" → github_issue_analysis
- "What's issue #234 all about?" → github_issue_analysis
- "Give me details on GitHub issue 345" → github_issue_analysis
- "Analyze the bug reported in issue #678" → github_issue_analysis
- "What's the status of issue 901?" → github_issue_analysis
- "Is issue #432 still relevant?" → github_issue_analysis
- "Analyze issue gravityforms/gravityforms#456" → github_issue_analysis
- "Explain GitHub issue gravityforms/gravityformsstripe#789" → github_issue_analysis
- "What's happening with issue gravityforms/gravityformspaypal#123?" → github_issue_analysis

# docs intent examples:
- "How do I use the Gravity Forms conditional logic?" → docs
- "What are the steps to set up a form?" → docs
- "Explain how the email notifications work" → docs
- "What payment gateways are supported?" → docs
- "How do I create a multi-page form?" → docs
- "What field types are available in Gravity Forms?" → docs
- "How to set up user registration with Gravity Forms?" → docs
- "Explain the difference between posts and custom post types" → docs
- "Show me how to use calculations in forms" → docs
- "What does the 'enable AJAX' setting do?" → docs

# technical_question intent examples:
- "Can you help me debug this PHP code?" → technical_question
- "Why is my form submission failing?" → technical_question
- "How do I fix this JavaScript error in my form?" → technical_question
- "What does this error message mean?" → technical_question
- "How can I optimize my form's performance?" → technical_question
- "Why doesn't my conditional logic work?" → technical_question
- "How do I intercept form submissions programmatically?" → technical_question
- "What's causing this validation error?" → technical_question
- "How do I add custom CSS to my form?" → technical_question
- "What hooks are available for the payment process?" → technical_question

# best_practices_question intent examples:
- "What's the best way to implement webhooks?" → best_practices_question
- "Should I use AJAX for my forms?" → best_practices_question
- "What's the recommended approach for handling file uploads?" → best_practices_question
- "How should I structure my form for better conversion?" → best_practices_question
- "Best practices for form security?" → best_practices_question
- "What's the proper way to use the Gravity Forms API?" → best_practices_question
- "Is it better to use multiple forms or one form with conditional logic?" → best_practices_question
- "Recommended setup for high-traffic forms?" → best_practices_question
- "Best way to integrate Gravity Forms with a custom theme?" → best_practices_question
- "What's the right approach for importing legacy form data?" → best_practices_question

# historical_knowledge intent examples:
- "Why was the legacy payment system deprecated?" → historical_knowledge
- "When was the REST API introduced?" → historical_knowledge
- "What were the major changes in version 2.0?" → historical_knowledge
- "Why did you decide to remove the old user interface?" → historical_knowledge
- "How has the form builder evolved over time?" → historical_knowledge
- "What was the reason for changing how conditional logic works?" → historical_knowledge
- "When did Gravity Forms first add support for Gutenberg?" → historical_knowledge
- "What led to the creation of the Gravity Flow add-on?" → historical_knowledge
- "How did you handle the transition to WordPress 5.0?" → historical_knowledge
- "What legacy features are no longer supported?" → historical_knowledge

# bot_abilities intent examples:
- "What can you help me with?" → bot_abilities
- "What are you capable of doing?" → bot_abilities
- "What commands do you understand?" → bot_abilities
- "How can you assist me with Gravity Forms?" → bot_abilities
- "What GitHub functions can you perform?" → bot_abilities
- "Can you help me with API requests?" → bot_abilities
- "What knowledge do you have about WordPress?" → bot_abilities
- "Are you able to analyze code?" → bot_abilities
- "What types of questions can I ask you?" → bot_abilities
- "What are your limitations?" → bot_abilities

# greeting intent examples:
- "Hi there" → greeting
- "Hello" → greeting
- "Hey bot" → greeting
- "Good morning" → greeting
- "Hi, how are you?" → greeting
- "Hello Orbit" → greeting
- "Hey, what's up?" → greeting
- "Greetings" → greeting
- "Hi! Nice to meet you" → greeting
- "Hello, I'm new here" → greeting
`;

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
            description = "Queries about documentation content, usage instructions, general knowledge about features, or explanatory content. Only use when the user is asking about how to understand or use a feature, NOT when asking about version information.";
            break;
        case "greeting":
            description = "Simple greetings, introductions, or conversation starters.";
            break;
        case "github_release_info":
            description = "Queries about version information, release dates, latest release versions, changelogs, or what's new in a repository or add-on. Use whenever the user asks about 'latest version', 'release', 'update', or 'what's new'.";
            break;
        case "github_pr_review":
            description = "Requests to review or summarize a pull request.";
            break; 
        case "github_issue_analysis":
            description = "Requests to analyze, summarize, or explain a GitHub issue. For workspace suggestions, prefer repo names or specific components extracted from the repo name (e.g., for 'gravityformsstripe' suggest 'stripe'). Never use issue numbers as workspaces.";
            break;
        case "github_api_query":
            description = "Natural language requests to query the GitHub API.";
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
- For queries about latest version, release dates, "core release" or "what's new", ALWAYS use "github_release_info".
- For queries about how to use features or general product knowledge, use "docs".
- For queries asking to find, list, search for, or retrieve information from GitHub like issues or PRs, use "github_api_query".
- For queries requesting analysis or explanation of a specific issue, use "github_issue_analysis".
- For queries asking about a specific PR review, use "github_pr_review".
- Prioritize GitHub-specific intents (github_*) when a query mentions GitHub entities like issues, PRs, releases, etc.

Your classification must be precise and consistent, using ONLY the exact intent names listed above.`
        : 'Determine the most appropriate intent that describes the user query.';

    // Workspace suggestion instructions
    const workspaceList = availableWorkspaces.length > 0
        ? `Consider which workspaces from this list would be most relevant to the query: [${availableWorkspaces.join(', ')}].
        
Analyze the query's topic and rank the most relevant workspaces in order of relevance. Include only workspaces that have meaningful relevance to the query. IMPORTANT: You MUST include at least one workspace in your rankedWorkspaces array.

For GitHub issue analysis:
- If the issue is in format "org/repo#number" (e.g., "gravityforms/gravityforms#456"), extract the repo name (gravityforms) as the primary workspace
- If the repo has a prefix like "gravityforms" in "gravityformsstripe#123", use the suffix (stripe) as the workspace
- If only an issue number is provided without repo context (e.g., "Analyze issue #456"), suggest "github" or another general workspace
- NEVER use the issue number itself as a workspace name`
        : 'Use all for the suggested workspace.';

    // The core prompt instructing the model on its task and desired output format.
    const prompt = `
Analyze the following user query: "${query}"

Your task is to:
1. ${intentList}
2. Estimate your confidence in this classification (a number strictly between 0.0 and 1.0).
3. ${workspaceList}

${intentExamples}

Respond ONLY with a single, valid JSON object containing exactly these keys:
- "intent" (string or null): The primary classified intent from the allowed list
- "confidence" (number): Your confidence score between 0.0 and 1.0
- "suggestedWorkspace" (string): The primary (most relevant) workspace
- "rankedWorkspaces" (array): List of relevant workspaces with confidence scores. Each item must be an object with "name" and "confidence" properties. Always include at least one workspace.
- "rankedIntents" (array): List of all potential matching intents, ranked by confidence. Each item must be an object with "name" and "confidence" properties.

Do not include any other text, explanations, or markdown formatting like \`\`\`json.

Example valid responses:
{"intent": "technical_question", "confidence": 0.85, "suggestedWorkspace": "all", "rankedWorkspaces": [{"name": "all", "confidence": 0.85}, {"name": "gravityforms", "confidence": 0.65}, {"name": "gravityformsstripe", "confidence": 0.40}, {"name": "another-workspace", "confidence": 0.30}], "rankedIntents": [{"name": "technical_question", "confidence": 0.85}, {"name": "docs", "confidence": 0.45}, {"name": "best_practices_question", "confidence": 0.25}]}
{"intent": "github_release_info", "confidence": 0.92, "suggestedWorkspace": "gravityforms", "rankedWorkspaces": [{"name": "gravityforms", "confidence": 0.92}, {"name": "all", "confidence": 0.70}], "rankedIntents": [{"name": "github_release_info", "confidence": 0.92}, {"name": "docs", "confidence": 0.35}]}

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
            parsedResult.rankedWorkspaces.every(item => typeof item === 'object' && typeof item.name === 'string' && typeof item.confidence === 'number') &&
            parsedResult.hasOwnProperty('rankedIntents') && Array.isArray(parsedResult.rankedIntents) &&
            parsedResult.rankedIntents.every(item => typeof item === 'object' && typeof item.name === 'string' && typeof item.confidence === 'number')) {
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

            // Ensure rankedWorkspaces exists in the result
            if (!parsedResult.hasOwnProperty('rankedWorkspaces') || !Array.isArray(parsedResult.rankedWorkspaces)) {
                parsedResult.rankedWorkspaces = [];
            }

            // Ensure rankedIntents exists in the result
            if (!parsedResult.hasOwnProperty('rankedIntents') || !Array.isArray(parsedResult.rankedIntents)) {
                // Create a default rankedIntents array with just the primary intent
                if (finalIntent) {
                    parsedResult.rankedIntents = [{ 
                        name: finalIntent, 
                        confidence: confidence
                    }];
                } else {
                    parsedResult.rankedIntents = [];
                }
                console.warn(`[Gemini Intent Provider] Missing or invalid rankedIntents. Created default with primary intent.`);
            }

            console.log(`[Gemini Intent Provider] Parsed result: Intent=${finalIntent}, Conf=${confidence.toFixed(2)}, SugWS=${finalWorkspace}, RankedWS=${JSON.stringify(rankedWorkspaces)}, RankedIntents=${JSON.stringify(parsedResult.rankedIntents)}`);
            return {
                intent: finalIntent,
                confidence: confidence,
                suggestedWorkspace: finalWorkspace,
                rankedWorkspaces: rankedWorkspaces,
                rankedIntents: parsedResult.rankedIntents
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

/**
 * Simple test function to verify intent detection for release queries.
 * This is for development/debugging only and should be removed in production.
 * @param {string} query - The query to test
 * @param {string[]} [availableIntents=[]] - Optional list of available intents
 * @param {string[]} [availableWorkspaces=[]] - Optional list of available workspaces
 * @returns {Promise<void>} - Logs the result to the console
 */
export async function testReleaseIntentDetection(query, availableIntents = [], availableWorkspaces = []) {
    console.log(`[Gemini Intent Test] Testing query: "${query}"`);
    try {
        const result = await detectIntent(
            query, 
            availableIntents.length > 0 ? availableIntents : [
                "technical_question", "best_practices_question", "historical_knowledge",
                "bot_abilities", "docs", "greeting", "github_release_info", 
                "github_pr_review", "github_issue_analysis", "github_api_query"
            ],
            availableWorkspaces.length > 0 ? availableWorkspaces : ["all", "gravityforms", "gravityformsstripe"]
        );
        console.log("[Gemini Intent Test] Result:", JSON.stringify(result, null, 2));
        return result;
    } catch (error) {
        console.error("[Gemini Intent Test] Error:", error);
    }
}

console.log("[Gemini Intent Provider] Initialized.");
