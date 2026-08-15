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

const GATEWAY_VERSION = '2.7.0';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.GATEWAY_API_KEY || '';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const YTDLP = process.env.YTDLP || 'yt-dlp';
const RESOLUTION = process.env.RESOLUTION || '720:1280';
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || '2500k';
let YTDLP_COOKIES_FILE = (process.env.YTDLP_COOKIES_FILE || '').trim();
const YTDLP_COOKIES_B64 = (process.env.YTDLP_COOKIES_B64 || '').trim();
if (!YTDLP_COOKIES_FILE && YTDLP_COOKIES_B64) {
  try {
    YTDLP_COOKIES_FILE = '/tmp/shoplive-ytdlp-cookies.txt';
    fs.writeFileSync(YTDLP_COOKIES_FILE, Buffer.from(YTDLP_COOKIES_B64, 'base64'), { mode: 0o600 });
  } catch (e) {
    console.error('[yt-dlp cookies] cannot decode YTDLP_COOKIES_B64:', e.message);
    YTDLP_COOKIES_FILE = '';
  }
}

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
    execFile(command, ['--version'], { timeout: 4000 }, error => resolve(!error));
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

const sourceResolveCache = new Map();

function ytdlpJsonArgs(sourceUrl) {
  // Resolve the webpage first instead of piping yt-dlp's downloaded file to ffmpeg. This lets
  // yt-dlp select separate best video + best audio streams (common on YouTube) while ffmpeg reads
  // both CDN URLs directly and transcodes them in real time.
  const args = [
    '--no-playlist', '--no-progress', '--no-warnings',
    '--socket-timeout', '15', '--retries', '2', '--fragment-retries', '2',
    '--skip-download', '--dump-single-json',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/best',
    sourceUrl
  ];
  if (YTDLP_COOKIES_FILE) args.unshift('--cookies', YTDLP_COOKIES_FILE);
  return args;
}

function runYtDlpJson(sourceUrl) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      ytdlpJsonArgs(sourceUrl),
      { timeout: 35_000, maxBuffer: 12 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || 'yt-dlp failed').trim().slice(-1400);
          return reject(new Error(detail || 'yt-dlp failed'));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`yt-dlp trả dữ liệu không hợp lệ: ${e.message}`));
        }
      }
    );
  });
}

function safeHttpHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const blocked = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
  const clean = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = String(rawKey || '').trim();
    const value = String(rawValue ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!key || !value || blocked.has(key.toLowerCase())) continue;
    if (!/^[A-Za-z0-9-]+$/.test(key)) continue;
    clean[key] = value.slice(0, 2000);
  }
  return clean;
}

function formatToInput(format, fallbackHeaders = {}) {
  const url = String(format?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    url,
    headers: safeHttpHeaders({ ...fallbackHeaders, ...(format?.http_headers || {}) })
  };
}

function pickResolvedInputs(info) {
  const baseHeaders = safeHttpHeaders(info?.http_headers || {});
  const requested = Array.isArray(info?.requested_formats) ? info.requested_formats : [];

  if (requested.length) {
    const videoFmt = requested.find(f => f && f.vcodec && f.vcodec !== 'none') || null;
    const audioFmt = requested.find(f => f && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      || requested.find(f => f && f.acodec && f.acodec !== 'none') || null;
    const video = formatToInput(videoFmt, baseHeaders);
    const audio = formatToInput(audioFmt, baseHeaders);
    if (!video) throw new Error('yt-dlp không trả URL video có thể phát');
    if (audio && audio.url !== video.url) return { inputs: [video, audio], videoIndex: 0, audioIndex: 1 };
    return { inputs: [video], videoIndex: 0, audioIndex: audio ? 0 : null };
  }

  const combined = formatToInput(info, baseHeaders);
  if (!combined) throw new Error('yt-dlp không trả URL media có thể phát');
  const hasAudio = info?.acodec && info.acodec !== 'none';
  return { inputs: [combined], videoIndex: 0, audioIndex: hasAudio ? 0 : null };
}

async function resolvePageMedia(sourceUrl) {
  const now = Date.now();
  const cached = sourceResolveCache.get(sourceUrl);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = runYtDlpJson(sourceUrl)
    .then(info => pickResolvedInputs(info))
    .catch(error => {
      sourceResolveCache.delete(sourceUrl);
      throw error;
    });
  // Short cache is enough to deduplicate the video/audio ExoPlayer requests without holding
  // signed CDN URLs for too long.
  sourceResolveCache.set(sourceUrl, { expiresAt: now + 90_000, promise });
  return promise;
}

function ffmpegHeaderValue(headers) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return '';
  return entries.map(([key, value]) => `${key}: ${value}\r\n`).join('');
}

function ffmpegInputArgs(input) {
  const args = [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000'
  ];
  const headerValue = ffmpegHeaderValue(input.headers);
  if (headerValue) args.push('-headers', headerValue);
  args.push('-i', input.url);
  return args;
}

function ffmpegTranscodeTail(videoIndex = 0, audioIndex = 0, container = 'ts') {
  const args = [
    '-map', `${videoIndex}:v:0`,
  ];
  if (audioIndex === null || audioIndex === undefined) args.push('-map', `${videoIndex}:a:0?`);
  else args.push('-map', `${audioIndex}:a:0?`);
  args.push(
    '-fflags', '+genpts',
    '-vf', `scale=${RESOLUTION}:force_original_aspect_ratio=decrease,pad=${RESOLUTION}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-r', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-b:v', VIDEO_BITRATE, '-maxrate', VIDEO_BITRATE, '-bufsize', '5000k', '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2'
  );

  // 2.7.0: prefer HTTP-FLV for Android Smart Link. FLV has a tiny fixed magic header,
  // is naturally streamable over chunked HTTP, and carries H.264/AAC without the MP4 brand/init
  // ambiguity seen on some proxies/devices. fMP4/TS stay available for older builds/debugging.
  if (container === 'flv') {
    args.push('-flvflags', 'no_duration_filesize', '-f', 'flv', 'pipe:1');
  } else if (container === 'fmp4') {
    args.push(
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '1000000',
      '-f', 'mp4', 'pipe:1'
    );
  } else {
    args.push('-f', 'mpegts', 'pipe:1');
  }
  return args;
}

function ffmpegForDirect(sourceUrl, container = 'ts') {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    ...ffmpegInputArgs({ url: sourceUrl, headers: {} }),
    ...ffmpegTranscodeTail(0, 0, container)
  ];
}

function ffmpegForResolved(resolved, container = 'ts') {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
  for (const input of resolved.inputs) args.push(...ffmpegInputArgs(input));
  args.push(...ffmpegTranscodeTail(resolved.videoIndex, resolved.audioIndex, container));
  return args;
}

function looksLikeTs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 188 * 3) return false;
  // Allow a small prefix, but require three consecutive MPEG-TS sync bytes 188 bytes apart.
  const maxOffset = Math.min(187, buffer.length - 188 * 3);
  for (let offset = 0; offset <= maxOffset; offset++) {
    if (buffer[offset] === 0x47 && buffer[offset + 188] === 0x47 && buffer[offset + 376] === 0x47) return true;
  }
  return false;
}

function looksLikeFlv(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 13) return false;
  // Signature 'FLV', version 1, flags include audio/video, DataOffset >= 9.
  if (buffer[0] !== 0x46 || buffer[1] !== 0x4c || buffer[2] !== 0x56) return false;
  if (buffer[3] !== 0x01) return false;
  const flags = buffer[4];
  if ((flags & 0x05) === 0) return false;
  const dataOffset = buffer.readUInt32BE(5);
  return dataOffset >= 9 && dataOffset <= buffer.length;
}

function looksLikeFmp4(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  // A valid FFmpeg fragmented MP4 starts with an ISO-BMFF box such as ftyp, followed by moov.
  // Search only the initialization prefix so random payload bytes cannot satisfy this check.
  const head = buffer.subarray(0, Math.min(buffer.length, 64 * 1024));
  let offset = 0;
  let sawFtyp = false;
  let sawMoov = false;
  while (offset + 8 <= head.length) {
    let size = head.readUInt32BE(offset);
    const type = head.toString('ascii', offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > head.length) break;
      const big = head.readBigUInt64BE(offset + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
    } else if (size === 0) {
      size = head.length - offset;
    }
    if (size < 8) break;
    if (type === 'ftyp') sawFtyp = true;
    if (type === 'moov') sawMoov = true;
    if (sawFtyp && sawMoov) return true;
    if (offset + size > head.length) break;
    offset += size;
  }
  return sawFtyp && buffer.length >= 1024;
}

function probeFfmpegOutput(ff, container, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let stderrTail = '';
    let settled = false;

    const timer = setTimeout(() => fail(new Error(`FFmpeg không tạo dữ liệu ${container} sau ${Math.round(timeoutMs / 1000)} giây`)), timeoutMs);
    const onStderr = chunk => {
      stderrTail = (stderrTail + chunk.toString()).slice(-5000);
    };
    const onError = err => fail(err);
    const onClose = code => {
      if (!settled) fail(new Error((stderrTail.trim() || `FFmpeg kết thúc sớm (code ${code})`).slice(-1800)));
    };
    const onData = chunk => {
      if (settled) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total > 512 * 1024) {
        const prefix = Buffer.concat(chunks, total);
        return fail(new Error(`FFmpeg có dữ liệu nhưng không phải ${container}; prefix=${prefix.subarray(0, 24).toString('hex')}`));
      }
      if (total < 1024) return;
      const prefix = Buffer.concat(chunks, total);
      const valid = container === 'flv' ? looksLikeFlv(prefix) : (container === 'fmp4' ? looksLikeFmp4(prefix) : looksLikeTs(prefix));
      if (!valid) return;

      settled = true;
      clearTimeout(timer);
      ff.stdout.pause();
      ff.stdout.off('data', onData);
      ff.stderr.off('data', onStderr);
      ff.off('error', onError);
      ff.off('close', onClose);
      resolve({ prefix, stderrTail });
    };

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ff.stdout.off('data', onData);
      ff.stderr.off('data', onStderr);
      ff.off('error', onError);
      ff.off('close', onClose);
      if (!ff.killed) ff.kill('SIGKILL');
      const detail = stderrTail.trim();
      reject(new Error(detail ? `${error.message} • ${detail.slice(-1600)}` : error.message));
    }

    ff.stderr.on('data', onStderr);
    ff.on('error', onError);
    ff.on('close', onClose);
    ff.stdout.on('data', onData);
  });
}

async function handleSource(req, res, requestUrl) {
  if (!keyOk(req, requestUrl)) return json(res, 401, { ok: false, error: 'invalid gateway key' });
  const raw = requestUrl.searchParams.get('url');
  if (!raw) return json(res, 400, { ok: false, error: 'missing url' });

  const requestedContainer = requestUrl.searchParams.get('container');
  const container = requestedContainer === 'flv' ? 'flv' : (requestedContainer === 'fmp4' ? 'fmp4' : 'ts');

  let sourceUrl;
  try { sourceUrl = await safePublicUrl(raw); }
  catch (e) { return json(res, 400, { ok: false, error: e.message }); }

  const parsed = new URL(sourceUrl);
  const pageSource = supportedShareHost(parsed.hostname);
  let ffArgs;
  if (pageSource) {
    try {
      const resolved = await resolvePageMedia(sourceUrl);
      ffArgs = ffmpegForResolved(resolved, container);
    } catch (e) {
      const message = String(e?.message || 'Không tách được link').slice(-1600);
      console.error('[smart-link resolve]', message);
      return json(res, 502, {
        ok: false,
        error: message,
        gatewayVersion: GATEWAY_VERSION,
        hint: /cookie|sign in|bot|login/i.test(message)
          ? 'Nguồn yêu cầu đăng nhập/chống bot. Cấu hình YTDLP_COOKIES_B64 trên Gateway rồi deploy lại.'
          : 'Không tách được link công khai. Kiểm tra link còn xem được và không DRM.'
      });
    }
  } else {
    ffArgs = ffmpegForDirect(sourceUrl, container);
  }

  const ff = spawn(FFMPEG, ffArgs, {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });

  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    if (!ff.killed) ff.kill('SIGKILL');
  };
  res.on('close', stop);
  req.on('error', stop);

  // 2.7.0: never return HTTP 200 until FFmpeg has emitted a valid container signature.
  // Previously a failed FFmpeg process produced an empty HTTP 200 body, so Media3 reported
  // ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED instead of the real yt-dlp/FFmpeg error.
  let probe;
  try {
    probe = await probeFfmpegOutput(ff, container);
  } catch (e) {
    const message = String(e?.message || 'FFmpeg không tạo được media').slice(-2200);
    console.error('[smart-link ffmpeg probe]', message);
    if (!res.destroyed && !res.headersSent) {
      return json(res, 502, {
        ok: false,
        error: message,
        gatewayVersion: GATEWAY_VERSION,
        hint: 'Gateway không tạo được luồng H.264/AAC. Xem Render logs; nếu là YouTube/Facebook chống bot, cập nhật yt-dlp/cookies.'
      });
    }
    return;
  }

  if (closed || res.destroyed) return stop();

  res.writeHead(200, {
    'content-type': container === 'flv' ? 'video/x-flv' : (container === 'fmp4' ? 'video/mp4' : 'video/mp2t'),
    'cache-control': 'no-store, no-cache, must-revalidate',
    'connection': 'keep-alive',
    'x-shoplive-source': pageSource ? 'smart-link-resolved' : 'direct',
    'x-shoplive-container': container,
    'x-shoplive-gateway-version': GATEWAY_VERSION
  });
  res.write(probe.prefix);

  ff.stdout.pipe(res);
  ff.stdout.resume();
  ff.stderr.on('data', chunk => console.error('[ffmpeg]', chunk.toString().trim()));
  ff.on('error', err => {
    console.error('[ffmpeg error]', err.message);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'ffmpeg unavailable', gatewayVersion: GATEWAY_VERSION });
    else res.destroy(err);
  });
  ff.on('close', code => {
    if (!closed && code !== 0) console.error(`ffmpeg exited ${code}`);
    if (!res.writableEnded) res.end();
    closed = true;
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
      return json(res, ffmpeg && ytdlp ? 200 : 503, { ok: ffmpeg && ytdlp, version: GATEWAY_VERSION });
    }
    if (requestUrl.pathname === '/health') {
      if (!keyOk(req, requestUrl)) return json(res, 401, { ok: false, error: 'invalid gateway key' });
      const [ffmpeg, ytdlp] = await Promise.all([commandExists(FFMPEG), commandExists(YTDLP)]);
      return json(res, ffmpeg && ytdlp ? 200 : 503, {
        ok: ffmpeg && ytdlp,
        ffmpeg,
        ytdlp,
        version: GATEWAY_VERSION,
        cookiesConfigured: Boolean(YTDLP_COOKIES_FILE),
        resolution: RESOLUTION.replace(':', 'x')
      });
    }
    if ((requestUrl.pathname === '/api/source' || requestUrl.pathname === '/api/source-v2' || requestUrl.pathname === '/api/source-v3') && req.method === 'GET') return await handleSource(req, res, requestUrl);
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { ok: false, error: String(e?.message || 'internal error').slice(0, 500) });
    else res.destroy(e);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ShopLive Gateway ${GATEWAY_VERSION} listening on http://${HOST}:${PORT}`);
  if (!API_KEY) console.warn('WARNING: GATEWAY_API_KEY is empty. Set a key before exposing this service outside your LAN.');
  if (!OAUTH_STORE_KEY) console.warn('WARNING: OAUTH_STORE_KEY is empty. OAuth tokens will only live in memory and are lost when Gateway restarts.');
  if (PUBLIC_BASE_URL && !PUBLIC_BASE_URL.startsWith('https://')) console.warn('WARNING: PUBLIC_BASE_URL must be HTTPS for provider OAuth callbacks.');
});
