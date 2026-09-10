import express from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { db } from '../config/db.js';
import { getRedis } from '../config/redis.js';
import {
  generateDeviceToken,
  hashDeviceToken,
  hashFingerprint,
} from '../services/tokenService.js';
import { requireParentAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { getIO } from '../sockets/index.js';

const router = express.Router();

const OTP_TTL = Number(process.env.PAIR_OTP_TTL_SECONDS) || 300; // 5 minutes

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── POST /api/pair/generate ───────────────────────────────────────────────────
// Parent requests a new pairing session (QR + OTP)
router.post('/generate', requireParentAuth, async (req, res, next) => {
  try {
    const { childName, childId } = req.body;

    let targetChildId = childId;

    // If childName given, reuse existing unpaired child profile or create a new one
    if (!childId && childName) {
      const trimmedName = childName.trim();
      const existingUnpaired = await db('children')
        .leftJoin('child_devices', function () {
          this.on('children.id', '=', 'child_devices.child_id')
            .andOn('child_devices.is_active', '=', db.raw('true'));
        })
        .where('children.parent_id', req.parent.id)
        .whereRaw('LOWER(TRIM(children.name)) = ?', [trimmedName.toLowerCase()])
        .whereNull('child_devices.id')
        .select('children.id', 'children.name')
        .first();

      if (existingUnpaired) {
        targetChildId = existingUnpaired.id;
      } else {
        const [child] = await db('children')
          .insert({ parent_id: req.parent.id, name: trimmedName })
          .returning(['id', 'name']);
        targetChildId = child.id;
      }
    }

    if (!targetChildId) throw new AppError('Provide childId or childName', 400);

    // Verify ownership
    const child = await db('children')
      .where({ id: targetChildId, parent_id: req.parent.id })
      .first();
    if (!child) throw new AppError('Child not found', 404);

    const otp = generateOTP();
    const sessionId = crypto.randomUUID();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    // Store in Redis with TTL (by session AND by otp for 6-digit manual entry)
    const redis = getRedis();
    const sessionData = JSON.stringify({
      sessionId,
      parentId: req.parent.id,
      childId: targetChildId,
      otpHash,
    });
    await redis.setex(`pair:${sessionId}`, OTP_TTL, sessionData);
    await redis.setex(`pair:code:${otp}`, OTP_TTL, sessionData);

    // Also store in DB for audit
    await db('pairing_sessions').insert({
      id: sessionId,
      parent_id: req.parent.id,
      child_id: targetChildId,
      code_hash: otpHash,
      expires_at: new Date(Date.now() + OTP_TTL * 1000),
    });

    // QR payload — child app deeplink
    const qrPayload = `caretrack://pair?session=${sessionId}&code=${otp}`;

    res.json({
      sessionId,
      otp,
      qrPayload,
      childId: targetChildId,
      childName: child.name,
      expiresIn: OTP_TTL, // seconds
      expiresAt: new Date(Date.now() + OTP_TTL * 1000).toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/pair/claim ──────────────────────────────────────────────────────
// Child app claims a pairing session
const claimSchema = z.object({
  sessionId: z.string().uuid().optional().nullable().or(z.literal('')),
  otp: z.string().length(6),
  deviceFingerprint: z.string().min(1),
  deviceName: z.string().optional(),
  androidVersion: z.string().optional(),
});

router.post('/claim', async (req, res, next) => {
  try {
    const { sessionId, otp, deviceFingerprint, deviceName, androidVersion } =
      claimSchema.parse(req.body);

    const redis = getRedis();
    let raw = null;
    if (sessionId) {
      raw = await redis.get(`pair:${sessionId}`);
    }
    if (!raw && otp) {
      raw = await redis.get(`pair:code:${otp}`);
    }

    let session = null;
    const inputHash = crypto.createHash('sha256').update(otp).digest('hex');

    if (raw) {
      session = JSON.parse(raw);
    } else {
      // Fallback to PostgreSQL database for resilient pairing
      const query = db('pairing_sessions')
        .where({ code_hash: inputHash, claimed: false })
        .where('expires_at', '>', new Date());
      if (sessionId) {
        query.where({ id: sessionId });
      }
      const dbSession = await query.first();
      if (dbSession) {
        session = {
          sessionId: dbSession.id,
          parentId: dbSession.parent_id,
          childId: dbSession.child_id,
          otpHash: dbSession.code_hash,
        };
      }
    }

    if (!session) throw new AppError('Pairing code expired or invalid', 410);

    if (inputHash !== session.otpHash) {
      throw new AppError('Invalid pairing code', 401);
    }

    // Check device isn't already paired to this child
    const fingerprintHash = hashFingerprint(deviceFingerprint);
    const existing = await db('child_devices')
      .where({ child_id: session.childId, device_fingerprint_hash: fingerprintHash, is_active: true })
      .first();

    const activeSessionId = session.sessionId || sessionId;

    // Generate hardware-bound device token
    const { token: deviceToken } = generateDeviceToken(
      deviceFingerprint,
      session.parentId,
      session.childId,
    );
    const tokenHash = hashDeviceToken(deviceToken);

    let deviceRecord = null;
    if (existing) {
      // Re-issue token for this device
      const [updated] = await db('child_devices')
        .where({ id: existing.id })
        .update({
          device_token_hash: tokenHash,
          device_name: deviceName || existing.device_name,
          android_version: androidVersion || existing.android_version,
          last_seen: new Date(),
        })
        .returning(['id', 'device_name']);
      deviceRecord = updated;
    } else {
      const [inserted] = await db('child_devices').insert({
        child_id: session.childId,
        device_token_hash: tokenHash,
        device_fingerprint_hash: fingerprintHash,
        device_name: deviceName || 'Android Device',
        android_version: androidVersion,
        last_seen: new Date(),
      }).returning(['id', 'device_name']);
      deviceRecord = inserted;
    }

    // Mark pairing session as claimed
    if (activeSessionId) {
      await db('pairing_sessions').where({ id: activeSessionId }).update({
        claimed: true,
        claimed_at: new Date(),
      });
      await redis.del(`pair:${activeSessionId}`);
    }
    if (otp) {
      await redis.del(`pair:code:${otp}`);
    }

    // Notify parent in real-time
    const io = getIO();
    io.to(`parent:${session.parentId}`).emit('child_paired', {
      childId: session.childId,
      deviceId: deviceRecord.id,
      deviceName: deviceRecord.device_name,
    });

    res.json({
      deviceToken,
      childId: session.childId,
      parentId: session.parentId,
      deviceId: deviceRecord.id,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const details = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
      return res.status(400).json({ error: details || 'Validation failed', issues: err.issues });
    }
    next(err);
  }
});

// ── GET /api/pair/status/:sessionId ──────────────────────────────────────────
// Poll pairing status (fallback if websocket not available)
router.get('/status/:sessionId', requireParentAuth, async (req, res, next) => {
  try {
    const redis = getRedis();
    const raw = await redis.get(`pair:${req.params.sessionId}`);
    const session = await db('pairing_sessions')
      .where({ id: req.params.sessionId, parent_id: req.parent.id })
      .first();

    if (!session) throw new AppError('Session not found', 404);

    res.json({
      claimed: session.claimed,
      expired: !raw && !session.claimed,
      claimedAt: session.claimed_at,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
