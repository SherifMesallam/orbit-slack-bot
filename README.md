# Sagan Slack Bot (Refactored)

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

A modular Slack bot named **Sagan**, designed as an AI assistant to support developers working with **Gravity Forms and its ecosystem**. It leverages AI to answer questions, retrieve relevant information, and perform specific GitHub actions related to Gravity Forms development.

## Features

* **AI-Powered Assistance:** Provides answers and insights based on its knowledge of Gravity Forms development, documentation, code examples, and best practices within Slack threads.
* **GitHub Commands:** Provides specific commands (via `gh>` prefix in messages or `/gh-*` Slash Commands) tailored for Gravity Forms development workflows:
    * Fetch latest GitHub release information for relevant repositories.
    * Request an AI-powered review of a Pull Request on Gravity Forms-related projects.
    * Request an AI-powered analysis/summary of a GitHub Issue.
    * Execute generic GitHub API calls using natural language processing via an AI bridge.
* **Conversation Export:** Allows exporting Slack threads to Markdown for documentation or sharing development discussions.
* **Feedback Mechanism:** Users can provide feedback (👍/👌/👎) on bot responses to help improve its accuracy and helpfulness.
* **Context Management:** Supports directing queries to specific knowledge contexts (e.g., different Gravity Forms add-ons, core development areas) based on user or channel settings, with a fallback option. Manual context override available.
* **Thread Context:** Maintains conversation context within Slack threads for coherent, multi-turn interactions.
* **Modular Architecture:** Code organized by features and services for better maintainability.
* **Dockerized:** Includes `Dockerfile` and `.dockerignore` for easy containerization and deployment.

## Architecture Overview

The application follows a modular monolith pattern:

* **`src/`**: Main application source code.
    * **`app.js`**: Express server setup, middleware, top-level routes.
    * **`config.js`**: Environment variable loading and validation.
    * **`server.js`**: Main entry point (starts server, graceful shutdown).
    * **`core/dispatcher.js`**: Routes incoming Slack requests (Events, Interactions) to appropriate handlers.
    * **`handlers/`**: Logic for specific Slack request types (messages, commands, interactions).
    * **`services/`**: Clients and logic for interacting with external services (Redis, DB, GitHub, AI Service, Slack).
    * **`utils/`**: Shared helper functions (formatting, etc.).
    * **`features/`**: Self-contained feature modules (like `conversationExport.js`).

## Prerequisites

* Node.js (v18.x or later recommended)
* npm or yarn
* Docker (for containerized deployment)
* Access to:
    * Slack Workspace & App configuration (Bot Token, Signing Secret)
    * AI/LLM Service provider (API URL, API Key - specific requirements depend on the service used)
    * GitHub Personal Access Token (with `repo`, `read:user` scopes)
    * (Optional) Redis instance URL
    * (Optional) PostgreSQL database URL

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
    SLACK_BOT_USER_ID=UXXXXXXXXXX # Your bot's user ID (Sagan's ID)

    # AI/LLM Service Configuration (REQUIRED - specific keys/URLs depend on your chosen provider)
    LLM_API_BASE_URL=http://your-ai-service-host:port
    LLM_API_KEY=your-ai-service-api-key

    # GitHub Configuration (REQUIRED for GitHub features)
    GITHUB_TOKEN=ghp_your_github_pat
    GITHUB_CONTEXT_SLUG=gf-dev-context-for-gh-api # Context trained to generate GitHub API JSON for GF ecosystem
    # GITHUB_OWNER=gravityforms # Default GitHub org/owner for GF related actions

    # Optional Services
    # REDIS_URL=redis://user:password@host:port # Enables event deduplication
    # DATABASE_URL=postgresql://user:password@host:port/database # Enables feedback & thread mapping storage
    # FORMATTER_CONTEXT_SLUG=gf-formatter-context # Optional: Context to format gh api responses

    # Optional Context Mappings (JSON strings)
    # ENABLE_USER_CONTEXTS=true
    # SLACK_USER_CONTEXT_MAPPING={"UUSER1ID":"gf-core-context","UUSER2ID":"gf-addons-context"}
    # CHANNEL_CONTEXT_MAPPING={"CCHANNEL1ID":"gf-support-context","CCHANNEL2ID":"gf-roadmap-context"}
    # FALLBACK_CONTEXT_SLUG=general-gf-context

    # Optional Behavior
    # PORT=3001 # Defaults to 3000
    # MIN_SUBSTANTIVE_RESPONSE_LENGTH=150 # Defaults to 100
    # MAX_SLACK_BLOCK_CODE_LENGTH=2900 # Defaults to 2800

    # Ensure other necessary variables from config.js are set if defaults aren't suitable
    ```

4.  **Database Setup (Optional):** If using `DATABASE_URL`, ensure your PostgreSQL database has the necessary tables. You'll need to create tables for `feedback` and `slack_ai_threads`. Example SQL (adjust types as needed):

    ```sql
    CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        feedback_value VARCHAR(10), -- 'good', 'bad', 'ok'
        user_id VARCHAR(50),
        channel_id VARCHAR(50),
        bot_message_ts VARCHAR(50),
        original_user_message_ts VARCHAR(50),
        action_id VARCHAR(100),
        context_slug VARCHAR(100), -- Renamed from sphere_slug
        bot_message_text TEXT,
        original_user_message_text TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS slack_ai_threads ( -- Renamed table
        id SERIAL PRIMARY KEY,
        slack_channel_id VARCHAR(50) NOT NULL,
        slack_thread_ts VARCHAR(50) NOT NULL,
        context_slug VARCHAR(100) NOT NULL,      -- Renamed column
        ai_thread_id VARCHAR(100) NOT NULL,      -- Renamed column
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (slack_channel_id, slack_thread_ts) -- Ensure only one mapping per Slack thread
    );

    -- Optional: Index for faster lookups
    CREATE INDEX IF NOT EXISTS idx_slack_thread_lookup ON slack_ai_threads (slack_channel_id, slack_thread_ts);
    ```

5.  **Slack App Configuration:**
    * **Event Subscriptions:** Enable events like `message.channels`, `message.im`, `app_mention`. Set the Request URL to `https://<your-deployed-url>/slack/events`.
    * **Interactivity & Shortcuts:** Enable Interactivity. Set the Request URL to `https://<your-deployed-url>/slack/interactions`.
    * **Slash Commands:** Create commands (e.g., `/gh-release`, `/gh-review`, `/gh-analyze`, `/gh-api`). Set the Request URL for each to `https://<your-deployed-url>/slack/interactions`.
    * **OAuth & Permissions:** Ensure your bot **Sagan** has the necessary scopes (e.g., `chat:write`, `commands`, `users:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `conversations.replies`? - check specific API method needs). Install the app to your workspace.

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
    docker build -t sagan-slack-bot .
    ```

2.  **Run the Docker container:**
    * Make sure your `.env` file is correctly populated.
    * Use `--env-file` to pass environment variables securely.
    * Map the container port to a host port.

    ```bash
    docker run -d --name sagan-bot --restart unless-stopped \
      --env-file .env \
      -p 3000:3000 \
      sagan-slack-bot
    ```
    * Replace `3000:3000` if your `PORT` variable is different (e.g., `-p 3001:3001`).
    * The container will run in detached mode (`-d`) and restart automatically unless manually stopped.

3.  **Check logs:**
    ```bash
    docker logs sagan-bot -f
    ```

## Usage

* **General Chat:** Mention the bot (`@Sagan`) in a channel or send it a Direct Message with your Gravity Forms-related questions. It will use the configured context logic (user/channel mapping or fallback) and maintain context within Slack threads. Use `#context-slug` at the end of your query to manually target a specific knowledge context for that message (e.g., `#gravityflow`).
* **GitHub Commands (Messages):** Use the `gh>` prefix:
    * `gh> release <repo_name_or_abbrev_or_owner/repo>` (e.g., `gh> release gravityforms`)
    * `gh> review pr <owner/repo>#<pr_number> #<context_slug_for_review_ai>`
    * `gh> analyze issue [#<issue_number> | <owner/repo>#<issue_number>] [optional prompt...]`
    * `gh> api <natural language query for GitHub API related to GF>`
* **GitHub Commands (Slash):** Use the configured Slash Commands:
    * `/gh-release <repo_name_or_abbrev_or_owner/repo>`
    * `/gh-review <owner/repo>#<pr_number> #<context_slug_for_review_ai>`
    * `/gh-analyze [<owner/repo>]#<issue_number> #<context_slug_for_ai> [optional prompt...]`
    * `/gh-api <natural language query for GitHub API>`
* **Export:** Add the hashtag `#saveThread` (or similar, adjust command if needed) to any message within a thread to export that thread to Markdown.
* **Feedback:** Click the 👍/👌/👎 buttons on bot responses to provide feedback.
* **Delete Last Message:** Reply in a thread with `#delete_last_message` to attempt to delete the bot's most recent response in that thread.

## Contributing

(Add contribution guidelines if applicable)

## License

This project is licensed under the ISC License - see the LICENSE file for details (or state the license directly).
