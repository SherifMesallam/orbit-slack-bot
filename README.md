# Orbit Slack Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Orbit** is a modular Slack bot that serves as an AI assistant for developers working in the **Gravity Forms** ecosystem. It centralises reusable knowledge, automates common GitHub tasks and keeps conversation context at your fingertips—all without leaving Slack.

---

## Core value

Orbit is here to make our lives easier as Gravity Forms developers:

*   **Quick Answers & Code Help:** Get fast answers about Gravity Forms APIs, code patterns, or docs right in Slack. Ask Orbit to explain tricky code, check if a function or feature already exists exists (`'Do we have a method we can use to tell if a form is a convo form in the client side?'`), or see if an issue was already created (`'is there a issue about Y?'`). Spend less time digging and more time coding.
*   **GitHub Tasks in Slack:** Handle common GitHub chores without switching windows. Use the `gh:` prefix or `/gh-*` commands to fetch latest releases, get AI summaries/analysis for issues and PRs (Orbit can even suggest fixes or help with reviews), or run simple GitHub API queries using plain English.
*   **Code-Aware Knowledge Base:** Behind the scenes, Orbit uses a custom RAG system (based on a modified version of [`anythingLLM`](https://github.com/Mintplex-Labs/anything-llm)) to index our knowledge. It's designed to understand code specifically – distinguishing it from regular text and grasping relationships between features and functions, classes, etc. This helps Orbit provide more relevant answers and make smarter connections when you ask questions.
*   **Connect Knowledge & Avoid Repetition:** Orbit helps bring together info from our codebase, issues, PRs, docs, and importantly, saved Slack discussions. Seeing how things connect helps us make better decisions and avoid repeating work or breaking stuff for customers. Save useful conversations to Orbit so the *whole team* can find that knowledge later, instead of it being lost or stuck with one person.

---

## Features

| category | what it does |
| --- | --- |
| **AI-powered Q&A** | answers questions about Gravity Forms development, documentation, code examples and best practices directly inside Slack threads, using the most relevant knowledge context |
| **GitHub integration** | via the `gh:` message prefix **or** `/gh-*` slash commands:<br>• fetch the latest release for any repo<br>• generate an AI review summary of a pull request<br>• generate an AI analysis/summary of an issue<br>• perform generic GitHub API calls from natural-language queries |
| **Conversation export** | reply `#saveThread` to export an entire Slack thread to markdown for docs or offline sharing |
| **Feedback loop** | react 👍 / 👌 / 👎 on bot responses to help refine accuracy |
| **Context management** | automatically routes queries to the correct knowledge context (core, specific add-on, etc.), with manual override via `#context-slug` |
| **Thread context** | maintains conversational history within Slack threads for coherent dialogue |
| **Dockerised** | ships with a `Dockerfile` and `.dockerignore` for straightforward containerisation and deployment |

---

## Architecture overview

Orbit follows a **modular-monolith** layout: feature folders isolate code concerns, yet everything runs as one deployable service.

```text
src/
 ├─ app.js               # express server & middleware
 ├─ server.js            # entry point + graceful shutdown
 ├─ config.js            # env-var loading & runtime checks
 ├─ core/
 │   └─ dispatcher.js    # routes slack events/interactions
 ├─ handlers/            # logic for events, commands, actions
 ├─ services/            # redis, db, github, ai, slack clients
 ├─ utils/               # shared helpers (formatting, etc.)
 └─ features/            # self-contained modules (e.g. conversationExport.js)
```

---

## Prerequisites

### required

* **node.js** 18 lts (or 20 lts) and npm/yarn  
* a **slack workspace** with a configured slack app:  
  * slack bot token (`xoxb-…`)  
  * slack signing secret  
* an **ai / llm provider** (base url + api key)  
* **github** personal-access token with scopes `repo`, `read:user`  

### optional

* docker  
* redis url (event deduplication)  
* postgresql url (feedback & thread-mapping storage)  

---

## Setup and configuration

1. **clone the repo**

   ```bash
   git clone https://github.com/yourusername/orbit-slack-bot.git
   cd orbit-slack-bot
   ```

2. **install dependencies**

   ```bash
   npm install     # or: yarn install
   ```

3. **create `.env`** (copy `.env.example` if present) and fill in the required values. **never commit** this file.

   ```dotenv
   # ─── required ─────────────────────────────────────────────────────
   # slack
   SLACK_SIGNING_SECRET=your-slack-signing-secret
   SLACK_BOT_TOKEN=xoxb-your-bot-token
   SLACK_BOT_USER_ID=UXXXXXXXXXX

   # ai / llm
   LLM_API_BASE_URL=https://your-ai-service
   LLM_API_KEY=your-ai-key

   # github
   GITHUB_TOKEN=ghp_your_pat
   GITHUB_CONTEXT_SLUG=gf-dev-context-for-gh-api

   # ─── optional services ────────────────────────────────────────────
   # GITHUB_OWNER=gravityforms
   # REDIS_URL=redis://user:pass@host:6379
   # DATABASE_URL=postgresql://user:pass@host:5432/database

   # ─── behaviour tuning ─────────────────────────────────────────────
   # PORT=3001
   # MIN_SUBSTANTIVE_RESPONSE_LENGTH=150
   # MAX_SLACK_BLOCK_CODE_LENGTH=2900
   ```

4. **database setup (optional)**

   if `DATABASE_URL` is provided, run:

   ```sql
   CREATE TABLE IF NOT EXISTS feedback (
       id SERIAL PRIMARY KEY,
       feedback_value VARCHAR(10),
       user_id VARCHAR(50),
       channel_id VARCHAR(50),
       bot_message_ts VARCHAR(50),
       original_user_message_ts VARCHAR(50),
       action_id VARCHAR(100),
       context_slug VARCHAR(100),
       bot_message_text TEXT,
       original_user_message_text TEXT,
       created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
   );

   CREATE TABLE IF NOT EXISTS slack_ai_threads (
       id SERIAL PRIMARY KEY,
       slack_channel_id VARCHAR(50) NOT NULL,
       slack_thread_ts VARCHAR(50) NOT NULL,
       context_slug VARCHAR(100) NOT NULL,
       ai_thread_id VARCHAR(100) NOT NULL,
       created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
       last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
       UNIQUE (slack_channel_id, slack_thread_ts)
   );

   CREATE INDEX IF NOT EXISTS idx_slack_thread_lookup
     ON slack_ai_threads (slack_channel_id, slack_thread_ts);
   ```

5. **configure your slack app**

   * **event subscriptions** → enable and set request url to `https://<your-url>/slack/events`  
   * **interactivity & shortcuts** → `https://<your-url>/slack/interactions`  
   * **slash commands** → point each command to the same interactions endpoint  
   * **scopes** → at minimum:  
     * `app_mentions:read`  
     * `chat:write`, `chat:write.public`  
     * `commands`  
     * `channels:history`, `groups:history`, `im:history`, `mpim:history`  
     * `users:read`  
     * `reactions:write`  
   * install / re-install the app after updating scopes  

---

## Running the application

### local development

```bash
npm run validate-config   # optional sanity check
npm run dev               # starts nodemon on port 3000 (or $PORT)
```

> slack requires a public https endpoint. use **ngrok** during development:
>
> ```bash
> ngrok http 3000
> ```

### docker

```bash
docker build -t orbit-slack-bot .

docker run -d --name orbit-bot --restart unless-stopped   --env-file .env   -p 3000:3000   orbit-slack-bot
```

for multi-container setups (`docker-compose.yml` with redis/postgres) run:

```bash
docker-compose up -d
```

---

## Usage

| action                      | how                                                                                                                                                                                                                                                            |
|-----------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **ask a question**          | mention `@orbit` or dm it; start a thread to keep context.<br>example: `@orbit how can I use the flyout component from gravitypackages?`                                                                                                                       |
| **override context**        | append `#context-slug`.<br>example: `@orbit does #gravityflow support this feature?`                                                                                                                                                                           |
| **github via prefix**       | start a message with `gh:`.<br>• `gh: latest gravityforms`<br>• `gh: review pr gravityforms/gravityforms#123 #gf-code-review`<br>• `gh: analyze issue #456 summarise the main problem.`<br>• `gh: api list open issues labeled "bug" in the gravityforms repo` |
| **github via slash**        | `/gh-latest gravityforms`<br>`/gh-review gravityforms/gravityforms#123 #gf-code-review`<br>`/gh-analyze gravityforms/gravityflow#789`<br>`/gh-api <natural language query>`                                                                                    |
| **export thread**           | reply `#saveThread` anywhere in the thread                                                                                                                                                                                                                     |
| **delete last bot message** | reply `#delete_last_message` inside the thread                                                                                                                                                                                                                 |
| **feedback**                | react with 👍 (good), 👌 (okay) or 👎 (bad) on any bot message                                                                                                                                                                                                 |

## Developer Tools & Testing Options

### Intent Detection Dry Run Mode

The bot includes a debug feature called Intent Detection Dry Run Mode. When enabled (default is true), it will:

1. Run intent detection on user messages as normal
2. Return detailed debug information about the intent detected
3. **NOT** actually invoke the intent handler implementation

This is useful for:
- Testing how the intent detection system classifies different messages
- Seeing what workspace would be suggested for a given query
- Debugging intent detection without executing any actions

To enable/disable this feature, set the `INTENT_DETECTION_DRY_RUN` environment variable:

```dotenv
# Enable dry run mode (default)
INTENT_DETECTION_DRY_RUN=true  

# Disable dry run mode (normal operation)
INTENT_DETECTION_DRY_RUN=false
```

When enabled, the bot will respond with messages like:
- `✅ DRY RUN: Intent 'github_issue_summary' detected (confidence: 85.2%) with suggested workspace 'gravityforms'`
- A detailed breakdown of the intent detection results
- Information about what handler would have been invoked
