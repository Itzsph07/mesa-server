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
const activeConnections = new Map();
const fetchingUrls = new Set();

function killStream(mac, channelId) {
  const key = `${mac}_${channelId}`;
  if (activeConnections.has(key)) {
    const conn = activeConnections.get(key);
    console.log(`🪓 Force killing stream for MAC: ${mac}, Channel: ${channelId}`);

    if (conn.ffmpeg && typeof conn.ffmpeg.kill === 'function') {
      try { conn.ffmpeg.kill('SIGTERM'); } catch (e) {}
    }
    if (conn.stream && typeof conn.stream.destroy === 'function') {
      try { conn.stream.destroy(); } catch (e) {}
    }
    if (conn.res && !conn.res.writableEnded) {
      try { conn.res.end(); } catch (e) {}
    }

    activeConnections.delete(key);
    console.log(`✅ Stream killed for ${key}`);
    return true;
  }
  return false;
}

app.delete('/api/proxy/stream/:mac/:channelId', (req, res) => {
  const { mac, channelId } = req.params;
  const killed = killStream(mac, channelId);
  res.json({ success: killed, message: killed ? 'Stream terminated' : 'Stream not found' });
});

// Main proxy stream endpoint
app.get('/api/proxy/stream', async (req, res) => {
    let response = null;
    let connectionKey = null;
    
    try {
        let { url, mac, channelId, force_sw } = req.query;
        
        console.log('📥 Proxy request received:', { 
            url: url ? url.substring(0, 100) + '...' : 'missing',
            mac: mac || 'missing',
            channelId: channelId || 'missing',
            force_sw: force_sw || '0'
        });
        
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const decodedUrl = decodeURIComponent(url);
        
        if (!channelId || channelId === 'undefined') {
            const match = decodedUrl.match(/stream=(\d+)/) || decodedUrl.match(/\/(\d+)(?:\.ts)?$/);
            channelId = match ? match[1] : 'unknown';
        }

        if (!mac || mac === 'undefined') {
            const macMatch = decodedUrl.match(/mac=([^&]+)/);
            mac = macMatch ? macMatch[1] : 'unknown';
        }

        if (mac && mac !== 'unknown' && channelId && channelId !== 'unknown') {
            console.log(`🪓 Killing existing stream for MAC: ${mac}, Channel: ${channelId}`);
            killStream(mac, channelId);
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const urlKey = decodedUrl.split('?')[0];
        if (fetchingUrls.has(urlKey)) {
            return res.status(429).json({ error: 'Duplicate stream request' });
        }
        fetchingUrls.add(urlKey);
        setTimeout(() => fetchingUrls.delete(urlKey), 3000);

        let host;
        try {
            host = new URL(decodedUrl).host;
        } catch (e) {
            fetchingUrls.delete(urlKey);
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const headers = {
            'User-Agent': 'Lavf53.32.100',
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
            'Connection': 'keep-alive',
            'Host': host
        };

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
            console.log('🎬 SW Mode - Using FFmpeg stdin (reliable)');
            
            const { spawn } = require('child_process');
            const ffmpegStatic = require('ffmpeg-static');
            
            if (!ffmpegStatic) {
                throw new Error('ffmpeg-static not found - run npm install ffmpeg-static');
            }
            
const ffmpegArgs = [
  '-loglevel', 'error',

  // Input flags: Keep a moderate buffer to avoid flooding but allow smooth start
  '-fflags', '+genpts+discardcorrupt',
  '-flags', 'low_delay',
  '-analyzeduration', '10000000',   // Increase to 10s for better stream analysis
  '-probesize', '10000000',
  '-re',                             // ** KEY FIX: Read input at native frame rate. Prevents ffmpeg from consuming data too fast. **
  '-i', 'pipe:0',

  // Map streams
  '-map', '0:v:0',
  '-map', '0:a:0?',

  '-max_muxing_queue_size', '4000', // Increase queue size to handle jitter

  // Video encoding: Use a balanced preset and a more robust profile
  '-c:v', 'libx264',
  '-preset', 'veryfast',            // ** USE veryfast instead of ultrafast for much better compression **
  '-tune', 'zerolatency',
  '-profile:v', 'main',             // Use 'main' profile for better compatibility
  '-pix_fmt', 'yuv420p',
  '-g', '30',                       // Slightly larger GOP (keyframe interval) for bitrate efficiency
  '-keyint_min', '30',
  '-sc_threshold', '0',

  // Rate Control: Use CRF for constant quality with a bitrate cap for safety
  '-crf', '23',                     // Constant Rate Factor (lower is better, 23 is a good start)
  '-maxrate', '2000k',              // Allow higher peak bitrate
  '-bufsize', '4000k',             // ** INCREASE buffer size to 4x maxrate for stability **

  // Audio encoding
  '-c:a', 'aac',
  '-b:a', '96k',
  '-ar', '44100',
  '-ac', '2',

  // Output
  '-f', 'mpegts',
  'pipe:1'
];
          console.log(ffmpegArgs.join(' '));
            
            const ffmpeg = spawn(ffmpegStatic, ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            res.setHeader('Content-Type', 'video/mp2t');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('X-Transcoded', 'true');
            res.setHeader('Connection', 'close');
            
            activeConnections.set(connectionKey, {
                stream: response.data,
                ffmpeg: ffmpeg,
                res: res,
                timestamp: Date.now()
            });
            
            response.data.pipe(ffmpeg.stdin);
            ffmpeg.stdout.pipe(res);
            
            ffmpeg.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg && (msg.includes('error') || msg.includes('Error'))) {
                    console.log('🎬 FFmpeg:', msg.substring(0, 200));
                }
            });
            
            ffmpeg.on('close', (code) => {
                console.log(`🎬 FFmpeg closed (code ${code}) for ${connectionKey}`);
                activeConnections.delete(connectionKey);
                fetchingUrls.delete(urlKey);
            });
            
            ffmpeg.on('error', (err) => {
                console.error('❌ FFmpeg error:', err.message);
                activeConnections.delete(connectionKey);
                fetchingUrls.delete(urlKey);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Transcoding failed' });
                }
            });
            
            res.on('close', () => {
                console.log(`🔌 Client disconnected for ${connectionKey}`);
                try { ffmpeg.kill('SIGTERM'); } catch (e) {}
                try { response.data.destroy(); } catch (e) {}
                activeConnections.delete(connectionKey);
                fetchingUrls.delete(urlKey);
            });
            
        } else {
            // Passthrough mode
            console.log('📦 Passthrough mode');
            
            const responseHeaders = {
                'Content-Type': response.headers['content-type'] || 'video/mp2t',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*',
                'Connection': 'close'
            };
            
            res.set(responseHeaders);
            
            activeConnections.set(connectionKey, {
                stream: response.data,
                res: res,
                timestamp: Date.now()
            });
            
            response.data.pipe(res);
            
            response.data.on('end', () => {
                activeConnections.delete(connectionKey);
                fetchingUrls.delete(urlKey);
            });
            
            response.data.on('error', (err) => {
                console.error('Stream error:', err.message);
                activeConnections.delete(connectionKey);
                fetchingUrls.delete(urlKey);
            });
            
            res.on('close', () => {
                try { response.data.destroy(); } catch (e) {}
                activeConnections.delete(connectionKey);
                fetchingUrls.delete(urlKey);
            });
        }

    } catch (error) {
        console.error('❌ Proxy error:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Streaming failed: ' + error.message });
        }
    }
});

app.get('/api/proxy/test', (req, res) => {
    res.json({ message: 'Proxy route is working' });
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/playlists', require('./routes/playlists'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/fast-sync', require('./routes/fastSync'));

// Token refresh
const tokenRefreshService = require('./services/tokenRefreshService');
app.use('/api/admin/token', require('./routes/tokenRoutes'));

setInterval(async () => {
  console.log('⏰ Running scheduled token refresh...');
  try { await tokenRefreshService.refreshAllPlaylists(); } 
  catch (error) { console.error('Token refresh failed:', error); }
}, 6 * 60 * 60 * 1000);

setTimeout(() => {
  tokenRefreshService.refreshAllPlaylists().catch(console.error);
}, 10000);

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Something went wrong!' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

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
