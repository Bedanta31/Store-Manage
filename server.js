// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode-terminal");
const cron = require("node-cron");
const { Client, RemoteAuth } = require("whatsapp-web.js");

// --- Firebase Admin (Firestore for data + meta) ---
const admin = require("firebase-admin");

// The private key env often contains literal '\n' — fix that:
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey
  })
});
const db = admin.firestore();

// --- Firebase Web SDK for Storage (for RemoteAuth session store) ---
const { initializeApp, getStorage, FirebaseStorageStore } = require("wwebjs-firebase-storage");
const webApp = initializeApp({
  apiKey: process.env.WEB_API_KEY,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});
const storage = getStorage(webApp);

// --- WhatsApp Client with RemoteAuth (no Render Disk needed) ---
const client = new Client({
  authStrategy: new RemoteAuth({
    clientId: "my-bot",
    // Save under a folder in your Firebase Storage bucket:
    store: new FirebaseStorageStore({
      firebaseStorage: storage,
      sessionPath: "sessions-whatsapp-webjs"
    }),
    backupSyncIntervalMs: 600000 // 10 minutes
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  }
});

// Environment
const GROUP_ID = process.env.GROUP_ID; // e.g. "120363405243628613@g.us"
const PORT = process.env.PORT || 10000;
const TZ = process.env.TZ || "Asia/Kolkata"; // set this in Render env vars

// Helpers
function todayStrInTZ(tz = "Asia/Kolkata") {
  const now = new Date();
  // Convert to target TZ date string YYYY-MM-DD
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(now); // e.g. "2025-08-22"
}

async function fetchLowItems() {
  const snap = await db.collection("items").where("stock", "<", 5).get();
  const list = [];
  snap.forEach(d => list.push({ id: d.id, ...(d.data() || {}) }));
  return list;
}

async function alreadySentToday() {
  const metaRef = db.collection("meta").doc("daily");
  const snap = await metaRef.get();
  const last = snap.exists ? snap.data().lastSentDate : null;
  return last === todayStrInTZ(TZ);
}

async function markSentToday() {
  const metaRef = db.collection("meta").doc("daily");
  await metaRef.set({ lastSentDate: todayStrInTZ(TZ), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function checkAndSend() {
  const low = await fetchLowItems();
  if (!low.length) {
    console.log("No low-stock items. Nothing to send.");
    return "none";
  }

  if (await alreadySentToday()) {
    console.log("Already sent today. Skipping.");
    return "skipped";
  }

  const lines = low.map(it => `• ${it.name || it.id}: ${it.stock} left`);
  const message =
    `⚠️ Stock Alert (Daily 8:00 AM)\n` +
    `The following items are low (<5):\n\n` +
    lines.join("\n");

  await client.sendMessage(GROUP_ID, message);
  await markSentToday();
  console.log("Message sent to group.");
  return "sent";
}

// WhatsApp events
client.on("qr", (qr) => {
    console.log("📱 Scan this QR (copy it into a QR generator):\n", qr);
    qrcode.generate(qr, { small: true });
});

client.on("remote_session_saved", () => {
  console.log("💾 Remote session saved (stored in Firebase Storage).");
});

client.on("ready", async () => {
  console.log("✅ WhatsApp client is ready!");
});

client.on("disconnected", (reason) => {
  console.log("❌ Disconnected:", reason);
  client.initialize();
});

// Start WhatsApp
client.initialize();

// HTTP server
const app = express();
app.use(cors());
app.get("/healthz", (req, res) => res.send("ok"));

app.post("/send-now", express.json(), async (req, res) => {
  // Optional simple protection
  if ((req.query.key || req.body?.key) !== process.env.TRIGGER_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  try {
    const result = await checkAndSend();
    res.json({ ok: true, result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`HTTP listening on :${PORT}`);
  console.log(`Timezone: ${TZ}`);
  // Schedule at 08:00 Asia/Kolkata
  cron.schedule("0 0 8 * * *", () => {
    console.log("⏰ 08:00 job firing…");
    checkAndSend().catch(console.error);
  }, { timezone: TZ });
});

