import fs from 'node:fs';
fs.mkdirSync('dist/server', {recursive:true});
fs.mkdirSync('dist/.openai', {recursive:true});
const html = fs.readFileSync('code_artifact.html','utf8')
  .replace(/const sheetsEndpoint = '[^']*'/, "const sheetsEndpoint = ''");
const home = fs.readFileSync('index.html','utf8').replace('data-cloud="false"', 'data-cloud="true"');
const avatar = fs.readFileSync('頭像-01.png').toString('base64');
const api = fs.readFileSync('worker/api.mjs','utf8').replace('export async function api', 'async function api');
const source = api + '\nconst html = ' + JSON.stringify(html) +
  ';\nconst home = ' + JSON.stringify(home) + ';\nconst avatar = ' + JSON.stringify(avatar) + `;
export default {async fetch(request,env) {
  const path = new URL(request.url).pathname;
  try {
    if (path === '/api/itinerary' || path === '/api/trips') return await api(request,env);
    if (path === '/' || path === '/index.html' || path === '/code_artifact.html') {
      return new Response(path === '/code_artifact.html' ? html : home,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
    }
    if (decodeURIComponent(path) === '/頭像-01.png') {
      return new Response(Uint8Array.from(atob(avatar), char => char.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});
    }
    return new Response('Not found',{status:404});
  } catch { return json({error:'Server unavailable'},503); }
}};`;
fs.writeFileSync('dist/server/index.js',source);
fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
new Function(html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]);
new Function(home.match(/<script>([\s\S]*?)<\/script>/)[1]);
console.log('Worker built; client syntax passed.');
