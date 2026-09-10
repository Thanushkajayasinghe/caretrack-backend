import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function setupWebDashboard(app) {
  // Serve static assets for the web dashboard and child web client
  const publicDir = path.join(__dirname, '..', '..', 'public');
  app.use('/dashboard', express.static(publicDir));
  app.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.get('/child', (_req, res) => {
    res.sendFile(path.join(publicDir, 'child.html'));
  });
}
