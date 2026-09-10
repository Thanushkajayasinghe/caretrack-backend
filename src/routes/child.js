import express from 'express';
import { z } from 'zod';
import { db } from '../config/db.js';
import { requireParentAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

const createChildSchema = z.object({
  name: z.string().min(1).max(100),
  avatarColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

// ── GET /api/children ─────────────────────────────────────────────────────────
router.get('/', requireParentAuth, async (req, res, next) => {
  try {
    const children = await db('children')
      .leftJoin('child_devices', function () {
        this.on('children.id', '=', 'child_devices.child_id')
          .andOn('child_devices.is_active', '=', db.raw('true'));
      })
      .where('children.parent_id', req.parent.id)
      .select(
        'children.id',
        'children.name',
        'children.avatar_url',
        'children.avatar_color',
        'children.created_at',
        'child_devices.id as device_id',
        'child_devices.device_name',
        'child_devices.android_version',
        'child_devices.last_seen',
        'child_devices.battery_level as device_battery_level',
        'child_devices.is_charging as device_is_charging',
      );

    // Enrich with last location
    const enriched = await Promise.all(
      children.map(async (child) => {
        const lastLocation = await db('locations')
          .where({ child_id: child.id })
          .select(
            db.raw('ST_Y(location::geometry) as lat'),
            db.raw('ST_X(location::geometry) as lng'),
            'speed', 'heading', 'battery_level', 'is_charging', 'recorded_at',
          )
          .orderBy('recorded_at', 'desc')
          .first();

        if (lastLocation) {
          if (child.device_battery_level != null) {
            lastLocation.battery_level = child.device_battery_level;
          }
          if (child.device_is_charging != null) {
            lastLocation.is_charging = child.device_is_charging;
          }
        }

        const lastSeenTime = child.last_seen ? new Date(child.last_seen).getTime() : 0;
        const lastLocTime = lastLocation?.recorded_at ? new Date(lastLocation.recorded_at).getTime() : 0;
        const mostRecent = Math.max(lastSeenTime, lastLocTime);
        const isOnline = mostRecent > 0 && (Date.now() - mostRecent) < 180000; // Online if seen within 3 minutes

        return { ...child, isOnline, lastLocation: lastLocation || null };
      }),
    );

    res.json({ children: enriched });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/children ────────────────────────────────────────────────────────
router.post('/', requireParentAuth, async (req, res, next) => {
  try {
    const { name, avatarColor } = createChildSchema.parse(req.body);
    const [child] = await db('children')
      .insert({ parent_id: req.parent.id, name, avatar_color: avatarColor })
      .returning(['id', 'name', 'avatar_color', 'created_at']);
    res.status(201).json({ child });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', issues: err.issues });
    }
    next(err);
  }
});

// ── GET /api/children/:id ─────────────────────────────────────────────────────
router.get('/:id', requireParentAuth, async (req, res, next) => {
  try {
    const child = await db('children')
      .where({ id: req.params.id, parent_id: req.parent.id })
      .first();
    if (!child) throw new AppError('Child not found', 404);

    const devices = await db('child_devices')
      .where({ child_id: child.id, is_active: true })
      .select('id', 'device_name', 'android_version', 'last_seen', 'created_at');

    res.json({ child, devices });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/children/:id ──────────────────────────────────────────────────
router.delete('/:id', requireParentAuth, async (req, res, next) => {
  try {
    const deleted = await db('children')
      .where({ id: req.params.id, parent_id: req.parent.id })
      .delete();
    if (!deleted) throw new AppError('Child not found', 404);
    res.json({ message: 'Child removed' });
  } catch (err) {
    next(err);
  }
});

export default router;
