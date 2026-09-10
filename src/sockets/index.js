import { Server } from 'socket.io';
import { verifyAccessToken, hashDeviceToken, hashFingerprint } from '../services/tokenService.js';
import { db } from '../config/db.js';

let io = null;

export function getIO() {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.ALLOWED_ORIGINS?.split(',') ?? '*',
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // ── Authentication middleware ───────────────────────────────────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const clientType = socket.handshake.auth?.clientType; // 'parent' or 'child'
    const deviceFingerprint = socket.handshake.auth?.deviceFingerprint;

    if (!token || !clientType) {
      return next(new Error('Authentication required'));
    }

    try {
      if (clientType === 'parent') {
        // Validate parent JWT
        const payload = verifyAccessToken(token);
        socket.parentId = payload.id;
        socket.clientType = 'parent';
      } else if (clientType === 'child') {
        // Validate device token
        if (!deviceFingerprint) return next(new Error('Device fingerprint required'));
        const tokenHash = hashDeviceToken(token);
        const fingerprintHash = hashFingerprint(deviceFingerprint);

        const device = await db('child_devices')
          .join('children', 'children.id', 'child_devices.child_id')
          .where({
            'child_devices.device_token_hash': tokenHash,
            'child_devices.device_fingerprint_hash': fingerprintHash,
            'child_devices.is_active': true,
          })
          .select('child_devices.child_id', 'children.parent_id', 'child_devices.id as device_id')
          .first();

        if (!device) return next(new Error('Invalid device credentials'));

        socket.childId = device.child_id;
        socket.parentId = device.parent_id;
        socket.deviceId = device.device_id;
        socket.clientType = 'child';
      } else {
        return next(new Error('Invalid client type'));
      }

      next();
    } catch (err) {
      next(new Error('Authentication failed'));
    }
  });

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    if (socket.clientType === 'parent') {
      // Parent joins their private room
      socket.join(`parent:${socket.parentId}`);
      console.log(`👤 Parent ${socket.parentId} connected`);

      socket.on('disconnect', () => {
        console.log(`👤 Parent ${socket.parentId} disconnected`);
      });
    }

    if (socket.clientType === 'child') {
      socket.join(`child:${socket.childId}`);
      console.log(`👶 Child ${socket.childId} connected via socket`);

      // Update child_devices last_seen
      db('child_devices')
        .where({ id: socket.deviceId })
        .update({ last_seen: new Date() })
        .catch((e) => console.error('Error updating last_seen on connect:', e.message));

      // Notify parent that child is online
      io.to(`parent:${socket.parentId}`).emit('child_status', {
        childId: socket.childId,
        isOnline: true,
        lastSeen: new Date().toISOString(),
      });

      // ── Child events ─────────────────────────────────────────────────────
      socket.on('location_update', async (data) => {
        // Real-time location from child
        io.to(`parent:${socket.parentId}`).emit('location_update', {
          childId: socket.childId,
          ...data,
          timestamp: new Date().toISOString(),
        });

        // Persist to DB
        try {
          await db('locations').insert({
            child_id: socket.childId,
            location: db.raw(`ST_SetSRID(ST_MakePoint(?, ?), 4326)`, [data.lng, data.lat]),
            accuracy: data.accuracy,
            speed: data.speed,
            heading: data.heading,
            altitude: data.altitude,
            battery_level: data.batteryLevel,
            is_charging: data.isCharging,
            recorded_at: new Date(data.recordedAt),
          }).onConflict(['child_id', 'recorded_at']).ignore();
        } catch (_e) { /* ignore duplicate */ }

        // Also update child_devices with latest battery
        if (data.batteryLevel != null || data.isCharging != null) {
          const devUp = { last_seen: new Date() };
          if (data.batteryLevel != null) devUp.battery_level = Number(data.batteryLevel);
          if (data.isCharging != null) devUp.is_charging = Boolean(data.isCharging);
          db('child_devices').where({ id: socket.deviceId }).update(devUp).catch(() => {});
        }
      });

      socket.on('status_heartbeat', (data) => {
        const update = { last_seen: new Date() };
        if (data?.batteryLevel != null) update.battery_level = Number(data.batteryLevel);
        if (data?.isCharging != null) update.is_charging = Boolean(data.isCharging);

        db('child_devices')
          .where({ id: socket.deviceId })
          .update(update)
          .catch(() => {});

        io.to(`parent:${socket.parentId}`).emit('child_status', {
          childId: socket.childId,
          isOnline: true,
          lastSeen: new Date().toISOString(),
          ...data,
        });
      });

      socket.on('disconnect', () => {
        console.log(`👶 Child ${socket.childId} socket disconnected`);
        setTimeout(async () => {
          try {
            const dev = await db('child_devices').where({ id: socket.deviceId }).select('last_seen').first();
            const lastSeenTime = dev?.last_seen ? new Date(dev.last_seen).getTime() : 0;
            if (Date.now() - lastSeenTime > 120000) {
              io.to(`parent:${socket.parentId}`).emit('child_status', {
                childId: socket.childId,
                isOnline: false,
                lastSeen: dev?.last_seen ? new Date(dev.last_seen).toISOString() : new Date().toISOString(),
              });
            }
          } catch (_e) {}
        }, 60000);
      });
    }
  });

  console.log('✅ Socket.IO initialized');
  return io;
}
