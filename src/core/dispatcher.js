
// src/core/dispatcher.js
// Routes incoming Slack events and interactions to the appropriate handlers.

import axios from 'axios'; // For fallback interaction responses
import { isDuplicateRedis } from '../services/redisService.js';
import { handleSlackMessageEventInternal } from '../handlers/messageHandler.js';
import { handleInteractionPayload } from '../handlers/interactionHandler.js';
import { handleSlashCommand } from '../handlers/commandHandler.js';
import { botUserId, githubToken } from '../config.js';

// Import service clients to pass down to handlers
import { slackClient } from '../services/slackService.js';
import { octokit } from '../services/githubService.js';


/**
 * =============================================================================
 *                             EVENT DISPATCHER
 * =============================================================================
 */

/**
 * Main dispatcher for incoming Slack HTTP requests verified by the Events API Adapter.
 * Called by event listeners set up in app.js or slackService.js.
 * @param {object} requestBody - The full request body received from Slack.
 */
export async function dispatchSlackEvent(requestBody) {
    const event = requestBody?.event;
    if (!event) { console.warn("[Dispatcher/Event] Invalid request body: Missing 'event' field."); return; }

    const eventId = requestBody.event_id || event.event_ts || `no-id:${Date.now()}-${Math.random()}`;
    if (await isDuplicateRedis(eventId)) { console.log(`[Dispatcher/Event] Duplicate event skipped: ${eventId}`); return; }

    try {
        switch (event.type) {
            case 'message':
                if (event.user === botUserId || (event.subtype && event.subtype !== 'thread_broadcast') || !event.user || typeof event.text !== 'string') { return; } // Filter
                console.log(`[Dispatcher/Event] Processing 'message' event: User=${event.user}, Chan=${event.channel}, TS=${event.ts}`);
                handleSlackMessageEventInternal(event, slackClient, octokit).catch(err => { console.error(`[Dispatcher/Event] Unhandled error in message handler for event ${eventId}:`, err); });
                break;
            case 'app_mention':
                if (!event.user || typeof event.text !== 'string' || event.user === botUserId) { return; } // Filter
                console.log(`[Dispatcher/Event] Processing 'app_mention' event: User=${event.user}, Chan=${event.channel}, TS=${event.ts}`);
                handleSlackMessageEventInternal(event, slackClient, octokit).catch(err => { console.error(`[Dispatcher/Event] Unhandled error in app_mention handler for event ${eventId}:`, err); });
                break;
            // Add other event cases here
            default:
                // console.log(`[Dispatcher/Event] Ignoring unhandled event type: ${event.type}`); // Can be noisy
                break;
        }
    } catch (error) { console.error(`[Dispatcher/Event] Critical error dispatching event type ${event?.type} (ID: ${eventId}):`, error); }
}


/**
 * =============================================================================
 *                         INTERACTION DISPATCHER
 * =============================================================================
 */

/**
 * Main dispatcher for incoming Slack Interaction HTTP requests (Slash Commands, Buttons, Modals).
 * Assumes request signature has been verified by middleware BEFORE this is called.
 * @param {object} req - Express request object.
 * @param {object} res - Express response object.
 */
export async function dispatchSlackInteraction(req, res) {
    // --- Interaction Type Routing ---
    if (req.body.command && typeof req.body.command === 'string') { // == Slash Command ==
        const { command, response_url } = req.body; // Extract needed fields early
        console.log(`[Dispatcher/Interaction] Received Slash Command: ${command}`);
        res.send(); // Acknowledge immediately

        handleSlashCommand(req.body, slackClient, octokit).catch(error => {
             console.error(`[Dispatcher/Interaction] Uncaught error in handleSlashCommand for ${command}:`, error);
             axios.post(response_url, { replace_original: "false", text: `❌ Critical error processing \`${command}\`.` }).catch(()=>{});
        });

    } else if (req.body.payload) { // == Button Click, Modal Submit, etc. ==
         console.log(`[Dispatcher/Interaction] Received Interaction Payload.`);
         try {
             const payload = JSON.parse(req.body.payload);
             console.log(`[Dispatcher/Interaction] Payload type: ${payload.type}`);
             res.send(); // Acknowledge immediately

             handleInteractionPayload(payload, slackClient).catch(error => {
                 console.error(`[Dispatcher/Interaction] Uncaught error in handleInteractionPayload for type ${payload.type}:`, error);
                 // Cannot easily respond via response_url here, error is logged.
             });
         } catch (e) {
              console.error("[Dispatcher/Interaction] Failed to parse interaction payload:", e);
              res.status(400).send('Invalid payload format'); // Synchronous error response
         }
    } else {
        console.warn("[Dispatcher/Interaction] Received unknown POST format to interactions endpoint");
        res.status(400).send("Unsupported request format");
    }
}

console.log("[Dispatcher] Initialized.");
