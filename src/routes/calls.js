import express from 'express';
import { z } from 'zod';
import { db } from '../config/db.js';
import { requireParentAuth, requireDeviceAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { getIO } from '../sockets/index.js';
import { queueSnapshotCommand } from './snapshots.js';

const router = express.Router();

const callItemSchema = z.object({
  deviceCallId: z.string().min(1),
  phoneNumber: z.string().min(1).max(50),
  contactName: z.string().max(100).optional().nullable(),
  callType: z.enum(['incoming', 'outgoing', 'missed', 'rejected', 'blocked', 'voicemail', 'unknown']).default('unknown'),
  durationSeconds: z.number().int().min(0).default(0),
  timestamp: z.string().or(z.number()),
});

const syncCallsSchema = z.object({
  calls: z.array(callItemSchema).max(500),
});

// ── POST /api/calls/sync (Child device pushes call history batch) ─────────────
router.post('/sync', requireDeviceAuth, async (req, res, next) => {
  try {
    const { calls } = syncCallsSchema.parse(req.body);
    const childId = req.device.child_id;
    const parentId = req.device.parent_id;

    if (!calls || calls.length === 0) {
      return res.json({ success: true, inserted: 0 });
    }

    let insertedCount = 0;

    for (const call of calls) {
      const callDate = typeof call.timestamp === 'number'
        ? new Date(call.timestamp)
        : new Date(call.timestamp);

      try {
        const query = `
          INSERT INTO call_logs (
            child_id, parent_id, call_type, phone_number, contact_name,
            duration_seconds, timestamp, device_call_id, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (child_id, device_call_id) DO NOTHING
          RETURNING id;
        `;
        const result = await db.raw(query, [
          childId,
          parentId,
          call.callType,
          call.phoneNumber,
          call.contactName || null,
          call.durationSeconds,
          callDate,
          call.deviceCallId,
        ]);

        if (result.rows && result.rows.length > 0) {
          insertedCount++;
        }
      } catch (insertErr) {
        // Continue with other calls if one fails
        console.warn('Call insert notice:', insertErr.message);
      }
    }

    if (insertedCount > 0) {
      console.log(`📞 Synced ${insertedCount} new call logs for child ${childId}`);
      try {
        const io = getIO();
        io.to(`parent:${parentId}`).emit('calls:updated', {
          childId,
          newCount: insertedCount,
        });
      } catch (_sockErr) {}
    }

    res.json({ success: true, count: insertedCount, totalReceived: calls.length });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', issues: err.issues });
    }
    next(err);
  }
});

// ── GET /api/calls/child/:childId (Parent queries child's call logs) ──────────
router.get('/child/:childId', requireParentAuth, async (req, res, next) => {
  try {
    const { childId } = req.params;
    const { type = 'all', search, limit = 50, offset = 0 } = req.query;

    // Verify child belongs to parent
    const child = await db('children')
      .where({ id: childId, parent_id: req.parent.id })
      .first();

    if (!child) {
      throw new AppError('Child not found or unauthorized', 404);
    }

    let query = db('call_logs')
      .where({ child_id: childId, parent_id: req.parent.id });

    if (type && type !== 'all') {
      query = query.where({ call_type: type });
    }

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      query = query.where(function () {
        this.whereILike('phone_number', term)
          .orWhereILike('contact_name', term);
      });
    }

    const totalCountQuery = query.clone().count('id as count').first();
    const callsQuery = query
      .orderBy('timestamp', 'desc')
      .limit(Math.min(Number(limit) || 50, 150))
      .offset(Number(offset) || 0);

    const [totalRow, calls] = await Promise.all([totalCountQuery, callsQuery]);

    res.json({
      success: true,
      total: Number(totalRow?.count || 0),
      calls,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/calls/request-sync (Parent asks child to sync latest call logs now) ──
router.post('/request-sync', requireParentAuth, async (req, res, next) => {
  try {
    const { childId } = req.body;
    if (!childId) {
      return res.status(400).json({ error: 'childId is required' });
    }

    const child = await db('children')
      .where({ id: childId, parent_id: req.parent.id })
      .first();

    if (!child) {
      throw new AppError('Child not found or unauthorized', 404);
    }

    const reqId = `calls_${Date.now()}`;
    const cmd = queueSnapshotCommand(childId, {
      requestId: reqId,
      mediaType: 'sync_call_logs',
    });

    try {
      const io = getIO();
      io.to(`child:${childId}`).emit('call_logs:request_sync', {
        childId,
        requestId: reqId,
      });
    } catch (_sockErr) {}

    res.json({ success: true, message: 'Sync command queued for child device', requestId: reqId });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/calls/:id (Parent removes a call log entry) ───────────────────
router.delete('/:id', requireParentAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const deleted = await db('call_logs')
      .where({ id, parent_id: req.parent.id })
      .delete();

    if (!deleted) {
      throw new AppError('Call log not found or unauthorized', 404);
    }

    res.json({ success: true, message: 'Call log deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
