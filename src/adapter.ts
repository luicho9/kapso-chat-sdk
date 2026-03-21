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
  type ChatInstance,
  ConsoleLogger,
  convertEmojiPlaceholders,
  defaultEmojiResolver,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type Logger,
  type Message,
  NotImplementedError,
  type RawMessage,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import { KapsoFormatConverter } from "./format-converter.js";
import type {
  KapsoAdapterConfig,
  KapsoRawMessage,
  KapsoThreadId,
} from "./types.js";

/** Maximum message length for WhatsApp Cloud API */
const KAPSO_MESSAGE_LIMIT = 4096;

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
 * Supports outbound text messages and reactions via the Kapso WhatsApp API.
 * Inbound webhook handling and history/thread APIs are implemented separately.
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
  private logger: Logger;
  private _botUserId: string | null = null;

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
    _request: Request,
    _options?: WebhookOptions,
  ): Promise<Response> {
    this.notImplemented("handleWebhook");
  }

  parseMessage(_raw: KapsoRawMessage): Message<KapsoRawMessage> {
    return this.notImplemented("parseMessage");
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

  private notImplemented(method: string): never {
    throw new NotImplementedError(
      `Kapso adapter ${method} is not implemented yet.`,
      method,
    );
  }
}
