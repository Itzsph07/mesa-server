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
        // Extract ALL query parameters at the beginning
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
        
        // If channelId is not provided, try to extract it from the URL
        if (!channelId || channelId === 'undefined') {
            const match = decodedUrl.match(/stream=(\d+)/) || decodedUrl.match(/\/(\d+)(?:\.ts)?$/);
            channelId = match ? match[1] : 'unknown';
            console.log(`🔍 Extracted channelId from URL: ${channelId}`);
        }

        // If mac is not provided, try to extract from URL
        if (!mac || mac === 'undefined') {
            const macMatch = decodedUrl.match(/mac=([^&]+)/);
            mac = macMatch ? macMatch[1] : 'unknown';
            console.log(`🔍 Extracted MAC from URL: ${mac}`);
        }

        // ★★★ CRITICAL: Kill any existing stream for this MAC+channel before starting a new one ★★★
        if (mac && mac !== 'unknown' && channelId && channelId !== 'unknown') {
            console.log(`🪓 Killing existing stream for MAC: ${mac}, Channel: ${channelId}`);
            killStream(mac, channelId);
            // Small delay to ensure the previous connection is fully closed
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Block duplicate simultaneous requests for the same URL
        const urlKey = decodedUrl.split('?')[0] + (decodedUrl.match(/[?&](stream|play_token)=[^&]+/g) || []).join('');
        if (fetchingUrls.has(urlKey)) {
            console.log(`🚫 Duplicate request blocked for URL: ${urlKey.slice(0, 80)}`);
            return res.status(429).json({ error: 'Duplicate stream request — already connecting' });
        }
        fetchingUrls.add(urlKey);
        setTimeout(() => fetchingUrls.delete(urlKey), 3000);

        console.log('🔌 Proxying stream:', decodedUrl);

        // Parse the URL to get host
        let host;
        try {
            host = new URL(decodedUrl).host;
        } catch (e) {
            fetchingUrls.delete(urlKey);
            return res.status(400).json({ error: 'Invalid URL' });
        }

        // Use headers that work with the stream server
        const headers = {
            'User-Agent': 'Lavf53.32.100',
            'Icy-MetaData': '1',
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
            'Connection': 'keep-alive',
            'Host': host
        };

        // Add Referer if it's the stream domain
        if (host.includes('mztk02.xyz') || host.includes('ott-cdn.me')) {
            headers['Referer'] = `http://${host}/`;
        }

        console.log('📤 Request headers:', headers);

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
        
        // Check if we need to transcode (force_sw=1)
        const needsTranscode = force_sw === '1';
        
if (needsTranscode) {
    console.log('🎬 FORCE_SW=1 - Transcoding to H.264/AAC');
    
    // Use ffmpeg-static for reliable binary
    const ffmpegStatic = require('ffmpeg-static');
    const fs = require('fs');
    const { lookup } = require('dns').promises;
    const { spawn } = require('child_process');
    
    let FFMPEG_BIN = ffmpegStatic || 'ffmpeg';
    if (!FFMPEG_BIN || !fs.existsSync(FFMPEG_BIN)) {
        console.log('⚠️ ffmpeg-static not found, trying system ffmpeg');
        FFMPEG_BIN = 'ffmpeg';
    }
    
    console.log(`🎬 Using FFmpeg at: ${FFMPEG_BIN}`);
    
    // RESOLVE HOSTNAME FIRST (Critical fix for Alpine DNS)
    let finalDecodedUrl = decodedUrl;
    let hostHeader = null;
    
    try {
        const urlObj = new URL(decodedUrl);
        console.log(`🔍 Resolving hostname: ${urlObj.hostname}`);
        
        // Try to resolve DNS
        const addresses = await lookup(urlObj.hostname);
        console.log(`✅ Resolved ${urlObj.hostname} -> ${addresses.address}`);
        
        // Create URL with IP instead of hostname
        finalDecodedUrl = decodedUrl.replace(urlObj.hostname, addresses.address);
        hostHeader = urlObj.hostname;
        console.log(`🔄 Using IP-based URL for FFmpeg`);
    } catch (dnsErr) {
        console.log(`⚠️ DNS lookup failed: ${dnsErr.message}, using original URL`);
    }
    
    // Build FFmpeg args with DNS resolution fix
    const ffmpegArgs = [
        '-loglevel', 'warning',
        '-fflags', '+genpts+discardcorrupt',
        '-analyzeduration', '2000000',
        '-probesize', '2000000',
        '-timeout', '20000000',      // 20 second timeout
        '-reconnect', '1',            // Auto-reconnect
        '-reconnect_streamed', '1',   // Reconnect on streamed content
        '-reconnect_delay_max', '10',  // Changed from 5 to 10
        '-reconnect_at_eof', '1',       // ADD THIS - reconnect at end of file
        '-rtbufsize', '100M',           // ADD THIS - increase buffer size
    ];
    
    // Add custom Host header if we resolved DNS
    if (hostHeader) {
        ffmpegArgs.push('-headers', `Host: ${hostHeader}\r\n`);
    }
    
    ffmpegArgs.push(
        '-i', finalDecodedUrl,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c:v', 'libx264',
        '-profile:v', 'baseline',
        '-level', '3.1',
        '-b:v', '2000k',
        '-maxrate', '2500k',
        '-bufsize', '4000k',
        '-g', '50',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-f', 'mpegts',
        'pipe:1'
    );
    
    console.log(`🎬 FFmpeg args: ${ffmpegArgs.slice(0, 10).join(' ')}...`);
    
    ffmpegProc = spawn(FFMPEG_BIN, ffmpegArgs);
    
    // Set response headers for transcoded stream
    const responseHeaders = {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'X-Transcoded': 'true',
        'X-Video-Format': 'h264',
        'X-Audio-Format': 'aac',
        'Connection': 'close'
    };
    
    res.set(responseHeaders);
    
    // Store connection for force killing
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
    console.log(`📦 Stored transcoding connection for ${connectionKey}, total active: ${activeConnections.size}`);
    
    // Pipe FFmpeg stdout to response
    ffmpegProc.stdout.pipe(res);
    
    // Handle FFmpeg stderr for debugging
    ffmpegProc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
            console.log(`🎬 FFmpeg: ${msg}`);
        }
    });
    
    // Handle FFmpeg process end
    let isCleanupDone = false;
    ffmpegProc.on('close', (code) => {
        console.log(`🎬 FFmpeg closed (code ${code}) for ${connectionKey}`);
        if (!isCleanupDone) {
            isCleanupDone = true;
            activeConnections.delete(connectionKey);
            fetchingUrls.delete(urlKey);
        }
    });
    
    ffmpegProc.on('error', (err) => {
        console.error(`❌ FFmpeg error for ${connectionKey}:`, err.message);
        if (!isCleanupDone && isResponseWritable(res)) {
            res.status(500).json({ error: 'Transcoding failed' });
        }
        if (!isCleanupDone) {
            isCleanupDone = true;
            activeConnections.delete(connectionKey);
            fetchingUrls.delete(urlKey);
        }
    });
    
    // Handle response close (client disconnected)
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
