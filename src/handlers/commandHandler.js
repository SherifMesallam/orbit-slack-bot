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
        console.log(`[CH Util] updateOrDeleteThinkingMessage called with updateArgs: ${updateArgs ? 'update' : 'delete'}`);
        ts = await thinkingMessagePromise; // Get the TS
        console.log(`[CH Util] Thinking message promise resolved to TS: ${ts || 'null'}`);
        
        if (!ts) {
            console.log(`[CH Util] No thinking message TS resolved, nothing to update/delete.`);
            return;
        }
        
        if (updateArgs) {
            console.log(`[CH Util] Attempting to update message ${ts} with text: ${updateArgs.text || '(no text)'}`);
            await slack.chat.update({ channel, ts, ...updateArgs });
            console.log(`[CH Util] Updated thinking message ${ts}.`);
        } else {
            console.log(`[CH Util] Attempting to delete message ${ts}`);
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
                const reviewPattern = /([\w.-]+)\/([\w.-]+)#(\d+)(?:\s+#([\w-]+))?/i;
                const match = commandArgs.match(reviewPattern);
                if (match) {
                    const [_, owner, repo, pr_number, workspace_slug] = match;
                    
                    // Determine workspace slug from repo if not explicitly specified
                    let finalWorkspaceSlug = workspace_slug;
                    
                    if (!finalWorkspaceSlug) {
                        // Use repository name as the workspace slug
                        finalWorkspaceSlug = repo;
                        
                        // Check if repo has a gravityforms prefix and strip it if needed
                        if (repo.startsWith("gravityforms") && repo !== "gravityforms") {
                            // For repositories like "gravityformsstripe", use "stripe" as workspace
                            const repoWithoutPrefix = repo.replace("gravityforms", "");
                            if (repoWithoutPrefix.length > 0) {
                                finalWorkspaceSlug = repoWithoutPrefix;
                            }
                        }
                        
                        // Fallback to githubWorkspaceSlug if needed
                        if (!finalWorkspaceSlug) {
                            finalWorkspaceSlug = githubWorkspaceSlug;
                        }
                        
                        console.log(`[Slash Command Handler] Automatically using workspace from repo: ${finalWorkspaceSlug}`);
                    }
                    
                    commandHandled = await handlePrReviewCommand(
                        owner, 
                        repo, 
                        parseInt(pr_number), 
                        finalWorkspaceSlug, 
                        channel_id, 
                        channel_id, 
                        slack, 
                        octokit, 
                        thinkingPromise
                    );
                } else {
                    await slack.chat.postMessage({ 
                        channel: channel_id, 
                        text: `❌ Usage: \`/gh-review owner/repo#number [#optional-workspace]\`` 
                    });
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
    console.log(`[CH - PR Review] Debug - Parameters: replyTarget=${replyTarget}, channel=${channel}, slack=${!!slack}, octokit=${!!octokit}, thinkingMessagePromise=${!!thinkingMessagePromise}`);
    
    if (!githubToken || !octokit) { 
        console.log(`[CH - PR Review] Debug - Missing GitHub token or octokit`);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ GitHub not configured.` }); 
        return true; 
    }

    try {
        console.log(`[CH - PR Review] Debug - Updating thinking message`);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:robot_face: Fetching PR ${owner}/${repo}#${prNumber}...` });
        
        console.log(`[CH - PR Review] Debug - About to call getPrDetailsForReview`);
        const prDetails = await getPrDetailsForReview(owner, repo, prNumber); // Uses service function
        console.log(`[CH - PR Review] Debug - getPrDetailsForReview returned: ${!!prDetails}`);

        if (!prDetails) { 
            console.log(`[CH - PR Review] Debug - No PR details found`);
            await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `❌ Couldn't fetch PR ${owner}/${repo}#${prNumber}.` }); 
            return true; 
        }

        // --- Construct PR context (limited size) ---
        console.log(`[CH - PR Review] Debug - Building PR context`);
        let prContext = `**PR:** ${owner}/${repo}#${prNumber}\n**Title:** ${prDetails.title}\n**Desc:**\n${(prDetails.body || '').substring(0, 1000)}\n\n**Changes:**\n`;
        /* ... Full file diff formatting logic ... */
        const MAX_DIFF_SIZE = 3000; const MAX_TOTAL_DIFF_SIZE = 20000; let currentTotalDiffSize = 0; let diffTruncatedOverall = false;
        (prDetails.files || []).forEach(file => { if (currentTotalDiffSize >= MAX_TOTAL_DIFF_SIZE) { diffTruncatedOverall = true; return; } prContext += `\n**File:** ${file.filename} (${file.status})\n`; if (file.patch) { let diff = file.patch; let truncFile = false; if (diff.length > MAX_DIFF_SIZE) { diff = diff.substring(0, MAX_DIFF_SIZE); truncFile = true; } if (currentTotalDiffSize + diff.length > MAX_TOTAL_DIFF_SIZE) { const rem = MAX_TOTAL_DIFF_SIZE - currentTotalDiffSize; diff = diff.substring(0, rem); diffTruncatedOverall = true; } prContext += `\`\`\`diff\n${diff}\n\`\`\`\n`; if (truncFile && !diffTruncatedOverall) prContext += `... (diff truncated)\n`; currentTotalDiffSize += diff.length; } else { prContext += `(No diff)\n`; } }); if (diffTruncatedOverall) prContext += `\n... (Overall diff truncated)\n`;
        const MAX_COMMENTS = 5; if (prDetails.comments && prDetails.comments.length > 0) { /* ... format comments ... */ prContext += `\n**Recent Comments (${Math.min(prDetails.comments.length, MAX_COMMENTS)}):**\n`; prDetails.comments.slice(-MAX_COMMENTS).forEach(c => { prContext += `*${c.user}:* ${(c.body || '').substring(0, 300)}\n---\n`; }); }
        // --- End Context ---

        const reviewPrompt = `Review PR ${owner}/${repo}#${prNumber}. Focus: quality, bugs, security, best practices. Provide actionable feedback. Context (may be truncated):\n${prContext}`;
        console.log(`[CH - PR Review] Debug - About to update thinking message before LLM call`);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, { text: `:brain: Asking LLM in \`${workspaceSlug}\` to review...` });

        console.log(`[CH - PR Review] Debug - About to call queryLlm with workspace=${workspaceSlug}`);
        const analysisResponse = await queryLlm(workspaceSlug, null, reviewPrompt, 'chat'); // Uses llmService function
        console.log(`[CH - PR Review] Debug - queryLlm returned response length: ${analysisResponse ? analysisResponse.length : 0}`);
        
        if (!analysisResponse) {
            console.log(`[CH - PR Review] Debug - No analysis response from LLM`);
            throw new Error('LLM review analysis empty.');
        }

        console.log(`[CH - PR Review] Debug - About to delete thinking message`);
        await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, null); // Delete thinking

        console.log(`[CH - PR Review] Debug - About to split response into chunks`);
        const responseChunks = splitMessageIntoChunks(analysisResponse);
        console.log(`[CH - PR Review] Debug - Split response into ${responseChunks.length} chunks`);
        
        for (let i = 0; i < responseChunks.length; i++) { /* ... post chunks ... */
             const chunk = responseChunks[i]; 
             console.log(`[CH - PR Review] Debug - Processing chunk ${i+1}/${responseChunks.length}, length: ${chunk.length}`);
             const block = markdownToRichTextBlock(chunk);
             console.log(`[CH - PR Review] Debug - About to post message with chunk ${i+1}`);
             await slack.chat.postMessage({ 
                channel, 
                thread_ts: replyTarget, 
                text: `PR Review ${i + 1}`, 
                ...(block ? { blocks: [block] } : { text: chunk }) 
             });
             console.log(`[CH - PR Review] Debug - Posted chunk ${i+1}`);
             if (responseChunks.length > 1 && i < responseChunks.length - 1) await new Promise(r => setTimeout(r, 500));
        }
        console.log(`[CH - PR Review] Debug - All chunks posted successfully`);
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

/**
 * Handles the github_release_info intent detected by intent detection.
 * Extracts repository information from the query and calls handleReleaseInfoCommand.
 * @param {object} intentContext - The context object for this intent.
 * @returns {Promise<boolean>} - True if handled successfully.
 */
export async function handleGithubReleaseInfoIntent(intentContext) {
    const { 
        query,
        slack, 
        channelId, 
        replyTarget, 
        thinkingMessageTs,
        octokit,
        intentResult 
    } = intentContext;
    
    // Validate that we have the required components
    if (!slack || !channelId) {
        console.error(`[CommandHandler] Missing required parameters: slack=${!!slack}, channelId=${!!channelId}`);
        return false;
    }
    
    // Create a thinking message if one wasn't provided
    let localThinkingMessageTs = thinkingMessageTs;
    if (!localThinkingMessageTs) {
        try {
            console.log(`[CommandHandler] No thinking message found, creating one for github_release_info`);
            const thinkingMsg = await slack.chat.postMessage({ 
                channel: channelId, 
                thread_ts: replyTarget, 
                text: ":hourglass_flowing_sand: Processing release info request..." 
            });
            localThinkingMessageTs = thinkingMsg?.ts;
        } catch (err) {
            console.error("[CommandHandler] Failed to post thinking message:", err.data?.error || err.message);
            // Continue without thinking message
        }
    }
    
    console.log(`[CommandHandler] Handling github_release_info intent for query: "${query}"`);
    
    try {
        // Extract repository name from the query
        // Look for patterns like "latest for gravityforms" or "latest release of paypal" or just "gravityforms release"
        const repoPatterns = [
            /latest(?:\s+for|\s+release\s+of|\s+version\s+of|\s+of)?\s+([a-zA-Z0-9._-]+)/i,
            /([a-zA-Z0-9._-]+)\s+(?:release|version|update)/i,
            /what's\s+new\s+in\s+([a-zA-Z0-9._-]+)/i,
            /when\s+was\s+([a-zA-Z0-9._-]+)\s+(?:last\s+updated|released)/i,
            /(?:new|recent)\s+(?:version|release)\s+(?:of\s+)?([a-zA-Z0-9._-]+)/i,
            /version\s+(?:of\s+)?([a-zA-Z0-9._-]+)/i
        ];
        
        let repoIdentifier = null;
        for (const pattern of repoPatterns) {
            const match = query.match(pattern);
            if (match && match[1]) {
                repoIdentifier = match[1].trim();
                console.log(`[CommandHandler] Matched repo pattern: ${repoIdentifier}`);
                break;
            }
        }
        
        // If no repo found with patterns, look for specific keywords
        if (!repoIdentifier) {
            // Check for "core" references or general "latest" queries
            if (query.toLowerCase().includes("core") || 
                query.toLowerCase().includes("gravity forms") || 
                query.toLowerCase().includes("gravityforms")) {
                repoIdentifier = "gravityforms";
                console.log(`[CommandHandler] Found core reference: ${repoIdentifier}`);
            } 
            else if (query.toLowerCase().includes("latest version") || 
                     query.toLowerCase().includes("latest release") || 
                     query.toLowerCase().includes("most recent update")) {
                // Default to gravityforms for general "latest" queries
                repoIdentifier = "gravityforms";
                console.log(`[CommandHandler] Found general latest reference: ${repoIdentifier}`);
            }
            else {
                // Check for common add-on names
                const addonPatterns = [
                    { pattern: /\b(?:stripe|credit\s*card)\b/i, repo: "stripe" },
                    { pattern: /\b(?:paypal|pp|ppcp)\b/i, repo: "ppcp" },
                    { pattern: /\b(?:user\s*reg|user\s*registration|ur)\b/i, repo: "ur" },
                    { pattern: /\b(?:flow|gravity\s*flow)\b/i, repo: "flow" },
                    { pattern: /\b(?:auth\.?net|authorize\.?net)\b/i, repo: "authnet" },
                    { pattern: /\b(?:mailchimp|mail\s*chimp)\b/i, repo: "mailchimp" },
                    { pattern: /\b(?:zapier|zap)\b/i, repo: "zapier" }
                ];
                
                for (const {pattern, repo} of addonPatterns) {
                    if (pattern.test(query)) {
                        repoIdentifier = repo;
                        console.log(`[CommandHandler] Matched addon pattern: ${repoIdentifier}`);
                        break;
                    }
                }
            }
        }
        
        // If still no repo found, try fallback to extract any word that might be a repo name
        if (!repoIdentifier) {
            const words = query.split(/\s+/);
            // Check if any word matches common add-on names or keywords
            const potentialRepos = ['gravityforms', 'stripe', 'paypal', 'square', 'flow', 'packages'];
            for (const word of words) {
                if (potentialRepos.some(repo => word.toLowerCase().includes(repo.toLowerCase()))) {
                    repoIdentifier = word;
                    console.log(`[CommandHandler] Extracted potential repo from word: ${repoIdentifier}`);
                    break;
                }
            }
        }
        
        if (!repoIdentifier) {
            console.log(`[CommandHandler] Could not determine repository from query: "${query}"`);
            await updateOrDeleteThinkingMessage(localThinkingMessageTs, slack, channelId, { 
                text: "I couldn't determine which repository you're asking about. Please specify an add-on name or repository." 
            });
            return true;
        }
        
        console.log(`[CommandHandler] Extracted repo identifier: ${repoIdentifier}`);
        
        // FIXED: Check if repoIdentifier is numeric (likely an issue or PR number mistakenly detected)
        if (/^\d+$/.test(repoIdentifier)) {
            console.log(`[CommandHandler] Repo identifier is numeric (${repoIdentifier}), likely an issue or PR number. Using default repository.`);
            repoIdentifier = 'gravityforms';
        }
        
        // Call the existing handler
        console.log(`[CommandHandler] Calling handleReleaseInfoCommand with repo: ${repoIdentifier}`);
        return await handleReleaseInfoCommand(
            repoIdentifier, 
            replyTarget, 
            slack, 
            octokit, 
            localThinkingMessageTs, 
            channelId
        );
    } catch (error) {
        console.error(`[CommandHandler] Error handling github_release_info intent:`, error);
        await updateOrDeleteThinkingMessage(localThinkingMessageTs, slack, channelId, { 
            text: `❌ Error processing release info: ${error.message}` 
        });
        return true;
    }
}

/**
 * Handles the github_pr_review intent detected by intent detection.
 * Extracts PR information from the query and calls handlePrReviewCommand.
 * @param {object} intentContext - The context object for this intent.
 * @returns {Promise<boolean>} - True if handled successfully.
 */
export async function handleGithubPrReviewIntent(intentContext) {
    const { 
        query,
        slack, 
        channelId, 
        replyTarget, 
        thinkingMessageTs,
        octokit,
        intentResult 
    } = intentContext;
    
    // Validate that we have the required components
    if (!slack || !channelId) {
        console.error(`[CommandHandler] Missing required parameters: slack=${!!slack}, channelId=${!!channelId}`);
        return false;
    }
    
    // Create a thinking message if one wasn't provided
    let localThinkingMessageTs = thinkingMessageTs;
    if (!localThinkingMessageTs) {
        try {
            console.log(`[CommandHandler] No thinking message found, creating one for github_pr_review`);
            const thinkingMsg = await slack.chat.postMessage({ 
                channel: channelId, 
                thread_ts: replyTarget, 
                text: ":hourglass_flowing_sand: Processing PR review request..." 
            });
            localThinkingMessageTs = thinkingMsg?.ts;
        } catch (err) {
            console.error("[CommandHandler] Failed to post thinking message:", err.data?.error || err.message);
            // Continue without thinking message
        }
    }
    
    console.log(`[CommandHandler] Handling github_pr_review intent for query: "${query}"`);
    console.log(`[CommandHandler] Debug - Received context:`, JSON.stringify({
        query, 
        channelId, 
        replyTarget: replyTarget ? 'set' : 'undefined',
        thinkingMessageTs: thinkingMessageTs ? 'set' : 'undefined',
        octokit: octokit ? 'set' : 'undefined',
        intentResult: intentResult ? 'set' : 'undefined'
    }));
    
    try {
        // Extract PR information from the query
        // Look for patterns like "review PR 123" or "review pull request rocketgenius/gravityforms#456"
        const prPatterns = [
            /(?:review|analyze|summarize)\s+(?:PR|pull\s+request)\s+(?:for\s+)?(?:([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)|(\d+))/i,
            /(?:PR|pull\s+request)\s+(?:([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)|(\d+))/i
        ];
        
        let owner = null;
        let repo = null;
        let prNumber = null;
        
        for (const pattern of prPatterns) {
            const match = query.match(pattern);
            if (match) {
                console.log(`[CommandHandler] Debug - PR pattern matched:`, JSON.stringify(match));
                if (match[3]) {
                    // We matched the owner/repo#number format
                    owner = match[1];
                    repo = match[2];
                    prNumber = parseInt(match[3], 10);
                } else if (match[4]) {
                    // We only matched a PR number
                    prNumber = parseInt(match[4], 10);
                }
                break;
            }
        }
        
        // If we only have a PR number, determine owner/repo 
        if (prNumber && !owner) {
            console.log(`[CommandHandler] Debug - Only PR number found: ${prNumber}, determining owner/repo`);
            // Default to GITHUB_OWNER and extract repo from query or use a default
            owner = GITHUB_OWNER;
            
            // Try to find repo name in the query
            const repoPattern = /(?:in|for|from)\s+([a-zA-Z0-9._-]+)(?:\s+|$)/i;
            const repoMatch = query.match(repoPattern);
            if (repoMatch && repoMatch[1]) {
                repo = repoMatch[1].trim();
                console.log(`[CommandHandler] Debug - Found repo in query: ${repo}`);
            } else {
                // Default to gravityforms if no repo specified
                repo = 'gravityforms';
                console.log(`[CommandHandler] Debug - Using default repo: ${repo}`);
            }
        }
        
        if (!owner || !repo || !prNumber) {
            console.log(`[CommandHandler] Debug - Missing required information: owner=${owner}, repo=${repo}, prNumber=${prNumber}`);
            await updateOrDeleteThinkingMessage(localThinkingMessageTs, slack, channelId, { 
                text: "I couldn't determine the PR details. Please specify using format: owner/repo#number or PR number" 
            });
            return true;
        }
        
        // NEW: Use repository name as the workspace slug
        // This change automatically uses the repository name as the workspace
        let workspaceSlug = repo;
        
        // FIXED: Ensure workspaceSlug is not equal to the PR number (this would be an invalid workspace)
        if (workspaceSlug === prNumber.toString()) {
            console.log(`[CommandHandler] Debug - Workspace cannot be the PR number. Using repo name instead.`);
            workspaceSlug = 'gravityforms';
        }
        
        // Check if repo has a gravityforms prefix and strip it if needed
        if (repo.startsWith("gravityforms") && repo !== "gravityforms") {
            // For repositories like "gravityformsstripe", use "stripe" as workspace
            const repoWithoutPrefix = repo.replace("gravityforms", "");
            if (repoWithoutPrefix.length > 0) {
                workspaceSlug = repoWithoutPrefix;
                console.log(`[CommandHandler] Debug - Extracted workspace from repo: ${workspaceSlug}`);
            } else {
                // If the prefix removal results in an empty string, use the full name
                workspaceSlug = repo;
            }
        }
        
        // Override with explicit workspace if specified (maintaining backward compatibility)
        const workspacePattern = /#([a-zA-Z0-9._-]+)/i;
        const workspaceMatch = query.match(workspacePattern);
        if (workspaceMatch && workspaceMatch[1]) {
            // Make sure the matched workspace is not just the PR number
            const matchedWorkspace = workspaceMatch[1].trim();
            if (matchedWorkspace !== prNumber.toString()) {
                workspaceSlug = matchedWorkspace;
                console.log(`[CommandHandler] Explicit workspace specified in query: ${workspaceSlug}`);
            } else {
                console.log(`[CommandHandler] Ignoring matched workspace as it's the PR number: ${matchedWorkspace}`);
            }
        }
        
        // FIXED: Validate that workspaceSlug is not a number
        if (/^\d+$/.test(workspaceSlug)) {
            console.log(`[CommandHandler] Debug - Workspace cannot be numeric (${workspaceSlug}). Using default workspace.`);
            workspaceSlug = githubWorkspaceSlug || 'github';
        }
        
        // Fallback to githubWorkspaceSlug if none of the above are available
        if (!workspaceSlug) {
            workspaceSlug = githubWorkspaceSlug || 'github';
            console.log(`[CommandHandler] Using default GitHub workspace: ${workspaceSlug}`);
        }
        
        console.log(`[CommandHandler] Extracted PR: ${owner}/${repo}#${prNumber}, Using workspace: ${workspaceSlug}`);
        
        // Call the existing handler
        console.log(`[CommandHandler] Debug - About to call handlePrReviewCommand`);
        const result = await handlePrReviewCommand(
            owner,
            repo,
            prNumber,
            workspaceSlug,
            replyTarget,
            channelId,
            slack,
            octokit,
            localThinkingMessageTs
        );
        console.log(`[CommandHandler] Debug - handlePrReviewCommand returned: ${result}`);
        return result;
    } catch (error) {
        console.error(`[CommandHandler] Error handling github_pr_review intent:`, error);
        await updateOrDeleteThinkingMessage(localThinkingMessageTs, slack, channelId, { 
            text: `❌ Error processing PR review: ${error.message}` 
        });
        return true;
    }
}

/**
 * Handles the github_issue_analysis intent detected by intent detection.
 * Extracts issue information from the query and calls handleIssueAnalysisCommand.
 * @param {object} intentContext - The context object for this intent.
 * @returns {Promise<boolean>} - True if handled successfully.
 */
export async function handleGithubIssueAnalysisIntent(intentContext) {
    const { 
        query,
        slack, 
        channelId, 
        replyTarget, 
        thinkingMessageTs,
        octokit,
        intentResult 
    } = intentContext;
    
    // Validate that we have the required components
    if (!slack || !channelId) {
        console.error(`[CommandHandler] Missing required parameters: slack=${!!slack}, channelId=${!!channelId}`);
        return false;
    }
    
    // Create a thinking message if one wasn't provided
    let localThinkingMessageTs = thinkingMessageTs;
    if (!localThinkingMessageTs) {
        try {
            console.log(`[CommandHandler] No thinking message found, creating one for github_issue_analysis`);
            const thinkingMsg = await slack.chat.postMessage({ 
                channel: channelId, 
                thread_ts: replyTarget, 
                text: ":hourglass_flowing_sand: Processing issue analysis request..." 
            });
            localThinkingMessageTs = thinkingMsg?.ts;
        } catch (err) {
            console.error("[CommandHandler] Failed to post thinking message:", err.data?.error || err.message);
            // Continue without thinking message
        }
    }
    
    console.log(`[CommandHandler] Handling github_issue_analysis intent for query: "${query}"`);
    
    try {
        // Extract issue information from the query
        // Look for patterns like "analyze issue 123" or "explain issue rocketgenius/gravityforms#456"
        const issuePatterns = [
            /(?:analyze|explain|summarize)\s+(?:issue|ticket)\s+(?:([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)|#?(\d+))/i,
            /(?:issue|ticket)\s+(?:([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)|#?(\d+))/i
        ];
        
        let owner = null;
        let repo = null;
        let issueNumber = null;
        
        for (const pattern of issuePatterns) {
            const match = query.match(pattern);
            if (match) {
                console.log(`[CommandHandler] Debug - Issue pattern matched:`, JSON.stringify(match));
                if (match[3]) {
                    // We matched the owner/repo#number format
                    owner = match[1];
                    repo = match[2];
                    issueNumber = parseInt(match[3], 10);
                } else if (match[4]) {
                    // We only matched an issue number
                    issueNumber = parseInt(match[4], 10);
                }
                break;
            }
        }
        
        // If we only have an issue number, determine owner/repo 
        if (issueNumber && !owner) {
            console.log(`[CommandHandler] Debug - Only issue number found: ${issueNumber}, determining owner/repo`);
            // Default to GITHUB_OWNER and extract repo from query or use a default
            owner = GITHUB_OWNER;
            
            // Try to find repo name in the query
            const repoPattern = /(?:in|for|from)\s+([a-zA-Z0-9._-]+)(?:\s+|$)/i;
            const repoMatch = query.match(repoPattern);
            if (repoMatch && repoMatch[1]) {
                repo = repoMatch[1].trim();
                console.log(`[CommandHandler] Debug - Found repo in query: ${repo}`);
            } else {
                // Default to backlog if no repo specified
                repo = 'backlog';
                console.log(`[CommandHandler] Debug - Using default repo: ${repo}`);
            }
        }
        
        if (!owner || !repo || !issueNumber) {
            console.log(`[CommandHandler] Debug - Missing required information: owner=${owner}, repo=${repo}, issueNumber=${issueNumber}`);
            await updateOrDeleteThinkingMessage(localThinkingMessageTs, slack, channelId, { 
                text: "I couldn't determine the issue details. Please specify using format: owner/repo#number or issue number" 
            });
            return true;
        }
        
        // Determine workspace to use from intentResult or fallback
        let workspaceSlug = intentResult?.suggestedWorkspace || githubWorkspaceSlug || 'github';
        
        // FIXED: Ensure workspaceSlug is not equal to the issue number (this would be an invalid workspace)
        if (workspaceSlug === issueNumber.toString()) {
            console.log(`[CommandHandler] Debug - Workspace cannot be the issue number. Using repo name instead.`);
            workspaceSlug = repo;
        }
        
        // FIXED: Extract workspace from repo if it makes sense
        if (repo.startsWith("gravityforms") && repo !== "gravityforms" && workspaceSlug === repo) {
            // For repositories like "gravityformsstripe", use "stripe" as workspace
            const repoWithoutPrefix = repo.replace("gravityforms", "");
            if (repoWithoutPrefix.length > 0) {
                workspaceSlug = repoWithoutPrefix;
                console.log(`[CommandHandler] Debug - Extracted workspace from repo: ${workspaceSlug}`);
            }
        }
        
        // Override with explicit workspace if specified in query
        const workspacePattern = /#([a-zA-Z0-9._-]+)/i;
        const workspaceMatch = query.match(workspacePattern);
        if (workspaceMatch && workspaceMatch[1]) {
            // Make sure the matched workspace is not just the issue number
            const matchedWorkspace = workspaceMatch[1].trim();
            if (matchedWorkspace !== issueNumber.toString()) {
                workspaceSlug = matchedWorkspace;
                console.log(`[CommandHandler] Explicit workspace specified in query: ${workspaceSlug}`);
            } else {
                console.log(`[CommandHandler] Ignoring matched workspace as it's the issue number: ${matchedWorkspace}`);
            }
        }
        
        // FIXED: Validate that workspaceSlug is not a number
        if (/^\d+$/.test(workspaceSlug)) {
            console.log(`[CommandHandler] Debug - Workspace cannot be numeric (${workspaceSlug}). Using default workspace.`);
            workspaceSlug = githubWorkspaceSlug || 'github';
        }
        
        // Extract user prompt - anything after the issue identification that isn't a workspace
        let userPrompt = null;
        // Remove the issue identification part
        let promptText = query.replace(/(?:analyze|explain|summarize)\s+(?:issue|ticket)\s+(?:([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)|#?(\d+))/i, '').trim();
        // Remove any workspace specification
        promptText = promptText.replace(/#([a-zA-Z0-9._-]+)/g, '').trim();
        
        if (promptText) {
            userPrompt = promptText;
        }
        
        console.log(`[CommandHandler] Extracted Issue: ${owner}/${repo}#${issueNumber}, Workspace: ${workspaceSlug}, Prompt: ${userPrompt || 'None'}`);
        
        // Call the existing handler
        console.log(`[CommandHandler] Debug - About to call handleIssueAnalysisCommand`);
        const result = await handleIssueAnalysisCommand(
            owner,
            repo,
            issueNumber,
            userPrompt,
            replyTarget,
            channelId,
            slack,
            octokit,
            localThinkingMessageTs,
            workspaceSlug,
            null // anythingLLMThreadSlug - create new for this request
        );
        console.log(`[CommandHandler] Debug - handleIssueAnalysisCommand returned: ${result}`);
        return result;
    } catch (error) {
        console.error(`[CommandHandler] Error handling github_issue_analysis intent:`, error);
        await updateOrDeleteThinkingMessage(localThinkingMessageTs, slack, channelId, { 
            text: `❌ Error analyzing issue: ${error.message}` 
        });
        return true;
    }
}

/**
 * Handles the github_api_query intent detected by intent detection.
 * Passes the natural language query to handleGithubApiCommand.
 * @param {object} intentContext - The context object for this intent.
 * @returns {Promise<boolean>} - True if handled successfully.
 */
export async function handleGithubApiQueryIntent(intentContext) {
    const { 
        query,
        slack, 
        channelId, 
        replyTarget, 
        thinkingMessageTs,
        intentResult 
    } = intentContext;
    
    // Validate that we have the required components
    if (!slack || !channelId) {
        console.error(`[CommandHandler] Missing required parameters: slack=${!!slack}, channelId=${!!channelId}`);
        return false;
    }
    
    // Create a thinking message if one wasn't provided
    let localThinkingMessageTs = thinkingMessageTs;
    if (!localThinkingMessageTs) {
        try {
            console.log(`[CommandHandler] No thinking message found, creating one for github_api_query`);
            const thinkingMsg = await slack.chat.postMessage({ 
                channel: channelId, 
                thread_ts: replyTarget, 
                text: ":hourglass_flowing_sand: Processing GitHub API query..." 
            });
            localThinkingMessageTs = thinkingMsg?.ts;
        } catch (err) {
            console.error("[CommandHandler] Failed to post thinking message:", err.data?.error || err.message);
            // Continue without thinking message
        }
    }
    
    console.log(`[CommandHandler] Handling github_api_query intent for query: "${query}"`);
    
    try {
        // Clean up the query to remove any intent prefixes
        let apiQuery = query;
        const prefixes = [
            /^api\s+/i,
            /^github\s+api\s+/i,
            /^call\s+api\s+/i,
            /^query\s+api\s+/i
        ];
        
        for (const prefix of prefixes) {
            apiQuery = apiQuery.replace(prefix, '');
        }
        
        apiQuery = apiQuery.trim();
        
        if (!apiQuery) {
            console.log(`[CommandHandler] Empty API query after cleaning`);
            await updateOrDeleteThinkingMessage(localThinkingMessageTs, slack, channelId, { 
                text: "I couldn't determine what API query you want to make. Please provide more details." 
            });
            return true;
        }
        
        // Determine which workspaces to use
        // Use default GitHub workspace for API queries, or fallback to githubWorkspaceSlug
        let apiWorkspaceSlug = githubWorkspaceSlug || 'github';
        let formatterWorkspaceSlug = formatterWorkspaceSlug || 'default';
        
        // FIXED: Validate that workspace slugs are not numeric
        if (/^\d+$/.test(apiWorkspaceSlug)) {
            console.log(`[CommandHandler] Debug - API workspace slug cannot be numeric (${apiWorkspaceSlug}). Using default.`);
            apiWorkspaceSlug = 'github';
        }
        
        if (/^\d+$/.test(formatterWorkspaceSlug)) {
            console.log(`[CommandHandler] Debug - Formatter workspace slug cannot be numeric (${formatterWorkspaceSlug}). Using default.`);
            formatterWorkspaceSlug = 'default';
        }
        
        console.log(`[CommandHandler] Extracted API query: "${apiQuery}"`);
        console.log(`[CommandHandler] Using workspaces - API: ${apiWorkspaceSlug}, Formatter: ${formatterWorkspaceSlug}`);
        
        // Call the existing handler
        console.log(`[CommandHandler] Debug - About to call handleGithubApiCommand`);
        const result = await handleGithubApiCommand(
            apiQuery,
            replyTarget,
            channelId,
            slack,
            localThinkingMessageTs,
            apiWorkspaceSlug,
            formatterWorkspaceSlug
        );
        console.log(`[CommandHandler] Debug - handleGithubApiCommand returned: ${result}`);
        return result;
    } catch (error) {
        console.error(`[CommandHandler] Error handling github_api_query intent:`, error);
        await updateOrDeleteThinkingMessage(localThinkingMessageTs, slack, channelId, { 
            text: `❌ Error processing API query: ${error.message}` 
        });
        return true;
    }
}

/**
 * Provides a debug command to test intent detection directly from Slack.
 * @param {string} query - The query to test for intent detection
 * @param {string} channelId - The channel ID where the command was invoked
 * @param {string} threadTs - The thread timestamp for replying to the message
 * @param {object} slack - The Slack client instance
 * @returns {Promise<boolean>} - True if the command was handled
 */
export async function handleIntentDetectionDebugCommand(query, channelId, threadTs, slack) {
    if (!query || query.trim() === '') {
        await slack.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: "❌ Please provide a query to test intent detection."
        });
        return true;
    }

    try {
        // Post a thinking message
        const thinkingMsg = await slack.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: "🔍 Analyzing intent..."
        });

        // Import from our service
        const { detectIntentAndWorkspace } = await import('../ai/intentDetectionService.js');
        const { getWorkspaces } = await import('../services/llmService.js');
        
        // Get available workspaces
        const workspaces = await getWorkspaces();
        const workspaceNames = workspaces?.map(w => w.slug) || [];
        
        // List of available intents
        const availableIntents = [
            "technical_question", "best_practices_question", "historical_knowledge",
            "bot_abilities", "docs", "greeting", "github_release_info", 
            "github_pr_review", "github_issue_analysis", "github_api_query"
        ];
        
        // Detect intent
        const result = await detectIntentAndWorkspace(query, availableIntents, workspaceNames);
        
        // Format the response
        let responseBlocks = [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*Intent Detection Debug Result*\nQuery: \`${query}\``
                }
            },
            {
                type: "section",
                fields: [
                    {
                        type: "mrkdwn",
                        text: `*Primary Intent:*\n${result.intent || 'None'} (${(result.confidence * 100).toFixed(1)}%)`
                    },
                    {
                        type: "mrkdwn",
                        text: `*Suggested Workspace:*\n${result.suggestedWorkspace || 'None'}`
                    }
                ]
            }
        ];
        
        // Add ranked intents section if available
        if (result.rankedIntents && result.rankedIntents.length > 0) {
            const rankedIntentsList = result.rankedIntents
                .slice(0, 5) // Top 5 intents
                .map((intent, i) => `${i+1}. ${intent.name} (${(intent.confidence * 100).toFixed(1)}%)`)
                .join("\n");
                
            responseBlocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*Ranked Intents:*\n${rankedIntentsList}`
                }
            });
        }
        
        // Add ranked workspaces section if available
        if (result.rankedWorkspaces && result.rankedWorkspaces.length > 0) {
            const rankedWorkspacesList = result.rankedWorkspaces
                .slice(0, 5) // Top 5 workspaces
                .map((ws, i) => `${i+1}. ${ws.name} (${(ws.confidence * 100).toFixed(1)}%)`)
                .join("\n");
                
            responseBlocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*Ranked Workspaces:*\n${rankedWorkspacesList}`
                }
            });
        }
        
        // Update the thinking message with the result
        await slack.chat.update({
            channel: channelId,
            ts: thinkingMsg.ts,
            blocks: responseBlocks,
            text: `Intent Detection Results for: ${query}`
        });
        
        return true;
    } catch (error) {
        console.error("[CH - Intent Debug] Error:", error);
        await slack.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: `❌ Error testing intent detection: ${error.message}`
        });
        return true;
    }
}

console.log("[Command Handler] Initialized.");
