import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { URL } from 'node:url';

const VERSION = '2.8.4-online-worker-fixed1';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const API_KEY = (process.env.WORKER_API_KEY || '').trim();
const SMART_LINK_BASE_URL = (process.env.SMART_LINK_BASE_URL || 'https://shoplive-smart-link.onrender.com').replace(/\/$/, '');
const SMART_LINK_KEY = (process.env.SMART_LINK_KEY || '').trim();
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/shoplive-online/uploads';
const MAX_SESSIONS = numericSetting(process.env.MAX_SESSIONS, 3, 1, 3);
const MAX_UPLOAD_BYTES = numericSetting(process.env.MAX_UPLOAD_BYTES, 1610612736, 50 * 1024 * 1024);
const MAX_RESTARTS = 6;
const SESSION_RETENTION_MS = numericSetting(process.env.SESSION_RETENTION_MS, 6 * 60 * 60 * 1000, 60_000);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const sessions = new Map();
const uploads = new Map();
let pendingSessionCreates = 0;

function numericSetting(value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  });
  res.end(text);
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('JSON body quá lớn'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('JSON không hợp lệ')); }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!API_KEY) return false;
  const header = String(req.headers['x-shoplive-key'] || '');
  const actual = Buffer.from(header);
  const expected = Buffer.from(API_KEY);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function safeId(value) {
  return /^[a-zA-Z0-9_-]{6,80}$/.test(value || '') ? value : '';
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

function activeSessionCount() {
  let count = 0;
  for (const s of sessions.values()) if (s.shouldRun && ['STARTING', 'RUNNING', 'RECONNECTING'].includes(s.state)) count++;
  return count;
}

function publicSession(s) {
  return {
    id: s.id,
    state: s.state,
    sourceType: s.sourceType,
    sourceLabel: s.sourceLabel,
    bitrate: s.bitrate || '',
    speed: s.speed || '',
    frame: s.frame || 0,
    restartCount: s.restartCount || 0,
    loopCount: s.loopCount || 0,
    lastProgressAt: s.lastProgressAt ? new Date(s.lastProgressAt).toISOString() : '',
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    error: s.error || ''
  };
}

function commandOk(command, args) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: 8000 }, err => resolve(!err));
  });
}

async function smartLinkInput(rawUrl) {
  const target = new URL(rawUrl);
  const host = target.hostname.toLowerCase();
  const pageLink = host === 'youtu.be' || host.endsWith('youtube.com') || host.endsWith('facebook.com') ||
    host === 'fb.watch' || host.endsWith('tiktok.com') || host.endsWith('vimeo.com') || host.endsWith('instagram.com');
  if (!pageLink) return { input: rawUrl, kind: 'direct-url', h264Aac: false, sourceLabel: target.hostname };

  const probeUrl = new URL(`${SMART_LINK_BASE_URL}/api/probe-v5`);
  probeUrl.searchParams.set('url', rawUrl);
  const probeHeaders = { accept: 'application/json' };
  if (SMART_LINK_KEY) probeHeaders['x-shoplive-key'] = SMART_LINK_KEY;
  const response = await fetch(probeUrl, { headers: probeHeaders, signal: AbortSignal.timeout(120000) });
  const text = await response.text();
  let probe = {};
  try { probe = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(probe.error || probe.hint || `Smart Link probe HTTP ${response.status}`);
  const width = Number(probe.encoderWidth || probe.displayWidth || 0);
  const height = Number(probe.encoderHeight || probe.displayHeight || 0);
  if (!(width > 0 && height > 0)) throw new Error('Smart Link không trả kích thước native');

  const sourceUrl = new URL(`${SMART_LINK_BASE_URL}/api/source-v5`);
  sourceUrl.searchParams.set('url', rawUrl);
  sourceUrl.searchParams.set('container', 'flv');
  sourceUrl.searchParams.set('w', String(width));
  sourceUrl.searchParams.set('h', String(height));
  return {
    input: sourceUrl.toString(),
    inputHeaders: SMART_LINK_KEY ? `X-ShopLive-Key: ${SMART_LINK_KEY}\r\n` : '',
    kind: 'smart-link',
    h264Aac: true,
    sourceLabel: `${host} ${width}x${height}`
  };
}

function ffprobeJson(input) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,width,height:stream_tags=rotate:stream_side_data=rotation', '-of', 'json', input];
    execFile(FFPROBE, args, { timeout: 25000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffprobe: ${(stderr || err.message).slice(-400)}`));
      try { resolve(JSON.parse(stdout || '{}')); }
      catch { reject(new Error('ffprobe trả JSON lỗi')); }
    });
  });
}

async function inputPlan(sourceType, sourceUrl, uploadId) {
  if (sourceType === 'upload') {
    const id = safeId(uploadId);
    if (!id) throw new Error('uploadId không hợp lệ');
    const meta = uploads.get(id);
    const file = meta?.path || path.join(UPLOAD_DIR, id);
    if (!fs.existsSync(file)) throw new Error('Video upload không còn trên worker');
    const probe = await ffprobeJson(file);
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const v = streams.find(x => x.codec_type === 'video');
    const a = streams.find(x => x.codec_type === 'audio');
    if (!v) throw new Error('File upload không có track video');
    const rotation = Number(v.tags?.rotate || v.side_data_list?.find?.(x => x.rotation != null)?.rotation || 0);
    const canCopyVideo = String(v.codec_name).toLowerCase() === 'h264' && rotation === 0;
    const canCopyAudio = a && String(a.codec_name).toLowerCase() === 'aac';
    return {
      input: file,
      kind: 'upload',
      sourceLabel: meta?.filename || `upload ${id}`,
      hasAudio: !!a,
      copyVideo: canCopyVideo,
      copyAudio: !!canCopyAudio
    };
  }

  if (sourceType === 'url') {
    if (!/^https?:\/\//i.test(sourceUrl || '')) throw new Error('sourceUrl phải là http/https');
    const resolved = await smartLinkInput(sourceUrl);
    if (resolved.kind === 'smart-link') {
      return { ...resolved, hasAudio: true, copyVideo: true, copyAudio: true };
    }
    let probe = null;
    try { probe = await ffprobeJson(resolved.input); } catch {}
    const streams = Array.isArray(probe?.streams) ? probe.streams : [];
    const v = streams.find(x => x.codec_type === 'video');
    const a = streams.find(x => x.codec_type === 'audio');
    const rotation = Number(v?.tags?.rotate || v?.side_data_list?.find?.(x => x.rotation != null)?.rotation || 0);
    return {
      ...resolved,
      hasAudio: !!a,
      copyVideo: !!v && String(v.codec_name).toLowerCase() === 'h264' && rotation === 0,
      copyAudio: !!a && String(a.codec_name).toLowerCase() === 'aac'
    };
  }
  throw new Error('sourceType chỉ nhận upload hoặc url');
}

function buildFfmpegArgs(session) {
  const p = session.plan;
  // Machine-readable progress is required here. Normal FFmpeg status output is not
  // reliable for stream-copy and may omit frame= even while RTMP bytes are flowing.
  const args = ['-hide_banner', '-loglevel', 'info', '-nostats', '-progress', 'pipe:2'];
  if (p.kind !== 'upload') {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '8',
      '-rw_timeout', '120000000', '-thread_queue_size', '4096');
  }
  if (p.kind === 'upload' && session.loop) args.push('-stream_loop', '-1');
  if (p.inputHeaders) args.push('-headers', p.inputHeaders);
  args.push('-re', '-i', p.input);

  if (!p.hasAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }
  args.push('-map', '0:v:0');
  args.push('-map', p.hasAudio ? '0:a:0?' : '1:a:0');

  if (p.copyVideo) {
    args.push('-c:v', 'copy');
  } else {
    // FFmpeg autorotate is enabled by default. Evenize after rotation without forcing 720/1080.
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-b:v', '3500k', '-maxrate', '4500k', '-bufsize', '7000k',
      '-g', '60', '-keyint_min', '60');
  }

  if (p.copyAudio) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2');

  args.push('-flvflags', 'no_duration_filesize', '-f', 'flv', session.rtmpUrl);
  return args;
}

function markMediaProgress(session) {
  session.lastProgressAt = Date.now();
  session.state = 'RUNNING';
  session.error = '';
  // Only consecutive failures are capped. A recovered live can reconnect again later.
  session.consecutiveFailures = 0;
  session.updatedAt = new Date().toISOString();
}

function positiveTime(value) {
  if (!value || value === 'N/A') return false;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 0;
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return false;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) > 0;
}

function parseProgressLine(session, rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) return;
  let hasMediaProgress = false;
  const pair = /^([a-z_]+)=(.*)$/.exec(line);
  if (pair) {
    const key = pair[1];
    const value = pair[2].trim();
    if (key === 'frame') {
      const frame = Number(value);
      if (Number.isFinite(frame)) session.frame = Math.max(0, frame);
      hasMediaProgress = frame > 0;
    } else if (key === 'bitrate') {
      session.bitrate = value;
    } else if (key === 'speed') {
      session.speed = value;
    } else if (key === 'total_size') {
      const bytes = Number(value);
      if (Number.isFinite(bytes)) session.outputBytes = Math.max(0, bytes);
      hasMediaProgress = bytes > 0;
    } else if (key === 'out_time_us' || key === 'out_time_ms' || key === 'out_time') {
      hasMediaProgress = positiveTime(value);
    }
  } else {
    // Backward-compatible parsing for FFmpeg builds that still emit human stats.
    const frame = /frame=\s*(\d+)/.exec(line);
    const bitrate = /bitrate=\s*([^\s]+)/.exec(line);
    const speed = /speed=\s*([^\s]+)/.exec(line);
    const size = /size=\s*(\d+)kB/.exec(line);
    const time = /time=\s*([^\s]+)/.exec(line);
    if (frame) session.frame = Number(frame[1]);
    if (bitrate) session.bitrate = bitrate[1];
    if (speed) session.speed = speed[1];
    hasMediaProgress = Number(frame?.[1] || 0) > 0 || Number(size?.[1] || 0) > 0 || positiveTime(time?.[1]);
  }
  if (hasMediaProgress) markMediaProgress(session);
}

function parseProgress(session, text) {
  const combined = `${session.progressBuffer || ''}${String(text || '')}`;
  const lines = combined.split(/\r\n|\n|\r/);
  session.progressBuffer = lines.pop() || '';
  for (const line of lines) parseProgressLine(session, line);
  // Do not let a malformed/no-newline stderr line grow without bound.
  if (session.progressBuffer.length > 16_384) {
    parseProgressLine(session, session.progressBuffer);
    session.progressBuffer = '';
  }
}

function scheduleSessionCleanup(session) {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    if (sessions.get(session.id) === session && !session.shouldRun && !session.process) {
      sessions.delete(session.id);
    }
  }, SESSION_RETENTION_MS);
  session.cleanupTimer.unref?.();
}

function markTerminal(session, state, error = '') {
  session.shouldRun = false;
  session.state = state;
  session.error = error;
  session.updatedAt = new Date().toISOString();
  cleanupSessionUpload(session);
  scheduleSessionCleanup(session);
}

function scheduleRestart(session, reason, cleanExit = false) {
  if (!session.shouldRun) return;
  if (session.restartTimer) {
    clearTimeout(session.restartTimer);
    session.restartTimer = null;
  }
  if (cleanExit) {
    if (!session.loop) {
      markTerminal(session, 'STOPPED');
      return;
    }
    // A normal end-of-video is a loop, not a transport failure. It must not consume
    // the six consecutive reconnect attempts, otherwise a short clip would stop after six loops.
    session.loopCount = (session.loopCount || 0) + 1;
    session.state = 'RECONNECTING';
    session.error = '';
    session.updatedAt = new Date().toISOString();
    session.restartTimer = setTimeout(() => {
      session.restartTimer = null;
      if (session.shouldRun) startFfmpeg(session).catch(err => scheduleRestart(session, err.message, false));
    }, 700);
    session.restartTimer.unref?.();
    return;
  }

  session.restartCount += 1;
  session.consecutiveFailures = (session.consecutiveFailures || 0) + 1;
  if (session.consecutiveFailures > MAX_RESTARTS) {
    markTerminal(session, 'FAILED', reason || 'FFmpeg dừng quá số lần reconnect liên tiếp');
    return;
  }
  session.state = 'RECONNECTING';
  session.error = reason || '';
  session.updatedAt = new Date().toISOString();
  const delayMs = Math.min(1500 * session.consecutiveFailures, 8000);
  session.restartTimer = setTimeout(() => {
    session.restartTimer = null;
    if (session.shouldRun) startFfmpeg(session).catch(err => scheduleRestart(session, err.message, false));
  }, delayMs);
  session.restartTimer.unref?.();
}

function redactSensitive(value, session) {
  let text = String(value || '');
  if (session?.rtmpUrl) text = text.split(session.rtmpUrl).join('[RTMP_REDACTED]');
  if (SMART_LINK_KEY) text = text.split(SMART_LINK_KEY).join('[KEY_REDACTED]');
  return text;
}

async function startFfmpeg(session) {
  if (!session.shouldRun) return;
  if (session.process && session.process.exitCode === null) return;
  session.state = (session.restartCount || session.loopCount) ? 'RECONNECTING' : 'STARTING';
  session.progressBuffer = '';
  session.forcedReason = '';
  session.updatedAt = new Date().toISOString();
  const args = buildFfmpegArgs(session);
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  session.process = ff;
  let tail = '';
  let settled = false;
  const finishAttempt = (code, signal, spawnError = null) => {
    if (settled) return;
    settled = true;
    if (session.killTimer) {
      clearTimeout(session.killTimer);
      session.killTimer = null;
    }
    if (session.process === ff) session.process = null;
    if (!session.shouldRun) {
      markTerminal(session, 'STOPPED');
      return;
    }
    const clean = !spawnError && code === 0;
    const safeTail = redactSensitive(tail.replace(/\s+/g, ' ').slice(-800), session);
    const reason = session.forcedReason || (spawnError
      ? spawnError.message
      : clean ? 'Nguồn đã kết thúc' : `FFmpeg exit=${code ?? 'null'} signal=${signal ?? '-'} • ${safeTail}`);
    session.forcedReason = '';
    scheduleRestart(session, reason, clean);
  };
  ff.stderr.setEncoding('utf8');
  ff.stderr.on('data', chunk => {
    tail = (tail + chunk).slice(-5000);
    parseProgress(session, chunk);
  });
  ff.on('error', err => finishAttempt(null, null, err));
  ff.on('exit', (code, signal) => finishAttempt(code, signal));
}

async function createSession(body) {
  const rtmpUrl = String(body.rtmpUrl || '').trim();
  if (!/^rtmps?:\/\//i.test(rtmpUrl)) throw new Error('rtmpUrl không hợp lệ');
  const sourceType = String(body.sourceType || '').trim();
  const sourceUrl = String(body.sourceUrl || '').trim();
  const uploadId = String(body.uploadId || '').trim();
  if (activeSessionCount() + pendingSessionCreates >= MAX_SESSIONS) {
    throw new Error(`Worker đã đủ ${MAX_SESSIONS} phiên Online`);
  }
  pendingSessionCreates += 1;
  let plan;
  try {
    plan = await inputPlan(sourceType, sourceUrl, uploadId);
  } finally {
    pendingSessionCreates -= 1;
  }
  const id = randomId('live');
  const session = {
    id,
    sourceType,
    sourceLabel: plan.sourceLabel,
    plan,
    rtmpUrl,
    loop: body.loop !== false,
    shouldRun: true,
    state: 'STARTING',
    bitrate: '', speed: '', frame: 0, outputBytes: 0, lastProgressAt: 0,
    restartCount: 0, consecutiveFailures: 0, loopCount: 0,
    error: '', process: null, progressBuffer: '', restartTimer: null, killTimer: null, cleanupTimer: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  sessions.set(id, session);
  await startFfmpeg(session);
  return session;
}


function cleanupSessionUpload(session) {
  if (session?.sourceType !== 'upload') return;
  const file = session?.plan?.input;
  if (file && String(file).startsWith(UPLOAD_DIR + path.sep)) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  }
  for (const [id, meta] of uploads.entries()) {
    if (meta?.path === file) uploads.delete(id);
  }
}

function stopSession(session) {
  session.shouldRun = false;
  session.state = 'STOPPING';
  session.updatedAt = new Date().toISOString();
  if (session.restartTimer) {
    clearTimeout(session.restartTimer);
    session.restartTimer = null;
  }
  const ff = session.process;
  if (ff && ff.exitCode === null) {
    try { ff.kill('SIGTERM'); } catch {}
    session.killTimer = setTimeout(() => {
      session.killTimer = null;
      // ChildProcess.killed only means a signal was sent. It does not prove the
      // process exited, so use the live process reference for the SIGKILL fallback.
      if (session.process === ff && ff.exitCode === null) {
        try { ff.kill('SIGKILL'); } catch {}
      }
    }, 5000);
    session.killTimer.unref?.();
  } else {
    markTerminal(session, 'STOPPED');
  }
}

function uploadFile(req, res, uploadId) {
  const id = safeId(uploadId);
  if (!id) return json(res, 400, { ok: false, error: 'uploadId không hợp lệ' });
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) return json(res, 413, { ok: false, error: 'Video vượt giới hạn upload worker' });
  const temp = path.join(UPLOAD_DIR, `${id}.part`);
  const finalPath = path.join(UPLOAD_DIR, id);
  const out = fs.createWriteStream(temp, { flags: 'w', mode: 0o600 });
  let bytes = 0;
  let failed = false;
  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD_BYTES && !failed) {
      failed = true;
      req.destroy(new Error('upload quá lớn'));
      out.destroy();
    }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (failed) return;
    fs.renameSync(temp, finalPath);
    const filename = String(req.headers['x-shoplive-filename'] || 'video').replace(/[\r\n]/g, ' ').slice(0, 180);
    uploads.set(id, { id, path: finalPath, bytes, filename, createdAt: Date.now() });
    json(res, 201, { ok: true, uploadId: id, bytes, filename });
  });
  const fail = err => {
    if (failed) return;
    failed = true;
    try { out.destroy(); } catch {}
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    if (!res.headersSent) json(res, 500, { ok: false, error: err?.message || 'Upload lỗi' });
  };
  req.on('error', fail);
  out.on('error', fail);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (pathname === '/healthz' && req.method === 'GET') {
    const [ffmpeg, ffprobe] = await Promise.all([commandOk(FFMPEG, ['-version']), commandOk(FFPROBE, ['-version'])]);
    return json(res, 200, {
      ok: ffmpeg && ffprobe,
      version: VERSION,
      ffmpeg,
      ffprobe,
      activeSessions: activeSessionCount(),
      maxSessions: MAX_SESSIONS,
      smartLinkConfigured: !!SMART_LINK_BASE_URL,
      apiKeyConfigured: !!API_KEY,
      pendingSessionCreates,
      sessionRetentionMs: SESSION_RETENTION_MS,
      authOk: authorized(req)
    });
  }

  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });

  const uploadMatch = /^\/api\/uploads\/([a-zA-Z0-9_-]+)$/.exec(pathname);
  if (uploadMatch && req.method === 'PUT') return uploadFile(req, res, uploadMatch[1]);
  if (uploadMatch && req.method === 'DELETE') {
    const id = safeId(uploadMatch[1]);
    const meta = uploads.get(id);
    const file = meta?.path || path.join(UPLOAD_DIR, id);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
    uploads.delete(id);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/sessions' && req.method === 'GET') {
    return json(res, 200, { ok: true, sessions: [...sessions.values()].map(publicSession) });
  }
  if (pathname === '/api/sessions' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const session = await createSession(body);
      return json(res, 201, { ok: true, sessionId: session.id, ...publicSession(session) });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message || String(e) });
    }
  }

  const statusMatch = /^\/api\/sessions\/([a-zA-Z0-9_-]+)$/.exec(pathname);
  if (statusMatch && req.method === 'GET') {
    const s = sessions.get(statusMatch[1]);
    if (!s) return json(res, 404, { ok: false, error: 'Session không tồn tại' });
    return json(res, 200, { ok: true, ...publicSession(s) });
  }

  const stopMatch = /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/stop$/.exec(pathname);
  if (stopMatch && req.method === 'POST') {
    const s = sessions.get(stopMatch[1]);
    if (!s) return json(res, 404, { ok: false, error: 'Session không tồn tại' });
    stopSession(s);
    return json(res, 200, { ok: true, ...publicSession(s) });
  }

  return json(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[ShopLive Online Worker] ${VERSION} listening on ${HOST}:${PORT} maxSessions=${MAX_SESSIONS}`);
});

function shutdown() {
  for (const s of sessions.values()) stopSession(s);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
