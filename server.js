require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const cleanEnv = (v) => String(v || '').replace(/^["']|["']$/g, '').trim();

const JWT_SECRET = cleanEnv(process.env.JWT_SECRET) || 'CHANGE_THIS_IN_RENDER_ENV';
const PREMIUM_PRICE = Number(process.env.PREMIUM_PRICE || 49);
const PREMIUM_DISCOUNT_PERCENT = Number(process.env.PREMIUM_DISCOUNT_PERCENT || 12);

// ================= SECURITY MIDDLEWARE =================
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '50kb' }));

// Strip MongoDB operators ($gt, $ne, etc.) to prevent NoSQL Injection
function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) delete obj[key];
    else if (typeof obj[key] === 'object') sanitizeObject(obj[key]);
  }
}
app.use((req, _res, next) => {
  sanitizeObject(req.body);
  sanitizeObject(req.query);
  next();
});

app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));
app.use('/api/auth', rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  message: { error: 'Too many attempts. Please try again in 10 minutes.' }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ================= 1. MONGODB CONNECTION =================
const MONGODB_URI = cleanEnv(process.env.MONGODB_URI);

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is missing in Render Environment Variables!');
} else {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err.message));
}

// ================= 2. EMAIL OTP MAILER =================
const SMTP_HOST = cleanEnv(process.env.SMTP_HOST) || 'smtp.gmail.com';
const SMTP_PORT = Number(cleanEnv(process.env.SMTP_PORT) || 587);
const SMTP_USER = cleanEnv(process.env.SMTP_USER);
const SMTP_PASS = cleanEnv(process.env.SMTP_PASS).replace(/\s+/g, ''); // Removes spaces from Gmail App Password

const mailer = (SMTP_USER && SMTP_PASS) ? nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS
  }
}) : null;

if (mailer) {
  console.log(`✅ SMTP Mailer Ready (${SMTP_USER} via ${SMTP_HOST}:${SMTP_PORT})`);
} else {
  console.error(`❌ SMTP not ready -> SMTP_USER set: ${Boolean(SMTP_USER)}, SMTP_PASS set: ${Boolean(SMTP_PASS)}`);
}

// ================= 3. DATABASE SCHEMAS =================
const Product = mongoose.model('Product', new mongoose.Schema({
  code: String,
  name: String,
  category: String,
  tag: String,
  price: Number,
  mrp: Number,
  images: [String],
  specs: Object,
  stock: { type: Number, default: 20 }
}));

const User = mongoose.model('User', new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, sparse: true },
  phone: { type: String, unique: true, sparse: true },
  passwordHash: { type: String, required: true },
  isPremium: { type: Boolean, default: false },
  premiumExpiresAt: Date,
  lastSpinDate: String,
  coupons: [String],
  fitCoins: { type: Number, default: 50 },
  coinLedger: [{ label: String, delta: Number, createdAt: { type: Date, default: Date.now } }]
}, { timestamps: true }));

const Otp = mongoose.model('Otp', new mongoose.Schema({
  channel: { type: String, enum: ['email', 'whatsapp'], required: true },
  target: { type: String, required: true },
  codeHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 300 } // Auto-expires in 5 mins
}));

const Order = mongoose.model('Order', new mongoose.Schema({
  orderId: String,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  userName: String,
  userEmail: String,
  userPhone: String,
  address: String,
  pincode: String,
  paymentMode: { type: String, enum: ['UPI', 'CARD', 'NETBANKING', 'WALLET', 'EMI', 'COD'], default: 'COD' },
  paymentStatus: { type: String, default: 'PENDING' },
  deliveryEstimate: { type: String, default: '4-5 Days' },
  items: Array,
  subtotal: Number,
  discount: Number,
  finalTotal: Number,
  couponUsed: String
}, { timestamps: true }));

const ContactMessage = mongoose.model('ContactMessage', new mongoose.Schema({
  name: String,
  phone: String,
  email: String,
  message: String,
  status: { type: String, default: 'NEW' }
}, { timestamps: true }));

// ================= HELPERS =================
const wheelPrizes = [
  { segment: 1, label: '10% OFF Coupon', code: 'SPIN10', discountPercent: 10, coins: 15, weight: 35 },
  { segment: 2, label: '15% OFF Coupon', code: 'SPIN15', discountPercent: 15, coins: 25, weight: 25 },
  { segment: 3, label: '₹150 Flat Off', code: 'FLAT150', flatDiscount: 150, coins: 20, weight: 15 },
  { segment: 4, label: '20% OFF Coupon', code: 'SPIN20', discountPercent: 20, coins: 30, weight: 20 },
  { segment: 5, label: '50% OFF Jackpot!', code: 'JACKPOT50', discountPercent: 50, coins: 100, weight: 5 }
];

function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function hasActivePremium(user) {
  return Boolean(user && user.isPremium && (!user.premiumExpiresAt || user.premiumExpiresAt > new Date()));
}

function calcItemPrice(price, isVip) {
  return isVip ? Math.round(price * (1 - PREMIUM_DISCOUNT_PERCENT / 100)) : price;
}

async function getAuthUser(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  try {
    return await User.findById(jwt.verify(h.split(' ')[1], JWT_SECRET).id);
  } catch {
    return null;
  }
}

// ================= 4. AUTH ROUTES (EMAIL OTP SIGN UP + PASSWORD LOG IN) =================

// SEND EMAIL OTP FOR SIGN UP
app.post('/api/auth/email/send-otp', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email.includes('@')) return res.status(400).json({ error: 'Valid email address required' });

    if (await User.findOne({ email })) {
      return res.status(409).json({ error: 'Email already registered. Please Log In instead.' });
    }

    if (!mailer) {
      return res.status(500).json({ error: 'SMTP credentials not set in Environment Variables' });
    }

    const code = String(crypto.randomInt(100000, 999999));
    await Otp.deleteMany({ channel: 'email', target: email });
    await Otp.create({ channel: 'email', target: email, codeHash: hashOtp(code) });

    await mailer.sendMail({
      from: `"The FitsCheck™" <${SMTP_USER}>`,
      to: email,
      subject: 'Your FitsCheck Sign-Up Verification OTP',
      text: `Your FitsCheck verification OTP is ${code}. Valid for 5 minutes.`
    });

    res.json({ success: true, message: 'Email OTP sent' });
  } catch (err) {
    console.error('❌ Email OTP Error:', err.message);
    res.status(500).json({ error: 'Failed to send Email OTP. Check Render Logs.' });
  }
});

// SINGLE-STEP SIGN UP: Verify OTP + Save User & Hashed Password in MongoDB
app.post('/api/auth/signup-with-otp', async (req, res) => {
  try {
    const { channel = 'email', target, code, name, password } = req.body;
    const cleanTarget = String(target || '').trim().toLowerCase();

    if (!cleanTarget || !code || !password || password.length < 6) {
      return res.status(400).json({ error: 'All fields and a password (min 6 chars) are required' });
    }

    const record = await Otp.findOne({ channel, target: cleanTarget, codeHash: hashOtp(code) });
    if (!record) return res.status(400).json({ error: 'Invalid or expired OTP' });
    await Otp.deleteOne({ _id: record._id });

    const passwordHash = await bcrypt.hash(password, 12);
    const userData = {
      name: String(name || 'Player').trim(),
      passwordHash,
      coinLedger: [{ label: 'Welcome Bonus', delta: 50 }]
    };
    if (channel === 'email') userData.email = cleanTarget;
    else userData.phone = cleanTarget;

    const user = await User.create(userData);
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email || '',
        phone: user.phone || '',
        isPremium: false,
        fitCoins: user.fitCoins
      }
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Account already exists. Please Log In.' });
    console.error('❌ Sign Up Error:', err.message);
    res.status(500).json({ error: 'Sign up failed' });
  }
});

// LOG IN: Email or Mobile Number + Password
app.post('/api/auth/login', async (req, res) => {
  try {
    const identifier = String(req.body.identifier || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!identifier || !password) return res.status(400).json({ error: 'Email/Number and password required' });

    const query = identifier.includes('@') ? { email: identifier } : { phone: identifier };
    const user = await User.findOne(query);

    if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email/number or password' });
    }

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email || '',
        phone: user.phone || '',
        isPremium: hasActivePremium(user),
        fitCoins: user.fitCoins
      }
    });
  } catch (err) {
    console.error('❌ Login Error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

/* ============================================================================
   [CO-DEV SECTION 1: WHATSAPP OTP ROUTES]
   ============================================================================ */
app.post('/api/auth/whatsapp/send-otp', async (_req, res) => {
  res.status(501).json({ error: 'WhatsApp OTP not yet configured (Co-Dev TODO)' });
});

// ================= 5. PREMIUM (₹49 / 6M), SPIN WHEEL & PROFILE =================
app.post('/api/premium', async (req, res) => {
  try {
    const user = await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first' });

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 6);
    user.isPremium = true;
    user.premiumExpiresAt = expiresAt;
    await user.save();

    res.json({
      success: true,
      pricePaid: PREMIUM_PRICE,
      discountPercent: PREMIUM_DISCOUNT_PERCENT,
      expiresAt
    });
  } catch {
    res.status(500).json({ error: 'Could not activate premium' });
  }
});

app.post('/api/spin', async (req, res) => {
  try {
    const user = await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first' });
    if (!hasActivePremium(user)) {
      return res.status(403).json({ error: `Join 6-Month Premium (₹${PREMIUM_PRICE}) to unlock the Spin Wheel.` });
    }

    const totalWeight = wheelPrizes.reduce((sum, p) => sum + p.weight, 0);
    let rand = Math.random() * totalWeight;
    let winningPrize = wheelPrizes[0];
    for (const prize of wheelPrizes) {
      if (rand < prize.weight) { winningPrize = prize; break; }
      rand -= prize.weight;
    }

    user.lastSpinDate = new Date().toISOString().split('T')[0];
    user.coupons.push(winningPrize.code);
    user.fitCoins += winningPrize.coins;
    user.coinLedger.unshift({ label: `Spin Wheel (${winningPrize.label})`, delta: winningPrize.coins });
    await user.save();

    res.json({ success: true, prize: winningPrize, fitCoins: user.fitCoins });
  } catch {
    res.status(500).json({ error: 'Spin failed' });
  }
});

app.get('/api/profile', async (req, res) => {
  try {
    const user = await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const orders = await Order.find({ userId: user._id }).sort({ createdAt: -1 }).lean();
    res.json({
      user: {
        name: user.name,
        email: user.email || '',
        phone: user.phone || '',
        isPremium: hasActivePremium(user),
        premiumExpiresAt: user.premiumExpiresAt,
        fitCoins: user.fitCoins,
        coinLedger: user.coinLedger
      },
      orders
    });
  } catch {
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ================= 6. CHECKOUT (LOGIN + ADDRESS REQUIRED) =================
app.post('/api/checkout', async (req, res) => {
  try {
    const user = await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in to place your order' });

    const { items = [], phone, address, pincode, paymentMode = 'COD', couponCode } = req.body;
    if (!items.length) return res.status(400).json({ error: 'Bag is empty' });
    if (!address || String(address).trim().length < 5) {
      return res.status(400).json({ error: 'Delivery address required' });
    }

    const isVip = hasActivePremium(user);
    const subtotal = items.reduce((sum, i) => sum + calcItemPrice(Number(i.price), isVip) * Number(i.qty || 1), 0);
    const discount = String(couponCode || '').trim().toUpperCase() === 'SPIN20' ? Math.min(subtotal, 100) : 0;
    const finalTotal = Math.max(0, subtotal - discount);

    const order = await Order.create({
      orderId: `FC-${Date.now().toString().slice(-5)}`,
      userId: user._id,
      userName: user.name,
      userEmail: user.email || '',
      userPhone: String(phone || user.phone || ''),
      address: String(address).trim(),
      pincode: String(pincode || '').trim(),
      paymentMode,
      paymentStatus: paymentMode === 'COD' ? 'COD_CONFIRMED' : 'PENDING',
      items,
      subtotal,
      discount,
      finalTotal,
      couponUsed: couponCode || 'None'
    });

    if (finalTotal >= 600) {
      user.fitCoins += 30;
      user.coinLedger.unshift({ label: `Order ${order.orderId} Reward`, delta: 30 });
      await user.save();
    }

    res.status(201).json({ success: true, order, fitCoins: user.fitCoins });
  } catch (err) {
    console.error('❌ Checkout Error:', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

/* ============================================================================
   [CO-DEV SECTION 2: PAYMENT GATEWAY INTEGRATION]
   ============================================================================ */
app.post('/api/payment/create-order', async (_req, res) => {
  res.status(501).json({ error: 'Payment gateway not yet configured (Co-Dev TODO)' });
});

app.post('/api/payment/verify', async (_req, res) => {
  res.status(501).json({ error: 'Payment verification not yet configured (Co-Dev TODO)' });
});

/* ============================================================================
   [CO-DEV SECTION 3: DELIVERY PARTNER INTEGRATION]
   ============================================================================ */
app.get('/api/delivery/check', async (_req, res) => {
  res.json({ serviceable: true, eta: '4-5 Days', note: 'Co-Dev delivery partner placeholder' });
});

// ================= 7. CONTACT US (SAVES TO DB + EMAILS) =================
app.post('/api/contact', async (req, res) => {
  try {
    const { name, phone, email, message } = req.body;
    if (!name || !message) return res.status(400).json({ error: 'Name and message are required' });

    const saved = await ContactMessage.create({ name, phone, email, message });

    if (mailer && SMTP_USER) {
      await mailer.sendMail({
        from: `"The FitsCheck™ Contact" <${SMTP_USER}>`,
        to: SMTP_USER,
        subject: `New Inquiry from ${name}`,
        text: `Name: ${name}\nPhone: ${phone}\nEmail: ${email}\n\nMessage:\n${message}`
      }).catch(err => console.error('❌ Contact Email Error:', err.message));
    }

    res.status(201).json({ success: true, id: saved._id });
  } catch {
    res.status(500).json({ error: 'Failed to submit message' });
  }
});

app.listen(PORT, () => console.log(`🚀 FitsCheck server running on port ${PORT}`));