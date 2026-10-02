import { app } from "@azure/functions";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";

app.http("chat", {
  methods: ["POST"],
  authLevel: "anonymous",

  handler: async (req, ctx) => {
    try {
      const { message, previousResponseId } = await req.json();

      if (!message) {
        return {
          status: 400,
          jsonBody: { error: "Message is required" }
        };
      }

      const project = new AIProjectClient(
        process.env.PROJECT_ENDPOINT,
        new DefaultAzureCredential()
      );

      const openai = project.getOpenAIClient();

      const response = await openai.responses.create(
        {
          input: message,
          previous_response_id: previousResponseId || undefined
        },
        {
          body: {
            agent_reference: {
              name: process.env.AGENT_NAME,
              type: "agent_reference"
            }
          }
        }
      );

      return {
        jsonBody: {
          reply: response.output_text,
          id: response.id
        }
      };

    } catch (error) {
      ctx.error(error);

      return {
        status: 500,
        jsonBody: {
          error: "Agent call failed"
        }
      };
    }
  }
});
