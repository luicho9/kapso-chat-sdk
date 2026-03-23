import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { Chat, type AiMessage, type Message } from "chat";
import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import { createKapsoAdapter } from "@luicho/kapso-chat-sdk";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

// Load .env manually (no dotenv dep)
try {
  const env = readFileSync(".env", "utf-8");
  for (const line of env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // no .env file — rely on env vars
}

const chat = new Chat({
  userName: "AI Reply",
  adapters: { kapso: createKapsoAdapter() },
  state: new MemoryStateAdapter(),
});

function buildHistoryText(message: Message): string {
  const text = message.text.trim();
  const linkText = message.links
    .map((link) => {
      const parts = [link.url];
      if (link.title) {
        parts.push(`Title: ${link.title}`);
      }
      if (link.description) {
        parts.push(`Description: ${link.description}`);
      }
      return parts.join("\n");
    })
    .join("\n\n");
  const attachmentText = message.attachments
    .map((attachment) => {
      switch (attachment.type) {
        case "image":
          return attachment.name
            ? `[Image attachment: ${attachment.name}]`
            : "[Image attachment]";
        case "video":
          return attachment.name
            ? `[Video attachment: ${attachment.name}]`
            : "[Video attachment]";
        case "audio":
          return attachment.name
            ? `[Audio attachment: ${attachment.name}]`
            : "[Audio attachment]";
        case "file":
          return attachment.name
            ? `[File attachment: ${attachment.name}]`
            : "[File attachment]";
        default:
          return "[Attachment]";
      }
    })
    .join("\n");

  return [text, linkText ? `Links:\n${linkText}` : "", attachmentText]
    .filter(Boolean)
    .join("\n\n");
}

// We intentionally do not use Chat SDK's toAiMessages() here.
// Kapso/WhatsApp history can include attachments, and toAiMessages() eagerly
// inlines supported attachments as data: URLs. In AI SDK 6, that follow-up
// history path causes AI_DownloadError because the downloader only accepts
// http(s) URLs for remote assets.
function toPlainTextAiMessages(messages: Message[]): AiMessage[] {
  return [...messages]
    .sort(
      (a, b) =>
        (a.metadata.dateSent?.getTime() ?? 0) -
        (b.metadata.dateSent?.getTime() ?? 0),
    )
    .reduce<AiMessage[]>((history, message) => {
      const content = buildHistoryText(message);
      if (!content) {
        return history;
      }

      history.push(
        message.author.isMe
          ? { role: "assistant", content }
          : { role: "user", content },
      );

      return history;
    }, []);
}

// First message - subscribe and stream an AI reply
chat.onNewMention(async (thread, message) => {
  console.log(`[mention] from=${message.author.userId} text="${message.text}"`);
  await thread.subscribe();

  const result = streamText({
    model: openai("gpt-5.3-chat-latest"),
    system: "You are a helpful WhatsApp assistant. Keep replies concise.",
    prompt: message.text ?? "",
  });

  await thread.post(result.textStream);
});

// Follow-up messages - include conversation history
chat.onSubscribedMessage(async (thread, message) => {
  console.log(
    `[follow-up] from=${message.author.userId} text="${message.text}"`,
  );

  const fetched = await thread.adapter.fetchMessages(thread.id, { limit: 20 });
  const history = toPlainTextAiMessages(fetched.messages);

  const result = streamText({
    model: openai("gpt-5.3-chat-latest"),
    system: "You are a helpful WhatsApp assistant. Keep replies concise.",
    messages: history,
  });

  await thread.post(result.textStream);
});

const port = Number(process.env.PORT) || 3000;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

function toWebRequest(req: IncomingMessage, body: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  return new Request(`http://localhost:${port}${req.url}`, {
    method: "POST",
    headers,
    body,
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("kapso ai-reply example is running");
    return;
  }

  if (req.method === "POST" && req.url === "/webhooks/whatsapp") {
    try {
      const body = await readBody(req);
      const webRequest = toWebRequest(req, body);
      const result = await chat.webhooks.kapso(webRequest);
      const resultBody = await result.text();
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.status === 200, body: resultBody }));
    } catch (err) {
      console.error("[webhook error]", (err as Error).stack || err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
  console.log(`Webhook URL: http://localhost:${port}/webhooks/whatsapp`);
  console.log(`For local testing, expose this port with: ngrok http ${port}`);
});
