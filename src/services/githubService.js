
import { Octokit } from '@octokit/rest';
import fetch from 'node-fetch';
import { githubToken, GITHUB_OWNER } from '../config.js';

// --- Octokit Client Setup ---
export let octokit = null; // Initialize as null

if (githubToken) {
    try {
        octokit = new Octokit({
            auth: githubToken,
            userAgent: 'DeepOrbitSlackBot/v1.0', // Identify bot to GitHub
            // Consider adding throttling plugin if API limits become an issue
            // see: https://github.com/octokit/plugin-throttling.js
        });
        console.log("[GitHub Service] Octokit client initialized successfully.");

        // Optional: Test authentication on startup
        octokit.rest.users.getAuthenticated()
            .then(user => console.log(`[GitHub Service] Authenticated as GitHub user: ${user.data.login}`))
            .catch(err => console.error(`[GitHub Service] Octokit authentication test failed: ${err.message}. Check token permissions.`));

    } catch (error) {
        console.error("[GitHub Service] Failed to initialize Octokit instance:", error);
        octokit = null; // Ensure it's null on failure
    }
} else {
    console.warn("[GitHub Service] GITHUB_TOKEN not set. Octokit not initialized. GitHub features requiring authentication will fail.");
}

// --- GitHub API Functions ---

/**
 * Fetches the latest release for a given repository using the Octokit instance.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @returns {Promise<object | null>} Object with tagName, publishedAt, url, or null if not found/error.
 * @throws {Error} If Octokit is not initialized.
 */
export async function getLatestRelease(owner, repo) {
    if (!octokit) throw new Error("GitHub Service (Octokit) is not initialized. Cannot fetch release.");
    if (!owner || !repo) throw new Error("Owner and repository name are required to fetch latest release.");

    try {
        console.log(`[GitHub Service] Fetching latest release: ${owner}/${repo}`);
        const { data } = await octokit.rest.repos.getLatestRelease({ owner, repo });
        return {
            tagName: data.tag_name,
            publishedAt: data.published_at,
            url: data.html_url
        };
    } catch (error) {
        if (error.status === 404) {
            console.log(`[GitHub Service] No releases found for ${owner}/${repo}.`);
            return null; // Not an error, just no releases
        } else {
            console.error(`[GitHub Service] Error fetching latest release for ${owner}/${repo}:`, error.status, error.message);
            // Rethrow a more specific error or return null based on desired handling
            throw new Error(`Failed to fetch latest release for ${owner}/${repo}: ${error.message}`);
        }
    }
}

/**
 * Fetches details for a specific issue using the Octokit instance.
 * @param {number} issueNumber - The number of the issue.
 * @param {string} [owner=GITHUB_OWNER] - The repository owner.
 * @param {string} [repo='backlog'] - The repository name.
 * @returns {Promise<object|null>} - An object with issue details (title, body, url, state, labels, assignees, comments) or null if not found/error.
 * @throws {Error} If Octokit is not initialized or parameters are invalid.
 */
export async function getGithubIssueDetails(issueNumber, owner = GITHUB_OWNER, repo = 'backlog') {
     if (!octokit) throw new Error("GitHub Service (Octokit) is not initialized. Cannot fetch issue details.");
     if (!issueNumber || typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) {
         throw new Error(`Invalid issue number provided: ${issueNumber}`);
     }
     if (!owner || !repo) {
        throw new Error("Owner and repository name are required to fetch issue details.");
    }

    try {
        console.log(`[GitHub Service] Fetching issue details: ${owner}/${repo}#${issueNumber}`);
        const { data: issueData } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });

        console.log(`[GitHub Service] Fetching comments for issue ${owner}/${repo}#${issueNumber}`);
        let commentsData = [];
        try {
            const { data: rawComments } = await octokit.rest.issues.listComments({
                owner, repo, issue_number: issueNumber, per_page: 10 // Get up to 10 most recent
            });
            if (Array.isArray(rawComments)) { commentsData = rawComments; }
        } catch (commentError) {
            console.warn(`[GitHub Service] Failed fetch comments for issue ${issueNumber}: ${commentError.status}. Proceeding without comments.`);
        }

        const MAX_COMMENTS_TO_PROCESS = 10;
        const relevantComments = commentsData.slice(-MAX_COMMENTS_TO_PROCESS); // Ensure we process max 10

        return {
            title: issueData?.title || 'N/A',
            body: issueData?.body || '',
            url: issueData?.html_url || `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
            state: issueData?.state || 'unknown',
            labels: issueData?.labels?.map(l => typeof l === 'string' ? l : l.name) || [], // Handle different label formats
            assignees: issueData?.assignees?.map(a => a.login) || [],
            comments: relevantComments.map(comment => ({
                user: comment?.user?.login || 'unknown',
                body: comment?.body || '',
                createdAt: comment?.created_at
            }))
        };

    } catch (error) {
        if (error.status === 404) {
            console.log(`[GitHub Service] Issue ${owner}/${repo}#${issueNumber} not found.`);
            return null; // Return null specifically for 404
        } else {
             console.error(`[GitHub Service] Error fetching issue ${owner}/${repo}#${issueNumber}:`, error.status, error.message);
             throw new Error(`Failed to fetch issue details for ${owner}/${repo}#${issueNumber}: ${error.message}`);
        }
    }
}

/**
 * Fetches details needed for reviewing a Pull Request using the Octokit instance.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @param {number} prNumber - The pull request number.
 * @returns {Promise<object|null>} Object with PR details or null on error/not found.
 * @throws {Error} If Octokit is not initialized or parameters are invalid.
 */
export async function getPrDetailsForReview(owner, repo, prNumber) {
    if (!octokit) throw new Error("GitHub Service (Octokit) is not initialized. Cannot fetch PR details.");
     if (!owner || !repo || !prNumber || typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) {
        throw new Error(`Invalid owner, repo, or prNumber provided for PR review.`);
    }

    try {
        console.log(`[GitHub Service] Fetching details for PR ${owner}/${repo}#${prNumber}`);
        const [prResult, commentsResult, filesResult] = await Promise.allSettled([
            octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }),
            octokit.rest.issues.listComments({ owner, repo, issue_number: prNumber, per_page: 10 }),
            octokit.rest.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100 }) // Limit files fetched
        ]);

        if (prResult.status !== 'fulfilled') {
            if (prResult.reason?.status === 404) { console.log(`[GitHub Service] PR ${owner}/${repo}#${prNumber} not found.`); return null; }
            throw new Error(`Failed to fetch PR base details: ${prResult.reason?.message || prResult.reason}`);
        }
        const prData = prResult.value.data;

        const commentsData = (commentsResult.status === 'fulfilled' && Array.isArray(commentsResult.value.data)) ? commentsResult.value.data : [];
        if (commentsResult.status !== 'fulfilled') { console.warn(`[GitHub Service] Failed fetch comments PR ${prNumber}: ${commentsResult.reason?.status}`); }

        const filesData = (filesResult.status === 'fulfilled' && Array.isArray(filesResult.value.data)) ? filesResult.value.data : [];
        if (filesResult.status !== 'fulfilled') { console.warn(`[GitHub Service] Failed fetch files PR ${prNumber}: ${filesResult.reason?.status}`); }
        if (filesData.length >= 100) { console.warn(`[GitHub Service] Fetched max files (100) for PR ${prNumber}. Some files may be missing.`); }

        const MAX_COMMENTS_PR = 10;
        const relevantComments = commentsData.slice(-MAX_COMMENTS_PR);

        return {
            title: prData.title, body: prData.body, url: prData.html_url, state: prData.state, user: prData.user?.login,
            assignees: prData.assignees?.map(a => a.login) || [], labels: prData.labels?.map(l => typeof l === 'string' ? l : l.name) || [],
            comments: relevantComments.map(c => ({ user: c?.user?.login || '?', body: c?.body || '', createdAt: c?.created_at })),
            files: filesData.map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, patch: f.patch }))
        };
    } catch (error) { // Catch errors not handled by Promise.allSettled status checks
        console.error(`[GitHub Service] Error fetching PR details for ${owner}/${repo}#${prNumber}:`, error.message);
        // Avoid returning null for non-404 errors, let caller handle unexpected issues
        throw new Error(`Unexpected error fetching PR details for ${owner}/${repo}#${prNumber}: ${error.message}`);
    }
}


/**
 * Calls the GitHub API using fetch based on details provided (typically from an LLM).
 * Requires `githubToken` to be configured.
 * @param {object} apiDetails - Object containing endpoint, method, parameters, headers.
 * @param {string} apiDetails.endpoint - The relative API path (e.g., /repos/{owner}/{repo}/issues). Must start with /.
 * @param {string} [apiDetails.method='GET'] - HTTP method.
 * @param {object} [apiDetails.parameters={}] - Body parameters for POST/PATCH etc., or query params for GET.
 * @param {object} [apiDetails.headers={}] - Additional request headers.
 * @returns {Promise<object>} - The JSON response from the GitHub API, or status info for non-JSON responses.
 * @throws {Error} If token/endpoint is missing, or API request fails network/status code check.
 */
export async function callGithubApi(apiDetails) {
    if (!githubToken) throw new Error('GitHub token is missing. Cannot call generic API.');

    const { endpoint, method = 'GET', parameters = {}, headers = {} } = apiDetails;
    if (!endpoint || typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
        throw new Error(`GitHub API endpoint path must be provided and start with '/'. Received: ${endpoint}`);
    }

    const baseUrl = 'https://api.github.com';
    const url = new URL(baseUrl + endpoint);
    const upperMethod = method.toUpperCase();

    const requestHeaders = {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${githubToken}`, // Corrected token usage
        'Content-Type': 'application/json',
        'User-Agent': 'DeepOrbitSlackBot/v1.0',
        ...headers
    };

    const options = { method: upperMethod, headers: requestHeaders };

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(upperMethod)) {
        if (parameters && Object.keys(parameters).length > 0) {
            options.body = JSON.stringify(parameters);
        }
    } else if (upperMethod === 'GET' || upperMethod === 'HEAD') {
        Object.keys(parameters).forEach(key => {
            if (parameters[key] !== undefined && parameters[key] !== null) {
               url.searchParams.append(key, parameters[key]);
            }
        });
    }

    console.log(`[GitHub Service/Generic] Request: ${options.method} ${url.toString()}`);
    if (options.body) console.log(`[GitHub Service/Generic] Body: ${options.body.substring(0, 200)}...`);

    try {
        const response = await fetch(url.toString(), options);
        const contentType = response.headers.get('content-type');
        let responseBody;

        if (response.status === 204) { // Handle No Content specifically
             console.log(`[GitHub Service/Generic] Success (Status 204 No Content).`);
             return { status: 204, message: "No Content" };
        }

        try { // Try parsing based on content type
            if (contentType && contentType.includes('application/json')) {
                responseBody = await response.json();
            } else {
                responseBody = await response.text();
            }
        } catch (parseError) { // Handle cases where parsing fails even if content-type was misleading
             console.warn('[GitHub Service/Generic] Error parsing response body, falling back to text:', parseError);
             try {
                  responseBody = await response.text(); // Attempt to get text even after failed JSON parse
             } catch (textError) {
                  console.error('[GitHub Service/Generic] Failed to get text fallback after parse error:', textError);
                  responseBody = `(Failed to parse response body: ${parseError.message})`; // Provide error info
             }
        }

        if (!response.ok) {
            console.error(`[GitHub Service/Generic] API Error: ${response.status} ${response.statusText}`, responseBody);
            const errorMessage = responseBody?.message || (typeof responseBody === 'string' ? responseBody.substring(0, 100) : response.statusText);
            throw new Error(`GitHub API request failed: ${response.status} - ${errorMessage}`);
        }

        console.log(`[GitHub Service/Generic] Success (Status ${response.status}).`);
        return responseBody;

    } catch (error) {
        // Handle network errors or errors thrown above
        console.error('[GitHub Service/Generic] Network/processing error:', error);
        throw new Error(`Failed to call GitHub API (${options.method} ${endpoint}): ${error.message}`);
    }
}

console.log(`[GitHub Service] Initialized. Octokit ${octokit ? 'Enabled' : 'Disabled'}.`);
