import os from 'os';
import fs from 'fs';
import axios from 'axios';

// Safety buffer reserved for system RAM (150 MB)
export const SAFETY_BUFFER_BYTES = 150 * 1024 * 1024;

// Dynamic Max Allowable Download Size based on current Free RAM
export function getMaxAllowedDownloadSize() {
    const freeRam = os.freemem();
    const maxDownloadSize = freeRam - SAFETY_BUFFER_BYTES;
    return {
        freeRamBytes: freeRam,
        maxDownloadBytes: maxDownloadSize > 0 ? maxDownloadSize : 0
    };
}

// ✅ Parse Content-Disposition header properly (handles filename= AND filename*=UTF-8'')
export function parseContentDisposition(disposition) {
    if (!disposition) return null;

    // 1️⃣ Prefer RFC 5987 encoded filename* (UTF-8)
    const utf8Match = disposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i);
    if (utf8Match && utf8Match[1]) {
        try {
            return decodeURIComponent(utf8Match[1].trim());
        } catch (e) {
            return utf8Match[1].trim();
        }
    }

    // 2️⃣ Fallback: standard filename=
    const match = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (match && match[1]) {
        return match[1].trim();
    }

    return null;
}

// Clean File Name
export function cleanFileName(name) {
    if (!name) return 'downloaded_file';
    try {
        name = decodeURIComponent(name);
    } catch (e) {}
    
    return name
        .replace(/\[?\s*cinesubz\.(com -|com|co)\s*\]?/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Format Bytes to Human Readable Size
export function formatBytes(bytes, decimals = 2) {
    if (!bytes || isNaN(bytes) || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Get File Metadata Safely
export async function getFileMetaData(url) {
    let fileName = url.split('/').pop().split('?')[0] || 'downloaded_file';
    let fileSize = 'Unknown Size';
    let sizeInBytes = 0;

    try {
        const headRes = await axios.head(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 5000
        });

        const length = headRes.headers['content-length'];
        if (length) {
            sizeInBytes = parseInt(length, 10);
            fileSize = formatBytes(sizeInBytes);
        }

        // ✅ FIXED: proper content-disposition parsing
        const parsedName = parseContentDisposition(headRes.headers['content-disposition']);
        if (parsedName) fileName = parsedName;
    } catch (e) {
        try {
            const rangeRes = await axios.get(url, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Range': 'bytes=0-0'
                },
                timeout: 5000
            });
            const contentRange = rangeRes.headers['content-range'];
            if (contentRange) {
                const total = contentRange.split('/')[1];
                if (total && !isNaN(total)) {
                    sizeInBytes = parseInt(total, 10);
                    fileSize = formatBytes(sizeInBytes);
                }
            }

            // ✅ FIXED: proper content-disposition parsing
            const parsedName = parseContentDisposition(rangeRes.headers['content-disposition']);
            if (parsedName) fileName = parsedName;
        } catch (err) {}
    }

    fileName = cleanFileName(fileName);
    return { fileName, fileSize, sizeInBytes };
}

// Get Detailed OS & Hosting Environment Info
export function getDetailedOS() {
    const platform = os.platform();

    if (platform === 'win32') return 'Windows';
    if (platform === 'darwin') return 'macOS';
    
    if (process.env.PREFIX && process.env.PREFIX.includes('com.termux')) {
        return 'Android (Termux)';
    }

    if (platform === 'linux') {
        let osName = 'Linux';

        try {
            if (fs.existsSync('/etc/os-release')) {
                const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
                const match = osRelease.match(/^PRETTY_NAME="(.*)"$/m) || osRelease.match(/^NAME="(.*)"$/m);
                if (match && match[1]) {
                    osName = match[1].replace(/["']/g, '');
                }
            }
        } catch (e) {
            osName = 'Linux (Generic)';
        }

        let cloudEnv = '';
        if (process.env.HEROKU_APP_ID || process.env.DYNO) cloudEnv = ' [Heroku]';
        else if (process.env.KOYEB_SERVICE_ID) cloudEnv = ' [Koyeb]';
        else if (process.env.RENDER_SERVICE_ID) cloudEnv = ' [Render]';
        else if (process.env.RAILWAY_SERVICE_ID) cloudEnv = ' [Railway]';
        else if (fs.existsSync('/.dockerenv')) cloudEnv = ' [Docker Container]';

        return `${osName}${cloudEnv}`;
    }

    return platform;
}
