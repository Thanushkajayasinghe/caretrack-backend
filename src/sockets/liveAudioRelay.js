import { WebSocketServer, WebSocket } from 'ws';
import { verifyAccessToken, hashDeviceToken, hashFingerprint } from '../services/tokenService.js';
import { db } from '../config/db.js';

// Map of childId -> WebSocket (child device microphone stream)
const activeChildStreams = new Map();

// Map of childId -> Set<WebSocket> (parent listeners)
const activeParentListeners = new Map();

export function initLiveAudioRelay(httpServer) {
  const wss = new WebSocketServer({
    noServer: true,
  });

  httpServer.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== '/ws/live-audio' && url.pathname !== '/api/ws/live-audio') {
        // Let Socket.IO or other upgrade handlers handle this request
        return;
      }

      const role = url.searchParams.get('role'); // 'child' or 'parent'
      const token = url.searchParams.get('token');
      const fingerprint = url.searchParams.get('fingerprint');
      const childId = url.searchParams.get('childId');

      if (!role || !token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      let authContext = null;

      if (role === 'parent') {
        try {
          const payload = verifyAccessToken(token);
          if (!childId) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
          }
          // Verify parent owns this child
          const child = await db('children')
            .where({ id: childId, parent_id: payload.id })
            .first();

          if (!child) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
          authContext = { role: 'parent', parentId: payload.id, childId };
        } catch (_err) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      } else if (role === 'child') {
        try {
          if (!fingerprint) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
          }
          const tokenHash = hashDeviceToken(token);
          const fingerprintHash = hashFingerprint(fingerprint);

          const device = await db('child_devices')
            .join('children', 'children.id', 'child_devices.child_id')
            .where({
              'child_devices.device_token_hash': tokenHash,
              'child_devices.device_fingerprint_hash': fingerprintHash,
              'child_devices.is_active': true,
            })
            .select('child_devices.child_id', 'children.parent_id')
            .first();

          if (!device) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          authContext = { role: 'child', childId: device.child_id, parentId: device.parent_id };
        } catch (_err) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      } else {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, authContext);
      });
    } catch (err) {
      console.error('Upgrade error in liveAudioRelay:', err);
      socket.destroy();
    }
  });

  wss.on('connection', (ws, _req, authContext) => {
    const { role, childId } = authContext;

    if (role === 'child') {
      console.log(`🎙️ Child ${childId} connected to Live Audio WebSocket`);
      
      // Close any previous stream from this child
      const prev = activeChildStreams.get(childId);
      if (prev && prev !== ws && prev.readyState === WebSocket.OPEN) {
        prev.close();
      }
      activeChildStreams.set(childId, ws);

      // Notify any listening parents that stream is active
      const listeners = activeParentListeners.get(childId);
      if (listeners && listeners.size > 0) {
        const msg = JSON.stringify({ type: 'stream_started', childId });
        listeners.forEach((pWs) => {
          if (pWs.readyState === WebSocket.OPEN) pWs.send(msg);
        });
      }

      let chunkCount = 0;
      ws.on('message', (data, isBinary) => {
        chunkCount++;
        const currentListeners = activeParentListeners.get(childId);
        if (currentListeners && currentListeners.size > 0) {
          currentListeners.forEach((pWs) => {
            if (pWs.readyState === WebSocket.OPEN) {
              pWs.send(data, { binary: isBinary });
            }
          });
          if (chunkCount % 30 === 1) {
            console.log(`🔊 [AudioRelay] Broadcasted binary chunk #${chunkCount} (${data.length} bytes) to ${currentListeners.size} parent(s)`);
          }
        }
      });

      ws.on('close', () => {
        console.log(`⏹️ Child ${childId} disconnected from Live Audio WebSocket`);
        activeChildStreams.delete(childId);
        const currentListeners = activeParentListeners.get(childId);
        if (currentListeners) {
          const msg = JSON.stringify({ type: 'stream_ended', childId });
          currentListeners.forEach((pWs) => {
            if (pWs.readyState === WebSocket.OPEN) pWs.send(msg);
          });
        }
      });

      ws.on('error', (err) => {
        console.warn(`⚠️ Child ${childId} WebSocket error:`, err.message);
      });

    } else if (role === 'parent') {
      console.log(`👤 Parent connected to Live Audio WebSocket for child ${childId}`);
      if (!activeParentListeners.has(childId)) {
        activeParentListeners.set(childId, new Set());
      }
      const listeners = activeParentListeners.get(childId);
      listeners.add(ws);

      // Check if child is already streaming
      const childWs = activeChildStreams.get(childId);
      if (childWs && childWs.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stream_started', childId }));
      }

      ws.on('close', () => {
        console.log(`👤 Parent disconnected from Live Audio WebSocket for child ${childId}`);
        listeners.delete(ws);
        if (listeners.size === 0) {
          activeParentListeners.delete(childId);
        }
      });

      ws.on('error', (err) => {
        console.warn(`⚠️ Parent WebSocket error:`, err.message);
      });
    }
  });

  console.log('✅ Live Audio WebSocket Relay initialized on /ws/live-audio');
}
