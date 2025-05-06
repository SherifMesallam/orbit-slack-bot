// src/handlers/interactionHandler.js
// Handles interactions originating from Slack interactive components (buttons, modals).

// Import necessary services and config
import { storeFeedback, dbPool } from '../services/dbService.js';
import { slackClient } from '../services/slackService.js'; // Use the initialized client
import { databaseUrl } from '../config.js'; // To check if DB is enabled
import logger from '../utils/logger.js'; // Assuming logger exists

// --- App Home Handler ---
/**
 * Handles the 'app_home_opened' event by publishing the App Home view.
 * @param {object} event - The event payload from Slack.
 */
export const handleAppHomeOpened = async (event) => {
    if (!event || !event.user) {
        logger.warn('[AppHomeHandler] Received app_home_opened event without user ID.', { event });
        return;
    }
    const userId = event.user;
    logger.info(`[AppHomeHandler] User ${userId} opened App Home.`);

    try {
        // Define the basic App Home view
        const homeView = {
            user_id: userId,
            view: {
                type: 'home',
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*Welcome to Orbit, <@${userId}>!* :rocket:`
                        }
                    },
                    {
                        type: 'divider'
                    },
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `I'm here to help with your Gravity Forms development tasks. You can ask me questions, interact with GitHub, and save important conversations.\\n\\nMention me (\`@Orbit\`) in any channel or DM me to get started.`
                        }
                    },
                     {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: 'Use the message input below to interact with me.'
                            }
                        ]
                    }
                ]
            }
        };

        // Publish the view to the App Home tab
        await slackClient.views.publish(homeView);
        logger.info(`[AppHomeHandler] Successfully published home view for user ${userId}.`);

    } catch (error) {
        logger.error(`[AppHomeHandler] Failed to publish App Home view for user ${userId}:`, error);
    }
};
// --- End App Home Handler ---

/**
 * Processes incoming interaction payloads (buttons, modals, etc.).
 * This function is called asynchronously after the main interaction endpoint acknowledges Slack.
 * @param {object} payload - The parsed JSON payload from Slack.
 * @param {object} slackClientRef - Reference to the initialized Slack WebClient instance.
 */
export async function handleInteractionPayload(payload, slackClientRef) {
    // Use the passed slackClientRef, assuming it's valid
    const slack = slackClientRef;
    if (!slack) {
        console.error("[Interaction Handler] Slack client reference is missing!");
        return; // Cannot proceed without client
    }

    try {
        switch (payload.type) {
            case 'block_actions':
                await processBlockAction(payload, slack);
                break;
            case 'view_submission':
                console.log(`[Interaction Handler] Received view submission for view ID: ${payload.view?.id} (Handler not implemented)`);
                // Example: await processViewSubmission(payload, slack);
                break;
            // Add cases for other interaction types like 'shortcut', 'message_action' if needed
            default:
                console.log(`[Interaction Handler] Received unhandled interaction type: ${payload.type}`);
        }
    } catch (error) {
        console.error(`[Interaction Handler] Error processing payload type ${payload.type}:`, error);
        // Consider logging the error to a monitoring service
    }
}

// --- Specific Handler for Block Actions (e.g., Button Clicks) ---
async function processBlockAction(payload, slack) {
    if (!payload.actions?.[0]) {
        console.warn("[Interaction Handler/BlockAction] No actions found in payload.");
        return;
    }

    // Assuming only one action per interaction for simplicity
    const action = payload.actions[0];
    const { action_id: actionId, block_id: blockId, value: actionValue } = action;
    const user = payload.user || {}; // User who clicked
    const channel = payload.channel || {}; // Channel where message was
    const message = payload.message || {}; // The original message containing the button
    const triggerId = payload.trigger_id; // Useful for opening modals

    if (!message.ts || !channel.id) {
        console.warn("[Interaction Handler/BlockAction] Missing channel or message TS in payload for action:", actionId);
        return;
    }
    console.log(`[Interaction Handler/BlockAction] ActionID=${actionId}, BlockID=${blockId}, User=${user.id}, Channel=${channel.id}, MsgTS=${message.ts}`);

    // --- Handle Feedback Buttons ---
    if (actionId.startsWith('feedback_')) {
        const feedbackValue = actionValue; // Use value from action payload
        let originalQuestionTs = null;
        let responseSphere = null;

        // Extract context from block_id (format: feedback_origTS_sphere)
        if (blockId?.startsWith('feedback_')) {
            const parts = blockId.substring(9).split('_');
            originalQuestionTs = parts[0];
            if (parts.length > 1) { responseSphere = parts.slice(1).join('_'); } // Handle underscores in sphere
        }
        console.log(`[Interaction Handler/Feedback] Data: Val=${feedbackValue}, OrigTS=${originalQuestionTs}, Sphere=${responseSphere}`);

        // --- Store Feedback ---
        if (databaseUrl && dbPool) {
            let originalQuestionText = null;
            let actualBotMessageText = message.text || "(Could not retrieve bot message text)";
            if (originalQuestionTs && channel.id) {
                try {
                    const history = await slack.conversations.history({ channel: channel.id, latest: originalQuestionTs, oldest: originalQuestionTs, inclusive: true, limit: 1 });
                    if (history.ok && history.messages?.[0]?.text) { originalQuestionText = history.messages[0].text; }
                } catch (e) { console.error('[Interaction/Feedback] Error fetching original msg text:', e.data?.error); }
            }
            try {
                await storeFeedback({
                    feedback_value: feedbackValue, user_id: user.id, channel_id: channel.id,
                    bot_message_ts: message.ts, original_user_message_ts: originalQuestionTs || null,
                    action_id: actionId, sphere_slug: responseSphere || null,
                    bot_message_text: actualBotMessageText, original_user_message_text: originalQuestionText
                });
                console.log(`[Interaction Handler/Feedback] Feedback stored successfully.`);
            } catch (dbError) { console.error(`[Interaction Handler/Feedback] Error storing feedback DB:`, dbError); }
        } else {
            console.log(`[Interaction Handler/Feedback] (DB Disabled): User:${user.id}, Val:${feedbackValue}, Sphere:${responseSphere}, OrigTS:${originalQuestionTs}, BotTS:${message.ts}`);
        }
        // --- End Store Feedback ---

        // --- Update Original Message UI ---
        try {
            const originalBlocks = message.blocks;
            if (originalBlocks?.length > 0) {
                const actionBlockIndex = originalBlocks.findIndex(b => b.type === 'actions' && b.block_id === blockId);
                const thanksEmoji = feedbackValue === 'bad' ? '👎' : (feedbackValue === 'ok' ? '👌' : '👍');
                const thanksText = `🙏 Thanks for the feedback! (_${thanksEmoji}_)`;
                const contextBlock = { type: "context", elements: [{ type: "mrkdwn", text: thanksText }] };
                let updatedBlocks = [...originalBlocks]; // Create a copy

                if (actionBlockIndex !== -1) {
                    updatedBlocks.splice(actionBlockIndex, 1, contextBlock); // Replace action block
                } else {
                    console.warn("[Interaction Handler/Feedback] Action block not found by ID. Appending thanks.");
                    updatedBlocks.push(contextBlock); // Append if not found
                }

                await slack.chat.update({
                    channel: channel.id, ts: message.ts,
                    text: (message.text || '') + `\n${thanksText}`, // Append thanks to fallback text
                    blocks: updatedBlocks
                });
                console.log(`[Interaction Handler/Feedback] Updated original message ${message.ts}.`);
            } else {
                console.warn("[Interaction Handler/Feedback] Original message had no blocks to update.");
                await slack.chat.postEphemeral({ channel: channel.id, user: user.id, text: `🙏 Thanks for the feedback!` }).catch(()=>{});
            }
        } catch (updateError) {
            console.warn("[Interaction Handler/Feedback] Failed update original message:", updateError.data?.error || updateError.message);
            await slack.chat.postEphemeral({ channel: channel.id, user: user.id, text: `Error updating message, but feedback was received! (${updateError.data?.error || 'unknown'})` }).catch(()=>{});
        }
        // --- End Update UI ---
    }
    // --- Handle Intent Confirmation Buttons ---
    else if (actionId === 'confirm_intent_yes' || actionId === 'confirm_intent_no') {
        console.log(`[Interaction Handler] Intent confirmation button clicked: ${actionId}`);
        // 1. Retrieve stored context from Redis based on data perhaps stored in the button's value or block_id
        //    Example: const storedContextKey = actionValue; // Assuming key is in value
        //    const contextJson = await redisClient.get(storedContextKey);
        //    if (!contextJson) { console.error("Could not find stored context for intent confirmation."); return; }
        //    await redisClient.del(storedContextKey); // Consume the key
        //    const context = JSON.parse(contextJson);
        //    const { originalEvent, intent, suggestedWorkspace } = context;

        // 2. If 'yes', call the appropriate handler asynchronously
        if (actionId === 'confirm_intent_yes') {
            //    console.log(`Executing confirmed intent: ${intent} for workspace ${suggestedWorkspace}`);
            //    // Map intent to handler (needs mapping logic)
            //    if (intent === 'github_issue_lookup') {
            //       // Extract args from originalEvent.text or context.parameters
            //       // handleGithubLookup({ args: ..., channel: originalEvent.channel, ... }).catch(...)
            //    } else if (intent === 'general_query') {
            //       // handleLlmQuery({ ...originalEvent details ..., suggestedWorkspace }).catch(...)
            //    } // etc.
            // Update the confirmation message
             await slack.chat.update({ channel: channel.id, ts: message.ts, text: ":white_check_mark: Okay, proceeding with your request...", blocks: [] });

        } else { // 'no'
            // Update the confirmation message
             await slack.chat.update({ channel: channel.id, ts: message.ts, text: ":negative_squared_cross_mark: Okay, request cancelled. Please rephrase or try again.", blocks: [] });
        }
        // NOTE: The actual execution logic for confirmed intents needs implementation based on stored context retrieval (Redis) and mapping intents to handlers.
        console.warn("[Interaction Handler] Intent confirmation 'yes'/'no' logic needs full implementation (Redis get/del, handler mapping).");


    }
    // --- Add handlers for other action_ids ---
    // else if (actionId === 'show_details_button') {
    //     // Example: Open a modal
    //     try {
    //         await slack.views.open({
    //             trigger_id: triggerId,
    //             view: { /* ... modal definition ... */ }
    //         });
    //     } catch (modalError) { console.error("Error opening modal:", modalError); }
    // }
     else {
         console.log(`[Interaction Handler/BlockAction] Received unhandled action ID: ${actionId}`);
         // Optionally post an ephemeral message if it's unexpected
         await slack.chat.postEphemeral({ channel: channel.id, user: user.id, text: `Action \`${actionId}\` is not handled yet.`}).catch(()=>{});
     }
}

console.log("[Interaction Handler] Initialized (including App Home handler)." );
