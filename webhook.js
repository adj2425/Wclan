 // webhook.js — WCLAN webhook + order server
// Copy this file into your project root (replace existing webhook.js).
// Run: npm run dev
// Make sure .env is present and correct.

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const cors = require('cors');
const nodemailer = require('nodemailer');
const process = require('process');
const path = require('path');

const app = express();

// -------------------- Config / env --------------------
const PORT = Number(process.env.PORT || 3000);
process.env.MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || '';
const MONGO_URI = process.env.MONGO_URI;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

const WHATSAPP_LINK = process.env.WHATSAPP_LINK || '';
const TELEGRAM_LINK = process.env.TELEGRAM_LINK || '';
const MERN_BUNDLE_URL = process.env.MERN_BUNDLE_URL || '';

// Optional SMTP
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = process.env.SMTP_PORT || '';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'WCLAN <no-reply@wclan.in>';

// Debug quick-check on startup
console.log('DEBUG: PORT =', PORT);
console.log('DEBUG: MONGO_URI present?', !!MONGO_URI);
console.log('DEBUG: RAZORPAY_KEY_ID present?', !!RAZORPAY_KEY_ID);
console.log('DEBUG: RAZORPAY_WEBHOOK_SECRET present?', !!RAZORPAY_WEBHOOK_SECRET);

// -------------------- Middleware --------------------
// We need raw body for webhook HMAC verification — keep raw in req.rawBody
app.use(bodyParser.json({
  verify: function (req, res, buf) {
    req.rawBody = buf ? buf.toString() : '';
  }
}));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());

// Serve static frontend if you put index.html in /public (optional)
// app.use(express.static(path.join(__dirname, 'public')));

// -------------------- MongoDB --------------------
if (!MONGO_URI) {
  console.error('❌ MONGO_URI not set in .env. MongoDB will not connect until set.');
} else {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err));
}

// Minimal attendee schema
const AttendeeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String },
  bundle: { type: Boolean, default: false },
  orderId: { type: String },
  paymentId: { type: String },
  verified: { type: Boolean, default: false },
  links: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

const Attendee = mongoose.models.Attendee || mongoose.model('Attendee', AttendeeSchema);

// -------------------- Razorpay client --------------------
const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

// -------------------- Mailer --------------------
let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: (String(SMTP_PORT) === '465'), // true for 465, false for other ports
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  console.log('✉️ Mailer configured.');
} else {
  console.log('⚠️ Mailer not configured (SMTP missing). Emails will be skipped.');
}

async function sendConfirmationEmail(attendee) {
  if (!transporter) return;
  try {
    const links = attendee.links || {};
    let html = `<p>Hi ${attendee.name},</p>
      <p>Thanks for joining the WCLAN workshop — here are your join links & resources:</p><ul>`;
    if (links.whatsapp) html += `<li>WhatsApp: <a href="${links.whatsapp}">${links.whatsapp}</a></li>`;
    if (links.telegram) html += `<li>Telegram: <a href="${links.telegram}">${links.telegram}</a></li>`;
    if (links.download) html += `<li>Download: <a href="${links.download}">Download bundle</a></li>`;
    html += `</ul><p>See you at the workshop — WCLAN</p>`;

    await transporter.sendMail({
      from: SMTP_FROM,
      to: attendee.email,
      subject: 'WCLAN — Your workshop links',
      html
    });
    console.log('📧 Confirmation email sent to', attendee.email);
  } catch (err) {
    console.error('❌ sendConfirmationEmail error', err);
  }
}

// -------------------- Helpers --------------------
function safeJsonResponse(res, code, payload) {
  res.status(code || 200).json(payload || {});
}

function computeHmacSha256(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// -------------------- Static Frontend --------------------
// Serve static files from /assets
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


// Create order (expects amount in paise)
app.post('/create-order', async (req, res) => {
  try {
    const { amount, name, email, phone, bundle } = req.body;
    if (!amount || !name || !email) {
      return safeJsonResponse(res, 400, { ok: false, error: 'Missing required fields: amount,name,email' });
    }

    // Create Razorpay order (server-side)
    const order = await razorpay.orders.create({
      amount: Number(amount),
      currency: 'INR',
      receipt: 'wclan_' + Date.now(),
      payment_capture: 1
    });

    // Save attendee record (pending)
    const attendee = new Attendee({
      name, email, phone, bundle: !!bundle,
      orderId: order.id,
      verified: false
    });
    await attendee.save();

    return safeJsonResponse(res, 200, { ok: true, order });
  } catch (err) {
    console.error('❌ /create-order error', err);
    return safeJsonResponse(res, 500, { ok: false, error: 'server error' });
  }
});

// Client-side payment report (non-authoritative)
app.post('/payment-verify', async (req, res) => {
  // This is optional: frontend may POST razorpay response here for convenience.
  // Real verification should rely on webhook.
  try {
    console.log('/payment-verify received (client report):', req.body || {});
    return safeJsonResponse(res, 200, { ok: true });
  } catch (err) {
    console.error('❌ /payment-verify error', err);
    return safeJsonResponse(res, 500, { ok: false });
  }
});

// Razorpay webhook endpoint (authoritative)
app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'] || '';
    const raw = req.rawBody || JSON.stringify(req.body || {});

    // Verify signature if secret available
    if (RAZORPAY_WEBHOOK_SECRET) {
      const expected = computeHmacSha256(RAZORPAY_WEBHOOK_SECRET, raw);
      if (expected !== signature) {
        console.error('❌ Webhook signature mismatch', { expected, signature });
        return res.status(400).send('invalid signature');
      }
    } else {
      console.warn('⚠️ RAZORPAY_WEBHOOK_SECRET not set — webhook signature verification disabled.');
    }

    const payload = req.body;
    const event = payload && payload.event;
    console.log('🔔 webhook event:', event);

    // Main event we care about: payment.captured (Razorpay)
    if (event === 'payment.captured' || event === 'payment.authorized' || event === 'order.paid') {
      // Navigate payload to find payment entity safely
      const paymentEntity = payload.payload && (payload.payload.payment ? payload.payload.payment.entity : null);
      const orderEntity = payload.payload && (payload.payload.order ? payload.payload.order.entity : null);
      const payment = paymentEntity || (payload.payload && payload.payload.payment && payload.payload.payment.entity) || null;

      if (payment && payment.order_id) {
        const orderId = payment.order_id;
        const paymentId = payment.id;
        const razorStatus = payment.status || 'captured';

        const attendee = await Attendee.findOne({ orderId: orderId });
        if (!attendee) {
          console.warn('⚠️ webhook: attendee not found for orderId', orderId);
        } else {
          attendee.paymentId = paymentId;
          attendee.verified = true;
          attendee.links = attendee.links || {};

          // assign links based on bundle
          attendee.links.whatsapp = attendee.links.whatsapp || WHATSAPP_LINK || '';
          if (attendee.bundle) {
            attendee.links.telegram = attendee.links.telegram || TELEGRAM_LINK || '';
            attendee.links.download = attendee.links.download || MERN_BUNDLE_URL || '';
          }

          attendee.save().then(() => {
            console.log('✅ attendee updated', attendee.email);
            // send email if configured
            sendConfirmationEmail(attendee).catch(()=>{});
          }).catch(err => {
            console.error('❌ saving attendee after webhook', err);
          });
        }
      } else {
        console.warn('⚠️ webhook: payment object missing or no order_id');
      }
    } else {
      // log other events for visibility
      console.log('Webhook event ignored (not processed):', event);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ /webhook handler error', err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// Attendee status polling endpoint
app.get('/attendee-status/:paymentId', async (req, res) => {
  try {
    const pid = req.params.paymentId;
    if (!pid) return safeJsonResponse(res, 400, { ok: false, error: 'missing payment id' });

    const attendee = await Attendee.findOne({ paymentId: pid });
    if (!attendee) return safeJsonResponse(res, 404, { ok: false, error: 'not found' });

    return safeJsonResponse(res, 200, {
      ok: true,
      verified: !!attendee.verified,
      links: attendee.links || {}
    });
  } catch (err) {
    console.error('❌ /attendee-status error', err);
    return safeJsonResponse(res, 500, { ok: false });
  }
});

// Small utility route: list recent attendees (dev only)
app.get('/_recent-attendees', async (req, res) => {
  try {
    const list = await Attendee.find().sort({ createdAt: -1 }).limit(30).lean();
    return res.json({ ok: true, count: list.length, list });
  } catch (err) {
    return res.status(500).json({ ok: false });
  }
});

// -------------------- Server start with port fallback --------------------
function startServerWithFallback(startPort, maxAttempts = 6) {
  let port = startPort;
  let attempts = 0;

  return new Promise((resolve, reject) => {
    const tryStart = () => {
      const server = app.listen(port, () => {
        console.log(`🚀 WCLAN webhook server listening on port ${port}`);
        resolve(server);
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < maxAttempts - 1) {
          console.warn(`Port ${port} in use, trying ${port + 1}...`);
          attempts++;
          port++;
          setTimeout(tryStart, 200);
        } else {
          reject(err);
        }
      });
    };

    tryStart();
  });
}

startServerWithFallback(PORT, 8).catch(err => {
  console.error('Server failed to start:', err);
  process.exit(1);
});

// Export for tests if needed
module.exports = app;