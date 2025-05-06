// Moved from root src/
// Handles exporting Slack conversations to Markdown and optionally uploading to AnythingLLM.

import { slackClient } from '../services/slackService.js'; // Use slackClient from service
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { anythingLLMBaseUrl, anythingLLMApiKey } from '../config.js'; // Use config
import axios from 'axios';
import process from 'process'; // Import process for cwd

/**
 * Fetches user info from Slack API with caching.
 * @param {string} userId - The Slack User ID.
 * @param {object} userInfoCache - A cache object { userId: userData }.
 * @returns {Promise<object>} Slack user object or a default object on error.
 */
async function getUserInfo(userId, userInfoCache) {
     if (userInfoCache[userId]) {
        return userInfoCache[userId];
     }
     if (!slackClient) { // Check if client is available
         console.error("Slack client not available in getUserInfo.");
         return { real_name: 'Unknown User (Slack Client Error)' };
     }
     try {
        const result = await slackClient.users.info({ user: userId });
        if (result.ok && result.user) {
            userInfoCache[userId] = result.user;
            return result.user;
        } else {
            console.error(`Error fetching user info for ${userId}:`, result.error);
            userInfoCache[userId] = { real_name: `Unknown User (${userId})` };
            return userInfoCache[userId];
        }
    } catch (error) {
        console.error(`Network/API error fetching user info for ${userId}:`, error.message);
        userInfoCache[userId] = { real_name: 'Unknown User (Fetch Error)' };
        return userInfoCache[userId];
    }
}


/**
 * Formats a Slack message into Markdown.
 * @param {object} message - Slack message object.
 * @param {object} userInfoCache - User info cache object.
 * @returns {Promise<string>} Formatted markdown string.
 */
async function formatMessageToMarkdown(message, userInfoCache) {
    // Skip non-user messages, commands, status updates etc.
    if (!message.user || message.subtype || message.type !== 'message' || message.text?.startsWith('gh:') || message.text?.includes('#remember')) {
        return '';
    }

    const user = await getUserInfo(message.user, userInfoCache);
    const userName = user?.real_name || user?.name || `Unknown User (${message.user})`;
    const timestamp = new Date(parseFloat(message.ts) * 1000).toISOString();

    // Process message text - Prioritize blocks if available
    let messageText = '';
    if (message.blocks) {
        // Basic block text extraction (can be enhanced)
        try {
             messageText = message.blocks.map(block => {
                if (block.type === 'rich_text') {
                    return block.elements?.map(element => {
                        if (element.type === 'rich_text_section') {
                            return element.elements?.map(el => {
                                if (el.type === 'text') return el.text;
                                if (el.type === 'link') return `<${el.url}|${el.text || el.url}>`;
                                if (el.type === 'user') return `<@${el.user_id}>`;
                                return ''; // Handle other element types if needed
                            }).join('');
                        } else if (element.type === 'rich_text_preformatted') {
                            const codeContent = element.elements?.map(el => el.text || '').join('');
                            return `\n\`\`\`\n${codeContent}\n\`\`\`\n`;
                        } else if (element.type === 'rich_text_quote') {
                            const quoteContent = element.elements?.map(el => el.text || '').join('');
                            return `> ${quoteContent}\n`;
                        }
                        return '';
                    }).join('');
                }
                // Add extraction for other block types if needed
                return '';
            }).join('\n').trim();
        } catch(blockError) {
            console.error("Error processing blocks for export:", blockError);
            messageText = message.text || ''; // Fallback to simple text
        }
    }

    // Use message.text as fallback if blocks processing failed or no blocks
    if (!messageText) {
        messageText = message.text || '';
    }

    // Basic Slack mrkdwn to Markdown conversion (can be improved)
    // Handle user mentions <@Uxxxxxxx> -> @Real Name
    messageText = messageText.replace(/<@(\w+)>/g, (match, userId) => {
        // Use cache, but don't await inside replace directly
        const mentionedUser = userInfoCache[userId];
        return `@${mentionedUser?.real_name || userId}`;
    });
    // Handle links <http://url|text> -> [text](http://url)
    messageText = messageText.replace(/<([^|>]+)\|([^>]+)>/g, '[$2]($1)');
    // Handle links <http://url> -> [http://url](http://url)
    messageText = messageText.replace(/<([^|>]+)>/g, '[$1]($1)');
    // Handle bold *text* -> **text**
    messageText = messageText.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '**$1**');
    // Handle inline code `code` -> `code` (already compatible)
    // Handle code blocks ```code``` -> ```code``` (already compatible)

    // Final formatting
    return `### ${userName} (${timestamp})\n\n${messageText.trim()}\n\n---\n\n`;
}


/**
 * Adds an uploaded document (by its AnythingLLM path) to the 'conversations' workspace.
 * @param {string} docPath - The path of the uploaded document within AnythingLLM (e.g., 'custom-documents/user-upload.pdf').
 * @returns {Promise<object>} Response from AnythingLLM workspace update endpoint.
 * @throws {Error} If API call fails.
 */
async function addToConversationsWorkspace(docPath) {
    if (!anythingLLMBaseUrl || !anythingLLMApiKey) throw new Error("LLM Service not configured.");
    if (!docPath) throw new Error("Document path is required to add to workspace.");

    const workspaceSlug = 'conversations'; // Hardcoded target workspace
    console.log(`[Export/LLM] Adding doc '${docPath}' to workspace '${workspaceSlug}'...`);
    const updateUrl = `${anythingLLMBaseUrl}/api/v1/workspace/${workspaceSlug}/update-embeddings`;
    const requestBody = { adds: [docPath], deletes: [] };

    try {
        const response = await axios.post(updateUrl, requestBody, {
            headers: {
                'Authorization': `Bearer ${anythingLLMApiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        console.log(`[Export/LLM] Workspace '${workspaceSlug}' update successful.`);
        return response.data;
    } catch (error) {
        console.error(`[Export/LLM] Error adding doc '${docPath}' to workspace '${workspaceSlug}':`, error.response?.data || error.message);
        throw new Error(`Failed to add document to workspace ${workspaceSlug}: ${error.message}`);
    }
}

/**
 * Uploads content as a file to AnythingLLM, moves it, and adds to the 'conversations' workspace.
 * @param {string} content - The markdown content to upload.
 * @param {string} baseFilename - Base filename suggestion (e.g., conversation-channel-ts.md).
 * @returns {Promise<object>} Combined response from AnythingLLM including upload, move, and workspace update results.
 * @throws {Error} If any step fails.
 */
async function uploadToAnythingLLM(content, baseFilename) {
     if (!anythingLLMBaseUrl || !anythingLLMApiKey) throw new Error("LLM Service not configured.");

    let finalFilename = baseFilename; // Start with base name

    // --- Optional: Get LLM Title (Best Effort) ---
    try {
        const titlePrompt = 'Suggest a concise, descriptive title (max 10 words) for this Slack conversation snippet. Output ONLY the title text:';
        // Send only a snippet to LLM for title generation to save tokens/time
        const snippet = content.substring(0, 1500); // Send first 1500 chars
        const titleQuery = `${titlePrompt}\n\n---\n\n${snippet}\n\n---`;
        const chatResponse = await axios.post(
            `${anythingLLMBaseUrl}/api/v1/workspace/all/chat`, // Use 'all' or a general workspace for titling
            { message: titleQuery, mode: 'chat' }, // Use query mode maybe?
            { headers: { 'Authorization': `Bearer ${anythingLLMApiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' }, timeout: 200000 } // 20s timeout for title
        );
        let suggestedTitle = chatResponse.data?.textResponse?.trim();
        if (suggestedTitle) {
            // Sanitize title for filename
            suggestedTitle = suggestedTitle.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').substring(0, 50); // Limit length
            if (suggestedTitle) {
                const dateSuffix = new Date().toISOString().split('T')[0];
                finalFilename = `${suggestedTitle}-${dateSuffix}.md`;
                console.log(`[Export/LLM] Using LLM-suggested filename: ${finalFilename}`);
            }
        }
    } catch (titleError) {
        console.warn('[Export/LLM] Error getting title from LLM, using default filename:', titleError.message);
        // Keep default filename if titling fails
    }
    // --- End Optional Title ---

    // Create a temporary file for upload
    const tempDir = path.join(process.cwd(), 'temp_exports'); // Use a specific temp dir
    if (!fs.existsSync(tempDir)) { fs.mkdirSync(tempDir, { recursive: true }); }
    const tempFilePath = path.join(tempDir, finalFilename);
    fs.writeFileSync(tempFilePath, content);
    console.log(`[Export/LLM] Wrote content to temporary file: ${tempFilePath}`);

    let uploadResponseData = null;
    let docPath = null;

    try {
        // --- Upload File ---
        const form = new FormData();
        form.append('file', fs.createReadStream(tempFilePath));
        console.log(`[Export/LLM] Uploading '${finalFilename}' to ${anythingLLMBaseUrl}/api/v1/document/upload`);
        const uploadResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/document/upload`, form, {
            headers: { ...form.getHeaders(), 'Authorization': `Bearer ${anythingLLMApiKey}`, 'Accept': 'application/json' },
            maxContentLength: Infinity, maxBodyLength: Infinity // Handle potentially large files
        });
        uploadResponseData = uploadResponse.data;
        console.log('[Export/LLM] Upload Response:', uploadResponseData);

        // Check for success and the presence of the document object
        if (!uploadResponseData.success || !uploadResponseData.document) {
            throw new Error(`Upload failed or document object missing in response: ${JSON.stringify(uploadResponseData)}`);
        }

        // Attempt to get docPath from 'location', fallback to 'file_name'
        docPath = 'custom-documents/' + uploadResponseData.document.file_name + '-' + uploadResponseData.document.id + '.json';

        if (!docPath) {
            throw new Error(`Essential document path (location or file_name) not found in upload response: ${JSON.stringify(uploadResponseData.document)}`);
        }
        console.log(`[Export/LLM] Document uploaded successfully. Using path for move: ${docPath}`);
        // --- End Upload File ---

        // --- Move File ---
        const targetFolder = 'conversations'; // Target folder within AnythingLLM
        const targetPath = `${targetFolder}/${uploadResponseData.document.file_name}`;
        console.log(`[Export/LLM] Moving doc from '${docPath}' to '${targetPath}'`);
        const moveResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/document/move-files`, {
            files: [{ from: docPath, to: targetPath }]
        }, { headers: { 'Authorization': `Bearer ${anythingLLMApiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' } });
        console.log('[Export/LLM] Move Response:', moveResponse.data);
        if (!moveResponse.data?.ok) { // Check move status if API provides it
            console.warn(`[Export/LLM] File move might have failed (API response: ${JSON.stringify(moveResponse.data)})`);
            // Decide if this is fatal - for now, we'll proceed to add to workspace using the *new* path
        }
        // --- End Move File ---

        // --- Add to Workspace ---
        const workspaceUpdateResponse = await addToConversationsWorkspace(targetPath); // Use the new target path
        // --- End Add to Workspace ---

        return { upload: uploadResponseData, move: moveResponse.data, workspace: workspaceUpdateResponse };

    } catch (error) {
         console.error('[Export/LLM] Error during upload/move/add process:', error.message);
         // Re-throw to be caught by the caller
         throw error;
    } finally {
        // Clean up temp file regardless of success/failure
        if (fs.existsSync(tempFilePath)) {
            fs.unlink(tempFilePath, (err) => {
                if (err) console.error(`[Export/LLM] Error deleting temp file ${tempFilePath}:`, err);
                else console.log(`[Export/LLM] Deleted temp file: ${tempFilePath}`);
            });
        }
    }
}


/**
 * Exports a Slack conversation to Markdown and optionally uploads to AnythingLLM.
 * @param {string} channelId - Slack channel ID.
 * @param {string} threadTs - Thread timestamp (start of the thread).
 * @param {boolean} [uploadToLLM=true] - Whether to attempt upload to AnythingLLM.
 * @returns {Promise<{content: string, metadata: object, llmUploadResult?: object, llmUploadError?: string}>} Result object.
 */
export async function exportConversationToMarkdown(channelId, threadTs, uploadToLLM = true) {
    console.log(`[Export] Starting export for channel ${channelId}, thread ${threadTs}`);
    let channelName = `channel-${channelId}`; // Default name
    try {
        // Get channel info (best effort)
        if (slackClient) {
            try {
                const channelInfo = await slackClient.conversations.info({ channel: channelId });
                channelName = channelInfo.channel?.name || channelName;
            } catch (infoError) { console.warn(`[Export] Could not get channel info for ${channelId}:`, infoError.message); }
        }

        // Get conversation history
        let allMessages = [];
        let cursor;
        let fetchAttempts = 0;
        const MAX_FETCH_ATTEMPTS = 5; // Limit pagination loops

        if (!slackClient) throw new Error("Slack client not initialized for history fetch.");

        do {
            fetchAttempts++;
            if (fetchAttempts > MAX_FETCH_ATTEMPTS) {
                 console.warn(`[Export] Exceeded max pagination attempts (${MAX_FETCH_ATTEMPTS}) for thread ${threadTs}. Export may be incomplete.`);
                 break;
            }
            console.log(`[Export] Fetching replies page ${fetchAttempts} (cursor: ${cursor || 'start'})`);
            const result = await slackClient.conversations.replies({
                channel: channelId, ts: threadTs, limit: 200, cursor: cursor // Fetch max 200 per page
            });
            if (!result.ok || !result.messages) throw new Error(`Failed fetch history page ${fetchAttempts}: ${result.error}`);
            allMessages = allMessages.concat(result.messages);
            cursor = result.response_metadata?.next_cursor;
        } while (cursor);
        console.log(`[Export] Fetched total ${allMessages.length} messages.`);

        // Format messages to Markdown
        const userInfoCache = {}; // Cache for user lookups within this export
        let markdown = `# Slack Conversation Export\n\n**Channel:** #${channelName}\n**Thread Start:** ${new Date(parseFloat(threadTs) * 1000).toISOString()}\n\n---\n\n`;
        for (const message of allMessages) {
            markdown += await formatMessageToMarkdown(message, userInfoCache); // Ensure helper handles cache/API calls
        }

        const metadata = {
            exportedAt: new Date().toISOString(), channelId, channelName, threadTs, messageCount: allMessages.length
        };

        const exportResult = { content: markdown, metadata };

        // Upload to AnythingLLM if requested
        if (uploadToLLM && anythingLLMBaseUrl && anythingLLMApiKey) {
            try {
                const filename = `conversation-${metadata.channelName}-${threadTs}.md`;
                console.log(`[Export] Attempting upload to AnythingLLM as '${filename}'...`);
                const llmResponse = await uploadToAnythingLLM(markdown, filename);
                exportResult.llmUploadResult = llmResponse; // Attach detailed result
                console.log(`[Export] Upload to AnythingLLM successful.`);
            } catch (error) {
                console.error('[Export] Error uploading to AnythingLLM:', error.message);
                exportResult.llmUploadError = error.message || 'Unknown upload error';
            }
        } else if (uploadToLLM) {
             console.warn("[Export] Upload to LLM requested but LLM is not configured.");
             exportResult.llmUploadError = "LLM service not configured";
        }

        console.log(`[Export] Finished export for ${channelId}:${threadTs}. Messages: ${metadata.messageCount}. Uploaded: ${!!exportResult.llmUploadResult}`);
        return exportResult;

    } catch (error) {
        console.error(`[Export] Fatal error exporting conversation ${channelId}:${threadTs}:`, error);
        // Re-throw or return an error structure
        throw new Error(`Failed to export conversation: ${error.message}`);
    }
}

console.log("[Conversation Export] Initialized.");
