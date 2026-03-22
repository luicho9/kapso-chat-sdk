import type { ChatInstance } from "chat";
import { getEmoji } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KapsoAdapter } from "../src/adapter.js";
import {
  createImageRawMessage,
  createKapsoWebhookRequest,
  createLogger,
  createReceivedReactionWebhookEvent,
  createReceivedTextWebhookEvent,
  createTestAdapter,
  createTextRawMessage,
} from "./kapso-test-helpers.js";

async function initializeAdapterForWebhooks(adapter = createTestAdapter()) {
  const logger = {
    ...createLogger(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const processMessage = vi.fn();
  const processReaction = vi.fn();
  const chat = {
    getLogger: () => logger,
    processMessage,
    processReaction,
  } as unknown as ChatInstance;

  await adapter.initialize(chat);

  return { adapter, logger, processMessage, processReaction };
}

describe("KapsoAdapter webhook integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

      const response = await adapter.handleWebhook(
        createKapsoWebhookRequest("{", {
          rawBody: "{",
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

    it("emits reaction-added webhook payloads via processReaction", async () => {
      const { adapter, processMessage, processReaction } =
        await initializeAdapterForWebhooks();
      const options = { waitUntil: vi.fn() };

      const response = await adapter.handleWebhook(
        createKapsoWebhookRequest(createReceivedReactionWebhookEvent(), {
          headers: {
            "x-webhook-event": "whatsapp.message.received",
          },
        }),
        options,
      );

      expect(response.status).toBe(200);
      expect(processMessage).not.toHaveBeenCalled();
      expect(processReaction).toHaveBeenCalledOnce();
      expect(processReaction).toHaveBeenCalledWith(
        {
          adapter,
          emoji: getEmoji("👍"),
          rawEmoji: "👍",
          added: true,
          user: {
            userId: "15551234567",
            userName: "John Doe",
            fullName: "John Doe",
            isBot: false,
            isMe: false,
          },
          messageId: "wamid.original",
          threadId: "kapso:123456789:15551234567",
          raw: {
            phoneNumberId: "123456789",
            userWaId: "15551234567",
            contactName: "John Doe",
            message: createReceivedReactionWebhookEvent().message,
          },
        },
        options,
      );
    });

    it("emits reaction-removed webhook payloads via processReaction", async () => {
      const { adapter, processMessage, processReaction } =
        await initializeAdapterForWebhooks();
      const options = { waitUntil: vi.fn() };

      const response = await adapter.handleWebhook(
        createKapsoWebhookRequest(
          createReceivedReactionWebhookEvent({
            message: {
              ...createReceivedReactionWebhookEvent().message,
              reaction: {
                message_id: "wamid.original",
                emoji: "",
              },
            },
          }),
          {
            headers: {
              "x-webhook-event": "whatsapp.message.received",
            },
          },
        ),
        options,
      );

      expect(response.status).toBe(200);
      expect(processMessage).not.toHaveBeenCalled();
      expect(processReaction).toHaveBeenCalledOnce();
      expect(processReaction).toHaveBeenCalledWith(
        {
          adapter,
          emoji: getEmoji(""),
          rawEmoji: "",
          added: false,
          user: {
            userId: "15551234567",
            userName: "John Doe",
            fullName: "John Doe",
            isBot: false,
            isMe: false,
          },
          messageId: "wamid.original",
          threadId: "kapso:123456789:15551234567",
          raw: {
            phoneNumberId: "123456789",
            userWaId: "15551234567",
            contactName: "John Doe",
            message: {
              ...createReceivedReactionWebhookEvent().message,
              reaction: {
                message_id: "wamid.original",
                emoji: "",
              },
            },
          },
        },
        options,
      );
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
              from: "15550000000",
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
});
