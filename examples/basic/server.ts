import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { Chat } from "chat";
import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import { createKapsoAdapter } from "@luicho/kapso-chat-sdk";

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
  // no .env file - rely on env vars
}

const chat = new Chat({
  userName: "Basic",
  adapters: { kapso: createKapsoAdapter() },
  state: new MemoryStateAdapter(),
});

// Every inbound WhatsApp message - echo it back
chat.onNewMention(async (thread, message) => {
  console.log(`[message] from=${message.author.userId} text="${message.text}"`);
  await thread.post(`You said: ${message.text}`);
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
    res.end("kapso basic example is running");
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
