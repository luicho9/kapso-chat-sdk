# @kapso/chat-sdk-adapter

[![npm version](https://img.shields.io/npm/v/%40kapso%2Fchat-sdk-adapter)](https://www.npmjs.com/package/@kapso/chat-sdk-adapter)
[![npm downloads](https://img.shields.io/npm/dm/%40kapso%2Fchat-sdk-adapter)](https://www.npmjs.com/package/@kapso/chat-sdk-adapter)

WhatsApp adapter for [Chat SDK](https://chat-sdk.dev/docs) via Kapso, using Kapso webhook payloads and history APIs.

## Installation

```bash
pnpm add @kapso/chat-sdk-adapter chat
```

## Usage

```typescript
import { Chat } from "chat";
import { createKapsoAdapter } from "@kapso/chat-sdk-adapter";

export const bot = new Chat({
  userName: "My Bot",
  adapters: {
    kapso: createKapsoAdapter(),
  },
});

bot.onDirectMessage(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`You said: ${message.text}`);
});
```

When using `createKapsoAdapter()` without arguments, credentials are auto-detected from environment variables.

WhatsApp conversations via Kapso are always 1:1 DMs. `onDirectMessage` is usually the clearest entry point. If you do not register any `onDirectMessage` handlers, DM messages fall through to [`onNewMention`](https://chat-sdk.dev/docs/handling-events) for backward compatibility. See the [Chat SDK adapters docs](https://chat-sdk.dev/docs/adapters) and [direct messages guide](https://chat-sdk.dev/docs/direct-messages) for broader integration patterns.

## Environment variables

| Variable                | Required | Example                              | Description                                                                                        |
| ----------------------- | -------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `KAPSO_API_KEY`         | Yes      | `kap_live_abc123`                    | Kapso project API key used for outbound sends, history queries, and thread enrichment.             |
| `KAPSO_PHONE_NUMBER_ID` | Yes      | `123456789`                          | WhatsApp phone number ID connected in Kapso. Used for sends, history lookups, and thread IDs.      |
| `KAPSO_WEBHOOK_SECRET`  | Yes      | `whsec_abc123`                       | Shared secret used to verify the `X-Webhook-Signature` header on Kapso webhook deliveries.         |
| `KAPSO_BASE_URL`        | No       | `https://api.kapso.ai/meta/whatsapp` | Override the Kapso proxy base URL. Leave unset unless Kapso tells you to use a different base URL. |
| `KAPSO_BOT_USERNAME`    | No       | `support-bot`                        | Override the bot display name used by Chat SDK for bot-authored messages. Defaults to `kapso-bot`. |

## Configuration reference

All configuration can be provided explicitly or via environment variables.

| Option          | Type     | Default                              | Description                                                 |
| --------------- | -------- | ------------------------------------ | ----------------------------------------------------------- |
| `kapsoApiKey`   | `string` | `KAPSO_API_KEY`                      | Kapso API key used by the Kapso proxy client.               |
| `phoneNumberId` | `string` | `KAPSO_PHONE_NUMBER_ID`              | WhatsApp phone number ID that owns the conversation.        |
| `webhookSecret` | `string` | `KAPSO_WEBHOOK_SECRET`               | Secret used to verify Kapso webhook signatures.             |
| `baseUrl`       | `string` | `https://api.kapso.ai/meta/whatsapp` | Kapso proxy base URL for outbound messaging and query APIs. |
| `userName`      | `string` | `KAPSO_BOT_USERNAME` or `kapso-bot`  | Bot display name used by Chat SDK for self-message display. |

## Kapso platform setup

### 1. Connect a number

1. Open the [Kapso Dashboard](https://app.kapso.ai/users/sign_in).
2. Click `Add number`.
3. On `Connect number to WhatsApp`, choose `Instant setup with US digital number` if you want the fastest Kapso-managed path.
4. Finish the setup flow for the new number.

### 2. Get credentials

1. Go to `Phone numbers -> Connected numbers`, open the connected number, and copy its `Phone Number ID`. Use that value as `KAPSO_PHONE_NUMBER_ID`.
2. Go to `API keys`, click `Create API Key`, and copy the API key. Set it as `KAPSO_API_KEY`.
3. Generate a strong random secret, set it as `KAPSO_WEBHOOK_SECRET`, and use the same value as the webhook `secret_key`.

### 3. Add the webhook route

Add a public HTTPS POST webhook route that forwards the raw `Request` to Chat SDK and returns quickly:

```typescript
import { bot } from "@/lib/bot";

export async function POST(request: Request) {
  return bot.webhooks.kapso(request);
}
```

Expose that route at a public HTTPS URL such as `https://your-app.com/webhooks/whatsapp`.

### 4. Create the WhatsApp webhook

You can create the webhook in either of these ways.

#### Via dashboard

1. Go to `Webhooks`.
2. Stay on the `WhatsApp webhooks` tab.
3. Expand the connected number you want to use.
4. Click `Add Webhook`.
5. Set `Endpoint URL` to your public HTTPS route, for example `https://your-app.com/webhooks/whatsapp`.
6. In `Advanced settings`, set the webhook `secret_key` to the same value you stored in `KAPSO_WEBHOOK_SECRET`.
7. In `Events`, enable `Message received` and `Message sent`.

#### Via API

Create the same webhook via the Kapso API:

```bash
curl --request POST \
  --url "https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/$KAPSO_PHONE_NUMBER_ID/webhooks" \
  --header "Content-Type: application/json" \
  --header "X-API-Key: $KAPSO_API_KEY" \
  --data '{
    "whatsapp_webhook": {
      "url": "https://your-app.com/webhooks/whatsapp",
      "events": ["whatsapp.message.received", "whatsapp.message.sent"],
      "secret_key": "your-webhook-secret"
    }
  }'
```

### 5. Local testing and delivery notes

- For local testing, expose your app with an HTTPS tunnel such as ngrok or Cloudflare Tunnel, then register that URL in the webhook configuration.
- If you enable buffering for `whatsapp.message.received`, the adapter handles both immediate single-event deliveries and buffered batched payloads automatically.
- Kapso expects your endpoint to return `200 OK` within 10 seconds. The adapter already verifies `X-Webhook-Signature` and handles `X-Idempotency-Key` dedupe hooks for Kapso deliveries.

Relevant Kapso docs:

- [Webhook overview](https://docs.kapso.ai/docs/platform/webhooks/overview)
- [Webhook security](https://docs.kapso.ai/docs/platform/webhooks/security)
- [TypeScript SDK introduction](https://docs.kapso.ai/docs/whatsapp/typescript-sdk/introduction)
- [Messages API](https://docs.kapso.ai/docs/whatsapp/typescript-sdk/messages)
- [Conversations API](https://docs.kapso.ai/docs/whatsapp/typescript-sdk/conversations)
- [Contacts API](https://docs.kapso.ai/docs/whatsapp/typescript-sdk/contacts)

## Features and limitations

### Messaging

| Feature | Supported | Notes |
| ------- | --------- | ----- |
| Outbound text messages | Yes | `postMessage()` sends plain text through Kapso and automatically splits messages over 4096 characters at paragraph or line boundaries when possible. |
| Buffered streaming | Yes | `stream()` buffers `string` and `markdown_text` chunks, ignores non-text stream chunks, and sends one final message through `postMessage()`. It does not attempt incremental edits because WhatsApp does not support them. |
| Outbound cards | Limited | Cards with up to 3 action buttons are sent as WhatsApp interactive reply buttons. Button titles are truncated to 20 characters, and unsupported cards fall back to text. |
| Reactions | Yes | `addReaction()` and `removeReaction()` send WhatsApp reactions through Kapso. Removing a reaction sends an empty emoji string. |
| Mark messages as read | Yes | `markAsRead()` delegates to the Kapso SDK `messages.markRead()` helper. |
| Message edit | No | Platform limitation. `editMessage()` throws because this integration does not support editing previously sent messages. |
| Message delete | No | Platform limitation. `deleteMessage()` throws because this integration does not support deleting previously sent messages. |
| Attachments, files, and other richer outbound message types | No | Adapter limitation. Attachments, files, media sends, templates, and other richer outbound message types are not implemented in this adapter yet. |
| Typing indicator | No | No standalone adapter-level typing API is exposed here. `startTyping()` is an intentional parity no-op instead of guessing. |

### Inbound webhooks

| Feature | Supported | Notes |
| ------- | --------- | ----- |
| `whatsapp.message.received` handling | Yes | `handleWebhook()` verifies `X-Webhook-Signature`, accepts POST requests only, and processes Kapso webhook payloads into Chat SDK messages. |
| Buffered Kapso deliveries | Yes | Batched deliveries with `batch: true` and `X-Webhook-Batch: true` are expanded and processed one message at a time. |
| Inbound text messages | Yes | Text bodies are surfaced as Chat SDK message text. |
| Inbound media messages | Yes | Supported Kapso media payloads are converted into Chat SDK attachments plus readable fallback text. |
| Inbound reaction messages | Yes | Live webhook reactions call `chat.processReaction(...)`, so `bot.onReaction(...)` fires. Empty `reaction.emoji` values are treated as reaction removal. |
| Inbound interactive replies and button callbacks | Yes | Live interactive replies call `chat.processAction(...)`, so `bot.onAction(...)` fires instead of treating the reply as a plain message. |
| Other Kapso webhook events | Ignored | The adapter acknowledges unsupported event types with `200 OK`, but only `whatsapp.message.received` is processed. |

### History and thread info

| Feature                  | Supported | Notes                                                                                                                |
| ------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------- |
| Message history fetching | Yes       | `fetchMessages()` reads stored conversation history from Kapso and returns Chat SDK messages in chronological order. |
| Historical reaction events | Limited | Reactions returned by `fetchMessages()` are still surfaced as fallback messages like `[Reaction: 👍]`; only live webhooks emit Chat SDK reaction events. |
| Thread enrichment        | Yes       | `fetchThread()` enriches metadata with Kapso conversation and contact records when available.                        |
| DMs                      | Yes       | All conversations are 1:1 DMs. `isDM()` always returns `true`.                                                       |

## Thread ID format

```text
kapso:{phoneNumberId}:{userWaId}
```

Example:

```text
kapso:123456789:15551234567
```

`phoneNumberId` is the receiving business phone number ID in Kapso. `userWaId` is the customer's WhatsApp ID normalized to digits.

## Troubleshooting

### `401 Invalid signature`

- Confirm `KAPSO_WEBHOOK_SECRET` exactly matches the webhook `secret_key` configured in Kapso.
- Make sure your route passes the raw `Request` to `bot.webhooks.kapso` so signature verification uses the original request body.

### Messages are not arriving

- Confirm the webhook is registered for the same `KAPSO_PHONE_NUMBER_ID` your adapter uses.
- Confirm the webhook is subscribed to `whatsapp.message.received`.
- Make sure Kapso can reach your route over HTTPS and that the route returns `200 OK` quickly.

### You are receiving batched payloads

- This is expected when Kapso buffering is enabled for `whatsapp.message.received`.
- The adapter already supports batched bodies with `batch: true` and `data: [...]`; no code change is required.

### `fetchMessages()` returns no messages or `fetchThread()` has limited metadata

- History and enrichment depend on Kapso having matching conversation and contact records for the same phone number and WhatsApp user.
- If no Kapso conversation is found, `fetchMessages()` returns an empty list.
- If no Kapso contact or conversation is found, `fetchThread()` falls back to the decoded thread ID and user WA ID.

### Card or rich message behavior

- Supported cards are sent as WhatsApp reply buttons when they fit the platform limits.
- Unsupported cards fall back to readable text automatically.
- Attachments, files, and other richer outbound message types still reject. If you need them today, use `@kapso/whatsapp-cloud-api` directly alongside Chat SDK.

## License

MIT
