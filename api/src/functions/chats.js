import { app } from "@azure/functions";
import { TableClient } from "@azure/data-tables";

const CH = 30000;
const MAX = CH * 12;
let client;

async function table() {
  if (!client) {
    client = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, "chats");
    try { await client.createTable(); } catch (e) {}
  }
  return client;
}

function getUser(req) {
  const h = req.headers.get("x-ms-client-principal");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

function ownerKey(req) {
  const user = getUser(req);
  const allowed = (process.env.ALLOWED_USERS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!user || !allowed.includes(String(user.userDetails).toLowerCase())) return null;
  return String(user.userDetails).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function pack(messages) {
  let arr = messages;
  let json = JSON.stringify(arr);
  while (json.length > MAX && arr.length > 2) {
    arr = arr.slice(2);
    json = JSON.stringify(arr);
  }
  const parts = {};
  for (let i = 0; i * CH < json.length; i++) parts["m" + i] = json.slice(i * CH, (i + 1) * CH);
  return parts;
}

function unpack(e) {
  let s = "";
  for (let i = 0; i < 12; i++) {
    if (e["m" + i] == null) break;
    s += e["m" + i];
  }
  try { return JSON.parse(s || "[]"); } catch { return []; }
}

app.http("chats", {
  methods: ["GET", "PUT", "DELETE"],
  route: "chats/{id?}",
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    const pk = ownerKey(req);
    if (!pk) return { status: 403, jsonBody: { error: "Not allowed" } };
    const id = req.params.id;
    if (id && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { status: 400, jsonBody: { error: "Bad id" } };
    try {
      const c = await table();

      if (req.method === "GET" && !id) {
        const list = [];
        for await (const e of c.listEntities({
          queryOptions: { filter: `PartitionKey eq '${pk}'`, select: ["RowKey", "title", "updated"] },
        })) {
          list.push({ id: e.rowKey, title: e.title, updated: Number(e.updated) || 0 });
        }
        list.sort((a, b) => b.updated - a.updated);
        return { jsonBody: list.slice(0, 200) };
      }

      if (!id) return { status: 400, jsonBody: { error: "Missing id" } };

      if (req.method === "GET") {
        try {
          const e = await c.getEntity(pk, id);
          return { jsonBody: { id, title: e.title, lastId: e.lastId || null, messages: unpack(e) } };
        } catch (err) {
          if (err.statusCode === 404) return { status: 404, jsonBody: { error: "Not found" } };
          throw err;
        }
      }

      if (req.method === "PUT") {
        const b = await req.json();
        const messages = (Array.isArray(b.messages) ? b.messages : []).map(m => ({
          who: m.who === "user" ? "user" : "bot",
          text: String(m.text || "").slice(0, 20000),
          time: String(m.time || ""),
        }));
        await c.upsertEntity({
          partitionKey: pk,
          rowKey: id,
          title: String(b.title || "New chat").slice(0, 80),
          lastId: b.lastId ? String(b.lastId) : "",
          updated: Date.now(),
          ...pack(messages),
        }, "Replace");
        return { jsonBody: { ok: true } };
      }

      if (req.method === "DELETE") {
        try { await c.deleteEntity(pk, id); } catch (err) { if (err.statusCode !== 404) throw err; }
        return { jsonBody: { ok: true } };
      }

      return { status: 405, jsonBody: { error: "Method not allowed" } };
    } catch (e) {
      ctx.error(e);
      return { status: 500, jsonBody: { error: "Storage error", detail: String(e?.message || e) } };
    }
  },
});
