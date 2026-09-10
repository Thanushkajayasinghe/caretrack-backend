import { verifyAccessToken } from '../services/tokenService.js';
import { db } from '../config/db.js';
import { hashDeviceToken, hashFingerprint } from '../services/tokenService.js';

/**
 * Middleware: validates parent JWT access token
 */
export function requireParentAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyAccessToken(token);
    req.parent = payload; // { id, email, name }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Middleware: validates child device token + hardware fingerprint binding
 */
export async function requireDeviceAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const fingerprint = req.headers['x-device-fingerprint'];

  if (!authHeader?.startsWith('Bearer ') || !fingerprint) {
    return res.status(401).json({ error: 'Missing device credentials' });
  }

  const token = authHeader.slice(7);
  const tokenHash = hashDeviceToken(token);
  const fingerprintHash = hashFingerprint(fingerprint);

  try {
    const device = await db('child_devices')
      .join('children', 'children.id', 'child_devices.child_id')
      .where({
        'child_devices.device_token_hash': tokenHash,
        'child_devices.device_fingerprint_hash': fingerprintHash,
        'child_devices.is_active': true,
      })
      .select(
        'child_devices.id as device_id',
        'child_devices.id as id',
        'child_devices.child_id',
        'children.parent_id',
        'child_devices.movement_threshold',
      )
      .first();

    if (!device) {
      return res.status(401).json({ error: 'Invalid or revoked device token' });
    }

    // Update last seen
    await db('child_devices')
      .where({ id: device.device_id })
      .update({ last_seen: new Date() });

    req.device = device; // { device_id, child_id, parent_id }
    next();
  } catch (err) {
    next(err);
  }
}
