import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';

function loadEnv(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.GATEWAY_API_KEY || '';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const YTDLP = process.env.YTDLP || 'yt-dlp';
const RESOLUTION = process.env.RESOLUTION || '720:1280';
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || '2500k';
const YTDLP_COOKIES_FILE = (process.env.YTDLP_COOKIES_FILE || '').trim();

// OAuth account connection broker. Provider app secrets stay on the Gateway, never in the APK.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';
const FACEBOOK_GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v26.0';
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || '';
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || '';
const SHOPEE_PARTNER_ID = process.env.SHOPEE_PARTNER_ID || '';
const SHOPEE_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || '';
const SHOPEE_HOST = (process.env.SHOPEE_HOST || 'https://partner.shopeemobile.com').replace(/\/$/, '');
const OAUTH_STORE_KEY = process.env.OAUTH_STORE_KEY || '';
const OAUTH_STORE_FILE = path.resolve(process.env.OAUTH_STORE_FILE || './data/oauth-connections.enc.json');
const APP_RETURN_URI = 'shopliveai://oauth/callback';
const oauthStates = new Map();
const oauthConnections = new Map();

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function randomId(bytes = 24) {
  return b64url(crypto.randomBytes(bytes));
}

function secureCookieState(req) {
  const raw = req.headers.cookie || '';
  for (const item of raw.split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === 'shoplive_oauth_state') return decodeURIComponent(rest.join('='));
  }
  return '';
}

function setStateCookie(res, state) {
  res.setHeader('set-cookie', `shoplive_oauth_state=${encodeURIComponent(state)}; Max-Age=600; Path=/oauth; HttpOnly; SameSite=Lax; Secure`);
}

function publicCallback(platform) {
  if (!PUBLIC_BASE_URL.startsWith('https://')) {
    throw new Error('PUBLIC_BASE_URL phải là HTTPS public để dùng đăng nhập nền tảng');
  }
  return `${PUBLIC_BASE_URL}/oauth/${platform}/callback`;
}

function pruneStates() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, value] of oauthStates) if (value.createdAt < cutoff) oauthStates.delete(key);
}

function stateFor(platform, appReturn) {
  pruneStates();
  if (appReturn !== APP_RETURN_URI) throw new Error('app_return không hợp lệ');
  const state = randomId();
  oauthStates.set(state, { platform, appReturn, createdAt: Date.now() });
  return state;
}

function takeState(state, expectedPlatform) {
  pruneStates();
  const value = oauthStates.get(state);
  if (!value || value.platform !== expectedPlatform) return null;
  oauthStates.delete(state);
  return value;
}

function appRedirect(res, platform, status, details = {}) {
  const target = new URL(APP_RETURN_URI);
  target.searchParams.set('platform', platform.toUpperCase());
  target.searchParams.set('status', status);
  if (details.connectionId) target.searchParams.set('connection_id', details.connectionId);
  if (details.accountName) target.searchParams.set('account_name', details.accountName);
  if (details.destinationId) target.searchParams.set('destination_id', details.destinationId);
  if (details.destinationName) target.searchParams.set('destination_name', details.destinationName);
  if (details.message) target.searchParams.set('message', String(details.message).slice(0, 300));
  res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
  res.end();
}

function oauthConfigOk(platform) {
  if (!PUBLIC_BASE_URL.startsWith('https://')) return 'PUBLIC_BASE_URL phải là URL HTTPS public';
  if (platform === 'facebook' && (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET)) return 'Thiếu FACEBOOK_APP_ID / FACEBOOK_APP_SECRET';
  if (platform === 'tiktok' && (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET)) return 'Thiếu TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET';
  if (platform === 'shopee' && (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY)) return 'Thiếu SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY';
  return '';
}

function encryptConnections() {
  if (!OAUTH_STORE_KEY) return null;
  const key = crypto.createHash('sha256').update(OAUTH_STORE_KEY).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify([...oauthConnections.entries()]), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}

function saveConnections() {
  const payload = encryptConnections();
  if (!payload) return;
  fs.mkdirSync(path.dirname(OAUTH_STORE_FILE), { recursive: true });
  fs.writeFileSync(OAUTH_STORE_FILE, JSON.stringify(payload), { mode: 0o600 });
}

function loadConnections() {
  if (!OAUTH_STORE_KEY || !fs.existsSync(OAUTH_STORE_FILE)) return;
  try {
    const payload = JSON.parse(fs.readFileSync(OAUTH_STORE_FILE, 'utf8'));
    const key = crypto.createHash('sha256').update(OAUTH_STORE_KEY).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
    for (const [id, value] of JSON.parse(plain)) oauthConnections.set(id, value);
  } catch (e) {
    console.error('[oauth store] cannot decrypt saved connections:', e.message);
  }
}
loadConnections();

function saveConnection(platform, accountName, tokens, extra = {}) {
  const connectionId = randomId(18);
  oauthConnections.set(connectionId, {
    platform,
    accountName,
    tokens,
    extra,
    updatedAt: new Date().toISOString()
  });
  saveConnections();
  return connectionId;
}

function hmacSha256Hex(key, text) {
  return crypto.createHmac('sha256', key).update(text).digest('hex');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`); }
  if (!response.ok) {
    const graphError = body?.error?.message || body?.error?.error_user_msg || '';
    throw new Error(body.error_description || body.message || graphError || (typeof body.error === 'string' ? body.error : '') || `HTTP ${response.status}`);
  }
  if (body?.error) {
    const graphError = body.error.message || body.error.error_user_msg || body.error.type || 'Provider API error';
    throw new Error(graphError);
  }
  return body;
}

async function oauthStart(req, res, requestUrl, platform) {
  const error = oauthConfigOk(platform);
  if (error) return json(res, 503, { ok: false, error });
  const appReturn = requestUrl.searchParams.get('app_return') || '';
  let state;
  try { state = stateFor(platform, appReturn); }
  catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  setStateCookie(res, state);

  if (platform === 'facebook') {
    const auth = new URL('https://www.facebook.com/dialog/oauth');
    auth.searchParams.set('client_id', FACEBOOK_APP_ID);
    auth.searchParams.set('redirect_uri', publicCallback('facebook'));
    auth.searchParams.set('state', state);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', 'public_profile,pages_show_list,publish_video');
    res.writeHead(302, { location: auth.toString(), 'cache-control': 'no-store' });
    return res.end();
  }

  if (platform === 'tiktok') {
    const auth = new URL('https://www.tiktok.com/v2/auth/authorize/');
    auth.searchParams.set('client_key', TIKTOK_CLIENT_KEY);
    auth.searchParams.set('redirect_uri', publicCallback('tiktok'));
    auth.searchParams.set('state', state);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', 'user.info.basic');
    res.writeHead(302, { location: auth.toString(), 'cache-control': 'no-store' });
    return res.end();
  }

  if (platform === 'shopee') {
    const apiPath = '/api/v2/shop/auth_partner';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = hmacSha256Hex(SHOPEE_PARTNER_KEY, `${SHOPEE_PARTNER_ID}${apiPath}${timestamp}`);
    const callback = publicCallback('shopee');
    const auth = new URL(`${SHOPEE_HOST}${apiPath}`);
    auth.searchParams.set('partner_id', SHOPEE_PARTNER_ID);
    auth.searchParams.set('timestamp', String(timestamp));
    auth.searchParams.set('sign', sign);
    auth.searchParams.set('redirect', callback);
    res.writeHead(302, { location: auth.toString(), 'cache-control': 'no-store' });
    return res.end();
  }

  return json(res, 404, { ok: false, error: 'unsupported platform' });
}

async function oauthCallback(req, res, requestUrl, platform) {
  const returnedState = requestUrl.searchParams.get('state') || secureCookieState(req);
  const state = takeState(returnedState, platform);
  if (!state) return appRedirect(res, platform, 'error', { message: 'Phiên đăng nhập đã hết hạn hoặc state không hợp lệ' });
  const providerError = requestUrl.searchParams.get('error') || requestUrl.searchParams.get('error_description');
  if (providerError) return appRedirect(res, platform, 'error', { message: providerError });

  try {
    if (platform === 'facebook') {
      const code = requestUrl.searchParams.get('code');
      if (!code) throw new Error('Facebook không trả authorization code');
      const graphBase = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}`;
      const tokenUrl = new URL(`${graphBase}/oauth/access_token`);
      tokenUrl.searchParams.set('client_id', FACEBOOK_APP_ID);
      tokenUrl.searchParams.set('client_secret', FACEBOOK_APP_SECRET);
      tokenUrl.searchParams.set('redirect_uri', publicCallback('facebook'));
      tokenUrl.searchParams.set('code', code);
      const shortToken = await fetchJson(tokenUrl);

      // Exchange for a long-lived user token when Meta allows it. If exchange fails,
      // keep the original token so development/test users can still continue.
      let token = shortToken;
      try {
        const longUrl = new URL(`${graphBase}/oauth/access_token`);
        longUrl.searchParams.set('grant_type', 'fb_exchange_token');
        longUrl.searchParams.set('client_id', FACEBOOK_APP_ID);
        longUrl.searchParams.set('client_secret', FACEBOOK_APP_SECRET);
        longUrl.searchParams.set('fb_exchange_token', shortToken.access_token);
        const longToken = await fetchJson(longUrl);
        if (longToken.access_token) token = { ...shortToken, ...longToken };
      } catch (e) {
        console.warn('[facebook] long-lived token exchange skipped:', e.message);
      }

      const profileUrl = new URL(`${graphBase}/me`);
      profileUrl.searchParams.set('fields', 'id,name');
      profileUrl.searchParams.set('access_token', token.access_token);
      const profile = await fetchJson(profileUrl);
      const accountName = profile.name || `Facebook ${profile.id || ''}`.trim();
      const connectionId = saveConnection('facebook', accountName, token, { userId: profile.id || '' });
      // Default to the user's own profile; the Android app can switch to any managed Page later.
      return appRedirect(res, platform, 'ok', {
        connectionId,
        accountName,
        destinationId: `user:${profile.id || ''}`,
        destinationName: `${accountName} (Trang cá nhân)`
      });
    }

    if (platform === 'tiktok') {
      const code = requestUrl.searchParams.get('code');
      if (!code) throw new Error('TikTok không trả authorization code');
      const body = new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: publicCallback('tiktok')
      });
      const token = await fetchJson('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body
      });
      const profile = await fetchJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url', {
        headers: { authorization: `Bearer ${token.access_token}` }
      });
      const user = profile?.data?.user || {};
      const accountName = user.display_name || `TikTok ${token.open_id || user.open_id || ''}`.trim();
      const connectionId = saveConnection('tiktok', accountName, token, { openId: token.open_id || user.open_id || '' });
      return appRedirect(res, platform, 'ok', { connectionId, accountName });
    }

    if (platform === 'shopee') {
      const code = requestUrl.searchParams.get('code');
      const shopId = requestUrl.searchParams.get('shop_id');
      if (!code || !shopId) throw new Error('Shopee không trả code/shop_id');
      const apiPath = '/api/v2/auth/token/get';
      const timestamp = Math.floor(Date.now() / 1000);
      const sign = hmacSha256Hex(SHOPEE_PARTNER_KEY, `${SHOPEE_PARTNER_ID}${apiPath}${timestamp}`);
      const tokenUrl = new URL(`${SHOPEE_HOST}${apiPath}`);
      tokenUrl.searchParams.set('partner_id', SHOPEE_PARTNER_ID);
      tokenUrl.searchParams.set('timestamp', String(timestamp));
      tokenUrl.searchParams.set('sign', sign);
      const token = await fetchJson(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(SHOPEE_PARTNER_ID) })
      });
      if (token.error) throw new Error(token.message || token.error);
      const accountName = `Shopee Shop ${shopId}`;
      const connectionId = saveConnection('shopee', accountName, token, { shopId: Number(shopId) });
      return appRedirect(res, platform, 'ok', { connectionId, accountName });
    }

    return appRedirect(res, platform, 'error', { message: 'Nền tảng chưa được hỗ trợ' });
  } catch (e) {
    console.error(`[oauth ${platform}]`, e);
    return appRedirect(res, platform, 'error', { message: e.message || 'Đăng nhập thất bại' });
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function keyOk(req, requestUrl) {
  if (!API_KEY) return true;
  const header = req.headers['x-shoplive-key'];
  const query = requestUrl.searchParams.get('key');
  return header === API_KEY || query === API_KEY;
}

function commandExists(command) {
  return new Promise(resolve => {
    const args = command === 'ffmpeg' ? ['-version'] : ['--version'];
    execFile(command, args, { timeout: 4000 }, error => resolve(!error));
  });
}

function readJsonBody(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let text = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      text += chunk;
    });
    req.on('end', () => {
      try { resolve(text ? JSON.parse(text) : {}); }
      catch { reject(new Error('JSON body không hợp lệ')); }
    });
    req.on('error', reject);
  });
}

function requireFacebookConnection(connectionId) {
  const connection = oauthConnections.get(String(connectionId || ''));
  if (!connection || connection.platform !== 'facebook') throw new Error('Liên kết Facebook không hợp lệ hoặc đã hết hạn');
  if (!connection.tokens?.access_token) throw new Error('Facebook access token không còn tồn tại trên máy chủ');
  return connection;
}

async function facebookPageAccounts(connection) {
  const graphBase = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}`;
  const url = new URL(`${graphBase}/me/accounts`);
  url.searchParams.set('fields', 'id,name,access_token,tasks');
  url.searchParams.set('limit', '100');
  url.searchParams.set('access_token', connection.tokens.access_token);
  const body = await fetchJson(url);
  return Array.isArray(body.data) ? body.data : [];
}

async function facebookDestinations(connection) {
  const userId = String(connection.extra?.userId || '');
  const destinations = [];
  if (userId) {
    destinations.push({ id: `user:${userId}`, name: `${connection.accountName} (Trang cá nhân)`, type: 'user' });
  }
  const pages = await facebookPageAccounts(connection);
  for (const page of pages) {
    if (!page?.id || !page?.access_token) continue;
    destinations.push({ id: `page:${page.id}`, name: page.name || `Page ${page.id}`, type: 'page' });
  }
  return destinations;
}

async function resolveFacebookDestination(connection, destinationId) {
  const raw = String(destinationId || '');
  if (raw.startsWith('user:')) {
    const id = raw.slice(5);
    if (!id || id !== String(connection.extra?.userId || '')) throw new Error('Trang cá nhân Facebook không khớp tài khoản đã liên kết');
    return { id, name: connection.accountName, type: 'user', accessToken: connection.tokens.access_token, publicId: raw };
  }
  if (raw.startsWith('page:')) {
    const id = raw.slice(5);
    const pages = await facebookPageAccounts(connection);
    const page = pages.find(item => String(item.id) === id);
    if (!page?.access_token) throw new Error('Không lấy được quyền phát lên Page này. Hãy liên kết lại Facebook và cấp đủ quyền.');
    return { id, name: page.name || `Page ${id}`, type: 'page', accessToken: page.access_token, publicId: raw };
  }
  throw new Error('Chưa chọn Trang cá nhân/Page Facebook để phát');
}

async function handleFacebookDestinations(req, res) {
  const body = await readJsonBody(req);
  const connection = requireFacebookConnection(body.connection_id);
  const destinations = await facebookDestinations(connection);
  return json(res, 200, { ok: true, destinations });
}

async function handleFacebookLiveStart(req, res) {
  const body = await readJsonBody(req);
  const connection = requireFacebookConnection(body.connection_id);
  const destination = await resolveFacebookDestination(connection, body.destination_id);
  const graphBase = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}`;
  const url = new URL(`${graphBase}/${encodeURIComponent(destination.id)}/live_videos`);
  const form = new URLSearchParams();
  form.set('status', 'LIVE_NOW');
  form.set('title', String(body.title || 'ShopLive AI').slice(0, 255));
  const description = String(body.description || '').slice(0, 5000);
  if (description) form.set('description', description);
  form.set('access_token', destination.accessToken);

  const created = await fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const liveVideoId = String(created.id || '');
  if (!liveVideoId) throw new Error('Facebook không trả LiveVideo ID');

  let secureStreamUrl = String(created.secure_stream_url || '');
  if (!secureStreamUrl) {
    const detailUrl = new URL(`${graphBase}/${encodeURIComponent(liveVideoId)}`);
    detailUrl.searchParams.set('fields', 'secure_stream_url,status');
    detailUrl.searchParams.set('access_token', destination.accessToken);
    const detail = await fetchJson(detailUrl);
    secureStreamUrl = String(detail.secure_stream_url || '');
  }
  if (!secureStreamUrl.startsWith('rtmps://')) {
    // Do not downgrade to insecure RTMP. Meta's current Live requirements use RTMPS.
    throw new Error('Facebook không trả secure_stream_url (RTMPS). Kiểm tra quyền Live Video API của Meta App.');
  }

  return json(res, 200, {
    ok: true,
    live_video_id: liveVideoId,
    secure_stream_url: secureStreamUrl,
    destination_id: destination.publicId,
    destination_name: destination.name
  });
}

async function handleFacebookLiveStatus(req, res) {
  const body = await readJsonBody(req);
  const connection = requireFacebookConnection(body.connection_id);
  const destination = await resolveFacebookDestination(connection, body.destination_id);
  const liveVideoId = String(body.live_video_id || '');
  if (!liveVideoId) throw new Error('Thiếu LiveVideo ID');
  const graphBase = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}`;
  const url = new URL(`${graphBase}/${encodeURIComponent(liveVideoId)}`);
  url.searchParams.set('fields', 'status');
  url.searchParams.set('access_token', destination.accessToken);
  const detail = await fetchJson(url);
  return json(res, 200, { ok: true, status: String(detail.status || 'UNKNOWN') });
}

async function handleFacebookLiveEnd(req, res) {
  const body = await readJsonBody(req);
  const connection = requireFacebookConnection(body.connection_id);
  const destination = await resolveFacebookDestination(connection, body.destination_id);
  const liveVideoId = String(body.live_video_id || '');
  if (!liveVideoId) throw new Error('Thiếu LiveVideo ID');
  const graphBase = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}`;
  const url = new URL(`${graphBase}/${encodeURIComponent(liveVideoId)}`);
  const form = new URLSearchParams({ end_live_video: 'true', access_token: destination.accessToken });
  const result = await fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form
  });
  return json(res, 200, { ok: true, success: result.success !== false });
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(v => !Number.isInteger(v) || v < 0 || v > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224;
}

function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) {
    const value = ip.toLowerCase();
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') ||
      value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') ||
      value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
  }
  return true;
}

function supportedShareHost(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') ||
    host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.watch' ||
    host === 'tiktok.com' || host.endsWith('.tiktok.com') ||
    host === 'vimeo.com' || host.endsWith('.vimeo.com') ||
    host === 'instagram.com' || host.endsWith('.instagram.com');
}

function looksDirectMedia(parsed) {
  return /\.(m3u8|mpd|mp4|mov|m4v|webm|mkv|ts)(?:$|[?#])/i.test(parsed.href);
}

async function safePublicUrl(raw) {
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Chỉ nhận link http/https');
  if (parsed.username || parsed.password) throw new Error('Không nhận URL có user/password');
  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local')) throw new Error('Không nhận địa chỉ nội bộ');

  // Resolver is intentionally limited to known public video pages or obvious direct media URLs.
  if (!supportedShareHost(host) && !looksDirectMedia(parsed)) {
    throw new Error('Link chưa được Smart Link hỗ trợ');
  }

  const directIp = net.isIP(host);
  if (directIp && isPrivateAddress(host)) throw new Error('Không nhận IP nội bộ/private');
  if (!directIp) {
    const answers = await dns.lookup(host, { all: true, verbatim: true });
    if (!answers.length || answers.some(item => isPrivateAddress(item.address))) {
      throw new Error('Tên miền trỏ tới địa chỉ nội bộ/private');
    }
  }
  return parsed.toString();
}

function ytdlpPipeArgs(sourceUrl) {
  const args = [
    '--no-playlist', '--no-progress', '--no-warnings',
    '-f', 'best[height<=1080]/best',
    '-o', '-', sourceUrl
  ];
  if (YTDLP_COOKIES_FILE) args.unshift('--cookies', YTDLP_COOKIES_FILE);
  return args;
}

function ffmpegTranscodeTail() {
  return [
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=${RESOLUTION}:force_original_aspect_ratio=decrease,pad=${RESOLUTION}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-r', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-b:v', VIDEO_BITRATE, '-maxrate', VIDEO_BITRATE, '-bufsize', '5000k', '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-f', 'mpegts', 'pipe:1'
  ];
}

function ffmpegForDirect(sourceUrl) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', sourceUrl,
    ...ffmpegTranscodeTail()
  ];
}

function ffmpegForPipe() {
  return ['-hide_banner', '-loglevel', 'warning', '-i', 'pipe:0', ...ffmpegTranscodeTail()];
}

async function handleSource(req, res, requestUrl) {
  if (!keyOk(req, requestUrl)) return json(res, 401, { ok: false, error: 'invalid gateway key' });
  const raw = requestUrl.searchParams.get('url');
  if (!raw) return json(res, 400, { ok: false, error: 'missing url' });

  let sourceUrl;
  try { sourceUrl = await safePublicUrl(raw); }
  catch (e) { return json(res, 400, { ok: false, error: e.message }); }

  const parsed = new URL(sourceUrl);
  const pageSource = supportedShareHost(parsed.hostname);

  res.writeHead(200, {
    'content-type': 'video/mp2t',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'connection': 'keep-alive',
    'x-shoplive-source': pageSource ? 'smart-link' : 'direct'
  });

  let extractor = null;
  const ff = spawn(FFMPEG, pageSource ? ffmpegForPipe() : ffmpegForDirect(sourceUrl), {
    stdio: [pageSource ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true
  });

  if (pageSource) {
    extractor = spawn(YTDLP, ytdlpPipeArgs(sourceUrl), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    extractor.stdout.pipe(ff.stdin);
    extractor.stderr.on('data', chunk => console.error('[yt-dlp]', chunk.toString().trim()));
    extractor.on('error', err => {
      console.error('[yt-dlp error]', err.message);
      if (!ff.stdin.destroyed) ff.stdin.destroy(err);
    });
    extractor.on('close', code => {
      if (code !== 0) console.error(`yt-dlp exited ${code}`);
      if (!ff.stdin.destroyed) ff.stdin.end();
    });
  }

  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    if (extractor && !extractor.killed) extractor.kill('SIGKILL');
    if (!ff.killed) ff.kill('SIGKILL');
  };
  req.on('close', stop);
  res.on('close', stop);

  ff.stdout.pipe(res);
  ff.stderr.on('data', chunk => console.error('[ffmpeg]', chunk.toString().trim()));
  ff.on('error', err => {
    console.error('[ffmpeg error]', err.message);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'ffmpeg unavailable' });
    else res.destroy(err);
  });
  ff.on('close', code => {
    if (!closed && code !== 0) console.error(`ffmpeg exited ${code}`);
    if (!res.writableEnded) res.end();
    closed = true;
    if (extractor && !extractor.killed) extractor.kill('SIGKILL');
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const oauthStartMatch = requestUrl.pathname.match(/^\/oauth\/(facebook|tiktok|shopee)\/start$/);
    if (oauthStartMatch && req.method === 'GET') return await oauthStart(req, res, requestUrl, oauthStartMatch[1]);
    const oauthCallbackMatch = requestUrl.pathname.match(/^\/oauth\/(facebook|tiktok|shopee)\/callback$/);
    if (oauthCallbackMatch && req.method === 'GET') return await oauthCallback(req, res, requestUrl, oauthCallbackMatch[1]);

    if (requestUrl.pathname === '/api/facebook/destinations' && req.method === 'POST') return await handleFacebookDestinations(req, res);
    if (requestUrl.pathname === '/api/facebook/live/start' && req.method === 'POST') return await handleFacebookLiveStart(req, res);
    if (requestUrl.pathname === '/api/facebook/live/status' && req.method === 'POST') return await handleFacebookLiveStatus(req, res);
    if (requestUrl.pathname === '/api/facebook/live/end' && req.method === 'POST') return await handleFacebookLiveEnd(req, res);

    if (requestUrl.pathname === '/healthz') {
      const [ffmpeg, ytdlp] = await Promise.all([commandExists(FFMPEG), commandExists(YTDLP)]);
      return json(res, ffmpeg && ytdlp ? 200 : 503, { ok: ffmpeg && ytdlp });
    }
    if (requestUrl.pathname === '/health') {
      if (!keyOk(req, requestUrl)) return json(res, 401, { ok: false, error: 'invalid gateway key' });
      const [ffmpeg, ytdlp] = await Promise.all([commandExists(FFMPEG), commandExists(YTDLP)]);
      return json(res, ffmpeg && ytdlp ? 200 : 503, {
        ok: ffmpeg && ytdlp,
        ffmpeg,
        ytdlp,
        resolution: RESOLUTION.replace(':', 'x')
      });
    }
    if (requestUrl.pathname === '/api/source' && req.method === 'GET') return await handleSource(req, res, requestUrl);
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { ok: false, error: String(e?.message || 'internal error').slice(0, 500) });
    else res.destroy(e);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ShopLive Gateway listening on http://${HOST}:${PORT}`);
  if (!API_KEY) console.warn('WARNING: GATEWAY_API_KEY is empty. Set a key before exposing this service outside your LAN.');
  if (!OAUTH_STORE_KEY) console.warn('WARNING: OAUTH_STORE_KEY is empty. OAuth tokens will only live in memory and are lost when Gateway restarts.');
  if (PUBLIC_BASE_URL && !PUBLIC_BASE_URL.startsWith('https://')) console.warn('WARNING: PUBLIC_BASE_URL must be HTTPS for provider OAuth callbacks.');
});
