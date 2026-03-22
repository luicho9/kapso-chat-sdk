import { describe, expect, it } from "vitest";
import {
  buildAttachments,
  extractReactionEvent,
  extractMessageText,
  parseUnixTimestamp,
  resolveSenderId,
} from "../src/message-parser.js";
import type { KapsoMessage, KapsoRawMessage } from "../src/types.js";
import {
  createImageRawMessage,
  createTextRawMessage,
} from "./kapso-test-helpers.js";

describe("message-parser", () => {
  describe("parseUnixTimestamp", () => {
    it("parses numeric strings", () => {
      expect(parseUnixTimestamp("1730092800")).toEqual(
        new Date(1730092800 * 1000),
      );
    });

    it("falls back to epoch for invalid values", () => {
      expect(parseUnixTimestamp("nope")).toEqual(new Date(0));
    });
  });

  describe("resolveSenderId", () => {
    it("prefers message.from when present", () => {
      expect(resolveSenderId(createTextRawMessage())).toBe("15551234567");
    });

    it("uses phoneNumberId for outbound messages without from", () => {
      const raw: KapsoRawMessage = {
        phoneNumberId: "123456789",
        userWaId: "15551234567",
        message: {
          id: "wamid.outbound",
          timestamp: "1730092800",
          type: "text",
          kapso: {
            direction: "outbound",
          },
        },
      };

      expect(resolveSenderId(raw)).toBe("123456789");
    });

    it("falls back to userWaId for inbound messages without from", () => {
      const raw: KapsoRawMessage = {
        phoneNumberId: "123456789",
        userWaId: "15551234567",
        message: {
          id: "wamid.inbound",
          timestamp: "1730092800",
          type: "text",
          kapso: {
            direction: "inbound",
          },
        },
      };

      expect(resolveSenderId(raw)).toBe("15551234567");
    });
  });

  describe("extractMessageText", () => {
    it("returns text message bodies", () => {
      expect(extractMessageText(createTextRawMessage().message)).toBe(
        "Hello *Kapso*",
      );
    });

    it("uses media fallback for images", () => {
      expect(extractMessageText(createImageRawMessage().message)).toBe(
        "[Image: photo.jpg]",
      );
    });

    it("uses transcript text for audio messages", () => {
      const message: KapsoMessage = {
        id: "wamid.audio",
        timestamp: "1730092800",
        type: "audio",
        kapso: {
          transcript: {
            text: "Voice transcript",
          },
        },
      };

      expect(extractMessageText(message)).toBe("Voice transcript");
    });

    it("formats locations", () => {
      const message: KapsoMessage = {
        id: "wamid.location",
        timestamp: "1730092800",
        type: "location",
        location: {
          latitude: 14.0723,
          longitude: -87.1921,
          name: "Tegucigalpa",
          address: "HN",
        },
      };

      expect(extractMessageText(message)).toBe("[Location: Tegucigalpa - HN]");
    });

    it("uses Kapso content for reactions", () => {
      const message: KapsoMessage = {
        id: "wamid.reaction",
        timestamp: "1730092800",
        type: "reaction",
        reaction: {
          emoji: "🔥",
        },
      };

      expect(extractMessageText(message)).toBe("[Reaction: 🔥]");
    });

    it("reads text content from object-shaped Kapso content", () => {
      const message: KapsoMessage = {
        id: "wamid.unknown",
        timestamp: "1730092800",
        type: "unknown",
        kapso: {
          content: {
            text: "From content object",
          },
        },
      };

      expect(extractMessageText(message)).toBe("From content object");
    });
  });

  describe("extractReactionEvent", () => {
    it("normalizes webhook reaction payloads with snake_case message_id", () => {
      const message: KapsoMessage = {
        id: "wamid.reaction",
        timestamp: "1730092800",
        type: "reaction",
        reaction: {
          message_id: "wamid.original",
          emoji: "",
        },
      };

      expect(extractReactionEvent(message)).toEqual({
        added: false,
        messageId: "wamid.original",
        rawEmoji: "",
      });
    });
  });

  describe("buildAttachments", () => {
    it("builds image attachments from Kapso media URLs", () => {
      expect(buildAttachments(createImageRawMessage().message)).toEqual([
        {
          type: "image",
          url: "https://api.kapso.ai/media/photo.jpg",
          mimeType: "image/jpeg",
          name: "photo.jpg",
          size: 204800,
        },
      ]);
    });

    it("builds document attachments", () => {
      const message: KapsoMessage = {
        id: "wamid.document",
        timestamp: "1730092800",
        type: "document",
        document: {
          filename: "invoice.pdf",
        },
        kapso: {
          media_url: "https://api.kapso.ai/media/invoice.pdf",
          media_data: {
            url: "https://api.kapso.ai/media/invoice.pdf",
            filename: "invoice.pdf",
            content_type: "application/pdf",
            byte_size: 1024,
          },
        },
      };

      expect(buildAttachments(message)).toEqual([
        {
          type: "file",
          url: "https://api.kapso.ai/media/invoice.pdf",
          mimeType: "application/pdf",
          name: "invoice.pdf",
          size: 1024,
        },
      ]);
    });

    it("builds location map attachments", () => {
      const message: KapsoMessage = {
        id: "wamid.location",
        timestamp: "1730092800",
        type: "location",
        location: {
          latitude: 14.0723,
          longitude: -87.1921,
          name: "Tegucigalpa",
        },
      };

      expect(buildAttachments(message)).toEqual([
        {
          type: "file",
          name: "Tegucigalpa",
          url: "https://www.google.com/maps?q=14.0723,-87.1921",
          mimeType: "application/geo+json",
        },
      ]);
    });

    it("returns no attachments for plain text", () => {
      expect(buildAttachments(createTextRawMessage().message)).toEqual([]);
    });
  });
});
