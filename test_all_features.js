import { io } from 'socket.io-client';

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

async function runAllFeatureTests() {
  console.log('====================================================');
  console.log('       CARETRACK COMPREHENSIVE FEATURE TESTS        ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(name, condition, extra = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${name} ${extra}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name} ${extra}`);
      failed++;
    }
  }

  // ── 1. Health Check ──────────────────────────────────────────────────────────
  console.log('--- [1] System Health & Endpoints ---');
  const health = await request('/health');
  assert('Health Check status 200', health.status === 200 && health.data?.status === 'ok');

  const dashboard = await fetch(`${BASE_URL}/dashboard`);
  assert('Web Dashboard HTML reachable', dashboard.status === 200);

  // ── 2. Parent Authentication ────────────────────────────────────────────────
  console.log('\n--- [2] Parent Authentication ---');
  const loginRes = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'thanushkajayasinghe@gmail.com',
      password: 'secret123',
    }),
  });
  assert('Parent login with credentials', loginRes.ok && !!loginRes.data?.accessToken);
  const parentToken = loginRes.data?.accessToken;
  const refreshToken = loginRes.data?.refreshToken;
  const parentId = loginRes.data?.parent?.id;

  // Refresh token test
  const refreshRes = await request('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken, parentId }),
  });
  assert('Refresh access token', refreshRes.ok && !!refreshRes.data?.accessToken);
  const authHeaders = { Authorization: `Bearer ${parentToken}` };

  // ── 3. Child Management ─────────────────────────────────────────────────────
  console.log('\n--- [3] Child Profile Management ---');
  const createChildRes = await request('/api/children', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Test Kid',
      avatarColor: '#6C63FF',
    }),
  });
  assert('Create child profile', createChildRes.ok && !!createChildRes.data?.child?.id);
  const childId = createChildRes.data?.child?.id;

  const listChildrenRes = await request('/api/children', {
    method: 'GET',
    headers: authHeaders,
  });
  const foundChild = listChildrenRes.data?.children?.find((c) => c.id === childId);
  assert('List children includes created child', !!foundChild);
  assert('New child initially offline', foundChild?.isOnline === false);

  const getChildRes = await request(`/api/children/${childId}`, {
    method: 'GET',
    headers: authHeaders,
  });
  assert('Get child details by ID', getChildRes.ok && getChildRes.data?.child?.name === 'Test Kid');

  // ── 4. Pairing Flow (Parent + Child Device) ──────────────────────────────────
  console.log('\n--- [4] Device Pairing Flow ---');
  const generatePairRes = await request('/api/pair/generate', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ childId }),
  });
  assert('Parent generate 6-digit OTP & session', generatePairRes.ok && !!generatePairRes.data?.otp);
  const { otp, sessionId } = generatePairRes.data;
  console.log(`     -> Generated Pairing OTP: [ ${otp} ], Session: ${sessionId}`);

  // Child device claims the code
  const deviceFingerprint = `mock-hw-fingerprint-${Date.now()}`;
  const claimRes = await request('/api/pair/claim', {
    method: 'POST',
    body: JSON.stringify({
      sessionId,
      otp,
      deviceFingerprint,
      deviceName: 'Automated Test Device (Pixel 8 Pro)',
      androidVersion: '14.0',
    }),
  });
  assert('Child device claims OTP code', claimRes.ok && !!claimRes.data?.deviceToken);
  const deviceToken = claimRes.data?.deviceToken;
  const childHeaders = {
    Authorization: `Bearer ${deviceToken}`,
    'x-device-fingerprint': deviceFingerprint,
  };

  // Check pairing session status
  const pairStatusRes = await request(`/api/pair/status/${sessionId}`, {
    method: 'GET',
    headers: authHeaders,
  });
  assert('Pairing session marked claimed in backend', pairStatusRes.data?.claimed === true);

  // ── 5. Real-Time Socket.IO Communication ─────────────────────────────────────
  console.log('\n--- [5] Real-Time WebSocket (Socket.IO) ---');
  const socket = io(BASE_URL, {
    transports: ['websocket'],
    auth: {
      token: parentToken,
      clientType: 'parent',
    },
  });

  const socketConnected = await new Promise((resolve) => {
    socket.on('connect', () => {
      resolve(true);
    });
    socket.on('connect_error', (err) => {
      console.error('Socket connect error:', err.message);
      resolve(false);
    });
    setTimeout(() => resolve(false), 3000);
  });
  assert('Socket.IO parent connection & room join', socketConnected);

  // Setup listeners for real-time events
  let receivedStatusEvent = null;
  let receivedLocationEvent = null;

  socket.on('child_status', (data) => {
    receivedStatusEvent = data;
  });

  socket.on('location_update', (data) => {
    receivedLocationEvent = data;
  });

  // ── 6. Child Heartbeat / Status Updates ───────────────────────────────────────
  console.log('\n--- [6] Child Heartbeat & Telemetry ---');
  const heartbeatRes = await request('/api/location/status', {
    method: 'POST',
    headers: childHeaders,
    body: JSON.stringify({
      batteryLevel: 92,
      isCharging: true,
      speed: 0.0,
    }),
  });
  assert('Child sends heartbeat/status', heartbeatRes.ok && heartbeatRes.data?.ok === true);

  // Wait a moment for socket propagation
  await new Promise((r) => setTimeout(r, 400));
  assert('Parent received real-time child_status via socket', receivedStatusEvent?.childId === childId && receivedStatusEvent?.batteryLevel === 92);

  // ── 7. Child Location Tracking & PostGIS Ingestion ────────────────────────────
  console.log('\n--- [7] Location Ingestion & Spatial Storage ---');
  const baseLat = 6.4155;
  const baseLng = 80.0008;
  const now = Date.now();

  // Create 5 sequential trajectory points (spaced 15m apart along a realistic path)
  const trajectoryPoints = [
    { lat: baseLat, lng: baseLng, accuracy: 12.0, speed: 0.0, heading: 0, batteryLevel: 92, isCharging: true, recordedAt: new Date(now - 40000).toISOString() },
    { lat: baseLat + 0.00015, lng: baseLng + 0.00010, accuracy: 10.0, speed: 1.2, heading: 45, batteryLevel: 92, isCharging: true, recordedAt: new Date(now - 30000).toISOString() },
    { lat: baseLat + 0.00030, lng: baseLng + 0.00020, accuracy: 9.0, speed: 1.4, heading: 45, batteryLevel: 91, isCharging: true, recordedAt: new Date(now - 20000).toISOString() },
    { lat: baseLat + 0.00045, lng: baseLng + 0.00030, accuracy: 8.5, speed: 1.5, heading: 50, batteryLevel: 91, isCharging: true, recordedAt: new Date(now - 10000).toISOString() },
    { lat: baseLat + 0.00060, lng: baseLng + 0.00040, accuracy: 7.0, speed: 1.6, heading: 50, batteryLevel: 90, isCharging: true, recordedAt: new Date(now).toISOString() },
  ];

  const batchRes = await request('/api/location/batch', {
    method: 'POST',
    headers: childHeaders,
    body: JSON.stringify({ points: trajectoryPoints }),
  });
  assert('Batch location upload (5 trajectory points)', batchRes.ok && batchRes.data?.received === 5);

  // Wait a moment for socket propagation
  await new Promise((r) => setTimeout(r, 400));
  assert('Parent received real-time location_update via socket', receivedLocationEvent?.childId === childId && Math.abs(receivedLocationEvent?.lat - (baseLat + 0.00060)) < 0.00001);

  // ── 8. Parent Queries: Live, History, and Trips ──────────────────────────────
  console.log('\n--- [8] Parent Location History, Live View & Trips ---');
  const liveRes = await request(`/api/location/live/${childId}`, {
    method: 'GET',
    headers: authHeaders,
  });
  assert('Get live location returns latest fix', liveRes.ok && Math.abs(liveRes.data?.location?.lat - (baseLat + 0.00060)) < 0.00001);
  assert('Live location has accurate telemetry', liveRes.data?.location?.battery_level === 90 && liveRes.data?.location?.speed === 1.6);

  const historyRes = await request(`/api/location/history?childId=${childId}`, {
    method: 'GET',
    headers: authHeaders,
  });
  assert('Get location history returns all 5 points', historyRes.ok && historyRes.data?.count === 5);

  const tripsRes = await request(`/api/location/trips?childId=${childId}`, {
    method: 'GET',
    headers: authHeaders,
  });
  assert('Trip segmentation computes valid trips', tripsRes.ok && tripsRes.data?.trips?.length >= 1);
  assert('Trip stats calculate maxSpeed', tripsRes.data?.trips?.[0]?.maxSpeed === 1.6);

  // Check children list shows child as ONLINE now
  const listAgain = await request('/api/children', {
    method: 'GET',
    headers: authHeaders,
  });
  const updatedChild = listAgain.data?.children?.find((c) => c.id === childId);
  assert('Children list enriches status: isOnline is TRUE', updatedChild?.isOnline === true);
  assert('Children list enriches device info', updatedChild?.device_name === 'Automated Test Device (Pixel 8 Pro)');

  // ── 9. Setup Clean Fresh Child for Device Testing ─────────────────────────────
  console.log('\n--- [9] Preparing Fresh Pair Code for Phone App ---');
  // Generate a fresh pair session for user phone
  const freshPairRes = await request('/api/pair/generate', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ childName: 'My Child' }),
  });
  if (freshPairRes.ok) {
    console.log('\n****************************************************');
    console.log(` READY FOR YOUR PHONE:`);
    console.log(` Child Name: "My Child"`);
    console.log(` Pairing Code (OTP): >>>  ${freshPairRes.data.otp}  <<<`);
    console.log(` Session ID: ${freshPairRes.data.sessionId}`);
    console.log('****************************************************\n');
  }

  socket.disconnect();

  console.log('====================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  process.exit(failed > 0 ? 1 : 0);
}

runAllFeatureTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
