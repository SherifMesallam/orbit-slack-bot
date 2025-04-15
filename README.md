# DeepOrbit Slack Bot (Refactored)

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

A modular Slack bot designed to interact with AnythingLLM knowledge bases and perform specific GitHub actions based on user commands.

## Features

*   **LLM Integration:** Connects to AnythingLLM for knowledge retrieval and answering questions within Slack threads.
*   **GitHub Commands:** Provides specific commands (via `gh>` prefix in messages or `/gh-*` Slash Commands) to:
    *   Fetch latest GitHub release information.
    *   Request an LLM-powered review of a Pull Request.
    *   Request an LLM-powered analysis/summary of a GitHub Issue.
    *   Execute generic GitHub API calls based on natural language using an LLM bridge.
*   **Conversation Export:** Allows exporting Slack threads to Markdown and optionally uploading them to a designated AnythingLLM workspace.
*   **Feedback Mechanism:** Users can provide feedback (👍/👌/👎) on bot responses.
*   **Workspace Management:** Supports routing requests to different AnythingLLM workspaces based on user or channel mappings, with a fallback option. Manual workspace override available.
*   **Thread Context:** Maintains conversation context by mapping Slack threads to AnythingLLM threads.
*   **Modular Architecture:** Code organized by features and services for better maintainability.
*   **Dockerized:** Includes `Dockerfile` and `.dockerignore` for easy containerization and deployment.

## Architecture Overview

The application follows a modular monolith pattern:

*   **`src/`**: Main application source code.
    *   **`app.js`**: Express server setup, middleware, top-level routes.
    *   **`config.js`**: Environment variable loading and validation.
    *   **`server.js`**: Main entry point (starts server, graceful shutdown).
    *   **`core/dispatcher.js`**: Routes incoming Slack requests (Events, Interactions) to appropriate handlers.
    *   **`handlers/`**: Logic for specific Slack request types (messages, commands, interactions).
    *   **`services/`**: Clients and logic for interacting with external services (Redis, DB, GitHub, LLM, Slack).
    *   **`utils/`**: Shared helper functions (formatting, etc.).
    *   **`features/`**: Self-contained feature modules (like `conversationExport.js`).

## Prerequisites

*   Node.js (v18.x or later recommended)
*   npm or yarn
*   Docker (for containerized deployment)
*   Access to:
    *   Slack Workspace & App configuration (Bot Token, Signing Secret)
    *   AnythingLLM instance (API URL, API Key)
    *   GitHub Personal Access Token (with `repo`, `read:user` scopes)
    *   (Optional) Redis instance URL
    *   (Optional) PostgreSQL database URL

## Setup and Configuration

1.  **Clone the repository:**
    ```bash
    git clone <your-repository-url>
    cd <repository-directory>
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Create a `.env` file:** Copy the `.env.example` (if provided) or create a new `.env` file in the root directory. Fill in the required environment variables:

    ```dotenv
    # Slack Configuration (REQUIRED)
    SLACK_SIGNING_SECRET=your-slack-signing-secret
    SLACK_BOT_TOKEN=xoxb-your-bot-token
    SLACK_BOT_USER_ID=UXXXXXXXXXX # Your bot's user ID

    # AnythingLLM Configuration (REQUIRED)
    LLM_API_BASE_URL=http://your-anythingllm-host:port
    LLM_API_KEY=your-anythingllm-api-key

    # GitHub Configuration (REQUIRED for GitHub features)
    GITHUB_TOKEN=ghp_your_github_pat
    GITHUB_WORKSPACE_SLUG=anythingllm-workspace-for-gh-api-calls # Workspace trained to generate GitHub API JSON
    # GITHUB_OWNER=your-default-github-org # Defaults to 'gravityforms' if omitted

    # Optional Services
    # REDIS_URL=redis://user:password@host:port # Enables event deduplication
    # DATABASE_URL=postgresql://user:password@host:port/database # Enables feedback & thread mapping storage
    # FORMATTER_WORKSPACE_SLUG=anythingllm-workspace-for-formatting # Optional: Workspace to format gh api responses

    # Optional Workspace Mappings (JSON strings)
    # ENABLE_USER_WORKSPACES=true
    # SLACK_USER_WORKSPACE_MAPPING={"UUSER1ID":"workspace1","UUSER2ID":"workspace2"}
    # WORKSPACE_MAPPING={"CCHANNEL1ID":"workspace3","CCHANNEL2ID":"workspace4"}
    # FALLBACK_WORKSPACE_SLUG=default-workspace

    # Optional Behavior
    # PORT=3001 # Defaults to 3000
    # MIN_SUBSTANTIVE_RESPONSE_LENGTH=150 # Defaults to 100
    # MAX_SLACK_BLOCK_CODE_LENGTH=2900 # Defaults to 2800

    # Ensure other necessary variables from config.js are set if defaults aren't suitable
    ```

4.  **Database Setup (Optional):** If using `DATABASE_URL`, ensure your PostgreSQL database has the necessary tables. You'll need to create tables for `feedback` and `slack_anythingllm_threads`. Example SQL (adjust types as needed):

    ```sql
    CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        feedback_value VARCHAR(10), -- 'good', 'bad', 'ok'
        user_id VARCHAR(50),
        channel_id VARCHAR(50),
        bot_message_ts VARCHAR(50),
        original_user_message_ts VARCHAR(50),
        action_id VARCHAR(100),
        sphere_slug VARCHAR(100),
        bot_message_text TEXT,
        original_user_message_text TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS slack_anythingllm_threads (
        id SERIAL PRIMARY KEY,
        slack_channel_id VARCHAR(50) NOT NULL,
        slack_thread_ts VARCHAR(50) NOT NULL,
        anythingllm_workspace_slug VARCHAR(100) NOT NULL,
        anythingllm_thread_slug VARCHAR(100) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (slack_channel_id, slack_thread_ts) -- Ensure only one mapping per Slack thread
    );

    -- Optional: Index for faster lookups
    CREATE INDEX IF NOT EXISTS idx_slack_thread_lookup ON slack_anythingllm_threads (slack_channel_id, slack_thread_ts);
    ```

5.  **Slack App Configuration:**
    *   **Event Subscriptions:** Enable events like `message.channels`, `message.im`, `app_mention`. Set the Request URL to `https://<your-deployed-url>/slack/events`.
    *   **Interactivity & Shortcuts:** Enable Interactivity. Set the Request URL to `https://<your-deployed-url>/slack/interactions`.
    *   **Slash Commands:** Create commands (e.g., `/gh-release`, `/gh-review`, `/gh-analyze`, `/gh-api`). Set the Request URL for each to `https://<your-deployed-url>/slack/interactions`.
    *   **OAuth & Permissions:** Ensure your bot has the necessary scopes (e.g., `chat:write`, `commands`, `users:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `conversations.replies`? - check specific API method needs). Install the app to your workspace.

## Running the Application

### Locally (for Development)

1.  Ensure all environment variables are set in your `.env` file.
2.  Run validation (optional but recommended):
    ```bash
    npm run validate-config
    ```
3.  Start the development server:
    ```bash
    npm run dev
    ```
    The server will run (default: port 3000) and restart automatically on file changes. You'll likely need a tool like `ngrok` to expose your local server to Slack's APIs.

### Using Docker

1.  **Build the Docker image:**
    ```bash
    docker build -t deeporbit-slack-bot .
    ```

2.  **Run the Docker container:**
    *   Make sure your `.env` file is correctly populated.
    *   Use `--env-file` to pass environment variables securely.
    *   Map the container port to a host port.

    ```bash
    docker run -d --name deeporbit-bot --restart unless-stopped \
      --env-file .env \
      -p 3000:3000 \
      deeporbit-slack-bot
    ```
    *   Replace `3000:3000` if your `PORT` variable is different (e.g., `-p 3001:3001`).
    *   The container will run in detached mode (`-d`) and restart automatically unless manually stopped.

3.  **Check logs:**
    ```bash
    docker logs deeporbit-bot -f
    ```

## Usage

*   **General Chat:** Mention the bot (`@YourBotName`) in a channel or send it a Direct Message. It will use the configured workspace logic (user/channel mapping or fallback) and maintain context within Slack threads. Use `#workspace-slug` at the end of your query to manually target a specific workspace for that message.
*   **GitHub Commands (Messages):** Use the `gh>` prefix:
    *   `gh> release <repo_name_or_abbrev_or_owner/repo>`
    *   `gh> review pr <owner/repo>#<pr_number> #<workspace_slug_for_review_llm>`
    *   `gh> analyze issue [#<issue_number> | <owner/repo>#<issue_number>] [optional prompt...]`
    *   `gh> api <natural language query for GitHub API>`
*   **GitHub Commands (Slash):** Use the configured Slash Commands:
    *   `/gh-release <repo_name_or_abbrev_or_owner/repo>`
    *   `/gh-review <owner/repo>#<pr_number> #<workspace_slug_for_review_llm>`
    *   `/gh-analyze [<owner/repo>]#<issue_number> #<workspace_slug_for_llm> [optional prompt...]`
    *   `/gh-api <natural language query for GitHub API>`
*   **Export:** Add the hashtag `#saveToConversations` to any message within a thread to export that thread to Markdown (and potentially upload to the 'conversations' AnythingLLM workspace if configured).
*   **Feedback:** Click the 👍/👌/👎 buttons on bot responses to provide feedback (stored in DB if configured).
*   **Delete Last Message:** Reply in a thread with `#delete_last_message` to attempt to delete the bot's most recent response in that thread.

## Contributing

(Add contribution guidelines if applicable)

## License

This project is licensed under the ISC License - see the LICENSE file for details (or state the license directly).
