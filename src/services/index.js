
// src/services/index.js
// Main entry point for exporting service clients and functions.

// Export items from redisService
export { redisClient, isRedisReady, isDuplicateRedis } from './redisService.js';

// Export items from dbService
export { dbPool, storeFeedback, getAnythingLLMThreadMapping, storeAnythingLLMThreadMapping } from './dbService.js';

// Export items from githubService
export { octokit, getLatestRelease, getPrDetailsForReview, getGithubIssueDetails, callGithubApi } from './githubService.js';

// Export items from llmService
export { queryLlm, createNewAnythingLLMThread, getWorkspaces, determineInitialWorkspace } from './llmService.js';

// Export items from slackService
export { slackClient, slackEvents, postSlackMessage, updateSlackMessage, deleteSlackMessage, fetchSlackHistory } from './slackService.js';

// Export items from workspaceService (if created separately)
// export { determineWorkspace, getWorkspaces } from './workspaceService.js'; // Example if moved

// Export shutdown function
export { shutdownServices } from './shutdown.js';

console.log("[Services Index] Service functions exported.");
