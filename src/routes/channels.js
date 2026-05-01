// backend/src/routes/channels.js
// COMPLETE FIXED VERSION - WITH PROPER MAG URL CONSTRUCTION

const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const axios    = require('axios');
const Playlist = require('../models/Playlist');
const Channel  = require('../models/Channel');

// Cache for successful results
const linkCache = new Map(); // channelId -> { url, timestamp }
const sessionMap = new Map(); // macAddress -> { password, timestamp }

// Clean caches every hour
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of linkCache.entries()) {
    if (now - value.timestamp > 3600000) linkCache.delete(key);
  }
  for (const [key, value] of sessionMap.entries()) {
    if (now - value.timestamp > 3600000) sessionMap.delete(key);
  }
}, 3600000);

// ─── Shared helpers ───────────────────────────────────────────────────────────

const MAG_UA =
  'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 ' +
  '(KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

function makeMagHeaders(mac, token, baseUrl) {
  const h = {
    'User-Agent':      MAG_UA,
    'X-User-Agent':    'Model: MAG250; Link: WiFi',
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Connection':      'keep-alive',
    'Cookie':          `mac=${mac}; stb_lang=en; timezone=GMT`,
  };
  if (token) {
    h['Authorization'] = `Bearer ${token}`;
    h['Cookie']       += `; token=${token}`;
  }
  try {
    const u = new URL(baseUrl);
    h['Referer'] = `${u.protocol}//${u.host}/c/`;
  } catch (_) {}
  return h;
}

function parseMAG(data) {
  if (typeof data !== 'string') return data;
  for (const rx of [/^\w+\(({.*})\);?$/s, /({.*})/s]) {
    const m = data.match(rx);
    if (m) try { return JSON.parse(m[1]); } catch (_) {}
  }
  try { return JSON.parse(data); } catch (_) {}
  return { js: data };
}

function extractUrl(raw) {
  if (!raw) return null;
  const s = String(raw)
    .replace(/^ff(mpeg|rt)\s+/i, '')
    .replace(/[\t\n\r]/g, '')
    .trim();
  const m = s.match(/https?:\/\/[^\s"']+/);
  return m ? m[0] : null;
}

function getStreamId(text) {
  const m = String(text || '').match(/[?&]stream=(\d+)/);
  return m ? m[1] : null;
}

function ensureStreamId(url, streamId) {
  if (!url || !streamId) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.get('stream')) u.searchParams.set('stream', streamId);
    return u.toString();
  } catch (_) { return url; }
}

function isXtreamUrl(url) {
  if (!url) return false;
  const base  = url.split('?')[0].split('#')[0];
  const m     = base.match(/^https?:\/\/[^/]+(\/.*)?$/);
  if (!m) return false;
  const parts = (m[1] || '').split('/').filter(Boolean);
  const last  = parts[parts.length - 1] || '';
  if (parts.length === 4 && parts[0] === 'live') return /^\d+(\.(ts|m3u8|mp4))?$/i.test(last);
  if (parts.length === 3)                         return /^\d+(\.(ts|m3u8|mp4))?$/i.test(last);
  return false;
}

function cleanXtreamUrl(url) {
  let clean = url.split('?')[0].split('#')[0].trim().replace(/\/$/, '');
  const m = clean.match(/^(https?:\/\/[^/]+)(\/.*)?$/);
  if (m) {
    const base  = m[1];
    const parts = (m[2] || '').split('/').filter(Boolean);
    if (parts.length === 3 && parts[0] !== 'live') {
      clean = `${base}/live/${parts[0]}/${parts[1]}/${parts[2]}`;
    } else {
      clean = base + (m[2] || '');
    }
  }
  if (!/\.(ts|m3u8|mp4)$/i.test(clean)) clean += '.ts';
  return clean;
}

// Known MAG portal paths — tried in order until one returns a token
const API_PATHS = [
  '/portal.php',
  '/c/portal.php',
  '/server/load.php',
  '/c/server/load.php',
  '/stalker_portal/server/load.php',
  '/stalker_portal/portal.php',
  '/api/portal.php',
  '/c/api/portal.php',
  '/load.php',
  '/c/load.php',
];

// ─── doHandshake ──────────────────────────────────────────────────────────────
async function doHandshake(baseUrl, mac) {
  for (const path of API_PATHS) {
    try {
      const r = await axios.get(`${baseUrl}${path}`, {
        params:  { type: 'stb', action: 'handshake', token: '', JsHttpRequest: '1-xml' },
        headers: makeMagHeaders(mac, null, baseUrl),
        timeout: 8000,
        validateStatus: s => s < 500,
      });
      if (r.status === 200) {
        const d     = parseMAG(r.data);
        const token = d?.js?.token ?? d?.token;
        if (token) {
          console.log(`✅ Handshake OK → ${path}  token: ${token.substring(0, 8)}...`);
          return { token, apiPath: path };
        }
      }
    } catch (e) {
      console.log(`   ❌ ${path}: ${e.message}`);
    }
  }
  console.warn('⚠️  All handshake paths failed');
  return { token: null, apiPath: API_PATHS[0] };
}

// ─── doGetProfile ─────────────────────────────────────────────────────────────
async function doGetProfile(baseUrl, apiPath, mac, token) {
  try {
    const r = await axios.get(`${baseUrl}${apiPath}`, {
      params: {
        type:           'stb',
        action:         'get_profile',
        hd:             1,
        ver:            'ImageDescription: 0.2.18-r14-pub-250',
        num_banks:      2,
        sn:             '313356B172963',
        stb_type:       'MAG250',
        image_version:  '218',
        video_out:      'hdmi',
        device_id:      '', device_id2: '', signature: '',
        JsHttpRequest:  '1-xml',
        ...(token ? { token } : {}),
      },
      headers: makeMagHeaders(mac, token, baseUrl),
      timeout: 10000,
    });
    const d = parseMAG(r.data);
    const password = d?.js?.password ?? null;
    if (password) console.log(`✅ Got profile.password: ${String(password).substring(0, 8)}...`);
    return password;
  } catch (e) {
    console.warn('   doGetProfile error:', e.message);
    return null;
  }
}

// ─── doReleaseStream ─────────────────────────────────────────────────────────
async function doReleaseStream(baseUrl, apiPath, mac, token, oldCmd) {
  if (!oldCmd) return;
  try {
    let releaseCmd = oldCmd;
    if (typeof oldCmd === 'string') {
      releaseCmd = oldCmd.replace(/^ff(mpeg|rt)\s+/i, '').trim();
      const channelMatch = releaseCmd.match(/stream=(\d+)/) || releaseCmd.match(/\/(\d+)$/);
      if (channelMatch) {
        releaseCmd = channelMatch[1];
      }
    }
    
    console.log(`🔓 Releasing previous session with channel ID: ${releaseCmd}`);
    await axios.get(`${baseUrl}${apiPath}`, {
      params: {
        type:          'itv',
        action:        'get_ordered_list',
        cmd:           releaseCmd,
        genre:         '*',
        force_ch_link_check: 0,
        JsHttpRequest: '1-xml',
        ...(token ? { token } : {}),
      },
      headers: makeMagHeaders(mac, token, baseUrl),
      timeout: 5000,
    });
    await new Promise(r => setTimeout(r, 500));
    console.log('   ✅ Session released');
  } catch (e) {
    console.warn('   ⚠️ Release failed (non-fatal):', e.message);
  }
}

// ─── doCreateLink ─────────────────────────────────────────────────────────────
async function doCreateLink(baseUrl, apiPath, mac, token, cmdArg) {
  try {
    console.log(`🔗 create_link for channel ID: ${cmdArg}`);
    
    let channelId = cmdArg;
    if (typeof cmdArg === 'string') {
      const streamMatch = cmdArg.match(/stream=(\d+)/);
      if (streamMatch) channelId = streamMatch[1];
      else {
        const idMatch = cmdArg.match(/\/(\d+)$/);
        if (idMatch) channelId = idMatch[1];
      }
    }
    
    const r = await axios.get(`${baseUrl}${apiPath}`, {
      params: {
        type:           'itv',
        action:         'create_link',
        cmd:            channelId,
        series:         0,
        forced_storage: 0,
        disable_ad:     0,
        JsHttpRequest:  '1-xml',
        ...(token ? { token } : {}),
      },
      headers: makeMagHeaders(mac, token, baseUrl),
      timeout: 10000,
    });
    
    const d = parseMAG(r.data);
    let out = d?.js?.cmd ?? d?.js?.url ?? null;
    
    if (out && typeof out === 'string') {
      out = out.replace(/^ff(mpeg|rt)\s+/i, '').trim();
      const urlMatch = out.match(/https?:\/\/[^\s"']+/);
      if (urlMatch) {
        out = urlMatch[0];
      }
    }
    
    console.log(`   → "${String(out).slice(0, 120)}"`);
    return out;
  } catch (e) {
    console.error('   create_link error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /channels/channel-switch
// ─────────────────────────────────────────────────────────────────────────────
router.post('/channel-switch', auth, async (req, res) => {
    const { playlistId, channelId } = req.body;
    try {
        const playlist = await Playlist.findById(playlistId).lean();
        if (!playlist) return res.status(404).json({ success: false, message: 'Playlist not found' });

        const isMag = playlist.type === 'mag' || playlist.type === 'stalker';

        if (isMag) {
            const MagStalkerService = require('../services/magStalkerService');
            const service = new MagStalkerService(playlist.sourceUrl, playlist.macAddress);
            const tokenData = await service.getChannelToken(channelId);

            if (tokenData?.url) {
                console.log(`⚡ Cache hit: using stored URL for channel ${channelId}`);
                return res.json({ success: true, url: tokenData.url, type: 'mag_cached' });
            } else if (tokenData?.token) {
                const channel = await Channel.findOne({ playlistId, channelId }).lean();
                if (channel?.cmd) {
                    const baseMatch    = channel.cmd.match(/(https?:\/\/[^/]+)/);
                    const usernameMatch = channel.cmd.match(/https?:\/\/[^/]+\/([^/]+)/);
                    if (baseMatch && usernameMatch) {
                        const url = `${baseMatch[1]}/${usernameMatch[1]}/${tokenData.token}/${channelId}.ts`;
                        return res.json({ success: true, url, type: 'mag_token' });
                    }
                }
            }
        }

        const channel = await Channel.findOne({ playlistId, channelId }).lean();
        if (channel?.cmd) {
            const urlMatch = channel.cmd.match(/https?:\/\/[^\s]+/);
            if (urlMatch) return res.json({ success: true, url: urlMatch[0], type: 'fallback' });
        }

        return res.status(404).json({ success: false, message: 'Channel not found' });
    } catch (error) {
        console.error('channel-switch error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /channels/get-stalker-token
// ─────────────────────────────────────────────────────────────────────────────
router.post('/get-stalker-token', auth, async (req, res) => {
  const { playlistId } = req.body;
  try {
    const playlist = await Playlist.findById(playlistId).lean();
    if (!playlist) return res.status(404).json({ success: false, message: 'Playlist not found' });
    const { token } = await doHandshake(playlist.sourceUrl, playlist.macAddress);
    if (token) return res.json({ success: true, token });
    throw new Error('No token from handshake');
  } catch (err) {
    console.error('get-stalker-token error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ★  POST /channels/get-stream-single - FIXED VERSION
// ─────────────────────────────────────────────────────────────────────────────
router.post('/get-stream-single', auth, async (req, res) => {
  const { playlistId, channelId, cmd } = req.body;

  console.log('\n══════════ get-stream-single ══════════');
  console.log('channelId :', channelId);
  console.log('cmd       :', String(cmd || '').slice(0, 120));

  try {
    const playlist = await Playlist.findById(playlistId).lean();
    if (!playlist) return res.status(404).json({ success: false, message: 'Playlist not found' });

    const pType = playlist.type;
    console.log('Playlist type:', pType);

    // ── MAG / STALKER ─────────────────────────────────────────────────────────
    if (pType === 'mag' || pType === 'stalker') {
      if (!playlist.sourceUrl || !playlist.macAddress) {
        return res.status(400).json({ success: false, message: 'Playlist missing sourceUrl or macAddress' });
      }

      // Check per-channel cache first
      const cached = linkCache.get(channelId);
      if (cached && (Date.now() - cached.timestamp < 300000)) {
        console.log(`⚡ Using cached link for channel ${channelId}`);
        return res.json({ success: true, url: cached.url, type: 'mag_cached' });
      }

      try {
        // Get or create session for this MAC
        const sessionKey = playlist.macAddress;
        let sessionPassword = sessionMap.get(sessionKey)?.password;
        
        // Check if session exists and is valid (10 minutes)
        if (!sessionPassword || (Date.now() - sessionMap.get(sessionKey)?.timestamp > 600000)) {
          console.log(`🔑 Creating new session for MAC: ${playlist.macAddress}`);
          
          // Fresh handshake
          const { token, apiPath } = await doHandshake(playlist.sourceUrl, playlist.macAddress);
          
          // Get session password
          sessionPassword = await doGetProfile(playlist.sourceUrl, apiPath, playlist.macAddress, token);
          
          if (sessionPassword) {
            sessionMap.set(sessionKey, {
              password: sessionPassword,
              timestamp: Date.now()
            });
            console.log(`✅ Session password set: ${sessionPassword.substring(0, 8)}...`);
          }
        } else {
          console.log(`⚡ Using existing session for MAC: ${playlist.macAddress}`);
        }

        if (!sessionPassword) {
          throw new Error('Could not obtain session password');
        }

        // Check if this is a live.php portal (MAG) or Xtream-style
        const baseUrl = playlist.sourceUrl.replace(/\/+$/, '');
        
        let freshUrl;
        
        if (baseUrl.includes('live.php') || cmd.includes('live.php')) {
          // MAG portal - construct proper live.php URL
          const basePath = baseUrl.endsWith('/c') ? baseUrl.slice(0, -2) : baseUrl;
          const urlObj = new URL(`${basePath}/play/live.php`);
          urlObj.searchParams.set('mac', playlist.macAddress);
          urlObj.searchParams.set('stream', channelId);
          urlObj.searchParams.set('extension', 'ts');
          urlObj.searchParams.set('play_token', sessionPassword);
          // ★ ADD FORCE TRANSCODING PARAMETERS ★
          urlObj.searchParams.set('force_sw', '1');
          urlObj.searchParams.set('videoFormat', 'h264');
          urlObj.searchParams.set('audioFormat', 'aac');
          freshUrl = urlObj.toString();
          console.log(`✅ Constructed MAG URL with forced transcoding: ${freshUrl}`);
        } else {
          // Xtream-style portal
          const baseMatch = cmd.match(/(https?:\/\/[^\/]+):80\/([^\/]+)\//);
          if (!baseMatch) {
            throw new Error('Could not parse base URL from cmd');
          }
          const protocol = baseMatch[1];
          const username = baseMatch[2];
          freshUrl = `${protocol}/${username}/${sessionPassword}/${channelId}`;
          // ★ ALSO ADD FORCE TRANSCODING FOR XTREAM ★
          const separator = freshUrl.includes('?') ? '&' : '?';
          freshUrl = `${freshUrl}${separator}force_sw=1&videoFormat=h264&audioFormat=aac`;
          console.log(`✅ Constructed Xtream URL with forced transcoding: ${freshUrl}`);
        }
        
        // ★ FORCE TRANSCODING: Add parameters if they weren't already added
        // (This is a safety net for any edge cases)
        if (!freshUrl.includes('force_sw=1')) {
          const separator = freshUrl.includes('?') ? '&' : '?';
          freshUrl = `${freshUrl}${separator}force_sw=1&videoFormat=h264&audioFormat=aac`;
          console.log(`✅ Safety net: Added force_sw=1 to URL`);
        }
        
        // Cache this specific channel's URL
        linkCache.set(channelId, { url: freshUrl, timestamp: Date.now() });
        
        return res.json({ success: true, url: freshUrl, type: 'mag' });
        
        
        // Cache this specific channel's URL
        linkCache.set(channelId, { url: freshUrl, timestamp: Date.now() });
        
        return res.json({ success: true, url: freshUrl, type: 'mag' });

      } catch (magErr) {
        console.error('❌ MAG error:', magErr.message);
        const channelDoc = await Channel.findOne({ playlistId, channelId }).lean();
        const fallback = extractUrl(channelDoc?.cmd) || channelDoc?.url || extractUrl(cmd);
        if (fallback) {
          return res.json({ success: true, url: fallback, type: 'mag_fallback' });
        }
        return res.status(502).json({ success: false, message: magErr.message });
      }
    }

    // ── XTREAM — zero network calls ───────────────────────────────────────────
    if (pType === 'xtream') {
      const baseUrl  = (playlist.sourceUrl || '').replace(/\/+$/, '');
      const username = playlist.xtreamUsername;
      const password = playlist.xtreamPassword;

      if (baseUrl && username && password) {
        const url = `${baseUrl}/live/${username}/${password}/${channelId}.ts`;
        console.log('✅ Xtream URL (instant):', url);
        return res.json({ success: true, url, type: 'xtream' });
      }

      const fallback = extractUrl(cmd);
      if (fallback) {
        return res.json({ success: true, url: cleanXtreamUrl(fallback), type: 'xtream_fallback' });
      }
      return res.status(400).json({ success: false, message: 'Xtream playlist missing credentials' });
    }

    // ── M3U — zero network calls ──────────────────────────────────────────────
    if (pType === 'm3u') {
      const channelDoc = await Channel.findOne({ playlistId, channelId }).lean();
      const url        = channelDoc?.url || extractUrl(cmd);
      if (url) {
        console.log('✅ M3U URL (stored):', url);
        return res.json({ success: true, url, type: 'm3u' });
      }
      return res.status(400).json({ success: false, message: 'No URL found for M3U channel' });
    }

    return res.status(400).json({ success: false, message: `Unknown playlist type: ${pType}` });

  } catch (err) {
    console.error('get-stream-single error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /channels/get-stream
// ─────────────────────────────────────────────────────────────────────────────
router.post('/get-stream', auth, async (req, res) => {
  try {
    const { playlistId, channelId, cmd } = req.body;
    console.log('\n══════════ get-stream ══════════');
    console.log('channelId :', channelId);
    console.log('cmd       :', cmd);

    const rawUrl   = extractUrl(cmd);
    const streamId = getStreamId(cmd) || channelId;

    const playlist = await Playlist.findById(playlistId).lean();
    if (!playlist) return res.status(404).json({ success: false, message: 'Playlist not found' });

    const isMag = playlist.type === 'mag' || playlist.type === 'stalker';

    if (isMag && playlist.sourceUrl && playlist.macAddress) {
      try {
        const MagStalkerService = require('../services/magStalkerService');
        const service = new MagStalkerService(playlist.sourceUrl, playlist.macAddress);
        const channelData = await service.getCachedChannelData(channelId);
        if (channelData?.streamUrl) {
          return res.json({ success: true, url: channelData.streamUrl, type: 'mag_cached' });
        } else if (channelData?.cmd) {
          const m = channelData.cmd.match(/https?:\/\/[^\s]+/);
          if (m) return res.json({ success: true, url: m[0], type: 'mag_cached' });
        }
        if (rawUrl) return res.json({ success: true, url: rawUrl, type: 'mag_fallback' });
      } catch (error) {
        if (rawUrl) return res.json({ success: true, url: rawUrl, type: 'mag_fallback' });
      }
    }

    let rawHost = null, playlistHost = null;
    try { rawHost      = rawUrl ? new URL(rawUrl).hostname         : null; } catch (_) {}
    try { playlistHost = playlist.sourceUrl ? new URL(playlist.sourceUrl).hostname : null; } catch (_) {}

    if (rawUrl && rawHost && playlistHost && rawHost !== playlistHost) {
      let finalUrl = rawUrl;
      if (isXtreamUrl(rawUrl) && !/\.(ts|m3u8|mp4)$/i.test(rawUrl)) {
        if (/^\d+$/.test(rawUrl.split('/').pop() || '')) finalUrl += '.ts';
      }
      return res.json({ success: true, url: finalUrl, type: 'xtream' });
    }

    if (rawUrl && isXtreamUrl(rawUrl)) {
      if (playlist.sourceUrl && (playlist.xtreamUsername || playlist.username)) {
        const base = playlist.sourceUrl.replace(/\/+$/, '');
        const user = playlist.xtreamUsername || playlist.username;
        const pass = playlist.xtreamPassword || playlist.password;
        return res.json({ success: true, url: `${base}/live/${user}/${pass}/${streamId}.ts`, type: 'xtream' });
      }
      return res.json({ success: true, url: cleanXtreamUrl(rawUrl), type: 'xtream' });
    }

    if (playlist.type === 'xtream') {
      const base = playlist.sourceUrl?.replace(/\/+$/, '');
      const user = playlist.xtreamUsername || playlist.username;
      const pass = playlist.xtreamPassword || playlist.password;
      if (base && user && pass) {
        return res.json({ success: true, url: `${base}/live/${user}/${pass}/${channelId}.ts`, type: 'xtream' });
      }
      if (rawUrl) return res.json({ success: true, url: cleanXtreamUrl(rawUrl), type: 'xtream' });
    }

    if (!rawUrl) return res.status(400).json({ success: false, message: 'No valid URL in cmd' });
    return res.json({ success: true, url: ensureStreamId(rawUrl, streamId) });

  } catch (err) {
    console.error('get-stream error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /channels/release-stream - Client requests stream release
// ★★★ COMPLETELY FIXED VERSION ★★★
// In channels.js - make release-stream super simple
// In backend/routes/channels.js
router.post('/release-stream', auth, async (req, res) => {
  const { playlistId, channelId, cmd, macAddress } = req.body;
  
  console.log(`🔓 Releasing channel ${channelId} for MAC: ${macAddress}`);
  
  try {
    // Get the playlist to get MAC if not provided
    let mac = macAddress;
    if (!mac && playlistId) {
      const playlist = await Playlist.findById(playlistId).lean();
      mac = playlist?.macAddress;
    }
   
    // ★ COMMENT THIS OUT (match your local working version)
    // if (mac && channelId) {
    //   const killUrl = `${process.env.BASE_URL || 'http://localhost:5000'}/api/proxy/stream/${encodeURIComponent(mac)}/${encodeURIComponent(channelId)}`;
    //   axios.delete(killUrl).catch(() => {});
    //   console.log(`✅ Kill request sent for ${mac}/${channelId}`);
    // }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Release error:', error);
    res.json({ success: true }); // Still return success
  }
});

module.exports = router;
