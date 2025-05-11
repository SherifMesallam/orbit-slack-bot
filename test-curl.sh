#!/bin/bash

# Set variables
SERVER_URL="http://localhost:3000/slack/events"
USER_ID="U12345678"
BOT_ID="B08NR1B8LJU"
CHANNEL_ID="C12345678"
TS=$(date +%s.%N | cut -b1-14)  # Current timestamp in Slack format

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Helper function to send a message to the bot
send_message() {
    local message="$1"
    local mention="${2:-true}"
    local thread_ts="${3:-}"
    
    # Format message with bot mention if needed
    local text="$message"
    if [ "$mention" = "true" ]; then
        text="<@$BOT_ID> $message"
    fi
    
    # Build JSON payload
    local payload="{
        \"token\": \"test_token\",
        \"team_id\": \"T12345678\",
        \"api_app_id\": \"A12345678\",
        \"event\": {
            \"type\": \"message\",
            \"user\": \"$USER_ID\",
            \"text\": \"$text\",
            \"channel\": \"$CHANNEL_ID\",
            \"channel_type\": \"channel\",
            \"ts\": \"$TS\",
            \"event_ts\": \"$TS\",
            \"team\": \"T12345678\"
        },
        \"type\": \"event_callback\",
        \"event_id\": \"Ev$(date +%s%N)\",
        \"event_time\": $(date +%s)
    }"
    
    # Add thread_ts if provided
    if [ -n "$thread_ts" ]; then
        payload=$(echo "$payload" | sed "s/\"team\": \"T12345678\"/\"team\": \"T12345678\", \"thread_ts\": \"$thread_ts\"/")
    fi
    
    echo -e "${YELLOW}Sending: $text${NC}"
    response=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$SERVER_URL" \
        -H "Content-Type: application/json" \
        -d "$payload")
    
    if [ "$response" -eq 200 ]; then
        echo -e "${GREEN}Message sent successfully (HTTP $response)${NC}"
    else
        echo -e "${RED}Failed to send message (HTTP $response)${NC}"
    fi
    
    echo ""
    return 0
}

# Test cases
test_greeting() {
    send_message "Hello there!"
}

test_release_info() {
    send_message "What's the latest release of gravityforms?"
}

test_pr_review() {
    send_message "Review PR gravityforms/gravityforms#524"
}

test_issue_analysis() {
    send_message "Analyze issue gravityforms/gravityforms#456"
}

test_github_api() {
    send_message "Find open issues in the gravityforms repo"
}

# Run selected test or show menu
if [ -n "$1" ]; then
    case "$1" in
        greeting) test_greeting ;;
        release) test_release_info ;;
        pr) test_pr_review ;;
        issue) test_issue_analysis ;;
        api) test_github_api ;;
        all)
            test_greeting
            sleep 1
            test_release_info
            sleep 1
            test_pr_review
            sleep 1
            test_issue_analysis
            sleep 1
            test_github_api
            ;;
        *)
            echo "Unknown test: $1"
            echo "Available tests: greeting, release, pr, issue, api, all"
            ;;
    esac
else
    echo "Usage: $0 [test_name]"
    echo "Available tests: greeting, release, pr, issue, api, all"
fi 