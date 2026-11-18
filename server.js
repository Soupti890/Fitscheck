require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fitscheck_super_secret_key_2026';
const ADMIN_KEY = process.env.ADMIN_KEY || 'fitscheck_admin_123';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. CONNECT TO MONGODB (Reads MONGODB_URI from Render Environment Variables)
const rawUri = process.env.MONGODB_URI || '';
const MONGODB_URI = rawUri.replace(/^["']|["']$/g, '').trim();

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is missing in Render Environment Variables!');
} else {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err.message));
}

// 2. DATABASE SCHEMAS
const Product = mongoose.model('Product', new mongoose.Schema({
  name: String,
  category: String,
  tag: String,
  price: Number,
  premiumPrice: Number,
  stock: { type: Number, default: 20 }
}));

const User = mongoose.model('User', new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  passwordHash: String,
  isPremium: { type: Boolean, default: false },
  lastSpinDate: String,
  coupons: [String]
}, { timestamps: true }));

const Cart = mongoose.model('Cart', new mongoose.Schema({
  sessionId: { type: String, unique: true },
  items: [{ productId: String, name: String, price: Number, premiumPrice: Number, quantity: Number }]
}));

const Order = mongoose.model('Order', new mongoose.Schema({
  orderId: String,
  userEmail: String,
  items: Array,
  subtotal: Number,
  discount: Number,
  finalTotal: Number,
  couponUsed: String
}, { timestamps: true }));

// Initial Seed Products
const initialProducts = [
  { name: 'Nike Dunk Low Retro Edition', category: 'shoes', tag: 'Dunk Low', price: 1199, premiumPrice: 949 },
  { name: 'Air Jordan 1 Retro High', category: 'shoes', tag: 'Retro High', price: 1199, premiumPrice: 999 },
  { name: 'Court Pro Classic Sneaker', category: 'shoes', tag: 'Court Pro', price: 899, premiumPrice: 699 },
  { name: 'Real Madrid Mbappé #9 Home Jersey', category: 'jerseys', tag: 'MBAPPE', price: 499, premiumPrice: 379 },
  { name: 'Argentina Messi #10 World Cup Jersey', category: 'jerseys', tag: 'MESSI', price: 549, premiumPrice: 419 },
  { name: 'Al Nassr CR7 #7 Special Edition Jersey', category: 'jerseys', tag: 'CR7', price: 499, premiumPrice: 379 },
  { name: 'Pro Training Sports Kit (Jersey + Shorts)', category: 'sports-kits', tag: 'Kits', price: 699, premiumPrice: 549 },
  { name: 'Matchday Wristband & Socks Pack', category: 'sports-kits', tag: 'Kits', price: 120, premiumPrice: 80 },
  { name: 'Ultimate Matchday Combo (Jersey + Shoes)', category: 'combo-packs', tag: 'Combo Packs', price: 1199, premiumPrice: 950 }
];

const wheelPrizes = [
  { segment: 1, color: 'Red', label: '10% OFF Coupon', code: 'SPIN10', discountPercent: 10, weight: 35 },
  { segment: 2, color: 'Gold', label: '15% OFF Coupon', code: 'SPIN15', discountPercent: 15, weight: 25 },
  { segment: 3, color: 'Purple', label: '₹150 Flat Off', code: 'FLAT150', flatDiscount: 150, weight: 15 },
  { segment: 4, color: 'Blue', label: '20% OFF Coupon', code: 'SPIN20', discountPercent: 20, weight: 20 },
  { segment: 5, color: 'Green', label: '50% OFF Jackpot!', code: 'JACKPOT50', discountPercent: 50, weight: 5 }
];

async function getAuthUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    return await User.findById(decoded.id);
  } catch {
    return null;
  }
}

// 3. API ROUTES
app.get('/api/products', async (req, res) => {
  try {
    if ((await Product.countDocuments()) === 0) await Product.insertMany(initialProducts);
    const { category, tag, q } = req.query;
    const filter = {};
    if (category) filter.category = new RegExp(`^${category}$`, 'i');
    if (tag) filter.tag = new RegExp(tag, 'i');
    if (q) {
      const r = new RegExp(q, 'i');
      filter.$or = [{ name: r }, { category: r }, { tag: r }];
    }
    const products = await Product.find(filter).lean();
    res.json({ count: products.length, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth', async (req, res) => {
  try {
    const { action, name, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    if (action === 'register') {
      if (await User.findOne({ email })) return res.status(409).json({ error: 'Email already registered' });
      const passwordHash = await bcrypt.hash(password, 10);
      const u = await User.create({ name: name || 'Player', email, passwordHash });
      const token = jwt.sign({ id: u._id }, JWT_SECRET, { expiresIn: '7d' });
      return res.status(201).json({ token, user: { id: u._id, name: u.name, email, isPremium: false } });
    }

    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, isPremium: user.isPremium } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/spin', async (req, res) => {
  try {
    const user = await getAuthUser(req);
    const today = new Date().toISOString().split('T')[0];
    if (user && user.lastSpinDate === today && !user.isPremium) {
      return res.status(429).json({ error: 'Daily spin used! Join Premium Lounge (₹21/mo) for unlimited spins.' });
    }
    const totalWeight = wheelPrizes.reduce((sum, p) => sum + p.weight, 0);
    let rand = Math.random() * totalWeight;
    let winningPrize = wheelPrizes[0];
    for (const prize of wheelPrizes) {
      if (rand < prize.weight) { winningPrize = prize; break; }
      rand -= prize.weight;
    }
    if (user) {
      user.lastSpinDate = today;
      user.coupons.push(winningPrize.code);
      await user.save();
    }
    res.json({ success: true, prize: winningPrize });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/premium', async (req, res) => {
  try {
    const user = await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first' });
    user.isPremium = true;
    user.coupons.push('VIPWELCOME25');
    await user.save();
    res.json({ success: true, plan: 'Fits Check Premium Lounge', bonusCoupon: 'VIPWELCOME25' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/checkout', async (req, res) => {
  try {
    const { sessionId, productId, quantity = 1 } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    let cart = await Cart.findOne({ sessionId });
    if (!cart) cart = new Cart({ sessionId, items: [] });

    const existing = cart.items.find(i => i.productId === String(productId));
    if (existing) {
      existing.quantity += Number(quantity);
    } else {
      cart.items.push({ productId: String(product._id), name: product.name, price: product.price, premiumPrice: product.premiumPrice, quantity: Number(quantity) });
    }
    await cart.save();
    res.json({ cart: cart.items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/checkout', async (req, res) => {
  try {
    const user = await getAuthUser(req);
    const { sessionId, couponCode } = req.body;
    const cart = await Cart.findOne({ sessionId });
    if (!cart || cart.items.length === 0) return res.status(400).json({ error: 'Your bag is empty!' });

    const isVip = Boolean(user?.isPremium);
    const subtotal = cart.items.reduce((sum, i) => sum + (isVip ? i.premiumPrice : i.price) * i.quantity, 0);
    let discount = 0;

    if (couponCode) {
      const code = couponCode.toUpperCase();
      const prize = wheelPrizes.find(p => p.code === code);
      if (prize?.discountPercent) discount = Math.round((subtotal * prize.discountPercent) / 100);
      if (prize?.flatDiscount) discount = prize.flatDiscount;
      if (code === 'VIPWELCOME25') discount = Math.round(subtotal * 0.25);
    }

    const order = await Order.create({
      orderId: `FC-${Date.now().toString().slice(-5)}`,
      userEmail: user?.email || 'Guest',
      items: cart.items,
      subtotal,
      discount,
      finalTotal: Math.max(0, subtotal - discount),
      couponUsed: couponCode || 'None'
    });

    await Cart.deleteOne({ sessionId });
    res.status(201).json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
