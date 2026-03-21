import { ValidationError } from "@chat-adapter/shared";
import {
  type SendMessageResponse,
  type WhatsAppClient,
} from "@kapso/whatsapp-cloud-api";
import { Card, getEmoji, NotImplementedError, type ChatInstance } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KapsoAdapter } from "./adapter.js";

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
          attachments: [{ type: "image", url: "https://example.com/image.png" }],
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

  describe("unimplemented methods", () => {
    it("throws for parseMessage", () => {
      const adapter = createTestAdapter();

      expect(() => adapter.parseMessage({} as never)).toThrow(
        NotImplementedError,
      );
      expect(() => adapter.parseMessage({} as never)).toThrow("parseMessage");
    });

    const createAsyncCalls = () => {
      const adapter = createTestAdapter();

      return [
        {
          name: "handleWebhook",
          call: () => adapter.handleWebhook(new Request("https://example.com")),
        },
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
