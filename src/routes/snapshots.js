import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../config/db.js';
import { requireDeviceAuth, requireParentAuth } from '../middleware/auth.js';
import { getIO } from '../sockets/index.js';
import { AppError } from '../middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/snapshots');

// Ensure upload directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const router = express.Router();

// ── In-memory pending command queue & long-poll waiters ──────────────────────
export const pendingSnapshots = new Map(); // childId -> { requestId, mediaType, durationSeconds, cameraFacing, createdAt }
const pollWaiters = new Map(); // childId -> Set<Response>
export const activeLiveStreams = new Map(); // childId -> { res, parentId, startTime, timer }

export function endActiveLiveStream(childId) {
  const active = activeLiveStreams.get(childId);
  if (active) {
    try {
      if (active.timer) clearTimeout(active.timer);
      if (!active.res.headersSent) {
        active.res.status(200).json({ success: true, message: 'Live stream ended' });
      } else {
        active.res.end();
      }
    } catch (_e) {}
    activeLiveStreams.delete(childId);
    console.log(`⏹️ Ended live audio stream for child ${childId}`);
    return true;
  }
  return false;
}

export function queueSnapshotCommand(childId, command = {}) {
  // Deduplicate: if a command was queued for this child in the last 15 seconds, return it
  const existing = pendingSnapshots.get(childId);
  if (existing && Date.now() - existing.createdAt < 15000) {
    console.log(`ℹ️ Deduplicated snapshot command for child ${childId} (already pending)`);
    return existing;
  }

  const cmd = {
    requestId: command.requestId || `req_${Date.now()}`,
    mediaType: command.mediaType || 'audio',
    durationSeconds: command.options?.durationSeconds || command.durationSeconds || 20,
    cameraFacing: command.options?.cameraFacing || command.cameraFacing || null,
    createdAt: Date.now(),
  };

  pendingSnapshots.set(childId, cmd);
  console.log(`🎙️ Queued snapshot command for child ${childId}:`, cmd);

  // If child device is waiting on long-poll, dispatch immediately!
  const waiters = pollWaiters.get(childId);
  if (waiters && waiters.size > 0) {
    for (const res of waiters) {
      try {
        if (!res.headersSent) {
          res.json({ hasCommand: true, command: cmd });
        }
      } catch (_e) {}
    }
    pollWaiters.delete(childId);
    if (cmd.mediaType === 'live_listen' || cmd.mediaType === 'live_listen_stop') {
      pendingSnapshots.delete(childId);
    }
    console.log(`⚡ Snapshot command dispatched immediately to long-poll waiter for child ${childId}`);
  }

  return cmd;
}

// ── POST /api/snapshots/live-stream (Child streams real-time PCM audio chunks) ──
router.post('/live-stream', requireDeviceAuth, (req, res) => {
  const childId = req.device.child_id;
  const parentId = req.device.parent_id;

  console.log(`🔴 Child ${childId} started streaming live audio`);

  // Terminate any previous live stream for this child
  endActiveLiveStream(childId);

  // Set safety timeout (max 5 minutes)
  const timer = setTimeout(() => {
    console.log(`⏰ Max 5-min live stream safety timeout reached for child ${childId}`);
    endActiveLiveStream(childId);
    try {
      const io = getIO();
      io.to(`parent:${parentId}`).emit('live_listen:status', {
        status: 'timeout',
        message: 'Live listening reached the 5-minute safety limit.',
        childId,
      });
    } catch (_e) {}
  }, 5 * 60 * 1000);

  activeLiveStreams.set(childId, { res, parentId, startTime: Date.now(), timer });

  // Clear live_listen from pending snapshots queue
  const pending = pendingSnapshots.get(childId);
  if (pending?.mediaType === 'live_listen') {
    pendingSnapshots.delete(childId);
  }

  // Notify parent that live stream is active
  try {
    const io = getIO();
    io.to(`parent:${parentId}`).emit('live_listen:status', {
      status: 'active',
      childId,
    });
  } catch (_e) {}

  // Stream raw PCM chunks as they arrive over HTTP chunked connection
  let chunkIndex = 0;
  req.on('data', (chunk) => {
    try {
      const io = getIO();
      const chunkBase64 = chunk.toString('base64');
      chunkIndex++;
      if (chunkIndex % 30 === 1) {
        console.log(`🔊 Relayed PCM chunk #${chunkIndex} (${chunk.length} bytes) to parent ${parentId} for child ${childId}`);
      }
      io.to(`parent:${parentId}`).emit('live_audio:chunk', {
        childId,
        chunkBase64,
        timestamp: Date.now(),
      });
    } catch (_e) {}
  });

  req.on('end', () => {
    console.log(`⏹️ Child ${childId} live stream connection ended by client`);
    endActiveLiveStream(childId);
    try {
      const io = getIO();
      io.to(`parent:${parentId}`).emit('live_listen:status', {
        status: 'ended',
        childId,
      });
    } catch (_e) {}
  });

  req.on('error', (err) => {
    console.warn(`⚠️ Child ${childId} live stream error:`, err.message);
    endActiveLiveStream(childId);
  });
});

// ── GET /api/snapshots/poll-command (Child device long-poll for snapshot commands) ──
router.get('/poll-command', requireDeviceAuth, (req, res) => {
  const childId = req.device.child_id;

  // Check if a pending command already exists
  const pending = pendingSnapshots.get(childId);
  if (pending && Date.now() - pending.createdAt < 60000) {
    if (pending.mediaType === 'live_listen' || pending.mediaType === 'live_listen_stop') {
      pendingSnapshots.delete(childId);
    }
    return res.json({ hasCommand: true, command: pending });
  }

  // Otherwise, register as waiter for up to 20 seconds
  if (!pollWaiters.has(childId)) {
    pollWaiters.set(childId, new Set());
  }
  const waiters = pollWaiters.get(childId);
  waiters.add(res);

  const timer = setTimeout(() => {
    waiters.delete(res);
    if (waiters.size === 0) pollWaiters.delete(childId);
    if (!res.headersSent) {
      res.json({ hasCommand: false });
    }
  }, 20000);

  req.on('close', () => {
    clearTimeout(timer);
    waiters.delete(res);
    if (waiters.size === 0) pollWaiters.delete(childId);
  });
});

// ── POST /api/snapshots/request (Parent triggers snapshot via REST) ───────────
const requestSnapshotSchema = z.object({
  childId: z.string().uuid(),
  mediaType: z.enum(['audio', 'screenshot', 'camera_photo', 'camera_video', 'live_listen']).default('audio'),
  durationSeconds: z.number().int().min(5).max(120).optional().default(20),
  cameraFacing: z.enum(['front', 'back']).optional().nullable(),
  requestId: z.string().optional(),
});

router.post('/request', requireParentAuth, async (req, res, next) => {
  try {
    const { childId, mediaType, durationSeconds, cameraFacing, requestId } = requestSnapshotSchema.parse(req.body);

    const child = await db('children')
      .where({ id: childId, parent_id: req.parent.id })
      .first();

    if (!child) {
      throw new AppError('Child not found or unauthorized', 404);
    }

    const cmd = queueSnapshotCommand(childId, {
      requestId: requestId || `req_${Date.now()}`,
      mediaType,
      durationSeconds,
      cameraFacing,
    });

    try {
      const io = getIO();
      io.to(`child:${childId}`).emit('snapshot:request', {
        requestId: cmd.requestId,
        childId,
        mediaType: cmd.mediaType,
        options: { durationSeconds: cmd.durationSeconds, cameraFacing: cmd.cameraFacing },
      });
    } catch (_sockErr) {}

    res.json({ success: true, command: cmd });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', issues: err.issues });
    }
    next(err);
  }
});

const uploadSnapshotSchema = z.object({
  mediaType: z.enum(['audio', 'screenshot', 'camera_photo', 'camera_video']).default('audio'),
  mediaBase64: z.string().min(1, 'mediaBase64 is required'),
  durationSeconds: z.number().int().min(1).max(120).optional().default(20),
  cameraFacing: z.enum(['front', 'back']).optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  recordedAt: z.string().optional(),
  requestId: z.string().optional(),
});

// ── POST /api/snapshots/upload (Child device uploads media snapshot) ───────────
router.post('/upload', requireDeviceAuth, async (req, res, next) => {
  try {
    const {
      mediaType,
      mediaBase64,
      durationSeconds,
      cameraFacing,
      latitude,
      longitude,
      recordedAt,
      requestId,
    } = uploadSnapshotSchema.parse(req.body);

    const childId = req.device.child_id;
    const parentId = req.device.parent_id;

    // Determine extension and MIME type
    let ext = '.aac';
    let mimeType = 'audio/aac';
    if (mediaType === 'screenshot' || mediaType === 'camera_photo') {
      ext = '.jpg';
      mimeType = 'image/jpeg';
    } else if (mediaType === 'camera_video') {
      ext = '.mp4';
      mimeType = 'video/mp4';
    }

    // Deduplicate: If an audio snapshot was created for this child in the last 15 seconds, return existing
    if (mediaType === 'audio') {
      const fifteenSecondsAgo = new Date(Date.now() - 15000);
      const existing = await db('media_snapshots')
        .where({ child_id: childId, media_type: 'audio' })
        .where('created_at', '>', fifteenSecondsAgo)
        .orderBy('created_at', 'desc')
        .first();

      if (existing) {
        console.log(`ℹ️ Deduplicated snapshot upload for child ${childId} (already uploaded within 15s)`);
        return res.status(200).json({
          success: true,
          snapshot: {
            ...existing,
            fileUrl: `/api/snapshots/file/${existing.file_name}`,
          },
        });
      }
    }

    const uniqueId = uuidv4();
    const fileName = `${childId}_${Date.now()}_${uniqueId.slice(0, 8)}${ext}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    // Write binary from base64
    const buffer = Buffer.from(mediaBase64, 'base64');
    await fs.promises.writeFile(filePath, buffer);
    const fileSizeBytes = buffer.length;

    const recordTime = recordedAt ? new Date(recordedAt) : new Date();

    const [snapshot] = await db('media_snapshots')
      .insert({
        id: uniqueId,
        child_id: childId,
        parent_id: parentId,
        media_type: mediaType,
        file_name: fileName,
        mime_type: mimeType,
        file_size_bytes: fileSizeBytes,
        duration_seconds: mediaType === 'audio' || mediaType === 'camera_video' ? durationSeconds : null,
        camera_facing: cameraFacing || null,
        latitude: latitude || null,
        longitude: longitude || null,
        recorded_at: recordTime,
        created_at: new Date(),
        is_viewed: false,
      })
      .returning('*');

    // Command fulfilled: clear from pending queue
    pendingSnapshots.delete(childId);

    // Notify connected parent via Socket.IO
    try {
      const io = getIO();
      io.to(`parent:${parentId}`).emit('snapshot:ready', {
        snapshot: {
          ...snapshot,
          fileUrl: `/api/snapshots/file/${fileName}`,
        },
        childId,
        requestId: requestId || null,
      });
    } catch (sockErr) {
      console.warn('Socket notification for snapshot:ready failed:', sockErr.message);
    }

    res.status(201).json({
      success: true,
      snapshot: {
        ...snapshot,
        fileUrl: `/api/snapshots/file/${fileName}`,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', issues: err.issues });
    }
    next(err);
  }
});

// ── GET /api/snapshots/child/:childId (Parent queries snapshots list) ─────────
router.get('/child/:childId', requireParentAuth, async (req, res, next) => {
  try {
    const { childId } = req.params;
    const { mediaType, limit = 40, offset = 0 } = req.query;

    // Verify child belongs to parent
    const child = await db('children')
      .where({ id: childId, parent_id: req.parent.id })
      .first();

    if (!child) {
      throw new AppError('Child not found or unauthorized', 404);
    }

    let query = db('media_snapshots')
      .where({ child_id: childId, parent_id: req.parent.id })
      .orderBy('recorded_at', 'desc')
      .limit(Math.min(Number(limit) || 40, 100))
      .offset(Number(offset) || 0);

    if (mediaType && mediaType !== 'all') {
      query = query.where({ media_type: mediaType });
    }

    const rows = await query;
    const snapshots = rows.map((r) => ({
      ...r,
      fileUrl: `/api/snapshots/file/${r.file_name}`,
    }));

    res.json({ snapshots });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/snapshots/file/:fileName (Serves media file with range streaming) ─
router.get('/file/:fileName', (req, res, next) => {
  try {
    const { fileName } = req.params;
    // Prevent path traversal
    const safeName = path.basename(fileName);
    const filePath = path.join(UPLOADS_DIR, safeName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Determine content type accurately for media streaming
    let contentType = 'application/octet-stream';
    if (safeName.endsWith('.aac')) contentType = 'audio/aac';
    else if (safeName.endsWith('.m4a')) contentType = 'audio/mp4';
    else if (safeName.endsWith('.mp4')) contentType = 'video/mp4';
    else if (safeName.endsWith('.jpg') || safeName.endsWith('.jpeg')) contentType = 'image/jpeg';
    else if (safeName.endsWith('.png')) contentType = 'image/png';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Accept-Ranges', 'bytes');

    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        next(err);
      }
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/snapshots/:id/viewed (Marks snapshot as listened/viewed) ─────────
router.patch('/:id/viewed', requireParentAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [updated] = await db('media_snapshots')
      .where({ id, parent_id: req.parent.id })
      .update({ is_viewed: true })
      .returning('*');

    if (!updated) {
      throw new AppError('Snapshot not found', 404);
    }

    res.json({ success: true, snapshot: updated });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/snapshots/:id (Deletes snapshot and physical file) ─────────────
router.delete('/:id', requireParentAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const snapshot = await db('media_snapshots')
      .where({ id, parent_id: req.parent.id })
      .first();

    if (!snapshot) {
      throw new AppError('Snapshot not found', 404);
    }

    // Delete record from DB
    await db('media_snapshots').where({ id }).delete();

    // Delete physical file if exists
    try {
      const filePath = path.join(UPLOADS_DIR, path.basename(snapshot.file_name));
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    } catch (_unlinkErr) {}

    res.json({ success: true, message: 'Snapshot deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
