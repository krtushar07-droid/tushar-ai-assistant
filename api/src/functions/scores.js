import { app } from "@azure/functions";
import { TableClient } from "@azure/data-tables";

let ready = false;

function getUser(req) {
  const h = req.headers.get("x-ms-client-principal");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

async function table() {
  const c = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, "scores");
  if (!ready) {
    try { await c.createTable(); } catch {}
    ready = true;
  }
  return c;
}

app.http("scores", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "scores",
  handler: async (req, ctx) => {
    const user = getUser(req);
    const allowed = (process.env.ALLOWED_USERS || "")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!user || !allowed.includes(String(user.userDetails).toLowerCase())) {
      return { status: 403, jsonBody: { error: "Not allowed" } };
    }
    const pk = String(user.userDetails).toLowerCase().replace(/[^a-z0-9]/g, "_");
    try {
      const c = await table();
      if (req.method === "POST") {
        let b = {};
        try { b = await req.json(); } catch {}
        const score = Number(b.score), total = Number(b.total);
        if (!(total > 0) || !(score >= 0) || score > total) {
          return { status: 400, jsonBody: { error: "Bad score" } };
        }
        const subject = String(b.subject || "Mixed").slice(0, 40);
        await c.createEntity({
          partitionKey: pk,
          rowKey: String(Date.now()) + "_" + Math.random().toString(36).slice(2, 6),
          subject, score, total
        });
        return { jsonBody: { ok: true } };
      }
      const rows = [];
      for await (const e of c.listEntities({ queryOptions: { filter: `PartitionKey eq '${pk}'` } })) {
        rows.push({
          subject: e.subject,
          score: e.score,
          total: e.total,
          when: Number(String(e.rowKey).split("_")[0]) || 0
        });
      }
      return { jsonBody: rows.slice(-200) };
    } catch (e) {
      ctx.error(e);
      return { status: 500, jsonBody: { error: "Scores failed" } };
    }
  },
});
