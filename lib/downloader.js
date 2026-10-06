import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import mime from 'mime-types';
import { fileTypeFromFile } from 'file-type';
import { SAFETY_BUFFER_BYTES, cleanFileName } from './utils.js';

export const TEMP_DIR = './temp';

// FIX: Clean temp directory automatically on startup to prevent disk space leaks
export function cleanTempDir() {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    } else {
        try {
            const files = fs.readdirSync(TEMP_DIR);
            for (const file of files) {
                const filePath = path.join(TEMP_DIR, file);
                if (fs.lstatSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                }
            }
            console.log('🧹 Temp directory cleaned on startup.');
        } catch (e) {
            console.error('Failed to clean temp directory:', e.message);
        }
    }
}
cleanTempDir();

export const downloadQueue = [];
export let isProcessingQueue = false;

export async function processQueue(sock) {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        while (downloadQueue.length > 0) {
            const task = downloadQueue[0];
            task.status = 'downloading';
            task.downloadedBytes = 0;
            task.totalBytes = 0;
            task.startTime = Date.now();
            task.speed = 0;
            task.abortController = new AbortController();

            const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${Math.random().toString(36).substring(2, 7)}.tmp`);
            let writer = null;

            try {
                await sock.sendMessage(task.from, { react: { text: '⏳', key: task.msg.key } });

                const response = await axios.get(task.url, { 
                    responseType: 'stream',
                    signal: task.abortController.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });

                const total = parseInt(response.headers['content-length'] || task.sizeInBytes || 0, 10);
                task.totalBytes = total;

                writer = fs.createWriteStream(tempFilePath);

                await new Promise((resolve, reject) => {
                    response.data.on('data', (chunk) => {
                        task.downloadedBytes += chunk.length;

                        const currentFree = os.freemem();
                        if (currentFree < SAFETY_BUFFER_BYTES) {
                            task.abortController.abort();
                            reject(new Error('Download aborted! Server RAM memory critically low.'));
                            return;
                        }

                        const timeElapsed = (Date.now() - task.startTime) / 1000;
                        if (timeElapsed > 0) {
                            task.speed = task.downloadedBytes / timeElapsed;
                        }
                    });

                    response.data.pipe(writer);
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                    response.data.on('error', reject);
                });

                task.status = 'uploading';

                let mimeType = response.headers['content-type']?.split(';')[0] || 'application/octet-stream';
                let ext = mime.extension(mimeType) || '';

                const detectedType = await fileTypeFromFile(tempFilePath).catch(() => null);
                if (detectedType) {
                    mimeType = detectedType.mime;
                    ext = detectedType.ext;
                }

                let fileName = task.fileName || 'downloaded_file';
                const disposition = response.headers['content-disposition'];

                if (disposition && disposition.includes('filename=')) {
                    fileName = disposition.split('filename=')[1].replace(/["']/g, '').trim();
                }

                fileName = cleanFileName(fileName);

                if (!fileName.includes('.') || fileName.endsWith('.bin')) {
                    const baseName = fileName.replace(/\.bin$/, '');
                    fileName = ext ? `${baseName}.${ext}` : baseName;
                }

                task.fileName = fileName;

                // FIX: Pass read stream directly to prevent loading the full file into V8 RAM buffer
                await sock.sendMessage(task.from, {
                    document: fs.createReadStream(tempFilePath),
                    mimetype: mimeType,
                    fileName: fileName
                }, { quoted: task.msg });

                await sock.sendMessage(task.from, { react: { text: '✅', key: task.msg.key } });

            } catch (error) {
                if (axios.isCancel(error) || error.name === 'CanceledError' || error.name === 'AbortError') {
                    console.log(`[Canceled / Low RAM] ${task.url}`);
                    await sock.sendMessage(task.from, { react: { text: '🛑', key: task.msg.key } });
                } else {
                    console.error(`DLURL Error (${task.url}):`, error.message);
                    await sock.sendMessage(task.from, { react: { text: '❌', key: task.msg.key } });
                    await sock.sendMessage(task.from, { 
                        text: `❌ *Download Failed!*\n\n🔗 *Link:* ${task.url}\n⚠️ *Reason:* ${error.message || 'Failed to download file.'}` 
                    }, { quoted: task.msg });
                }
            } finally {
                if (writer) {
                    writer.destroy();
                }

                if (fs.existsSync(tempFilePath)) {
                    fs.unlink(tempFilePath, (err) => {
                        if (err) console.error('Error deleting temp file:', err);
                    });
                }

                if (downloadQueue.length > 0 && downloadQueue[0] === task) {
                    downloadQueue.shift();
                }
            }
        }
    } finally {
        isProcessingQueue = false;
    }
}
