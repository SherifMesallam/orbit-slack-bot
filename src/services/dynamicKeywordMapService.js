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

// --- Helper Functions (adapted from user script) ---

function cleanDescription(description) {
    if (!description) return '';
    // Remove special characters, keep alphanumeric and spaces
    return description.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function generateKeywords(repoName, description) {
    const keywords = [repoName.toLowerCase()];
    
    // Split repo name by common separators
    const nameParts = repoName.toLowerCase().split(/[-_]/);
    nameParts.forEach(part => {
        if (part && !keywords.includes(part)) {
            keywords.push(part);
        }
    });
    
    // Process description
    if (description) {
        const cleanedDesc = cleanDescription(description);
        const descWords = cleanedDesc.split(' ');
        
        // Add relevant words from description
        descWords.forEach(word => {
            if (!keywords.includes(word) && word.length > 3) { // Only add words longer than 3 chars
                keywords.push(word);
            }
        });
        
        // Generate compound phrases from description (2-word phrases)
        if (descWords.length > 1) {
            for (let i = 0; i < descWords.length - 1; i++) {
                const phrase = `${descWords[i]} ${descWords[i+1]}`;
                if (!keywords.includes(phrase)) {
                    keywords.push(phrase);
                }
            }
        }
    }
    
    // Remove duplicates while preserving order and limit to first 4
    return [...new Set(keywords)].slice(0, 4);
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
    
    let repos = [];
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
                repos = repos.concat(response.data);
            }
            
            if (!response.data || response.data.length < perPage) {
                break; // No more pages
            }
            page++;
        }
        
        console.log(`[KeywordMap Service] Fetched ${repos.length} repositories for org: ${org}.`);
        const workspaceKeywordMap = {};
        repos.forEach(repo => {
            // We'll use repo.name as the key, assuming it maps to a workspace slug or can be resolved.
            // If workspace slugs are different from repo names, this logic might need adjustment
            // or the keys of this map should be the actual workspace slugs.
            // For now, repo.name is used as the key as per the script's structure.
            const repoNameKey = repo.name; 
            const description = repo.description || '';
            if (repoNameKey) {
                workspaceKeywordMap[repoNameKey] = generateKeywords(repoNameKey, description);
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

// --- Caching Logic ---
let inMemoryKeywordMapCache = null;
let memoryCacheTimestamp = 0;

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