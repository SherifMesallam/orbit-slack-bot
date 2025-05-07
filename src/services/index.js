// src/services/index.js
// Main entry point for exporting service clients and functions.

// Export items from redisService
export { redisClient, isRedisReady, isDuplicateRedis } from './redisService.js';

// Export items from dbService
export { dbPool, storeFeedback, getAnythingLLMThreadMapping, storeAnythingLLMThreadMapping } from './dbService.js';

// Export items from githubService
export { octokit, getLatestRelease, getPrDetailsForReview, getGithubIssueDetails, callGithubApi } from './githubService.js';

// Export items from llmService (Refactored - only thread/query)
export { queryLlm, createNewAnythingLLMThread } from './llmService.js';

// Export items from slackService
export { slackClient, slackEvents, postSlackMessage, updateSlackMessage, deleteSlackMessage, fetchSlackHistory } from './slackService.js';

// Export items from workspaceService (New)
export { determineWorkspace, getWorkspaces } from './workspaceService.js';

// Export shutdown function
export { shutdownServices } from './shutdown.js';

// Export items from intentDetectionService (from src/ai)
// Ensure the path is correct relative to this index.js file
export { detectIntentAndWorkspace } from '../ai/intentDetectionService.js';

// Export items from dynamicKeywordMapService (New)
export { getDynamicWorkspaceKeywordMap } from './dynamicKeywordMapService.js';
export { initializeKeywordMapService } from './dynamicKeywordMapService.js';

console.log("[Services Index] Service functions exported.");
