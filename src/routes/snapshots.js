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
    let ext = '.m4a';
    let mimeType = 'audio/mp4';
    if (mediaType === 'screenshot' || mediaType === 'camera_photo') {
      ext = '.jpg';
      mimeType = 'image/jpeg';
    } else if (mediaType === 'camera_video') {
      ext = '.mp4';
      mimeType = 'video/mp4';
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

    // Determine content type
    let contentType = 'application/octet-stream';
    if (safeName.endsWith('.m4a') || safeName.endsWith('.aac')) contentType = 'audio/mp4';
    else if (safeName.endsWith('.jpg') || safeName.endsWith('.jpeg')) contentType = 'image/jpeg';
    else if (safeName.endsWith('.png')) contentType = 'image/png';
    else if (safeName.endsWith('.mp4')) contentType = 'video/mp4';

    res.setHeader('Content-Type', contentType);
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
