// src/handlers/commandHandler.js
// Contains handlers for specific commands (`gh:`, `/gh-*`) identified by routers.

import { getLatestRelease, getPrDetailsForReview, getGithubIssueDetails, callGithubApi, octokit as octokitInstance } from '../services/githubService.js'; // Import octokit instance
import { markdownToRichTextBlock, extractTextAndCode, splitMessageIntoChunks } from '../utils/formattingService.js';
import { queryLlm } from '../services/llmService.js';
import { githubToken, GITHUB_OWNER, githubWorkspaceSlug, formatterWorkspaceSlug } from '../config.js';
import { slackClient } from '../services/slackService.js'; // Import for posting messages if needed directly

/**
 * =============================================================================
 *                            HELPER FUNCTIONS
 * =============================================================================
 */

/**
 * Helper function to safely update or delete the thinking message.
 * @param {Promise<string | null>} thinkingMessagePromise - Promise resolving to the message TS.
 * @param {object} slack - Slack WebClient instance.
 * @param {string} channel - Channel ID.
 * @param {object | null} [updateArgs=null] - Arguments for chat.update (text, blocks), or null/undefined to delete.
 */
async function updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, updateArgs = null) {
    // Await the promise *only when needed*
    let ts = null;
    try {
        ts = await thinkingMessagePromise; // Get the TS
        if (!ts) {
            // console.warn("[CH Util] No thinking message TS resolved."); // Less noisy
            return;
        }
        if (updateArgs) {
            await slack.chat.update({ channel, ts, ...updateArgs });
             console.log(`[CH Util] Updated thinking message ${ts}.`);
        } else {
            await slack.chat.delete({ channel, ts });
             console.log(`[CH Util] Deleted thinking message ${ts}.`);
        }
    } catch (error) {
        console.warn(`[CH Util] Failed to ${updateArgs ? 'update' : 'delete'} thinking message ${ts || '?'}:`, error.data?.error || error.message);
    }
}

/**
 * Resolves a repository identifier (name, abbreviation, owner/repo) into owner and repo.
 * @param {string} identifier - The input identifier string.
 * @returns {{owner: string, repo: string} | null} Object with owner/repo or null if unresolvable.
 */
function resolveRepoIdentifier(identifier) {
    if (!identifier) return null;

    let owner = GITHUB_OWNER; // Default owner
    let repo = null;
    const lowerIdentifier = identifier.toLowerCase().trim();
    const abbreviations = { 'gf':'gravityforms', 'core':'gravityforms', 'ppcp':'gravityformsppcp', 'paypal':'gravityformsppcp', 'paypalcheckout':'gravityformsppcp', 'stripe':'gravityformsstripe', 'authorize.net':'gravityformsauthorizenet', 'authnet':'gravityformsauthorizenet', 'user registration':'gravityformsuserregistration', 'ur':'gravityformsuserregistration', 'gravityflow':'gravityflow', 'flow':'gravityflow' };

    if (abbreviations[lowerIdentifier]) {
       repo = abbreviations[lowerIdentifier];
       if (repo === 'gravityflow') owner = 'gravityflow'; // Special case owner
       else owner = GITHUB_OWNER; // Reset to default
    } else if (lowerIdentifier.includes('/')) {
        const parts = lowerIdentifier.split('/');
        if (parts.length === 2 && parts[0] && parts[1]) { owner = parts[0]; repo = parts[1]; }
    } else {
        repo = lowerIdentifier.startsWith('gravityforms') ? lowerIdentifier : `gravityforms${lowerIdentifier}`;
        owner = GITHUB_OWNER;
    }

    if (repo) {
        console.log(`[CH Util] Resolved repo identifier '${identifier}' to: ${owner}/${repo}`);
        return { owner, repo };
    } else {
        console.warn(`[CH Util] Could not resolve repository identifier: ${identifier}`);
        return null;
    }
}


/**
 * =============================================================================
 *                         SLASH COMMAND DISPATCHER
 * =============================================================================
 */

/**
 * Entry point for handling Slash Commands dispatched from the interaction handler.
 * Parses the command text and calls the appropriate specific command handler.
 * @param {object} payload - The full payload object from the Slack Slash Command request.
 * @param {object} slack - The initialized Slack WebClient instance.
 * @param {object} octokit - The initialized Octokit instance.
 */
export async function handleSlashCommand(payload, slack, octokit) {
    const { command, text, user_id, channel_id, response_url } = payload;
    const commandArgs = text.trim(); // Text after the command itself

    // Create a resolved promise with the TS of the initial "Processing..." message
    // posted by the interaction handler/dispatcher.
    let thinkingMessageTs = null;
    let thinkingPromise = null;
    try {
        // NOTE: This assumes the Interaction dispatcher ALREADY posted a thinking msg
        // If not, this handler needs to post its own. For consistency, assume
        // the dispatcher posts it and we just need the promise wrapper.
        // We don't have the TS here, so we'll have to post a NEW one if needed inside handlers.
        // Let's create a *placeholder* promise that resolves to null initially.
        // Handlers MUST check if the promise resolved to a valid TS before updating/deleting.
         thinkingPromise = Promise.resolve(null); // Placeholder
         console.warn("[Slash Command Handler] Cannot access initial thinking message TS from dispatcher easily. Handlers will post new status messages.");
         // Alternative: Post a *new* thinking message here? Seems redundant if dispatcher did.
         // Let's proceed assuming handlers will post their own status.

    } catch (error) {
        console.error(`[Slash Command Handler] Error posting initial message for ${command}:`, error);
        // If we can't even post the initial message, report via response_url
        await axios.post(response_url, { replace_original: "false", text: `❌ Error starting command processing.` }).catch(()=>{});
        return;
    }

     // --- Check GitHub Token ---
     if (!githubToken) {
         console.warn("[Slash Command Handler] GitHub command received, but GITHUB_TOKEN is missing.");
         // Use response_url to notify user since we already ACKed
         await axios.post(response_url, { replace_original: "false", text: `❌ GitHub features are disabled (missing configuration).` }).catch(()=>{});
         return;
     }
     if (!octokit) { // Also check if Octokit instance is valid
          console.warn("[Slash Command Handler] GitHub command received, but Octokit failed to initialize.");
         await axios.post(response_url, { replace_original: "false", text: `❌ GitHub client failed to initialize (check token/config).` }).catch(()=>{});
         return;
     }
     // --- End Check ---


    // --- Route based on command name ---
    try {
        let commandHandled = false; // Track if any handler runs
        switch (command) {
            case '/gh-latest': {
                const repoIdentifier = commandArgs;
                if (repoIdentifier) {
                    // Note: Slash commands don't have inherent thread context (replyTarget = channel_id)
                    commandHandled = await handleReleaseInfoCommand(repoIdentifier, channel_id, slack, octokit, thinkingPromise, channel_id);
                } else {
                    await slack.chat.postMessage({ channel: channel_id, text: `❌ Usage: \`/gh-latest <repo>\`` });
                    commandHandled = true; // Error reported
                }
                break;
            }
            case '/gh-review': {
                const reviewPattern = /([\w.-]+)\/([\w.-]+)#(\d+)\s+#([\w-]+)/i;
                const match = commandArgs.match(reviewPattern);
                if (match) {
                    const [_, owner, repo, pr_number, workspace_slug] = match;
                    commandHandled = await handlePrReviewCommand(owner, repo, parseInt(pr_number), workspace_slug, channel_id, channel_id, slack, octokit, thinkingPromise);
                } else {
                    await slack.chat.postMessage({ channel: channel_id, text: `❌ Usage: \`/gh-review owner/repo#number #workspace\`` });
                    commandHandled = true; // Error reported
                }
                break;
            }
            case '/gh-analyze': {
                const issuePattern = /(?:([\w.-]+)\/([\w.-]+))?#(\d+)\s+#([\w-]+)(?:\s+(.+))?/i;
                const match = commandArgs.match(issuePattern);
                if (match) {
                    const [_, owner = GITHUB_OWNER, repo = 'backlog', issue_number, workspace_slug, user_prompt] = match;
                    // Pass explicit workspace, null for thread context
                    commandHandled = await handleIssueAnalysisCommand( owner, repo, parseInt(issue_number), user_prompt || null, channel_id, channel_id, slack, octokit, thinkingPromise, workspace_slug, null );
                } else {
                    await slack.chat.postMessage({ channel: channel_id, text: `❌ Usage: \`/gh-analyze [owner/repo]#number #workspace [prompt]\`` });
                    commandHandled = true; // Error reported
                }
                break;
            }
             case '/gh-api': {
                const apiQuery = commandArgs;
                if (apiQuery) {
                    commandHandled = await handleGithubApiCommand(apiQuery, channel_id, channel_id, slack, thinkingPromise, githubWorkspaceSlug, formatterWorkspaceSlug);
                } else {
                    await slack.chat.postMessage({ channel: channel_id, text: `❌ Usage: \`/gh-api <your query>\`` });
                    commandHandled = true; // Error reported
                }
                break;
            }
            default:
                console.warn(`[Slash Command Handler] Unknown command: ${command}`);
                 await slack.chat.postMessage({ channel: channel_id, text: `❓ Unknown command: \`${command}\`.` });
                 commandHandled = true; // Error reported
        }
         // If somehow no handler ran for a known command structure
         if (!commandHandled && ['/gh-latest', '/gh-review', '/gh-analyze', '/gh-api'].includes(command)) {
            console.warn(`[Slash Command Handler] Handler for ${command} did not complete as expected.`);
            await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, null); // Attempt cleanup
         }
    } catch (error) {
         console.error(`[Slash Command Handler] Error executing handler for ${command}:`, error);
         // Report error via response_url as fallback
         await axios.post(response_url, { replace_original: "false", text: `❌ Error executing command ${command}: ${error.message}` }).catch(()=>{});
          await updateOrDeleteThinkingMessage(thinkingPromise, slack, channel_id, null); // Cleanup thinking message on error
    }
}


/**
 * =============================================================================
 *                         SPECIFIC COMMAND HANDLERS
 * =============================================================================
 */

/**
 * Handles the '#delete_last_message' command (Invoked directly from message router).
 */
export async function handleDeleteLastMessageCommand(channel, replyTarget, botUserId, slack) {
    // ... (Implementation is complete and correct in previous response) ...
    console.log(`[CH - Delete] Handling #delete_last_message in channel ${channel}`);
    try {
        const historyResult = await slack.conversations.replies({ channel, ts: replyTarget, limit: 20 });
         if (historyResult.ok && historyResult.messages) {
             const lastBotMessage = historyResult.messages.slice().reverse().find(msg => msg.user === botUserId && !msg.text?.includes('✅') && !msg.text?.includes('❌'));
             if (lastBotMessage) {
                 try {
                     await slack.chat.delete({ channel, ts: lastBotMessage.ts });
                     console.log(`[CH - Delete] Deleted message ${lastBotMessage.ts}`);
                     const confirmMsg = await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "✅ Last message deleted." });
                     setTimeout(async () => { try { await slack.chat.delete({ channel, ts: confirmMsg.ts }); } catch (e) {} }, 5000);
                 } catch (deleteError) { console.error('[CH - Delete] Error deleting:', deleteError.data?.error); await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "❌ Couldn't delete message." }).catch(() => {}); }
             } else { await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "❌ Couldn't find my last message." }).catch(() => {}); }
         } else { throw new Error(`Failed fetch history: ${historyResult.error}`); }
    } catch (error) { console.error('[CH - Delete] Error:', error); await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "❌ Error during delete." }).catch(() => {}); }
    return true; // Indicate handled
}

/**
 * Handles the 'gh: latest' command / '/gh-latest' slash command.
 * @param {string} repoIdentifier - Repo name, abbreviation, or owner/repo.
 * @param {string} replyTarget - Channel ID (for slash command) or Thread TS (for message command).
 * @param {object} slack - Slack WebClient.
 * @param {object} octokit - Octokit instance.
 * @param {Promise<string | null>} thinkingMessagePromise - Promise for the thinking message TS.
 * @param {string} channel - Channel ID where command was invoked.
 * @returns {Promise<boolean>} True if handled.
 */
export async function handleReleaseInfoCommand(repoIdentifier, replyTarget, slack, octokit, thinkingMessagePromise, channel) {
    console.log(`[CH - Latest] Handling for identifier: ${repoIdentifier}`);
    const resolved = resolveRepoIdentifier(repoIdentifier); // Use helper
    if (!resolved) {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Couldn't resolve repo '${repoIdentifier}'.` });
        return true;
    }
    const { owner, repo } = resolved;

    if (!githubToken || !octokit) {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ GitHub not configured.` });
        return true;
    }

    try {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:satellite: Fetching release ${owner}/${repo}...` });
        const releaseInfo = await getLatestRelease(owner, repo); // Uses service function
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, null); // Delete before post

        if (releaseInfo) {
            const publishedDate = new Date(releaseInfo.publishedAt).toLocaleDateString();
            const messageText = `Latest release *${owner}/${repo}*: <${releaseInfo.url}|*${releaseInfo.tagName}*> (Published ${publishedDate}).`;
            const block = markdownToRichTextBlock(messageText);
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `Release ${owner}/${repo}: ${releaseInfo.tagName}`, blocks: block ? [block] : undefined });
        } else {
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `No releases found for ${owner}/${repo}.` });
        }
        return true;
    } catch (error) {
        console.error(`[CH - Release] Error for ${owner}/${repo}:`, error);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Error fetching release: ${error.message}` });
        return true;
    }
}


/**
 * Handles the 'gh: review pr' command / '/gh-review' slash command.
 * @param {string} owner - Repo owner.
 * @param {string} repo - Repo name.
 * @param {number} prNumber - PR number.
 * @param {string} workspaceSlug - Workspace for the LLM review.
 * @param {string} replyTarget - Channel ID or Thread TS for posting results.
 * @param {string} channel - Channel ID where command was invoked.
 * @param {object} slack - Slack WebClient.
 * @param {object} octokit - Octokit instance.
 * @param {Promise<string | null>} thinkingMessagePromise - Promise for the thinking message TS.
 * @returns {Promise<boolean>} True if handled.
 */
export async function handlePrReviewCommand(owner, repo, prNumber, workspaceSlug, replyTarget, channel, slack, octokit, thinkingMessagePromise) {
    console.log(`[CH - PR Review] Handling for ${owner}/${repo}#${prNumber} in workspace ${workspaceSlug}`);
    if (!githubToken || !octokit) { await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ GitHub not configured.` }); return true; }

    try {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:robot_face: Fetching PR ${owner}/${repo}#${prNumber}...` });
        const prDetails = await getPrDetailsForReview(owner, repo, prNumber); // Uses service function

        if (!prDetails) { await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Couldn't fetch PR ${owner}/${repo}#${prNumber}.` }); return true; }

        // --- Construct PR context (limited size) ---
        let prContext = `**PR:** ${owner}/${repo}#${prNumber}\n**Title:** ${prDetails.title}\n**Desc:**\n${(prDetails.body || '').substring(0, 1000)}\n\n**Changes:**\n`;
        /* ... Full file diff formatting logic ... */
        const MAX_DIFF_SIZE = 3000; const MAX_TOTAL_DIFF_SIZE = 20000; let currentTotalDiffSize = 0; let diffTruncatedOverall = false;
        (prDetails.files || []).forEach(file => { if (currentTotalDiffSize >= MAX_TOTAL_DIFF_SIZE) { diffTruncatedOverall = true; return; } prContext += `\n**File:** ${file.filename} (${file.status})\n`; if (file.patch) { let diff = file.patch; let truncFile = false; if (diff.length > MAX_DIFF_SIZE) { diff = diff.substring(0, MAX_DIFF_SIZE); truncFile = true; } if (currentTotalDiffSize + diff.length > MAX_TOTAL_DIFF_SIZE) { const rem = MAX_TOTAL_DIFF_SIZE - currentTotalDiffSize; diff = diff.substring(0, rem); diffTruncatedOverall = true; } prContext += `\`\`\`diff\n${diff}\n\`\`\`\n`; if (truncFile && !diffTruncatedOverall) prContext += `... (diff truncated)\n`; currentTotalDiffSize += diff.length; } else { prContext += `(No diff)\n`; } }); if (diffTruncatedOverall) prContext += `\n... (Overall diff truncated)\n`;
        const MAX_COMMENTS = 5; if (prDetails.comments && prDetails.comments.length > 0) { /* ... format comments ... */ prContext += `\n**Recent Comments (${Math.min(prDetails.comments.length, MAX_COMMENTS)}):**\n`; prDetails.comments.slice(-MAX_COMMENTS).forEach(c => { prContext += `*${c.user}:* ${(c.body || '').substring(0, 300)}\n---\n`; }); }
        // --- End Context ---

        const reviewPrompt = `Review PR ${owner}/${repo}#${prNumber}. Focus: quality, bugs, security, best practices. Provide actionable feedback. Context (may be truncated):\n${prContext}`;
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:brain: Asking LLM in \`${workspaceSlug}\` to review...` });

        const analysisResponse = await queryLlm(workspaceSlug, null, reviewPrompt, 'chat'); // Uses llmService function
        if (!analysisResponse) throw new Error('LLM review analysis empty.');

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, null); // Delete thinking

        const responseChunks = splitMessageIntoChunks(analysisResponse);
        for (let i = 0; i < responseChunks.length; i++) { /* ... post chunks ... */
             const chunk = responseChunks[i]; const block = markdownToRichTextBlock(chunk);
             await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `PR Review ${i + 1}`, ...(block ? { blocks: [block] } : { text: chunk }) });
             if (responseChunks.length > 1 && i < responseChunks.length - 1) await new Promise(r => setTimeout(r, 500));
        }
        return true;

    } catch (error) {
        console.error(`[CH - PR Review] Error for ${owner}/${repo}#${prNumber}:`, error);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Error reviewing PR ${prNumber}: ${error.message}` });
        return true;
    }
}


/**
 * Handles the 'gh: analyze issue' command / '/gh-analyze' slash command.
 * @param {string} owner - Repo owner.
 * @param {string} repo - Repo name.
 * @param {number} issueNumber - Issue number.
 * @param {string | null} userPrompt - Optional user question about the issue.
 * @param {string} replyTarget - Channel ID or Thread TS for posting results.
 * @param {string} channel - Channel ID where command was invoked.
 * @param {object} slack - Slack WebClient.
 * @param {object} octokit - Octokit instance.
 * @param {Promise<string | null>} thinkingMessagePromise - Promise for the thinking message TS.
 * @param {string | null} workspaceSlugForLlm - Workspace slug to use for LLM calls (could be thread's or explicit from slash command).
 * @param {string | null} anythingLLMThreadSlug - Thread slug if invoked via message, null otherwise.
 * @returns {Promise<boolean>} True if handled.
 */
export async function handleIssueAnalysisCommand(owner, repo, issueNumber, userPrompt, replyTarget, channel, slack, octokit, thinkingMessagePromise, workspaceSlugForLlm, anythingLLMThreadSlug) {
    console.log(`[CH - Issue Analysis] Handling ${owner}/${repo}#${issueNumber}. LLM Ws: ${workspaceSlugForLlm}, Thread: ${anythingLLMThreadSlug || 'N/A'}`);

    // Validate necessary inputs for this handler
    if (!workspaceSlugForLlm) { await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Cannot analyze issue: Target LLM workspace is unknown.` }); return true; }
    if (!githubToken || !octokit) { await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ GitHub not configured.` }); return true; }

    try {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:robot_face: Fetching issue ${owner}/${repo}#${issueNumber}...` });
        const issueDetails = await getGithubIssueDetails(issueNumber, owner, repo); // Uses service

        if (!issueDetails) { await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Couldn't fetch issue ${owner}/${repo}#${issueNumber}.` }); return true; }

        // --- Construct Context ---
        let issueContext = `**Issue:** ${owner}/${repo}#${issueNumber}\n**Title:** ${issueDetails.title}\n**URL:** <${issueDetails.url}|View>\n**State:** ${issueDetails.state}\n**Body:**\n${(issueDetails.body || '').substring(0, 2000)}\n\n`;
        const MAX_COMMENTS_ISSUE = 5; const MAX_COMMENT_LENGTH = 300;
        if (issueDetails.comments && issueDetails.comments.length > 0) { /* ... format comments ... */ issueContext += `**Recent Comments (${Math.min(issueDetails.comments.length, MAX_COMMENTS_ISSUE)}):**\n`; issueDetails.comments.slice(-MAX_COMMENTS_ISSUE).forEach(c => { issueContext += `*${c.user}:* ${(c.body || '').substring(0, MAX_COMMENT_LENGTH)}\n---\n`; }); }
        // --- End Context ---

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:mag: Summarizing issue #${issueNumber}...` });
        const summarizePrompt = `Summarize GitHub issue ${owner}/${repo}#${issueNumber}:\n\n${issueContext}`;
        const summaryResponse = await queryLlm(workspaceSlugForLlm, anythingLLMThreadSlug, summarizePrompt); // Use provided workspace/thread
        if (!summaryResponse) throw new Error('LLM failed summary.');

        const summaryBlock = markdownToRichTextBlock(`*Summary for issue #${issueNumber}:*\n${summaryResponse}`);
		console.log( '----BLOCK DATA------' );
		console.log( summaryBlock );
		console.log( '----BLOCK DATA------' );

        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `Summary issue #${issueNumber}:`, blocks: summaryBlock ? [summaryBlock] : undefined });

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:brain: Analyzing issue #${issueNumber}...` });
        let analyzePrompt = `Based on summary ("${summaryResponse.substring(0, 300)}...") and context, analyze issue ${owner}/${repo}#${issueNumber}`;
        if (userPrompt) { analyzePrompt += ` addressing: "${userPrompt}"`; } else { analyzePrompt += `. Key points, causes, next steps?`; }
        analyzePrompt += `\n\n**Full Context:**\n${issueContext}`;
        const analysisResponse = await queryLlm(workspaceSlugForLlm, anythingLLMThreadSlug, analyzePrompt); // Use provided workspace/thread
        if (!analysisResponse) throw new Error('LLM failed analysis.');

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, null); // Delete thinking

        const analysisChunks = splitMessageIntoChunks(analysisResponse);
        for (let i = 0; i < analysisChunks.length; i++) { /* ... post chunks ... */
            const chunk = analysisChunks[i]; const block = markdownToRichTextBlock(chunk);
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `Analysis ${i + 1}`, ...(block ? { blocks: [block] } : { text: chunk }) });
            if (analysisChunks.length > 1 && i < analysisChunks.length - 1) await new Promise(r => setTimeout(r, 500));
        }
        return true;

    } catch (error) {
        console.error(`[CH - Issue Analysis] Error for ${owner}/${repo}#${issueNumber}:`, error);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Error analyzing issue #${issueNumber}: ${error.message}` });
        return true;
    }
}

/**
 * Handles the generic 'gh: api' command / '/gh-api' slash command.
 * @param {string} apiQuery - The user's query describing the API call.
 * @param {string} replyTarget - Channel ID or Thread TS for posting results.
 * @param {string} channel - Channel ID where command was invoked.
 * @param {object} slack - Slack WebClient.
 * @param {Promise<string | null>} thinkingMessagePromise - Promise for the thinking message TS.
 * @param {string|null} githubWsSlug - Configured workspace slug for generating API calls.
 * @param {string|null} formatterWsSlug - Configured workspace slug for formatting results.
 * @returns {Promise<boolean>} True if handled.
 */
export async function handleGithubApiCommand(apiQuery, replyTarget, channel, slack, thinkingMessagePromise, githubWsSlug, formatterWsSlug) {
    console.log(`[CH - API] Handling 'gh: api' query: "${apiQuery}"`);

    if (!githubToken) { await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: "❌ GitHub token not configured." }); return true; }
    if (!githubWsSlug) { await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: "❌ GitHub API workspace not configured." }); return true; }

    try {
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:nerd_face: Generating API call for: "${apiQuery.substring(0, 50)}..."` });
        const llmPrompt = `Based on request, generate JSON for GitHub REST API 'fetch'. ONLY output JSON. Request: ${apiQuery}`;
        const llmResponse = await queryLlm(githubWsSlug, null, llmPrompt, 'chat'); // Use GitHub LLM workspace
        if (!llmResponse) throw new Error('GitHub workspace LLM returned empty.');

        let cleanedJsonString = llmResponse.trim(); /* ... clean ```json ... ``` etc ... */
         const jsonMatch = cleanedJsonString.match(/```json\s*([\s\S]*?)\s*```/); if (jsonMatch && jsonMatch[1]) cleanedJsonString = jsonMatch[1].trim(); else if (!cleanedJsonString.startsWith('{') || !cleanedJsonString.endsWith('}')) throw new Error(`LLM response not JSON: ${llmResponse}`);
        let apiDetails; try { apiDetails = JSON.parse(cleanedJsonString); if (!apiDetails.endpoint) throw new Error("Missing 'endpoint'."); } catch (e) { throw new Error(`Failed parse LLM JSON: ${e.message}. Raw: ${llmResponse}`); }

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:satellite: Calling GitHub: ${apiDetails.method || 'GET'} ${apiDetails.endpoint}` });
        const githubResponse = await callGithubApi(apiDetails); // Uses service function
        console.log("[CH - API] Received GitHub response.");

        let finalResponseText = ''; const rawJsonString = JSON.stringify(githubResponse, null, 2);
        if (formatterWsSlug) { /* ... Format using formatterWsSlug ... */
            await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:art: Formatting response...` });
            const formatPrompt = `Format API JSON into Markdown:\n\n\`\`\`json\n${rawJsonString}\n\`\`\``;
            try {
                const formatted = await queryLlm(formatterWsSlug, null, formatPrompt, 'chat');
                if (formatted?.trim()) { let cleaned = formatted.trim(); if (cleaned.startsWith('```markdown')) cleaned = cleaned.substring(11); else if (cleaned.startsWith('```')) cleaned = cleaned.substring(3); if (cleaned.endsWith('```')) cleaned = cleaned.substring(0, cleaned.length - 3); finalResponseText = cleaned.trim(); }
                else { throw new Error("Formatter empty."); }
            } catch (formatError) { console.error('[CH - API] Formatter Error:', formatError); finalResponseText = `(Formatting Error)\n\nRaw:\n\`\`\`json\n${rawJsonString}\n\`\`\``; }
        } else { finalResponseText = `Raw Response:\n\`\`\`json\n${rawJsonString}\n\`\`\``; }

        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, null); // Delete thinking

        const chunks = splitMessageIntoChunks(finalResponseText);
        for (let i = 0; i < chunks.length; i++) { /* ... post chunks ... */
             const chunk = chunks[i]; const block = markdownToRichTextBlock(chunk);
             await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: chunk.substring(0,200)+'...', ...(block ? { blocks: [block] } : { text: chunk }) });
             if (chunks.length > 1 && i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
        }
        return true;

    } catch (error) {
        console.error('[CH - API] Error:', error);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Error processing \`gh: api\`: ${error.message}` });
        return true;
    }
}

/**
 * Handles greeting intents detected by intent detection.
 * Responds with a friendly welcome message.
 * @param {object} intentContext - The context object for this intent.
 * @returns {Promise<boolean>} - True if handled successfully.
 */
export async function handleGreetingIntent(intentContext) {
    const { 
        slack, 
        channelId, 
        replyTarget, 
        thinkingMessageTs,
        intentResult 
    } = intentContext;
    
    console.log(`[CommandHandler] Handling greeting intent`);
    
    try {
        // Prepare a friendly greeting response
        const greeting = [
            `Hello there! :wave:`,
            `I'm Orbit, your AI assistant for Gravity Forms development.`,
            `I can help with code questions, best practices, documentation, and GitHub tasks.`,
            `Feel free to ask me anything about Gravity Forms!`
        ].join('\n');
        
        // First, update the thinking message
        await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { 
            text: "Responding to greeting..." 
        });
        
        // Post the greeting message
        await slack.chat.postMessage({
            channel: channelId,
            thread_ts: replyTarget,
            text: greeting
        });
        
        // Delete the thinking message
        await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, null);
        
        return true;
    } catch (error) {
        console.error(`[CommandHandler] Error handling greeting intent:`, error);
        return false;
    }
}

console.log("[Command Handler] Initialized.");
