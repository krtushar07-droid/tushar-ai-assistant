import { app } from "@azure/functions";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";

function getUser(req) {
  const h = req.headers.get("x-ms-client-principal");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
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
      return { status: 500, jsonBody: { version: "v8", error: "Agent call failed", detail: String(e?.message || e), status: e?.status } };
    }
  },
});
