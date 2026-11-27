const googleHost = /^(?:(?:www|maps)\.)?google\.(?:com(?:\.tw)?|tw)$/;
const taiwanAddress = /(?:[0-9]{3,6}\s*)?(?:臺灣|台灣)?\s*[\p{Script=Han}]{2,3}[縣市]\s*[\p{Script=Han}]{1,3}?[鄉鎮市區].*/u;

function validate(value) {
  const url = new URL(value);
  const short = url.hostname === 'maps.app.goo.gl' ||
    (url.hostname === 'goo.gl' && url.pathname.startsWith('/maps/'));
  const maps = googleHost.test(url.hostname) &&
    (/^\/maps(?:\/|$)/.test(url.pathname) || url.hostname.startsWith('maps.'));
  if (url.protocol !== 'https:' || url.port || url.username || url.password || (!short && !maps)) {
    throw new Error('invalid_map_url');
  }
  return {url, short};
}

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
    const symbols = {amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', nbsp:' '};
    if (!code.startsWith('#')) return symbols[code.toLowerCase()];
    const point = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

function metadata(html, property) {
  for (const match of html.matchAll(/<meta\s+(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = Object.fromEntries([...match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map(([, key, double, single]) => [key.toLowerCase(), double ?? single]));
    if (attrs.property === property) return decodeEntities(attrs.content ?? '').trim();
  }
  return '';
}

async function readText(body, limit, stopAt = '') {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < limit && (!stopAt || !text.includes(stopAt))) {
      const {done, value} = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, {stream:true});
    }
    return text.slice(0, limit);
  } finally {
    await reader.cancel();
  }
}

async function placeDetails(html, url, fetchPage, options) {
  const preload = html.match(/<link\s+href="(\/maps\/preview\/place\?[^"]+)"/i)?.[1];
  if (!preload) return {};
  try {
    const response = await fetchPage(new URL(decodeEntities(preload), url), options);
    if (!response.body) return {};
    if (!response.ok) {
      await response.body.cancel();
      return {};
    }
    const text = await readText(response.body, 1500000);
    const place = JSON.parse(text.replace(/^\)\]\}'\s*/, ''))?.[6];
    if (!Array.isArray(place) || typeof place[11] !== 'string') return {};
    const location = place[2]?.[0] ?? place[39];
    const categories = Array.isArray(place[13]) ? place[13].filter(category => typeof category === 'string') : [];
    const restaurant = categories.some(category => /餐廳|小吃|咖啡|甜點|餐館|冰店|飲料|早餐|便當|restaurant|caf[eé]|bakery/i.test(category));
    return {
      name:place[11],
      location:typeof location === 'string' ? location : '',
      type:categories.length ? (restaurant ? 'restaurant' : 'attraction') : ''
    };
  } catch {
    return {};
  }
}

export async function previewMap(value, fetchPage = fetch) {
  let {url, short} = validate(value);
  const signal = AbortSignal.timeout(8000);
  const options = {redirect:'manual', signal, headers:{'Accept-Language':'zh-TW,zh;q=0.9'}};
  let html = '';
  for (let redirects = 0; redirects <= 5; redirects++) {
    try {
      const response = await fetchPage(url, options);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 5) break;
        ({url, short} = validate(new URL(location, url)));
        continue;
      }
      if (!short && response.ok && response.body && response.headers.get('content-type')?.includes('text/html')) {
        html = await readText(response.body, 128000, '</head>');
      } else {
        await response.body?.cancel();
      }
    } catch {
      // A readable place name or address in the original URL can still be used.
    }
    break;
  }
  if (short) return {};

  const segment = url.pathname.match(/^\/maps\/(?:place|search)\/([^/@]+)/)?.[1] ?? '';
  let label = url.searchParams.get('query') || url.searchParams.get('q') ||
    decodeURIComponent(segment.replace(/\+/g, ' '));
  if (/^(?:[+-]?\d+(?:\.\d+)?\s*,|\d+°|place_id:)/i.test(label)) label = '';
  const title = metadata(html, 'og:title').replace(/\s*[-–|]\s*(?:Google Maps|Google 地圖)$/i, '');
  const [titleName, titleAddress] = title.split(/\s+·\s+/, 2);
  const description = metadata(html, 'og:description');
  const details = await placeDetails(html, url, fetchPage, options);
  const addressInLabel = label.match(taiwanAddress);
  const address = details.location || titleAddress || description.split(/\s+·\s+/).find(part => taiwanAddress.test(part))?.match(taiwanAddress)?.[0] ||
    addressInLabel?.[0] || '';
  const nameFromLabel = addressInLabel ? label.slice(0, addressInLabel.index).replace(/[\s,，]+$/, '') : label;
  const name = details.name || (/^(?:Google Maps|Google 地圖)$/i.test(titleName) ? nameFromLabel : titleName || nameFromLabel);
  return {name:name.slice(0, 100), location:address.slice(0, 300), ...(details.type ? {type:details.type} : {})};
}
