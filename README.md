# Negm Slack Bot

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

**Negm** is a modular Slack bot designed as an AI assistant specifically for developers working within the **Gravity Forms ecosystem**. It centralizes knowledge and streamlines common development tasks by leveraging AI to answer questions, retrieve information, and interact with GitHub directly from Slack.

## Core Value

Negm aims to accelerate Gravity Forms development by:

* Providing quick, contextual answers to technical questions.
* Automating routine GitHub interactions (fetching latest releases, summarizing issues/PRs).
* Keeping development discussions and related context easily accessible within Slack.

## Features

* **AI-Powered Q&A:** Answers questions about Gravity Forms development, documentation, code examples, and best practices directly within Slack threads, using relevant knowledge context.
* **GitHub Integration:** Offers commands (via `gh:` message prefix or `/gh-*` Slash Commands) for common Gravity Forms development workflows:
    * Fetch the latest GitHub latest release details for relevant repositories.
    * Request an AI-powered review summary of a Pull Request.
    * Request an AI-powered analysis or summary of a GitHub Issue.
    * Execute generic GitHub API calls using natural language queries via an AI bridge.
* **Conversation Export:** Exports Slack threads to Markdown (`#saveThread` command) for documentation or offline sharing.
* **Feedback Loop:** Users can provide feedback (👍/👌/👎 reactions) on bot responses to help refine its accuracy.
* **Context Management:** Intelligently directs queries to specific knowledge contexts (e.g., core, specific add-ons) based on user/channel settings or a default fallback. Allows manual context override (`#context-slug` in messages).
* **Thread Context:** Maintains conversational history within Slack threads for coherent interactions.
* **Dockerized:** Includes `Dockerfile` and `.dockerignore` for straightforward containerization and deployment.

## Architecture Overview

The application uses a **modular monolith** pattern, organizing code by features and services for better maintainability and separation of concerns while running as a single deployable unit.

* **`src/`**: Main application source code.
    * **`app.js`**: Express server setup, middleware, top-level routes.
    * **`config.js`**: Environment variable loading and validation.
    * **`server.js`**: Main entry point (starts server, handles graceful shutdown).
    * **`core/dispatcher.js`**: Routes incoming Slack requests (Events, Interactions) to appropriate handlers.
    * **`handlers/`**: Contains logic for specific Slack request types (messages, commands, interactions).
    * **`services/`**: Houses clients and logic for interacting with external services (Redis, DB, GitHub, AI Service, Slack).
    * **`utils/`**: Provides shared helper functions (e.g., formatting).
    * **`features/`**: Includes self-contained feature modules (e.g., `conversationExport.js`).

## Prerequisites

**Required:**

* Node.js (v18.x or later recommended)
* npm or yarn
* Access to a Slack Workspace and permissions to configure a Slack App:
    * Slack Bot Token (`xoxb-...`)
    * Slack Signing Secret
* Access to an AI/LLM Service provider:
    * API Base URL
    * API Key (specific requirements depend on the service)
* GitHub Personal Access Token (PAT):
    * Required scopes: `repo`, `read:user` (or more depending on desired API usage)

**Optional:**

* Docker (for containerized deployment)
* Redis instance URL (for event deduplication)
* PostgreSQL database URL (for storing feedback and thread mappings)

## Setup and Configuration

1.  **Clone the repository:**
    ```bash
    git clone <your-repository-url>
    cd <repository-directory>
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```

3.  **Create and configure the `.env` file:**
    * Copy `.env.example` to `.env` if it exists: `cp .env.example .env`
    * Otherwise, create a new `.env` file in the root directory.
    * **IMPORTANT:** Fill in the required environment variables. **NEVER commit your `.env` file to version control.**

    ```dotenv
    # --- Required Configuration ---

    # Slack Configuration
    SLACK_SIGNING_SECRET=your-slack-signing-secret          # Found in Slack App settings (Basic Information)
    SLACK_BOT_TOKEN=xoxb-your-bot-token                     # Bot User OAuth Token (OAuth & Permissions)
    SLACK_BOT_USER_ID=UXXXXXXXXXX                           # The Bot's User ID (find via profile or API)

    # AI/LLM Service Configuration (Specific keys/URLs depend on your chosen provider)
    LLM_API_BASE_URL=http://your-ai-service-host:port       # URL of your AI service endpoint
    LLM_API_KEY=your-ai-service-api-key                     # API Key for authenticating with the AI service

    # GitHub Configuration (Required for GitHub features)
    GITHUB_TOKEN=ghp_your_github_pat                        # Your GitHub Personal Access Token
    GITHUB_CONTEXT_SLUG=gf-dev-context-for-gh-api         # AI Context trained to generate GitHub API JSON for GF ecosystem requests

    # --- Optional Services & Configuration ---

    # GitHub Owner Default (Optional, fallback for commands)
    # GITHUB_OWNER=gravityforms

    # Redis (Optional: Enables event deduplication)
    # REDIS_URL=redis://user:password@host:port

    # PostgreSQL Database (Optional: Enables feedback & thread mapping storage)
    # DATABASE_URL=postgresql://user:password@host:port/database

    # Context Mapping & Fallback (Optional: Customize AI context selection)
    # ENABLE_USER_CONTEXTS=true                             # Set to true to enable user-specific contexts
    # SLACK_USER_CONTEXT_MAPPING={"UUSER1ID":"gf-core-context","UUSER2ID":"gf-addons-context"} # JSON mapping Slack User IDs to Context Slugs
    # CHANNEL_CONTEXT_MAPPING={"CCHANNEL1ID":"gf-support-context","CCHANNEL2ID":"gf-roadmap-context"} # JSON mapping Slack Channel IDs to Context Slugs
    # FALLBACK_CONTEXT_SLUG=general-gf-context              # Default context if no specific mapping found
    # FORMATTER_CONTEXT_SLUG=gf-formatter-context           # Optional: Context specifically for formatting GitHub API responses

    # Behavior Tuning (Optional: Adjust if defaults aren't suitable)
    # PORT=3001                                             # Server port (defaults to 3000)
    # MIN_SUBSTANTIVE_RESPONSE_LENGTH=150                   # Min characters for a response to be considered 'substantive' (defaults to 100)
    # MAX_SLACK_BLOCK_CODE_LENGTH=2900                      # Max characters in a single Slack code block (defaults to 2800)

    # Add any other necessary variables defined in config.js if defaults need overriding
    ```

4.  **Database Setup (Optional):**
    * If you specified a `DATABASE_URL`, connect to your PostgreSQL database and execute the following SQL to create the necessary tables:

    ```sql
    CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        feedback_value VARCHAR(10), -- 'good', 'bad', 'ok'
        user_id VARCHAR(50),
        channel_id VARCHAR(50),
        bot_message_ts VARCHAR(50),
        original_user_message_ts VARCHAR(50),
        action_id VARCHAR(100),
        context_slug VARCHAR(100), -- The AI context used for the response
        bot_message_text TEXT,
        original_user_message_text TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS slack_ai_threads (
        id SERIAL PRIMARY KEY,
        slack_channel_id VARCHAR(50) NOT NULL,
        slack_thread_ts VARCHAR(50) NOT NULL,     -- The timestamp of the parent message of the Slack thread
        context_slug VARCHAR(100) NOT NULL,       -- The primary AI context associated with this thread
        ai_thread_id VARCHAR(100) NOT NULL,       -- The identifier for the conversation thread in the AI service
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (slack_channel_id, slack_thread_ts) -- Ensures one AI mapping per Slack thread
    );

    -- Optional: Index for faster lookups on thread mapping
    CREATE INDEX IF NOT EXISTS idx_slack_thread_lookup ON slack_ai_threads (slack_channel_id, slack_thread_ts);
    ```

5.  **Slack App Configuration:**
    * Go to your Slack App's configuration page ([api.slack.com/apps](https://api.slack.com/apps)).
    * **Event Subscriptions:**
        * Enable Events.
        * Set the Request URL to `https://<your-deployed-url>/slack/events` (replace `<your-deployed-url>` with your bot's public URL).
        * Subscribe to Bot Events like: `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`.
    * **Interactivity & Shortcuts:**
        * Enable Interactivity.
        * Set the Request URL to `https://<your-deployed-url>/slack/interactions`.
    * **Slash Commands:**
        * Create your desired commands (e.g., `/gh-latest`, `/gh-review`, `/gh-analyze`, `/gh-api`).
        * Set the Request URL for *each* command to `https://<your-deployed-url>/slack/interactions`.
    * **OAuth & Permissions:**
        * Ensure your bot has the necessary Bot Token Scopes. Essential scopes include:
            * `app_mentions:read`
            * `chat:write`
            * `commands`
            * `channels:history`, `groups:history`, `im:history`, `mpim:history` (for reading messages the bot can access)
            * `users:read` (to get user details if needed)
            * `reactions:write` (for adding feedback buttons, optional)
            * `chat:write.public` (if needed for certain channel interactions)
            * Check the specific Slack API methods used in the code for any additional required scopes.
        * Install (or reinstall) the app to your workspace after configuring scopes and URLs.

## Running the Application

**Ensure your `.env` file is correctly populated before running.**

### Locally (for Development)

1.  **Validate Configuration (Optional but Recommended):**
    ```bash
    npm run validate-config
    ```
2.  **Start the Development Server:**
    ```bash
    npm run dev
    ```
    * The server will typically start on port 3000 (or the `PORT` specified in `.env`).
    * It will automatically restart when you save file changes.
    * **Important:** Slack requires a public HTTPS URL for its webhooks. Use a tool like `ngrok` (`ngrok http 3000`) to expose your local server to the internet and update the Request URLs in your Slack App configuration accordingly during development.

### Using Docker

1.  **Build the Docker image:**
    ```bash
    docker build -t sagan-slack-bot .
    ```

2.  **Run the Docker container:**
    * Use `--env-file` to securely pass your environment variables from the `.env` file.
    * Map the container's port (default 3000 or specified `PORT`) to a host port.

    ```bash
    # Example running on port 3000
    docker run -d --name sagan-bot --restart unless-stopped \
      --env-file .env \
      -p 3000:3000 \
      sagan-slack-bot

    # Example if your bot runs on port 3001 inside the container
    # docker run -d --name sagan-bot --restart unless-stopped \
    #   --env-file .env \
    #   -p 3001:3001 \
    #   sagan-slack-bot
    ```
    * `-d`: Run in detached mode (background).
    * `--name sagan-bot`: Assign a convenient name to the container.
    * `--restart unless-stopped`: Automatically restart the container if it crashes or the Docker daemon restarts.
    * Make sure your deployment server's firewall allows incoming connections on the mapped host port (e.g., 3000 or 3001).

3.  **Check Container Logs:**
    ```bash
    docker logs sagan-bot -f
    ```

## Usage

Interact with Negm in channels where it has been added or via Direct Message.

* **General Questions:** Mention the bot (`@Negm`) or DM it. Start a thread to maintain conversation context.
    * Example: `@Negm How do I filter entries in Gravity Forms using gform_entries_field_value?`
* **Manual Context Override:** Add `#context-slug` at the end of your message to target a specific AI knowledge context.
    * Example: `@Negm Tell me about payment gateway integration #gf-payments`
* **GitHub Commands (via Message Prefix):** Start your message with `gh:`.
    * Get latest release: `gh: latest gravityforms` or `gh: latest gf` (if abbreviations are configured) or `gh: release rocketgenius/gravityforms`
    * Request PR Review Summary: `gh: review pr <owner/repo>#<pr_number> #<context_slug_for_review_ai>`
        * Example: `gh: review pr gravityforms/gravityforms#123 #gf-code-review`
    * Request Issue Analysis/Summary: `gh: analyze issue [#<issue_number> | <owner/repo>#<issue_number>] [Optional: specific question about the issue...]`
        * Example (repo context inferred): `gh: analyze issue #456 Summarize the main problem.`
        * Example (specific repo): `gh: analyze issue gravityforms/gravityflow#789`
    * Generic GitHub API Call: `gh: api <natural language query for GitHub API related to GF>`
        * Example: `gh: api list open issues labeled 'bug' in the gravityforms repo`
* **GitHub Commands (via Slash Commands):** Use the commands you configured in Slack.
    * `/gh-latest <repo_name_or_abbrev_or_owner/repo>`
    * `/gh-review <owner/repo>#<pr_number> #<context_slug_for_review_ai>`
    * `/gh-analyze [<owner/repo>]#<issue_number> [Optional: prompt...] #<context_slug_for_ai>`
    * `/gh-api <natural language query for GitHub API>`
* **Export Thread:** Reply to *any* message within a thread with exactly `#saveThread`. The bot will export the thread content as Markdown.
* **Provide Feedback:** React to the bot's response messages with 👍 (good), 👌 (okay), or 👎 (bad). This data can be used for improving the bot if the database is configured.
* **Delete Bot's Last Message:** Reply within a thread with exactly `#delete_last_message`. The bot will attempt to delete its own most recent message *in that specific thread*.

## Contributing

Please read `CONTRIBUTING.md` (if available) for details on our code of conduct, and the process for submitting pull requests.

## License

This project is licensed under the ISC License - see the `LICENSE` file for details.
