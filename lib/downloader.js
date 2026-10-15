import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import mime from 'mime-types';
import { fileTypeFromFile } from 'file-type';
import { SAFETY_BUFFER_BYTES, cleanFileName, parseContentDisposition } from './utils.js';

export const TEMP_DIR = './temp';
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

export const downloadQueue = [];
export let isProcessingQueue = false;

export async function processQueue(sock) {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (downloadQueue.length > 0) {
        const task = downloadQueue[0];
        task.status = 'downloading';
        task.downloadedBytes = 0;
        task.totalBytes = 0;
        task.startTime = Date.now();
        task.speed = 0;
        task.abortController = new AbortController();

        const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${Math.random().toString(36).substring(2, 7)}.tmp`);

        // ✅ FIX #1: Declare `writer` outside try so catch/finally can access it
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

            // ✅ FIX #2: `let` (was `const`) so we can assign after creation
            writer = fs.createWriteStream(tempFilePath);

            await new Promise((resolve, reject) => {
                response.data.on('data', (chunk) => {
                    task.downloadedBytes += chunk.length;

                    const currentFree = os.freemem();
                    if (currentFree < SAFETY_BUFFER_BYTES) {
                        task.abortController.abort();

                        // ✅ FIX #3: Close writer IMMEDIATELY on RAM abort
                        if (writer && !writer.destroyed) {
                            writer.destroy();
                        }

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

                // ✅ FIX #4: Close writer on network/stream error
                response.data.on('error', (err) => {
                    if (writer && !writer.destroyed) {
                        writer.destroy();
                    }
                    reject(err);
                });
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

            // ✅ FIXED: proper content-disposition parsing (no more duplicate names)
            const parsedName = parseContentDisposition(response.headers['content-disposition']);
            if (parsedName) fileName = parsedName;

            fileName = cleanFileName(fileName);

            // ✅ FIXED: robust extension check — no more "my.video" -> "my.video.mp4" mishaps
            const hasKnownExt = /\.[a-z0-9]{2,5}$/i.test(fileName);
            if (!hasKnownExt || fileName.toLowerCase().endsWith('.bin')) {
                const baseName = fileName.replace(/\.bin$/i, '');
                fileName = ext ? `${baseName}.${ext}` : baseName;
            }

            task.fileName = fileName;

            await sock.sendMessage(task.from, {
                document: { url: tempFilePath },
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
            // ✅ FIX #5: Safety net — force-close writer if still open (any path)
            if (writer && !writer.destroyed) {
                try {
                    writer.destroy();
                } catch (e) {}
            }

            // Small delay ensures OS releases the file lock before deletion (Windows-safe)
            await new Promise(r => setTimeout(r, 100));

            if (fs.existsSync(tempFilePath)) {
                try {
                    fs.unlinkSync(tempFilePath);
                } catch (e) {
                    // Fallback async delete if sync fails
                    fs.unlink(tempFilePath, () => {});
                }
            }

            if (downloadQueue.length > 0 && downloadQueue[0] === task) {
                downloadQueue.shift();
            }
        }
    }

    isProcessingQueue = false;
}
