import dotenv from 'dotenv';
import process from 'process'; // Ensure process is available for process.env and process.exit

// Load environment variables from .env file
dotenv.config();

/**
 * =============================================================================
 * SLACK CONFIGURATION
 * =============================================================================
 */

/** @type {string | undefined} Slack App Signing Secret for verifying requests. REQUIRED. */
export const signingSecret = process.env.SLACK_SIGNING_SECRET;

/** @type {string | undefined} Slack Bot User OAuth Token (xoxb-...). REQUIRED. */
export const botToken = process.env.SLACK_BOT_TOKEN;

/** @type {string | undefined} Slack App-Level Token (xapp-...). Usually for Socket Mode, optional for HTTP. */
export const appToken = process.env.SLACK_APP_TOKEN;

/** @type {string | undefined} The User ID of the bot itself (e.g., UXXXXXXXX). REQUIRED. */
export const botUserId = process.env.SLACK_BOT_USER_ID;

/** @type {string | undefined} Optional: Slack User ID of the developer for special commands/notifications. */
export const developerId = process.env.DEVELOPER_ID;


/**
 * =============================================================================
 * WORKSPACE / ROUTING CONFIGURATION
 * =============================================================================
 */

/** @type {boolean} Enable mapping specific Slack users to specific AnythingLLM workspaces. */
export const enableUserWorkspaces = process.env.ENABLE_USER_WORKSPACES === 'true';

/** @type {Record<string, string>} Parsed JSON mapping Slack User IDs to AnythingLLM workspace slugs. */
export const userWorkspaceMapping = JSON.parse(process.env.SLACK_USER_WORKSPACE_MAPPING || '{}');

/** @type {Record<string, string>} Parsed JSON mapping Slack Channel IDs to AnythingLLM workspace slugs. */
export const workspaceMapping = JSON.parse(process.env.WORKSPACE_MAPPING || '{}');

/** @type {string | null} Default AnythingLLM workspace slug if no user or channel mapping found. */
export const fallbackWorkspace = process.env.FALLBACK_WORKSPACE_SLUG || 'all';

/** @type {string} Prefix character for manually overriding workspace in general chat (e.g., #). Kept for reference, but routing primarily uses determineWorkspace now. */
export const WORKSPACE_OVERRIDE_COMMAND_PREFIX = '#';


/**
 * =============================================================================
 * INTENT DETECTION CONFIGURATION (New)
 * =============================================================================
 */

/** @type {boolean} Master switch to enable/disable the intent detection step in messageHandler. */
export const intentRoutingEnabled = process.env.INTENT_ROUTING_ENABLED === 'true' || true; // Default: true

/** @type {string} Name of the intent detection provider to use ('none', 'gemini', etc.). Matches keys in intentDetectionService.js. */
export const intentProvider = process.env.INTENT_PROVIDER || 'gemini'; // Default: 'gemini'

/** @type {number} Minimum confidence score (0-1) required to act upon a detected intent (used in future routing logic). */
export const intentConfidenceThreshold = parseFloat(process.env.INTENT_CONFIDENCE_THRESHOLD || '0.7'); // Default: 0.7

/** @type {string | null} API Key specifically for the Gemini intent provider. Required if intentProvider is 'gemini'. */
export const geminiApiKey = process.env.GEMINI_API_KEY || ""; // Default: null

/** @type {string} The Gemini model name to use for intent detection. */
export const geminiModelName = process.env.GEMINI_MODEL_NAME || "gemini-2.5-pro-preview-03-25"; // Default: gemini-2.5-pro-preview-03-25

/** @type {string[]} Optional: List of known intent names. Might be used by providers or routing logic. */
export const possibleIntents = JSON.parse(process.env.POSSIBLE_INTENTS || '["technical_question", "best_practices_question", "historical_knowledge", "bot_abilities", "docs", "greeting"]'); // Default: []

/** @type {string[]} Optional: List of message prefixes that could trigger intent detection explicitly (if needed). */
export const intentPrefixes = JSON.parse(process.env.INTENT_PREFIXES || '[]'); // Default: []


/**
 * =============================================================================
 * ANYTHINGLLM CONFIGURATION
 * =============================================================================
 */

/** @type {string | undefined} Base URL for the AnythingLLM API (e.g., http://localhost:3001). REQUIRED. */
export const anythingLLMBaseUrl = process.env.LLM_API_BASE_URL;

/** @type {string | undefined} API Key for AnythingLLM. REQUIRED. */
export const anythingLLMApiKey = process.env.LLM_API_KEY;


/**
 * =============================================================================
 * GITHUB FEATURE CONFIGURATION
 * =============================================================================
 */

/** @type {string | null} GitHub Personal Access Token (PAT) with appropriate scopes (repo, read:user). REQUIRED for GitHub features. */
export const githubToken = process.env.GITHUB_TOKEN || null;

/** @type {string | null} AnythingLLM workspace slug used for the generic API command (`gh: api`, `/gh-api`) to generate API call details. REQUIRED for generic API command. */
export const githubWorkspaceSlug = process.env.GITHUB_WORKSPACE_SLUG || null;

/** @type {string | null} Optional AnythingLLM workspace slug used to format JSON responses from the generic API command into Markdown. */
export const formatterWorkspaceSlug = process.env.FORMATTER_WORKSPACE_SLUG || null;

/** @type {string} Default GitHub owner username/organization for commands unless specified otherwise (e.g., `gh: analyze issue #123` defaults to this owner). */
export const GITHUB_OWNER = process.env.GITHUB_OWNER || 'gravityforms';


/**
 * =============================================================================
 * INFRASTRUCTURE & BEHAVIOR CONFIGURATION
 * =============================================================================
 */

/** @type {number} Port the application server will listen on. */
export const port = parseInt(process.env.PORT || '3000', 10);

/** @type {string | null} Connection URL for Redis (e.g., redis://user:pass@host:port). Optional, enables deduplication. */
export const redisUrl = process.env.REDIS_URL || null;

/** @type {string | null} Connection URL for PostgreSQL database (e.g., postgresql://user:pass@host:port/db). Optional, enables feedback/thread mapping. */
export const databaseUrl = process.env.DATABASE_URL || null;

/** @type {string} Prefix string required for text-based commands (e.g., gh:). */
export const COMMAND_PREFIX = "gh:";

/** @type {number} Max characters allowed in a single Slack text block element (approximate). */
export const MAX_SLACK_BLOCK_TEXT_LENGTH = 2950; // Slack limit is 3000 for mrkdwn text obj

/** @type {number} Max characters allowed in a single Slack code block element (within preformatted). */
export const MAX_SLACK_BLOCK_CODE_LENGTH = process.env.MAX_SLACK_BLOCK_CODE_LENGTH ? parseInt(process.env.MAX_SLACK_BLOCK_CODE_LENGTH, 10) : 2800; // Keep slightly under limit

/** @type {string} Text command trigger to reset conversation history (if implemented). */
export const RESET_CONVERSATION_COMMAND = 'reset conversation';

/** @type {number} Minimum character length for an LLM response to be considered "substantive" enough for feedback buttons. */
export const MIN_SUBSTANTIVE_RESPONSE_LENGTH = process.env.MIN_SUBSTANTIVE_RESPONSE_LENGTH ? parseInt(process.env.MIN_SUBSTANTIVE_RESPONSE_LENGTH, 10) : 100; // Default: 100 chars

export const FEEDBACK_SYSTEM_ENABLED = process.env.FEEDBACK_SYSTEM_ENABLED || false;

/**
 * =============================================================================
 * CACHE CONFIGURATION (TTL in seconds)
 * =============================================================================
 */

/** @type {number} Time-to-live (seconds) for Redis event deduplication keys. */
export const DUPLICATE_EVENT_TTL = 600; // 10 minutes

/** @type {number} Time-to-live (seconds) for Redis "reset history" keys (if used). */
export const RESET_HISTORY_TTL = 300; // 5 minutes

/** @type {number} Time-to-live (seconds) for the cached list of available AnythingLLM workspaces. */
export const WORKSPACE_LIST_CACHE_TTL = 3600; // 1 hour

// Note: THREAD_WORKSPACE_TTL is effectively managed by the DB last_accessed_at timestamp now.


/**
 * =============================================================================
 * REDIS KEY PREFIXES
 * =============================================================================
 */

/** @type {string} Prefix for Redis keys used for event deduplication. */
export const DUPLICATE_EVENT_REDIS_PREFIX = 'slack_event_id:';

/** @type {string} Prefix for Redis keys used for "reset history" command (if used). */
export const RESET_HISTORY_REDIS_PREFIX = 'slack_reset_hist:';

/** @type {string} Redis key used to cache the list of available AnythingLLM workspace slugs. */
export const WORKSPACE_LIST_CACHE_KEY = 'anythingllm_workspaces';


/**
 * =============================================================================
 * CONFIGURATION VALIDATION
 * =============================================================================
 */

/**
 * Validates essential configuration and logs warnings/errors.
 * Exits the process if critical configuration is missing.
 */
export function validateConfig() {
    console.log("[Config] Validating configuration...");
    const errors = [];
    const warnings = [];

    // Critical Slack Config
    if (!signingSecret) errors.push("SLACK_SIGNING_SECRET");
    if (!botToken) errors.push("SLACK_BOT_TOKEN");
    if (!botUserId) errors.push("SLACK_BOT_USER_ID");

    // Critical LLM Config
    if (!anythingLLMBaseUrl) errors.push("LLM_API_BASE_URL");
    if (!anythingLLMApiKey) errors.push("LLM_API_KEY");

    // Workspace Configuration Warnings
    if (!fallbackWorkspace && !enableUserWorkspaces && (!workspaceMapping || Object.keys(workspaceMapping).length === 0)) {
        warnings.push("No primary workspace configuration found (FALLBACK_WORKSPACE_SLUG, WORKSPACE_MAPPING, or ENABLE_USER_WORKSPACES + SLACK_USER_WORKSPACE_MAPPING). Default LLM routing might fail if workspace cannot be determined.");
    }
    if (enableUserWorkspaces && (!userWorkspaceMapping || Object.keys(userWorkspaceMapping).length === 0)) {
        warnings.push("ENABLE_USER_WORKSPACES is true, but SLACK_USER_WORKSPACE_MAPPING is empty/invalid.");
    }

    // Intent Detection Warnings
    if (intentProvider === 'gemini' && !geminiApiKey) {
        warnings.push("INTENT_PROVIDER is set to 'gemini', but GEMINI_API_KEY is missing. Intent detection will fail to use Gemini.");
    }
    if (intentProvider === 'gemini' && (!geminiModelName || geminiModelName.trim() === '')) {
        warnings.push("INTENT_PROVIDER is set to 'gemini', but GEMINI_MODEL_NAME is empty. Using default model.");
    }
    if (intentRoutingEnabled && intentProvider === 'none') {
        warnings.push("INTENT_ROUTING_ENABLED is true, but INTENT_PROVIDER is 'none'. Intent detection step will run but won't detect anything.");
    }
    if (isNaN(intentConfidenceThreshold) || intentConfidenceThreshold < 0 || intentConfidenceThreshold > 1) {
         warnings.push(`Invalid INTENT_CONFIDENCE_THRESHOLD value: "${process.env.INTENT_CONFIDENCE_THRESHOLD}". Must be a number between 0 and 1. Using default: ${intentConfidenceThreshold}`);
    }

    // Optional Infrastructure Warnings
    if (!redisUrl) warnings.push("REDIS_URL not set. Event deduplication and workspace caching via Redis disabled.");
    if (!databaseUrl) warnings.push("DATABASE_URL not set. Feedback and Thread Mapping disabled (will log to console).");

    // GitHub Feature Warnings/Errors
    if (!githubToken) {
        warnings.push("GITHUB_TOKEN not set. GitHub features (`gh:`, `/gh-*`) disabled.");
    } else {
        // Only warn about dependent configs if the token *is* set
        if (!githubWorkspaceSlug) {
            warnings.push("GITHUB_TOKEN set, but GITHUB_WORKSPACE_SLUG missing. Generic API commands (`gh: api`, `/gh-api`) may fail to generate API calls.");
        }
        if (!formatterWorkspaceSlug) {
            warnings.push("GITHUB_TOKEN set, but FORMATTER_WORKSPACE_SLUG missing. API responses from `gh: api`/`/gh-api` will be raw JSON.");
        }
    }

    // --- Output Results ---
    if (errors.length > 0) {
        console.error("❌ Critical configuration errors found! Process cannot start.");
        errors.forEach(err => console.error(`   - Missing required environment variable: ${err}`));
        process.exit(1); // Exit immediately if critical config is missing
    }
    if (warnings.length > 0) {
        console.warn("⚠️ Configuration warnings found:");
        warnings.forEach(warn => console.warn(`   - ${warn}`));
    }

    console.log("[Config] Configuration validation complete.");
}

// Automatically validate config when this module is loaded.
// validateConfig(); // Consider calling this explicitly in server.js instead if preferred.
