import type { Attachment } from "chat";
import type { KapsoMessage, KapsoRawMessage } from "./types.js";
import { isRecord, readNumber, readString, readValue } from "./value-readers.js";

export interface KapsoReactionEventData {
  added: boolean;
  messageId: string;
  rawEmoji: string;
}

export function parseUnixTimestamp(value: unknown): Date {
  const seconds = readNumber(value);
  return seconds === undefined ? new Date(0) : new Date(seconds * 1000);
}

export function resolveSenderId(raw: KapsoRawMessage): string {
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

export function extractReactionEvent(
  message: KapsoMessage,
): KapsoReactionEventData | null {
  if (message.type !== "reaction") {
    return null;
  }

  const reaction = message.reaction;
  if (!reaction) {
    return null;
  }

  const messageId = reaction.messageId ?? reaction.message_id;
  if (typeof messageId !== "string" || messageId.length === 0) {
    return null;
  }

  const rawEmoji = typeof reaction.emoji === "string" ? reaction.emoji : "";

  return {
    added: rawEmoji !== "",
    messageId,
    rawEmoji,
  };
}

export function extractMessageText(message: KapsoMessage): string {
  const type = message.type || "message";
  const kapso = message.kapso;
  const mediaData = kapso?.mediaData ?? kapso?.media_data;
  const messageTypeData = kapso?.messageTypeData ?? kapso?.message_type_data;
  const transcript = kapso?.transcript;
  const kapsoContent = extractKapsoContent(kapso);
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
      return caption ?? kapsoContent ?? buildMediaFallback("Image", filename);
    case "video":
      return caption ?? kapsoContent ?? buildMediaFallback("Video", filename);
    case "document":
      return caption ?? kapsoContent ?? buildMediaFallback("Document", filename);
    case "audio":
      return (
        transcriptText ?? kapsoContent ?? buildMediaFallback("Audio", filename)
      );
    case "sticker":
      return kapsoContent ?? buildMediaFallback("Sticker", filename);
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

export function buildAttachments(message: KapsoMessage): Attachment[] {
  const type = message.type;
  const kapso = message.kapso;
  const mediaData = kapso?.mediaData ?? kapso?.media_data;
  const mediaUrl = kapso?.mediaUrl ?? kapso?.media_url ?? mediaData?.url;
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

function extractKapsoContent(kapso: KapsoMessage["kapso"]): string | undefined {
  const content = kapso?.content;
  if (typeof content === "string" && content.length > 0) {
    return content;
  }

  if (isRecord(content)) {
    return readString(readValue(content, "text", "body", "value"));
  }

  return undefined;
}

function buildMediaFallback(label: string, filename: string | undefined): string {
  return filename ? `[${label}: ${filename}]` : `[${label}]`;
}
