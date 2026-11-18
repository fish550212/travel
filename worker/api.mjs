const json = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control':'no-store'}});
export async function api(request, env) {
  // Sites dispatch verifies and supplies identity headers for signed-in visitors.
  const canEdit = request.headers.get('oai-authenticated-user-email')?.toLowerCase() === 'codexllllllll@gmail.com';
  const user = 'owner-itinerary';
  if (!env.DB) return json({error:'Storage unavailable'}, 503);
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT payload, revision FROM itineraries WHERE id = ?').bind(user).first();
    return json({tripData: row ? JSON.parse(row.payload) : null, revision: row?.revision || 0, canEdit});
  }
  if (request.method !== 'PUT') return json({error:'Method not allowed'}, 405);
  if (!canEdit) return json({error:'Owner sign-in required'}, 403);
  if (request.headers.get('Origin') !== new URL(request.url).origin) return json({error:'Invalid origin'}, 403);
  const body = await request.text();
  if (body.length > 1000000) return json({error:'Too large'}, 413);
  let data;
  try { data = JSON.parse(body); } catch { return json({error:'Invalid JSON'}, 400); }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !data.tripData) return json({error:'Invalid data'}, 400);
  const clean = {};
  const customItems = data.tripData.customItems;
  const deletedItemIds = data.tripData.deletedItemIds;
  if (customItems !== undefined) {
    if (!Array.isArray(customItems) || customItems.length > 100) return json({error:'Invalid places'}, 400);
    const seen = new Set();
    clean.customItems = [];
    for (const item of customItems) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^custom-[a-zA-Z0-9-]{1,80}$/.test(item.id) || seen.has(item.id) || !['attraction','restaurant'].includes(item.type)) return json({error:'Invalid place'}, 400);
      seen.add(item.id);
      const place = {id:item.id, type:item.type};
      for (const [key,max] of Object.entries({name:100,tag:50,location:300,desc:5000,highlight:300,mapUrl:2000})) {
        const value = item[key] ?? '';
        if (typeof value !== 'string' || value.length > max || (key === 'name' && !value.trim())) return json({error:'Invalid place field'}, 400);
        place[key] = value;
      }
      try { if (!['http:','https:'].includes(new URL(place.mapUrl).protocol)) throw Error(); } catch { return json({error:'Invalid map URL'}, 400); }
      clean.customItems.push(place);
    }
  }
  if (deletedItemIds !== undefined) {
    if (!Array.isArray(deletedItemIds) || deletedItemIds.length > 100 || deletedItemIds.some(id => typeof id !== 'string' || !/^(spot|rest)-[0-9]+$/.test(id))) return json({error:'Invalid deleted places'}, 400);
    clean.deletedItemIds = [...new Set(deletedItemIds)];
  }
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
