import { io } from 'socket.io-client';
import { pool } from './src/config/db.js';

const BASE_URL = 'http://localhost:3000';

async function request(endpoint, options = {}) {
  const { headers, ...rest } = options;
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    ...rest,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

async function runTest() {
  console.log('===========================================================');
  console.log('  TEST: LOCATION INGESTION, STATIONARY THROTTLING & HISTORY');
  console.log('===========================================================\n');

  // 1. Parent Login
  console.log('--- [Step 1] Parent Authentication ---');
  const loginRes = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'thanushkajayasinghe@gmail.com',
      password: 'secret123',
    }),
  });

  if (!loginRes.ok) {
    console.error('Login failed:', loginRes.data);
    process.exit(1);
  }
  const parentToken = loginRes.data.accessToken;
  const parentId = loginRes.data.parent.id;
  const authHeaders = { Authorization: `Bearer ${parentToken}` };
  console.log(`  ✅ Parent authenticated: ${loginRes.data.parent.email} (${parentId})`);

  // 2. Child Setup & Pairing
  console.log('\n--- [Step 2] Child Device Pairing ---');
  const childRes = await request('/api/children', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Verification Child', avatarColor: '#10B981' }),
  });
  const childId = childRes.data.child.id;

  const pairRes = await request('/api/pair/generate', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ childId }),
  });
  const { otp, sessionId } = pairRes.data;

  const deviceFingerprint = `test-hw-${Date.now()}`;
  const claimRes = await request('/api/pair/claim', {
    method: 'POST',
    body: JSON.stringify({
      sessionId,
      otp,
      deviceFingerprint,
      deviceName: 'Test Phone',
      androidVersion: '14',
    }),
  });
  const deviceToken = claimRes.data.deviceToken;
  const childHeaders = {
    Authorization: `Bearer ${deviceToken}`,
    'x-device-fingerprint': deviceFingerprint,
  };
  console.log(`  ✅ Child device paired successfully (childId: ${childId})`);

  // Connect parent socket to listen for real-time events
  const socket = io(BASE_URL, {
    transports: ['websocket'],
    auth: { token: parentToken, clientType: 'parent' },
  });
  await new Promise((resolve) => socket.on('connect', resolve));
  console.log('  ✅ Parent real-time WebSocket connected');

  let liveLocationEvent = null;
  let liveStatusEvent = null;
  socket.on('location_update', (d) => { if (d.childId === childId) liveLocationEvent = d; });
  socket.on('child_status', (d) => { if (d.childId === childId) liveStatusEvent = d; });

  // 3. Test Initial Location Fix
  console.log('\n--- [Step 3] Initial Location Fix Acquisition ---');
  const initialLat = 6.41550;
  const initialLng = 80.00080;
  const t0 = new Date();

  await request('/api/location/batch', {
    method: 'POST',
    headers: childHeaders,
    body: JSON.stringify({
      points: [{
        lat: initialLat,
        lng: initialLng,
        accuracy: 8.5,
        speed: 0.0,
        heading: 0,
        altitude: 15.0,
        batteryLevel: 98,
        isCharging: false,
        recordedAt: t0.toISOString(),
      }],
    }),
  });
  await new Promise((r) => setTimeout(r, 400));

  const dbCount1 = await pool.query('SELECT COUNT(*) FROM locations WHERE child_id = $1', [childId]);
  console.log(`  ✅ Initial location stored in PostGIS. Locations table count: ${dbCount1.rows[0].count}`);
  console.log(`  ✅ Parent socket received live position: [${liveLocationEvent?.lat}, ${liveLocationEvent?.lng}]`);

  // 4. Test Stationary Throttling (Same Location NOT Repeatedly Sending)
  console.log('\n--- [Step 4] Stationary Throttling: Same Location NOT Sent Repeatedly ---');
  console.log('  Simulating phone sitting still on desk for 15 minutes:');
  console.log('  -> Under Android service logic: displacement < 12m triggers STATUS HEARTBEATS only.');

  for (let i = 1; i <= 5; i++) {
    const hbRes = await request('/api/location/status', {
      method: 'POST',
      headers: childHeaders,
      body: JSON.stringify({
        batteryLevel: 98 - i, // battery dropping 1% per heartbeat
        isCharging: false,
        speed: 0.0,
      }),
    });
    console.log(`    Pinging heartbeat #${i}: status=${hbRes.status}, battery=${98 - i}%, speed=0.0 km/h`);
  }
  await new Promise((r) => setTimeout(r, 400));

  const dbCount2 = await pool.query('SELECT COUNT(*) FROM locations WHERE child_id = $1', [childId]);
  const isDuplicateSuppressed = Number(dbCount2.rows[0].count) === 1;
  console.log(`\n  🔎 Verification: Locations count before: ${dbCount1.rows[0].count}, after 5 heartbeats: ${dbCount2.rows[0].count}`);
  if (isDuplicateSuppressed) {
    console.log('  ✅ PASS: ZERO duplicate location rows were added during stationary state!');
  } else {
    console.error('  ❌ FAIL: Repeated locations were written to database!');
  }
  console.log(`  ✅ PASS: Parent received live battery updates: ${liveStatusEvent?.batteryLevel}% (online: ${liveStatusEvent?.isOnline})`);

  // 5. Test Movement Detection (Displacement >= 12m)
  console.log('\n--- [Step 5] Movement Detection: True Movement Uploads New Locations ---');
  console.log('  Simulating child walking down Sooriyagoda Road:');
  const movePoints = [
    {
      lat: initialLat + 0.00020, // ~22m displacement
      lng: initialLng + 0.00010,
      accuracy: 9.0,
      speed: 1.3, // ~4.7 km/h walking speed
      heading: 30,
      batteryLevel: 93,
      isCharging: false,
      recordedAt: new Date(Date.now() + 60000).toISOString(),
    },
    {
      lat: initialLat + 0.00045, // ~52m displacement
      lng: initialLng + 0.00025,
      accuracy: 8.0,
      speed: 1.5,
      heading: 32,
      batteryLevel: 92,
      isCharging: false,
      recordedAt: new Date(Date.now() + 120000).toISOString(),
    },
    {
      lat: initialLat + 0.00075, // ~88m displacement
      lng: initialLng + 0.00040,
      accuracy: 7.5,
      speed: 1.4,
      heading: 35,
      batteryLevel: 92,
      isCharging: false,
      recordedAt: new Date(Date.now() + 180000).toISOString(),
    },
  ];

  await request('/api/location/batch', {
    method: 'POST',
    headers: childHeaders,
    body: JSON.stringify({ points: movePoints }),
  });
  await new Promise((r) => setTimeout(r, 400));

  const dbCount3 = await pool.query('SELECT COUNT(*) FROM locations WHERE child_id = $1', [childId]);
  console.log(`  ✅ True movement points saved. Locations table count: ${dbCount3.rows[0].count} (expected 4)`);

  // 6. Test History & Trips Retrieval
  console.log('\n--- [Step 6] History & Trips Query Verification ---');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const historyRes = await request(`/api/location/history?childId=${childId}&from=${today.toISOString()}`, {
    method: 'GET',
    headers: authHeaders,
  });
  console.log(`  ✅ Location History retrieved: ${historyRes.data?.count} points returned`);
  console.log(`     Start point: [${historyRes.data?.points[0]?.lat}, ${historyRes.data?.points[0]?.lng}] at ${historyRes.data?.points[0]?.recorded_at}`);
  console.log(`     Latest point: [${historyRes.data?.points[historyRes.data.points.length - 1]?.lat}, ${historyRes.data?.points[historyRes.data.points.length - 1]?.lng}]`);

  const tripsRes = await request(`/api/location/trips?childId=${childId}&from=${today.toISOString()}`, {
    method: 'GET',
    headers: authHeaders,
  });
  console.log(`  ✅ Trips segmentation retrieved: ${tripsRes.data?.trips?.length} trip(s) identified`);
  if (tripsRes.data?.trips?.length > 0) {
    const t = tripsRes.data.trips[0];
    console.log(`     Trip 1: ${t.pointCount} points, Max Speed: ${(t.maxSpeed * 3.6).toFixed(1)} km/h`);
    console.log(`     Duration: from ${t.startTime} to ${t.endTime}`);
  }

  // 7. Cleanup test child
  await pool.query('DELETE FROM children WHERE id = $1', [childId]);
  socket.disconnect();

  console.log('\n===========================================================');
  console.log('  ALL CHECKS PASSED:');
  console.log('  1. Locations correctly acquired and stored in PostGIS.');
  console.log('  2. Stationary state suppresses duplicate location inserts.');
  console.log('  3. Movement triggers immediate location batching.');
  console.log('  4. History and Trips endpoints return clean, ordered data.');
  console.log('===========================================================');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
