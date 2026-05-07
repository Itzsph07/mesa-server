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

// Centralized cleanup function to avoid code duplication and ensure complete cleanup
function cleanupConnection(connectionKey, urlKey) {
  const conn = activeConnections.get(connectionKey);
  if (conn) {
    console.log(`🧹 Cleaning up connection: ${connectionKey}`);
    
    // Kill ffmpeg first - try process group kill for complete termination
    if (conn.ffmpeg && conn.ffmpeg.pid) {
      try {
        // Kill entire process group to ensure all child processes die
        process.kill(-conn.ffmpeg.pid, 'SIGKILL');
        console.log(`   Killed FFmpeg process group: ${conn.ffmpeg.pid}`);
      } catch (e) {
        // Fallback if process group kill fails (e.g., on Windows)
        try { conn.ffmpeg.kill('SIGKILL'); } catch (e2) {
          console.error('   Failed to kill FFmpeg:', e2.message);
        }
      }
    }
    
    // Destroy the source stream
    if (conn.stream) {
      try { 
        conn.stream.unpipe(); // Remove all pipe connections
        conn.stream.destroy(); 
      } catch (e) {
        console.error('   Error destroying stream:', e.message);
      }
    }
    
    // End the response properly
    if (conn.res && !conn.res.writableEnded && !conn.res.finished) {
      try { 
        if (!conn.res.headersSent) {
          conn.res.status(410).json({ error: 'Stream terminated by user' });
        } else {
          conn.res.end(); 
        }
      } catch (e) {
        console.error('   Error ending response:', e.message);
      }
    }
    
    // Clear timeout if set
    if (conn.timeoutId) {
      clearTimeout(conn.timeoutId);
    }
    
    activeConnections.delete(connectionKey);
    console.log(`✅ Connection cleaned up: ${connectionKey}`);
  }
  
  // Always clean up the fetching URL flag
  if (urlKey) {
    fetchingUrls.delete(urlKey);
  }
}

function killStream(mac, channelId) {
  const key = `${mac}_${channelId}`;
  if (!activeConnections.has(key)) {
    console.log(`⚠️ No active connection found for ${key}`);
    return false;
  }

  const conn = activeConnections.get(key);
  console.log(`🪓 Force killing stream for MAC: ${mac}, Channel: ${channelId}`);

  // Use the centralized cleanup
  cleanupConnection(key, null);
  console.log(`✅ Stream killed for ${key}`);
  return true;
}

app.delete('/api/proxy/stream/:mac/:channelId', (req, res) => {
  const { mac, channelId } = req.params;
  const killed = killStream(mac, channelId);
  res.json({ success: killed, message: killed ? 'Stream terminated' : 'Stream not found' });
});

// Debug endpoint to check active connections
app.get('/api/proxy/active-streams', (req, res) => {
  const streams = [];
  activeConnections.forEach((conn, key) => {
    streams.push({
      key,
      timestamp: new Date(conn.timestamp).toISOString(),
      age: Math.floor((Date.now() - conn.timestamp) / 1000) + 's',
      hasFFmpeg: !!conn.ffmpeg,
      responseEnded: conn.res?.writableEnded || false,
      responseFinished: conn.res?.finished || false
    });
  });
  
  res.json({
    active: streams,
    total: activeConnections.size
  });
});

// Main proxy stream endpoint
app.get('/api/proxy/stream', async (req, res) => {
    let response = null;
    let connectionKey = null;
    let urlKey = null;
    
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

        urlKey = decodedUrl.split('?')[0];
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
            console.log('🎬 SW Mode - Using FFmpeg with improved settings');
            
            const { spawn } = require('child_process');
            const ffmpegStatic = require('ffmpeg-static');
            
            if (!ffmpegStatic) {
                throw new Error('ffmpeg-static not found - run npm install ffmpeg-static');
            }
            
            const ffmpegArgs = [
              '-loglevel', 'error',

              // Improved input handling for stability
              '-fflags', '+genpts+discardcorrupt',
              '-flags', 'low_delay',
              '-strict', 'experimental',
              '-analyzeduration', '20000000',   // 20 seconds - more time to analyze
              '-probesize', '20000000',         // Match analyzeduration
              '-thread_queue_size', '512',      // Larger input thread queue
              '-re',
              '-i', 'pipe:0',

              '-map', '0:v:0',
              '-map', '0:a:0?',

              '-max_muxing_queue_size', '8000', // Increased for stability
              '-muxdelay', '0',
              '-muxpreload', '0',

              // Balanced encoding for quality and stability
              '-c:v', 'libx264',
              '-preset', 'veryfast',           // Better compression than ultrafast
              '-tune', 'zerolatency',
              '-profile:v', 'main',
              '-pix_fmt', 'yuv420p',
              '-g', '15',                       // Smaller GOP for faster recovery
              '-keyint_min', '15',
              '-sc_threshold', '0',
              '-refs', '1',                     // Single reference frame for lower latency
              '-rc-lookahead', '0',            // Disable lookahead for zero latency

              // Rate control with headroom
              '-crf', '23',                     // Constant quality
              '-maxrate', '2500k',              // Higher peak bitrate allowed
              '-bufsize', '5000k',              // Larger buffer for stability
              
              // Audio
              '-c:a', 'aac',
              '-b:a', '96k',
              '-ar', '44100',
              '-ac', '2',

              '-f', 'mpegts',
              'pipe:1'
            ];
            
            console.log('FFmpeg args:', ffmpegArgs.join(' '));
            
            const ffmpeg = spawn(ffmpegStatic, ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: true  // Allow killing the process group
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
                timestamp: Date.now(),
                timeoutId: setTimeout(() => {
                    console.log(`⏰ Stream timeout for ${connectionKey}`);
                    cleanupConnection(connectionKey, urlKey);
                }, 300000) // 5-minute timeout as safety
            });
            
            // Pipe data with error handling
            response.data.on('error', (err) => {
                console.error('📡 Source stream error:', err.message);
                cleanupConnection(connectionKey, urlKey);
            });
            
            ffmpeg.stdin.on('error', (err) => {
                if (err.code !== 'EPIPE') {
                    console.error('❌ FFmpeg stdin error:', err.message);
                }
                cleanupConnection(connectionKey, urlKey);
            });
            
            ffmpeg.stdout.on('error', (err) => {
                console.error('❌ FFmpeg stdout error:', err.message);
                cleanupConnection(connectionKey, urlKey);
            });
            
            ffmpeg.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg && (msg.includes('error') || msg.includes('Error'))) {
                    console.log('🎬 FFmpeg:', msg.substring(0, 200));
                }
            });
            
            ffmpeg.on('error', (err) => {
                console.error('❌ FFmpeg spawn error:', err.message);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Transcoding failed to start' });
                }
                cleanupConnection(connectionKey, urlKey);
            });
            
            ffmpeg.on('close', (code, signal) => {
                console.log(`🎬 FFmpeg closed (code: ${code}, signal: ${signal}) for ${connectionKey}`);
                cleanupConnection(connectionKey, urlKey);
            });
            
            res.on('close', () => {
                console.log(`🔌 Client disconnected for ${connectionKey}`);
                cleanupConnection(connectionKey, urlKey);
            });
            
            // Start piping
            response.data.pipe(ffmpeg.stdin);
            ffmpeg.stdout.pipe(res);
            
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
                timestamp: Date.now(),
                timeoutId: setTimeout(() => {
                    console.log(`⏰ Stream timeout for ${connectionKey}`);
                    cleanupConnection(connectionKey, urlKey);
                }, 300000) // 5-minute timeout as safety
            });
            
            response.data.on('error', (err) => {
                console.error('Stream error:', err.message);
                cleanupConnection(connectionKey, urlKey);
            });
            
            response.data.on('end', () => {
                console.log('📡 Source stream ended');
                cleanupConnection(connectionKey, urlKey);
            });
            
            res.on('close', () => {
                console.log(`🔌 Client disconnected for ${connectionKey}`);
                cleanupConnection(connectionKey, urlKey);
            });
            
            response.data.pipe(res);
        }

    } catch (error) {
        console.error('❌ Proxy error:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Streaming failed: ' + error.message });
        }
        cleanupConnection(connectionKey, urlKey);
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
