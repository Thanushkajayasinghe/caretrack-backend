import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
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
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  phone: z.string().max(30).optional().nullable().or(z.literal('')),
  avatarUrl: z.string().optional().nullable().or(z.literal('')),
});

/**
 * Helper to verify Google credentials from ID token or Access token
 */
async function verifyGoogleCredentials({ idToken, accessToken, googleId, email, name, avatarUrl }) {
  // 1. If idToken is provided, verify with Google
  if (idToken) {
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID || undefined,
      });
      const payload = ticket.getPayload();
      return {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name || payload.given_name || 'CareTrack Parent',
        avatarUrl: payload.picture || null,
        emailVerified: payload.email_verified,
      };
    } catch (verifyErr) {
      // Fallback: Query Google tokeninfo directly (handles audience differences between web/android clients)
      try {
        const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
        if (response.ok) {
          const info = await response.json();
          if (info && info.sub && info.email) {
            return {
              googleId: info.sub,
              email: info.email,
              name: info.name || 'CareTrack Parent',
              avatarUrl: info.picture || null,
              emailVerified: info.email_verified === 'true' || info.email_verified === true,
            };
          }
        }
      } catch (tokenInfoErr) {
        console.warn('Google tokeninfo fetch failed:', tokenInfoErr.message);
      }
      throw new AppError('Google token verification failed: ' + (verifyErr.message || 'Invalid token'), 401);
    }
  }

  // 2. If accessToken is provided, query Google userinfo API
  if (accessToken) {
    try {
      const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) {
        const info = await response.json();
        return {
          googleId: info.sub,
          email: info.email,
          name: info.name || 'CareTrack Parent',
          avatarUrl: info.picture || null,
          emailVerified: info.email_verified,
        };
      }
      throw new Error(`Google userinfo responded with status ${response.status}`);
    } catch (userInfoErr) {
      throw new AppError('Failed to verify Google access token: ' + userInfoErr.message, 401);
    }
  }

  // 3. Fallback for testing / dev environment if explicitly passed
  if (email && googleId) {
    return {
      googleId,
      email,
      name: name || 'CareTrack Parent',
      avatarUrl: avatarUrl || null,
      emailVerified: true,
    };
  }

  throw new AppError('Missing Google credentials. Provide idToken or accessToken.', 400);
}

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
        auth_provider: 'local',
      })
      .returning(['id', 'email', 'name', 'phone', 'created_at']);

    const accessToken = generateAccessToken({ id: parent.id, email: parent.email, name: parent.name });
    const refreshToken = generateRefreshToken();
    await saveRefreshToken(parent.id, refreshToken);

    res.status(201).json({
      parent: { id: parent.id, email: parent.email, name: parent.name, phone: parent.phone },
      accessToken,
      refreshToken,
      isProfileComplete: Boolean(parent.phone && parent.phone.trim().length > 0),
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

    if (!parent.password_hash) {
      throw new AppError(
        'This account was created with Google Sign-In. Please tap "Continue with Google" or set a password in your settings.',
        400
      );
    }

    const valid = await bcrypt.compare(password, parent.password_hash);
    if (!valid) throw new AppError('Invalid credentials', 401);

    const accessToken = generateAccessToken({ id: parent.id, email: parent.email, name: parent.name });
    const refreshToken = generateRefreshToken();
    await saveRefreshToken(parent.id, refreshToken);

    res.json({
      parent: {
        id: parent.id,
        email: parent.email,
        name: parent.name,
        phone: parent.phone,
        avatar_url: parent.avatar_url,
      },
      accessToken,
      refreshToken,
      isProfileComplete: Boolean(parent.phone && parent.phone.trim().length > 0),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', issues: err.issues });
    }
    next(err);
  }
});

// ── POST /api/auth/google ─────────────────────────────────────────────────────
router.post('/google', async (req, res, next) => {
  try {
    const { idToken, accessToken: googleAccessToken, googleId, email, name, avatarUrl } = req.body;

    const googleUser = await verifyGoogleCredentials({
      idToken,
      accessToken: googleAccessToken,
      googleId,
      email,
      name,
      avatarUrl,
    });

    if (!googleUser.email) {
      throw new AppError('Google account does not have a verified email', 400);
    }

    const normalizedEmail = googleUser.email.toLowerCase().trim();

    // 1. Look up by Google ID
    let parent = await db('parents').where({ google_id: googleUser.googleId }).first();

    if (!parent) {
      // 2. Check if an account already exists with this email (e.g. from previous normal email/password registration)
      parent = await db('parents').whereRaw('LOWER(email) = ?', [normalizedEmail]).first();

      if (parent) {
        // Link Google ID to existing account!
        const updates = {
          google_id: googleUser.googleId,
          avatar_url: parent.avatar_url || googleUser.avatarUrl || null,
          updated_at: db.fn.now(),
        };
        await db('parents').where({ id: parent.id }).update(updates);
        parent = await db('parents').where({ id: parent.id }).first();
      } else {
        // 3. Create a brand-new parent record
        const [newParent] = await db('parents')
          .insert({
            email: normalizedEmail,
            name: googleUser.name?.trim() || 'CareTrack Parent',
            google_id: googleUser.googleId,
            auth_provider: 'google',
            avatar_url: googleUser.avatarUrl || null,
            phone: null,
            password_hash: null,
          })
          .returning(['id', 'email', 'name', 'phone', 'avatar_url', 'auth_provider', 'created_at']);
        parent = newParent;
      }
    } else {
      // Update avatar if not already set
      if (!parent.avatar_url && googleUser.avatarUrl) {
        await db('parents')
          .where({ id: parent.id })
          .update({ avatar_url: googleUser.avatarUrl, updated_at: db.fn.now() });
        parent.avatar_url = googleUser.avatarUrl;
      }
    }

    const accessToken = generateAccessToken({ id: parent.id, email: parent.email, name: parent.name });
    const refreshToken = generateRefreshToken();
    await saveRefreshToken(parent.id, refreshToken);

    const isProfileComplete = Boolean(parent.phone && parent.phone.trim().length > 0);

    res.json({
      parent: {
        id: parent.id,
        email: parent.email,
        name: parent.name,
        phone: parent.phone,
        avatar_url: parent.avatar_url,
        auth_provider: parent.auth_provider || 'local',
      },
      accessToken,
      refreshToken,
      isProfileComplete,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/google/callback ─────────────────────────────────────────────
// Direct OAuth relay for mobile: receives Google's redirect and forwards tokens to app deep link
router.get('/google/callback', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CareTrack Authentication</title>
  <style>
    body {
      background-color: #070A13;
      color: #FFFFFF;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      text-align: center;
      padding: 24px;
      box-sizing: border-box;
    }
    .spinner {
      width: 44px;
      height: 44px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: #3B82F6;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 24px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { font-size: 20px; font-weight: 700; margin: 0 0 8px 0; color: #F3F4F6; }
    p { font-size: 14px; color: #9CA3AF; margin: 0 0 20px 0; max-width: 320px; line-height: 1.5; }
    .btn {
      display: inline-block;
      background-color: #2563EB;
      color: #FFFFFF;
      font-weight: 600;
      font-size: 15px;
      padding: 12px 28px;
      border-radius: 10px;
      text-decoration: none;
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.4);
      transition: background-color 0.2s;
    }
    .btn:active { background-color: #1D4ED8; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <h2>Signing you into CareTrack...</h2>
  <p id="statusText">Returning to CareTrack Parent</p>
  <a id="launchBtn" href="#" class="btn" style="display:none;">Open CareTrack Parent</a>

  <script>
    (function() {
      var hash = (window.location.hash || '').replace(/^#/, '');
      var search = (window.location.search || '').replace(/^\?/, '');
      var combined = (hash ? hash + '&' : '') + search;
      var params = new URLSearchParams(combined);
      
      var state = params.get('state');
      var returnUrl = state ? decodeURIComponent(state) : 'caretrack-parent://google-auth-callback';
      
      var target = returnUrl;
      if (hash) {
        target += (target.indexOf('#') !== -1 ? '&' : '#') + hash;
      } else if (search) {
        target += (target.indexOf('?') !== -1 ? '&' : '?') + search;
      }
      
      var launchBtn = document.getElementById('launchBtn');
      var statusText = document.getElementById('statusText');
      if (launchBtn) {
        launchBtn.href = target;
      }

      // 1. Attempt automatic navigation
      try {
        window.location.href = target;
      } catch (_e) {}

      // 2. Fallback: if browser blocks automatic intent navigation (Brave/Chrome restrictions),
      // show the button immediately so a single tap opens the app
      setTimeout(function() {
        if (launchBtn) {
          launchBtn.style.display = 'inline-block';
          if (statusText) statusText.innerText = 'Tap below to return to the CareTrack app:';
        }
      }, 350);
    })();
  </script>
</body>
</html>`);
});

// ── PUT /api/auth/profile ─────────────────────────────────────────────────────
router.put('/profile', requireParentAuth, async (req, res, next) => {
  try {
    const { name, phone, avatarUrl } = updateProfileSchema.parse(req.body);
    const updates = { updated_at: db.fn.now() };

    if (name !== undefined) updates.name = name.trim();
    if (phone !== undefined) updates.phone = phone && phone.trim() ? phone.trim() : null;
    if (avatarUrl !== undefined) updates.avatar_url = avatarUrl && avatarUrl.trim() ? avatarUrl.trim() : null;

    const [updatedParent] = await db('parents')
      .where({ id: req.parent.id })
      .update(updates)
      .returning(['id', 'email', 'name', 'phone', 'avatar_url', 'auth_provider', 'created_at', 'updated_at']);

    if (!updatedParent) throw new AppError('Parent not found', 404);

    const isProfileComplete = Boolean(updatedParent.phone && updatedParent.phone.trim().length > 0);

    res.json({
      parent: updatedParent,
      isProfileComplete,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const details = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
      return res.status(400).json({ error: details || 'Validation failed', issues: err.issues });
    }
    next(err);
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken, parentId } = req.body;
    if (!refreshToken || !parentId) throw new AppError('Missing token or parentId', 400);

    let newRefreshToken = await rotateRefreshToken(refreshToken, parentId);
    if (!newRefreshToken) throw new AppError('Invalid or expired refresh token', 401);
    if (newRefreshToken === 'REUSE_ACTIVE') {
      newRefreshToken = refreshToken;
    }

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
      .select('id', 'email', 'name', 'phone', 'avatar_url', 'auth_provider', 'created_at')
      .first();

    if (!parent) throw new AppError('Parent not found', 404);

    res.json({
      parent,
      isProfileComplete: Boolean(parent.phone && parent.phone.trim().length > 0),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
