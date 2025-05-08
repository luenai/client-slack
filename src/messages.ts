import {
    stringToUuid,
    getEmbeddingZeroVector,
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    ModelClass,
    type Memory,
    type Content,
    type State,
    elizaLogger,
    type HandlerCallback,
} from "@elizaos/core";
import {
    slackMessageHandlerTemplate,
    slackShouldRespondTemplate,
} from "./templates";
import type { WebClient } from "@slack/web-api";
import type { IAgentRuntime } from "@elizaos/core";
import path from "path";
import fs from "fs";
import os from "os";
import {createReadStream} from "fs";

export class MessageManager {
    private client: WebClient;
    private runtime: IAgentRuntime;
    private botUserId: string;
    private processedEvents: Set<string> = new Set();
    private messageProcessingLock: Set<string> = new Set();
    private processedMessages: Map<string, number> = new Map();

    constructor(client: WebClient, runtime: IAgentRuntime, botUserId: string) {
        console.log("📱 Initializing MessageManager...");
        this.client = client;
        this.runtime = runtime;
        this.botUserId = botUserId;
        console.log("MessageManager initialized with botUserId:", botUserId);

        // Clear old processed messages and events every hour
        setInterval(() => {
            const oneHourAgo = Date.now() - 3600000;

            // Clear old processed messages
            for (const [key, timestamp] of Array.from(this.processedMessages.entries())) {
                if (timestamp < oneHourAgo) {
                    this.processedMessages.delete(key);
                }
            }

            // Clear old processed events
            this.processedEvents.clear();
        }, 3600000);
    }

    private generateEventKey(event: any): string {
        // Create a unique key that includes all relevant event data
        // Normalize event type to handle message and app_mention as the same type
        const eventType = event.type === "app_mention" ? "message" : event.type;

        const components = [
            event.ts, // Timestamp
            event.channel, // Channel ID
            eventType, // Normalized event type
            event.user, // User ID
            event.thread_ts, // Thread timestamp (if any)
        ].filter(Boolean); // Remove any undefined/null values

        const key = components.join("-");
        console.log("\n=== EVENT DETAILS ===");
        console.log("Event Type:", event.type);
        console.log("Event TS:", event.ts);
        console.log("Channel:", event.channel);
        console.log("User:", event.user);
        console.log("Thread TS:", event.thread_ts);
        console.log("Generated Key:", key);
        return key;
    }

    private cleanMessage(text: string): string {
        elizaLogger.debug("🧹 [CLEAN] Cleaning message text:", text);
        // Remove bot mention
        const cleaned = text
            .replace(new RegExp(`<@${this.botUserId}>`, "g"), "")
            .trim();
        elizaLogger.debug("✨ [CLEAN] Cleaned result:", cleaned);
        return cleaned;
    }

    private async _shouldRespond(message: any, state: State): Promise<boolean> {
        console.log("\n=== SHOULD_RESPOND PHASE ===");
        console.log("🔍 Step 1: Evaluating if should respond to message");

        // Always respond to direct mentions
        if (
            message.type === "app_mention" ||
            message.text?.includes(`<@${this.botUserId}>`)
        ) {
            console.log("✅ Direct mention detected - will respond");
            return true;
        }

        // Always respond in direct messages
        if (message.channel_type === "im") {
            console.log("✅ Direct message detected - will respond");
            return true;
        }

        // Check if we're in a thread and we've participated
        if (
            message.thread_ts &&
            state.recentMessages?.includes(this.runtime.agentId)
        ) {
            console.log("✅ Active thread participant - will respond");
            return true;
        }

        // Only use LLM for ambiguous cases
        console.log("🤔 Step 2: Using LLM to decide response");
        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates?.slackShouldRespondTemplate ||
                this.runtime.character.templates?.shouldRespondTemplate ||
                slackShouldRespondTemplate,
        });

        console.log("🔄 Step 3: Calling generateShouldRespond");
        const response = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });

        console.log(`✅ Step 4: LLM decision received: ${response}`);
        return response === "RESPOND";
    }

    private async _generateResponse(
        memory: Memory,
        state: State,
        context: string
    ): Promise<Content> {
        console.log("\n=== GENERATE_RESPONSE PHASE ===");
        console.log("🔍 Step 1: Starting response generation");

        // Generate response only once
        console.log("🔄 Step 2: Calling LLM for response");
        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });
        console.log("✅ Step 3: LLM response received");

        if (!response) {
            console.error("❌ No response from generateMessageResponse");
            return {
                text: "I apologize, but I'm having trouble generating a response right now.",
                source: "slack",
            };
        }

        // If response includes a CONTINUE action but there's no direct mention or thread,
        // remove the action to prevent automatic continuation
        if (
            response.action === "CONTINUE" &&
            !memory.content.text?.includes(`<@${this.botUserId}>`) &&
            !state.recentMessages?.includes(memory.id)
        ) {
            console.log(
                "⚠️ Step 4: Removing CONTINUE action - not a direct interaction"
            );
            delete response.action;
        }

        console.log("✅ Step 5: Returning generated response");
        return response;
    }

    private async _downloadAttachments(event: any):Promise<any> {
        if (event.files==null || event.files.length==0) {
            return event;
        }

        elizaLogger.log("📥 Downloading attachments");

        const downloadedAttachments = [];
        for (const file of event.files) {
            if (!file.url_private) {
                elizaLogger.warn(`No url_private found for file ${file.id}`);
                continue;
            }
            try {
                const response = await fetch(file.url_private, {
                    headers: {
                        Authorization: `Bearer ${this.client.token}`
                    }
                });
                if (!response.ok) {
                    elizaLogger.error(`Failed to download file ${file.id}: ${response.statusText}`);
                    continue;
                }
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                // Create a file path in the temporary directory
                const tempDir = os.tmpdir();
                const sanitizedFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
                const filePath = path.join(
                    tempDir,
                    `slack_attachment_${file.id}_${Date.now()}_${sanitizedFileName}`
                );

                fs.writeFileSync(filePath, buffer);

                downloadedAttachments.push({
                    id: file.id,
                    title: file.name,
                    url: filePath,
                    source: "slack",
                    description: "Attachment to the Slack message",
                    text: ""
                });
            } catch (error) {
                elizaLogger.error(`Error downloading file ${file.id}:`, error);
            }
        }
        // Optionally, attach the downloaded attachments to the event for further processing
        event.downloadedAttachments = downloadedAttachments;
        elizaLogger.log("✅ Attachments downloaded:", downloadedAttachments);
        return event;
    }

    private async _uploadAttachments(event: any, attachments: string[]) {
        if (attachments==null || attachments.length==0) {
            return;
        }

        for (const attachmentId of attachments) {
            try {
                // Retrieve file data from the runtime's cache manager.
                const fileData = await this.runtime.cacheManager.get(attachmentId) as string;
                if (!fileData) {
                    elizaLogger.warn(`No file data found for attachment id: ${attachmentId}`);
                    continue;
                }
    
                elizaLogger.debug(`Retrieved fileData for attachmentId: ${attachmentId}. Type: ${typeof fileData}. Preview: ${(fileData || '').substring(0,70)}...`);
                let uploadParams: any;

                const dataUriRegex = /^data:(.+?);base64,(.+)$/i; // More general data URI regex

                const base64Match = fileData.match(dataUriRegex);

                if (base64Match) {
                    // Case 1: fileData is a Data URI (could be image or other type)
                    elizaLogger.log(`Detected base64 data URI for attachmentId: ${attachmentId}. Uploading as buffer...`);
                    const mimeType = base64Match[1]; // e.g., image/jpeg, application/pdf
                    const base64Data = base64Match[2];
                    const fileBuffer = Buffer.from(base64Data, 'base64');
                    
                    let extension = 'bin'; // Default extension
                    const mimeParts = mimeType.split('/');
                    if (mimeParts.length > 1) {
                        extension = mimeParts[1];
                        if (extension.includes('+')) { // Handle cases like 'svg+xml' -> 'svg'
                            extension = extension.split('+')[0];
                        }
                    }
                    // Common known extensions for certain mimetypes Slack might not guess well from buffer alone
                    if (mimeType === 'image/jpeg') extension = 'jpg';
                    if (mimeType === 'image/png') extension = 'png';
                    if (mimeType === 'application/pdf') extension = 'pdf';

                    uploadParams = {
                        channels: event.channel,
                        thread_ts: event.thread_ts,
                        filename: `attachment_${attachmentId}.${extension}`,
                        filetype: mimeType, // Provide explicit mimetype
                        file: fileBuffer,
                        initial_comment: "", 
                    };

                } else if (fs.existsSync(fileData)) { 
                    // Case 2: fileData is an existing file path
                    elizaLogger.log(`Detected valid file path for attachmentId: ${attachmentId}. Path: ${fileData}. Uploading file content...`);
                    
                    const filename = path.basename(fileData) || `attachment_${attachmentId}${path.extname(fileData) || '.dat'}`;

                    uploadParams = {
                        channels: event.channel,
                        thread_ts: event.thread_ts,
                        filename: filename,
                        file: createReadStream(fileData), 
                        initial_comment: "",
                        // Slack will attempt to determine filetype from content/filename.
                        // For more control, if the original mimetype of the file path was cached, it could be used here.
                    };
                } else {
                    // Case 3: fileData is likely direct text content (not a data URI, not a valid path)
                    elizaLogger.log(`Assuming fileData for attachmentId: ${attachmentId} is direct text content. Uploading as text file...`);
                    uploadParams = {
                        channels: event.channel,
                        thread_ts: event.thread_ts,
                        filename: `text_content_${attachmentId}.txt`,
                        filetype: "text/plain",
                        content: fileData, 
                        initial_comment: "",
                    };
                }
    
                elizaLogger.debug("Attempting file upload with params for attachmentId:", attachmentId, "Filename:", uploadParams.filename, "Filetype:", uploadParams.filetype || 'auto');
                const uploadResult = await this.client.filesUploadV2(uploadParams);
                const fileId = (uploadResult.file as any)?.id || 'Unknown ID';
                elizaLogger.log("File uploaded successfully to Slack:", fileId, "for local attachmentId:", attachmentId);
    
            } catch (error) {
                elizaLogger.error(`Error uploading file to Slack for attachment ${attachmentId}:`, error);
            }
        }
    }

    public async handleMessage(event: any) {
        console.log("\n=== MESSAGE_HANDLING PHASE ===");
        console.log("🔍 Step 1: Received new message event");

        // Skip if no event data
        if (!event || !event.ts || !event.channel) {
            console.log("⚠️ Invalid event data - skipping");
            return;
        }

        // Generate event key for deduplication
        const eventKey = this.generateEventKey(event);

        // Check if we've already processed this event
        if (this.processedEvents.has(eventKey)) {
            console.log("⚠️ Event already processed - skipping");
            console.log("Existing event key:", eventKey);
            console.log("Original event type:", event.type);
            console.log("Duplicate prevention working as expected");
            return;
        }

        // Add to processed events immediately
        console.log("✅ New event - processing:", eventKey);
        console.log("Event type being processed:", event.type);
        this.processedEvents.add(eventKey);

        // Generate message key for processing lock
        const messageKey = eventKey; // Use same key for consistency
        const currentTime = Date.now();

        try {
            // Check if message is currently being processed
            if (this.messageProcessingLock.has(messageKey)) {
                console.log(
                    "⚠️ Message is currently being processed - skipping"
                );
                return;
            }

            // Add to processing lock
            console.log("🔒 Step 2: Adding message to processing lock");
            this.messageProcessingLock.add(messageKey);

            try {
                // Ignore messages from bots (including ourselves)
                if (event.bot_id || event.user === this.botUserId) {
                    console.log("⚠️ Message from bot or self - skipping");
                    return;
                }

                // Clean the message text
                console.log("🧹 Step 3: Cleaning message text");
                const cleanedText = this.cleanMessage(event.text || "");
                if (!cleanedText) {
                    console.log("⚠️ Empty message after cleaning - skipping");
                    return;
                }

                // Generate unique IDs
                console.log("🔑 Step 4: Generating conversation IDs");
                const roomId = stringToUuid(
                    `${event.channel}-${this.runtime.agentId}`
                );
                const userId = stringToUuid(
                    `${event.user}-${this.runtime.agentId}`
                );
                const messageId = stringToUuid(
                    `${event.ts}-${this.runtime.agentId}`
                );

                // Ensure both the sender and agent are properly set up in the room
                await this.runtime.ensureConnection(
                    userId,
                    roomId,
                    event.user,
                    event.user,
                    "slack"
                );

                // Create initial memory
                console.log("💾 Step 5: Creating initial memory");

                // Download attachments if any
                event = await this._downloadAttachments(event);

                const content: Content = {
                    text: cleanedText,
                    source: "slack",
                    inReplyTo: event.thread_ts
                        ? stringToUuid(
                              `${event.thread_ts}-${this.runtime.agentId}`
                          )
                        : undefined,
                    attachments: event.downloadedAttachments
                };

                const memory: Memory = {
                    id: messageId,
                    userId,
                    agentId: this.runtime.agentId,
                    roomId,
                    content,
                    createdAt: new Date(Number.parseFloat(event.ts) * 1000).getTime(),
                    embedding: getEmbeddingZeroVector(),
                };

                // Add memory
                if (content.text) {
                    console.log("💾 Step 6: Saving initial memory");
                    await this.runtime.messageManager.createMemory(memory);
                }

                // Initial state composition
                console.log("🔄 Step 7: Composing initial state");
                let state = await this.runtime.composeState(
                    { content, userId, agentId: this.runtime.agentId, roomId },
                    {
                        slackClient: this.client,
                        slackEvent: event,
                        agentName: this.runtime.character.name,
                        senderName: event.user_name || event.user,
                    }
                );

                // Update state with recent messages
                console.log("🔄 Step 8: Updating state with recent messages");
                state = await this.runtime.updateRecentMessageState(state);

                // Check if we should respond
                console.log("🤔 Step 9: Checking if we should respond");
                const shouldRespond = await this._shouldRespond(event, state);

                if (shouldRespond) {
                    console.log(
                        "✅ Step 10: Should respond - generating response"
                    );
                    const context = composeContext({
                        state,
                        template:
                            this.runtime.character.templates
                                ?.slackMessageHandlerTemplate ||
                            slackMessageHandlerTemplate,
                    });

                    const responseContent = await this._generateResponse(
                        memory,
                        state,
                        context
                    );

                    if (responseContent?.text) {
                        console.log("📤 Step 11: Preparing to send response");

                        const callback: HandlerCallback = async (
                            content: Content,
                            attachments: any[]
                        ) => {
                            try {
                                elizaLogger.log(
                                    " Step 12: Executing response callback"
                                );

                                let messageText = content.text || "";
                                const attachmentIdsForUpload = attachments; 

                                if (attachmentIdsForUpload && attachmentIdsForUpload.length > 0) {
                                    const dataUriRegexGlobal = /data:image\/(?:png|jpeg|jpg|gif|bmp|tiff|webp);base64,[\w+/=]+/gi;
                                    messageText = messageText.replace(dataUriRegexGlobal, "").trim();
                                    elizaLogger.debug("Cleaned messageText after removing base64 strings:", messageText.substring(0,100) + "...");
                                }
                                
                                elizaLogger.debug("Posting message to Slack:", { channel: event.channel, textLength: messageText.length, thread_ts: event.thread_ts });
                                const result = await this.client.chat.postMessage({
                                    channel: event.channel,
                                    text: messageText, 
                                    thread_ts: event.thread_ts,
                                });

                                if (attachmentIdsForUpload && attachmentIdsForUpload.length > 0) {
                                    elizaLogger.debug("Starting upload of attachments:", attachmentIdsForUpload);
                                    await this._uploadAttachments(event, attachmentIdsForUpload);
                                }

                                elizaLogger.log(
                                    "💾 Step 13: Creating response memory"
                                );
                                const responseMemory: Memory = {
                                    id: stringToUuid(
                                        `${result.ts}-${this.runtime.agentId}`
                                    ),
                                    userId: this.runtime.agentId,
                                    agentId: this.runtime.agentId,
                                    roomId,
                                    content: {
                                        ...content,
                                        text:
                                            content.text ||
                                            responseContent.text,
                                        inReplyTo: messageId,
                                    },
                                    createdAt: Date.now(),
                                    embedding: getEmbeddingZeroVector(),
                                };

                                elizaLogger.log(
                                    "✓ Step 14: Marking message as processed"
                                );
                                this.processedMessages.set(
                                    messageKey,
                                    currentTime
                                );

                                elizaLogger.log(
                                    "💾 Step 15: Saving response memory"
                                );
                                await this.runtime.messageManager.createMemory(
                                    responseMemory
                                );

                                return [responseMemory];
                            } catch (error) {
                                elizaLogger.error("❌ Error in callback:", error);
                                return [];
                            }
                        };

                        console.log("📤 Step 16: Sending initial response");
                        const responseMessages =
                            await callback(responseContent);

                        console.log(
                            "🔄 Step 17: Updating state after response"
                        );
                        state =
                            await this.runtime.updateRecentMessageState(state);

                        if (responseContent.action) {
                            console.log("⚡ Step 18: Processing actions");
                            await this.runtime.processActions(
                                memory,
                                responseMessages,
                                state,
                                callback
                            );
                        }
                    }
                } else {
                    console.log("⏭️ Should not respond - skipping");
                    this.processedMessages.set(messageKey, currentTime);
                }
            } finally {
                console.log(
                    "🔓 Final Step: Removing message from processing lock and deleting downloaded attachments"
                );
                this.messageProcessingLock.delete(messageKey);

                // Delete downloaded attachments
                if (event.downloadedAttachments) {
                    for (const attachment of event.downloadedAttachments) {
                        fs.unlinkSync(attachment.url);
                    }
                }
            }
        } catch (error) {
            console.error("❌ Error in message handling:", error);
            this.messageProcessingLock.delete(messageKey);
        }
    }
}