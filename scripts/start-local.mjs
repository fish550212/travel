import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdir, readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {api} from '../worker/api.mjs';
import {previewMap} from './maps-preview.mjs';

const local = new URL('http://127.0.0.1:3000');
const [mode, address] = process.argv.slice(2);
const publicOrigin = mode === '--public-url' ? new URL(address) : null;
const remote = mode && !publicOrigin ? new URL(mode) : null;
if (publicOrigin && (publicOrigin.protocol !== 'https:' ||
    publicOrigin.href !== publicOrigin.origin + '/')) {
  throw new Error('Expected an HTTPS public site URL.');
}
if (remote && (remote.protocol !== 'https:' || !remote.hostname.endsWith('.ts.net') ||
    remote.href !== remote.origin + '/')) {
  throw new Error('Expected an HTTPS Tailscale Serve URL.');
}

const root = new URL('../', import.meta.url);
const data = new URL('data/', root);
await mkdir(data, {recursive:true});
const db = new DatabaseSync(fileURLToPath(new URL('yilan.sqlite', data)));
const schema = await readFile(new URL('drizzle/0000_itinerary.sql', root), 'utf8');
db.exec(schema.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
const DB = {
  prepare(sql) {
    const statement = db.prepare(sql);
    return {
      all: () => ({results:statement.all()}),
      bind(...values) {
        return {
          first: () => statement.get(...values),
          run: () => ({meta:statement.run(...values)})
        };
      }
    };
  }
};

const html = 'text/html; charset=utf-8';
const js = 'text/javascript; charset=utf-8';
const css = 'text/css; charset=utf-8';
const assets = new Map([
  ['/index.html', html], ['/code_artifact.html', html],
  ['/js/index.js', js], ['/js/itinerary.js', js],
  ['/css/index.css', css], ['/css/itinerary.css', css], ['/css/controls.css', css],
  ['/images/頭像-01.png', 'image/png'], ['/images/logo-03.png', 'image/png'], ['/images/bg.png', 'image/png']
]);
const localApiOptions = {localOwner:true, includeExample:false};

function renderTripHeader(page, trip) {
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const departure = trip?.dateRange?.departureDate ?? trip?.dates?.day1 ?? today;
  const returning = trip?.dateRange?.returnDate ?? trip?.dates?.day3 ?? today;
  const start = departure.replaceAll('-', '/');
  const end = (departure.slice(0, 4) === returning.slice(0, 4) ? returning.slice(5) : returning).replaceAll('-', '/');
  const dateLabel = departure === returning ? start : start + ' – ' + end;
  const title = (trip?.title || '新旅程').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return page
    .replace(/(<h1 id="trip-header-title"[^>]*>)[^<]*(<\/h1>)/, (_, open, close) => open + title + close)
    .replace(/(<p id="trip-header-dates"[^>]*>)[^<]*(<\/p>)/, (_, open, close) => open + dateLabel + close);
}

async function serve(incoming, outgoing, publicSite) {
  try {
    const forwarded = incoming.headers['x-forwarded-host'];
    const viaTailscale = !publicSite && remote && typeof incoming.headers['tailscale-user-login'] === 'string' &&
      (incoming.headers.host === remote.host || forwarded === remote.host);
    const site = publicSite ? publicOrigin : viaTailscale ? remote : local;
    if (!publicSite && !viaTailscale && incoming.headers.host !== local.host) {
      outgoing.writeHead(403).end('Invalid host');
      return;
    }
    const url = new URL(site);
    const queryStart = incoming.url.indexOf('?');
    url.pathname = queryStart < 0 ? incoming.url : incoming.url.slice(0, queryStart);
    url.search = queryStart < 0 ? '' : incoming.url.slice(queryStart);
    if (url.pathname === '/api/maps-preview' && incoming.method === 'GET') {
      let status = 200;
      let result;
      try {
        const mapUrl = url.searchParams.get('url');
        if (!mapUrl || mapUrl.length > 2000) throw new Error('invalid_map_url');
        result = await previewMap(mapUrl);
      } catch {
        status = 400;
        result = {error:'invalid_map_url'};
      }
      outgoing.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'})
        .end(JSON.stringify(result));
      return;
    }
    if (['/api/trips', '/api/itinerary'].includes(url.pathname)) {
      const options = {method:incoming.method, headers:incoming.headers};
      if (!['GET', 'HEAD'].includes(incoming.method)) {
        options.body = Readable.toWeb(incoming);
        options.duplex = 'half';
      }
      const result = await api(new Request(url, options), {DB}, localApiOptions);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.fromWeb(result.body), outgoing);
      else outgoing.end();
      return;
    }

    const path = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    if (!assets.has(path) || incoming.method !== 'GET') {
      outgoing.writeHead(404).end('Not found');
      return;
    }
    const file = new URL('.' + path, root);
    const headers = {'Content-Type':assets.get(path), 'Cache-Control':'no-store'};
    if (path === '/index.html' || path === '/code_artifact.html' || path === '/js/itinerary.js') {
      let body = await readFile(file, 'utf8');
      if (path === '/index.html') body = body.replace('data-cloud="false"', 'data-cloud="true"');
      if (path === '/code_artifact.html') {
        const dataUrl = new URL('/api/itinerary' + url.search, site);
        const result = await api(new Request(dataUrl, {headers:incoming.headers}), {DB}, localApiOptions);
        if (result.ok) {
          const snapshot = await result.text();
          const {tripData} = JSON.parse(snapshot);
          const safeSnapshot = snapshot.replaceAll('<', '\\u003c');
          body = renderTripHeader(body, tripData).replace('<html ', '<html data-trip-preloaded ')
            .replace('</body>', () => `<script type="application/json" id="trip-initial-data">${safeSnapshot}</script>\n</body>`);
        }
      }
      if (path === '/js/itinerary.js') body = body.replace(/const sheetsEndpoint = '[^']*'/, "const sheetsEndpoint = ''")
        .replace(/^const localPreview = .*;$/m, 'const localPreview = false;')
        .replace('const showTripExamples = true;', 'const showTripExamples = false;');
      outgoing.writeHead(200, headers).end(body);
    } else {
      await pipeline(createReadStream(file), outgoing.writeHead(200, headers));
    }
  } catch (error) {
    console.error(error);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
}
const server = createServer((request, response) => serve(request, response, false));
server.listen(Number(local.port), local.hostname, () => {
  console.log(`Local site: ${local.href}`);
  if (remote) console.log(`Tailscale site: ${remote.href}`);
});
if (publicOrigin) {
  const publicServer = createServer((request, response) => serve(request, response, true));
  publicServer.listen(3001, local.hostname, () => {
    console.log(`Public site: ${publicOrigin.href} via http://127.0.0.1:3001/`);
  });
}
