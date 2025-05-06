// src/handlers/messageHandler.js
// Handles regular messages and app mentions, routing to commands or LLM fallback.

import {
	botUserId,
	githubWorkspaceSlug,
	formatterWorkspaceSlug,
	MIN_SUBSTANTIVE_RESPONSE_LENGTH,
	GITHUB_OWNER,
	githubToken,
	COMMAND_PREFIX,
	WORKSPACE_OVERRIDE_COMMAND_PREFIX,
	FEEDBACK_SYSTEM_ENABLED,
	// Import new config flags for intent routing
	intentRoutingEnabled,
	intentConfidenceThreshold, fallbackWorkspace,
} from '../config.js';

// --- Service Imports ---
import {
    slackClient, // Needed for helper function
    getAnythingLLMThreadMapping,
    storeAnythingLLMThreadMapping,
    queryLlm,
    createNewAnythingLLMThread,
    determineWorkspace,
    detectIntentAndWorkspace,
	getWorkspaces
} from '../services/index.js';

// --- Utility Imports ---
import {
    markdownToRichTextBlock,
    extractTextAndCode,
} from '../utils/formattingService.js';

// --- Command Handler Imports ---
// Assume specific intent handlers might live here or in a dedicated file later
import {
    handleDeleteLastMessageCommand,
    handleReleaseInfoCommand,
    handlePrReviewCommand,
    handleIssueAnalysisCommand,
    handleGithubApiCommand,
    // --- Placeholder Intent Handlers (to be created) ---
    // handleGithubLookupIntent,
    // handleFaqIntent,
} from './commandHandler.js'; // Or import from './intentHandler.js' later
import { exportConversationToMarkdown } from '../features/conversationExport.js';

import strings from '../services/stringService.js';
// --- Command Patterns ---

const CMD_PREFIX = COMMAND_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape prefix
const RELEASE_REGEX = new RegExp(`^${CMD_PREFIX}\\s*latest\\s+(?<repo_id>[\\w.-]+(?:\\/[\\w.-]+)?)\\s*\\??$`, 'i');
const PR_REVIEW_REGEX = new RegExp(`^${CMD_PREFIX}\\s*review\\s+pr\\s+(?<owner>[\\w.-]+)\\/(?<repo>[\\w.-]+)#(?<pr_number>\\d+)\\s+#(?<workspace_slug>[\\w-]+)\\s*$`, 'i');
const ISSUE_ANALYSIS_REGEX = new RegExp(`^${CMD_PREFIX}\\s*(?:analyze|summarize|explain)\\s+issue\\s+(?:(?<owner>[\\w.-]+)\\/(?<repo>[\\w.-]+))?#(?<issue_number>\\d+)(?:\\s*#(?<workspace_slug>[\\w-]+))?(?:\\s+(?<user_prompt>.+))?\\s*$`, 'i');
const GENERIC_API_REGEX = new RegExp(`^${CMD_PREFIX}\\s*api\\s+(?<api_query>.+)\\s*$`, 'i');
const WORKSPACE_OVERRIDE_REGEX = new RegExp(`\\${WORKSPACE_OVERRIDE_COMMAND_PREFIX}(\\S+)`);

/**
 * Helper function to create a delay.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper to update or delete the initial "Processing..." message.
 * Uses the imported slackClient instance.
 * @param {Promise<string | null> | string | null} thinkingMessageTsOrPromise - TS string or Promise resolving to it.
 * @param {object} slack - Slack WebClient instance (passed down).
 * @param {string} channel - Channel ID.
 * @param {object | null} [updateArgs=null] - Arguments for chat.update (text, blocks), or null/undefined to delete.
 */
async function updateOrDeleteThinkingMessage(thinkingMessageTsOrPromise, slack, channel, updateArgs = null) {
    if (!thinkingMessageTsOrPromise) return;
    if (!slack || !channel) {
        console.error("[Util/updateOrDeleteThinkingMessage] Missing Slack client or channel ID.");
        return;
    }
    let ts = null;
    try {
        ts = await Promise.resolve(thinkingMessageTsOrPromise);
        if (!ts) return;
		await sleep( 100 );
        if (updateArgs && typeof updateArgs === 'object') {
            const updatePayload = { channel: channel, ts: ts, text: updateArgs.text || "Processing...", ...updateArgs };
            await slack.chat.update(updatePayload);
        } else {
            await slack.chat.delete({ channel: channel, ts: ts });
        }
    } catch (error) {
        if (error?.data?.error !== 'message_not_found' && error?.data?.error !== 'cant_update_message') {
            console.warn(`[Util] Failed to ${updateArgs ? 'update' : 'delete'} thinking message ${ts || '?'}:`, error.data?.error || error.message);
        }
    }
}


/**
 * Handles incoming message or app_mention events.
 * Checks for commands, then intent, otherwise routes to LLM fallback.
 * @param {object} event - The Slack event object.
 * @param {object} slack - The initialized Slack WebClient instance (passed down).
 * @param {object} octokit - The initialized Octokit instance (passed down).
 */
export async function handleSlackMessageEventInternal(event, slack, octokit) {
    const handlerStartTime = Date.now();
    const { user: userId, text: originalText = '', channel: channelId, ts: originalTs, thread_ts: threadTs } = event;

    // --- 1. Initial Processing & Context ---
    let rawQuery = originalText.trim();
    const mentionString = `<@${botUserId}>`;
    const isMentioned = rawQuery.includes(mentionString);
    let cleanedQuery = rawQuery.replace(mentionString, '').trim();
    const replyTarget = threadTs || originalTs;

    console.log(`[Msg Handler] Start: User=${userId}, Chan=${channelId}, TS=${originalTs}, Thread=${threadTs || 'None'}, Target=${replyTarget}, Mention=${isMentioned}, Query="${cleanedQuery}"`);

    if (!cleanedQuery) {
        console.log("[Msg Handler] Ignoring empty message after mention removal.");
        return;
    }

    // --- 2. Handle #delete_last_message Command ---
    if (cleanedQuery.toLowerCase().startsWith('#delete_last_message')) {
        console.log("[Msg Handler] Delete command detected.");
        await handleDeleteLastMessageCommand(channelId, replyTarget, botUserId, slack);
        console.log(`[Msg Handler] Delete handled. Duration: ${Date.now() - handlerStartTime}ms`);
        return;
    }

    // --- Handle #saveToConversations Command ---
    if (cleanedQuery.toLowerCase().startsWith('#remember')) {
        console.log("[Msg Handler] #remember command detected.");
        let savingMsgTs = null;
        try {
            const savingMsg = await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: ":floppy_disk: Saving conversation..." });
            savingMsgTs = savingMsg?.ts;

            await exportConversationToMarkdown(channelId, replyTarget, true); // true to upload to LLM

            if (savingMsgTs) {
                await slack.chat.update({ channel: channelId, ts: savingMsgTs, text: "✅ Logged for future use, anonymized and secure." });
            } else {
                await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: "✅ Logged for future use, anonymized and secure." });
            }
            console.log(`[Msg Handler] #remember handled. Duration: ${Date.now() - handlerStartTime}ms`);
            return; // Command handled, stop further processing
        } catch (exportError) {
            console.error("[Msg Handler] Error during #remember:", exportError);
            const errorText = `❌ Error saving conversation: ${exportError.message}`;
            if (savingMsgTs) {
                await slack.chat.update({ channel: channelId, ts: savingMsgTs, text: errorText }).catch(e => console.error("Error updating saving message with error:", e));
            } else {
                await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: errorText }).catch(e => console.error("Error posting export error message:", e));
            }
            return; // Stop further processing on error
        }
    }

    // --- 3. Post Initial Thinking Message ---
    let thinkingMessageTs = null;
    try {
        const thinkingMsg = await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: ":hourglass_flowing_sand: Processing..." });
        thinkingMessageTs = thinkingMsg?.ts;
        if (!thinkingMessageTs) { throw new Error("Failed to get timestamp from thinking message response."); }
    } catch (err) {
        console.error("[Msg Handler] Failed post initial thinking message:", err.data?.error || err.message);
        return;
    }

    // --- 4. Check for Specific `gh:` Commands ---
    let commandHandled = false; // Flag for explicit commands
    const isPotentialGhCommand = cleanedQuery.toLowerCase().startsWith(COMMAND_PREFIX);

    if (isPotentialGhCommand) {
        // Check GitHub configuration
        if (!githubToken) {
             await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❌ GitHub commands disabled (GITHUB_TOKEN not configured).` });
             return;
        }
        if (!octokit) {
            await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❌ GitHub client failed to initialize (check token/config).` });
            return;
        }

        let match;

        // --- Release Command ---
        match = cleanedQuery.match(RELEASE_REGEX);
        if (match?.groups?.repo_id) {
            console.log("[Msg Handler] Matched 'gh: latest'.");
            commandHandled = await handleReleaseInfoCommand(match.groups.repo_id, replyTarget, slack, octokit, thinkingMessageTs, channelId);
        }

        // --- PR Review Command ---
        if (!commandHandled) {
            match = cleanedQuery.match(PR_REVIEW_REGEX);
            if (match?.groups) {
                 console.log("[Msg Handler] Matched 'gh: review pr'.");
                 const { owner, repo, pr_number, workspace_slug } = match.groups;
                 const prNum = parseInt(pr_number, 10);
                 if (owner && repo && !isNaN(prNum) && workspace_slug) {
                     commandHandled = await handlePrReviewCommand( owner, repo, prNum, workspace_slug, replyTarget, channelId, slack, octokit, thinkingMessageTs );
                 } else {
                     console.warn("[Msg Handler] Invalid PR Review params:", match.groups);
                     await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❌ Invalid format. Use: \`gh: review pr owner/repo#number #workspace\`` });
                     commandHandled = true;
                 }
            }
        }

        // --- Issue Analysis Command ---
        if (!commandHandled) {
            match = cleanedQuery.match(ISSUE_ANALYSIS_REGEX);
            if (match?.groups) {
                 console.log("[Msg Handler] Matched 'gh: analyze issue'.");
                 const { owner = GITHUB_OWNER, repo = 'backlog', issue_number, workspace_slug: explicitWs, user_prompt } = match.groups;
                 const issueNum = parseInt(issue_number, 10);

                 if (!isNaN(issueNum)) {
                    let llmWs = null;
                    let llmThread = null;
                    try {
                        const mapping = await getAnythingLLMThreadMapping(channelId, replyTarget);
                        if (mapping) {
                            llmWs = explicitWs || mapping.anythingllm_workspace_slug;
                            llmThread = mapping.anythingllm_thread_slug;
                            console.log(`[Msg Handler - Issue Cmd] Using context (Explicit Ws: '${explicitWs || 'None'}', Mapped Ws: '${mapping.anythingllm_workspace_slug}'): Final Ws=${llmWs}, Thr=${llmThread}`);
                        } else {
                            if (explicitWs) {
                                llmWs = explicitWs;
                                console.log(`[Msg Handler - Issue Cmd] No mapping found, using explicit Ws: ${llmWs}`);
                            } else {
                                console.log(`[Msg Handler - Issue Cmd] No mapping or explicit Ws, determining workspace...`);
                                llmWs = await determineWorkspace({ suggestedWorkspace: null, userId, channelId });
                                console.log(`[Msg Handler - Issue Cmd] Determined Ws: ${llmWs}`);
                            }
                            if (!llmWs) throw new Error("Could not determine target workspace for issue analysis.");
                            llmThread = null; // Flag to trigger creation
                        }
                        if (!llmThread && llmWs) {
                             console.log(`[Msg Handler - Issue Cmd] Creating new thread in workspace: ${llmWs}`);
                             llmThread = await createNewAnythingLLMThread(llmWs);
                             if (!llmThread) throw new Error(`Failed to create thread in ${llmWs}.`);
                             await storeAnythingLLMThreadMapping(channelId, replyTarget, llmWs, llmThread);
                             console.log(`[Msg Handler - Issue Cmd] Created and stored new mapping: ${llmWs}:${llmThread}`);
                        } else if (!llmWs) {
                            throw new Error("Workspace could not be determined for thread creation.");
                        }
                        commandHandled = await handleIssueAnalysisCommand( owner, repo, issueNum, user_prompt || null, replyTarget, channelId, slack, octokit, thinkingMessageTs, llmWs, llmThread );
                    } catch (contextError) {
                         console.error("[Msg Handler-IssueCmd] Context/Thread Setup Error:", contextError);
                         await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❌ Error setting up context for issue analysis: ${contextError.message}` });
                         commandHandled = true;
                    }
                 } else {
                     console.warn("[Msg Handler] Invalid Issue Analysis number:", match.groups.issue_number);
                     await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❌ Invalid issue number. Use format: \`gh: analyze issue [#123 | owner/repo#123] [#optional-ws]\`` });
                     commandHandled = true;
                 }
            }
        }

        // --- Generic API Command ---
        if (!commandHandled) {
            match = cleanedQuery.match(GENERIC_API_REGEX);
            if (match?.groups?.api_query) {
                console.log("[Msg Handler] Matched generic 'gh: api'.");
                commandHandled = await handleGithubApiCommand( match.groups.api_query, replyTarget, channelId, slack, thinkingMessageTs, githubWorkspaceSlug, formatterWorkspaceSlug );
            }
        }

        // --- Unknown gh: Command ---
        if (isPotentialGhCommand && !commandHandled) {
             console.warn(`[Msg Handler] Unknown command starting with '${COMMAND_PREFIX}': ${cleanedQuery}`);
             await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❓ Unknown command. Type \`@Orbit help\` for options.` });
             // No return here, might fall through to intent/LLM
        }
    } // End of `if (isPotentialGhCommand)`

    // --- 5. Workspace Override & Intent Detection / LLM Fallback ---
    if (commandHandled) {
        console.log(`[Msg Handler] Explicit gh: command handled. Duration: ${Date.now() - handlerStartTime}ms`);
        return; // Explicit gh: command was handled, stop.
    }

    if (!commandHandled) {
        console.log("[Msg Handler] No command matched. Proceeding with Intent Detection -> Routing -> LLM query.");

        let finalWorkspaceSlug = null;
        let anythingLLMThreadSlug = null;
        let intentDetectionResult = null;
        let intentHandled = false; // Flag to track if a specific intent handler ran

        try {
            // --- Step 5a: Intent Detection ---
            console.log("[Msg Handler] Running Intent Detection...");
			const availableWorkSpaces = await getWorkspaces( true );
            intentDetectionResult = await detectIntentAndWorkspace(cleanedQuery, [], availableWorkSpaces );
            const { intent, confidence, suggestedWorkspace } = intentDetectionResult;
			console.log({ intent, confidence, suggestedWorkspace } );
            // --- Step 5b: Intent-Based Routing ---
            if (intentRoutingEnabled && intent && confidence >= intentConfidenceThreshold) {
                console.log(`[Msg Handler] Intent detected: '${intent}' (Confidence: ${confidence.toFixed(2)}). Attempting routing.`);
                // Prepare context for potential intent handlers
                const intentContext = {
                    query: cleanedQuery,
                    userId, channelId, replyTarget, originalTs, threadTs,
                    slack, octokit, thinkingMessageTs,
                    intentResult // Pass the full result
                };

                switch (intent) {
                    case 'github_issue_lookup': // Example Intent
                        console.log(`[Msg Handler] Routing to 'github_issue_lookup' handler.`);
                        // Placeholder: You need to create and import handleGithubLookupIntent
                        // intentHandled = await handleGithubLookupIntent(intentContext);
                        console.warn("Placeholder: `handleGithubLookupIntent` not implemented.");
                        await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `🚧 Intent '${intent}' handler not implemented yet.`});
                        intentHandled = true; // Mark as handled (even if stubbed) to prevent fallback
                        break;
                    case 'ask_faq': // Example Intent
                         console.log(`[Msg Handler] Routing to 'ask_faq' handler.`);
                         // Placeholder: You need to create and import handleFaqIntent
                         // intentHandled = await handleFaqIntent(intentContext);
                         console.warn("Placeholder: `handleFaqIntent` not implemented.");
                         await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `🚧 Intent '${intent}' handler not implemented yet.`});
                         intentHandled = true; // Mark as handled
                         break;
                    // Add cases for other specific intents you want to handle directly
                    default:
                        console.log(`[Msg Handler] Intent '${intent}' detected but no specific handler defined. Proceeding to LLM.`);
                        intentHandled = false; // Fall through to default LLM query
                }
            } else {
                 // Intent routing disabled, no intent detected, or confidence too low
                 if (intent) {
                     console.log(`[Msg Handler] Intent detected: '${intent}' (Confidence: ${confidence.toFixed(2)}), but routing conditions not met (Enabled: ${intentRoutingEnabled}, Threshold: ${intentConfidenceThreshold}). Proceeding to LLM.`);
                 } else {
                     console.log(`[Msg Handler] No specific intent detected or routing disabled. Proceeding to LLM.`);
                 }
                 intentHandled = false;
            }

            // --- Step 5c: Default LLM Query Path (if no specific intent was handled) ---
            if (!intentHandled) {
                console.log("[Msg Handler] Determining workspace for LLM query...");
                // Determine workspace using suggestion from intent detection (even if intent wasn't routed)
                finalWorkspaceSlug = await determineWorkspace({
                    suggestedWorkspace: suggestedWorkspace, // Use suggestion from step 5a
                    userId,
                    channelId
                });

                if (!finalWorkspaceSlug) {
                    throw new Error("Could not determine a valid workspace. Check configuration (mappings, fallback) and LLM workspace availability.");
                }
                console.log(`[Msg Handler] Final workspace determined for LLM: ${finalWorkspaceSlug}`);

                // Get/Create Thread Mapping
                console.log("[Msg Handler] Checking/Updating thread mapping for LLM query...");
                const mapping = await getAnythingLLMThreadMapping(channelId, replyTarget);
                let historyForLlm = "";
                let llmInputText = cleanedQuery.replace(WORKSPACE_OVERRIDE_REGEX, '').trim();
                let rawReply, trimmedReply;

                if (mapping && mapping.anythingllm_workspace_slug === finalWorkspaceSlug) {
                    // If using existing thread in same workspace - the LLM API maintains history
                    anythingLLMThreadSlug = mapping.anythingllm_thread_slug;
                    console.log(`[Msg Handler] Using existing thread mapping for LLM: ${finalWorkspaceSlug}:${anythingLLMThreadSlug}`);

                    // Just send the clean message without history, User: prefix, or instruction
                    console.log(`[Msg Handler] Querying LLM with existing thread: Ws=${finalWorkspaceSlug}, Thr=${anythingLLMThreadSlug}, Input Length=${llmInputText.length}`);

                } else if (mapping && finalWorkspaceSlug === fallbackWorkspace) {
                    // Reset to original mapping if consequent questions were marked as fallback, unless intentionally (Add check)
                    anythingLLMThreadSlug = mapping.anythingllm_thread_slug;
                    finalWorkspaceSlug = mapping.anythingllm_workspace_slug;
                    console.log(`[Msg Handler] Resting to existing thread mapping for LLM: ${finalWorkspaceSlug}:${anythingLLMThreadSlug}`);

                    // Just send the clean message without history, User: prefix, or instruction
                    console.log(`[Msg Handler] Querying LLM with existing thread: Ws=${finalWorkspaceSlug}, Thr=${anythingLLMThreadSlug}, Input Length=${llmInputText.length}`);

                } else {
                    // Creating a new thread (due to workspace change or first message)
                    if (mapping) {
                        console.log(`[Msg Handler] Workspace changed for LLM (Mapped: ${mapping.anythingllm_workspace_slug}, Determined: ${finalWorkspaceSlug}). Creating new thread.`);
                    } else {
                        console.log(`[Msg Handler] No existing thread mapping found for LLM. Creating new thread.`);
                    }

                    // --- Fetch History for Context ---
                    // Only fetch history if this is a reply in a thread (not a brand new conversation)
                    // and there was a workspace change (mapping exists)
                    if (threadTs && mapping) {
                        try {
                            console.log(`[Msg Handler] Fetching history for new thread context from channel ${channelId}, thread ${replyTarget}`);
                            const historyResult = await slack.conversations.replies({
                                channel: channelId,
                                ts: replyTarget,
                                limit: 20 // Fetch last 20 messages in the thread
                            });
                            if (historyResult.ok && historyResult.messages && historyResult.messages.length > 1) {
                                // Skip the first message (thread starter) and format the rest
                                // Filter out "Processing..." messages and format the others
                                historyForLlm = historyResult.messages.slice(1)
                                    .filter(msg => !(msg.text || '').includes(':hourglass_flowing_sand: Processing'))
                                    .map(msg => {
                                        const prefix = (msg.user === botUserId || msg.bot_id) ? "Assistant:" : "User:";
                                        // Extract text, handling potential blocks structure later if needed
                                        const msgText = (msg.text || '').replace(/<@[^>]+>/g, '').trim(); // Basic mention removal
                                        return `${prefix} ${msgText}`;
                                    }).join("\n");
                                console.log(`[Msg Handler] Fetched ${historyResult.messages.length - 1} history messages. Total length: ${historyForLlm.length}`);
                                // Add the current user's message to history with User: prefix
                                historyForLlm += "\n\nUser: " + llmInputText;
                                // Use the history as the input
                                llmInputText = historyForLlm;
                            } else {
                               console.warn("[Msg Handler] Could not fetch significant history for new thread:", historyResult.error || 'No messages found');
                            }
                        } catch (histError) {
                            console.error("[Msg Handler] Error fetching thread history:", histError);
                            // Proceed without history if fetching fails
                        }
                    } else {
                        console.log(`[Msg Handler] Skipping history fetch for brand new thread (Thread TS: ${threadTs ? 'exists' : 'none'}, Mapping: ${mapping ? 'exists' : 'none'})`);
                    }
                    // --- End History Fetch ---

                    anythingLLMThreadSlug = await createNewAnythingLLMThread(finalWorkspaceSlug);
                    if (!anythingLLMThreadSlug) { throw new Error(`Failed to create new thread in workspace ${finalWorkspaceSlug}. Check LLM API status and workspace slug validity.`); }

                    await storeAnythingLLMThreadMapping(channelId, replyTarget, finalWorkspaceSlug, anythingLLMThreadSlug);
                    console.log(`[Msg Handler] Created/Updated thread mapping for LLM: ${finalWorkspaceSlug}:${anythingLLMThreadSlug}`);

                    console.log(`[Msg Handler] Querying LLM with new thread: Ws=${finalWorkspaceSlug}, Thr=${anythingLLMThreadSlug}, Input Length=${llmInputText.length} (History included: ${!!historyForLlm})`);
                }

                // --- Step 5d: Query LLM (common for all scenarios) ---
                await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: strings.getWorkplaceThinkingString(finalWorkspaceSlug) });

                rawReply = await queryLlm(finalWorkspaceSlug, anythingLLMThreadSlug, llmInputText);
                trimmedReply = typeof rawReply === 'string' ? rawReply.trim() : "";

                // --- Step 5e: Process & Post LLM Response ---
                if (!trimmedReply) {
                    console.log("[Msg Handler] LLM returned empty response.");
                    await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: "_(I received an empty response. Please try rephrasing your query.)_" });
                    // No return needed here, flow ends
                } else {
                    console.log(`[Msg Handler] LLM raw response length: ${rawReply.length}, Trimmed: ${trimmedReply.length}`);
                    let isSubstantive = trimmedReply.length >= MIN_SUBSTANTIVE_RESPONSE_LENGTH;
                    if (isSubstantive) { console.log("[Msg Handler] Response deemed substantive."); } else { console.log("[Msg Handler] Response deemed non-substantive."); }

                    const segments = extractTextAndCode(trimmedReply);

                    let lastMessageTs = null;

                    if (segments.length === 0) {
                        console.warn("[Msg Handler] No segments extracted from non-empty reply, posting raw trimmed reply.");
                        const block = markdownToRichTextBlock(trimmedReply);
                        const result = await slack.chat.postMessage({
                            channel: channelId, thread_ts: replyTarget,
                            text: trimmedReply.substring(0, 200) + (trimmedReply.length > 200 ? '...' : ''),
                            ...(block ? { blocks: [block] } : { text: trimmedReply })
                        });
                        lastMessageTs = result?.ts;
                    } else {
                        for (let i = 0; i < segments.length; i++) {
                            // (Segment posting logic remains the same as previous version)
                            const segment = segments[i];
                            let segmentText = '';
                            let fallbackText = '...';
                            if (segment.type === 'text' && segment.content?.trim()) {
                                segmentText = segment.content.trim();
                                fallbackText = segmentText.substring(0, 200) + (segmentText.length > 200 ? '...' : '');
                            } else if (segment.type === 'code' && segment.content?.trim()) {
                                const lang = segment.language || '';
                                segmentText = '```' + lang + '\n' + segment.content.trim() + '\n```';
                                fallbackText = `Code block (${lang || 'unknown'})`;
                            }
                            if (!segmentText) continue;
                            const block = markdownToRichTextBlock(segmentText);
                            try {
                                const postArgs = { channel: channelId, thread_ts: replyTarget, text: fallbackText };
                                if (block) { postArgs.blocks = [block]; }
                                else { console.warn(`[Msg Handler] Failed block for seg ${i+1}. Posting raw.`); postArgs.text = segmentText; }
                                const res = await slack.chat.postMessage(postArgs);
                                lastMessageTs = res?.ts;
                            } catch (e) {
                                console.error(`[Msg Handler] Error posting seg ${i+1} (Block: ${!!block}):`, e.data?.error || e.message);
                                if (block) { try { const res = await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: segmentText }); lastMessageTs = res?.ts; } catch (e2) { /* ignore retry error */ } }
                            }
                            if (segments.length > 1 && i < segments.length - 1) { await new Promise(resolve => setTimeout(resolve, 500)); }
                        }
                    }

                    // --- Step 5f: Post Feedback Buttons ---
                    if (lastMessageTs && isSubstantive && FEEDBACK_SYSTEM_ENABLED ) {
                        try {
                            const feedbackButtons = [
                                 { type: "button", text: { type: "plain_text", text: "👎", emoji: true }, style: "danger", value: "bad", action_id: "feedback_bad" },
                                 { type: "button", text: { type: "plain_text", text: "👌", emoji: true }, value: "ok", action_id: "feedback_ok" },
                                 { type: "button", text: { type: "plain_text", text: "👍", emoji: true }, style: "primary", value: "great", action_id: "feedback_great" }
                            ];
                            const feedbackBlock = [
                                 { type: "divider" },
                                 { type: "actions", block_id: `feedback_${originalTs}_${finalWorkspaceSlug}`, elements: feedbackButtons }
                            ];
                            await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: "Was this response helpful?", blocks: feedbackBlock });
                        } catch (e) { console.warn("[Msg Handler] Failed post feedback buttons:", e.data?.error || e.message); }
                    }
                } // End if (!trimmedReply)

                await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, null); // Delete thinking message
                thinkingMessageTs = null; // Mark as deleted

            } // End if (!intentHandled)

        } catch (error) { // Catch errors from context setup or LLM query/response path
            console.error('[Msg Handler Error - Intent/LLM Path]', error);
            if (thinkingMessageTs) { // Check if thinking message still exists
                 await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `⚠️ Oops! An error occurred: ${error.message}` });
                 thinkingMessageTs = null; // Mark as handled
            } else {
                 await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `⚠️ Oops! An error occurred: ${error.message}` }).catch(()=>{});
            }
        } finally {
            // Final cleanup for thinking message if it somehow wasn't deleted
            if (thinkingMessageTs) {
                 await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, null);
            }
            console.log(`[Msg Handler] LLM Fallback processing complete. Duration: ${Date.now() - handlerStartTime}ms`);
        }
    }
}

console.log("[Message Handler] Initialized.");
