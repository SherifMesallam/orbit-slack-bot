// src/app.js
// Configures the Express application and routes requests to the dispatcher.

import express from 'express';
import morgan from 'morgan'; // Optional: HTTP request logger
import { dispatchSlackEvent, dispatchSlackInteraction } from './core/dispatcher.js';
import { slackClient, slackEvents } from './services/slackService.js'; // Import Slack clients/adapters
import { handleAppHomeOpened } from './handlers/interactionHandler.js'; // Import the App Home handler

const app = express();

// --- Middleware ---
app.use(morgan('tiny')); // Log HTTP requests (optional)

// Health Check
app.get('/', (req, res) => res.send(`OK`));

// --- Slack Routes ---

// Slack Events API endpoint
// IMPORTANT: The slackEvents adapter from slackService MUST handle body parsing and signature verification.
if (slackEvents?.requestListener) {
    // Mount the event adapter middleware FIRST
    app.use('/slack/events', slackEvents.requestListener());
    console.log("[App] Slack Event listener mounted via SDK Adapter at /slack/events.");

    // NOTE: Event listeners (`slackEvents.on`) should now call the dispatcher function,
    // passing the *full request body* received by the adapter.
    // The adapter provides the body in its event callback.
    slackEvents.on('message', (event, body) => dispatchSlackEvent(body));
    slackEvents.on('app_mention', (event, body) => dispatchSlackEvent(body));

    // --- App Home Handler Registration ---
    // Register the App Home event listener to use the imported handler
    slackEvents.on('app_home_opened', (event, body) => {
        // The event adapter might pass the raw body, the handler expects the parsed event object.
        // Pass the event object directly which is usually the first argument.
        handleAppHomeOpened(event); // Call the imported handler
    });
    // --- End App Home Handler Registration ---

    // Add other event listeners here as needed, calling dispatchSlackEvent(body)
    slackEvents.on('error', (error) => {
         console.error('[App] Slack Events Adapter Error:', error.name || 'Unknown Error', error.code || '', error.message || '');
         // Log specific details if available
         if (error.request) console.error('  Request:', error.request.method, error.request.url);
         if (error.response) console.error('  Response Status:', error.response.status);
    });

} else {
     console.error("[App] Slack Events Adapter not initialized! /slack/events endpoint WILL NOT WORK.");
     // Provide a fallback route that indicates the error
     app.post('/slack/events', (req, res) => {
         console.error("[App] Received event request, but Events Adapter is not functional.");
         res.status(503).send("Service configuration error: Slack Events unavailable.");
     });
}


// Slack Interactions endpoint (Buttons, Slash Commands, Modals)
// Use urlencoded parser for Slash Commands and interaction payloads initially.
// Dispatcher will handle JSON parsing if needed (for interaction payloads).
// TODO: ADD SLACK SIGNATURE VERIFICATION MIDDLEWARE HERE!
app.post('/slack/interactions', express.urlencoded({ extended: true, limit: '5mb' }), (req, res) => {
    // Signature verification should happen *before* this handler ideally.
    // Assuming verification passed...
    console.log("[App] Received POST on /slack/interactions");
    dispatchSlackInteraction(req, res); // Pass request and response to dispatcher
});


// --- Top-level Error Handler ---
// Catch errors that might bubble up unexpectedly
app.use((err, req, res, next) => {
  console.error("[App] Unhandled Application Error:", err.stack || err);
  // Avoid sending stack trace to client in production
  res.status(500).send("Internal Server Error");
});


export default app; // Export the configured app

console.log("[App] Express app configured.");
