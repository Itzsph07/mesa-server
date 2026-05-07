const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin', 'linux');
const FFMPEG_PATH = path.join(BIN_DIR, 'ffmpeg');

// Skip if FFmpeg already exists
if (fs.existsSync(FFMPEG_PATH)) {
    console.log('✅ FFmpeg already installed at:', FFMPEG_PATH);
    // Make sure it's executable
    try { fs.chmodSync(FFMPEG_PATH, '755'); } catch (e) {}
    process.exit(0);
}

console.log('📥 Downloading FFmpeg for Linux x64...');

// Create bin directory
if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
}

// Static FFmpeg build for Linux (works on most distros)
const FFMPEG_URL = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
const ARCHIVE_PATH = path.join(BIN_DIR, 'ffmpeg.tar.xz');

console.log(`   Downloading from: ${FFMPEG_URL}`);

// Download the file
const file = fs.createWriteStream(ARCHIVE_PATH);
https.get(FFMPEG_URL, (response) => {
    // Handle redirects
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        https.get(response.headers.location, (redirectRes) => {
            redirectRes.pipe(file);
        });
        return;
    }
    response.pipe(file);
});

file.on('finish', () => {
    file.close();
    console.log('✅ Download complete!');
    console.log('📦 Extracting...');
    
    try {
        // Extract tar.xz
        execSync(`tar -xf "${ARCHIVE_PATH}" -C "${BIN_DIR}"`, { stdio: 'inherit' });
        
        // Find ffmpeg binary in extracted folder
        const files = fs.readdirSync(BIN_DIR);
        let found = false;
        
        for (const file of files) {
            const fullPath = path.join(BIN_DIR, file);
            const ffmpegBinPath = path.join(fullPath, 'ffmpeg');
            
            if (fs.existsSync(ffmpegBinPath)) {
                // Move ffmpeg to our desired location
                fs.copyFileSync(ffmpegBinPath, FFMPEG_PATH);
                // Copy ffprobe too (useful for debugging)
                const ffprobeBinPath = path.join(fullPath, 'ffprobe');
                if (fs.existsSync(ffprobeBinPath)) {
                    fs.copyFileSync(ffprobeBinPath, path.join(BIN_DIR, 'ffprobe'));
                }
                
                // Remove extracted folder
                fs.rmSync(fullPath, { recursive: true, force: true });
                found = true;
                break;
            }
        }
        
        if (found) {
            // Make executable
            fs.chmodSync(FFMPEG_PATH, '755');
            console.log('✅ FFmpeg installed successfully!');
            console.log(`   Location: ${FFMPEG_PATH}`);
        } else {
            console.error('❌ Could not find ffmpeg binary in archive');
        }
        
        // Clean up archive
        fs.unlinkSync(ARCHIVE_PATH);
        
    } catch (error) {
        console.error('❌ Extraction failed:', error.message);
        console.log('   Try manual installation:');
        console.log('   1. Download static build from https://johnvansickle.com/ffmpeg/');
        console.log('   2. Extract ffmpeg binary');
        console.log(`   3. Place it at: ${FFMPEG_PATH}`);
    }
});

file.on('error', (err) => {
    console.error('❌ Download failed:', err.message);
    console.log('   The server will use system ffmpeg if available.');
});
