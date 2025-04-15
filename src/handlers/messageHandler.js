
// src/handlers/messageHandler.js
// Handles regular messages and app mentions, routing to commands or LLM fallback.

import {
    botUserId,
    githubWorkspaceSlug,
    formatterWorkspaceSlug,
    MIN_SUBSTANTIVE_RESPONSE_LENGTH,
    GITHUB_OWNER,
    githubToken,
    COMMAND_PREFIX, // Use defined prefix
    WORKSPACE_OVERRIDE_COMMAND_PREFIX,
} from '../config.js';
import {
    getAnythingLLMThreadMapping,
    storeAnythingLLMThreadMapping,
} from '../services/dbService.js'; // Direct import from specific service
import {
    getWorkspaces,
    createNewAnythingLLMThread,
    queryLlm,
    determineInitialWorkspace // Import workspace logic helper
} from '../services/llmService.js'; // Direct import
import {
    markdownToRichTextBlock,
    extractTextAndCode,
} from '../utils/formattingService.js';
// Import Command Handlers (used for command checking AND execution)
import {
    handleDeleteLastMessageCommand,
    handleReleaseInfoCommand,
    handlePrReviewCommand,
    handleIssueAnalysisCommand,
    handleGithubApiCommand
} from './commandHandler.js';
// Import Slack helpers if needed (e.g., for history, though often better in utils)
// import { fetchSlackHistory } from '../services/slackService.js';

// --- Command Patterns using COMMAND_PREFIX ---
const CMD_PREFIX = COMMAND_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape prefix for regex
const RELEASE_REGEX = new RegExp(`^${CMD_PREFIX}\\s*release\\s+(?<repo_id>[\\w.-]+(?:\\/[\\w.-]+)?)\\s*$`, 'i');
const PR_REVIEW_REGEX = new RegExp(`^${CMD_PREFIX}\\s*review\\s+pr\\s+(?<owner>[\\w.-]+)\\/(?<repo>[\\w.-]+)#(?<pr_number>\\d+)\\s+#(?<workspace_slug>[\\w-]+)\\s*$`, 'i');
const ISSUE_ANALYSIS_REGEX = new RegExp(`^${CMD_PREFIX}\\s*(?:analyze|summarize|explain)\\s+issue\\s+(?:(?<owner>[\\w.-]+)\\/(?<repo>[\\w.-]+))?#(?<issue_number>\\d+)(?:\\s+(?<user_prompt>.+))?\\s*$`, 'i');
const GENERIC_API_REGEX = new RegExp(`^${CMD_PREFIX}\\s*api\\s+(?<api_query>.+)\\s*$`, 'i');
const WORKSPACE_OVERRIDE_REGEX = new RegExp(`\\${WORKSPACE_OVERRIDE_COMMAND_PREFIX}(\\S+)`);


/**
 * Handles incoming message or app_mention events.
 * Checks for commands, otherwise routes to the LLM.
 * @param {object} event - The Slack event object.
 * @param {object} slack - The initialized Slack WebClient.
 * @param {object} octokit - The initialized Octokit instance.
 */
export async function handleSlackMessageEventInternal(event, slack, octokit) {
    const handlerStartTime = Date.now();
    const { user: userId, text: originalText = '', channel: channelId, ts: originalTs, thread_ts: threadTs } = event;

    // 1. Initial Processing & Context
    let rawQuery = originalText.trim();
    const mentionString = `<@${botUserId}>`;
    let isMentioned = rawQuery.includes(mentionString);
    const isDM = channelId.startsWith('D');
    const replyTarget = threadTs || originalTs; // Reply in thread if available

    // Remove mention *after* logging raw query
    let cleanedQuery = rawQuery;
    if (isMentioned) { cleanedQuery = rawQuery.replace(mentionString, '').trim(); }

    console.log(`[Msg Handler] Start: User=${userId}, Chan=${channelId}, TS=${originalTs}, Thread=${threadTs}, Target=${replyTarget}, Mention=${isMentioned}, Query="${cleanedQuery}"`);

    // 2. Handle #delete_last_message command (no thinking message needed)
    if (cleanedQuery.toLowerCase().startsWith('#delete_last_message')) {
        console.log("[Msg Handler] Delete command detected.");
        await handleDeleteLastMessageCommand(channelId, replyTarget, botUserId, slack); // Uses commandHandler
        console.log(`[Msg Handler] Delete handled. Duration: ${Date.now() - handlerStartTime}ms`);
        return;
    }

    // 3. Post Initial Thinking Message (for all other flows)
    const thinkingMessagePromise = slack.chat.postMessage({
        channel: channelId, thread_ts: replyTarget, text: ":hourglass_flowing_sand: Processing..."
    }).then(msg => msg.ts).catch(err => { console.error("[Msg Handler] Failed post initial thinking message:", err.data?.error); return null; });

    // 4. --- Try Matching Specific `gh>` Commands ---
    let commandHandled = false;
    const isPotentialGhCommand = cleanedQuery.toLowerCase().startsWith(COMMAND_PREFIX);

    if (isPotentialGhCommand) {
        if (!githubToken) {
             await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channelId, { text: `❌ GitHub commands disabled (config).` });
             return; // Stop processing
        }
        if (!octokit) { // Also check if Octokit itself initialized properly
            await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channelId, { text: `❌ GitHub client failed to initialize.` });
            return; // Stop processing
        }

        let match; // Reuse match variable

        match = cleanedQuery.match(RELEASE_REGEX);
        if (match?.groups?.repo_id) {
            console.log("[Msg Handler] Matched 'gh> release'.");
            commandHandled = await handleReleaseInfoCommand(match.groups.repo_id, replyTarget, slack, octokit, thinkingMessagePromise, channelId);
        }

        if (!commandHandled) {
            match = cleanedQuery.match(PR_REVIEW_REGEX);
            if (match?.groups) { /* ... Handle PR Review ... */
                 console.log("[Msg Handler] Matched 'gh> review pr'."); const { owner, repo, pr_number, workspace_slug } = match.groups; const prNum = parseInt(pr_number, 10);
                 if (owner && repo && !isNaN(prNum) && workspace_slug) { commandHandled = await handlePrReviewCommand( owner, repo, prNum, workspace_slug, replyTarget, channelId, slack, octokit, thinkingMessagePromise ); }
                 else { console.warn("[Msg Handler] Invalid PR Review params:", match.groups); await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channelId, { text: `❌ Format: \`gh> review pr owner/repo#num #ws\`` }); commandHandled = true; }
            }
        }

        if (!commandHandled) {
            match = cleanedQuery.match(ISSUE_ANALYSIS_REGEX);
            if (match?.groups) { /* ... Handle Issue Analysis ... */
                 console.log("[Msg Handler] Matched 'gh> analyze issue'."); const { owner = GITHUB_OWNER, repo = 'backlog', issue_number, user_prompt } = match.groups; const issueNum = parseInt(issue_number, 10);
                 if (!isNaN(issueNum)) {
                    let llmWs = null, llmThread = null; // Vars for LLM context needed by handler
                    try { // Get thread context
                        const mapping = await getAnythingLLMThreadMapping(channelId, replyTarget); // Uses service
                        if (mapping) { [llmThread, llmWs] = [mapping.anythingllm_thread_slug, mapping.anythingllm_workspace_slug]; }
                        else { llmWs = determineInitialWorkspace(userId, channelId); if (!llmWs) throw new Error("No workspace for new thread."); llmThread = await createNewAnythingLLMThread(llmWs); if (!llmThread) throw new Error(`Failed create thread in ${llmWs}.`); await storeAnythingLLMThreadMapping(channelId, replyTarget, llmWs, llmThread); } // Uses service
                        console.log(`[Msg Handler - Issue Cmd] Using context: ${llmWs}:${llmThread}`);
                        commandHandled = await handleIssueAnalysisCommand( owner, repo, issueNum, user_prompt || null, replyTarget, channelId, slack, octokit, thinkingMessagePromise, llmWs, llmThread );
                    } catch (threadError) { console.error("[Msg Handler-IssueCmd] Thread Error:", threadError); await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channelId, { text: `❌ Error setting up context: ${threadError.message}` }); commandHandled = true; }
                 } else { console.warn("[Msg Handler] Invalid Issue Analysis number:", match.groups); await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channelId, { text: `❌ Format: \`gh> analyze issue [#123 | owner/repo#123]\`` }); commandHandled = true; }
            }
        }

        if (!commandHandled) {
            match = cleanedQuery.match(GENERIC_API_REGEX);
            if (match?.groups?.api_query) { /* ... Handle Generic API ... */
                console.log("[Msg Handler] Matched generic 'gh> api'.");
                commandHandled = await handleGithubApiCommand( match.groups.api_query, replyTarget, channelId, slack, thinkingMessagePromise, githubWorkspaceSlug, formatterWorkspaceSlug );
            }
        }

        if (isPotentialGhCommand && !commandHandled) { /* ... Handle unknown command ... */
             console.warn(`[Msg Handler] Unknown command: ${cleanedQuery}`); await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channelId, { text: `❓ Unknown \`${COMMAND_PREFIX}\` command.` }); commandHandled = true;
        }
    } // End of `if (isPotentialGhCommand)`

    // 5. --- Main Processing Logic (Fallback if no command handled) ---
    if (!commandHandled) {
        console.log("[Msg Handler] No 'gh>' command. Proceeding with LLM query.");

        let anythingLLMThreadSlug = null;
        let workspaceSlugForThread = null;
        try { // Get/Create Thread & Workspace Context
             const mapping = await getAnythingLLMThreadMapping(channelId, replyTarget); // Uses service
             if (mapping) { // Existing Thread
                 [anythingLLMThreadSlug, workspaceSlugForThread] = [mapping.anythingllm_thread_slug, mapping.anythingllm_workspace_slug];
                 const overrideMatch = cleanedQuery.match(WORKSPACE_OVERRIDE_REGEX); // Check override
                 if (overrideMatch && overrideMatch[1]) { /* ... Check if override valid ... */
                    const potentialWs = overrideMatch[1]; const availableWs = await getWorkspaces();
                    if (availableWs.includes(potentialWs)) { workspaceSlugForThread = potentialWs; console.log(`[Msg Handler] Workspace override: ${workspaceSlugForThread}`); }
                    else { console.warn(`[Msg Handler] Override '${potentialWs}' invalid. Using mapped: '${workspaceSlugForThread}'.`); }
                 }
             } else { // New Thread
                 workspaceSlugForThread = determineInitialWorkspace(userId, channelId); // Use helper
                 const overrideMatch = cleanedQuery.match(WORKSPACE_OVERRIDE_REGEX); // Check override
                 if (overrideMatch && overrideMatch[1]) { /* ... Check if override valid ... */
                    const potentialWs = overrideMatch[1]; const availableWs = await getWorkspaces();
                    if (availableWs.includes(potentialWs)) { workspaceSlugForThread = potentialWs; console.log(`[Msg Handler] New thread workspace override: ${workspaceSlugForThread}`); }
                    else { console.warn(`[Msg Handler] Override '${potentialWs}' invalid. Using default: '${workspaceSlugForThread}'.`); }
                 }
                 if (!workspaceSlugForThread) throw new Error("Could not determine target workspace."); // Exit if no workspace found
                 anythingLLMThreadSlug = await createNewAnythingLLMThread(workspaceSlugForThread); // Uses service
                 if (!anythingLLMThreadSlug) throw new Error(`Failed create thread in ${workspaceSlugForThread}.`);
                 await storeAnythingLLMThreadMapping(channelId, replyTarget, workspaceSlugForThread, anythingLLMThreadSlug); // Uses service
                 console.log(`[Msg Handler] Created new thread mapping: ${workspaceSlugForThread}:${anythingLLMThreadSlug}`);
             }
        } catch (threadError) { console.error("[Msg Handler] Thread Error:", threadError); await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channelId, { text: `⚠️ Error connecting to knowledge base: ${threadError.message}` }); return; }

        // --- Proceed with LLM query ---
        try {
            const currentThinkingTs = await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channelId, { text: `:brain: Thinking in workspace \`${workspaceSlugForThread}\`...` });

            let llmInputText = cleanedQuery.replace(WORKSPACE_OVERRIDE_REGEX, '').trim(); // Remove override from query
            const instruction = '\n\nIMPORTANT: Do not include context references (like "CONTEXT N"). Provide a clean answer.';
            llmInputText += instruction;

            console.log(`[Msg Handler] Querying LLM: Ws=${workspaceSlugForThread}, Thr=${anythingLLMThreadSlug}`);
            const rawReply = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, llmInputText); // Uses service
            if (!rawReply && rawReply !== "") throw new Error('LLM returned null/undefined response.'); // Allow empty string ""

             await updateOrDeleteThinkingMessage(Promise.resolve(currentThinkingTs), slack, channelId, null); // Delete thinking message

            // --- Process & Post LLM Response ---
            let isSubstantive = rawReply.trim().length >= MIN_SUBSTANTIVE_RESPONSE_LENGTH; // Basic length check
             // Add more checks for canned/non-substantive replies if needed
            if (isSubstantive) { console.log("[Msg Handler] Response deemed substantive."); } else { console.log("[Msg Handler] Response deemed non-substantive."); }

            const segments = extractTextAndCode(rawReply);
            let lastMessageTs = null;
            if (segments.length === 0 && rawReply.trim()) { // Handle cases where extraction fails but there was text
                 console.warn("[Msg Handler] No segments extracted, posting raw reply.");
                 const result = await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: rawReply });
                 lastMessageTs = result?.ts;
            } else { // Post segments
                for (let i = 0; i < segments.length; i++) { /* ... Post segments ... */
                    const segment = segments[i]; let blocks = []; let fb = '...';
                    if (segment.type === 'text' && segment.content?.trim()) { const b = markdownToRichTextBlock(segment.content); if(b){ blocks.push(b); fb = segment.content.substring(0,200); } }
                    else if (segment.type === 'code' && segment.content?.trim()) { const lang = segment.language || 'text'; const code = `\`\`\`${lang}\n${segment.content}\`\`\``; const b = markdownToRichTextBlock(code); if(b){ blocks.push(b); fb = `Code (${lang})`; } }
                    if(blocks.length === 0) continue;
                    try { const res = await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: fb, blocks: blocks }); lastMessageTs = res?.ts; } catch (e) { console.error(`[Msg Handler] Error posting segment ${i+1}:`, e.data?.error); }
                    if (segments.length > 1 && i < segments.length - 1) await new Promise(r => setTimeout(r, 500));
                }
            }

            // Post feedback if applicable
            if (lastMessageTs && isSubstantive) { /* ... Post feedback buttons ... */
                try {
                    const btns = [ { type: "button", text: { type: "plain_text", text: "👎", emoji: true }, style: "danger", value: "bad", action_id: "feedback_bad" }, { type: "button", text: { type: "plain_text", text: "👌", emoji: true }, value: "ok", action_id: "feedback_ok" }, { type: "button", text: { type: "plain_text", text: "👍", emoji: true }, style: "primary", value: "great", action_id: "feedback_great" }];
                    const block = [ { type: "divider" }, { type: "actions", block_id: `feedback_${originalTs}_${workspaceSlugForThread}`, elements: btns }];
                    await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: "Feedback:", blocks: block });
                } catch (e) { console.warn("[Msg Handler] Failed post feedback buttons:", e.data?.error); }
            }
            // --- End Response Processing ---

        } catch (error) { // Catch errors during LLM query or response posting
            console.error('[Msg Handler Error - Fallback Path]', error);
            await updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channelId, { text: `⚠️ Oops! Error: ${error.message}` });
            // Don't delete thinking message showing error
        } finally {
            console.log(`[Msg Handler - Fallback] Finished. Duration: ${Date.now() - handlerStartTime}ms`);
        }
    } else { // Command handled branch
        console.log(`[Msg Handler] 'gh>' command handled. Duration: ${Date.now() - handlerStartTime}ms`);
    }
}

// --- Helper to update/delete thinking message --- (Moved to commandHandler, keep one source eventually)
async function updateOrDeleteThinkingMessage(thinkingMessagePromise, slack, channel, updateArgs = null) {
    if (!thinkingMessagePromise) return;
    try { const ts = await thinkingMessagePromise; if (!ts) return; if (updateArgs) await slack.chat.update({ channel, ts, ...updateArgs }); else await slack.chat.delete({ channel, ts }); }
    catch (error) { console.warn(`[Util] Failed ${updateArgs ? 'update' : 'delete'} thinking msg:`, error.data?.error); }
}

console.log("[Message Handler] Initialized.");
