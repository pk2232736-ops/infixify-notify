// =====================================================================
//  INFIXIFY NOTIFY — mini server for phone notification-bar pushes
//  Route:  POST /admin/send-broadcast-push
//  Body:   { title, body, imageUrl?, uid? }
//     uid missing -> all users with a saved fcmToken
//     uid present -> only that user
//  Env vars (set on Render, NEVER in code / HTML / GitHub):
//     FIREBASE_SERVICE_ACCOUNT  = full contents of the service-account JSON file
//     FIREBASE_DATABASE_URL     = (optional) defaults to your Realtime DB URL below
//     PUSH_CHANNEL_ID           = (optional) Android notification channel id
// =====================================================================
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
} catch (e) {
  console.error('FATAL: FIREBASE_SERVICE_ACCOUNT env var is missing or is not valid JSON. Paste the FULL contents of the service-account .json file.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://ruvax-26646-default-rtdb.firebaseio.com'
});

const app = express();
app.use(cors());              // admin.html is hosted on another domain, so CORS is required
app.use(express.json());

// Health check (open this URL in a browser to confirm the server is alive)
app.get('/', (req, res) => res.send('Infixify notify server is running'));

const pushCooldown = new Map(); // adminUid -> last broadcast time (anti double-click / spam)

app.post('/admin/send-broadcast-push', async (req, res) => {
  try {
    // 1) Who is calling?
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Missing token' });

    let decoded;
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
    const callerUid = decoded.uid;

    // 2) Allowed? (Super Admin OR active staff with 'all' / 'notif_mgt' permission — same rule as admin.html)
    const db = admin.database();
    let allowed = false;
    const mainAdminUid = (await db.ref('adminConfig/adminUid').once('value')).val();
    if (mainAdminUid && mainAdminUid === callerUid) {
      allowed = true;
    } else {
      const st = (await db.ref(`staff/${callerUid}`).once('value')).val();
      if (st && st.status === 'active') {
        const perms = Array.isArray(st.permissions) ? st.permissions : Object.values(st.permissions || {});
        allowed = perms.includes('all') || perms.includes('notif_mgt');
      }
    }
    if (!allowed) return res.status(403).json({ error: 'Not allowed' });

    // 3) Validate input
    const title = String(req.body.title || '').trim().slice(0, 100);
    const body = String(req.body.body || '').trim().slice(0, 500);
    const imageUrl = String(req.body.imageUrl || '').trim();
    const targetUid = req.body.uid ? String(req.body.uid) : null;
    if (!title || !body) return res.status(400).json({ error: 'Title and message are required' });
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) return res.status(400).json({ error: 'Image URL must start with https://' });

    if (!targetUid) {
      const last = pushCooldown.get(callerUid) || 0;
      if (Date.now() - last < 8000) return res.status(429).json({ error: 'Please wait a few seconds before sending again' });
      pushCooldown.set(callerUid, Date.now());
    }

    // 4) Collect device tokens (Map removes duplicate tokens)
    const tokenToUid = new Map();
    if (targetUid) {
      const u = (await db.ref(`users/${targetUid}`).once('value')).val();
      if (u && u.fcmToken && u.fcmToken !== 'NA' && u.status !== 'banned') tokenToUid.set(u.fcmToken, targetUid);
    } else {
      const snap = await db.ref('users').once('value');
      snap.forEach(c => {
        const u = c.val();
        if (u && u.fcmToken && u.fcmToken !== 'NA' && u.status !== 'banned') tokenToUid.set(u.fcmToken, c.key);
      });
    }
    const tokens = Array.from(tokenToUid.keys());
    if (tokens.length === 0) {
      return res.status(404).json({ error: targetUid ? 'This user has no device token yet' : 'No devices to send to' });
    }

    // 5) Send in batches of 500 (FCM limit)
    const channelId = process.env.PUSH_CHANNEL_ID || undefined;
    let sent = 0, failed = 0;
    const deadUpdates = {};

    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      const result = await admin.messaging().sendEachForMulticast({
        tokens: batch,
        notification: { title, body, ...(imageUrl ? { imageUrl } : {}) },
        data: { type: 'admin_broadcast', title, body },
        android: {
          priority: 'high',
          notification: { ...(channelId ? { channelId } : {}), ...(imageUrl ? { imageUrl } : {}) }
        }
      });
      sent += result.successCount;
      failed += result.failureCount;

      // Remove dead tokens (app uninstalled / token expired)
      result.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error && r.error.code;
          if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
            const owner = tokenToUid.get(batch[idx]);
            if (owner) deadUpdates[`users/${owner}/fcmToken`] = null;
          }
        }
      });
    }

    const removed = Object.keys(deadUpdates).length;
    if (removed) await db.ref().update(deadUpdates).catch(() => {});

    return res.json({ success: true, total: tokens.length, sent, failed, removed });
  } catch (err) {
    console.error('[send-broadcast-push] error:', err);
    return res.status(500).json({ error: 'Server error while sending push' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Infixify notify server listening on port ' + PORT));
