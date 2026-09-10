import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../config/db.js';
import {
  generateAccessToken,
  generateRefreshToken,
  saveRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from '../services/tokenService.js';
import { requireParentAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(100),
  phone: z.string().max(30).optional().nullable().or(z.literal('')),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, phone } = registerSchema.parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();

    const existing = await db('parents').whereRaw('LOWER(email) = ?', [normalizedEmail]).first();
    if (existing) throw new AppError('Email already registered', 409);

    const password_hash = await bcrypt.hash(password, 12);
    const [parent] = await db('parents')
      .insert({
        email: normalizedEmail,
        password_hash,
        name: name?.trim(),
        phone: phone && phone.trim() ? phone.trim() : null,
      })
      .returning(['id', 'email', 'name', 'phone', 'created_at']);

    const accessToken = generateAccessToken({ id: parent.id, email: parent.email, name: parent.name });
    const refreshToken = generateRefreshToken();
    await saveRefreshToken(parent.id, refreshToken);

    res.status(201).json({
      parent: { id: parent.id, email: parent.email, name: parent.name, phone: parent.phone },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const details = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
      return res.status(400).json({ error: details || 'Validation failed', issues: err.issues });
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    next(err);
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();

    const parent = await db('parents').whereRaw('LOWER(email) = ?', [normalizedEmail]).first();
    if (!parent) throw new AppError('Invalid credentials', 401);

    const valid = await bcrypt.compare(password, parent.password_hash);
    if (!valid) throw new AppError('Invalid credentials', 401);

    const accessToken = generateAccessToken({ id: parent.id, email: parent.email, name: parent.name });
    const refreshToken = generateRefreshToken();
    await saveRefreshToken(parent.id, refreshToken);

    res.json({
      parent: { id: parent.id, email: parent.email, name: parent.name, avatar_url: parent.avatar_url },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', issues: err.issues });
    }
    next(err);
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken, parentId } = req.body;
    if (!refreshToken || !parentId) throw new AppError('Missing token or parentId', 400);

    const newRefreshToken = await rotateRefreshToken(refreshToken, parentId);
    if (!newRefreshToken) throw new AppError('Invalid or expired refresh token', 401);

    const parent = await db('parents').where({ id: parentId }).first();
    if (!parent) throw new AppError('Parent not found', 404);

    const accessToken = generateAccessToken({ id: parent.id, email: parent.email, name: parent.name });

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', requireParentAuth, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) await revokeRefreshToken(refreshToken);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', requireParentAuth, async (req, res, next) => {
  try {
    const parent = await db('parents')
      .where({ id: req.parent.id })
      .select('id', 'email', 'name', 'avatar_url', 'created_at')
      .first();
    res.json({ parent });
  } catch (err) {
    next(err);
  }
});

export default router;
