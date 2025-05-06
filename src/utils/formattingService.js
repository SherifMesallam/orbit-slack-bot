// src/utils/formattingService.js
// Contains functions related to text extraction, splitting, and Slack formatting.
// Includes improvements for robustness and Slack API compliance (avoids empty text elements).

import {
    MAX_SLACK_BLOCK_TEXT_LENGTH,
    MAX_SLACK_BLOCK_CODE_LENGTH
} from '../config.js'; // Assuming config.js is in the parent directory

/**
 * =============================================================================
 * MESSAGE SPLITTING LOGIC
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
    // Handle null/undefined/empty input gracefully
    if (!text || text.length === 0) {
        // console.warn("[Formatting Service] splitByCharCount called with empty input.");
        return chunks;
    }

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
            // Prefer newline if it exists and is past the halfway point
            if (newlineSplitPoint > maxLength * 0.5) {
                 splitPoint = newlineSplitPoint + 1; // Split *after* newline
            } else {
                 // Try last space if newline wasn't suitable
                 let spaceSplitPoint = remainingText.lastIndexOf(' ', maxLength);
                 // Prefer space if it exists and is past the halfway point
                 if (spaceSplitPoint > maxLength * 0.5) {
                     splitPoint = spaceSplitPoint + 1; // Split *after* space
                 }
            }

            // If no good split point found (only very long words/no spaces/newlines), force split at maxLength
            if (splitPoint === -1) {
                // Check if maxLength itself is a space or newline, prefer splitting before it if so
                if (maxLength > 0 && /\s/.test(remainingText[maxLength])) {
                     splitPoint = maxLength;
                } else if (maxLength > 1 && /\s/.test(remainingText[maxLength - 1])) {
                     splitPoint = maxLength -1;
                // Otherwise, force split, potentially mid-word
                } else {
                     splitPoint = maxLength;
                }
            }

            // Ensure splitPoint is valid
             splitPoint = Math.max(1, splitPoint); // Avoid splitPoint 0 if maxLength is 0 or issue occurs

            currentChunk = remainingText.substring(0, splitPoint);
            remainingText = remainingText.substring(splitPoint);
        }

        // Preserve trailing newline for the first chunk if it exists (e.g., start of code block)
        // Trim other chunks to avoid artificial whitespace gaps.
        const chunkToPush = (isFirstChunk && currentChunk.endsWith('\n')) ? currentChunk : currentChunk.trim();

        // Only push non-empty chunks (trimming might make it empty)
        if (chunkToPush.length > 0) {
             chunks.push(chunkToPush);
        }

        isFirstChunk = false;
        remainingText = remainingText.trimStart(); // Trim leading whitespace for the next chunk
    }
    // Final filter just in case, although logic above should prevent empty strings
    return chunks.filter(chunk => chunk.length > 0);
}

/**
 * Splits a message potentially containing markdown text and code blocks into Slack-friendly chunks.
 * Prioritizes keeping code blocks intact if possible. Adds numbering to multiple text chunks.
 * @param {string} message - The full message content.
 * @param {number} [maxLength=MAX_SLACK_BLOCK_TEXT_LENGTH] - Max length for text chunks.
 * @returns {string[]} An array of message chunks ready for posting. Returns [''] if input is effectively empty.
 */
export function splitMessageIntoChunks(message, maxLength = MAX_SLACK_BLOCK_TEXT_LENGTH) {
    // Enhanced input validation
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        console.warn(`[Formatting Service] splitMessageIntoChunks called with empty or invalid input. Type: ${typeof message}`);
        return ['']; // Return a single empty string block as Slack often requires some content
    }

    const segments = extractTextAndCode(message);
    if (segments.length === 0) {
         console.warn("[Formatting Service] extractTextAndCode returned no segments for non-empty input. Input (start):", message.substring(0, 100));
        // If extraction yielded nothing from non-empty trimmed input, split the original message directly
        // This could happen if the message has unusual formatting not matching the code block regex
         return splitByCharCount(message.trim(), maxLength);
        // return ['']; // Or return empty if preferred
    }

    const finalChunks = [];
    let currentTextAccumulator = ''; // Accumulates text between code blocks

    function flushAccumulatedText() {
        const trimmedAccumulator = currentTextAccumulator.trim();
        if (trimmedAccumulator.length > 0) {
            const splitText = splitByCharCount(trimmedAccumulator, maxLength);
            if (splitText.length > 0) {
                finalChunks.push(...splitText);
            } else {
                 console.warn("[Formatting Service] splitByCharCount resulted in zero chunks from non-empty trimmed accumulator:", trimmedAccumulator.substring(0,100));
            }
        }
        currentTextAccumulator = '';
    }

    for (const segment of segments) {
        if (segment.type === 'code') {
            flushAccumulatedText(); // Process any text before this code block

            const langIdentifier = (segment.language && segment.language !== 'text') ? segment.language : '';
            // Ensure content inside block is trimmed, but keep surrounding newlines for ``` formatting
            const codeBlockContent = (segment.content || '').trim(); // Trim internal content first
            // Avoid adding extra newlines if content is empty
            const codeBlockText = codeBlockContent.length > 0
                 ? '```' + langIdentifier + '\n' + codeBlockContent + '\n```'
                 : '```' + langIdentifier + '\n```'; // Represent empty code block

            // Determine the limit for this specific code block chunk
            // Use the larger of the default maxLength or the specific code block max length
            const limitForThisCodeBlock = Math.max(maxLength, MAX_SLACK_BLOCK_CODE_LENGTH);

            // Split the code block itself if it exceeds the limit
            const splitCode = splitByCharCount(codeBlockText, limitForThisCodeBlock);
             if (splitCode.length > 0) {
                 finalChunks.push(...splitCode);
             } else {
                 console.warn("[Formatting Service] splitByCharCount resulted in zero chunks from code block:", codeBlockText.substring(0,100));
             }

        } else { // segment.type === 'text'
            // Add space separator unless the accumulator is empty or already ends with whitespace
            if (currentTextAccumulator.length > 0 && !/\s$/.test(currentTextAccumulator)) {
                 currentTextAccumulator += ' ';
            }
            currentTextAccumulator += segment.content; // Add the raw content
        }
    }

    flushAccumulatedText(); // Flush any remaining text

    // Filter out any potentially empty chunks again (belt-and-suspenders)
    const nonEmptyChunks = finalChunks.filter(chunk => chunk && chunk.trim().length > 0);

    // Count only chunks that are NOT code blocks for numbering
    let nonCodeBlockCounter = 0;
    const totalNonCodeBlocks = nonEmptyChunks.filter(chunk => !chunk.trim().startsWith('```')).length;

    let numberedChunks = [];
    if (totalNonCodeBlocks > 1) {
        numberedChunks = nonEmptyChunks.map((chunk) => {
            // Check if it's NOT a code block before numbering
            if (!chunk.trim().startsWith('```')) {
                nonCodeBlockCounter++;
                // Ensure chunk content itself is trimmed before prepending number
                return `[${nonCodeBlockCounter}/${totalNonCodeBlocks}] ${chunk.trim()}`;
            }
            return chunk; // Leave code blocks as is
        });
    } else {
        // No numbering needed, just use the non-empty chunks
        numberedChunks = nonEmptyChunks;
    }

    // Ensure we always return at least [''] if everything got filtered out
    return numberedChunks.length > 0 ? numberedChunks : [''];
}


/**
 * =============================================================================
 * TEXT & CODE BLOCK EXTRACTION
 * =============================================================================
 */

/**
 * Extracts text and code segments from raw text containing markdown code blocks.
 * @param {string} rawText - The raw text potentially containing markdown code blocks.
 * @returns {Array<{type: 'text' | 'code', content: string, language?: string}>}
 */
export function extractTextAndCode(rawText) {
	console.log( `[Msg Handler] LLM Raw response: ${rawText}`)
    // Return empty array for null/undefined input immediately
    if (rawText === null || rawText === undefined) return [];
    // Allow empty string input to proceed, might contain only code blocks later
    if (typeof rawText !== 'string') return [];


    const segments = [];
    // Improved regex that matches code blocks more flexibly:
    // 1. Allows code blocks to appear anywhere, not just at line start
    // 2. Better handling of language identifiers
    // 3. More permissive of whitespace variations
    const codeBlockRegex = /```([\w\-]+)?\s*([\s\S]*?)\s*```/gm;
    
    let lastIndex = 0;
    let match;

    // Reset lastIndex before exec
    codeBlockRegex.lastIndex = 0;

    while ((match = codeBlockRegex.exec(rawText)) !== null) {
        // Use 'text' as default language if identifier is missing or empty
        const languageIdentifier = match[1]?.trim() ? match[1].trim().toLowerCase() : 'text';
        const codeContent = match[2] || ''; // Default to empty string if content is missing
        const startIndex = match.index;
        const endIndex = codeBlockRegex.lastIndex;

        // Add preceding text segment if it exists and isn't just whitespace
        if (startIndex > lastIndex) {
            const textContent = rawText.substring(lastIndex, startIndex).trim();
            if (textContent.length > 0) {
                 segments.push({ type: 'text', content: textContent });
            }
        }
        // Add the code segment
        segments.push({
            type: 'code',
            content: codeContent, // Preserve original content formatting within the block for now
            language: languageIdentifier
        });
        lastIndex = endIndex;
    }

    // Add any remaining text after the last code block if it exists and isn't just whitespace
    if (lastIndex < rawText.length) {
         const textContent = rawText.substring(lastIndex).trim();
         if (textContent.length > 0) {
            segments.push({ type: 'text', content: textContent });
         }
    }

    // If the input was non-empty but only whitespace, segments might be empty.
    // If input had content but only code blocks, segments would contain only code.
    // If input had content but only text, segments would contain only text.
    return segments;
}

/**
 * =============================================================================
 * SLACK RICH TEXT BLOCK FORMATTING
 * =============================================================================
 */

/**
 * Parses simple inline markdown formatting within a text segment for Slack rich text.
 * Returns an array of Slack rich text elements suitable for a rich_text_section block.
 * IMPORTANT: Filters out any generated text elements with empty strings to prevent API errors.
 * Handles: **bold**, _italic_, ~strike~, `code`, <links>, [links](url).
 *
 * @param {string} text - The text segment to parse.
 * @returns {Array<object>} An array of Slack rich text elements (type: "text" or type: "link").
 */
function parseInlineFormatting(text) {
    // Return empty array for empty, null, or non-string input
    if (!text || typeof text !== 'string' || text.length === 0) {
        return [];
    }

    const elements = [];
    let currentIndex = 0;

    // Regex using named capture groups. Includes bold, italic, strike, code, slack links, markdown links.
    // Using non-capturing groups (?:...) where appropriate.
    // Lookarounds (?<!\w) and (?!\w) help avoid matching within words for _italic_ and ~strike~.
    const ALL_FORMATS_RE = new RegExp(
        // Bold: **content** -> captures 'content' (non-greedy)
        `\\*\\*(?<bold_content>.*?)\\*\\*` +
        // Italic: _content_ -> captures 'content' (non-greedy, with word boundary checks)
        `|(?<![\\w*_])_(?<italic_content>.+?)_(?![\\w*_])` + // Avoid matching inside **_bold-italic_** issues, allow leading/trailing * or _
         // Strikethrough: ~content~ -> captures 'content' (non-greedy, with word boundary checks)
        `|(?<![\\w~])~(?<strike_content>.+?)~(?![\\w~])` + // Avoid matching inside words
        // Code: `content` -> captures 'content' (non-greedy)
        `|\`(?<code_content>.*?)\`` +
        // Slack Link: <url|text> or <url> -> captures 'url' and optional 'text'
        `|<(?<slack_link_url>https?:\/\/[^|>\\s]+)(?:\\|(?<slack_link_text>[^>]+))?>` + // Ensure URL part has no spaces or >
        // Markdown Link: [text](url) -> captures 'text' (non-greedy) and 'url' (non-greedy)
        `|\\[(?<md_link_text>[^\\][]*?)\\]\\((?<md_link_url>[^)\\s]+?)\\)`, // Ensure URL part has no ) or spaces
        'g' // Global flag to find all matches
    );


    let match;
    while ((match = ALL_FORMATS_RE.exec(text)) !== null) {
        // 1. Add any plain text found *before* the current match
        if (match.index > currentIndex) {
            const plainText = text.substring(currentIndex, match.index);
            // *** Filter: Only add if non-empty ***
            if (plainText.length > 0) {
                 elements.push({ type: "text", text: plainText });
            }
        }

        // 2. Process the matched formatted element using named groups
        const groups = match.groups;
        let matched = false; // Flag to check if any group matched

        if (groups.bold_content !== undefined) {
             // *** Filter: Only add if content is non-empty ***
             if (groups.bold_content.length > 0) {
                elements.push({ type: "text", text: groups.bold_content, style: { bold: true } });
                matched = true;
             }
        } else if (groups.italic_content !== undefined) {
             // *** Filter: Only add if content is non-empty ***
             if (groups.italic_content.length > 0) {
                elements.push({ type: "text", text: groups.italic_content, style: { italic: true } });
                matched = true;
             }
        } else if (groups.strike_content !== undefined) {
             // *** Filter: Only add if content is non-empty ***
             if (groups.strike_content.length > 0) {
                 // Slack uses "strike: true" for strikethrough style
                elements.push({ type: "text", text: groups.strike_content, style: { strike: true } });
                matched = true;
             }
        } else if (groups.code_content !== undefined) {
             // *** Filter: Only add if content is non-empty ***
             if (groups.code_content.length > 0) {
                elements.push({ type: "text", text: groups.code_content, style: { code: true } });
                matched = true;
             }
        } else if (groups.slack_link_url !== undefined) {
            const url = groups.slack_link_url;
            // Use provided text, fallback to URL if text is missing/empty
            const linkText = groups.slack_link_text?.trim() || url;
             // *** Filter: Ensure linkText is non-empty (URL itself should always be non-empty due to regex) ***
             if (linkText.length > 0) {
                 elements.push({ type: "link", url: url, text: linkText });
                 matched = true;
             }
        } else if (groups.md_link_url !== undefined) {
            const url = groups.md_link_url;
            // Use provided text, fallback to URL if text is missing/empty
            const linkText = groups.md_link_text?.trim() || url;
             // *** Filter: Ensure linkText is non-empty (URL itself should always be non-empty due to regex) ***
             if (linkText.length > 0) {
                 elements.push({ type: "link", url: url, text: linkText || url }); // Ensure text field exists
                 matched = true;
             }
        }

        // 3. Update the current index
        // If a known format was matched, advance past it.
        // If regex matched but no group captured (shouldn't happen with this regex structure),
        // or if matched content was empty and filtered out, still advance past the raw match
        // to avoid infinite loops on zero-length matches (though the regex tries to avoid this).
        currentIndex = ALL_FORMATS_RE.lastIndex;

         // Safety check for potential zero-length matches that might cause infinite loops
         // (e.g., if regex somehow matched an empty string)
         if (match[0].length === 0) {
             // console.warn("[Formatting Service] Zero-length match detected in parseInlineFormatting regex. Advancing index by 1.");
             ALL_FORMATS_RE.lastIndex++; // Manually advance index
         }
    }

    // 4. Add any remaining plain text *after* the last match
    if (currentIndex < text.length) {
        const remainingText = text.substring(currentIndex);
         // *** Filter: Only add if non-empty ***
         if (remainingText.length > 0) {
             elements.push({ type: "text", text: remainingText });
         }
    }

    // *** Final Filter (Belt-and-Suspenders): Ensure no empty text elements remain ***
    // Although inline filters are added above, this catches any missed cases.
    const finalFilteredElements = elements.filter(element => {
        return element.type !== "text" || (element.text && element.text.length > 0);
    });

    // Log if filtering occurred at the end (might indicate a logic issue above)
    // if (finalFilteredElements.length < elements.length) {
    //     console.warn("[Formatting Service] parseInlineFormatting final filter removed empty text elements.");
    // }

    return finalFilteredElements;
}



/**
 * Converts markdown text (potentially including code blocks handled by splitting)
 * into a single Slack rich_text block object suitable for the Slack API.
 * Uses `rich_text_preformatted` for pure code blocks detected, `rich_text_section` otherwise.
 * Ensures generated blocks comply with Slack's requirement for non-empty text elements.
 *
 * @param {string} markdown - The markdown text for the block (should be a single chunk from splitMessageIntoChunks or a short message).
 * @param {string} [blockId] - Optional block_id for the rich_text block.
 * @returns {object | null} A Slack rich_text block object or null if input is empty/invalid or results in an empty block.
 */
export function markdownToRichTextBlock(markdown, blockId = `block_${Date.now()}_${Math.random().toString(16).slice(2)}`) {
    // Enhanced Input Validation
    if (!markdown || typeof markdown !== 'string' || markdown.trim().length === 0) {
        console.warn(`[Formatting Service] markdownToRichTextBlock called with empty or invalid input. Type: ${typeof markdown}. Input(start): "${String(markdown).substring(0, 50)}..."`);
        return null; // Cannot create a block from empty content
    }

    const trimmedMarkdown = markdown.trim();

    // Detect if the *entire* trimmed input is just a single code block
    // More permissive regex that matches code blocks anywhere
    const codeBlockMatch = trimmedMarkdown.match(/^```([\w-]*)?\s*([\s\S]*?)\s*```$/);

    if (codeBlockMatch) {
        // Pure Code Block: Use rich_text_preformatted
        const language = codeBlockMatch[1] || '';
        const codeContent = codeBlockMatch[2] || ''; // Extract content
        
        // If there's a language identifier, add it as a comment at the beginning
        const displayContent = language 
            ? `// Language: ${language}\n${codeContent}` 
            : codeContent;

        return {
            type: "rich_text",
            block_id: blockId,
            elements: [{
                type: "rich_text_preformatted",
                elements: [{ type: "text", text: displayContent }]
            }]
        };
    } else {
        // Check for embedded code blocks using extractTextAndCode
        const segments = extractTextAndCode(trimmedMarkdown);
        
        // If we have multiple segments with at least one code block, handle them specially
        if (segments.length > 0 && segments.some(seg => seg.type === 'code')) {
            const richTextElements = [];
            
            for (const segment of segments) {
                if (segment.type === 'text') {
                    // Process text segments with inline formatting
                    const textElements = parseInlineFormatting(segment.content);
                    if (textElements.length > 0) {
                        richTextElements.push({
                            type: "rich_text_section",
                            elements: textElements
                        });
                    }
                } else if (segment.type === 'code') {
                    // Process code segments
                    const language = segment.language || '';
                    const codeContent = segment.content || '';
                    
                    // If there's a language identifier, add it as a comment
                    const displayContent = language 
                        ? `// Language: ${language}\n${codeContent}` 
                        : codeContent;
                    
                    richTextElements.push({
                        type: "rich_text_preformatted",
                        elements: [{ type: "text", text: displayContent }]
                    });
                }
            }
            
            if (richTextElements.length > 0) {
                return {
                    type: "rich_text",
                    block_id: blockId,
                    elements: richTextElements
                };
            }
        }
        
        // Default case: Regular Text or no special segments detected
        let sectionElements = parseInlineFormatting(markdown);

        // Safeguard Filter
        sectionElements = sectionElements.filter(element => {
            return element.type !== "text" || (element.text && element.text.length > 0);
        });

        if (sectionElements.length === 0) {
            console.warn(`[Formatting Service] No valid rich text elements generated or remained after filtering for markdownToRichTextBlock section. Input: "${markdown.substring(0,100)}..."`);
            return null;
        }

        return {
            type: "rich_text",
            block_id: blockId,
            elements: [{
                type: "rich_text_section",
                elements: sectionElements
            }]
        };
    }
}


console.log("[Formatting Service] Initialized with improved formatting logic.");
