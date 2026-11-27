import {mkdir, readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {tripPasswordDigest} from '../worker/api.mjs';

const root = new URL('../', import.meta.url);
const client = await readFile(new URL('js/itinerary.js', root), 'utf8');
const endpoint = client.match(/^const sheetsEndpoint = '(https:\/\/script\.google\.com\/[^']+)';$/m)?.[1];
if (!endpoint) throw new Error('Google Sheets endpoint is missing.');

async function readSheets(action, id, password) {
  const response = await fetch(endpoint, {
    method:'POST',
    headers:{'Content-Type':'text/plain;charset=UTF-8'},
    body:JSON.stringify({action, id, password}),
    signal:AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`${action}: HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(`${action}: ${result.error}`);
  return result;
}

const {trips} = await readSheets('travel-list');
if (!Array.isArray(trips)) throw new Error('Google Sheets did not return a trip list.');
const withoutLock = process.argv.includes('--without-edit-lock');
const seen = new Set();
const records = await Promise.all([...trips].reverse().map(async ({id}) => {
  const localId = id === null ? 'owner-itinerary' : id;
  if (typeof localId !== 'string' ||
      (localId !== 'owner-itinerary' && !/^trip-[0-9a-f-]{36}$/.test(localId)) ||
      seen.has(localId)) throw new Error('Invalid or duplicate trip ID.');
  seen.add(localId);
  const password = process.env.YILAN_SHEETS_EDIT_PASSWORD;
  let {tripData, revision, locked} = await readSheets('travel-read', id);
  if (locked && !withoutLock && password && /^(?:[0-9]{6}|[\x21-\x7e]{8,72})$/.test(password)) {
    const unlocked = await readSheets('travel-read', id, password);
    if (unlocked.canEdit && unlocked.locked && unlocked.tripData) {
      const salt = crypto.randomUUID();
      tripData = {...unlocked.tripData, editLock:{salt, digest:await tripPasswordDigest(password, salt)}};
      revision = unlocked.revision;
      locked = false;
    }
  }
  if (!tripData || typeof tripData !== 'object' || Array.isArray(tripData) ||
      !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid trip data.');
  return {id:localId, tripData, revision, locked};
}));

if (withoutLock) {
  const protectedRecords = records.filter(record => record.locked);
  if (protectedRecords.length !== 1) {
    throw new Error('Expected exactly one password-protected trip.');
  }
  // The list and read API provide the itinerary independently of edit access.
  // This option affects only the newly imported SQLite copy.
  protectedRecords[0].locked = false;
}

const data = new URL('data/', root);
await mkdir(data, {recursive:true});
const db = new DatabaseSync(fileURLToPath(new URL('yilan.sqlite', data)));
const schema = await readFile(new URL('drizzle/0000_itinerary.sql', root), 'utf8');
let imported = 0;
let existing = 0;
let locked = 0;
try {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(schema.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
  const insert = db.prepare('INSERT INTO itineraries (id,payload,revision) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const record of records) {
      if (record.locked) {
        locked++;
        continue;
      }
      if (insert.run(record.id, JSON.stringify(record.tripData), record.revision).changes) imported++;
      else existing++;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
} finally {
  db.close();
}
console.log(`Google Sheets: ${records.length}, imported: ${imported}, existing: ${existing}, password-protected: ${locked}.`);
