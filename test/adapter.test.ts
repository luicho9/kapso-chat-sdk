import { ValidationError } from "@chat-adapter/shared";
import {
  getEmoji,
  type CardElement,
  type ChatInstance,
} from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWhatsAppCallbackData } from "../src/cards.js";
import {
  createContactRecord,
  createConversationListResponse,
  createConversationRecord,
  createMessageListResponse,
  createNotFoundGraphApiError,
  createSendResponse,
  createTestAdapter,
  createUnifiedTextMessage,
  getClient,
} from "./kapso-test-helpers.js";

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

  describe("thread and dm helpers", () => {
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

  describe("history and thread support", () => {
    it("enables persisted message history", () => {
      const adapter = createTestAdapter();

      expect(adapter.persistMessageHistory).toBe(true);
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

    it("sends supported cards as interactive reply buttons", async () => {
      const adapter = createTestAdapter();
      const sendInteractive = vi
        .spyOn(getClient(adapter).messages, "sendInteractiveRaw")
        .mockResolvedValue(createSendResponse("wamid.card"));
      const card: CardElement = {
        type: "card",
        title: "Choose an action",
        children: [
          { type: "text", content: "What would you like to do?" },
          {
            type: "actions",
            children: [
              { type: "button", id: "approve", label: "Approve" },
              { type: "button", id: "report", label: "Report bug", value: "bug" },
            ],
          },
        ],
      };

      const result = await adapter.postMessage(
        "kapso:123456789:15551234567",
        card,
      );

      expect(sendInteractive).toHaveBeenCalledOnce();
      expect(sendInteractive).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        to: "15551234567",
        interactive: {
          type: "button",
          header: {
            type: "text",
            text: "Choose an action",
          },
          body: {
            text: "What would you like to do?",
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: encodeWhatsAppCallbackData("approve"),
                  title: "Approve",
                },
              },
              {
                type: "reply",
                reply: {
                  id: encodeWhatsAppCallbackData("report", "bug"),
                  title: "Report bug",
                },
              },
            ],
          },
        },
      });
      expect(result).toEqual({
        id: "wamid.card",
        threadId: "kapso:123456789:15551234567",
        raw: {
          phoneNumberId: "123456789",
          userWaId: "15551234567",
          message: {
            id: "wamid.card",
            type: "interactive",
            timestamp: expect.any(String),
            from: "123456789",
            to: "15551234567",
            interactive: expect.any(Object),
          },
        },
      });
    });

    it("falls back to text for unsupported wrapped cards", async () => {
      const adapter = createTestAdapter();
      const sendText = vi
        .spyOn(getClient(adapter).messages, "sendText")
        .mockResolvedValue(createSendResponse("wamid.fallback"));
      const card: CardElement = {
        type: "card",
        title: "Links only",
        children: [
          {
            type: "actions",
            children: [
              {
                type: "link-button",
                url: "https://example.com",
                label: "Visit",
              },
            ],
          },
        ],
      };

      await adapter.postMessage("kapso:123456789:15551234567", { card });

      expect(sendText).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        to: "15551234567",
        body: "*Links only*\n\nVisit: https://example.com",
      });
    });

    it("rejects attachments", async () => {
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

    it("rejects files", async () => {
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

  describe("fetchMessages", () => {
    it("returns parsed messages in chronological order", async () => {
      const adapter = createTestAdapter();
      const conversation = createConversationRecord();
      const contact = createContactRecord();
      const listConversations = vi
        .spyOn(getClient(adapter).conversations, "list")
        .mockResolvedValue(createConversationListResponse([conversation]));
      const getContact = vi
        .spyOn(getClient(adapter).contacts, "get")
        .mockResolvedValue(contact);
      const listByConversation = vi
        .spyOn(getClient(adapter).messages, "listByConversation")
        .mockResolvedValue(
          createMessageListResponse(
            [
              createUnifiedTextMessage({
                id: "wamid.history.2",
                timestamp: "1730092900",
                text: {
                  body: "Second from history",
                },
                kapso: {
                  content: {
                    text: "Second from history",
                  },
                },
              }),
              createUnifiedTextMessage({
                id: "wamid.history.1",
                timestamp: "1730092800",
                text: {
                  body: "First from history",
                },
                kapso: {
                  content: {
                    text: "First from history",
                  },
                },
              }),
            ],
            {
              after: "older-page-1",
            },
          ),
        );

      const result = await adapter.fetchMessages(
        "kapso:123456789:15551234567",
      );

      expect(listConversations).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        phoneNumber: "+15551234567",
        limit: 100,
        after: undefined,
        fields: expect.stringContaining("contact_name"),
      });
      expect(getContact).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        waId: "15551234567",
      });
      expect(listByConversation).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        conversationId: "conv_123",
        limit: 50,
        after: undefined,
        fields: expect.any(String),
      });
      expect(result.messages.map((message) => message.text)).toEqual([
        "First from history",
        "Second from history",
      ]);
      expect(result.messages[0]?.raw).toMatchObject({
        phoneNumberId: "123456789",
        userWaId: "15551234567",
        contactName: "John Doe",
        message: {
          id: "wamid.history.1",
          text: {
            body: "First from history",
          },
        },
      });
      expect(result.nextCursor).toBe("older-page-1");
    });

    it("continues when contact enrichment fails", async () => {
      const adapter = createTestAdapter();
      const conversation = createConversationRecord({
        kapso: {
          contactName: "Conversation Contact",
        },
      });

      vi.spyOn(getClient(adapter).conversations, "list").mockResolvedValue(
        createConversationListResponse([conversation]),
      );
      vi.spyOn(getClient(adapter).contacts, "get").mockRejectedValue(
        new Error("Kapso contacts unavailable"),
      );
      vi.spyOn(getClient(adapter).messages, "listByConversation").mockResolvedValue(
        createMessageListResponse([
          createUnifiedTextMessage({
            text: {
              body: "History without contact",
            },
            kapso: {
              contactName: undefined,
              content: {
                text: "History without contact",
              },
            },
          }),
        ]),
      );

      const result = await adapter.fetchMessages(
        "kapso:123456789:15551234567",
      );

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.text).toBe("History without contact");
      expect(result.messages[0]?.author.fullName).toBe("Conversation Contact");
      expect(result.messages[0]?.raw).toMatchObject({
        contactName: "Conversation Contact",
      });
    });

    it("maps backward pagination cursors to Kapso after cursors", async () => {
      const adapter = createTestAdapter();
      const conversation = createConversationRecord();
      vi.spyOn(getClient(adapter).conversations, "list").mockResolvedValue(
        createConversationListResponse([conversation]),
      );
      vi.spyOn(getClient(adapter).contacts, "get").mockRejectedValue(
        createNotFoundGraphApiError(),
      );
      const listByConversation = vi
        .spyOn(getClient(adapter).messages, "listByConversation")
        .mockResolvedValue(
          createMessageListResponse(
            [
              createUnifiedTextMessage({
                id: "wamid.history.4",
                timestamp: "1730093100",
                text: {
                  body: "Fourth from history",
                },
              }),
              createUnifiedTextMessage({
                id: "wamid.history.3",
                timestamp: "1730093000",
                text: {
                  body: "Third from history",
                },
              }),
            ],
            {
              after: "older-page-2",
            },
          ),
        );

      const result = await adapter.fetchMessages(
        "kapso:123456789:15551234567",
        {
          cursor: "older-page-1",
          limit: 2,
        },
      );

      expect(listByConversation).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        conversationId: "conv_123",
        limit: 2,
        after: "older-page-1",
        fields: expect.any(String),
      });
      expect(result.messages.map((message) => message.text)).toEqual([
        "Third from history",
        "Fourth from history",
      ]);
      expect(result.nextCursor).toBe("older-page-2");
    });

    it("maps forward pagination to the oldest page first", async () => {
      const adapter = createTestAdapter();
      const conversation = createConversationRecord();
      vi.spyOn(getClient(adapter).conversations, "list").mockResolvedValue(
        createConversationListResponse([conversation]),
      );
      vi.spyOn(getClient(adapter).contacts, "get").mockResolvedValue(
        createContactRecord({
          displayName: "Jane Customer",
        }),
      );
      const listByConversation = vi
        .spyOn(getClient(adapter).messages, "listByConversation")
        .mockResolvedValueOnce(
          createMessageListResponse(
            [
              createUnifiedTextMessage({
                id: "wamid.history.4",
                timestamp: "1730093100",
                text: {
                  body: "Fourth from history",
                },
              }),
              createUnifiedTextMessage({
                id: "wamid.history.3",
                timestamp: "1730093000",
                text: {
                  body: "Third from history",
                },
              }),
            ],
            {
              after: "older-page-1",
            },
          ),
        )
        .mockResolvedValueOnce(
          createMessageListResponse(
            [
              createUnifiedTextMessage({
                id: "wamid.history.2",
                timestamp: "1730092900",
                text: {
                  body: "Second from history",
                },
              }),
              createUnifiedTextMessage({
                id: "wamid.history.1",
                timestamp: "1730092800",
                text: {
                  body: "First from history",
                },
              }),
            ],
            {
              before: "newer-page-1",
            },
          ),
        );

      const result = await adapter.fetchMessages(
        "kapso:123456789:15551234567",
        {
          direction: "forward",
          limit: 2,
        },
      );

      expect(listByConversation).toHaveBeenNthCalledWith(1, {
        phoneNumberId: "123456789",
        conversationId: "conv_123",
        limit: 2,
        fields: expect.any(String),
      });
      expect(listByConversation).toHaveBeenNthCalledWith(2, {
        phoneNumberId: "123456789",
        conversationId: "conv_123",
        limit: 2,
        after: "older-page-1",
        fields: expect.any(String),
      });
      expect(result.messages.map((message) => message.text)).toEqual([
        "First from history",
        "Second from history",
      ]);
      expect(result.nextCursor).toBe("newer-page-1");
    });

    it("prefers Kapso message and conversation names over contact names", async () => {
      const adapter = createTestAdapter();
      const conversation = createConversationRecord({
        kapso: {
          contactName: "Conversation Contact",
        },
      });
      const contact = createContactRecord({
        displayName: "Contact Display",
        profileName: "Contact Profile",
      });

      vi.spyOn(getClient(adapter).conversations, "list").mockResolvedValue(
        createConversationListResponse([conversation]),
      );
      vi.spyOn(getClient(adapter).contacts, "get").mockResolvedValue(contact);
      vi.spyOn(getClient(adapter).messages, "listByConversation").mockResolvedValue(
        createMessageListResponse([
          createUnifiedTextMessage({
            id: "wamid.history.1",
            text: {
              body: "Uses message Kapso name",
            },
            kapso: {
              contactName: "Message Contact",
              content: {
                text: "Uses message Kapso name",
              },
            },
          }),
          createUnifiedTextMessage({
            id: "wamid.history.2",
            timestamp: "1730092900",
            text: {
              body: "Uses conversation Kapso name",
            },
            kapso: {
              contactName: undefined,
              content: {
                text: "Uses conversation Kapso name",
              },
            },
          }),
        ]),
      );

      const result = await adapter.fetchMessages(
        "kapso:123456789:15551234567",
      );

      expect(result.messages.map((message) => message.raw.contactName)).toEqual([
        "Message Contact",
        "Conversation Contact",
      ]);
    });

    it("clamps the history fetch limit to 100", async () => {
      const adapter = createTestAdapter();
      const conversation = createConversationRecord();

      vi.spyOn(getClient(adapter).conversations, "list").mockResolvedValue(
        createConversationListResponse([conversation]),
      );
      vi.spyOn(getClient(adapter).contacts, "get").mockRejectedValue(
        createNotFoundGraphApiError(),
      );
      const listByConversation = vi
        .spyOn(getClient(adapter).messages, "listByConversation")
        .mockResolvedValue(createMessageListResponse([]));

      await adapter.fetchMessages("kapso:123456789:15551234567", {
        limit: 250,
      });

      expect(listByConversation).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        conversationId: "conv_123",
        limit: 100,
        after: undefined,
        fields: expect.any(String),
      });
    });
  });

  describe("fetchThread", () => {
    it("returns fallback info from the thread ID when no Kapso record exists", async () => {
      const adapter = createTestAdapter();
      const listConversations = vi
        .spyOn(getClient(adapter).conversations, "list")
        .mockResolvedValueOnce(createConversationListResponse([]))
        .mockResolvedValueOnce(createConversationListResponse([]));
      const getContact = vi
        .spyOn(getClient(adapter).contacts, "get")
        .mockRejectedValue(createNotFoundGraphApiError());

      const result = await adapter.fetchThread("kapso:123456789:15551234567");

      expect(listConversations).toHaveBeenCalledTimes(2);
      expect(getContact).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        waId: "15551234567",
      });
      expect(result).toEqual({
        id: "kapso:123456789:15551234567",
        channelId: "kapso:123456789:15551234567",
        channelName: "WhatsApp: 15551234567",
        isDM: true,
        metadata: {
          phoneNumberId: "123456789",
          userWaId: "15551234567",
        },
      });
    });

    it("continues when contact enrichment fails", async () => {
      const adapter = createTestAdapter();
      const conversation = createConversationRecord({
        id: "conv_555",
        kapso: {
          contactName: "Conversation Contact",
        },
      });

      vi.spyOn(getClient(adapter).conversations, "list").mockResolvedValue(
        createConversationListResponse([conversation]),
      );
      vi.spyOn(getClient(adapter).contacts, "get").mockRejectedValue(
        new Error("Kapso contacts unavailable"),
      );

      const result = await adapter.fetchThread("kapso:123456789:15551234567");

      expect(result.channelName).toBe("WhatsApp: Conversation Contact");
      expect(result.metadata).toMatchObject({
        phoneNumberId: "123456789",
        userWaId: "15551234567",
        contactName: "Conversation Contact",
        conversationId: "conv_555",
        conversation,
      });
      expect(result.metadata).not.toHaveProperty("contactId");
    });

    it("enriches metadata when Kapso conversation and contact data are available", async () => {
      const adapter = createTestAdapter();
      const conversation = createConversationRecord({
        id: "conv_999",
        phoneNumber: "+15551234567",
        kapso: {
          contactName: "Conversation Contact",
          lastMessageText: "Latest Kapso message",
        },
      });
      const contact = createContactRecord({
        id: "contact_999",
        displayName: "Jane Customer",
        profileName: "Jane Profile",
      });

      vi.spyOn(getClient(adapter).conversations, "list").mockResolvedValue(
        createConversationListResponse([conversation]),
      );
      vi.spyOn(getClient(adapter).contacts, "get").mockResolvedValue(contact);

      const result = await adapter.fetchThread("kapso:123456789:15551234567");

      expect(result.channelName).toBe("WhatsApp: Conversation Contact");
      expect(result.metadata).toMatchObject({
        phoneNumberId: "123456789",
        userWaId: "15551234567",
        contactName: "Conversation Contact",
        contactId: "contact_999",
        conversationId: "conv_999",
        contact,
        conversation,
      });
    });
  });

  describe("unimplemented methods", () => {
    it("throws an explicit error for editMessage", async () => {
      const adapter = createTestAdapter();

      await expect(
        adapter.editMessage("kapso:123456789:15551234567", "wamid.123", "hello"),
      ).rejects.toThrow(
        "Kapso/WhatsApp does not support editing messages. Use postMessage() instead.",
      );
    });

    it("throws an explicit error for deleteMessage", async () => {
      const adapter = createTestAdapter();

      await expect(
        adapter.deleteMessage("kapso:123456789:15551234567", "wamid.123"),
      ).rejects.toThrow("Kapso/WhatsApp does not support deleting messages.");
    });
  });

  describe("read receipts and typing", () => {
    it("marks inbound messages as read via the Kapso SDK", async () => {
      const adapter = createTestAdapter();
      const markRead = vi
        .spyOn(getClient(adapter).messages, "markRead")
        .mockResolvedValue({ success: true });

      await adapter.markAsRead("wamid.123");

      expect(markRead).toHaveBeenCalledOnce();
      expect(markRead).toHaveBeenCalledWith({
        phoneNumberId: "123456789",
        messageId: "wamid.123",
      });
    });

    it("treats startTyping as a no-op instead of guessing", async () => {
      const adapter = createTestAdapter();
      const markRead = vi
        .spyOn(getClient(adapter).messages, "markRead")
        .mockResolvedValue({ success: true });

      await expect(
        adapter.startTyping("kapso:123456789:15551234567", "drafting"),
      ).resolves.toBeUndefined();
      expect(markRead).not.toHaveBeenCalled();
    });
  });
});
