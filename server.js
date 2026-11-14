'use strict';

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
let db = null;
class FirebaseSessionStore extends session.Store {
  _ref(sid) { return db.ref(`_lunarSessions/${crypto.createHash('sha256').update(String(sid)).digest('hex')}`); }
  get(sid, callback) {
    if (!db) return callback(new Error('Session database is unavailable.'));
    this._ref(sid).once('value').then(async snap => {
      const record = snap.val();
      if (!record || !record.session || (record.expiresAt && record.expiresAt < Date.now())) {
        if (record) await this._ref(sid).remove();
        return callback(null, null);
      }
      callback(null, record.session);
    }).catch(callback);
  }
  set(sid, sess, callback = () => {}) {
    if (!db) return callback(new Error('Session database is unavailable.'));
    const expiresAt = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7*24*60*60*1000;
    this._ref(sid).set({ session: JSON.parse(JSON.stringify(sess)), expiresAt }).then(() => callback(null)).catch(callback);
  }
  touch(sid, sess, callback = () => {}) { this.set(sid, sess, callback); }
  destroy(sid, callback = () => {}) {
    if (!db) return callback(null);
    this._ref(sid).remove().then(() => callback(null)).catch(callback);
  }
}
app.use(session({
  name: 'lunar.sid',
  secret: process.env.SESSION_SECRET || 'development-only-change-this-session-secret-please',
  store: new FirebaseSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const PORT = Number(process.env.PORT || 10000);
const ROOT = 'nbh';

const DEFAULTS = {
  settings: {
    notice: { text: 'Welcome to LUNAR TOPUP!', color: '#6D28D9' },
    popup: { enabled: true, title: 'LUNAR TOPUP', image: '', text: 'LUNAR TOPUP-এ স্বাগতম। নিরাপদে Diamond top-up করুন।' },
    minAddMoney: 20,
    support: {}, payment: {}, otherSites: [],
    nameCheckApi: '/api/game/lookup',
    aiApi: { enabled: Boolean(process.env.AI_API_KEY) },
    zrPayMethods: ['bKash', 'Nagad', 'Rocket']
  },
  sliders: [], themes: [], categories: [], flashCategories: [], products: [], flashOffers: [],
  users: {}, orders: {}, deposits: {}, codes: {}, adminLogs: {}
};

function firebaseInit() {
  if (admin.apps.length) return;
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.'); }
  } else {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');
  }
  if (serviceAccount.project_id !== 'lunar-topup') {
    throw new Error(`Service account project_id must be lunar-topup (received: ${serviceAccount.project_id || 'missing'}).`);
  }
  if (!process.env.FIREBASE_DATABASE_URL) throw new Error('FIREBASE_DATABASE_URL is required for the lunar-topup project.');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    ...(process.env.FIREBASE_STORAGE_BUCKET ? { storageBucket: process.env.FIREBASE_STORAGE_BUCKET } : {})
  });
  db = admin.database();
}
function now() { return Date.now(); }
function asObj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function values(v) { return Array.isArray(v) ? v.filter(Boolean) : Object.values(asObj(v)); }
function safeUser(u) {
  if (!u) return null;
  const x = { ...u };
  delete x.pass; delete x.passHash; delete x.password; delete x.passwordHash;
  return x;
}
function cleanSettings(s = {}) {
  const out = { ...s };
  if (out.aiApi) out.aiApi = { enabled: Boolean(process.env.AI_API_KEY || out.aiApi.enabled), url: out.aiApi.url || process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions', model: process.env.AI_MODEL || out.aiApi.model || 'gpt-4o-mini' };
  delete out.privateSecrets;
  delete out.zrPayBrandKey;
  delete out.gameskinboApiKey;
  return out;
}
async function readRoot() {
  const snap = await db.ref(ROOT).once('value');
  const val = asObj(snap.val());
  const base = structuredClone(DEFAULTS);
  return { ...base, ...val,
    settings: { ...base.settings, ...asObj(val.settings) },
    users: asObj(val.users), orders: asObj(val.orders), deposits: asObj(val.deposits), codes: asObj(val.codes),
    adminLogs: asObj(val.adminLogs)
  };
}
async function ensureRoot() {
  const s = await db.ref(ROOT).once('value');
  if (!s.exists()) { await db.ref(ROOT).set(DEFAULTS); return; }
  const current = asObj(s.val());
  const patch = {};
  for (const [k,v] of Object.entries(DEFAULTS)) if (current[k] === undefined) patch[k] = v;
  if (Object.keys(patch).length) await db.ref(ROOT).update(patch);
}
function sessionUser(req) { return req.session && req.session.userId ? req.session.userId : null; }
async function requireUser(req, res, next) {
  const id = sessionUser(req);
  if (!id) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  try { const snap=await db.ref(`${ROOT}/users/${id}`).once('value'); const user=snap.val();
    if(!user) { req.session.destroy(()=>{}); return res.status(401).json({error:'LOGIN_REQUIRED'}); }
    if(user.banned) { const reason=user.banReason||'Account disabled by administrator.'; req.session.destroy(()=>{}); return res.status(403).json({error:'ACCOUNT_BANNED',reason}); }
    req.userId=id; next();
  } catch(e) { console.error(e); res.status(503).json({error:'AUTH_CHECK_UNAVAILABLE'}); }
}
function requireAdmin(req, res, next) {
  if (!req.session || req.session.admin !== true) return res.status(401).json({ error: 'ADMIN_LOGIN_REQUIRED' });
  next();
}
function sameOrigin(req, res, next) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'CROSS_ORIGIN_BLOCKED' }); }
    catch { return res.status(403).json({ error: 'INVALID_ORIGIN' }); }
  }
  if (req.get('x-lunar-request') !== '1') return res.status(403).json({ error: 'REQUEST_HEADER_REQUIRED' });
  next();
}
app.use('/api', sameOrigin);
const authLimiter = rateLimit({ windowMs: 15*60*1000, limit: 15, standardHeaders: true, legacyHeaders: false });
const lookupLimiter = rateLimit({ windowMs: 60*1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const paymentLimiter = rateLimit({ windowMs: 60*1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const orderLimiter = rateLimit({ windowMs: 60*1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60*1000, limit: 12, standardHeaders: true, legacyHeaders: false });
const gameLookupCache = new Map();

function encryptionKey() {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) throw new Error('APP_ENCRYPTION_KEY must contain at least 32 characters.');
  return crypto.createHash('sha256').update(raw).digest();
}
function encryptSecret(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}
function decryptSecret(payload) {
  if (!payload || payload.v !== 1) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
}
async function getSecret(name) {
  const snap = await db.ref(`${ROOT}/privateSecrets/${name}`).once('value');
  const v = snap.val();
  try { const stored=decryptSecret(v); if(stored) return stored; } catch { /* use environment fallback */ }
  return name === 'gameskinboApiKey' ? (process.env.GAMESKINBO_API_KEY||'') : name === 'zrPayBrandKey' ? (process.env.ZR_PAY_BRAND_KEY||'') : name === 'aiApiKey' ? (process.env.AI_API_KEY||'') : '';
}
async function saveSecret(name, value) {
  if (!['gameskinboApiKey','zrPayBrandKey','aiApiKey'].includes(name)) throw new Error('Unsupported secret name.');
  if (value) await db.ref(`${ROOT}/privateSecrets/${name}`).set(encryptSecret(value));
  else await db.ref(`${ROOT}/privateSecrets/${name}`).remove();
  if (name === 'gameskinboApiKey') gameLookupCache.clear();
}
function sanitizeAdminRoot(root) {
  const copy = structuredClone(root);
  copy.settings = cleanSettings(copy.settings);
  copy.users = Object.fromEntries(Object.entries(asObj(copy.users)).map(([id,u])=>[id,safeUser(u)]));
  delete copy.privateSecrets;
  return copy;
}
function userState(root, userId) {
  const u = root.users[userId];
  if (!u) return null;
  if (u.banned) return { banned: true, reason: u.banReason || 'Account disabled by administrator.' };
  const ownOrders = Object.fromEntries(Object.entries(root.orders).filter(([,o]) => o && o.user === userId));
  const ownDeposits = Object.fromEntries(Object.entries(root.deposits).filter(([,d]) => d && d.user === userId));
  const ownCodes = Object.fromEntries(Object.entries(root.codes).filter(([,c]) => c && c.user === userId));
  const recent = values(root.orders).filter(o => o && ['pending','completed','rejected'].includes(o.status)).sort((a,b)=>(b.time||0)-(a.time||0)).slice(0,8).map(o => ({
    id: o.id, player: o.player ? `${String(o.player).slice(0,1)}•••` : 'Player', type: o.type || o.cat || 'Topup', cat: o.cat || '', price: Number(o.price)||0, status: o.status, time: o.time
  }));
  return {
    settings: cleanSettings(root.settings), sliders: root.sliders, themes: root.themes, categories: root.categories,
    flashCategories: root.flashCategories, products: root.products, flashOffers: root.flashOffers,
    users: { [userId]: safeUser(u) }, orders: ownOrders, deposits: ownDeposits, codes: ownCodes,
    publicRecentOrders: recent, currentUserId: userId
  };
}
function findByPath(o, p) { const parts=String(p||'').split('.').filter(Boolean); if(!parts.length) return undefined; return parts.reduce((v,k)=>v == null ? undefined : v[k], o); }
function fillTemplate(v, vars) {
  if (Array.isArray(v)) return v.map(x => fillTemplate(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,fillTemplate(x,vars)]));
  if (typeof v === 'string') {
    const exact=v.match(/^\{\{([a-z_]+)\}\}$/i);
    if(exact && Object.prototype.hasOwnProperty.call(vars,exact[1])) return vars[exact[1]];
    return v.replace(/\{\{([a-z_]+)\}\}/gi, (_,k)=>String(vars[k] ?? ''));
  }
  return v;
}
function parseTemplate(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { throw new Error(`${name} must be valid JSON.`); }
}
function findAny(obj, names, maxDepth=4) {
  if (!obj || typeof obj !== 'object' || maxDepth < 0) return undefined;
  for (const [k,v] of Object.entries(obj)) if (names.includes(k.toLowerCase()) && v != null) return v;
  for (const v of Object.values(obj)) { const found = findAny(v, names, maxDepth-1); if (found !== undefined) return found; }
  return undefined;
}
async function callGateway(url, body, brandKey) {
  const header = process.env.ZR_PAY_AUTH_HEADER;
  const prefix = process.env.ZR_PAY_AUTH_PREFIX || '';
  if (!header) throw new Error('ZR_PAY_AUTH_HEADER is not configured from the provider documentation.');
  if (new URL(url).protocol !== 'https:') throw new Error('ZR PAY endpoint must use HTTPS.');
  const h = { 'content-type': 'application/json', 'accept': 'application/json' };
  h[header] = prefix + brandKey;
  const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await r.text(); let data;
  try { data = JSON.parse(text); } catch { throw new Error(`ZR PAY returned non-JSON (${r.status}).`); }
  if (!r.ok) throw new Error(data.message || data.error || `ZR PAY error ${r.status}`);
  return data;
}

// Health
app.get('/health', (_req,res) => res.json({ ok: true, service: 'lunar-topup', time: now() }));
app.get('/api/config', (_req,res) => res.json({ brand: 'LUNAR TOPUP', minAddMoney: 20 }));

// Auth: server-side password hashes and HttpOnly sessions; ban is checked on every request.
app.post('/api/auth/signup', authLimiter, async (req,res) => {
  try {
    const email = String(req.body.email||'').trim().toLowerCase();
    const name = String(req.body.name||'').trim().slice(0,50);
    const password = String(req.body.password||'');
    if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2 || password.length < 8) return res.status(400).json({ error: 'NAME_EMAIL_PASSWORD_INVALID' });
    const root = await readRoot();
    if (values(root.users).some(u => String(u.email||'').toLowerCase() === email)) return res.status(409).json({ error: 'EMAIL_EXISTS' });
    const id = 'LTP' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const user = { id, name, email, passHash: await bcrypt.hash(password, 12), balance: 0, spent: 0, orders: 0, verified: false, pic: '', banned: false, supportPin: String(crypto.randomInt(1000,10000)), created: now() };
    await db.ref(`${ROOT}/users/${id}`).set(user);
    req.session.userId = id;
    req.session.save(err => err ? res.status(500).json({error:'SESSION_CREATE_FAILED'}) : res.json({ ok:true, user:safeUser(user) }));
  } catch(e) { console.error(e); res.status(500).json({error:'SIGNUP_FAILED'}); }
});
app.post('/api/auth/login', authLimiter, async (req,res) => {
  try {
    const email = String(req.body.email||'').trim().toLowerCase(), password = String(req.body.password||'');
    const root = await readRoot();
    const pair = Object.entries(root.users).find(([,u])=>String(u.email||'').toLowerCase()===email);
    if (!pair) return res.status(401).json({error:'INVALID_CREDENTIALS'});
    const [id,u] = pair;
    if (u.banned) return res.status(403).json({error:'ACCOUNT_BANNED', reason:u.banReason||'Account disabled by administrator.'});
    let valid = false;
    if (u.passHash) valid = await bcrypt.compare(password, u.passHash);
    else if (u.pass) {
      const old = crypto.createHash('sha256').update(password).digest('hex');
      valid = String(u.pass).length===64 && crypto.timingSafeEqual(Buffer.from(old), Buffer.from(String(u.pass))); 
      if (valid) { u.passHash = await bcrypt.hash(password,12); delete u.pass; await db.ref(`${ROOT}/users/${id}`).set(u); }
    }
    if (!valid) return res.status(401).json({error:'INVALID_CREDENTIALS'});
    req.session.userId = id;
    req.session.save(err => err ? res.status(500).json({error:'SESSION_CREATE_FAILED'}) : res.json({ok:true,user:safeUser(u)}));
  } catch(e) { console.error(e); res.status(500).json({error:'LOGIN_FAILED'}); }
});
app.post('/api/auth/logout', (req,res)=>req.session.destroy(()=>{res.clearCookie('lunar.sid');res.json({ok:true});}));
app.get('/api/state', async (req,res) => {
  try {
    const root = await readRoot(); const id = sessionUser(req);
    if (id && root.users[id]?.banned) { req.session.destroy(()=>{}); return res.status(403).json({banned:true,reason:root.users[id].banReason||'Account disabled.'}); }
    res.set('Cache-Control','no-store');
    if (id && root.users[id]) return res.json(userState(root,id));
    const recent = values(root.orders).sort((a,b)=>(b.time||0)-(a.time||0)).slice(0,8).map(o=>({id:o.id,player:o.player?`${String(o.player).slice(0,1)}•••`:'Player',type:o.type||o.cat||'Topup',price:Number(o.price)||0,status:o.status,time:o.time}));
    res.json({settings:cleanSettings(root.settings),sliders:root.sliders,themes:root.themes,categories:root.categories,flashCategories:root.flashCategories,products:root.products,flashOffers:root.flashOffers,users:{},orders:{},deposits:{},codes:{},publicRecentOrders:recent,currentUserId:null});
  } catch(e) { console.error(e); res.status(500).json({error:'STATE_LOAD_FAILED'}); }
});

// User profile update
app.post('/api/profile', requireUser, async (req,res) => {
  try {
    const name = String(req.body.name||'').trim().slice(0,50);
    const pic = String(req.body.pic||'');
    if (name.length < 2) return res.status(400).json({error:'NAME_TOO_SHORT'});
    if (pic && (!pic.startsWith('data:image/') || pic.length > 180000)) return res.status(400).json({error:'IMAGE_INVALID_OR_TOO_LARGE'});
    const ref = db.ref(`${ROOT}/users/${req.userId}`);
    const tx = await ref.transaction(u => { if(!u || u.banned) return; u.name=name; u.pic=pic; u.updatedAt=now(); return u; });
    if (!tx.committed) return res.status(403).json({error:'PROFILE_UPDATE_BLOCKED'});
    res.json({ok:true,user:safeUser(tx.snapshot.val())});
  } catch(e) { console.error(e); res.status(500).json({error:'PROFILE_UPDATE_FAILED'}); }
});

// GamesKinbo proxy; API key is never sent to the browser.
app.get('/api/game/lookup', lookupLimiter, async (req,res) => {
  try {
    const uid = String(req.query.uid||'').trim();
    if (!/^\d{5,15}$/.test(uid)) return res.status(400).json({error:'INVALID_UID'});
    const profile=await lookupGamesKinbo(uid);res.json({ok:true,...profile});
  } catch(e) { console.error('GamesKinbo lookup:',e.message); const missing=e.message==='GAMESKINBO_KEY_NOT_CONFIGURED'; res.status(missing?503:502).json({error:missing?'GAMESKINBO_KEY_NOT_CONFIGURED':'PLAYER_LOOKUP_UNAVAILABLE'}); }
});

async function lookupGamesKinbo(uid) {
  const cached=gameLookupCache.get(uid);if(cached&&cached.expires>Date.now())return cached.profile;
  const key = await getSecret('gameskinboApiKey'); if (!key) throw new Error('GAMESKINBO_KEY_NOT_CONFIGURED');
  const url = new URL(process.env.GAMESKINBO_API_URL || 'https://api.gameskinbo.com/ff-info/get');
  if (url.protocol !== 'https:') throw new Error('GamesKinbo endpoint must use HTTPS.');
  url.searchParams.set('uid', uid); if (process.env.GAMESKINBO_REGION) url.searchParams.set('region', process.env.GAMESKINBO_REGION);
  const r = await fetch(url,{headers:{'x-api-key':key,accept:'application/json'},signal:AbortSignal.timeout(12000)});
  const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.error||'PLAYER_LOOKUP_FAILED');
  const info=data.AccountInfo||data.accountInfo||data.data?.AccountInfo||{}; const name=info.AccountName||info.accountName||data.nickname||data.name;
  if(!name) throw new Error('PLAYER_NOT_FOUND');
  const profile={name:String(name),region:String(info.AccountRegion||info.accountRegion||data.region||''),level:info.AccountLevel??info.accountLevel??data.level??null};
  gameLookupCache.set(uid,{profile,expires:Date.now()+60_000});
  if(gameLookupCache.size>200){for(const [k,v] of gameLookupCache)if(v.expires<Date.now())gameLookupCache.delete(k);}
  return profile;
}

// Top-up order: balance and order writes happen in one RTDB transaction.
app.post('/api/orders', requireUser, orderLimiter, async (req,res) => {
  try {
    const { productId, categoryId, uid='', player='', via='wallet' } = req.body || {};
    const rawInfo = asObj(req.body?.accountInfo);
    const accountInfo = Object.fromEntries(Object.entries(rawInfo).filter(([k,v]) => /^[a-zA-Z][a-zA-Z0-9_]{1,30}$/.test(k) && ['string','number','boolean'].includes(typeof v)).slice(0,12).map(([k,v]) => [k,String(v).trim().slice(0,200)]));
    const initialRoot=await readRoot(); const category=[...values(initialRoot.categories),...values(initialRoot.flashCategories)].find(x=>x&&x.id===categoryId);
    if(!category) return res.status(400).json({error:'CATEGORY_NOT_FOUND'});
    let verifiedPlayer='';
    if(category.uidCheck!==false){const playerUid=String(uid||accountInfo?.playerId||accountInfo?.uid||'').trim();if(!/^\d{5,15}$/.test(playerUid))return res.status(400).json({error:'INVALID_UID'});try{const profile=await lookupGamesKinbo(playerUid);verifiedPlayer=profile.name;}catch(lookupError){return res.status(422).json({error:lookupError.message==='GAMESKINBO_KEY_NOT_CONFIGURED'?'GAMESKINBO_KEY_NOT_CONFIGURED':'PLAYER_VERIFICATION_FAILED'});}}
    const rootRef = db.ref(ROOT); const id='OD'+crypto.randomBytes(6).toString('hex').toUpperCase();
    const tx = await rootRef.transaction(root => {
      if (!root || !root.users || !root.users[req.userId]) return;
      const user=root.users[req.userId]; if(user.banned) return;
      const products=[...values(root.products),...values(root.flashOffers)]; const p=products.find(x=>x && x.id===productId && String(x.cat)===String(categoryId) && (!x.end || Number(x.end)>now()));
      if(!p || !p.stock || Number(p.price)<=0) return;
      const cats=[...values(root.categories),...values(root.flashCategories)]; const cat=cats.find(x=>x&&x.id===categoryId);
      if(!cat) return;
      const fields=Array.isArray(cat.accountFields)?cat.accountFields:[];
      for(const f of fields) if(f.required!==false && !String(accountInfo?.[f.key]||'').trim()) return;
      if(cat.uidCheck!==false){const confirmedUid=String(uid||accountInfo?.playerId||accountInfo?.uid||'').trim();if(!/^\d{5,15}$/.test(confirmedUid)||!verifiedPlayer)return;}
      const price=Number(p.price);if(!Number.isFinite(price)||price<=0)return;const balance=Number(user.balance)||0;
      if(balance<price) return;
      root.orders=root.orders||{}; user.balance=balance-price; user.spent=(Number(user.spent)||0)+price; user.orders=(Number(user.orders)||0)+1; user.lastOrder=id;
      root.orders[id]={id,user:req.userId,uid:String(uid||accountInfo?.playerId||accountInfo?.uid||'-').slice(0,40),player:verifiedPlayer||String(player||'').slice(0,50),accountInfo,productId,categoryId,type:p.name,cat:cat.name,price,via,status:'pending',time:now()};
      root.users[req.userId]=user; return root;
    }, undefined, false);
    if(!tx.committed) return res.status(409).json({error:'ORDER_NOT_COMMITTED',message:'Package out of stock, insufficient balance, or account data invalid.'});
    res.json({ok:true,order:tx.snapshot.val().orders[id]});
  } catch(e) { console.error(e); res.status(500).json({error:'ORDER_CREATE_FAILED'}); }
});

// Payment creation. The exact ZR PAY request template must be filled from their merchant API docs.
app.post('/api/payments/create', requireUser, paymentLimiter, async (req,res) => {
  try {
    const amount = Number(req.body.amount);
    const root=await readRoot(); const minAmount=Math.max(1,Number(root.settings.minAddMoney)||20);
    if (!Number.isFinite(amount) || amount < minAmount || amount > 100000) return res.status(400).json({error:'INVALID_AMOUNT',message:`Minimum deposit is ${minAmount} BDT.`});
    const user=root.users[req.userId];
    if(!user || user.banned) return res.status(403).json({error:'ACCOUNT_BLOCKED'});
    const method=String(req.body.method||'').trim();
    const methods=Array.isArray(root.settings.zrPayMethods)?root.settings.zrPayMethods.map(x=>String(x).trim()).filter(Boolean):[];
    if(methods.length && (!method || !methods.includes(method))) return res.status(400).json({error:'PAYMENT_METHOD_INVALID'});
    const brandKey=await getSecret('zrPayBrandKey');
    const template=parseTemplate('ZR_PAY_CREATE_TEMPLATE_JSON');
    if(!brandKey || !template) return res.status(503).json({error:'ZRPAY_SETUP_INCOMPLETE',message:'Set the Brand Key and confirmed ZR PAY create-request JSON template in Render environment variables. No payment request was sent.'});
    const orderId='DP'+crypto.randomBytes(7).toString('hex').toUpperCase();
    const base=`${req.protocol}://${req.get('host')}`;
    const vars={amount:Number(amount.toFixed(2)),amount_text:amount.toFixed(2),order_id:orderId,user_id:req.userId,name:user.name||'',email:user.email||'',phone:String(req.body.phone||''),method,payment_method:method,success_url:`${base}/?payment_order=${orderId}`,cancel_url:`${base}/?payment_cancel=${orderId}`,callback_url:`${base}/api/payments/callback`,brand_key:brandKey};
    const body=fillTemplate(template,vars);
    const data=await callGateway(process.env.ZR_PAY_CREATE_URL||'https://pay.zrpaybd.xyz/api/payment/create',body,brandKey);
    const redirect=findByPath(data,process.env.ZR_PAY_REDIRECT_PATH)||findAny(data,['payment_url','paymenturl','checkout_url','checkouturl','redirect_url','redirecturl','url']);
    const paymentId=findByPath(data,process.env.ZR_PAY_PAYMENT_ID_PATH)||findAny(data,['payment_id','paymentid','invoice_id','invoiceid','id','reference']);
    if(!redirect || !/^https:\/\//i.test(String(redirect))) return res.status(502).json({error:'GATEWAY_RESPONSE_INVALID',message:'ZR PAY response has no configured HTTPS payment URL.'});
    await db.ref(`${ROOT}/deposits/${orderId}`).set({id:orderId,user:req.userId,amount,gateway:'ZR PAY BD',gatewayMethod:method,provider:'zrpay',providerPaymentId:String(paymentId||''),status:'pending',time:now(),redirectUrl:String(redirect)});
    res.json({ok:true,orderId,redirectUrl:String(redirect)});
  } catch(e) { console.error('ZR Pay create:',e.message); res.status(502).json({error:'PAYMENT_CREATE_FAILED',message:e.message}); }
});

// Server-side verify; only a positive status AND exact amount/order reference credits once.
app.get('/api/payments/:orderId/status', requireUser, paymentLimiter, async (req,res) => {
  try {
    const ref=db.ref(`${ROOT}/deposits/${req.params.orderId}`), snap=await ref.once('value'), dep=snap.val();
    if(!dep || dep.user!==req.userId) return res.status(404).json({error:'PAYMENT_NOT_FOUND'});
    if(dep.status==='approved') return res.json({ok:true,status:'approved'});
    const brandKey=await getSecret('zrPayBrandKey'), template=parseTemplate('ZR_PAY_VERIFY_TEMPLATE_JSON');
    if(!brandKey || !template) return res.json({ok:true,status:dep.status,verificationConfigured:false});
    const vars={amount:Number(dep.amount),amount_text:Number(dep.amount).toFixed(2),order_id:dep.id,user_id:dep.user,payment_id:dep.providerPaymentId||'',brand_key:brandKey,name:'',email:''};
    const body=fillTemplate(template,vars);
    const header=process.env.ZR_PAY_AUTH_HEADER;
    if(!header) return res.status(503).json({error:'ZR_PAY_AUTH_HEADER_MISSING'});
    const headers={'content-type':'application/json','accept':'application/json'};headers[header]=(process.env.ZR_PAY_AUTH_PREFIX||'')+brandKey;
    const verifyUrl=process.env.ZR_PAY_VERIFY_URL||'https://pay.zrpaybd.xyz/api/payment/verify';
    if (new URL(verifyUrl).protocol !== 'https:') return res.status(503).json({error:'ZR_PAY_HTTPS_REQUIRED'});
    const method=(process.env.ZR_PAY_VERIFY_METHOD||'POST').toUpperCase();
    const vr=await fetch(verifyUrl,{method,headers, ...(method==='GET'?{ }:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
    const data=await vr.json().catch(()=>({}));
    if(!vr.ok) return res.status(502).json({error:'GATEWAY_VERIFY_FAILED'});
    const status=findByPath(data,process.env.ZR_PAY_STATUS_PATH)||findAny(data,['status','payment_status','paymentstatus']);
    const amountValue=findByPath(data,process.env.ZR_PAY_AMOUNT_PATH)||findAny(data,['amount','paid_amount','paidamount']);
    const transId=findByPath(data,process.env.ZR_PAY_TRANSACTION_ID_PATH)||findAny(data,['transaction_id','transactionid','trxid','reference']);
    const refValue=process.env.ZR_PAY_ORDER_ID_PATH?findByPath(data,process.env.ZR_PAY_ORDER_ID_PATH):findAny(data,['order_id','orderid','merchant_order_id','merchantorderid']);
    const good=String(status||'').toLowerCase()===String(process.env.ZR_PAY_SUCCESS_VALUE||'success').toLowerCase()
      && Number(amountValue)===Number(dep.amount) && String(refValue||'')===String(dep.id) && !!transId;
    if(good){
      const tx=await db.ref(ROOT).transaction(root=>{
        const d=root?.deposits?.[dep.id];const u=root?.users?.[req.userId];
        const txid=String(transId||'').trim().toLowerCase();
        const duplicate=txid&&Object.values(root?.deposits||{}).some(x=>x&&x.id!==dep.id&&x.status==='approved'&&String(x.providerTransactionId||'').trim().toLowerCase()===txid);
        if(!d||d.status!=='pending'||!u||u.banned||!txid||duplicate||Number(amountValue)!==Number(d.amount))return;
        d.status='approved';d.approvedAt=now();d.providerTransactionId=String(transId||'').slice(0,120);u.balance=(Number(u.balance)||0)+Number(d.amount);root.deposits[d.id]=d;root.users[req.userId]=u;return root;
      });
      return res.json({ok:true,status:tx.committed?'approved':'pending'});
    }
    res.json({ok:true,status:dep.status==='pending'?'pending':dep.status});
  } catch(e) { console.error('ZR Pay verify:',e.message); res.status(502).json({error:'PAYMENT_STATUS_UNAVAILABLE'}); }
});

// AI support chat; provider credential remains server-only.
app.post('/api/chat', requireUser, chatLimiter, async (req,res) => {
  try {
    const aiKey=await getSecret('aiApiKey'); if(!aiKey) return res.status(503).json({error:'AI_NOT_CONFIGURED'});
    const root=await readRoot(); const aiCfg=asObj(root.settings.aiApi);
    const messages=Array.isArray(req.body.messages)?req.body.messages.slice(-12):[];
    const safeMessages=messages.filter(m=>m&&['user','assistant'].includes(m.role)&&typeof m.content==='string').map(m=>({role:m.role,content:m.content.slice(0,2500)}));
    const url=aiCfg.url||process.env.AI_API_URL||'https://api.openai.com/v1/chat/completions';
    if (new URL(url).protocol !== 'https:') return res.status(400).json({error:'AI_ENDPOINT_MUST_USE_HTTPS'});
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${aiKey}`},body:JSON.stringify({model:aiCfg.model||process.env.AI_MODEL||'gpt-4o-mini',messages:[{role:'system',content:'You are Lunar Topup support. Help with account, orders, deposits, and service questions. Never request passwords, OTPs, wallet PINs, or full payment credentials. Answer briefly in Bangla or English.'},...safeMessages]}),signal:AbortSignal.timeout(25000)});
    const j=await r.json().catch(()=>({})); if(!r.ok) return res.status(502).json({error:'AI_PROVIDER_ERROR'});
    res.json({ok:true,reply:j.choices?.[0]?.message?.content||j.reply||'দুঃখিত, এখন উত্তর পাওয়া যাচ্ছে না।'});
  } catch(e){console.error(e);res.status(502).json({error:'AI_UNAVAILABLE'});}
});

// Firebase Realtime Database pushes live changes to connected storefront/admin tabs.
function sendEvent(res, payload){res.write(`data: ${JSON.stringify(payload)}\n\n`);}
app.get('/api/events', async(req,res)=>{
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
  const id=sessionUser(req);let closed=false;const emit=async snap=>{if(closed)return;const root=asObj(snap.val());const u=id?root.users?.[id]:null;if(id&&(!u||u.banned)){sendEvent(res,{banned:true,reason:u?.banReason||'Account disabled.'});return;}if(id)sendEvent(res,userState({...structuredClone(DEFAULTS),...root,settings:{...DEFAULTS.settings,...asObj(root.settings)}},id));else{const recent=values(root.orders).sort((a,b)=>(b.time||0)-(a.time||0)).slice(0,8).map(o=>({id:o.id,player:o.player?`${String(o.player).slice(0,1)}•••`:'Player',type:o.type||o.cat||'Topup',price:Number(o.price)||0,status:o.status,time:o.time}));sendEvent(res,{settings:cleanSettings(root.settings),sliders:root.sliders||[],themes:root.themes||[],categories:root.categories||[],flashCategories:root.flashCategories||[],products:root.products||[],flashOffers:root.flashOffers||[],users:{},orders:{},deposits:{},codes:{},publicRecentOrders:recent,currentUserId:null});}};
  const listener=snap=>{emit(snap).catch(()=>{});};db.ref(ROOT).on('value',listener,()=>{});req.on('close',()=>{closed=true;db.ref(ROOT).off('value',listener);});
});

// Admin auth and secured data API
app.post('/api/admin/login', authLimiter, async (req,res)=>{
  const username=String(req.body.username||''), password=String(req.body.password||'');
  const expectedUser=process.env.ADMIN_USERNAME||'admin', expectedPass=process.env.ADMIN_PASSWORD||'';
  if(!expectedPass || expectedPass.length<12) return res.status(503).json({error:'ADMIN_PASSWORD_NOT_CONFIGURED'});
  const inputUser=Buffer.from(username),storedUser=Buffer.from(expectedUser),inputPass=Buffer.from(password),storedPass=Buffer.from(expectedPass);
  const ok=inputUser.length===storedUser.length && inputPass.length===storedPass.length
    && crypto.timingSafeEqual(inputUser,storedUser) && crypto.timingSafeEqual(inputPass,storedPass);
  if(!ok)return res.status(401).json({error:'INVALID_ADMIN_CREDENTIALS'});
  req.session.admin=true;req.session.save(err=>err?res.status(500).json({error:'SESSION_FAILED'}):res.json({ok:true}));
});
app.post('/api/admin/logout', requireAdmin, (req,res)=>req.session.destroy(()=>{res.clearCookie('lunar.sid');res.json({ok:true});}));
app.get('/api/admin/state', requireAdmin, async (_req,res)=>{try{res.set('Cache-Control','no-store');res.json(sanitizeAdminRoot(await readRoot()));}catch(e){console.error(e);res.status(500).json({error:'ADMIN_STATE_FAILED'});}});
app.get('/api/admin/events', requireAdmin, (req,res)=>{
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();let closed=false;
  const listener=snap=>{if(!closed)sendEvent(res,sanitizeAdminRoot({...structuredClone(DEFAULTS),...asObj(snap.val()),settings:{...DEFAULTS.settings,...asObj(snap.val()?.settings)}}));};
  db.ref(ROOT).on('value',listener,()=>{});req.on('close',()=>{closed=true;db.ref(ROOT).off('value',listener);});
});
app.get('/api/admin/db', requireAdmin, async (req,res)=>{
  try { const p=String(req.query.path||'').replace(/^nbh\/?/,''); if(p.includes('privateSecrets'))return res.status(403).json({error:'FORBIDDEN'}); const s=await db.ref(p?`${ROOT}/${p}`:ROOT).once('value');res.json({value:s.val(),exists:s.exists()}); }
  catch(e){res.status(500).json({error:'DB_READ_FAILED'});}
});
function safeAdminPath(input) {
  const p=String(input||'').replace(/^nbh\/?/,'').replace(/^\/+|\/+$/g,'');
  if(!p || p.split('/').some(x=>!x || x==='..') || p.includes('privateSecrets') || p.includes('passHash') || p.endsWith('/pass')) throw new Error('Path not allowed.');
  const allowed=['settings','sliders','themes','categories','flashCategories','products','flashOffers','users','orders','deposits','codes','adminLogs'];
  if(!allowed.some(a=>p===a||p.startsWith(a+'/'))) throw new Error('Path not allowed.');
  return `${ROOT}/${p}`;
}
app.post('/api/admin/db/set', requireAdmin, async(req,res)=>{try{await db.ref(safeAdminPath(req.body.path)).set(req.body.value);res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/admin/db/update', requireAdmin, async(req,res)=>{try{await db.ref(safeAdminPath(req.body.path)).update(req.body.value||{});res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/admin/db/remove', requireAdmin, async(req,res)=>{try{await db.ref(safeAdminPath(req.body.path)).remove();res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/admin/secrets', requireAdmin, async(req,res)=>{
  try {
    const entries=['gameskinboApiKey','zrPayBrandKey'];
    for(const k of [...entries,'aiApiKey']) if(Object.prototype.hasOwnProperty.call(req.body,k)) await saveSecret(k,String(req.body[k]||'').trim());
    if(Object.prototype.hasOwnProperty.call(req.body,'aiApiKey') && req.body.aiApiKey) await db.ref(`${ROOT}/settings/aiApi/enabled`).set(true);
    res.json({ok:true,status:await secretStatus()});
  } catch(e){console.error(e);res.status(400).json({error:e.message});}
});
async function secretStatus(){const a=await getSecret('gameskinboApiKey'),b=await getSecret('zrPayBrandKey'),c=await getSecret('aiApiKey');return {gameskinbo:!!a,zrpay:!!b,ai:!!c};}
app.get('/api/admin/secret-status', requireAdmin, async(_req,res)=>{try{res.json(await secretStatus());}catch(e){res.status(500).json({error:'SECRET_STATUS_FAILED'});}});
app.post('/api/admin/user-action', requireAdmin, async(req,res)=>{
  try {
    const {action,userId,reason='',delta,name,pic}=req.body||{}; if(!userId) return res.status(400).json({error:'USER_ID_REQUIRED'});
    const tx=await db.ref(ROOT).transaction(root=>{
      const u=root?.users?.[userId];if(!u)return;
      root.adminLogs=root.adminLogs||{};const logId='LG'+crypto.randomBytes(5).toString('hex');
      if(action==='ban'){u.banned=true;u.bannedAt=now();u.banReason=String(reason||'Policy violation').slice(0,250);}
      else if(action==='unban'){u.banned=false;u.bannedAt=null;u.banReason='';}
      else if(action==='balance'){const d=Number(delta),n=(Number(u.balance)||0)+d;if(!Number.isFinite(d)||d===0||n<0)return;u.balance=n;root.adminLogs[logId]={id:logId,type:'balance_adjustment',user:userId,delta:d,reason:String(reason).slice(0,250),time:now()};}
      else if(action==='profile'){if(name && String(name).trim().length>=2)u.name=String(name).trim().slice(0,50);if(typeof pic==='string' && (!pic || /^https:\/\//i.test(pic)))u.pic=String(pic).slice(0,2048);}
      else return;
      root.users[userId]=u;root.adminLogs[logId]=root.adminLogs[logId]||{id:logId,type:action,user:userId,reason:String(reason).slice(0,250),time:now()};return root;
    });
    if(!tx.committed)return res.status(409).json({error:'ACTION_NOT_COMMITTED'});
    res.json({ok:true,user:safeUser(tx.snapshot.val().users[userId])});
  }catch(e){console.error(e);res.status(500).json({error:'USER_ACTION_FAILED'});}
});
app.post('/api/admin/deposit-action', requireAdmin, async(req,res)=>{
  try {
    const {id,action,reason=''}=req.body||{};
    const tx=await db.ref(ROOT).transaction(root=>{
      const d=root?.deposits?.[id];if(!d||d.status!=='pending')return;
      const u=root.users?.[d.user];if(!u)return;
      if(action==='approve'){
        const txid=String(d.providerTransactionId||d.trx||'').trim().toLowerCase();
        const duplicate=txid&&Object.values(root.deposits||{}).some(x=>x&&x.id!==id&&x.status==='approved'&&String(x.providerTransactionId||x.trx||'').trim().toLowerCase()===txid);if(duplicate)return;
        d.status='approved';d.approvedAt=now();u.balance=(Number(u.balance)||0)+Number(d.amount||0);
      } else if(action==='reject'){d.status='rejected';d.rejectedAt=now();d.rejectReason=String(reason).slice(0,250);} else return;
      root.deposits[id]=d;root.users[d.user]=u;root.adminLogs=root.adminLogs||{};const logId='LG'+crypto.randomBytes(5).toString('hex');root.adminLogs[logId]={id:logId,type:'deposit_'+action,user:d.user,deposit:id,amount:Number(d.amount)||0,reason:String(reason).slice(0,250),time:now()};return root;
    });
    res.status(tx.committed?200:409).json({ok:tx.committed});
  }catch(e){console.error(e);res.status(500).json({error:'DEPOSIT_ACTION_FAILED'});}
});
app.post('/api/admin/order-action', requireAdmin, async(req,res)=>{
  try {
    const {id,action}=req.body||{};
    const tx=await db.ref(ROOT).transaction(root=>{
      const o=root?.orders?.[id];if(!o||o.status!=='pending')return;
      if(action==='complete'){o.status='completed';o.completedAt=now();}
      else if(action==='reject'){const u=root.users?.[o.user];if(!u)return;o.status='rejected';o.rejectedAt=now();if(!o.refundedAt){u.balance=(Number(u.balance)||0)+Number(o.price||0);o.refundedAt=now();root.users[o.user]=u;}}
      else return;
      root.orders[id]=o;root.adminLogs=root.adminLogs||{};const logId='LG'+crypto.randomBytes(5).toString('hex');root.adminLogs[logId]={id:logId,type:'order_'+action,user:o.user,order:id,amount:Number(o.price)||0,time:now()};return root;
    });
    res.status(tx.committed?200:409).json({ok:tx.committed});
  }catch(e){console.error(e);res.status(500).json({error:'ORDER_ACTION_FAILED'});}
});

// Provider notifications are acknowledged but never credit a wallet by themselves.
// The authenticated customer return calls /api/payments/:orderId/status for server-to-server verification.
app.post('/api/payments/callback', (req,res)=>{res.status(200).json({received:true,verification:'server-side verification is performed on the customer return'});});

// Payment return: the browser then asks the authenticated status endpoint to verify with ZR PAY.
app.get('/payment/return', (req,res)=>res.redirect('/?payment_order='+encodeURIComponent(String(req.query.order_id||req.query.orderId||''))));
app.use(express.static(path.join(__dirname,'public'), { etag:true, maxAge: process.env.NODE_ENV==='production'?'1h':0 }));
app.get('/admin', (_req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('*', (req,res)=>{ if(req.path.startsWith('/api/')) return res.status(404).json({error:'NOT_FOUND'}); res.sendFile(path.join(__dirname,'public','index.html')); });

async function start() {
  if(process.env.NODE_ENV==='production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length<32 || !process.env.APP_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY.length<32)) throw new Error('Set SESSION_SECRET and APP_ENCRYPTION_KEY (each at least 32 characters).');
  firebaseInit(); await ensureRoot();
  app.listen(PORT, '0.0.0.0', ()=>console.log(`LUNAR TOPUP listening on ${PORT}`));
}
start().catch(e=>{console.error('Startup failed:',e.message);process.exit(1);});
