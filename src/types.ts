/**
 * Type definitions for the Kapso adapter.
 *
 * Uses types from @kapso/whatsapp-cloud-api wherever possible.
 * Defines adapter-specific configuration, thread identity, and shared
 * message shapes used by the Kapso Chat SDK adapter.
 */

import type {
  KapsoMessageExtensions as BaseKapsoMessageExtensions,
  MediaData as BaseMediaData,
  UnifiedMessage,
} from "@kapso/whatsapp-cloud-api";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for the Kapso Chat SDK adapter.
 *
 * This adapter is Kapso-first:
 * - Outbound messages and history queries go through the Kapso proxy
 * - Inbound webhook verification uses Kapso webhook signatures
 */
export interface KapsoAdapterConfig {
  /** Kapso proxy base URL. Defaults to https://api.kapso.ai/meta/whatsapp */
  baseUrl?: string;
  /** Kapso API key. Falls back to KAPSO_API_KEY env var. */
  kapsoApiKey?: string;
  /** WhatsApp phone number ID used for send/query operations. Falls back to KAPSO_PHONE_NUMBER_ID env var. */
  phoneNumberId?: string;
  /** Bot display name. Defaults to "kapso-bot". */
  userName?: string;
  /** Shared secret used to verify Kapso webhook signatures. Must match the webhook `secret_key` configured in Kapso Dashboard. */
  webhookSecret?: string;
}

// =============================================================================
// Thread ID
// =============================================================================

/**
 * Decoded thread ID for WhatsApp via Kapso.
 *
 * WhatsApp conversations are always 1:1 between a business phone number and a user.
 * There is no concept of threads or channels.
 *
 * Format: kapso:{phoneNumberId}:{userWaId}
 */
export interface KapsoThreadId {
  /** Whatsapp Business phone number ID */
  phoneNumberId: string;
  /** User's WhatsApp ID (their phone number) */
  userWaId: string;
}

/** Kapso media metadata as returned by webhook `message.kapso.media_data`. */
export type KapsoMediaData = BaseMediaData & {
  /** Snake-case alias used in webhook payloads. */
  content_type?: string;
  /** Snake-case alias used in webhook payloads. */
  byte_size?: number;
};

/** Kapso reaction payload supporting both SDK and webhook casing. */
export type KapsoReaction = NonNullable<UnifiedMessage["reaction"]> & {
  /** Snake-case reacted-to message ID as delivered by webhooks. */
  message_id?: string;
};

/**
 * Kapso webhook extensions for a WhatsApp message.
 *
 * Kapso webhook payloads use snake_case fields and may return `content` as a
 * string summary even though the SDK query types model it more narrowly.
 */
export type KapsoMessageExtensions = Omit<
  BaseKapsoMessageExtensions,
  | "content"
  | "contactName"
  | "flowName"
  | "flowResponse"
  | "flowToken"
  | "hasMedia"
  | "mediaData"
  | "mediaUrl"
  | "messageTypeData"
  | "orderText"
  | "phoneNumber"
  | "processingStatus"
  | "whatsappConversationId"
> & {
  /** Text summary Kapso includes in webhook payloads. */
  content?: string | Record<string, unknown>;
  /** Camel-case contact name, used by SDK query responses. */
  contactName?: string;
  /** Snake-case contact name, used by webhooks. */
  contact_name?: string;
  /** Camel-case flow name. */
  flowName?: string;
  /** Snake-case flow name. */
  flow_name?: string;
  /** Camel-case flow response payload. */
  flowResponse?: Record<string, unknown>;
  /** Snake-case flow response payload. */
  flow_response?: Record<string, unknown>;
  /** Camel-case flow token. */
  flowToken?: string;
  /** Snake-case flow token. */
  flow_token?: string;
  /** Camel-case media flag. */
  hasMedia?: boolean;
  /** Snake-case media flag. */
  has_media?: boolean;
  /** Camel-case media metadata. */
  mediaData?: KapsoMediaData;
  /** Snake-case media metadata. */
  media_data?: KapsoMediaData;
  /** Camel-case media URL. */
  mediaUrl?: string;
  /** Snake-case media URL. */
  media_url?: string;
  /** Camel-case type-specific payload. */
  messageTypeData?: Record<string, unknown>;
  /** Snake-case type-specific payload. */
  message_type_data?: Record<string, unknown>;
  /** Camel-case order summary. */
  orderText?: string;
  /** Snake-case order summary. */
  order_text?: string;
  /** Camel-case phone number. */
  phoneNumber?: string;
  /** Snake-case phone number. */
  phone_number?: string;
  /** Camel-case processing status. */
  processingStatus?: string;
  /** Snake-case processing status. */
  processing_status?: string;
  /** Kapso audio transcription payload. */
  transcript?: {
    text?: string;
    body?: string;
    [key: string]: unknown;
  };
  /** Camel-case conversation ID. */
  whatsappConversationId?: string;
  /** Snake-case conversation ID. */
  whatsapp_conversation_id?: string;
};

/** Normalized WhatsApp message shape used across webhooks and history APIs. */
export type KapsoMessage = Pick<
  UnifiedMessage,
  | "audio"
  | "contacts"
  | "context"
  | "document"
  | "from"
  | "id"
  | "image"
  | "interactive"
  | "location"
  | "order"
  | "sticker"
  | "template"
  | "text"
  | "timestamp"
  | "to"
  | "type"
  | "video"
> & {
  reaction?: KapsoReaction;
  kapso?: KapsoMessageExtensions;
  [key: string]: unknown;
};

/** Kapso webhook conversation metadata for inbound message events. */
export interface KapsoWebhookConversation {
  /** Conversation record ID in Kapso. */
  id?: string;
  /** Snake-case phone number as delivered by Kapso webhooks. */
  phone_number?: string;
  /** Camel-case phone number when normalized by callers. */
  phoneNumber?: string;
  /** Snake-case phone number ID as delivered by Kapso webhooks. */
  phone_number_id?: string;
  /** Camel-case phone number ID when normalized by callers. */
  phoneNumberId?: string;
  /** Conversation status. */
  status?: string;
  /** Kapso conversation enrichments. */
  kapso?: {
    /** Contact display name in camel case. */
    contactName?: string;
    /** Contact display name in snake case. */
    contact_name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Kapso webhook event for `whatsapp.message.received`. */
export interface KapsoWebhookMessageReceivedEvent {
  /** Event name when present in the payload body. */
  event?: string;
  /** Inbound WhatsApp message payload. */
  message: KapsoMessage;
  /** Associated Kapso conversation metadata. */
  conversation?: KapsoWebhookConversation;
  /** Snake-case phone number ID as delivered by Kapso webhooks. */
  phone_number_id?: string;
  /** Camel-case phone number ID when normalized by callers. */
  phoneNumberId?: string;
  /** Whether the webhook opened a brand new conversation. */
  is_new_conversation?: boolean;
  [key: string]: unknown;
}

/** Kapso buffered webhook payload containing multiple message events. */
export interface KapsoWebhookBatchPayload {
  /** Kapso sets this when batching/buffering deliveries. */
  batch?: boolean;
  /** Buffered event list. */
  data: KapsoWebhookMessageReceivedEvent[];
  [key: string]: unknown;
}

/**
 * Platform-specific raw message stored in Chat `message.raw`.
 *
 * Keeps the receiving business phone number alongside the normalized
 * WhatsApp message returned by the Kapso SDK.
 */
export interface KapsoRawMessage {
  /** WhatsApp phone number ID that owns the conversation. */
  phoneNumberId: string;
  /** User's WhatsApp ID for the conversation thread. */
  userWaId: string;
  /** Normalized WhatsApp message. */
  message: KapsoMessage;
  /** Optional display name resolved from webhook contacts. */
  contactName?: string;
}
