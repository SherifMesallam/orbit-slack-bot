// src/handlers/messageHandler.js
// Handles regular messages and app mentions, routing to commands or LLM fallback.

import {
    botUserId,
    githubWorkspaceSlug, // Still needed for gh> api default
    formatterWorkspaceSlug, // Still needed for gh> api default
    MIN_SUBSTANTIVE_RESPONSE_LENGTH,
    GITHUB_OWNER, // Still needed for gh> analyze default
    githubToken, // Still needed for command checks
    COMMAND_PREFIX,
    WORKSPACE_OVERRIDE_COMMAND_PREFIX, // Kept for reference/potential future use
    // Add config flags relevant to intent detection if needed later
    intentRoutingEnabled,
    intentConfidenceThreshold,
} from '../config.js';

// --- Service Imports ---
// Import only necessary functions from each service via the index
import {
    slackClient, // Needed for helper function
    getAnythingLLMThreadMapping,
    storeAnythingLLMThreadMapping,
    queryLlm,
    createNewAnythingLLMThread,
    determineWorkspace,
    // getWorkspaces, // Only needed if passing to intent detection explicitly
    detectIntentAndWorkspace
} from '../services/index.js'; // Use the central service index

// --- Utility Imports ---
import {
    markdownToRichTextBlock,
    extractTextAndCode,
} from '../utils/formattingService.js';

// --- Command Handler Imports ---
import {
    handleDeleteLastMessageCommand,
    handleReleaseInfoCommand,
    handlePrReviewCommand,
    handleIssueAnalysisCommand,
    handleGithubApiCommand
} from './commandHandler.js';

// --- Command Patterns ---
const CMD_PREFIX = COMMAND_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape prefix
const RELEASE_REGEX = new RegExp(`^${CMD_PREFIX}\\s*release\\s+(?<repo_id>[\\w.-]+(?:\\/[\\w.-]+)?)\\s*$`, 'i');
const PR_REVIEW_REGEX = new RegExp(`^${CMD_PREFIX}\\s*review\\s+pr\\s+(?<owner>[\\w.-]+)\\/(?<repo>[\\w.-]+)#(?<pr_number>\\d+)\\s+#(?<workspace_slug>[\\w-]+)\\s*$`, 'i');
// Updated Regex: Workspace is now OPTIONAL in the command itself for issue analysis
const ISSUE_ANALYSIS_REGEX = new RegExp(`^${CMD_PREFIX}\\s*(?:analyze|summarize|explain)\\s+issue\\s+(?:(?<owner>[\\w.-]+)\\/(?<repo>[\\w.-]+))?#(?<issue_number>\\d+)(?:\\s*#(?<workspace_slug>[\\w-]+))?(?:\\s+(?<user_prompt>.+))?\\s*$`, 'i');
const GENERIC_API_REGEX = new RegExp(`^${CMD_PREFIX}\\s*api\\s+(?<api_query>.+)\\s*$`, 'i');
// Workspace override prefix - not directly used for routing anymore but pattern kept
const WORKSPACE_OVERRIDE_REGEX = new RegExp(`\\${WORKSPACE_OVERRIDE_COMMAND_PREFIX}(\\S+)`);


/**
 * Helper to update or delete the initial "Processing..." message.
 * Uses the imported slackClient instance.
 * @param {Promise<string | null> | string | null} thinkingMessageTsOrPromise - TS string or Promise resolving to it.
 * @param {object} slack - Slack WebClient instance (passed down).
 * @param {string} channel - Channel ID.
 * @param {object | null} [updateArgs=null] - Arguments for chat.update (text, blocks), or null/undefined to delete.
 */
async function updateOrDeleteThinkingMessage(thinkingMessageTsOrPromise, slack, channel, updateArgs = null) {
    if (!thinkingMessageTsOrPromise) return; // No TS or promise provided
    if (!slack || !channel) {
        console.error("[Util/updateOrDeleteThinkingMessage] Missing Slack client or channel ID.");
        return;
    }

    let ts = null;
    try {
        // Resolve the promise if it is one, otherwise use the string directly
        ts = await Promise.resolve(thinkingMessageTsOrPromise);

        if (!ts) {
             // console.warn("[Util] No thinking message TS resolved or provided.");
             return; // No TS was resolved/provided
        }

        if (updateArgs && typeof updateArgs === 'object') {
            // Ensure text is always provided for updates, fallback if missing
            const updatePayload = {
                channel: channel,
                ts: ts,
                text: updateArgs.text || "Processing...", // Default text
                ...updateArgs // Spread other args like blocks
            };
            await slack.chat.update(updatePayload);
            // console.log(`[Util] Updated thinking message ${ts}.`);
        } else {
            // Delete the message
            await slack.chat.delete({ channel: channel, ts: ts });
            // console.log(`[Util] Deleted thinking message ${ts}.`);
        }
    } catch (error) {
        // Avoid logging common errors like message_not_found or cant_update_message
        if (error?.data?.error !== 'message_not_found' && error?.data?.error !== 'cant_update_message') {
            console.warn(`[Util] Failed to ${updateArgs ? 'update' : 'delete'} thinking message ${ts || '?'}:`, error.data?.error || error.message);
        }
    }
}


/**
 * Handles incoming message or app_mention events.
 * Checks for commands, otherwise routes to intent detection & LLM.
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
    // Remove mention for cleaner processing
    let cleanedQuery = rawQuery.replace(mentionString, '').trim();
    const replyTarget = threadTs || originalTs; // Reply in thread if available

    console.log(`[Msg Handler] Start: User=${userId}, Chan=${channelId}, TS=${originalTs}, Thread=${threadTs || 'None'}, Target=${replyTarget}, Mention=${isMentioned}, Query="${cleanedQuery}"`);

    // Ignore empty messages after cleaning
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

    // --- 3. Post Initial Thinking Message ---
    let thinkingMessageTs = null;
    try {
        const thinkingMsg = await slack.chat.postMessage({
             channel: channelId, thread_ts: replyTarget, text: ":hourglass_flowing_sand: Processing..."
        });
        thinkingMessageTs = thinkingMsg?.ts;
        if (!thinkingMessageTs) { throw new Error("Failed to get timestamp from thinking message response."); }
    } catch (err) {
        console.error("[Msg Handler] Failed post initial thinking message:", err.data?.error || err.message);
        // Cannot proceed reliably without a thinking message to update/delete
        return;
    }

    // --- 4. Check for Specific `gh>` Commands ---
    let commandHandled = false;
    const isPotentialGhCommand = cleanedQuery.toLowerCase().startsWith(COMMAND_PREFIX);

    if (isPotentialGhCommand) {
        // Check GitHub configuration before proceeding with commands
        if (!githubToken) {
             await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❌ GitHub commands disabled (GITHUB_TOKEN not configured).` });
             return;
        }
        if (!octokit) {
            await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❌ GitHub client failed to initialize (check token/config).` });
            return;
        }

        let match; // Reusable variable for regex matches

        // --- Release Command ---
        match = cleanedQuery.match(RELEASE_REGEX);
        if (match?.groups?.repo_id) {
            console.log("[Msg Handler] Matched 'gh> release'.");
            // Pass thinkingMessageTs directly (it's not a promise anymore here)
            commandHandled = await handleReleaseInfoCommand(match.groups.repo_id, replyTarget, slack, octokit, thinkingMessageTs, channelId);
        }

        // --- PR Review Command ---
        if (!commandHandled) {
            match = cleanedQuery.match(PR_REVIEW_REGEX);
            if (match?.groups) {
                 console.log("[Msg Handler] Matched 'gh> review pr'.");
                 const { owner, repo, pr_number, workspace_slug } = match.groups;
                 const prNum = parseInt(pr_number, 10);
                 if (owner && repo && !isNaN(prNum) && workspace_slug) {
                     // PR Review command explicitly defines the workspace.
                     commandHandled = await handlePrReviewCommand( owner, repo, prNum, workspace_slug, replyTarget, channelId, slack, octokit, thinkingMessageTs );
                 } else {
                     console.warn("[Msg Handler] Invalid PR Review params:", match.groups);
                     await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❌ Invalid format. Use: \`gh> review pr owner/repo#number #workspace\`` });
                     commandHandled = true; // Mark as handled (error reported)
                 }
            }
        }

        // --- Issue Analysis Command ---
        if (!commandHandled) {
            match = cleanedQuery.match(ISSUE_ANALYSIS_REGEX);
            if (match?.groups) {
                 console.log("[Msg Handler] Matched 'gh> analyze issue'.");
                 const { owner = GITHUB_OWNER, repo = 'backlog', issue_number, workspace_slug: explicitWs, user_prompt } = match.groups;
                 const issueNum = parseInt(issue_number, 10);

                 if (!isNaN(issueNum)) {
                    let llmWs = null;
                    let llmThread = null; // Thread slug for LLM context

                    try {
                        // Check for existing thread mapping first
                        const mapping = await getAnythingLLMThreadMapping(channelId, replyTarget);

                        if (mapping) {
                            // Use mapped workspace unless overridden by explicit #workspace in command
                            llmWs = explicitWs || mapping.anythingllm_workspace_slug;
                            llmThread = mapping.anythingllm_thread_slug;
                            console.log(`[Msg Handler - Issue Cmd] Using context (Explicit Ws: '${explicitWs || 'None'}', Mapped Ws: '${mapping.anythingllm_workspace_slug}'): Final Ws=${llmWs}, Thr=${llmThread}`);
                            // Note: If explicitWs differs from mapped Ws, we currently use the mapped thread ID.
                            // Consider if a new thread should be created in the explicitWs instead.
                        } else {
                            // No mapping exists. Determine workspace.
                            if (explicitWs) {
                                llmWs = explicitWs; // Use explicitly provided workspace
                                console.log(`[Msg Handler - Issue Cmd] No mapping found, using explicit Ws: ${llmWs}`);
                            } else {
                                // No mapping and no explicit workspace, determine based on context
                                console.log(`[Msg Handler - Issue Cmd] No mapping or explicit Ws, determining workspace...`);
                                llmWs = await determineWorkspace({ suggestedWorkspace: null, userId, channelId }); // No suggestion for commands
                                console.log(`[Msg Handler - Issue Cmd] Determined Ws: ${llmWs}`);
                            }

                            // If we couldn't determine a workspace, we can't proceed.
                            if (!llmWs) throw new Error("Could not determine target workspace for issue analysis.");

                            // Force creation of a new thread since no mapping existed
                            llmThread = null; // Flag to trigger creation below
                        }

                        // Create a new thread if llmThread is null (and we have a workspace)
                        if (!llmThread && llmWs) {
                             console.log(`[Msg Handler - Issue Cmd] Creating new thread in workspace: ${llmWs}`);
                             llmThread = await createNewAnythingLLMThread(llmWs);
                             if (!llmThread) throw new Error(`Failed to create thread in ${llmWs}.`);
                             // Store the new mapping
                             await storeAnythingLLMThreadMapping(channelId, replyTarget, llmWs, llmThread);
                             console.log(`[Msg Handler - Issue Cmd] Created and stored new mapping: ${llmWs}:${llmThread}`);
                        } else if (!llmWs) {
                            // Should be caught earlier, but safeguard
                            throw new Error("Workspace could not be determined for thread creation.");
                        }

                        // Execute the command handler with the determined context
                        commandHandled = await handleIssueAnalysisCommand( owner, repo, issueNum, user_prompt || null, replyTarget, channelId, slack, octokit, thinkingMessageTs, llmWs, llmThread );

                    } catch (contextError) {
                         // Catch errors during workspace/thread determination or creation
                         console.error("[Msg Handler-IssueCmd] Context/Thread Setup Error:", contextError);
                         await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❌ Error setting up context for issue analysis: ${contextError.message}` });
                         commandHandled = true; // Mark as handled (error reported)
                    }
                 } else {
                     // Invalid issue number provided in the command
                     console.warn("[Msg Handler] Invalid Issue Analysis number:", match.groups.issue_number);
                     await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❌ Invalid issue number. Use format: \`gh> analyze issue [#123 | owner/repo#123] [#optional-ws]\`` });
                     commandHandled = true; // Mark as handled (error reported)
                 }
            }
        }

        // --- Generic API Command ---
        if (!commandHandled) {
            match = cleanedQuery.match(GENERIC_API_REGEX);
            if (match?.groups?.api_query) {
                console.log("[Msg Handler] Matched generic 'gh> api'.");
                // Uses specifically configured workspaces from config.js, not context-derived ones.
                commandHandled = await handleGithubApiCommand( match.groups.api_query, replyTarget, channelId, slack, thinkingMessageTs, githubWorkspaceSlug, formatterWorkspaceSlug );
            }
        }

        // --- Unknown gh> Command ---
        if (isPotentialGhCommand && !commandHandled) {
             // If the text started with the prefix but didn't match any known command
             console.warn(`[Msg Handler] Unknown command starting with '${COMMAND_PREFIX}': ${cleanedQuery}`);
             await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `❓ Unknown command. Try \`gh> release ...\`, \`gh> review ...\`, \`gh> analyze ...\`, or \`gh> api ...\`.` });
             commandHandled = true; // Mark as handled (error reported)
        }
    } // End of `if (isPotentialGhCommand)`

    // --- 5. Fallback: Intent Detection & LLM Query ---
    if (!commandHandled) {
        console.log("[Msg Handler] No command matched. Proceeding with Intent Detection -> LLM query.");

        let finalWorkspaceSlug = null;
        let anythingLLMThreadSlug = null;
        let intentDetectionResult = null;

        try {
            // --- Step 5a: Intent Detection ---
            // Future: Conditionally run based on config.intentRoutingEnabled flag.
            console.log("[Msg Handler] Running Intent Detection...");
            // Pass the cleaned query. Providers might need available workspaces/intents in future.
            intentDetectionResult = await detectIntentAndWorkspace(cleanedQuery);
            // TODO: Implement routing based on intent/confidence later if needed.

            // --- Step 5b: Determine Final Workspace ---
            console.log("[Msg Handler] Determining final workspace...");
            finalWorkspaceSlug = await determineWorkspace({
                suggestedWorkspace: intentDetectionResult.suggestedWorkspace, // Use suggestion from intent
                userId,
                channelId
            });

            // If workspace determination fails, we cannot proceed with an LLM query.
            if (!finalWorkspaceSlug) {
                throw new Error("Could not determine a valid workspace. Check configuration (mappings, fallback) and LLM workspace availability.");
            }
            console.log(`[Msg Handler] Final workspace determined: ${finalWorkspaceSlug}`);

            // --- Step 5c: Get/Create Thread Mapping ---
            console.log("[Msg Handler] Checking/Updating thread mapping...");
            const mapping = await getAnythingLLMThreadMapping(channelId, replyTarget);

            if (mapping && mapping.anythingllm_workspace_slug === finalWorkspaceSlug) {
                // Existing mapping matches the determined workspace, use it.
                anythingLLMThreadSlug = mapping.anythingllm_thread_slug;
                console.log(`[Msg Handler] Using existing thread mapping: ${finalWorkspaceSlug}:${anythingLLMThreadSlug}`);
            } else {
                // No mapping, or mapping workspace differs from the determined one. Create new thread.
                if (mapping) {
                   console.log(`[Msg Handler] Workspace changed (Mapped: ${mapping.anythingllm_workspace_slug}, Determined: ${finalWorkspaceSlug}). Creating new thread in determined workspace.`);
                } else {
                   console.log(`[Msg Handler] No existing thread mapping found. Creating new thread.`);
                }
                // Create a new thread in the final determined workspace.
                anythingLLMThreadSlug = await createNewAnythingLLMThread(finalWorkspaceSlug);
                if (!anythingLLMThreadSlug) {
                    // If thread creation fails, it's a significant issue with the LLM API or workspace.
                    throw new Error(`Failed to create new thread in workspace ${finalWorkspaceSlug}. Check LLM API status and workspace slug validity.`);
                }
                // Store/update the mapping with the new thread in the determined workspace.
                await storeAnythingLLMThreadMapping(channelId, replyTarget, finalWorkspaceSlug, anythingLLMThreadSlug);
                console.log(`[Msg Handler] Created/Updated thread mapping: ${finalWorkspaceSlug}:${anythingLLMThreadSlug}`);
            }

        } catch (contextError) {
             // Errors during intent/workspace/thread setup are critical.
             console.error("[Msg Handler] Context Setup Error:", contextError);
             await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `⚠️ Error setting up context: ${contextError.message}` });
             return; // Stop processing this event
        }

        // --- Step 5d: Query LLM ---
        try {
            // Update thinking message to show the final workspace being used.
            await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `:brain: Thinking in workspace \`${finalWorkspaceSlug}\`...` });

            // Prepare LLM input - remove potential override prefix if user still included it.
            // The override logic is now handled by determineWorkspace based on mappings/fallback.
            let llmInputText = cleanedQuery.replace(WORKSPACE_OVERRIDE_REGEX, '').trim();
            // Add instruction for clean output formatting suitable for Slack.
            const instruction = '\n\nIMPORTANT: Provide a clean answer without referencing internal context markers (like "CONTEXT N"). Format your response using Slack markdown (bold, italics, code blocks, links).';
            llmInputText += instruction;

            console.log(`[Msg Handler] Querying LLM: Ws=${finalWorkspaceSlug}, Thr=${anythingLLMThreadSlug}, Input Length=${llmInputText.length}`);
            const rawReply = await queryLlm(finalWorkspaceSlug, anythingLLMThreadSlug, llmInputText);
            const trimmedReply = typeof rawReply === 'string' ? rawReply.trim() : ""; // Ensure it's a string and trim

            // Delete the "Thinking..." message *before* posting the reply
            await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, null);
            thinkingMessageTs = null; // Mark as deleted so finally block doesn't try again

            // --- Step 5e: Process & Post LLM Response ---
            if (!trimmedReply) {
                console.log("[Msg Handler] LLM returned empty response.");
                // Post a message indicating no response was generated.
                 await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: "_(I received an empty response. Please try rephrasing your query.)_" });
                 return; // Nothing more to do
            }

            console.log(`[Msg Handler] LLM raw response length: ${rawReply.length}, Trimmed: ${trimmedReply.length}`);
            let isSubstantive = trimmedReply.length >= MIN_SUBSTANTIVE_RESPONSE_LENGTH;
            if (isSubstantive) { console.log("[Msg Handler] Response deemed substantive."); } else { console.log("[Msg Handler] Response deemed non-substantive."); }

            // Use formatting service to split into potential text/code segments and format
            const segments = extractTextAndCode(trimmedReply);
            let lastMessageTs = null; // Track the TS of the last posted message part

            if (segments.length === 0) {
                 // This case should ideally not happen if trimmedReply is non-empty,
                 // but handle it by posting the raw reply if segment extraction fails.
                 console.warn("[Msg Handler] No segments extracted from non-empty reply, posting raw trimmed reply.");
                 const block = markdownToRichTextBlock(trimmedReply); // Attempt to format whole reply
                 const result = await slack.chat.postMessage({
                     channel: channelId,
                     thread_ts: replyTarget,
                     text: trimmedReply.substring(0, 200) + (trimmedReply.length > 200 ? '...' : ''), // Fallback text
                     ...(block ? { blocks: [block] } : { text: trimmedReply }) // Use block if created, else raw text
                 });
                 lastMessageTs = result?.ts;
            } else {
                // Post each segment, attempting block formatting
                for (let i = 0; i < segments.length; i++) {
                    const segment = segments[i];
                    let segmentText = ''; // The formatted text for the block/message
                    let fallbackText = '...'; // Fallback text for notifications

                    // Prepare text based on segment type
                    if (segment.type === 'text' && segment.content?.trim()) {
                        segmentText = segment.content.trim();
                        fallbackText = segmentText.substring(0, 200) + (segmentText.length > 200 ? '...' : '');
                    } else if (segment.type === 'code' && segment.content?.trim()) {
                        const lang = segment.language || ''; // Use empty string if no language detected
                        // Format as a markdown code block for markdownToRichTextBlock
                        segmentText = '```' + lang + '\n' + segment.content.trim() + '\n```';
                        fallbackText = `Code block (${lang || 'unknown'})`;
                    }

                    // Skip empty segments after trimming/formatting
                    if (!segmentText) continue;

                    // Attempt to create a rich text block from the segment
                    const block = markdownToRichTextBlock(segmentText);

                    try {
                        const postArgs = {
                             channel: channelId,
                             thread_ts: replyTarget,
                             text: fallbackText, // Always provide fallback text
                        };
                        if (block) {
                            // If block creation succeeded, use it
                            postArgs.blocks = [block];
                        } else {
                            // If block creation failed, post the raw segment text
                            console.warn(`[Msg Handler] Failed to create block for segment ${i+1}. Posting raw text instead.`);
                            postArgs.text = segmentText; // Use the full segment text
                        }
                        // Post the message (either with block or raw text)
                        const res = await slack.chat.postMessage(postArgs);
                        lastMessageTs = res?.ts; // Update last TS with the latest successful post
                    } catch (e) {
                        console.error(`[Msg Handler] Error posting segment ${i+1} (Block attempted: ${!!block}):`, e.data?.error || e.message);
                        // If block posting failed, attempt to post raw text as a fallback
                        if (block) {
                            try {
                                console.log(`[Msg Handler] Retrying post for segment ${i+1} as raw text after block failure.`);
                                const res = await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: segmentText });
                                lastMessageTs = res?.ts;
                            } catch (e2) {
                                console.error(`[Msg Handler] Error posting raw segment ${i+1} after block failure:`, e2.data?.error || e2.message);
                                // If even raw text fails, log and continue to next segment if any
                            }
                        }
                    }

                    // Add a small delay between posting multiple segments to avoid rate limits and improve readability
                    if (segments.length > 1 && i < segments.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 500)); // 0.5s delay
                    }
                }
            }

            // --- Step 5f: Post Feedback Buttons (if applicable) ---
            // Only post feedback if the response was substantive and we successfully posted at least one part of it.
            if (lastMessageTs && isSubstantive) {
                try {
                    const feedbackButtons = [
                         { type: "button", text: { type: "plain_text", text: "👎", emoji: true }, style: "danger", value: "bad", action_id: "feedback_bad" },
                         { type: "button", text: { type: "plain_text", text: "👌", emoji: true }, value: "ok", action_id: "feedback_ok" },
                         { type: "button", text: { type: "plain_text", text: "👍", emoji: true }, style: "primary", value: "great", action_id: "feedback_great" }
                    ];
                    // Embed context (original message TS, final workspace) in the block_id for the interaction handler
                    const feedbackBlock = [
                         { type: "divider" },
                         { type: "actions", block_id: `feedback_${originalTs}_${finalWorkspaceSlug}`, elements: feedbackButtons }
                    ];
                    // Post the feedback block as a separate message in the thread
                    await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: "Was this response helpful?", blocks: feedbackBlock });
                } catch (e) {
                    console.warn("[Msg Handler] Failed post feedback buttons:", e.data?.error || e.message);
                }
            }

        } catch (error) { // Catch errors during LLM query or response posting stages
            console.error('[Msg Handler Error - LLM Query/Response Path]', error);
            // Try to update the thinking message with the error, if it still exists
            if (thinkingMessageTs) {
                 await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, { text: `⚠️ Oops! An error occurred while processing your request: ${error.message}` });
                 thinkingMessageTs = null; // Mark as handled
            } else {
                 // If thinking message was already deleted (e.g., error during posting), post a new error message
                 await slack.chat.postMessage({ channel: channelId, thread_ts: replyTarget, text: `⚠️ Oops! An error occurred while processing your request: ${error.message}` }).catch(()=>{/* Ignore failure to post error */});
            }
        } finally {
            // Final check: ensure the thinking message is deleted if it somehow still exists
            // (e.g., an error occurred after successful deletion but before setting thinkingMessageTs to null)
            if (thinkingMessageTs) {
                 await updateOrDeleteThinkingMessage(thinkingMessageTs, slack, channelId, null);
            }
            console.log(`[Msg Handler - Fallback Path] Finished processing. Duration: ${Date.now() - handlerStartTime}ms`);
        }
    } else { // Command handled branch
        console.log(`[Msg Handler] Command handled. Duration: ${Date.now() - handlerStartTime}ms`);
        // Note: Command handlers are responsible for their own thinking message updates/deletion.
    }
}

console.log("[Message Handler] Initialized.");
