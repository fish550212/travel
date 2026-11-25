const json = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control':'no-store'}});
const githubOrigin = 'https://fish550212.github.io';
const githubKeyId = 'github-editor-key';

async function keyDigest(key) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function isTripDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export async function api(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const github = origin === githubOrigin && ['/api/trips','/api/itinerary'].includes(url.pathname);
  if (request.method === 'OPTIONS' && github) {
    return new Response(null,{status:204,headers:{
      'Access-Control-Allow-Origin':githubOrigin,
      'Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':'Authorization, Content-Type',
      'Vary':'Origin'
    }});
  }
  const response = await handleTripRequest(request, env, url, origin, github);
  response.headers.set('Vary', 'Origin');
  if (github) response.headers.set('Access-Control-Allow-Origin', githubOrigin);
  return response;
}

async function handleTripRequest(request, env, url, origin, github) {
  // Sites dispatch verifies and supplies identity headers for signed-in visitors.
  const owner = request.headers.get('oai-authenticated-user-email')?.toLowerCase() === 'codexllllllll@gmail.com';
  if (!env.DB) return json({error:'Storage unavailable'}, 503);
  if (url.pathname === '/api/github-editor') {
    if (request.method !== 'POST') return json({error:'Method not allowed'}, 405);
    if (!owner || origin !== url.origin) return json({error:'Owner sign-in required'}, 403);
    const key = crypto.randomUUID() + crypto.randomUUID();
    const payload = JSON.stringify({digest:await keyDigest(key)});
    await env.DB.prepare('INSERT INTO itineraries (id,payload,revision) VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
      .bind(githubKeyId,payload).run();
    return json({key},201);
  }
  let canEdit = owner && !github;
  if (github) {
    const match = /^Bearer ([0-9a-f-]{72})$/.exec(request.headers.get('Authorization') ?? '');
    if (match) {
      const row = await env.DB.prepare('SELECT payload FROM itineraries WHERE id = ?').bind(githubKeyId).first();
      canEdit = !!row && JSON.parse(row.payload).digest === await keyDigest(match[1]);
    }
  }
  if (url.pathname === '/api/trips') {
    if (request.method === 'GET') {
      const {results} = await env.DB.prepare(`SELECT id, json_extract(payload, '$.title') AS title,
        json_extract(payload, '$.deleted') AS deleted,
        coalesce(json_extract(payload, '$.dateRange.departureDate'), json_extract(payload, '$.dates.day1')) AS departureDate,
        coalesce(json_extract(payload, '$.dateRange.returnDate'), json_extract(payload, '$.dates.day3')) AS returnDate
        FROM itineraries WHERE id = 'owner-itinerary' OR id LIKE 'trip-%' ORDER BY rowid DESC`).all();
      const trips = results.filter(row => !row.deleted && row.id.startsWith('trip-')).map(row => ({
        id:row.id,title:row.title || '新旅程',departureDate:row.departureDate,returnDate:row.returnDate
      }));
      const original = results.find(row => row.id === 'owner-itinerary');
      if (!original?.deleted) trips.push({
        id:null,title:original?.title || '宜蘭旅行',
        departureDate:original?.departureDate || '2026-12-12',returnDate:original?.returnDate || '2026-12-14'
      });
      return json({trips,canEdit});
    }
    if (request.method !== 'POST') return json({error:'Method not allowed'}, 405);
    if (!canEdit) return json({error:'Owner sign-in required'}, 403);
    if (!github && origin !== url.origin) return json({error:'Invalid origin'}, 403);
    const id = 'trip-' + crypto.randomUUID();
    const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const empty = {ids:[],notes:{}};
    const trip = {title:'新旅程', dateRange:{departureDate:today,returnDate:today}, day1:empty, day2:empty, day3:empty};
    await env.DB.prepare('INSERT INTO itineraries (id,payload,revision) VALUES (?,?,1) ON CONFLICT(id) DO NOTHING').bind(id,JSON.stringify(trip)).run();
    return json({id}, 201);
  }
  const user = url.searchParams.get('trip') ?? 'owner-itinerary';
  if (user !== 'owner-itinerary' && !/^trip-[0-9a-f-]{36}$/.test(user)) return json({error:'Invalid trip'}, 400);
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT payload, revision FROM itineraries WHERE id = ?').bind(user).first();
    const tripData = row ? JSON.parse(row.payload) : null;
    if (tripData?.deleted) return json({error:'Trip removed'}, 410);
    if (!row && user !== 'owner-itinerary') return json({error:'Trip not found'}, 404);
    return json({tripData, revision: row?.revision || 0, canEdit});
  }
  if (!['PUT','DELETE'].includes(request.method)) return json({error:'Method not allowed'}, 405);
  if (!canEdit) return json({error:'Owner sign-in required'}, 403);
  if (!github && origin !== url.origin) return json({error:'Invalid origin'}, 403);
  if (request.method === 'DELETE') {
    if (user === 'owner-itinerary') {
      await env.DB.prepare('INSERT INTO itineraries (id,payload,revision) VALUES (?,?,1) ON CONFLICT(id) DO NOTHING')
        .bind(user, JSON.stringify({deleted:1})).run();
    }
    await env.DB.prepare("UPDATE itineraries SET payload = json_set(payload, '$.deleted', 1), revision = revision + 1 WHERE id = ? AND json_extract(payload, '$.deleted') IS NULL")
      .bind(user).run();
    return new Response(null,{status:204});
  }
  const body = await request.text();
  if (body.length > 1000000) return json({error:'Too large'}, 413);
  let data;
  try { data = JSON.parse(body); } catch { return json({error:'Invalid JSON'}, 400); }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !data.tripData) return json({error:'Invalid data'}, 400);
  if (user !== 'owner-itinerary' && data.revision === 0) return json({error:'Trip not found'}, 404);
  const clean = {};
  const {title, dates, dateRange} = data.tripData;
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim() || title.length > 100) return json({error:'Invalid title'}, 400);
    clean.title = title;
  }
  const {reminder, stay} = data.tripData;
  if (reminder !== undefined) {
    if (typeof reminder !== 'string' || reminder.length > 2000) return json({error:'Invalid reminder'}, 400);
    clean.reminder = reminder;
  }
  if (stay !== undefined) {
    if (!stay || typeof stay !== 'object' || Array.isArray(stay)) return json({error:'Invalid stay'}, 400);
    clean.stay = {};
    for (const [key, max] of Object.entries({name:100, address:300, checkIn:40, checkOut:40})) {
      const value = stay[key] ?? (key === 'name' ? '' : undefined);
      if (typeof value !== 'string' || value.length > max) return json({error:'Invalid stay'}, 400);
      clean.stay[key] = value;
    }
  }
  if (dates !== undefined) {
    const days = ['day1','day2','day3'];
    const values = days.map(day => dates?.[day]);
    if (values.some((value, index) => !isTripDate(value) || (index > 0 && value <= values[index - 1]))) return json({error:'Invalid trip dates'}, 400);
    clean.dates = Object.fromEntries(days.map((day, index) => [day, values[index]]));
  }
  if (dateRange !== undefined) {
    const {departureDate, returnDate} = dateRange ?? {};
    if (!isTripDate(departureDate) || !isTripDate(returnDate) || returnDate < departureDate) return json({error:'Invalid trip date range'}, 400);
    clean.dateRange = {departureDate, returnDate};
  }
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
  const days = new Set(['day1','day2','day3', ...Object.keys(data.tripData).filter(key => /^day[1-9][0-9]*$/.test(key) || (key.startsWith('date-') && isTripDate(key.slice(5))))]);
  for (const day of days) {
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
    : await env.DB.prepare("UPDATE itineraries SET payload = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND json_extract(payload, '$.deleted') IS NULL").bind(payload,user,data.revision).run();
  if (!result.meta.changes) return json({error:'Conflict'}, 409);
  return json({revision:data.revision + 1});
}
