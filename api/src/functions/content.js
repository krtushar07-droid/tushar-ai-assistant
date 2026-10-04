import { app } from '@azure/functions';
import { TableClient } from '@azure/data-tables';

function getUser(request) {
  const h = request.headers.get('x-ms-client-principal');
  if (!h) return null;
  try {
    const p = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
    return (p.userDetails || '').toLowerCase();
  } catch (e) {
    return null;
  }
}

function isAllowed(user) {
  const list = (process.env.ALLOWED_USERS || '')
    .toLowerCase()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return !!user && list.includes(user);
}

async function getTable() {
  const t = TableClient.fromConnectionString(
    process.env.STORAGE_CONNECTION_STRING,
    'content'
  );
  try { await t.createTable(); } catch (e) {}
  return t;
}

app.http('content', {
  route: 'content',
  methods: ['GET', 'PUT'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!isAllowed(user)) {
      return { status: 403, jsonBody: { error: 'Not allowed' } };
    }
    try {
      const table = await getTable();
      if (request.method === 'GET') {
        try {
          const e = await table.getEntity('site', 'content');
          return { status: 200, jsonBody: JSON.parse(e.data || '{}') };
        } catch (err) {
          return { status: 200, jsonBody: {} };
        }
      }
      const body = await request.json();
      const text = JSON.stringify(body);
      if (text.length > 60000) {
        return { status: 413, jsonBody: { error: 'Too large' } };
      }
      await table.upsertEntity(
        { partitionKey: 'site', rowKey: 'content', data: text },
        'Replace'
      );
      return { status: 200, jsonBody: { ok: true } };
    } catch (err) {
      context.error(err);
      return { status: 500, jsonBody: { error: 'Server error' } };
    }
  }
});
