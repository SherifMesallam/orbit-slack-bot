// src/services/dynamicKeywordMapService.js
// Service to dynamically generate and cache a workspace keyword map from GitHub repositories.

import axios from 'axios';
import {
    githubToken,
    GITHUB_ORG_FOR_KEYWORDS, // New: Org to fetch repos from
    KEYWORD_MAP_CACHE_KEY,     // New: Redis key for this cache
    KEYWORD_MAP_CACHE_TTL_SECONDS // New: TTL for this cache
} from '../config.js';
import { redisClient, isRedisReady } from './redisService.js';

// --- Caching Logic ---
let inMemoryKeywordMapCache = null;
let memoryCacheTimestamp = 0;

/**
 * Initializes the keyword map service, primarily by flushing any stale cache on startup.
 */
export async function initializeKeywordMapService() {
    console.log("[KeywordMap Service] Initializing and flushing caches...");
    // Reset in-memory cache
    inMemoryKeywordMapCache = null;
    memoryCacheTimestamp = 0;

    // Clear Redis cache if available
    if (isRedisReady && redisClient && KEYWORD_MAP_CACHE_KEY) {
        try {
            const result = await redisClient.del(KEYWORD_MAP_CACHE_KEY);
            if (result > 0) {
                console.log(`[KeywordMap Service] Flushed Redis cache for key: ${KEYWORD_MAP_CACHE_KEY}`);
            } else {
                console.log(`[KeywordMap Service] No Redis cache to flush for key: ${KEYWORD_MAP_CACHE_KEY} (key not found).`);
            }
        } catch (err) {
            console.error("[KeywordMap Service/Redis Error] Failed to flush keyword map Redis cache on startup:", err);
        }
    }
    console.log("[KeywordMap Service] Cache flushing complete.");
}

// --- Helper Functions (adapted from user script and new additions) ---

function cleanDescription(description) {
    if (!description) return '';
    // Remove special characters, keep alphanumeric and spaces
    return description.toLowerCase()
        .replace(/[^\\w\\s]/g, '')
        .replace(/\\s+/g, ' ')
        .trim();
}

/**
 * Fetches the content of specified files from the root of a repository.
 * Tries files in order and returns the content of the first one found.
 * @param {string} token - GitHub token.
 * @param {string} owner - Repository owner (organization or user).
 * @param {string} repoName - Repository name.
 * @param {string[]} filesToTry - Array of filenames to look for in the root.
 * @returns {Promise<string|null>} Decoded file content as a string, or null if not found or error.
 */
async function getRepoRootFileContent(token, owner, repoName, filesToTry = ['README.md', 'readme.md', 'README.txt', 'readme.txt']) {
    if (!token || !owner || !repoName) {
        console.error("[KeywordMap Service/FileContent] Missing token, owner, or repoName.");
        return null;
    }

    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };

    try {
        // First, list root contents to find the exact filename and its download_url or content API URL
        const rootContentsUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/`;
        const rootResponse = await axios.get(rootContentsUrl, { headers, timeout: 10000 });

        let targetFileMeta = null;
        if (rootResponse.data && Array.isArray(rootResponse.data)) {
            for (const fileName of filesToTry) {
                targetFileMeta = rootResponse.data.find(file => file.name.toLowerCase() === fileName.toLowerCase() && file.type === 'file');
                if (targetFileMeta) break;
            }
        }

        if (!targetFileMeta || !targetFileMeta.url) { // .url is the API URL for the content
            // console.log(`[KeywordMap Service/FileContent] None of the target files found in root of ${owner}/${repoName}`);\
            return null;
        }

        // Fetch the specific file content using its API URL
        const fileResponse = await axios.get(targetFileMeta.url, { headers, timeout: 15000 });

        if (fileResponse.data && fileResponse.data.content) {
            if (fileResponse.data.encoding === 'base64') {
                return Buffer.from(fileResponse.data.content, 'base64').toString('utf-8');
            } else {
                // Should ideally not happen for common text files, but handle if content is plain text
                return fileResponse.data.content;
            }
        } else {
            console.warn(`[KeywordMap Service/FileContent] No content found for ${targetFileMeta.name} in ${owner}/${repoName}`);
            return null;
        }
    } catch (error) {
        // console.error(`[KeywordMap Service/FileContent] Error fetching file content for ${owner}/${repoName}:`, error.message);\
        // Be less verbose for 404s which are expected if a README doesn't exist
        if (error.response && error.response.status === 404) {
            // console.log(`[KeywordMap Service/FileContent] File/Repo not found (404) for ${owner}/${repoName}`);\
        } else if (error.response) { // Log other API errors more verbosely
            console.error(`[KeywordMap Service/FileContent] API Error ${error.response.status} for ${owner}/${repoName}:`, error.response.data?.message || error.message);
        } else {
            console.error(`[KeywordMap Service/FileContent] Network/Request error for ${owner}/${repoName}:`, error.message);
        }
        return null;
    }
}

/**
 * Extracts two-word combinations (bigrams) from a given text.
 * @param {string} text - The input text.
 * @returns {string[]} An array of unique two-word phrases.
 */
function extractTwoWordCombinations(text) {
    if (!text || typeof text !== 'string') return [];
    
    // Use the existing cleanDescription for consistent text cleaning
    const cleanedText = cleanDescription(text);
    const words = cleanedText.split(' ').filter(word => word.length > 0); // Filter out empty strings from multiple spaces

    const twoWordPhrases = [];
    if (words.length > 1) {
        for (let i = 0; i < words.length - 1; i++) {
            // Basic check for word substance (e.g., length > 2 to avoid short/common words dominating)
            // This can be made more sophisticated with stop word lists if needed.
            if (words[i].length > 2 && words[i+1].length > 2) {
                twoWordPhrases.push(`${words[i]} ${words[i+1]}`);
            }
        }
    }
    return [...new Set(twoWordPhrases)]; // Deduplicate and return
}

/**
 * Generates keywords for a given repository based on its name and root file content.
 * @param {string} token - GitHub token.
 * @param {string} owner - Repository owner.
 * @param {string} repoName - Repository name.
 * @param {Set<string>} allRepoNamesSet - A Set of all known repository names in the org (lowercase).
 * @returns {Promise<string[]>} A promise that resolves to an array of up to 5 keywords.
 */
async function generateKeywords(token, owner, repoName, allRepoNamesSet = new Set()) {
    const currentRepoNameLower = repoName.toLowerCase();
    let keywords = [];

    // 1. Add the full repository name
    if (currentRepoNameLower) { // Ensure repoName is not empty
        keywords.push(currentRepoNameLower);
    }

    // 2. Add repository name sans "gravityforms" (if applicable)
    if (currentRepoNameLower && currentRepoNameLower.startsWith('gravityforms')) {
        const simplifiedName = currentRepoNameLower.replace(/^gravityforms/, '');
        if (simplifiedName && simplifiedName !== currentRepoNameLower && !keywords.includes(simplifiedName)) {
            keywords.push(simplifiedName);
        }
    }
    
    // 3. Keywords from root files (e.g., README)
    const fileContent = await getRepoRootFileContent(token, owner, repoName);
    if (fileContent) {
        const twoWordPhrases = extractTwoWordCombinations(fileContent);
        twoWordPhrases.forEach(phrase => {
            if (!keywords.includes(phrase)) { // Avoid duplicates from this step
                keywords.push(phrase);
            }
        });
    }

    // Initial deduplication before filtering against other repo names
    keywords = [...new Set(keywords)];

    // Filter out keywords that are names of OTHER existing repos.
    // The current repo's own name (or its simplified version) should be preserved if they were added.
    const filteredKeywords = keywords.filter(kw => {
        if (kw === currentRepoNameLower) return true; // Always keep the repo's own full name
        if (currentRepoNameLower.startsWith('gravityforms') && kw === currentRepoNameLower.replace(/^gravityforms/, '')) {
            return true; // Always keep the repo's own simplified name if it was generated
        }
        return !allRepoNamesSet.has(kw); // Remove if it's another repo's name
    });
    
    // Deduplicate again after filtering (in case filtering changed things, though less likely here)
    let finalKeywords = [...new Set(filteredKeywords)];

    // Prioritize own name / simplified name to be at the top for slicing
    const simplifiedNameIfApplicable = (currentRepoNameLower && currentRepoNameLower.startsWith('gravityforms')) ? 
                                       currentRepoNameLower.replace(/^gravityforms/, '') : null;

    finalKeywords.sort((a, b) => {
        let scoreA = 0;
        let scoreB = 0;

        if (a === currentRepoNameLower) scoreA = 100;
        if (b === currentRepoNameLower) scoreB = 100;
        if (simplifiedNameIfApplicable) {
            if (a === simplifiedNameIfApplicable) scoreA = Math.max(scoreA, 90);
            if (b === simplifiedNameIfApplicable) scoreB = Math.max(scoreB, 90);
        }
        // Add more scoring based on length or other factors if needed, e.g., prefer longer phrases from README
        if (scoreA !== scoreB) return scoreB - scoreA; // Higher score comes first
        return 0; // Keep original relative order for others of same score (effectively initial order)
    });

    return finalKeywords.slice(0, 5); // Return up to 5 keywords
}

async function fetchAndGenerateMapFromGitHub(token, org) {
    if (!token || !org) {
        console.error("[KeywordMap Service] GitHub token or organization not configured.");
        return null;
    }

    const headers = {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json'
    };
    
    let allFetchedRepos = [];
    let page = 1;
    const perPage = 100; // Max allowed by GitHub API
    
    console.log(`[KeywordMap Service] Fetching repositories for org: ${org}`);
    try {
        while (true) {
            const response = await axios.get(`https://api.github.com/orgs/${org}/repos`, {
                headers,
                params: { type: 'all', per_page: perPage, page }
            });
            
            if (response.data && response.data.length > 0) {
                allFetchedRepos = allFetchedRepos.concat(response.data);
            }
            
            if (!response.data || response.data.length < perPage) {
                break; // No more pages
            }
            page++;
        }
        
        console.log(`[KeywordMap Service] Fetched ${allFetchedRepos.length} repositories for org: ${org}.`);

        // Create a Set of all repository names for efficient lookup
        const allRepoNamesSet = new Set(allFetchedRepos.map(repo => repo.name.toLowerCase()));

        const keywordPromises = allFetchedRepos.map(repo => {
            const repoNameKey = repo.name;
            const owner = GITHUB_ORG_FOR_KEYWORDS; // Assuming GITHUB_ORG_FOR_KEYWORDS is the owner\
            if (repoNameKey) {
                return generateKeywords(githubToken, owner, repoNameKey, allRepoNamesSet)
                    .then(keywords => ({ repoName: repoNameKey, keywords }));
            }
            return Promise.resolve(null); // Resolve null for repos without a name to keep array structure for Promise.all\
        });

        const results = await Promise.all(keywordPromises);
        
        const workspaceKeywordMap = {};
        results.forEach(result => {
            if (result && result.repoName && result.keywords) {
                workspaceKeywordMap[result.repoName] = result.keywords;
            }
        });
                
        console.log(`[KeywordMap Service] Generated keyword map with ${Object.keys(workspaceKeywordMap).length} entries.`);
        return workspaceKeywordMap;

    } catch (error) {
        console.error(`[KeywordMap Service] Error fetching repositories for org ${org}:`, error.message);
        if (error.response) {
            console.error('GitHub API Error Response:', error.response.status, error.response.data);
        }
        return null; // Return null on error
    }
}

/**
 * Fetches the dynamic workspace keyword map, using cache if available.
 * @param {boolean} [forceRefresh=false] - If true, bypasses cache and fetches fresh from GitHub.
 * @returns {Promise<object | null>} The workspace keyword map or null on failure.
 */
export async function getDynamicWorkspaceKeywordMap(forceRefresh = false) {
    const now = Date.now();
    const cacheTTLms = (KEYWORD_MAP_CACHE_TTL_SECONDS || 3600) * 1000; // Default to 1 hour

    // 1. Check in-memory cache
    if (!forceRefresh && inMemoryKeywordMapCache && (now - memoryCacheTimestamp < cacheTTLms)) {
        console.log("[KeywordMap Service] In-memory cache HIT.");
        return inMemoryKeywordMapCache;
    }

    // 2. Check Redis cache
    if (!forceRefresh && isRedisReady && redisClient && KEYWORD_MAP_CACHE_KEY) {
        try {
            const cachedData = await redisClient.get(KEYWORD_MAP_CACHE_KEY);
            if (cachedData) {
                const map = JSON.parse(cachedData);
                console.log("[KeywordMap Service] Redis cache HIT.");
                inMemoryKeywordMapCache = map; // Update memory cache
                memoryCacheTimestamp = now;
                return map;
            }
            console.log("[KeywordMap Service] Redis cache MISS.");
        } catch (err) {
            console.error("[KeywordMap Service/Redis Error] Get keyword map cache failed:", err);
        }
    }

    // 3. Fetch from GitHub API
    console.log("[KeywordMap Service] Fetching fresh keyword map from GitHub.");
    const newMap = await fetchAndGenerateMapFromGitHub(githubToken, GITHUB_ORG_FOR_KEYWORDS);

    if (newMap) {
        // Log the newly generated map when fetched fresh from GitHub
        console.log("[KeywordMap Service] Successfully fetched and generated new keyword map:", JSON.stringify(newMap, null, 2)); // Pretty print JSON

        inMemoryKeywordMapCache = newMap; // Update memory cache
        memoryCacheTimestamp = now;

        if (isRedisReady && redisClient && KEYWORD_MAP_CACHE_KEY) {
            try {
                await redisClient.set(KEYWORD_MAP_CACHE_KEY, JSON.stringify(newMap), {
                    EX: KEYWORD_MAP_CACHE_TTL_SECONDS || 3600
                });
                console.log("[KeywordMap Service] Updated Redis cache with new keyword map.");
            } catch (cacheErr) {
                console.error("[KeywordMap Service/Redis Error] Set keyword map cache failed:", cacheErr);
            }
        }
        return newMap;
    } else {
        console.error("[KeywordMap Service] Failed to fetch or generate new keyword map from GitHub.");
        // If fetching fails, try to return stale cache if available and not forced refresh
        if (inMemoryKeywordMapCache) {
            console.warn("[KeywordMap Service] Returning stale in-memory cache due to fetch failure.");
            return inMemoryKeywordMapCache;
        }
        return null; // Ultimate failure
    }
}

console.log("[Dynamic KeywordMap Service] Initialized.");
