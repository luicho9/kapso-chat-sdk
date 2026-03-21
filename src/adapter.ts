import { createHmac, timingSafeEqual } from "node:crypto";
import {
  extractCard,
  extractFiles,
  ValidationError,
} from "@chat-adapter/shared";
import {
  type SendMessageResponse,
  WhatsAppClient,
} from "@kapso/whatsapp-cloud-api";
import {
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type ChatInstance,
  ConsoleLogger,
  convertEmojiPlaceholders,
  defaultEmojiResolver,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type Logger,
  Message,
  NotImplementedError,
  type RawMessage,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import { KapsoFormatConverter } from "./format-converter.js";
import type {
  KapsoAdapterConfig,
  KapsoMessage,
  KapsoRawMessage,
  KapsoThreadId,
  KapsoWebhookConversation,
  KapsoWebhookMessageReceivedEvent,
} from "./types.js";

/** Maximum message length for WhatsApp Cloud API */
const KAPSO_MESSAGE_LIMIT = 4096;
const KAPSO_MESSAGE_RECEIVED_EVENT = "whatsapp.message.received";
const MAX_PROCESSED_WEBHOOK_KEYS = 1024;

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function readValue(record: JsonObject | undefined, ...keys: string[]): unknown {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function normalizeUserWaId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\D/g, "");
  return normalized.length > 0 ? normalized : undefined;
}

function parseUnixTimestamp(value: unknown): Date {
  const seconds = readNumber(value);
  return seconds === undefined ? new Date(0) : new Date(seconds * 1000);
}

function isKapsoMessage(value: unknown): value is KapsoMessage {
  return (
    isRecord(value) &&
    readString(readValue(value, "id")) !== undefined &&
    readString(readValue(value, "type")) !== undefined &&
    readString(readValue(value, "timestamp")) !== undefined
  );
}

function isKapsoWebhookMessageReceivedEvent(
  value: unknown,
): value is KapsoWebhookMessageReceivedEvent {
  if (!isRecord(value)) {
    return false;
  }

  return isKapsoMessage(readValue(value, "message"));
}

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

/**
 * Kapso adapter for Chat SDK.
 *
 * Supports outbound text messages, reactions, and inbound Kapso webhook
 * handling for real-time message processing.
 *
 * History/thread APIs are implemented separately.
 */
export class KapsoAdapter implements Adapter<KapsoThreadId, KapsoRawMessage> {
  readonly name = "kapso";
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
    return `kapso:${platformData.phoneNumberId}:${platformData.userWaId}`;
  }

  decodeThreadId(threadId: string): KapsoThreadId {
    if (!threadId.startsWith("kapso:")) {
      throw new ValidationError(
        "kapso",
        `Invalid Kapso thread ID: ${threadId}`,
      );
    }

    const withoutPrefix = threadId.slice("kapso:".length);
    if (!withoutPrefix) {
      throw new ValidationError(
        "kapso",
        `Invalid Kapso thread ID format: ${threadId}`,
      );
    }

    const parts = withoutPrefix.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new ValidationError(
        "kapso",
        `Invalid Kapso thread ID format: ${threadId}`,
      );
    }

    return {
      phoneNumberId: parts[0],
      userWaId: parts[1],
    };
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
    if (!this.verifyWebhookSignature(body, signature)) {
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

    const payloadRecord = isRecord(payload) ? payload : undefined;
    const eventName =
      request.headers.get("x-webhook-event") ??
      readString(readValue(payloadRecord, "event"));

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

    const events = this.extractWebhookEvents(
      payload,
      request.headers.get("x-webhook-batch"),
    );

    for (const event of events) {
      const raw = this.buildWebhookRawMessage(event);
      if (!raw) {
        continue;
      }

      const threadId = this.encodeThreadId({
        phoneNumberId: raw.phoneNumberId,
        userWaId: raw.userWaId,
      });

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

  parseMessage(raw: KapsoRawMessage): Message<KapsoRawMessage> {
    const threadId = this.encodeThreadId({
      phoneNumberId: raw.phoneNumberId,
      userWaId: raw.userWaId,
    });
    const senderId = this.resolveSenderId(raw);
    const isMe = senderId === this._botUserId;
    const displayName = raw.contactName ?? (isMe ? this.userName : raw.userWaId);
    const text = this.extractMessageText(raw.message);

    return new Message<KapsoRawMessage>({
      id: raw.message.id,
      threadId,
      text,
      formatted: this.formatConverter.toAst(text),
      raw,
      author: {
        userId: senderId,
        userName: displayName,
        fullName: displayName,
        isBot: false,
        isMe,
      },
      metadata: {
        dateSent: parseUnixTimestamp(raw.message.timestamp),
        edited: false,
      },
      attachments: this.buildAttachments(raw.message),
    });
  }

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

  async editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<KapsoRawMessage>> {
    this.notImplemented("editMessage");
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    this.notImplemented("deleteMessage");
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

  async startTyping(_threadId: string, _status?: string): Promise<void> {
    this.notImplemented("startTyping");
  }

  async fetchMessages(
    _threadId: string,
    _options?: FetchOptions,
  ): Promise<FetchResult<KapsoRawMessage>> {
    this.notImplemented("fetchMessages");
  }

  async fetchThread(_threadId: string): Promise<ThreadInfo> {
    this.notImplemented("fetchThread");
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

  private verifyWebhookSignature(
    body: string,
    signature: string | null,
  ): boolean {
    if (!signature) {
      return false;
    }

    const expected = createHmac("sha256", this.webhookSecret)
      .update(body)
      .digest("hex");

    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  private extractWebhookEvents(
    payload: unknown,
    batchHeader: string | null,
  ): KapsoWebhookMessageReceivedEvent[] {
    if (!isRecord(payload)) {
      return [];
    }

    const data = readValue(payload, "data");
    if (Array.isArray(data)) {
      return data.filter(isKapsoWebhookMessageReceivedEvent);
    }

    const isBatch = batchHeader === "true" || readValue(payload, "batch") === true;
    if (isBatch) {
      return [];
    }

    return isKapsoWebhookMessageReceivedEvent(payload) ? [payload] : [];
  }

  private buildWebhookRawMessage(
    event: KapsoWebhookMessageReceivedEvent,
  ): KapsoRawMessage | null {
    const { message } = event;
    const kapso = message.kapso;
    const direction = kapso?.direction;
    if (direction && direction !== "inbound") {
      this.logger.debug("Ignoring non-inbound Kapso message event", {
        direction,
        messageId: message.id,
      });
      return null;
    }

    const conversation = event.conversation;
    const phoneNumberId =
      event.phone_number_id ??
      event.phoneNumberId ??
      conversation?.phone_number_id ??
      conversation?.phoneNumberId ??
      this.phoneNumberId;
    const userWaId =
      normalizeUserWaId(message.from) ??
      normalizeUserWaId(conversation?.phone_number ?? conversation?.phoneNumber);

    if (!userWaId) {
      this.logger.warn("Kapso webhook message missing sender identifier", {
        messageId: message.id,
        phoneNumberId,
      });
      return null;
    }

    return {
      phoneNumberId,
      userWaId,
      message,
      contactName: this.extractContactName(conversation),
    };
  }

  private extractContactName(
    conversation: KapsoWebhookConversation | undefined,
  ): string | undefined {
    return conversation?.kapso?.contactName ?? conversation?.kapso?.contact_name;
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

  private resolveSenderId(raw: KapsoRawMessage): string {
    const senderId = raw.message.from;
    if (senderId) {
      return senderId;
    }

    const direction = raw.message.kapso?.direction;
    if (direction === "outbound") {
      return raw.phoneNumberId;
    }

    return raw.userWaId;
  }

  private extractMessageText(message: KapsoMessage): string {
    const type = message.type || "message";
    const kapso = message.kapso;
    const mediaData = kapso?.mediaData ?? kapso?.media_data;
    const messageTypeData =
      kapso?.messageTypeData ?? kapso?.message_type_data;
    const transcript = kapso?.transcript;
    const kapsoContent = this.extractKapsoContent(kapso);
    const textBody = message.text?.body;
    if (textBody) {
      return textBody;
    }

    const caption =
      message.image?.caption ??
      message.video?.caption ??
      message.document?.caption ??
      readString(readValue(messageTypeData, "caption"));
    const transcriptText =
      (typeof transcript?.text === "string" ? transcript.text : undefined) ??
      transcript?.body;
    const filename = mediaData?.filename ?? message.document?.filename;

    switch (type) {
      case "text":
        return kapsoContent ?? "";
      case "image":
        return caption ?? kapsoContent ?? this.buildMediaFallback("Image", filename);
      case "video":
        return caption ?? kapsoContent ?? this.buildMediaFallback("Video", filename);
      case "document":
        return caption ?? kapsoContent ?? this.buildMediaFallback("Document", filename);
      case "audio":
        return transcriptText ?? kapsoContent ?? this.buildMediaFallback("Audio", filename);
      case "sticker":
        return kapsoContent ?? this.buildMediaFallback("Sticker", filename);
      case "location": {
        const location = message.location;
        const name = location?.name;
        const address = location?.address;
        const latitude = location?.latitude;
        const longitude = location?.longitude;
        if (name && address) {
          return `[Location: ${name} - ${address}]`;
        }
        if (name) {
          return `[Location: ${name}]`;
        }
        if (latitude !== undefined && longitude !== undefined) {
          return `[Location: ${latitude}, ${longitude}]`;
        }
        return "[Location]";
      }
      case "contacts":
        return kapsoContent ?? "[Contact card]";
      case "reaction": {
        const emoji = message.reaction?.emoji;
        return emoji ? `[Reaction: ${emoji}]` : "[Reaction]";
      }
      case "interactive":
        return kapsoContent ?? "[Interactive message]";
      case "template": {
        const name = message.template?.name;
        return name ? `[Template: ${name}]` : kapsoContent ?? "[Template]";
      }
      case "order":
        return (
          kapso?.orderText ??
          kapso?.order_text ??
          message.order?.orderText ??
          kapsoContent ??
          "[Order]"
        );
      default:
        return kapsoContent ?? `[${type}]`;
    }
  }

  private extractKapsoContent(kapso: KapsoMessage["kapso"]): string | undefined {
    const content = kapso?.content;
    if (typeof content === "string" && content.length > 0) {
      return content;
    }

    if (isRecord(content)) {
      return readString(readValue(content, "text", "body", "value"));
    }

    return undefined;
  }

  private buildMediaFallback(label: string, filename: string | undefined): string {
    return filename ? `[${label}: ${filename}]` : `[${label}]`;
  }

  private buildAttachments(message: KapsoMessage): Attachment[] {
    const type = message.type;
    const kapso = message.kapso;
    const mediaData = kapso?.mediaData ?? kapso?.media_data;
    const mediaUrl =
      kapso?.mediaUrl ??
      kapso?.media_url ??
      mediaData?.url;
    const mimeType = mediaData?.contentType ?? mediaData?.content_type;
    const size = mediaData?.byteSize ?? mediaData?.byte_size;
    const attachments: Attachment[] = [];

    const pushMediaAttachment = (
      attachmentType: Attachment["type"],
      name?: string,
    ) => {
      attachments.push({
        type: attachmentType,
        url: mediaUrl,
        mimeType,
        name,
        size,
      });
    };

    switch (type) {
      case "image":
        pushMediaAttachment("image", mediaData?.filename);
        break;
      case "video":
        pushMediaAttachment("video", mediaData?.filename);
        break;
      case "audio":
        pushMediaAttachment("audio", mediaData?.filename ?? "audio");
        break;
      case "document":
        pushMediaAttachment(
          "file",
          message.document?.filename ?? mediaData?.filename ?? "document",
        );
        break;
      case "sticker":
        pushMediaAttachment("image", mediaData?.filename ?? "sticker");
        break;
      case "location": {
        const latitude = message.location?.latitude;
        const longitude = message.location?.longitude;

        if (latitude !== undefined && longitude !== undefined) {
          attachments.push({
            type: "file",
            name: message.location?.name ?? "Location",
            url: `https://www.google.com/maps?q=${latitude},${longitude}`,
            mimeType: "application/geo+json",
          });
        }
        break;
      }
      default:
        break;
    }

    return attachments;
  }

  private notImplemented(method: string): never {
    throw new NotImplementedError(
      `Kapso adapter ${method} is not implemented.`,
      method,
    );
  }
}
