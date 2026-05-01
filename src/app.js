const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'API is working', 
    time: new Date().toISOString(),
    note: 'Your backend is running!'
  });
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Database connection
mongoose.connect(process.env.MONGODB_URI)
.then(() => console.log('MongoDB connected'))
.catch(err => {
    console.error('MongoDB connection error:', err);
    if (err.message.includes('ECONNREFUSED')) {
        console.error('DNS/Network Block detected. Check whitelist or use Standard String.');
    }
});

// ========== PROXY STREAM ROUTE ==========
// Track active connections for force killing
const activeConnections = new Map(); // key: `${mac}_${channelId}` -> { stream, res, ffmpeg, timestamp }
const fetchingUrls = new Set(); // Track URLs being fetched to prevent duplicates

// Function to forcefully kill a specific stream
function killStream(mac, channelId) {
  const key = `${mac}_${channelId}`;
  if (activeConnections.has(key)) {
    const conn = activeConnections.get(key);
    console.log(`🪓 Force killing stream for MAC: ${mac}, Channel: ${channelId}`);

    // Kill FFmpeg process if it exists
    if (conn.ffmpeg && typeof conn.ffmpeg.kill === 'function') {
      try {
        conn.ffmpeg.kill('SIGTERM');
      } catch (e) {
        console.log('⚠️ Error killing FFmpeg:', e.message);
      }
    }

    // Destroy the incoming stream from the source
    if (conn.stream && typeof conn.stream.destroy === 'function') {
      try {
        conn.stream.destroy();
      } catch (e) {
        console.log('⚠️ Error destroying stream:', e.message);
      }
    }

    // End the response to the client if it's still writable
    if (conn.res && !conn.res.writableEnded) {
      try {
        conn.res.end();
      } catch (e) {}
    }

    activeConnections.delete(key);
    console.log(`✅ Stream killed for ${key}`);
    return true;
  }
  return false;
}

// DELETE endpoint to force kill a stream
app.delete('/api/proxy/stream/:mac/:channelId', (req, res) => {
  const { mac, channelId } = req.params;
  console.log(`🔫 Kill request received for MAC: ${mac}, Channel: ${channelId}`);

  const killed = killStream(mac, channelId);

  res.json({
    success: killed,
    message: killed ? 'Stream terminated' : 'Stream not found'
  });
});

// Function to check if response is still writable
function isResponseWritable(res) {
  return res && !res.writableEnded && !res.headersSent;
}

// Main proxy stream endpoint
// Main proxy stream endpoint
app.get('/api/proxy/stream', async (req, res) => {
    let response = null;
    let ffmpegProc = null;
    let connectionKey = null;
    let isCleanedUp = false;

    const cleanup = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;
        
        if (ffmpegProc) {
            try { ffmpegProc.kill('SIGTERM'); } catch (e) {}
        }
        if (response && response.data) {
            try { response.data.destroy(); } catch (e) {}
        }
        if (connectionKey && activeConnections.has(connectionKey)) {
            activeConnections.delete(connectionKey);
        }
    };
    
    try {
        // Extract ALL query parameters
        let { url, mac, type, ua_index, channelId, force_sw, videoFormat, audioFormat, container } = req.query;
        
        console.log('📥 Proxy request received:', { 
            url: url ? url.substring(0, 100) + '...' : 'missing',
            mac: mac || 'missing',
            channelId: channelId || 'missing',
            force_sw: force_sw || '0',
            type: type || 'auto'
        });
        
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const decodedUrl = decodeURIComponent(url);
        
        // Extract channelId if not provided
        if (!channelId || channelId === 'undefined') {
            const match = decodedUrl.match(/stream=(\d+)/) || decodedUrl.match(/\/(\d+)(?:\.ts)?$/);
            channelId = match ? match[1] : 'unknown';
            console.log(`🔍 Extracted channelId from URL: ${channelId}`);
        }

        // Extract MAC if not provided
        if (!mac || mac === 'undefined') {
            const macMatch = decodedUrl.match(/mac=([^&]+)/);
            mac = macMatch ? macMatch[1] : 'unknown';
            console.log(`🔍 Extracted MAC from URL: ${mac}`);
        }

        // Kill existing stream for this MAC+channel
        if (mac && mac !== 'unknown' && channelId && channelId !== 'unknown') {
            console.log(`🪓 Killing existing stream for MAC: ${mac}, Channel: ${channelId}`);
            killStream(mac, channelId);
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Block duplicate requests
        const urlKey = decodedUrl.split('?')[0] + (decodedUrl.match(/[?&](stream|play_token)=[^&]+/g) || []).join('');
        if (fetchingUrls.has(urlKey)) {
            console.log(`🚫 Duplicate request blocked`);
            return res.status(429).json({ error: 'Duplicate stream request' });
        }
        fetchingUrls.add(urlKey);
        setTimeout(() => fetchingUrls.delete(urlKey), 3000);

        console.log('🔌 Proxying stream:', decodedUrl);

        // Parse URL for host
        let host;
        try {
            host = new URL(decodedUrl).host;
        } catch (e) {
            fetchingUrls.delete(urlKey);
            return res.status(400).json({ error: 'Invalid URL' });
        }

        // Request headers
        const headers = {
            'User-Agent': 'Lavf53.32.100',
            'Icy-MetaData': '1',
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
            'Connection': 'keep-alive',
            'Host': host
        };

        if (host.includes('mztk02.xyz') || host.includes('ott-cdn.me')) {
            headers['Referer'] = `http://${host}/`;
        }

        response = await axios({
            method: 'GET',
            url: decodedUrl,
            headers,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 5,
            validateStatus: (status) => status < 500
        });

        console.log('📥 Response status:', response.status);
        connectionKey = `${mac}_${channelId}`;

        const needsTranscode = force_sw === '1';

if (needsTranscode) {
    console.log('🎬 FORCE_SW=1 - Transcoding via stdin pipe (axios handles auth)');
    
    const ffmpegStatic = require('ffmpeg-static');
    const { spawn } = require('child_process');
    
    const FFMPEG_BIN = ffmpegStatic || 'ffmpeg';
    
    // ✅ Read from stdin — axios already fetched with correct headers
    // No DNS resolve needed, no custom headers needed, no URL passed to ffmpeg
    const ffmpegArgs = [
        '-loglevel', 'warning',
        '-fflags', '+genpts+discardcorrupt',
        '-analyzeduration', '2000000',
        '-probesize', '2000000',
        '-i', 'pipe:0',          // ← READ FROM STDIN (axios stream)
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-profile:v', 'baseline',
        '-level', '3.1',
        '-b:v', '2000k',         // ← restored, was 1000k
        '-maxrate', '2500k',
        '-bufsize', '4000k',
        '-g', '50',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',          // ← restored, was 96k
        '-f', 'mpegts',
        'pipe:1'                 // ← write to stdout
    ];

    // ✅ Fix: declare isCleanupDone BEFORE registering any event handlers
    let isCleanupDone = false;

    ffmpegProc = spawn(FFMPEG_BIN, ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe']  // stdin, stdout, stderr all piped
    });

    // ✅ Pipe axios stream INTO ffmpeg stdin (this is the key fix)
    response.data.pipe(ffmpegProc.stdin);

    // Handle stdin errors (source stream dies)
    ffmpegProc.stdin.on('error', (err) => {
        // EPIPE is normal when ffmpeg stops — ignore it
        if (err.code !== 'EPIPE') {
            console.error('FFmpeg stdin error:', err.message);
        }
    });

    response.data.on('error', (err) => {
        console.error('Source stream error:', err.message);
        try { ffmpegProc.stdin.destroy(); } catch(e) {}
    });

    // Set response headers
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Transcoded', 'true');
    res.setHeader('Connection', 'close');
    res.setHeader('Transfer-Encoding', 'chunked');

    activeConnections.set(connectionKey, {
        stream: response.data,
        ffmpeg: ffmpegProc,
        res: res,
        timestamp: Date.now(),
        url: decodedUrl,
        mac: mac,
        channelId: channelId,
        transcoded: true
    });

    // Pipe ffmpeg stdout → client
    ffmpegProc.stdout.pipe(res);

    ffmpegProc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg.includes('error') || msg.includes('Error')) {
            console.log(`🎬 FFmpeg: ${msg.substring(0, 200)}`);
        }
    });

    ffmpegProc.on('close', (code) => {
        console.log(`🎬 FFmpeg closed (code ${code}) for ${connectionKey}`);
        if (!isCleanupDone) {
            isCleanupDone = true;
            activeConnections.delete(connectionKey);
            fetchingUrls.delete(urlKey);
        }
    });

    ffmpegProc.on('error', (err) => {
        console.error(`❌ FFmpeg error:`, err.message);
        if (!isCleanupDone) {
            isCleanupDone = true;
            if (!res.headersSent) res.status(500).json({ error: 'Transcoding failed' });
            activeConnections.delete(connectionKey);
            fetchingUrls.delete(urlKey);
        }
    });

    res.on('close', () => {
        if (!isCleanupDone) {
            console.log(`🔌 Client disconnected for ${connectionKey}`);
            isCleanupDone = true;
            try { ffmpegProc.kill('SIGTERM'); } catch (e) {}
            try { response.data.destroy(); } catch (e) {}
            activeConnections.delete(connectionKey);
            fetchingUrls.delete(urlKey);
        }
    });
        }

    } catch (error) {
        console.error('❌ Proxy error:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Streaming failed: ' + error.message });
        }
    }
});
// Test endpoint
app.get('/api/proxy/test', (req, res) => {
    res.json({ message: 'Proxy route is working' });
});

// Routes that require authentication
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/playlists', require('./routes/playlists'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/fast-sync', require('./routes/fastSync'));

// ========== TOKEN REFRESH SYSTEM ==========
const tokenRefreshService = require('./services/tokenRefreshService');

// Admin token management routes
app.use('/api/admin/token', require('./routes/tokenRoutes'));

// Run token check every 6 hours
setInterval(async () => {
  console.log('⏰ Running scheduled token refresh...');
  try {
    await tokenRefreshService.refreshAllPlaylists();
  } catch (error) {
    console.error('Scheduled token refresh failed:', error);
  }
}, 6 * 60 * 60 * 1000); // 6 hours

// Run once on startup (after 10 seconds)
setTimeout(() => {
  tokenRefreshService.refreshAllPlaylists().catch(console.error);
}, 10000);

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// DEBUG ROUTE - Remove later
app.get('/api/debug/data', async (req, res) => {
    try {
        const Playlist = require('./models/Playlist');
        const Customer = require('./models/Customer');
        const User = require('./models/User');
        
        const playlists = await Playlist.find().populate('owner', 'username');
        const customers = await Customer.find().populate('playlists');
        const users = await User.find().select('-password');
        
        res.json({
            success: true,
            counts: {
                playlists: playlists.length,
                customers: customers.length,
                users: users.length
            },
            data: {
                playlists: playlists.map(p => ({ id: p._id, name: p.name, owner: p.owner?.username })),
                customers: customers.map(c => ({ id: c._id, name: c.name, playlists: c.playlists?.length })),
                users: users.map(u => ({ id: u._id, username: u.username, role: u.role }))
            }
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

module.exports = app;
