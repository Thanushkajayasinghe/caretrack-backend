import 'dotenv/config';
import express from 'express';
import http from 'http';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import { initSocket } from './sockets/index.js';
import { connectDB } from './config/db.js';
import { connectRedis } from './config/redis.js';
import authRouter from './routes/auth.js';
import childRouter from './routes/child.js';
import pairRouter from './routes/pair.js';
import locationRouter from './routes/location.js';
import { errorHandler } from './middleware/errorHandler.js';
import { setupWebDashboard } from './web/index.js';

const app = express();
const httpServer = http.createServer(app);

// ── Trust Proxy (Render is 1 hop reverse proxy) ─────────────────────────────
app.set('trust proxy', 1);

// ── Security middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // allow loading OpenStreetMap tiles and CDNs
}));
app.use(cors({
  origin: '*',
  credentials: true,
}));

// ── Rate limiting ────────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV === 'development';
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: isDev ? 10000 : (Number(process.env.RATE_LIMIT_MAX) || 1000),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});
app.use(limiter);

// Auth routes get a reasonable limiter (100 attempts per 15 min in prod, 1000 in dev)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 1000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many attempts, please try again later.' },
});


// ── Parsing ──────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/children', childRouter);
app.use('/api/pair', pairRouter);
app.use('/api/location', locationRouter);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', v: '8dc6f4a', ts: new Date().toISOString() }));

// ── Web Parent Dashboard ─────────────────────────────────────────────────────
setupWebDashboard(app);
app.get('/', (_req, res) => res.redirect('/dashboard'));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use(errorHandler);

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  await connectDB();
  await connectRedis();
  initSocket(httpServer);

  const PORT = process.env.PORT || 3000;
  // Ensure Node.js keepAliveTimeout > Nginx keepalive_timeout (prevents 502/socket hang up on reused sockets)
  httpServer.keepAliveTimeout = 65000;
  httpServer.headersTimeout = 66000;

  httpServer.listen(PORT, () => {
    console.log(`\n🚀 CareTrack backend running on port ${PORT}`);
    console.log(`   ENV: ${process.env.NODE_ENV}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
