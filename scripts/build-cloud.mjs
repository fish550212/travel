import fs from 'node:fs';
import vm from 'node:vm';

const pages = {
  '/index.html': fs.readFileSync('index.html', 'utf8').replace('data-cloud="false"', 'data-cloud="true"'),
  '/code_artifact.html': fs.readFileSync('code_artifact.html', 'utf8')
};
const files = {
  '/css/index.css': 'text/css; charset=utf-8',
  '/css/itinerary.css': 'text/css; charset=utf-8',
  '/css/controls.css': 'text/css; charset=utf-8',
  '/js/index.js': 'text/javascript; charset=utf-8',
  '/js/itinerary.js': 'text/javascript; charset=utf-8',
  '/images/頭像-01.png': 'image/png',
  '/images/logo-03.png': 'image/png',
  '/images/bg.png': 'image/png'
};
const assets = Object.fromEntries(Object.entries(files).map(([path, type]) => {
  const binary = type === 'image/png';
  let body = fs.readFileSync('.' + path, binary ? 'base64' : 'utf8');
  if (path === '/js/itinerary.js') {
    body = body.replace(/const sheetsEndpoint = '[^']*'/, "const sheetsEndpoint = ''");
  }
  if (type.startsWith('text/javascript')) new vm.Script(body, {filename: path});
  return [path, {type, body, binary}];
}));
const api = fs.readFileSync('worker/api.mjs', 'utf8').replace('export async function api', 'async function api');
const source = api + '\nconst pages = ' + JSON.stringify(pages) +
  ';\nconst assets = ' + JSON.stringify(assets) + `;
export default {async fetch(request,env) {
  const path = new URL(request.url).pathname;
  try {
    if (path === '/api/itinerary' || path === '/api/trips' || path === '/api/github-editor') return await api(request,env);
    const pagePath = path === '/' ? '/index.html' : path;
    if (Object.hasOwn(pages, pagePath)) {
      return new Response(pages[pagePath], {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
    }
    const assetPath = decodeURIComponent(path);
    if (Object.hasOwn(assets, assetPath)) {
      const {type, body, binary} = assets[assetPath];
      const content = binary ? Uint8Array.from(atob(body), char => char.charCodeAt(0)) : body;
      return new Response(content, {headers:{'Content-Type':type,'Cache-Control':'no-cache'}});
    }
    return new Response('Not found',{status:404});
  } catch { return json({error:'Server unavailable'},503); }
}};`;

fs.mkdirSync('dist/server', {recursive:true});
fs.mkdirSync('dist/.openai', {recursive:true});
fs.writeFileSync('dist/server/index.js', source);
fs.copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json');
console.log('Worker built; client syntax passed.');
