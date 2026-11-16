const json = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control':'no-store'}});
export async function api(request, env) {
  const user = request.headers.get('oai-authenticated-user-id');
  if (!user) return json({error:'Sign in required'}, 401);
  if (!env.DB) return json({error:'Storage unavailable'}, 503);
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT payload, revision FROM itineraries WHERE id = ?').bind(user).first();
    return json({tripData: row ? JSON.parse(row.payload) : null, revision: row?.revision || 0});
  }
  if (request.method !== 'PUT') return json({error:'Method not allowed'}, 405);
  if (request.headers.get('Origin') !== new URL(request.url).origin) return json({error:'Invalid origin'}, 403);
  const body = await request.text();
  if (body.length > 100000) return json({error:'Too large'}, 413);
  let data;
  try { data = JSON.parse(body); } catch { return json({error:'Invalid JSON'}, 400); }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !data.tripData) return json({error:'Invalid data'}, 400);
  const clean = {};
  for (const day of ['day1','day2','day3']) {
    const value = data.tripData[day];
    const ids = Array.isArray(value) ? value : value?.ids;
    const notes = Array.isArray(value) ? {} : value?.notes;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || id.length > 100) || !notes || typeof notes !== 'object' || Array.isArray(notes)) return json({error:'Invalid schedule'}, 400);
    const safeNotes = Object.create(null);
    for (const id of ids) {
      if (notes[id] !== undefined && (typeof notes[id] !== 'string' || notes[id].length > 5000)) return json({error:'Invalid note'}, 400);
      if (notes[id] !== undefined) safeNotes[id] = notes[id];
    }
    clean[day] = {ids: [...new Set(ids)], notes:safeNotes};
  }
  const payload = JSON.stringify(clean);
  const result = data.revision === 0
    ? await env.DB.prepare('INSERT INTO itineraries (id,payload,revision) VALUES (?,?,1) ON CONFLICT(id) DO NOTHING').bind(user,payload).run()
    : await env.DB.prepare('UPDATE itineraries SET payload = ?, revision = revision + 1 WHERE id = ? AND revision = ?').bind(payload,user,data.revision).run();
  if (!result.meta.changes) return json({error:'Conflict'}, 409);
  return json({revision:data.revision + 1});
}
