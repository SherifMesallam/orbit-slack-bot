
// src/server.js
// Main application entry point. Initializes services, starts the server, handles shutdown.

import process from 'process';
import app from './app.js'; // Import the configured Express app
import { port, validateConfig } from './config.js';
import { shutdownServices } from './services/shutdown.js';

// 1. Validate Configuration
// This will exit if critical variables are missing.
validateConfig();

// 2. Initialize Services (Implicitly by importing modules)
// Ensure services are imported so their initialization logic runs.
// The order usually doesn't matter unless one service strictly depends
// on another being fully initialized *before* its own init logic runs.
import './services/redisService.js';
import './services/dbService.js';
import './services/githubService.js';
import './services/llmService.js';
import './services/slackService.js';
// Import other top-level modules/handlers if they have init logic
import './core/dispatcher.js';
import './handlers/commandHandler.js';
import './handlers/interactionHandler.js';
import './handlers/messageHandler.js';
import './utils/formattingService.js';


// 3. Start the HTTP Server
const server = app.listen(port, () => {
    console.log(`-----------------------------------------`);
    console.log(`🚀 Server listening on http://localhost:${port}`);
    console.log(`🕒 Current Time: ${new Date().toISOString()}`);
    console.log(`-----------------------------------------`);
});

server.on('error', (error) => {
    console.error('[Server] Failed to start server:', error);
    if (error.syscall !== 'listen') throw error;
    switch (error.code) {
        case 'EACCES': console.error(`Port ${port} requires elevated privileges`); process.exit(1); break;
        case 'EADDRINUSE': console.error(`Port ${port} is already in use`); process.exit(1); break;
        default: throw error;
    }
});


// 4. Graceful Shutdown Handler
async function gracefulShutdown(signal) {
    console.log(`\n[Server] ${signal} received. Starting graceful shutdown...`);

    // Prevent new connections
    server.close(async (err) => {
        if (err) { console.error('[Server] Error closing HTTP server:', err); process.exit(1); }
        console.log('[Server] HTTP server closed.');

        // Shutdown external services
        await shutdownServices(signal);

        console.log('[Server] Graceful shutdown complete. Exiting.');
        process.exit(0);
    });

    // Force exit after timeout
    setTimeout(() => { console.error('[Server] Graceful shutdown timed out. Forcing exit.'); process.exit(1); }, 15000);
}

// 5. Attach Signal Listeners
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // e.g., kill
process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // e.g., Ctrl+C

// 6. Optional: Global Exception Handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Promise Rejection at:', promise, 'reason:', reason);
  // Consider if you should trigger graceful shutdown here as well
  // gracefulShutdown('UnhandledRejection');
});
process.on('uncaughtException', (error, origin) => {
  console.error('[Server] Uncaught Exception:', error, 'Origin:', origin);
  // Uncaught exceptions often leave the app in an unstable state, exiting is safest
  process.exit(1);
});

console.log("[Server] Process listeners for signals attached.");
