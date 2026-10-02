import { app } from "@azure/functions";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";

app.http("chat", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { message, previousResponseId } = await req.json();
      const project = new AIProjectClient(
        process.env.PROJECT_ENDPOINT,
        new DefaultAzureCredential()
      );
      const openai = project.getOpenAIClient();
      const res = await openai.responses.create(
        {
          input: message,
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        },
        { body: { agent: { name: process.env.AGENT_NAME, type: "agent_reference" } } }
      );
      return { jsonBody: { reply: res.output_text, id: res.id } };
    } catch (e) {
      ctx.error(e);
      return {
        status: 500,
        jsonBody: {
          error: "Agent call failed",
          detail: String(e?.message || e),
          status: e?.status,
          code: e?.code,
        },
      };
    }
  },
});
