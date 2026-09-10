import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from '../config/db.js';

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES || (process.env.NODE_ENV === 'production' ? '15m' : '7d');
const REFRESH_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function generateAccessToken(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRES });
}

export function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

export function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET);
}

export async function saveRefreshToken(parentId, token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);
  await db('refresh_tokens').insert({ parent_id: parentId, token_hash: hash, expires_at: expiresAt });
  return hash;
}

export async function rotateRefreshToken(oldToken, parentId) {
  const oldHash = crypto.createHash('sha256').update(oldToken).digest('hex');

  const existing = await db('refresh_tokens')
    .where({ token_hash: oldHash, parent_id: parentId, revoked: false })
    .where('expires_at', '>', new Date())
    .first();

  if (!existing) return null;

  // Revoke old token
  await db('refresh_tokens').where({ id: existing.id }).update({ revoked: true });

  // Issue new token
  const newToken = generateRefreshToken();
  await saveRefreshToken(parentId, newToken);
  return newToken;
}

export async function revokeRefreshToken(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db('refresh_tokens').where({ token_hash: hash }).update({ revoked: true });
}

// Generate hardware-bound device token
export function generateDeviceToken(deviceFingerprint, parentId, childId) {
  const DEVICE_SECRET = process.env.DEVICE_TOKEN_SECRET;
  const timestamp = Date.now().toString();
  const data = `${deviceFingerprint}:${parentId}:${childId}:${timestamp}`;
  const token = crypto.createHmac('sha256', DEVICE_SECRET).update(data).digest('hex');
  return { token, timestamp };
}

export function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function hashFingerprint(fingerprint) {
  return crypto.createHash('sha256').update(fingerprint).digest('hex');
}
