import {
  extractCard,
  extractFiles,
  ValidationError,
} from "@chat-adapter/shared";
import {
  buildKapsoFields,
  type ContactRecord,
  type ConversationRecord,
  GraphApiError,
  type SendMessageResponse,
  type UnifiedMessage,
  WhatsAppClient,
} from "@kapso/whatsapp-cloud-api";
import {
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  ConsoleLogger,
  convertEmojiPlaceholders,
  defaultEmojiResolver,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  getEmoji,
  type Logger,
  Message,
  NotImplementedError,
  type RawMessage,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import {
  buildAttachments,
  extractReactionEvent,
  extractMessageText,
  parseUnixTimestamp,
  resolveSenderId,
} from "./message-parser.js";
import { KapsoFormatConverter } from "./format-converter.js";
import {
  decodeKapsoThreadId,
  encodeKapsoThreadId,
  normalizeUserWaId,
} from "./thread-utils.js";
import {
  buildWebhookRawMessage,
  extractWebhookEventName,
  extractWebhookEvents,
  KAPSO_MESSAGE_RECEIVED_EVENT,
  verifyWebhookSignature,
} from "./webhook-handler.js";
import type {
  KapsoAdapterConfig,
  KapsoRawMessage,
  KapsoThreadId,
} from "./types.js";

/** Maximum message length for WhatsApp Cloud API */
const KAPSO_MESSAGE_LIMIT = 4096;
const MAX_PROCESSED_WEBHOOK_KEYS = 1024;
const DEFAULT_FETCH_LIMIT = 50;
const KAPSO_HISTORY_FETCH_LIMIT_MAX = 100;
const KAPSO_CONVERSATION_FIELDS = buildKapsoFields([
  "contact_name",
  "messages_count",
  "last_message_id",
  "last_message_type",
  "last_message_timestamp",
  "last_message_text",
  "last_inbound_at",
  "last_outbound_at",
]);
const KAPSO_HISTORY_FIELDS = buildKapsoFields();

type KapsoThreadContext = {
  contact?: ContactRecord | null;
  conversation?: ConversationRecord | null;
  phoneNumberId: string;
  userWaId: string;
};

/**
 * Split text into chunks that fit within WhatsApp's message limit,
 * breaking on paragraph boundaries (\n\n) when possible, then line
 * boundaries (\n), and finally at the character limit as a last resort.
 */
function splitMessage(text: string): string[] {
  if (text.length <= KAPSO_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > KAPSO_MESSAGE_LIMIT) {
    const slice = remaining.slice(0, KAPSO_MESSAGE_LIMIT);

    // Try to break at a paragraph boundary
    let breakIndex = slice.lastIndexOf("\n\n");
    let breakLength = 2;
    if (breakIndex === -1 || breakIndex < KAPSO_MESSAGE_LIMIT / 2) {
      // Try a line boundary
      breakIndex = slice.lastIndexOf("\n");
      breakLength = 1;
    }
    if (breakIndex === -1 || breakIndex < KAPSO_MESSAGE_LIMIT / 2) {
      // Hard break at the limit
      breakIndex = KAPSO_MESSAGE_LIMIT;
      breakLength = 0;
    }

    const chunkEnd = breakIndex + breakLength;
    chunks.push(remaining.slice(0, chunkEnd));
    remaining = remaining.slice(chunkEnd);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function compareConversationActivity(
  left: ConversationRecord,
  right: ConversationRecord,
): number {
  const leftIsActive = left.status === "active" ? 1 : 0;
  const rightIsActive = right.status === "active" ? 1 : 0;
  if (leftIsActive !== rightIsActive) {
    return rightIsActive - leftIsActive;
  }

  const leftLastActiveAt = Date.parse(left.lastActiveAt ?? "") || 0;
  const rightLastActiveAt = Date.parse(right.lastActiveAt ?? "") || 0;
  if (leftLastActiveAt !== rightLastActiveAt) {
    return rightLastActiveAt - leftLastActiveAt;
  }

  return right.id.localeCompare(left.id);
}

function compareHistoryMessages(
  left: UnifiedMessage,
  right: UnifiedMessage,
): number {
  const leftTimestamp = parseUnixTimestamp(left.timestamp).getTime();
  const rightTimestamp = parseUnixTimestamp(right.timestamp).getTime();
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  return left.id.localeCompare(right.id);
}

function getCursor(
  paging: { cursors?: { after?: string | null; before?: string | null } },
  key: "after" | "before",
): string | undefined {
  const value = paging.cursors?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof GraphApiError && error.httpStatus === 404;
}

function normalizeConversationPhoneNumber(
  conversation: ConversationRecord,
): string | undefined {
  return normalizeUserWaId(conversation.phoneNumber);
}

function resolveMessageContactName(message: UnifiedMessage): string | undefined {
  const contactName = message.kapso?.contactName;
  return typeof contactName === "string" && contactName.length > 0
    ? contactName
    : undefined;
}

function resolveConversationContactName(
  conversation: ConversationRecord | null | undefined,
): string | undefined {
  const contactName = conversation?.kapso?.contactName;
  return typeof contactName === "string" && contactName.length > 0
    ? contactName
    : undefined;
}

function resolveContactRecordName(
  contact: ContactRecord | null | undefined,
): string | undefined {
  const displayName = contact?.displayName;
  if (typeof displayName === "string" && displayName.length > 0) {
    return displayName;
  }

  const profileName = contact?.profileName;
  return typeof profileName === "string" && profileName.length > 0
    ? profileName
    : undefined;
}

function resolveThreadDisplayName(
  userWaId: string,
  context: {
    contact?: ContactRecord | null;
    conversation?: ConversationRecord | null;
  },
): string {
  const displayName =
    resolveConversationContactName(context.conversation) ??
    resolveContactRecordName(context.contact);

  return typeof displayName === "string" && displayName.length > 0
    ? displayName
    : userWaId;
}

/**
 * Kapso adapter for Chat SDK.
 *
 * Supports outbound text messages, reactions, inbound Kapso webhook
 * handling, and Kapso-backed message history/thread enrichment for
 * WhatsApp conversations.
 */
export class KapsoAdapter implements Adapter<KapsoThreadId, KapsoRawMessage> {
  readonly name = "kapso";
  readonly persistMessageHistory = true;
  readonly userName: string;

  private readonly baseUrl: string;
  private readonly kapsoApiKey: string;
  private readonly phoneNumberId: string;
  private readonly webhookSecret: string;
  private readonly client: WhatsAppClient;
  private readonly formatConverter = new KapsoFormatConverter();
  private chat: ChatInstance | null = null;
  private logger: Logger;
  private _botUserId: string | null = null;
  private readonly processedWebhookKeys = new Map<string, number>();

  /** Bot user ID used for self-message detection. */
  get botUserId(): string | undefined {
    return this._botUserId ?? undefined;
  }

  constructor(config: Required<KapsoAdapterConfig>) {
    this.baseUrl = config.baseUrl;
    this.kapsoApiKey = config.kapsoApiKey;
    this.phoneNumberId = config.phoneNumberId;
    this.userName = config.userName;
    this.webhookSecret = config.webhookSecret;
    this.client = new WhatsAppClient({
      baseUrl: this.baseUrl,
      kapsoApiKey: this.kapsoApiKey,
    });
    this.logger = new ConsoleLogger("info").child("kapso");
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger("kapso");
    this._botUserId = this.phoneNumberId;

    this.logger.info("Kapso adapter initialized", {
      baseUrl: this.baseUrl,
      phoneNumberId: this.phoneNumberId,
    });
  }

  encodeThreadId(platformData: KapsoThreadId): string {
    return encodeKapsoThreadId(platformData);
  }

  decodeThreadId(threadId: string): KapsoThreadId {
    return decodeKapsoThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(_threadId: string): boolean {
    return true;
  }

  async openDM(userId: string): Promise<string> {
    return this.encodeThreadId({
      phoneNumberId: this.phoneNumberId,
      userWaId: userId,
    });
  }

  renderFormatted(content: FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  /**
   * Handle incoming Kapso webhook events.
   *
   * Supports POST requests for Kapso webhook mode and processes
   * `whatsapp.message.received` events into Chat SDK messages.
   */
  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "POST",
        },
      });
    }

    const body = await request.text();
    const signature = request.headers.get("x-webhook-signature");
    if (!verifyWebhookSignature(body, signature, this.webhookSecret)) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      this.logger.error("Kapso webhook invalid JSON", {
        contentType: request.headers.get("content-type"),
        bodyPreview: body.slice(0, 200),
      });
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!this.chat) {
      this.logger.warn("Chat instance not initialized, ignoring webhook");
      return new Response("OK", { status: 200 });
    }

    const eventName =
      request.headers.get("x-webhook-event") ?? extractWebhookEventName(payload);

    if (eventName && eventName !== KAPSO_MESSAGE_RECEIVED_EVENT) {
      this.logger.debug("Ignoring unsupported Kapso webhook event", {
        event: eventName,
      });
      return new Response("OK", { status: 200 });
    }

    const idempotencyKey = request.headers.get("x-idempotency-key");
    if (idempotencyKey && this.processedWebhookKeys.has(idempotencyKey)) {
      this.logger.debug("Ignoring duplicate Kapso webhook delivery", {
        idempotencyKey,
      });
      return new Response("OK", { status: 200 });
    }

    const events = extractWebhookEvents(
      payload,
      request.headers.get("x-webhook-batch"),
    );

    for (const event of events) {
      const raw = buildWebhookRawMessage(event, {
        logger: this.logger,
        phoneNumberId: this.phoneNumberId,
      });
      if (!raw) {
        continue;
      }

      const threadId = this.encodeThreadId({
        phoneNumberId: raw.phoneNumberId,
        userWaId: raw.userWaId,
      });

      const reaction = extractReactionEvent(raw.message);
      if (reaction) {
        this.chat.processReaction(
          {
            adapter: this,
            emoji: getEmoji(reaction.rawEmoji),
            rawEmoji: reaction.rawEmoji,
            added: reaction.added,
            user: this.buildAuthor(raw),
            messageId: reaction.messageId,
            threadId,
            raw,
          },
          options,
        );
        continue;
      }

      if (raw.message.type === "reaction") {
        this.logger.warn("Skipping Kapso reaction webhook missing target message", {
          inboundMessageId: raw.message.id,
          threadId,
        });
        continue;
      }

      this.chat.processMessage(
        this,
        threadId,
        async () => this.parseMessage(raw),
        options,
      );
    }

    if (idempotencyKey && events.length > 0) {
      this.rememberProcessedWebhookKey(idempotencyKey);
    }

    return new Response("OK", { status: 200 });
  }

  /**
   * Parse a Kapso raw message into a Chat SDK message.
   */
  parseMessage(raw: KapsoRawMessage): Message<KapsoRawMessage> {
    const threadId = this.encodeThreadId({
      phoneNumberId: raw.phoneNumberId,
      userWaId: raw.userWaId,
    });
    const text = extractMessageText(raw.message);

    return new Message<KapsoRawMessage>({
      id: raw.message.id,
      threadId,
      text,
      formatted: this.formatConverter.toAst(text),
      raw,
      author: this.buildAuthor(raw),
      metadata: {
        dateSent: parseUnixTimestamp(raw.message.timestamp),
        edited: false,
      },
      attachments: buildAttachments(raw.message),
    });
  }

  /**
   * Send a plain-text message. Throws if the message contains cards, attachments,
   * or files. Automatically splits messages over 4096 characters at paragraph or
   * line boundaries.
   */
  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<KapsoRawMessage>> {
    const { userWaId } = this.decodeThreadId(threadId);
    this.assertOutboundTextOnly(message);

    const body = convertEmojiPlaceholders(
      this.formatConverter.renderPostable(message),
      "whatsapp",
    );

    if (body.trim().length === 0) {
      throw new ValidationError(
        "kapso",
        "Kapso adapter requires a non-empty text message.",
      );
    }

    const chunks = splitMessage(body);
    let result: RawMessage<KapsoRawMessage> | null = null;

    for (const chunk of chunks) {
      const response = await this.client.messages.sendText({
        phoneNumberId: this.phoneNumberId,
        to: userWaId,
        body: chunk,
      });

      result = this.buildRawTextMessage(threadId, userWaId, chunk, response);
    }

    if (!result) {
      throw new ValidationError(
        "kapso",
        "Kapso adapter requires a non-empty text message.",
      );
    }

    return result;
  }

  /** Not supported. Always throws — WhatsApp does not support editing sent messages. */
  async editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<KapsoRawMessage>> {
    throw new Error(
      "Kapso/WhatsApp does not support editing messages. Use postMessage() instead.",
    );
  }

  /** Not supported. Always throws — WhatsApp does not support deleting sent messages. */
  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new Error("Kapso/WhatsApp does not support deleting messages.");
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    const { userWaId } = this.decodeThreadId(threadId);

    await this.client.messages.sendReaction({
      phoneNumberId: this.phoneNumberId,
      to: userWaId,
      reaction: {
        messageId,
        emoji: defaultEmojiResolver.toGChat(emoji),
      },
    });
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    const { userWaId } = this.decodeThreadId(threadId);

    await this.client.messages.sendReaction({
      phoneNumberId: this.phoneNumberId,
      to: userWaId,
      reaction: {
        messageId,
        emoji: "",
      },
    });
  }

  /** Not implemented. Always throws `NotImplementedError`. */
  async startTyping(_threadId: string, _status?: string): Promise<void> {
    this.notImplemented("startTyping");
  }

  /**
   * Fetch stored message history for a Kapso-backed WhatsApp thread.
   */
  async fetchMessages(
    threadId: string,
    options: FetchOptions = {},
  ): Promise<FetchResult<KapsoRawMessage>> {
    const { phoneNumberId, userWaId } = this.decodeThreadId(threadId);
    const conversation = await this.findBestConversationForThread(
      phoneNumberId,
      userWaId,
    );

    if (!conversation) {
      return { messages: [] };
    }

    const direction = options.direction ?? "backward";
    const limit = Math.min(
      options.limit ?? DEFAULT_FETCH_LIMIT,
      KAPSO_HISTORY_FETCH_LIMIT_MAX,
    );
    const page = await this.fetchConversationHistoryPage(
      conversation.id,
      phoneNumberId,
      direction,
      limit,
      options.cursor,
    );
    const contact = await this.fetchContactForThread(
      phoneNumberId,
      userWaId,
      "fetchMessages",
    );
    const context: KapsoThreadContext = {
      phoneNumberId,
      userWaId,
      conversation,
      contact,
    };
    const messages = [...page.data]
      .sort(compareHistoryMessages)
      .map((message) => this.toKapsoRawMessage(message, context))
      .map((raw) => this.parseMessage(raw));

    return {
      messages,
      nextCursor:
        direction === "backward"
          ? getCursor(page.paging, "after")
          : getCursor(page.paging, "before"),
    };
  }

  /**
   * Fetch thread metadata for a Kapso-backed WhatsApp conversation.
   */
  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { phoneNumberId, userWaId } = this.decodeThreadId(threadId);
    const conversation = await this.findBestConversationForThread(
      phoneNumberId,
      userWaId,
    );
    const contact = await this.fetchContactForThread(
      phoneNumberId,
      userWaId,
      "fetchThread",
    );
    const displayName = resolveThreadDisplayName(userWaId, {
      contact,
      conversation,
    });

    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      channelName: `WhatsApp: ${displayName}`,
      isDM: true,
      metadata: {
        phoneNumberId,
        userWaId,
        ...(displayName !== userWaId ? { contactName: displayName } : {}),
        ...(contact
          ? {
              contactId: contact.id,
              contact,
            }
          : {}),
        ...(conversation
          ? {
              conversationId: conversation.id,
              conversation,
            }
          : {}),
      },
    };
  }

  private assertOutboundTextOnly(message: AdapterPostableMessage): void {
    const hasAttachments =
      typeof message === "object" &&
      message !== null &&
      "attachments" in message &&
      Array.isArray(message.attachments) &&
      message.attachments.length > 0;
    const hasFiles = extractFiles(message).length > 0;

    if (extractCard(message) || hasAttachments || hasFiles) {
      throw new ValidationError(
        "kapso",
        "Kapso adapter only supports text messages. Cards, attachments, and files are not supported.",
      );
    }
  }

  private buildRawTextMessage(
    threadId: string,
    to: string,
    body: string,
    response: SendMessageResponse,
  ): RawMessage<KapsoRawMessage> {
    const id = this.getResponseMessageId(response, "text message");

    return {
      id,
      threadId,
      raw: {
        phoneNumberId: this.phoneNumberId,
        userWaId: to,
        message: {
          id,
          type: "text",
          timestamp: String(Math.floor(Date.now() / 1000)),
          from: this.phoneNumberId,
          to,
          text: {
            body,
          },
        },
      },
    };
  }

  private buildAuthor(raw: KapsoRawMessage) {
    const senderId = resolveSenderId(raw);
    const isMe = senderId === this._botUserId;
    const displayName = raw.contactName ?? (isMe ? this.userName : raw.userWaId);

    return {
      userId: senderId,
      userName: displayName,
      fullName: displayName,
      isBot: false,
      isMe,
    };
  }

  private getResponseMessageId(
    response: SendMessageResponse,
    operation: string,
  ): string {
    const messageId = response.messages[0]?.id;

    if (!messageId) {
      throw new ValidationError(
        "kapso",
        `Kapso SDK did not return a message ID for ${operation}.`,
      );
    }

    return messageId;
  }

  private rememberProcessedWebhookKey(idempotencyKey: string): void {
    this.processedWebhookKeys.set(idempotencyKey, Date.now());

    while (this.processedWebhookKeys.size > MAX_PROCESSED_WEBHOOK_KEYS) {
      const oldestKey = this.processedWebhookKeys.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.processedWebhookKeys.delete(oldestKey);
    }
  }

  private notImplemented(method: string): never {
    throw new NotImplementedError(
      `Kapso adapter ${method} is not implemented.`,
      method,
    );
  }

  private async fetchConversationHistoryPage(
    conversationId: string,
    phoneNumberId: string,
    direction: "forward" | "backward",
    limit: number,
    cursor?: string,
  ) {
    if (direction === "backward") {
      return this.client.messages.listByConversation({
        phoneNumberId,
        conversationId,
        limit,
        after: cursor,
        fields: KAPSO_HISTORY_FIELDS,
      });
    }

    if (cursor) {
      return this.client.messages.listByConversation({
        phoneNumberId,
        conversationId,
        limit,
        before: cursor,
        fields: KAPSO_HISTORY_FIELDS,
      });
    }

    // Kapso history pages newest-first. Walk to the oldest page so Chat's
    // forward mode can start from the beginning while still using opaque
    // Kapso cursors for subsequent pages.
    let page = await this.client.messages.listByConversation({
      phoneNumberId,
      conversationId,
      limit,
      fields: KAPSO_HISTORY_FIELDS,
    });
    let nextOlderCursor = getCursor(page.paging, "after");

    while (nextOlderCursor) {
      const olderPage = await this.client.messages.listByConversation({
        phoneNumberId,
        conversationId,
        limit,
        after: nextOlderCursor,
        fields: KAPSO_HISTORY_FIELDS,
      });

      page = olderPage;
      nextOlderCursor = getCursor(page.paging, "after");
    }

    return page;
  }

  private async findBestConversationForThread(
    phoneNumberId: string,
    userWaId: string,
  ): Promise<ConversationRecord | null> {
    const normalizedUserWaId = normalizeUserWaId(userWaId);
    if (!normalizedUserWaId) {
      return null;
    }

    const phoneCandidates = [
      userWaId.startsWith("+") ? userWaId : `+${normalizedUserWaId}`,
      normalizedUserWaId,
    ].filter((value, index, values) => values.indexOf(value) === index);

    const matches: ConversationRecord[] = [];

    for (const phoneNumber of phoneCandidates) {
      let after: string | undefined;

      do {
        const page = await this.client.conversations.list({
          phoneNumberId,
          phoneNumber,
          limit: 100,
          after,
          fields: KAPSO_CONVERSATION_FIELDS,
        });

        for (const conversation of page.data) {
          if (
            normalizeConversationPhoneNumber(conversation) === normalizedUserWaId
          ) {
            matches.push(conversation);
          }
        }

        after = getCursor(page.paging, "after");
      } while (after);

      if (matches.length > 0) {
        break;
      }
    }

    if (matches.length === 0) {
      return null;
    }

    matches.sort(compareConversationActivity);
    return matches[0] ?? null;
  }

  private async fetchContactForThread(
    phoneNumberId: string,
    userWaId: string,
    operation: "fetchMessages" | "fetchThread",
  ): Promise<ContactRecord | null> {
    const normalizedUserWaId = normalizeUserWaId(userWaId);
    if (!normalizedUserWaId) {
      return null;
    }

    try {
      return await this.client.contacts.get({
        phoneNumberId,
        waId: normalizedUserWaId,
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }

      this.logger.warn(
        "Kapso contact enrichment failed; continuing without contact",
        {
          operation,
          phoneNumberId,
          userWaId: normalizedUserWaId,
          error,
        },
      );
      return null;
    }
  }

  private toKapsoRawMessage(
    message: UnifiedMessage,
    context: KapsoThreadContext,
  ): KapsoRawMessage {
    return {
      phoneNumberId: context.phoneNumberId,
      userWaId: context.userWaId,
      contactName:
        resolveMessageContactName(message) ??
        resolveConversationContactName(context.conversation) ??
        resolveContactRecordName(context.contact),
      message: message as KapsoRawMessage["message"],
    };
  }
}
