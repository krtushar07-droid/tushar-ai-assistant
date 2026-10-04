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
    .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return !!user && list.includes(user);
}

async function getTable() {
  const t = TableClient.fromConnectionString(
    process.env.STORAGE_CONNECTION_STRING, 'updates');
  try { await t.createTable(); } catch (e) {}
  return t;
}

app.http('updates', {
  route: 'updates',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const table = await getTable();

      // Apps Script posts new emails here, with a secret key
      if (request.method === 'POST') {
        const key = request.headers.get('x-api-key') || '';
        if (!process.env.UPDATES_KEY || key !== process.env.UPDATES_KEY) {
          return { status: 403, jsonBody: { error: 'Not allowed' } };
        }
        const b = await request.json();
        const id = String(b.msgId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 60);
        if (!id) return { status: 400, jsonBody: { error: 'No id' } };
        try {
          await table.getEntity('u', id);
          return { status: 200, jsonBody: { ok: true, duplicate: true } };
        } catch (e) {}
        await table.createEntity({
          partitionKey: 'u', rowKey: id,
          title: String(b.subject || '(no subject)').slice(0, 200),
          body: String(b.body || '').slice(0, 6000),
          sender: String(b.sender || '').slice(0, 200),
          sent: String(b.date || ''),
          status: 'pending',
          created: Date.now()
        });
        return { status: 200, jsonBody: { ok: true } };
      }

      const user = getUser(request);
      if (!user) return { status: 401, jsonBody: { error: 'Sign in' } };
      if (!isAllowed(user)) return { status: 403, jsonBody: { error: 'Not allowed' } };
      const admin = isAllowed(user);

      if (request.method === 'GET') {
        const items = [];
        for await (const e of table.listEntities()) {
          if (!admin && e.status !== 'approved') continue;
          items.push({
            id: e.rowKey, title: e.title, body: e.body, sender: e.sender,
            sent: e.sent, created: e.created, status: e.status
          });
        }
        items.sort((a, b) => b.created - a.created);
        return { status: 200, jsonBody: { admin, items: items.slice(0, 60) } };
      }

      if (!admin) return { status: 403, jsonBody: { error: 'Not allowed' } };

      if (request.method === 'PUT') {
        const b = await request.json();
        const id = String(b.id || '');
        if (!id) return { status: 400, jsonBody: { error: 'No id' } };
        const upd = { partitionKey: 'u', rowKey: id };
        if (['pending', 'approved', 'rejected'].includes(b.status)) upd.status = b.status;
        if (typeof b.title === 'string') upd.title = b.title.slice(0, 200);
        if (typeof b.body === 'string') upd.body = b.body.slice(0, 6000);
        await table.updateEntity(upd, 'Merge');
        return { status: 200, jsonBody: { ok: true } };
      }

      const id = request.query.get('id');
      if (!id) return { status: 400, jsonBody: { error: 'No id' } };
      await table.deleteEntity('u', id);
      return { status: 200, jsonBody: { ok: true } };
    } catch (err) {
      context.error(err);
      return { status: 500, jsonBody: { error: 'Server error' } };
    }
  }
});
