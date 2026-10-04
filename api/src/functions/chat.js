import { app } from "@azure/functions";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { TableClient } from "@azure/data-tables";

const DAILY_LIMIT = 3;
let usageReady = false;

function getUser(req) {
  const h = req.headers.get("x-ms-client-principal");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

async function countMessage(username) {
  const client = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, "usage");
  if (!usageReady) {
    try { await client.createTable(); } catch {}
    usageReady = true;
  }
  const pk = String(username).toLowerCase().replace(/[^a-z0-9]/g, "_");
  const day = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  let count = 0;
  try {
    const e = await client.getEntity(pk, day);
    count = Number(e.count) || 0;
  } catch {}
  if (count >= DAILY_LIMIT) return false;
  await client.upsertEntity({ partitionKey: pk, rowKey: day, count: count + 1 }, "Replace");
  return true;
}

app.http("chat", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    const user = getUser(req);
    const allowed = (process.env.ALLOWED_USERS || "")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!user || !allowed.includes(String(user.userDetails).toLowerCase())) {
      return { status: 403, jsonBody: { error: "Not allowed" } };
    }
    try {
      const ok = await countMessage(user.userDetails);
      if (!ok) {
        return { status: 429, jsonBody: { error: "Limit reached, try tomorrow" } };
      }
    } catch (e) {
      ctx.error(e);
    }
    try {
      let body = {};
      try { body = await req.json(); } catch {}
      const message = body.message || "Hello";
      const previousResponseId = body.previousResponseId;
      const files = Array.isArray(body.attachments) ? body.attachments : [];

      let input = message;
      if (files.length) {
        const content = [{ type: "input_text", text: message }];
        for (const f of files) {
          if (String(f.type).startsWith("image/"))
            content.push({ type: "input_image", image_url: f.data });
          else
            content.push({ type: "input_file", filename: f.name, file_data: f.data });
        }
        input = [{ role: "user", content }];
      }

      const project = new AIProjectClient(process.env.PROJECT_ENDPOINT, new DefaultAzureCredential());
      const openai = project.getOpenAIClient();
      const res = await openai.responses.create(
        { input, ...(previousResponseId ? { previous_response_id: previousResponseId } : {}) },
        { body: { agent_reference: { name: process.env.AGENT_NAME, type: "agent_reference" } } }
      );
      return { jsonBody: { reply: res.output_text, id: res.id } };
    } catch (e) {
      ctx.error(e);
      return { status: 500, jsonBody: { version: "v9", error: "Agent call failed", detail: String(e?.message || e), status: e?.status } };
    }
  },
});
