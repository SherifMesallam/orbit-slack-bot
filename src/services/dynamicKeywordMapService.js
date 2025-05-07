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

// --- Helper Functions (adapted from user script) ---

function cleanDescription(description) {
    if (!description) return '';
    // Remove special characters, keep alphanumeric and spaces
    return description.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function generateKeywords(repoName, description, allRepoNamesSet = new Set()) {
    const currentRepoNameLower = repoName.toLowerCase();
    const initialKeywords = [currentRepoNameLower];
    
    // Split repo name by common separators
    const nameParts = currentRepoNameLower.split(/[-_]/);
    nameParts.forEach(part => {
        if (part && !initialKeywords.includes(part)) {
            initialKeywords.push(part);
        }
    });
    
    // Process description
    if (description) {
        const cleanedDesc = cleanDescription(description);
        const descWords = cleanedDesc.split(' ');
        
        // Add relevant words from description
        descWords.forEach(word => {
            if (!initialKeywords.includes(word) && word.length > 3) { // Only add words longer than 3 chars
                initialKeywords.push(word);
            }
        });
        
        // Generate compound phrases from description (2-word phrases)
        if (descWords.length > 1) {
            for (let i = 0; i < descWords.length - 1; i++) {
                const phrase = `${descWords[i]} ${descWords[i+1]}`;
                if (!initialKeywords.includes(phrase)) {
                    initialKeywords.push(phrase);
                }
            }
        }
    }
    
    // Filter out keywords that are names of other existing repos
    const filteredKeywords = initialKeywords.filter(keyword => {
        // Keep the keyword if it's the current repo's own name OR if it's not found in the set of all other repo names.
        return keyword === currentRepoNameLower || !allRepoNamesSet.has(keyword);
    });
    
    // Remove duplicates while preserving order and limit to first 4
    // Ensure the repo's own name is always the first keyword if still present after filtering, then take top N.
    // However, the original slice(0,4) was simple. Let's stick to that simplicity for now after filtering.
    // If currentRepoNameLower was filtered out (e.g. if it matched another repo name and wasn't caught by the OR condition,
    // which is unlikely but for safety), we might lose it. The filter logic should prevent this.
    let finalKeywords = [...new Set(filteredKeywords)];
    
    // Ensure the repo's own name is prioritized if it exists, then take up to 4 unique keywords.
    // This is a bit more robust to ensure the primary repo name isn't accidentally removed by the slice(0,4)
    // if other valid keywords push it out after deduplication from the filtered list.
    const ownNameIndex = finalKeywords.indexOf(currentRepoNameLower);
    if (ownNameIndex > 0) { // If currentRepoNameLower exists but is not at the start, move it to start.
        finalKeywords.splice(ownNameIndex, 1); // Remove it from its current position
        finalKeywords.unshift(currentRepoNameLower); // Add it to the beginning
    } else if (ownNameIndex === -1 && !allRepoNamesSet.has(currentRepoNameLower)) {
        // This case implies currentRepoNameLower was filtered out *and* it's not another repo's name.
        // This shouldn't happen with the current filter `keyword === currentRepoNameLower || !allRepoNamesSet.has(keyword)`
        // but as a safeguard, re-add it if it was the keyword being processed.
        // However, the problem statement implies currentRepoNameLower should not be filtered if it's for THIS repo.
        // The filter `keyword === currentRepoNameLower || !allRepoNamesSet.has(keyword)` correctly handles this:
        // - If keyword is `currentRepoNameLower`, it's kept.
        // - If keyword is NOT `currentRepoNameLower` AND it IS IN `allRepoNamesSet`, it's removed.
        // This means currentRepoNameLower itself will not be removed by the filter unless it was NOT currentRepoNameLower,
        // which is a contradiction for that specific keyword. So currentRepoNameLower is safe.
    }

    return finalKeywords.slice(0, 4);
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
                params: { type: 'public', per_page: perPage, page } // Fetching only public repos, adjust if needed
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

        const workspaceKeywordMap = {};
        allFetchedRepos.forEach(repo => {
            const repoNameKey = repo.name; 
            const description = repo.description || '';
            if (repoNameKey) {
                // Pass allRepoNamesSet to generateKeywords
                workspaceKeywordMap[repoNameKey] = generateKeywords(repoNameKey, description, allRepoNamesSet);
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
