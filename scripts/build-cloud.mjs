import fs from 'node:fs';
fs.mkdirSync('dist/server', {recursive:true});
fs.mkdirSync('dist/.openai', {recursive:true});
const html = fs.readFileSync('code_artifact.html','utf8');
const api = fs.readFileSync('worker/api.mjs','utf8').replace('export async function api', 'async function api');
const source = api + '\nconst html = ' + JSON.stringify(html) + `;
export default {async fetch(request,env) {
  const path = new URL(request.url).pathname;
  try {
    if (path === '/api/itinerary') return await api(request,env);
    if (path === '/' || path === '/index.html') return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
    return new Response('Not found',{status:404});
  } catch { return json({error:'Server unavailable'},503); }
}};`;
fs.writeFileSync('dist/server/index.js',source);
fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
new Function(html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]);
console.log('Worker built; client syntax passed.');
