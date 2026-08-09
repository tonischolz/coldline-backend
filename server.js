import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { runConversationTurn } from "./lib/claude.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors()); // fine for a prototype - lock this down to your real domain before going live
app.use(express.json());

// --- Client config loading -------------------------------------------------
// Each file in /clients is one business. Add a new .json file per client -
// nothing else in this server needs to change to onboard a new business.
const clientsDir = path.join(__dirname, "clients");
const clientConfigs = {};
for (const file of fs.readdirSync(clientsDir)) {
  if (file.endsWith(".json")) {
    const config = JSON.parse(fs.readFileSync(path.join(clientsDir, file), "utf-8"));
    clientConfigs[config.clientId] = config;
  }
}

// --- Conversation state ------------------------------------------------
// In-memory session store, keyed by a session id the widget generates.
// Fine for a prototype; for production, move this to Redis or your DB
// so it survives server restarts and works across multiple server instances.
const sessions = {};

// --- Routes -----------------------------------------------------------

app.get("/health", (req, res) => res.json({ ok: true }));

// Widget calls this once on load to get a session id.
app.post("/session/:clientId", (req, res) => {
  const { clientId } = req.params;
  if (!clientConfigs[clientId]) {
    return res.status(404).json({ error: `Unknown client: ${clientId}` });
  }
  const sessionId = randomUUID();
  sessions[sessionId] = { clientId, conversation: [] };
  res.json({ sessionId });
});

// Widget calls this for every message the customer sends.
app.post("/chat/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { message } = req.body;

  const session = sessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: "Session not found - call /session/:clientId first" });
  }

  const clientConfig = clientConfigs[session.clientId];
  session.conversation.push({ role: "user", content: message });

  try {
    const { reply, updatedConversation } = await runConversationTurn(session.conversation, clientConfig);
    session.conversation = updatedConversation;
    res.json({ reply });
  } catch (err) {
    console.error("Claude call failed:", err);
    res.status(500).json({ error: "Something went wrong - please try again." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`Loaded clients: ${Object.keys(clientConfigs).join(", ")}`);
});
