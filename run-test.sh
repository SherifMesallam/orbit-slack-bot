#!/bin/bash

# Start the bot server in the background
echo "Starting the bot server..."
npm run dev &
SERVER_PID=$!

# Wait for the server to start
echo "Waiting for server to start (5 seconds)..."
sleep 5

# Run the test tool
echo "Starting test tool..."
node test-bot.js

# When test tool exits, kill the server
echo "Test tool exited. Shutting down server..."
kill $SERVER_PID 