import { createHmac } from "node:crypto";
import { ValidationError } from "@chat-adapter/shared";
import {
  type SendMessageResponse,
  type WhatsAppClient,
} from "@kapso/whatsapp-cloud-api";
import { Card, getEmoji, NotImplementedError, type ChatInstance } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KapsoAdapter } from "./adapter.js";
import type {
  KapsoRawMessage,
  KapsoWebhookMessageReceivedEvent,
} from "./types.js";

function createTestAdapter(): KapsoAdapter {
  return new KapsoAdapter({
    baseUrl: "https://api.kapso.ai/meta/whatsapp",
    kapsoApiKey: "test-api-key",
    phoneNumberId: "123456789",
    userName: "test-bot",
    webhookSecret: "test-secret",
  });
}

function getClient(adapter: KapsoAdapter): WhatsAppClient {
  return (adapter as unknown as { client: WhatsAppClient }).client;
}

function createLogger() {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return logger;
}

async function initializeAdapterForWebhooks(adapter = createTestAdapter()) {
  const logger = createLogger();
  const processMessage = vi.fn();
  const chat = {
    getLogger: () => logger,
    processMessage,
  } as unknown as ChatInstance;

  await adapter.initialize(chat);

  return { adapter, logger, processMessage };
}

function createSendResponse(messageId: string): SendMessageResponse {
  return {
    messagingProduct: "whatsapp",
    contacts: [
      {
        input: "15551234567",
        waId: "15551234567",
      },
    ],
    messages: [{ id: messageId }],
  };
}

function createWebhookSignature(body: string): string {
  return createHmac("sha256", "test-secret").update(body).digest("hex");
}

function createKapsoWebhookRequest(
  payload: unknown,
  options?: {
    headers?: HeadersInit;
    method?: string;
    rawBody?: string;
    signature?: string;
  },
): Request {
  const body =
    options?.rawBody ??
    (typeof payload === "string" ? payload : JSON.stringify(payload));
  const headers = new Headers(options?.headers);
  headers.set("Content-Type", "application/json");
  headers.set(
    "x-webhook-signature",
    options?.signature ?? createWebhookSignature(body),
  );

  return new Request("https://example.com/webhooks/kapso", {
    method: options?.method ?? "POST",
    headers,
    body,
  });
}

function createReceivedTextWebhookEvent(
  overrides?: Partial<KapsoWebhookMessageReceivedEvent>,
): KapsoWebhookMessageReceivedEvent {
  return {
    message: {
      id: "wamid.123",
      timestamp: "1730092800",
      type: "text",
      text: { body: "Hello from Kapso" },
      kapso: {
        direction: "inbound",
        status: "received",
        processing_status: "pending",
        origin: "cloud_api",
        has_media: false,
        content: "Hello from Kapso",
      },
    },
    conversation: {
      id: "conv_123",
      phone_number: "+1 (555) 123-4567",
      status: "active",
      metadata: {},
      phone_number_id: "123456789",
      kapso: {
        contact_name: "John Doe",
        messages_count: 1,
        last_message_id: "wamid.123",
        last_message_type: "text",
        last_message_timestamp: "2025-10-28T14:25:01Z",
        last_message_text: "Hello from Kapso",
        last_inbound_at: "2025-10-28T14:25:01Z",
        last_outbound_at: null,
      },
    },
    is_new_conversation: true,
    phone_number_id: "123456789",
    ...overrides,
  };
}

function createTextRawMessage(): KapsoRawMessage {
  return {
    phoneNumberId: "123456789",
    userWaId: "15551234567",
    contactName: "John Doe",
    message: {
      id: "wamid.text",
      timestamp: "1730092800",
      type: "text",
      text: { body: "Hello *Kapso*" },
      kapso: {
        direction: "inbound",
        status: "received",
        processing_status: "pending",
        origin: "cloud_api",
        has_media: false,
        content: "Hello *Kapso*",
      },
    },
  };
}

function createImageRawMessage(): KapsoRawMessage {
  return {
    phoneNumberId: "123456789",
    userWaId: "15551234567",
    contactName: "Jane Doe",
    message: {
      id: "wamid.image",
      timestamp: "1730093000",
      type: "image",
      image: {
        id: "media_123",
      },
      kapso: {
        direction: "inbound",
        status: "received",
        processing_status: "pending",
        origin: "cloud_api",
        has_media: true,
        media_url: "https://api.kapso.ai/media/photo.jpg",
        media_data: {
          url: "https://api.kapso.ai/media/photo.jpg",
          filename: "photo.jpg",
          content_type: "image/jpeg",
          byte_size: 204800,
        },
      },
    },
  };
}

describe("KapsoAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("initialize", () => {
    it("sets botUserId and uses the chat logger", async () => {
      const adapter = createTestAdapter();
      const logger = {
        child: () => logger,
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      };
      const chat = {
        getLogger: () => logger,
      } as unknown as ChatInstance;

      await adapter.initialize(chat);

      expect(adapter.botUserId).toBe("123456789");
      expect(logger.info).toHaveBeenCalledWith("Kapso adapter initialized", {
        baseUrl: "https://api.kapso.ai/meta/whatsapp",
        phoneNumberId: "123456789",
      });
    });
  });

  describe("thread IDs", () => {
    it("encodes a thread ID", () => {
      const adapter = createTestAdapter();

      expect(
        adapter.encodeThreadId({
          phoneNumberId: "123456789",
          userWaId: "15551234567",
        }),
      ).toBe("kapso:123456789:15551234567");
    });

    it("decodes a valid thread ID", () => {
      const adapter = createTestAdapter();

      expect(adapter.decodeThreadId("kapso:123456789:15551234567")).toEqual({
        phoneNumberId: "123456789",
        userWaId: "15551234567",
      });
    });

    it("round-trips a thread ID", () => {
      const adapter = createTestAdapter();
      const original = {
        phoneNumberId: "123456789",
        userWaId: "15551234567",
      };

      expect(adapter.decodeThreadId(adapter.encodeThreadId(original))).toEqual(
        original,
      );
    });

    it("throws on invalid prefix", () => {
      const adapter = createTestAdapter();

      expect(() =>
        adapter.decodeThreadId("whatsapp:123456789:15551234567"),
      ).toThrow("Invalid Kapso thread ID");
    });

    it("throws on empty after prefix", () => {
      const adapter = createTestAdapter();

      expect(() => adapter.decodeThreadId("kapso:")).toThrow(
        "Invalid Kapso thread ID format",
      );
    });

    it("throws on missing userWaId", () => {
      const adapter = createTestAdapter();

      expect(() => adapter.decodeThreadId("kapso:123456789:")).toThrow(
        "Invalid Kapso thread ID format",
      );
    });

    it("throws on completely wrong format", () => {
      const adapter = createTestAdapter();

      expect(() => adapter.decodeThreadId("nonsense")).toThrow(
        "Invalid Kapso thread ID",
      );
    });

    it("throws on extra segments", () => {
      const adapter = createTestAdapter();

      expect(() => adapter.decodeThreadId("kapso:123:456:extra")).toThrow(
        "Invalid Kapso thread ID format",
      );
    });
  });

  describe("dm helpers", () => {
    it("returns the full thread ID as channel ID", () => {
      const adapter = createTestAdapter();

      expect(adapter.channelIdFromThreadId("kapso:123456789:15551234567")).toBe(
        "kapso:123456789:15551234567",
      );
    });

    it("always reports conversations as DMs", () => {
      const adapter = createTestAdapter();

      expect(adapter.isDM("kapso:123456789:15551234567")).toBe(true);
    });

    it("opens a DM by constructing the thread ID", async () => {
      const adapter = createTestAdapter();

      await expect(adapter.openDM("15551234567")).resolves.toBe(
        "kapso:123456789:15551234567",
      );
    });
  });

  describe("renderFormatted", () => {
    it("renders simple text from an AST", () => {
      const adapter = createTestAdapter();
      const ast = {
        type: "root" as const,
        children: [
          {
            type: "paragraph" as const,
            children: [{ type: "text" as const, value: "Hello world" }],
          },
        ],
      };

      expect(adapter.renderFormatted(ast)).toContain("Hello world");
    });
  });

  describe("postMessage", () => {
    it("sends a plain string via the Kapso SDK", async () => {
      const adapter = createTestAdapter();
      const sendText = vi
        .spyOn(getClient(adapter).messages, "sendText")
        .mockResolvedValue(createSendResponse("wamid.sent123"));

      const result = await adapter.postMessage(
        "kapso:123456789:15551234567",
        "Hello there",
      );

      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        to: "15551234567",
        body: "Hello there",
      });
      expect(result).toEqual({
        id: "wamid.sent123",
        threadId: "kapso:123456789:15551234567",
        raw: {
          phoneNumberId: "123456789",
          userWaId: "15551234567",
          message: {
            id: "wamid.sent123",
            type: "text",
            timestamp: expect.any(String),
            from: "123456789",
            to: "15551234567",
            text: {
              body: "Hello there",
            },
          },
        },
      });
    });

    it("renders markdown and converts emoji placeholders before sending", async () => {
      const adapter = createTestAdapter();
      const sendText = vi
        .spyOn(getClient(adapter).messages, "sendText")
        .mockResolvedValue(createSendResponse("wamid.markdown"));

      await adapter.postMessage("kapso:123456789:15551234567", {
        markdown: `**Hello** ${getEmoji("wave")}`,
      });

      expect(sendText).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        to: "15551234567",
        body: "*Hello* 👋",
      });
    });

    it("renders AST content before sending", async () => {
      const adapter = createTestAdapter();
      const sendText = vi
        .spyOn(getClient(adapter).messages, "sendText")
        .mockResolvedValue(createSendResponse("wamid.ast"));

      await adapter.postMessage("kapso:123456789:15551234567", {
        ast: {
          type: "root",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", value: "Hello from AST" }],
            },
          ],
        },
      });

      expect(sendText).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        to: "15551234567",
        body: "Hello from AST",
      });
    });

    it("splits long messages and returns the last sent chunk", async () => {
      const adapter = createTestAdapter();
      const sendText = vi
        .spyOn(getClient(adapter).messages, "sendText")
        .mockResolvedValueOnce(createSendResponse("wamid.chunk1"))
        .mockResolvedValueOnce(createSendResponse("wamid.chunk2"));

      const result = await adapter.postMessage(
        "kapso:123456789:15551234567",
        "a".repeat(5000),
      );

      expect(sendText).toHaveBeenCalledTimes(2);
      expect(sendText.mock.calls[0]?.[0]).toMatchObject({
        phoneNumberId: "123456789",
        to: "15551234567",
      });
      expect(sendText.mock.calls[0]?.[0]?.body).toHaveLength(4096);
      expect(sendText.mock.calls[1]?.[0]?.body).toHaveLength(904);
      expect(result.id).toBe("wamid.chunk2");
      expect(result.raw.message.text?.body).toHaveLength(904);
    });

    it("preserves paragraph separators when splitting long messages", async () => {
      const adapter = createTestAdapter();
      const sendText = vi
        .spyOn(getClient(adapter).messages, "sendText")
        .mockResolvedValueOnce(createSendResponse("wamid.chunk1"))
        .mockResolvedValueOnce(createSendResponse("wamid.chunk2"));

      await adapter.postMessage(
        "kapso:123456789:15551234567",
        `${"a".repeat(3000)}\n\n${"b".repeat(1500)}`,
      );

      expect(sendText).toHaveBeenCalledTimes(2);
      expect(sendText.mock.calls[0]?.[0]?.body).toHaveLength(3002);
      expect(sendText.mock.calls[0]?.[0]?.body.endsWith("\n\n")).toBe(true);
      expect(sendText.mock.calls[1]?.[0]?.body).toBe("b".repeat(1500));
    });

    it("preserves line separators when splitting long messages", async () => {
      const adapter = createTestAdapter();
      const sendText = vi
        .spyOn(getClient(adapter).messages, "sendText")
        .mockResolvedValueOnce(createSendResponse("wamid.chunk1"))
        .mockResolvedValueOnce(createSendResponse("wamid.chunk2"));

      await adapter.postMessage(
        "kapso:123456789:15551234567",
        `${"a".repeat(3000)}\n${"b".repeat(1500)}`,
      );

      expect(sendText).toHaveBeenCalledTimes(2);
      expect(sendText.mock.calls[0]?.[0]?.body).toHaveLength(3001);
      expect(sendText.mock.calls[0]?.[0]?.body.endsWith("\n")).toBe(true);
      expect(sendText.mock.calls[1]?.[0]?.body).toBe("b".repeat(1500));
    });

    it("rejects direct cards in v1", async () => {
      const adapter = createTestAdapter();

      await expect(
        adapter.postMessage(
          "kapso:123456789:15551234567",
          Card({ title: "Unsupported" }),
        ),
      ).rejects.toThrow(ValidationError);
      await expect(
        adapter.postMessage(
          "kapso:123456789:15551234567",
          Card({ title: "Unsupported" }),
        ),
      ).rejects.toThrow("only supports text messages");
    });

    it("rejects wrapped cards in v1", async () => {
      const adapter = createTestAdapter();

      await expect(
        adapter.postMessage("kapso:123456789:15551234567", {
          card: Card({ title: "Unsupported" }),
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects attachments in v1", async () => {
      const adapter = createTestAdapter();

      await expect(
        adapter.postMessage("kapso:123456789:15551234567", {
          raw: "hello",
          attachments: [
            { type: "image", url: "https://example.com/image.png" },
          ],
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects files in v1", async () => {
      const adapter = createTestAdapter();

      await expect(
        adapter.postMessage("kapso:123456789:15551234567", {
          raw: "hello",
          files: [{ filename: "hello.txt", data: Buffer.from("hello") }],
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("reactions", () => {
    it("sends raw unicode reactions via the Kapso SDK", async () => {
      const adapter = createTestAdapter();
      const sendReaction = vi
        .spyOn(getClient(adapter).messages, "sendReaction")
        .mockResolvedValue(createSendResponse("wamid.reaction"));

      await adapter.addReaction(
        "kapso:123456789:15551234567",
        "wamid.original",
        "😀",
      );

      expect(sendReaction).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        to: "15551234567",
        reaction: {
          messageId: "wamid.original",
          emoji: "😀",
        },
      });
    });

    it("converts EmojiValue reactions to unicode", async () => {
      const adapter = createTestAdapter();
      const sendReaction = vi
        .spyOn(getClient(adapter).messages, "sendReaction")
        .mockResolvedValue(createSendResponse("wamid.reaction"));

      await adapter.addReaction(
        "kapso:123456789:15551234567",
        "wamid.original",
        getEmoji("thumbs_up"),
      );

      expect(sendReaction).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        to: "15551234567",
        reaction: {
          messageId: "wamid.original",
          emoji: "👍",
        },
      });
    });

    it("removes reactions by sending an empty emoji", async () => {
      const adapter = createTestAdapter();
      const sendReaction = vi
        .spyOn(getClient(adapter).messages, "sendReaction")
        .mockResolvedValue(createSendResponse("wamid.reaction"));

      await adapter.removeReaction(
        "kapso:123456789:15551234567",
        "wamid.original",
        "😀",
      );

      expect(sendReaction).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        to: "15551234567",
        reaction: {
          messageId: "wamid.original",
          emoji: "",
        },
      });
    });
  });

  describe("handleWebhook", () => {
    it("rejects non-POST requests", async () => {
      const adapter = createTestAdapter();

      const response = await adapter.handleWebhook(
        new Request("https://example.com/webhooks/kapso", { method: "GET" }),
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    });

    it("rejects requests with an invalid signature", async () => {
      const { adapter, processMessage } = await initializeAdapterForWebhooks();
      const response = await adapter.handleWebhook(
        createKapsoWebhookRequest(createReceivedTextWebhookEvent(), {
          headers: {
            "x-webhook-event": "whatsapp.message.received",
          },
          signature: "invalid-signature",
        }),
      );

      expect(response.status).toBe(401);
      expect(processMessage).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid JSON", async () => {
      const { adapter, processMessage, logger } =
        await initializeAdapterForWebhooks();
      const rawBody = "{";
      const response = await adapter.handleWebhook(
        createKapsoWebhookRequest(rawBody, {
          rawBody,
          headers: {
            "x-webhook-event": "whatsapp.message.received",
          },
        }),
      );

      expect(response.status).toBe(400);
      expect(processMessage).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith("Kapso webhook invalid JSON", {
        contentType: "application/json",
        bodyPreview: "{",
      });
    });

    it("processes whatsapp.message.received webhook payloads", async () => {
      const { adapter, processMessage } = await initializeAdapterForWebhooks();
      const options = { waitUntil: vi.fn() };
      const response = await adapter.handleWebhook(
        createKapsoWebhookRequest(createReceivedTextWebhookEvent(), {
          headers: {
            "x-webhook-event": "whatsapp.message.received",
          },
        }),
        options,
      );

      expect(response.status).toBe(200);
      expect(processMessage).toHaveBeenCalledOnce();
      expect(processMessage).toHaveBeenCalledWith(
        adapter,
        "kapso:123456789:15551234567",
        expect.any(Function),
        options,
      );

      const factory = processMessage.mock.calls[0]?.[2] as
        | (() => Promise<ReturnType<KapsoAdapter["parseMessage"]>>)
        | undefined;
      expect(factory).toBeTypeOf("function");

      const message = await factory?.();
      expect(message?.text).toBe("Hello from Kapso");
      expect(message?.author.userId).toBe("15551234567");
      expect(message?.author.userName).toBe("John Doe");
      expect(message?.threadId).toBe("kapso:123456789:15551234567");
      expect(message?.raw.userWaId).toBe("15551234567");
    });

    it("processes buffered whatsapp.message.received webhook payloads", async () => {
      const { adapter, processMessage } = await initializeAdapterForWebhooks();
      const payload = {
        batch: true,
        data: [
          createReceivedTextWebhookEvent(),
          createReceivedTextWebhookEvent({
            message: {
              id: "wamid.456",
              timestamp: "1730092801",
              type: "text",
              text: { body: "Second message" },
              kapso: {
                direction: "inbound",
                status: "received",
                processing_status: "pending",
                origin: "cloud_api",
                has_media: false,
                content: "Second message",
              },
            },
            conversation: {
              id: "conv_456",
              phone_number: "+1 (555) 000-0000",
              status: "active",
              metadata: {},
              phone_number_id: "123456789",
              kapso: {
                contact_name: "Second User",
              },
            },
          }),
        ],
        batch_info: {
          size: 2,
          window_ms: 5000,
          first_sequence: 100,
          last_sequence: 101,
          conversation_id: "conv_123",
        },
      };

      const response = await adapter.handleWebhook(
        createKapsoWebhookRequest(payload, {
          headers: {
            "x-webhook-batch": "true",
            "x-webhook-event": "whatsapp.message.received",
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(processMessage).toHaveBeenCalledTimes(2);
      expect(processMessage.mock.calls[0]?.[1]).toBe(
        "kapso:123456789:15551234567",
      );
      expect(processMessage.mock.calls[1]?.[1]).toBe(
        "kapso:123456789:15550000000",
      );
    });

    it("deduplicates repeated webhook deliveries by X-Idempotency-Key", async () => {
      const { adapter, processMessage } = await initializeAdapterForWebhooks();
      const requestOptions = {
        headers: {
          "x-idempotency-key": "evt_123",
          "x-webhook-event": "whatsapp.message.received",
        },
      };

      const first = await adapter.handleWebhook(
        createKapsoWebhookRequest(
          createReceivedTextWebhookEvent(),
          requestOptions,
        ),
      );
      const second = await adapter.handleWebhook(
        createKapsoWebhookRequest(
          createReceivedTextWebhookEvent(),
          requestOptions,
        ),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(processMessage).toHaveBeenCalledOnce();
    });
  });

  describe("parseMessage", () => {
    it("parses inbound text messages", () => {
      const adapter = createTestAdapter();
      const message = adapter.parseMessage(createTextRawMessage());

      expect(message.id).toBe("wamid.text");
      expect(message.threadId).toBe("kapso:123456789:15551234567");
      expect(message.text).toBe("Hello *Kapso*");
      expect(message.formatted.type).toBe("root");
      expect(message.author).toEqual({
        userId: "15551234567",
        userName: "John Doe",
        fullName: "John Doe",
        isBot: false,
        isMe: false,
      });
      expect(message.metadata).toEqual({
        dateSent: new Date(1730092800 * 1000),
        edited: false,
      });
      expect(message.attachments).toEqual([]);
      expect(message.raw).toEqual(createTextRawMessage());
    });

    it("builds fallback text and attachments for non-text messages", () => {
      const adapter = createTestAdapter();
      const message = adapter.parseMessage(createImageRawMessage());

      expect(message.text).toBe("[Image: photo.jpg]");
      expect(message.author.userId).toBe("15551234567");
      expect(message.attachments).toEqual([
        {
          type: "image",
          url: "https://api.kapso.ai/media/photo.jpg",
          mimeType: "image/jpeg",
          name: "photo.jpg",
          size: 204800,
        },
      ]);
    });
  });

  describe("unimplemented methods", () => {
    const createAsyncCalls = () => {
      const adapter = createTestAdapter();

      return [
        {
          name: "editMessage",
          call: () =>
            adapter.editMessage(
              "kapso:123456789:15551234567",
              "wamid.123",
              "hello",
            ),
        },
        {
          name: "deleteMessage",
          call: () =>
            adapter.deleteMessage("kapso:123456789:15551234567", "wamid.123"),
        },
        {
          name: "startTyping",
          call: () => adapter.startTyping("kapso:123456789:15551234567"),
        },
        {
          name: "fetchMessages",
          call: () => adapter.fetchMessages("kapso:123456789:15551234567"),
        },
        {
          name: "fetchThread",
          call: () => adapter.fetchThread("kapso:123456789:15551234567"),
        },
      ] as const;
    };

    for (const { name, call } of createAsyncCalls()) {
      it(`throws for ${name}`, async () => {
        await expect(call()).rejects.toThrow(NotImplementedError);
        await expect(call()).rejects.toThrow(name);
      });
    }
  });
});
