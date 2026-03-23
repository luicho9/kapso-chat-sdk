import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { Chat, Card, Button, Actions } from "chat";
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

const menuCard = Card({
  title: "How can we help?",
  children: [
    Actions([
      Button({ id: "order_status", label: "Order status" }),
      Button({ id: "track_shipment", label: "Track shipment" }),
      Button({ id: "human_agent", label: "Talk to a human" }),
    ]),
  ],
});

const chat = new Chat({
  userName: "Interactive Menu",
  adapters: { kapso: createKapsoAdapter() },
  state: new MemoryStateAdapter(),
});

// First message - send the interactive menu
chat.onNewMention(async (thread, message) => {
  console.log(`[message] from=${message.author.userId}`);
  await thread.post({
    card: menuCard,
    fallbackText:
      "How can we help? Reply with: 1) Order status  2) Track shipment  3) Talk to a human",
  });
});

// Button tap handlers
chat.onAction("order_status", async (event) => {
  console.log(`[action] order_status from=${event.user.userId}`);
  await event.thread?.post(
    "Your last order is being prepared. Expected delivery: 2-3 business days.",
  );
});

chat.onAction("track_shipment", async (event) => {
  console.log(`[action] track_shipment from=${event.user.userId}`);
  await event.thread?.post(
    "Your shipment is on the way! Track it at: https://track.example.com",
  );
});

chat.onAction("human_agent", async (event) => {
  console.log(`[action] human_agent from=${event.user.userId}`);
  await event.thread?.post(
    "Connecting you to a support agent. Average wait time: 2 minutes.",
  );
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
    res.end("kapso interactive-menu example is running");
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
