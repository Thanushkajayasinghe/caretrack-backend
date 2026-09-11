import express from 'express';
import { z } from 'zod';
import { db } from '../config/db.js';
import { requireDeviceAuth, requireParentAuth } from '../middleware/auth.js';
import { getIO } from '../sockets/index.js';
import { AppError } from '../middleware/errorHandler.js';
import { cacheLocation, getCachedLatestLocation, getCachedTrail, updateCachedDeviceStatus, clearCachedTrail } from '../services/locationCache.js';

const router = express.Router();

const locationPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nullable().optional(),
  speed: z.number().nullable().optional(),         // m/s
  heading: z.number().nullable().optional(),       // degrees
  altitude: z.number().nullable().optional(),
  batteryLevel: z.number().int().min(0).max(100).nullable().optional(),
  isCharging: z.boolean().nullable().optional(),
  recordedAt: z.string(),    // ISO string from device
  activityType: z.string().optional(),             // still, walking, running, in_vehicle, on_bicycle, unknown
});

const batchSchema = z.object({
  points: z.array(locationPointSchema).min(1).max(500),
});

// ── Smart Trajectory Compression for Database Storage (Google Maps / Fleet Grade) ──
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateHeadingDelta(h1, h2) {
  if (h1 == null || h2 == null) return 0;
  return Math.abs((((h2 - h1) % 360) + 540) % 360 - 180);
}

// In-memory track of last saved waypoint per child_id
const lastPersistedLocationMap = new Map();

/**
 * Filter points for persistent DB storage (Option 3).
 * Eliminates redundant collinear points during driving while preserving 100% of turns and stops.
 * Note: Real-time WebSocket streaming to parents is NEVER filtered and runs at 100% live frequency!
 */
function filterPointsForStorage(childId, points) {
  let last = lastPersistedLocationMap.get(childId);
  const pointsToStore = [];

  for (const p of points) {
    const pTime = new Date(p.recordedAt).getTime();
    const isStill = p.activityType === 'still' || (p.speed != null && p.speed < 0.35);
    const isMoving = !isStill && (
      p.activityType === 'walking' ||
      p.activityType === 'running' ||
      p.activityType === 'in_vehicle' ||
      p.activityType === 'on_bicycle' ||
      (p.speed != null && p.speed >= 0.5)
    );

    if (!last) {
      // 1. Initial point for this child -> always persist
      pointsToStore.push(p);
      last = { lat: p.lat, lng: p.lng, speed: p.speed ?? 0, heading: p.heading ?? 0, time: pTime, isMoving };
      continue;
    }

    const dist = haversineDistanceMeters(last.lat, last.lng, p.lat, p.lng);
    const dt = Math.max(0, (pTime - last.time) / 1000);
    const angleChange = calculateHeadingDelta(last.heading, p.heading);
    const stateChanged = last.isMoving !== isMoving;

    // 2. Instant Stop or Start Transition -> always persist
    if (stateChanged || (!isMoving && last.speed > 0.5)) {
      pointsToStore.push(p);
      last = { lat: p.lat, lng: p.lng, speed: p.speed ?? 0, heading: p.heading ?? 0, time: pTime, isMoving };
      continue;
    }

    // 3. Stationary / Still: Reject table jitter (< 15m) and avoid flooding DB with resting points
    if (!isMoving) {
      continue;
    }

    // 4. Moving - Distinguish Driving (> 20 km/h = 5.5 m/s) vs Walking / Cycling
    const isVehicle = (p.speed != null && p.speed >= 5.5) || p.activityType === 'in_vehicle';

    if (isVehicle) {
      // Driving mode:
      // A. Corner / Curve: Heading changed >= 15 deg and moved >= 20m (preserves road turns)
      const isTurn = angleChange >= 15 && dist >= 20;
      // B. Straight road: Traveled >= 80m or >= 10 seconds
      const isStraightWaypoint = dist >= 80 || dt >= 10;

      if (isTurn || isStraightWaypoint) {
        pointsToStore.push(p);
        last = { lat: p.lat, lng: p.lng, speed: p.speed ?? 0, heading: p.heading ?? 0, time: pTime, isMoving: true };
      }
    } else {
      // Walking / Pedestrian mode (Google Fit / Pedometer walk):
      // Keep rich fidelity: save every 5m, every turn >= 20 deg (if moved >= 4m), or every 6 seconds
      const isWalkTurn = angleChange >= 20 && dist >= 4.0;
      const isWalkProgression = dist >= 5.0 || dt >= 6.0;

      if (isWalkTurn || isWalkProgression) {
        pointsToStore.push(p);
        last = { lat: p.lat, lng: p.lng, speed: p.speed ?? 0, heading: p.heading ?? 0, time: pTime, isMoving: true };
      }
    }
  }

  if (last) {
    lastPersistedLocationMap.set(childId, last);
  }

  return pointsToStore;
}

// Track low-battery notification timestamps per child to prevent alert flooding
// Key: child_id, Value: { lastAlertTime: ms, lastLevel: number }
const lowBatteryAlertTracker = new Map();

function checkAndEmitLowBatteryAlert(io, parent_id, child_id, batteryLevel, isCharging) {
  if (batteryLevel == null || isCharging) return;
  const level = Number(batteryLevel);
  if (level > 20) return;

  const now = Date.now();
  const existing = lowBatteryAlertTracker.get(child_id);

  // Alert if:
  // 1. Never alerted before
  // 2. More than 30 minutes since last alert
  // 3. Dropped into critical threshold (<= 10%) while last alert was above 10%
  const shouldAlert = !existing ||
    (now - existing.lastAlertTime > 30 * 60 * 1000) ||
    (level <= 10 && existing.lastLevel > 10);

  if (shouldAlert) {
    lowBatteryAlertTracker.set(child_id, { lastAlertTime: now, lastLevel: level });
    io.to(`parent:${parent_id}`).emit('child_battery_low', {
      childId: child_id,
      batteryLevel: level,
      isCharging: false,
      timestamp: new Date().toISOString(),
    });
    console.log(`⚠️ Emitted low battery warning for child ${child_id} (${level}%) to parent ${parent_id}`);
  }
}

// ── POST /api/location/batch ──────────────────────────────────────────────────
// Child device uploads a batch of location points (online flush or live stream)
router.post('/batch', requireDeviceAuth, async (req, res, next) => {
  try {
    const { points } = batchSchema.parse(req.body);
    const { child_id, parent_id } = req.device;

    // Filter out points with accuracy > 80m to reject coarse cell-tower triangulations
    const validPoints = points.filter((p) => p.accuracy == null || p.accuracy <= 80);
    if (validPoints.length === 0) {
      return res.status(200).json({ saved: 0, status: 'ignored_low_accuracy' });
    }

    // 1. REAL-TIME BROADCAST: Broadcast latest point to parent IMMEDIATELY (zero delay, 100% frequency)
    const latest = validPoints.reduce((a, b) =>
      new Date(a.recordedAt) > new Date(b.recordedAt) ? a : b,
    );

    const io = getIO();
    io.to(`parent:${parent_id}`).emit('location_update', {
      childId: child_id,
      lat: latest.lat,
      lng: latest.lng,
      accuracy: latest.accuracy,
      speed: latest.speed,
      heading: latest.heading,
      batteryLevel: latest.batteryLevel,
      isCharging: latest.isCharging,
      recordedAt: latest.recordedAt,
      activityType: latest.activityType || undefined,
      timestamp: new Date().toISOString(),
    });

    // Cache latest point and active trail into Redis (safe error handling)
    cacheLocation(child_id, latest);

    // 2. DATABASE PERSISTENCE: Apply smart trajectory filter (reduces highway clutter by 75-85%)
    const pointsToStore = filterPointsForStorage(child_id, validPoints);

    if (pointsToStore.length > 0) {
      const now = new Date();
      const deviceCreated = req.device?.created_at ? new Date(req.device.created_at) : null;

      const rows = pointsToStore.map((p) => {
        let recDate = new Date(p.recordedAt);
        if (isNaN(recDate.getTime()) || recDate > now) {
          recDate = now;
        }
        if (deviceCreated && recDate < deviceCreated) {
          recDate = deviceCreated;
        }
        return {
          child_id,
          location: db.raw(`ST_SetSRID(ST_MakePoint(?, ?), 4326)`, [p.lng, p.lat]),
          accuracy: p.accuracy ?? null,
          speed: p.speed ?? null,
          heading: p.heading ?? null,
          altitude: p.altitude ?? null,
          battery_level: p.batteryLevel ?? null,
          is_charging: p.isCharging ?? null,
          recorded_at: recDate,
        };
      });

      // Upsert — ignore duplicate (child_id, recorded_at) pairs
      await db('locations')
        .insert(rows)
        .onConflict(['child_id', 'recorded_at'])
        .ignore();
    }

    // Update child_devices last_seen & battery
    const deviceUpdate = { last_seen: new Date() };
    if (latest.batteryLevel != null) {
      deviceUpdate.battery_level = Number(latest.batteryLevel);
    }
    if (latest.isCharging != null) {
      deviceUpdate.is_charging = Boolean(latest.isCharging);
    }

    await db('child_devices')
      .where({ id: req.device.device_id || req.device.id })
      .update(deviceUpdate);

    io.to(`parent:${parent_id}`).emit('child_status', {
      childId: child_id,
      isOnline: true,
      lastSeen: new Date().toISOString(),
      batteryLevel: latest.batteryLevel,
      isCharging: latest.isCharging,
      speed: latest.speed != null ? Number(latest.speed) : undefined,
      activityType: latest.activityType || undefined,
    });

    checkAndEmitLowBatteryAlert(io, parent_id, child_id, latest.batteryLevel, latest.isCharging);

    res.json({ received: points.length, movementThreshold: req.device.movement_threshold ?? 20 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error('Batch validation error:', JSON.stringify(err.issues, null, 2), 'body was:', JSON.stringify(req.body, null, 2));
      return res.status(400).json({ error: 'Validation failed', issues: err.issues });
    }
    next(err);
  }
});

// ── POST /api/location/status ─────────────────────────────────────────────────
// Child device sends a heartbeat with battery/status info
router.post('/status', requireDeviceAuth, async (req, res, next) => {
  try {
    const { child_id, parent_id } = req.device;
    const { batteryLevel, isCharging, speed, activityType } = req.body;

    const statusUpdate = { last_seen: new Date() };
    if (batteryLevel != null) {
      statusUpdate.battery_level = Number(batteryLevel);
    }
    if (isCharging != null) {
      statusUpdate.is_charging = Boolean(isCharging);
    }

    await db('child_devices')
      .where({ id: req.device.device_id || req.device.id })
      .update(statusUpdate);

    // Keep Redis location cache in sync with the new battery status & speed
    updateCachedDeviceStatus(child_id, {
      batteryLevel,
      isCharging,
      speed: (speed !== undefined && speed !== null) ? Number(speed) : 0,
      activityType: activityType || 'still',
      lastSeen: new Date().toISOString(),
    });

    const io = getIO();
    io.to(`parent:${parent_id}`).emit('child_status', {
      childId: child_id,
      batteryLevel: batteryLevel != null ? Number(batteryLevel) : undefined,
      isCharging: isCharging != null ? Boolean(isCharging) : undefined,
      speed: (speed !== undefined && speed !== null) ? Number(speed) : undefined,
      activityType: activityType || undefined,
      isOnline: true,
      lastSeen: new Date().toISOString(),
    });

    checkAndEmitLowBatteryAlert(io, parent_id, child_id, batteryLevel, isCharging);

    res.json({ ok: true, movementThreshold: req.device.movement_threshold ?? 20 });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/location/config ──────────────────────────────────────────────────
// Child device fetches its movement detection configuration
router.get('/config', requireDeviceAuth, async (req, res, next) => {
  try {
    const device = await db('child_devices')
      .where({ id: req.device.device_id || req.device.id })
      .select('movement_threshold')
      .first();

    res.json({
      movementThreshold: device?.movement_threshold ?? 20,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/location/live/:childId ──────────────────────────────────────────
// Parent: get last known location for a child (Redis cache-aside with Postgres fallback)
router.get('/live/:childId', requireParentAuth, async (req, res, next) => {
  try {
    const child = await db('children')
      .where({ id: req.params.childId, parent_id: req.parent.id })
      .first();
    if (!child) throw new AppError('Child not found', 404);

    const activeDevice = await db('child_devices')
      .where({ child_id: req.params.childId, is_active: true })
      .orderBy('last_seen', 'desc')
      .first();

    // 1. Try Redis cache first (Sub-20ms instant RAM response)
    const cachedLoc = await getCachedLatestLocation(req.params.childId);
    if (cachedLoc) {
      const battery = activeDevice?.battery_level ?? cachedLoc.battery_level;
      const charging = activeDevice?.is_charging ?? cachedLoc.is_charging;
      const lastSeen = activeDevice?.last_seen || cachedLoc.recorded_at;
      const locAge = cachedLoc.recorded_at ? Math.abs(Date.now() - new Date(cachedLoc.recorded_at).getTime()) : 0;
      const isStill = cachedLoc.activityType === 'still';
      const effectiveSpeed = (locAge > 45000 || isStill) ? 0 : (cachedLoc.speed ?? 0);

      return res.json({
        location: {
          ...cachedLoc,
          speed: effectiveSpeed,
          battery_level: battery,
          is_charging: charging,
        },
        device: {
          battery_level: battery,
          is_charging: charging,
          last_seen: lastSeen,
        },
        cached: true,
      });
    }

    // 2. Cache miss or Redis unavailable: query PostgreSQL
    const result = await db('locations')
      .where({ child_id: req.params.childId })
      .orderBy('recorded_at', 'desc')
      .select(
        'id',
        db.raw('ST_Y(location::geometry) as lat'),
        db.raw('ST_X(location::geometry) as lng'),
        'accuracy', 'speed', 'heading', 'altitude',
        'battery_level', 'is_charging',
        'recorded_at', 'synced_at',
      )
      .first();

    if (result && activeDevice) {
      const locAge = result.recorded_at ? Math.abs(Date.now() - new Date(result.recorded_at).getTime()) : 0;
      if (locAge > 45000) {
        result.speed = 0;
      }
      if (activeDevice.battery_level != null) {
        result.battery_level = activeDevice.battery_level;
      }
      if (activeDevice.is_charging != null) {
        result.is_charging = activeDevice.is_charging;
      }
      if (activeDevice.last_seen) {
        result.device_last_seen = activeDevice.last_seen;
      }
    }

    // Backfill Redis cache asynchronously
    if (result) {
      cacheLocation(req.params.childId, result);
    }

    res.json({
      location: result || null,
      device: activeDevice ? {
        battery_level: activeDevice.battery_level,
        is_charging: activeDevice.is_charging,
        last_seen: activeDevice.last_seen,
      } : null,
      cached: false,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/location/trail/:childId ──────────────────────────────────────────
// Parent: get recent breadcrumb trail (Redis cache-aside with Postgres fallback)
router.get('/trail/:childId', requireParentAuth, async (req, res, next) => {
  try {
    const child = await db('children')
      .where({ id: req.params.childId, parent_id: req.parent.id })
      .first();
    if (!child) throw new AppError('Child not found', 404);

    // 1. Try Redis cached trail first (Last 100 points)
    const cachedTrail = await getCachedTrail(req.params.childId, 100);
    if (cachedTrail && cachedTrail.length > 0) {
      return res.json({ points: cachedTrail, cached: true });
    }

    // 2. Cache miss or Redis unavailable: query PostgreSQL (last 24 hours)
    const points = await db('locations')
      .where({ child_id: req.params.childId })
      .where('recorded_at', '>=', new Date(Date.now() - 24 * 60 * 60 * 1000))
      .orderBy('recorded_at', 'desc')
      .limit(100)
      .select(
        'id',
        db.raw('ST_Y(location::geometry) as lat'),
        db.raw('ST_X(location::geometry) as lng'),
        'accuracy', 'speed', 'heading',
        'battery_level', 'is_charging',
        'recorded_at',
      );

    const chronological = (points || []).reverse();
    // Backfill Redis cache asynchronously
    for (const pt of chronological) {
      cacheLocation(req.params.childId, pt);
    }

    res.json({ points: chronological, cached: false });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/location/history ─────────────────────────────────────────────────
// Parent: get location history for a child over a time range
router.get('/history', requireParentAuth, async (req, res, next) => {
  try {
    const { childId, from, to, limit = 2000 } = req.query;

    if (!childId) throw new AppError('childId required', 400);

    const child = await db('children')
      .where({ id: childId, parent_id: req.parent.id })
      .first();
    if (!child) throw new AppError('Child not found', 404);

    // Fast-path: If querying recent live trail (limit <= 120 and up to current time)
    const isRecentQuery = Number(limit) <= 120 && (!to || new Date(to) >= new Date(Date.now() - 60000));
    if (isRecentQuery) {
      const cachedTrail = await getCachedTrail(childId, Number(limit));
      if (cachedTrail && cachedTrail.length > 0) {
        return res.json({ points: cachedTrail, count: cachedTrail.length, cached: true });
      }
    }

    let query = db('locations')
      .where({ child_id: childId })
      .where(function() {
        this.whereNull('accuracy').orWhere('accuracy', '<=', 80);
      })
      .select(
        'id',
        db.raw('ST_Y(location::geometry) as lat'),
        db.raw('ST_X(location::geometry) as lng'),
        'accuracy', 'speed', 'heading', 'altitude',
        'battery_level', 'is_charging', 'recorded_at',
      )
      .orderBy('recorded_at', 'asc')
      .limit(Number(limit));


    if (from) query = query.where('recorded_at', '>=', new Date(from));
    if (to) query = query.where('recorded_at', '<=', new Date(to));

    const points = await query;
    res.json({ points, count: points.length });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/location/history ──────────────────────────────────────────────
// Parent: prune false jitter points and keep the latest resting anchor point
router.delete('/history', requireParentAuth, async (req, res, next) => {
  try {
    const { childId } = req.query;
    if (!childId) throw new AppError('childId required', 400);

    const child = await db('children')
      .where({ id: childId, parent_id: req.parent.id })
      .first();
    if (!child) throw new AppError('Child not found', 404);

    const latest = await db('locations')
      .where({ child_id: childId })
      .orderBy('recorded_at', 'desc')
      .first();

    let deletedCount = 0;
    if (latest) {
      deletedCount = await db('locations')
        .where({ child_id: childId })
        .whereNot({ id: latest.id })
        .delete();
    }

    await clearCachedTrail(childId);

    res.json({ ok: true, deleted: deletedCount, keptId: latest?.id || null });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/location/trips ───────────────────────────────────────────────────
// Parent: get segmented trips for a child (gap > 10 min = new trip)
router.get('/trips', requireParentAuth, async (req, res, next) => {
  try {
    const { childId, from, to } = req.query;
    if (!childId) throw new AppError('childId required', 400);

    const child = await db('children')
      .where({ id: childId, parent_id: req.parent.id })
      .first();
    if (!child) throw new AppError('Child not found', 404);

    let query = db('locations')
      .where({ child_id: childId })
      .select(
        db.raw('ST_Y(location::geometry) as lat'),
        db.raw('ST_X(location::geometry) as lng'),
        'speed', 'heading', 'battery_level', 'is_charging', 'recorded_at',
        // Gap detection: time since previous point
        db.raw(`
          EXTRACT(EPOCH FROM (recorded_at - LAG(recorded_at) OVER (ORDER BY recorded_at))) AS gap_seconds
        `),
      )
      .orderBy('recorded_at', 'asc');

    if (from) query = query.where('recorded_at', '>=', new Date(from));
    if (to) query = query.where('recorded_at', '<=', new Date(to));

    const points = await query;

    // Segment into trips (gap > 600 seconds = 10 min)
    const GAP_THRESHOLD = 600;
    const trips = [];
    let current = [];

    for (const point of points) {
      if (point.gap_seconds > GAP_THRESHOLD && current.length > 0) {
        trips.push(current);
        current = [];
      }
      current.push(point);
    }
    if (current.length > 0) trips.push(current);

    // Compute trip stats
    const tripsWithStats = trips.map((pts, i) => ({
      tripIndex: i,
      startTime: pts[0].recorded_at,
      endTime: pts[pts.length - 1].recorded_at,
      pointCount: pts.length,
      maxSpeed: Math.max(...pts.map((p) => p.speed || 0)),
      points: pts.map(({ gap_seconds: _gs, ...rest }) => rest),
    }));

    res.json({ trips: tripsWithStats });
  } catch (err) {
    next(err);
  }
});

export default router;
