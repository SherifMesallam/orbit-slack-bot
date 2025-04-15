
// src/utils/formattingService.js
// Contains functions related to text extraction, splitting, and Slack formatting.

import {
    MAX_SLACK_BLOCK_TEXT_LENGTH,
    MAX_SLACK_BLOCK_CODE_LENGTH
} from '../config.js';

/**
 * =============================================================================
 *                          MESSAGE SPLITTING LOGIC
 * =============================================================================
 */

/**
 * Helper: Splits text purely by character count, trying to break at spaces/newlines intelligently.
 * @param {string} text - The text to split.
 * @param {number} maxLength - The maximum length for each chunk.
 * @returns {string[]} An array of text chunks.
 */
function splitByCharCount(text, maxLength) {
    const chunks = [];
    if (!text || text.length === 0) return chunks; // Handle empty input

    let remainingText = text;
    let isFirstChunk = true;

    while (remainingText.length > 0) {
        let currentChunk;
        if (remainingText.length <= maxLength) {
            currentChunk = remainingText;
            remainingText = ''; // End loop
        } else {
            let splitPoint = -1;
            // Try last newline first within the limit, preferring it if it's not too close to the start
            let newlineSplitPoint = remainingText.lastIndexOf('\n', maxLength);
            if (newlineSplitPoint > maxLength * 0.5) {
                 splitPoint = newlineSplitPoint + 1; // Split *after* newline
            } else {
                 // Try last space if newline wasn't suitable
                 let spaceSplitPoint = remainingText.lastIndexOf(' ', maxLength);
                 if (spaceSplitPoint > maxLength * 0.5) { // Prefer space if not too close to start
                     splitPoint = spaceSplitPoint + 1; // Split *after* space
                 }
            }

            // If no good split point found, force split at maxLength
            if (splitPoint === -1) {
                splitPoint = maxLength;
            }

            currentChunk = remainingText.substring(0, splitPoint);
            remainingText = remainingText.substring(splitPoint);
        }

        // Preserve trailing newline for the first chunk if it exists (e.g., start of code block)
        if (isFirstChunk && currentChunk.endsWith('\n')) {
             chunks.push(currentChunk);
        } else {
             chunks.push(currentChunk.trim()); // Trim whitespace from other chunks
        }
        isFirstChunk = false;
        remainingText = remainingText.trimStart(); // Trim leading whitespace for the next chunk
    }
    // Filter out potentially empty chunks created by splitting/trimming
    return chunks.filter(chunk => chunk.length > 0);
}

/**
 * Splits a message potentially containing markdown text and code blocks into Slack-friendly chunks.
 * Prioritizes keeping code blocks intact if possible. Adds numbering to multiple text chunks.
 * @param {string} message - The full message content.
 * @param {number} [maxLength=MAX_SLACK_BLOCK_TEXT_LENGTH] - Max length for text chunks.
 * @returns {string[]} An array of message chunks ready for posting.
 */
export function splitMessageIntoChunks(message, maxLength = MAX_SLACK_BLOCK_TEXT_LENGTH) {
    if (!message || message.trim().length === 0) return [''];

    const segments = extractTextAndCode(message); // Assumes extractTextAndCode exists in this file
    if (segments.length === 0) return [''];

    const finalChunks = [];
    let currentTextAccumulator = ''; // Accumulates text between code blocks

    function flushAccumulatedText() {
        if (currentTextAccumulator.trim().length > 0) {
            finalChunks.push(...splitByCharCount(currentTextAccumulator, maxLength));
        }
        currentTextAccumulator = '';
    }

    for (const segment of segments) {
        if (segment.type === 'code') {
            flushAccumulatedText(); // Process any text before this code block

            const langIdentifier = (segment.language && segment.language !== 'text') ? segment.language : '';
            // Ensure content inside block is trimmed, but keep surrounding newlines
            const codeBlockText = '```' + langIdentifier + '\n' + (segment.content || '').trim() + '\n```';

            // Determine the limit for this specific code block chunk
            const limitForThisCodeBlock = Math.max(maxLength, MAX_SLACK_BLOCK_CODE_LENGTH);

            // Split the code block itself if it exceeds the limit
            finalChunks.push(...splitByCharCount(codeBlockText, limitForThisCodeBlock));

        } else { // segment.type === 'text'
            // Add space separator unless the accumulator already ends with whitespace
            if (currentTextAccumulator.length > 0 && !/\s$/.test(currentTextAccumulator)) {
                 currentTextAccumulator += ' ';
            }
            currentTextAccumulator += segment.content;
        }
    }

    flushAccumulatedText(); // Flush any remaining text

    // Add chunk numbering [N/M] if there's more than one text chunk
    const nonEmptyChunks = finalChunks.filter(chunk => chunk && chunk.trim().length > 0);
    let nonCodeBlockCounter = 0;
    // Count only chunks that are NOT code blocks
    const totalNonCodeBlocks = nonEmptyChunks.filter(chunk => !chunk.trim().startsWith('```')).length;

    if (totalNonCodeBlocks > 1) {
        return nonEmptyChunks.map((chunk) => {
            if (!chunk.trim().startsWith('```')) {
                nonCodeBlockCounter++;
                return `[${nonCodeBlockCounter}/${totalNonCodeBlocks}] ${chunk}`;
            }
            return chunk; // Leave code blocks as is
        });
    } else {
        // Return the chunks, ensuring at least one empty string if all else fails
        return nonEmptyChunks.length > 0 ? nonEmptyChunks : [''];
    }
}


/**
 * =============================================================================
 *                       TEXT & CODE BLOCK EXTRACTION
 * =============================================================================
 */

/**
 * Extracts text and code segments from raw text containing markdown code blocks.
 * @param {string} rawText - The raw text potentially containing markdown code blocks.
 * @returns {Array<{type: 'text' | 'code', content: string, language?: string}>}
 */
export function extractTextAndCode(rawText) {
    if (!rawText) return [];

    const segments = [];
    // Regex:
    // ^``` : Start of line followed by ```
    //  *(\w+)? : Optional language identifier (word characters), captured in group 1
    //  *\\n? : Optional space, then optional newline
    // ([\s\S]*?) : Capture content (any char, non-greedy), captured in group 2
    // \\n?```$ : Optional newline, ```, end of line
    // gm : Global (find all) and Multiline (^$ match line breaks)
    const codeBlockRegex = /^``` *([\w\-]+)? *\n?([\s\S]*?)\n?```$/gm;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(rawText)) !== null) {
        const languageIdentifier = match[1]?.toLowerCase() || 'text';
        const codeContent = match[2] || ''; // Default to empty string if content is missing
        const startIndex = match.index;
        const endIndex = codeBlockRegex.lastIndex;

        // Add preceding text segment if it exists
        if (startIndex > lastIndex) {
            const textContent = rawText.substring(lastIndex, startIndex).trim();
            if (textContent.length > 0) {
                 segments.push({ type: 'text', content: textContent });
            }
        }
        // Add the code segment
        segments.push({
            type: 'code',
            content: codeContent, // Preserve original content formatting
            language: languageIdentifier
        });
        lastIndex = endIndex;
    }

    // Add any remaining text after the last code block
    if (lastIndex < rawText.length) {
         const textContent = rawText.substring(lastIndex).trim();
         if (textContent.length > 0) {
            segments.push({ type: 'text', content: textContent });
         }
    }

    return segments; // Return the array of text/code objects
}

/**
 * =============================================================================
 *                      SLACK RICH TEXT BLOCK FORMATTING
 * =============================================================================
 */

/**
 * Parses simple inline markdown formatting (**bold**, `code`, <links>) within a text segment.
 * Returns an array of Slack rich text elements suitable for a rich_text_section.
 * Note: Does NOT handle block-level elements. Ignores italics (*text* or _text_).
 * @param {string} text - The text segment to parse.
 * @returns {Array<object>} An array of Slack rich text elements.
 */
function parseInlineFormatting(text) {
    const elements = [];
    // Regex breakdown:
    // Group 1: Match known formats OR
    // Group 6: Match plain text segment
    // Known Formats:
    //   Group 2: \*\*(.*?)\*\* : Bold (**text**) content in group 3
    //   Group 4: `(.*?)`     : Code (`code`) content in group 5
    //   Group 6: <(https?:\/\/[^|>]+)(?:\|([^>]+))?> : Links (<http://url|text> or <http://url>)
    //                                                    URL in group 7, Optional Text in group 8
    const regex = /(\*\*(.*?)\*\*|`(.*?)`|<(https?:\/\/[^|>]+)(?:\|([^>]+))?>)|([^`*<]+)/g;
    let match;
    let lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
        // Add plain text preceding the current match
        if (match.index > lastIndex) {
            elements.push({ type: "text", text: text.substring(lastIndex, match.index) });
        }

        // Extract matched groups
        const boldContent = match[2];
        const codeContent = match[3];
        const linkUrl = match[4];
        const linkText = match[5];
        const plainTextSegment = match[6]; // This captures plain text BETWEEN formatted elements

        // Add the formatted element or the plain text segment
        if (boldContent !== undefined) {
            elements.push({ type: "text", text: boldContent, style: { bold: true } });
        } else if (codeContent !== undefined) {
            elements.push({ type: "text", text: codeContent, style: { code: true } });
        } else if (linkUrl) {
            // Use provided text or fallback to the URL itself if text is missing
            elements.push({ type: "link", url: linkUrl, text: linkText || linkUrl });
        } else if (plainTextSegment) {
            // This group captures runs of plain text
             elements.push({ type: "text", text: plainTextSegment });
        }

        lastIndex = regex.lastIndex; // Update position for next iteration
    }

    // Add any remaining plain text after the last match
    if (lastIndex < text.length) {
        elements.push({ type: "text", text: text.substring(lastIndex) });
    }

    return elements;
}


/**
 * Converts markdown text (potentially including a single code block)
 * into a single Slack rich_text block object.
 * Uses `rich_text_preformatted` for pure code blocks, `rich_text_section` otherwise.
 * @param {string} markdown - The markdown text for the block.
 * @param {string} [blockId] - Optional block_id for the rich_text block.
 * @returns {object | null} A Slack rich_text block object or null if input is empty/invalid.
 */
export function markdownToRichTextBlock(markdown, blockId = `block_${Date.now()}_${Math.random().toString(16).slice(2)}`) {
    if (!markdown || typeof markdown !== 'string' || markdown.trim().length === 0) {
        console.warn("[Formatting Service] markdownToRichTextBlock called with empty or invalid input.");
        return null;
    }

    // Detect if the *entire* trimmed input is just a single code block
    const codeBlockMatch = markdown.trim().match(/^```(?:[\w-]*)?\s*([\s\S]*?)\s*```$/);

    if (codeBlockMatch) {
        // Pure Code Block: Use rich_text_preformatted
        const codeContent = codeBlockMatch[1] || '';
        // console.log(`[Formatting Service] Detected pure code block.`);
        return {
            type: "rich_text",
            block_id: blockId,
            elements: [{
                type: "rich_text_preformatted",
                elements: [{ type: "text", text: codeContent }] // Raw code content inside text element
            }]
        };
    } else {
        // Regular Text or Mixed Content: Use rich_text_section
        // console.log(`[Formatting Service] Parsing as rich_text_section.`);
        const sectionElements = parseInlineFormatting(markdown); // Parse for **bold**, `code`, <links>

        if (sectionElements.length === 0) {
            // This might happen if input was only whitespace or unparsable chars
            console.warn(`[Formatting Service] No elements generated from parsing markdown section. Input: "${markdown.substring(0,50)}..."`);
            return null;
        }

        return {
            type: "rich_text",
            block_id: blockId,
            elements: [{
                type: "rich_text_section",
                elements: sectionElements // Array of text, link, styled text elements
            }]
        };
    }
}


console.log("[Formatting Service] Initialized.");
