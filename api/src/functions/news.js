import { app } from "@azure/functions";

const TOPICS = {
  "Automobile": "automobile industry India",
  "E-commerce": "e-commerce quick commerce India",
  "Finance": "banking finance markets India",
  "Marketing": "marketing advertising brands India",
  "FMCG": "FMCG consumer goods India",
  "Technology": "technology AI business India",
  "Startups": "startups funding India",
  "Economy": "Indian economy RBI inflation GDP"
};
const TTL = 30 * 60 * 1000;
const cache = new Map();

function getUser(req) {
  const h = req.headers.get("x-ms-client-principal");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

function decode(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}

function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">"));
  if (!m) return "";
  return decode(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
}

function realUrl(link) {
  try {
    const u = new URL(link);
    const target = u.searchParams.get("url");
    if (target && /^https?:\/\//.test(target)) return target;
  } catch {}
  return link;
}

function fixImg(v) {
  if (!v) return "";
  if (v.startsWith("//")) v = "https:" + v;
  else if (v.startsWith("/")) v = "https://www.bing.com" + v;
  v = v.replace(/^http:\/\//, "https://");
  return /^https:\/\//.test(v) ? v : "";
}

function parseBing(xml) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const title = tag(b, "title");
    const link = realUrl(tag(b, "link"));
    const source = tag(b, "News:Source");
    const image = fixImg(tag(b, "News:Image"));
    const t = Date.parse(tag(b, "pubDate"));
    if (!title || !/^https?:\/\//.test(link)) continue;
    items.push({ title, source, link, image, date: isNaN(t) ? null : new Date(t).toISOString() });
  }
  return items;
}

function parse(xml) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    let title = tag(b, "title");
    const source = tag(b, "source");
    const link = tag(b, "link");
    const date = tag(b, "pubDate");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    if (!title || !/^https?:\/\//.test(link)) continue;
    const t = Date.parse(date);
    items.push({ title, source, link, image: "", date: isNaN(t) ? null : new Date(t).toISOString() });
  }
  return items;
}

app.http("news", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    const user = getUser(req);
    const allowed = (process.env.ALLOWED_USERS || "")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!user || !allowed.includes(String(user.userDetails).toLowerCase())) {
      return { status: 403, jsonBody: { error: "Not allowed" } };
    }
    const topic = req.query.get("topic") || "Finance";
    const q = TOPICS[topic];
    if (!q) return { status: 400, jsonBody: { error: "Unknown topic" } };

    const hit = cache.get(topic);
    if (hit && Date.now() - hit.t < TTL) return { jsonBody: { topic, items: hit.items } };

    try {
      let items = [];
      // 1) Bing News feed (includes images)
      try {
        const bu = "https://www.bing.com/news/search?q=" + encodeURIComponent(q) +
          "&format=rss&setmkt=en-IN&qft=sortbydate%3d%221%22";
        const br = await fetch(bu, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (br.ok) items = parseBing(await br.text());
      } catch (e) { ctx.warn("bing feed failed", e); }
      // 2) Fallback: Google News feed (no images)
      if (!items.length) {
        const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q + " when:3d") +
          "&hl=en-IN&gl=IN&ceid=IN:en";
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!r.ok) throw new Error("Feed returned " + r.status);
        items = parse(await r.text());
      }
      items = items.slice(0, 12);
      cache.set(topic, { t: Date.now(), items });
      return { jsonBody: { topic, items } };
    } catch (e) {
      ctx.error(e);
      if (hit) return { jsonBody: { topic, items: hit.items } };
      return { status: 502, jsonBody: { error: "News feed unavailable" } };
    }
  },
});
