const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// --- Logger: Ghi log đồng thời ra console và file server.log ---
const LOG_FILE = path.join(__dirname, 'server.log');
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

function formatLog(prefix, args) {
  const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  return `[${time}] ${prefix ? prefix + ' ' : ''}${text}`;
}

console.log = function(...args) {
  const line = formatLog('', args);
  origLog.apply(console, args);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
};

console.error = function(...args) {
  const line = formatLog('[ERROR]', args);
  origError.apply(console, args);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
};

console.warn = function(...args) {
  const line = formatLog('[WARN]', args);
  origWarn.apply(console, args);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
};

process.on('uncaughtException', (err) => {
  console.error('[CRITICAL UNCAUGHT EXCEPTION]:', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL UNHANDLED REJECTION]:', reason);
});

const HTTP_PORTS = [80, 8080];
const WS_PORT = 9001;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const CATALOG_FILE = path.join(__dirname, 'data', 'catalogs.json');

// --- Helper: Catalogs ---
function getCatalogs() {
  try {
    if (fs.existsSync(CATALOG_FILE)) {
      return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    }
  } catch (e) {}
  return { items: [], heroes: [] };
}

// --- Helper: Read / Write Database ---
function getDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const db = JSON.parse(raw);
    db.servers = db.servers || [];
    db.users = db.users || [];
    db.giftcodes = db.giftcodes || [];
    db.notifications = db.notifications || [];
    return db;
  } catch (err) {
    return { servers: [], users: [], giftcodes: [], notifications: [] };
  }
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Helper: Ensure user has valid player_data structure
function initPlayerData(user) {
  if (!user.player_data) {
    user.player_data = {};
  }
  const pd = user.player_data;
  pd.team_name = pd.team_name || user.nickname || user.username || `Ninja_${user.uid}`;
  pd.level = pd.level || user.level || 100;
  pd.vip = pd.vip !== undefined ? pd.vip : (user.vip !== undefined ? user.vip : 15);
  pd.gold = pd.gold || user.gold || 99999999;
  pd.stone = pd.stone || user.diamond || 99999999;
  pd.sp = pd.sp !== undefined ? pd.sp : 300;
  pd.arena_point = pd.arena_point || 999999;
  pd.used_codes = pd.used_codes || [];

  if (!pd.items || Object.keys(pd.items).length === 0) {
    pd.items = {
      "40010": { id: 40010, count: 9999 },
      "10010": { id: 10010, count: 9999 },
      "10020": { id: 10020, count: 9999 },
      "10030": { id: 10030, count: 9999 },
      "10040": { id: 10040, count: 9999 },
      "10050": { id: 10050, count: 9999 },
      "10100": { id: 10100, count: 9999 },
      "20010": { id: 20010, count: 9999 },
      "30010": { id: 30010, count: 9999 }
    };
  }

  if (!pd.heros || Object.keys(pd.heros).length === 0) {
    pd.heros = {};
    const heroIds = [10010, 10020, 10030, 10040, 10050, 10100];
    heroIds.forEach(id => {
      pd.heros[id] = {
        id: id,
        hero_id: id,
        lv: pd.level,
        exp: 0,
        quality: 1,
        star: 5,
        status: 0,
        has_awake: 1
      };
    });
  }

  return user;
}

// Active WebSocket connections: Map(ws => { uid, user })
const activeSockets = new Map();

// Push packet to active connection
function sendWsPacket(ws, obj) {
  try {
    const jsonStr = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (ws && ws.readyState === 1 /* OPEN */) {
      ws.send(jsonStr);
    }
  } catch (e) {
    console.error('[WebSocket] Lỗi gửi gói tin:', e.message);
  }
}

// Live Push PlayerInfo to client
function pushPlayerInfo(ws, user) {
  if (!ws || !user) return;
  const pd = user.player_data || {};
  sendWsPacket(ws, {
    func_name: 'PlayerInfo',
    data: {
      player: {
        id: parseInt(user.uid),
        user_id: parseInt(user.uid),
        user_name: pd.team_name || user.username,
        platform: "android",
        create_time: Math.floor(new Date(user.created_at || Date.now()).getTime() / 1000),
        last_signin_time: Math.floor(Date.now() / 1000),
        last_signin_ip: "127.0.0.1"
      },
      player_attr: {
        team_name: pd.team_name || user.username,
        team_lv: pd.level || 100,
        team_exp: 0,
        vip_lv: pd.vip !== undefined ? pd.vip : 15,
        vip_exp: 0,
        gold: pd.gold || 0,
        stone: pd.stone || 0,
        sp: pd.sp !== undefined ? pd.sp : 300,
        arena_point: pd.arena_point || 0
      }
    },
    error: 0
  });
}

// Live Push BagInfo to client
function pushBagInfo(ws, user) {
  if (!ws || !user) return;
  const pd = user.player_data || {};
  sendWsPacket(ws, {
    func_name: 'BagInfo',
    data: {
      items: pd.items || {},
      equip: {}
    },
    error: 0
  });
}

// Live Push Heros to client
function pushHeros(ws, user) {
  if (!ws || !user) return;
  const pd = user.player_data || {};
  sendWsPacket(ws, {
    func_name: 'GetHeros',
    data: {
      heros: pd.heros || {}
    },
    error: 0
  });
}

// Push live update to user if online
function broadcastUserUpdate(uid, type = 'all') {
  for (const [ws, u] of activeSockets.entries()) {
    if (u && String(u.uid) === String(uid)) {
      const db = getDb();
      const freshUser = db.users.find(x => String(x.uid) === String(uid));
      if (freshUser) {
        initPlayerData(freshUser);
        activeSockets.set(ws, freshUser);
        if (type === 'all' || type === 'player') pushPlayerInfo(ws, freshUser);
        if (type === 'all' || type === 'bag') pushBagInfo(ws, freshUser);
        if (type === 'all' || type === 'heros') pushHeros(ws, freshUser);
      }
    }
  }
}

// --- Helper: Parse Request Body ---
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        const params = new URLSearchParams(body);
        const obj = {};
        for (const [k, v] of params.entries()) {
          obj[k] = v;
        }
        resolve(obj);
      }
    });
  });
}

// --- Request Handler ---
async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const api = (parsedUrl.searchParams.get('api') || '').toLowerCase();
  const fullRoute = `${pathname}${parsedUrl.search}`.toLowerCase();
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Admin Dashboard UI
  if (pathname === '/' || pathname === '/admin') {
    const htmlPath = path.join(__dirname, 'public', 'admin.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(htmlPath, 'utf8'));
  }

  // Public Online User Registration UI
  if (pathname === '/register' || pathname === '/signup') {
    const htmlPath = path.join(__dirname, 'public', 'register.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(htmlPath, 'utf8'));
    }
  }

  // Admin API: Get all data
  if (pathname === '/api/data') {
    const db = getDb();
    const catalogs = getCatalogs();
    const onlineUids = Array.from(new Set(Array.from(activeSockets.values()).map(u => String(u.uid))));
    const stats = {
      totalUsers: db.users.length,
      totalGiftcodes: (db.giftcodes || []).length,
      totalServers: db.servers.length,
      onlineCount: onlineUids.length,
      onlineUids
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...db, stats, catalogs }));
  }

  // Admin API: Catalogs
  if (pathname === '/api/catalogs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(getCatalogs()));
  }

  // ==========================================
  // USER & GM CONTROL APIS
  // ==========================================

  // Public User Register API
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await parseBody(req);
    const username = (body.username || '').trim();
    const password = (body.password || '').trim();
    const nickname = (body.nickname || body.username || '').trim();

    if (!username || username.length < 3) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, msg: 'Tên tài khoản phải có ít nhất 3 ký tự!' }));
    }
    if (!password || password.length < 3) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, msg: 'Mật khẩu phải có ít nhất 3 ký tự!' }));
    }

    const db = getDb();
    if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, msg: 'Tên tài khoản này đã tồn tại! Vui lòng chọn tên khác.' }));
    }

    const uid = String(10000 + db.users.length + 1);
    const newUser = {
      uid,
      username,
      password,
      role: 'user',
      status: 'active',
      gold: 5000000,
      diamond: 20000,
      level: 50,
      vip: 5,
      created_at: new Date().toISOString(),
      player_data: {
        team_name: nickname || `Ninja_${uid}`,
        level: 50,
        vip: 5,
        gold: 5000000,
        stone: 20000,
        sp: 300,
        arena_point: 5000,
        items: {
          "40010": { id: 40010, count: 100 },
          "10010": { id: 10010, count: 80 },
          "10020": { id: 10020, count: 80 },
          "10030": { id: 10030, count: 80 },
          "20010": { id: 20010, count: 50 },
          "30010": { id: 30010, count: 20 }
        },
        heros: {
          "10010": { id: 10010, hero_id: 10010, lv: 50, exp: 0, quality: 1, star: 4, status: 0, has_awake: 1 },
          "10020": { id: 10020, hero_id: 10020, lv: 50, exp: 0, quality: 1, star: 4, status: 0, has_awake: 1 },
          "10030": { id: 10030, hero_id: 10030, lv: 50, exp: 0, quality: 1, star: 4, status: 0, has_awake: 1 },
          "10040": { id: 10040, hero_id: 10040, lv: 50, exp: 0, quality: 1, star: 4, status: 0, has_awake: 1 }
        },
        used_codes: []
      }
    };

    db.users.push(newUser);
    saveDb(db);
    console.log(`>>> [Đăng Ký Online] Người chơi mới tạo tài khoản thành công: ${username} (UID: ${uid})`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      msg: 'Đăng ký tài khoản thành công! Bạn có thể vào game ngay.',
      uid,
      username
    }));
  }

  // Admin API: Add User manually
  if (pathname === '/api/user/add' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    const uid = String(10000 + db.users.length + 1);
    const newUser = {
      uid,
      username: body.username,
      password: body.password || '123456',
      role: body.role || 'user',
      status: 'active',
      gold: parseInt(body.gold) || 99999999,
      diamond: parseInt(body.diamond) || 99999999,
      level: parseInt(body.level) || 100,
      vip: parseInt(body.vip) || 15,
      created_at: new Date().toISOString()
    };
    initPlayerData(newUser);
    db.users.push(newUser);
    saveDb(db);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, uid }));
  }

  // Admin API: Edit User Stats (GM Command)
  if (pathname === '/api/user/edit' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    const user = db.users.find(u => String(u.uid) === String(body.uid));
    if (user) {
      initPlayerData(user);
      const pd = user.player_data;

      if (body.gold !== undefined) {
        pd.gold = parseInt(body.gold);
        user.gold = pd.gold;
      }
      if (body.diamond !== undefined || body.stone !== undefined) {
        pd.stone = parseInt(body.diamond !== undefined ? body.diamond : body.stone);
        user.diamond = pd.stone;
      }
      if (body.level !== undefined) {
        pd.level = parseInt(body.level);
        user.level = pd.level;
      }
      if (body.vip !== undefined) {
        pd.vip = parseInt(body.vip);
        user.vip = pd.vip;
      }
      if (body.sp !== undefined) {
        pd.sp = parseInt(body.sp);
      }
      if (body.arena_point !== undefined) {
        pd.arena_point = parseInt(body.arena_point);
      }
      if (body.team_name !== undefined && body.team_name.trim()) {
        pd.team_name = body.team_name.trim();
      }

      saveDb(db);
      console.log(`>>> [GM Edit] Cập nhật chỉ số cho UID ${user.uid} (${user.username}): Level ${pd.level}, VIP ${pd.vip}, Gold ${pd.gold}`);
      
      // Real-time live sync to game client!
      broadcastUserUpdate(user.uid, 'player');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // Admin API: Add Item to User Bag
  if (pathname === '/api/user/item/add' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    const user = db.users.find(u => String(u.uid) === String(body.uid));
    if (user) {
      initPlayerData(user);
      const pd = user.player_data;
      pd.items = pd.items || {};
      
      const itemId = String(body.itemId || body.id);
      const count = parseInt(body.count || 1);

      if (itemId) {
        if (!pd.items[itemId]) {
          pd.items[itemId] = { id: parseInt(itemId), count: 0 };
        }
        pd.items[itemId].count += count;
        saveDb(db);
        console.log(`>>> [GM Item] Đã thêm ${count}x Vật phẩm [${itemId}] vào túi của UID ${user.uid} (${user.username})`);
        
        // Live sync Bag to game client!
        broadcastUserUpdate(user.uid, 'bag');
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // Admin API: Add or Upgrade Hero for User
  if (pathname === '/api/user/hero/add' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    const user = db.users.find(u => String(u.uid) === String(body.uid));
    if (user) {
      initPlayerData(user);
      const pd = user.player_data;
      pd.heros = pd.heros || {};
      
      const heroId = String(body.heroId || body.id);
      const lv = parseInt(body.lv || pd.level || 100);
      const star = parseInt(body.star || 5);
      const has_awake = body.has_awake !== undefined ? (body.has_awake ? 1 : 0) : 1;

      if (heroId) {
        pd.heros[heroId] = {
          id: parseInt(heroId),
          hero_id: parseInt(heroId),
          lv: lv,
          exp: 0,
          quality: 1,
          star: star,
          status: 0,
          has_awake: has_awake
        };
        saveDb(db);
        console.log(`>>> [GM Hero] Đã cấp Tướng [${heroId}] (Lv.${lv}, ${star}★, Thức tỉnh: ${has_awake}) cho UID ${user.uid} (${user.username})`);
        
        // Live sync Heroes to game client!
        broadcastUserUpdate(user.uid, 'heros');
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // Admin API: Toggle Ban User
  if (pathname === '/api/user/ban' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    const user = db.users.find(u => String(u.uid) === String(body.uid));
    if (user) {
      user.status = user.status === 'banned' ? 'active' : 'banned';
      saveDb(db);
      console.log(`>>> [GM Ban] Đổi trạng thái UID ${user.uid} thành: ${user.status}`);
      // Disconnect if currently online and banned
      if (user.status === 'banned') {
        for (const [ws, u] of activeSockets.entries()) {
          if (String(u.uid) === String(user.uid)) {
            ws.close();
          }
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, status: user?.status }));
  }

  // Admin API: Delete User
  if (pathname === '/api/user/delete' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    const idx = db.users.findIndex(u => String(u.uid) === String(body.uid));
    if (idx !== -1) {
      db.users.splice(idx, 1);
      saveDb(db);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // ==========================================
  // GIFTCODE MANAGEMENT APIS
  // ==========================================

  // Admin API: Create Giftcode
  if (pathname === '/api/giftcode/create' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    db.giftcodes = db.giftcodes || [];

    const code = (body.code || '').trim().toUpperCase();
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, msg: 'Mã Giftcode không được để trống!' }));
    }

    if (db.giftcodes.some(g => g.code.toUpperCase() === code)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, msg: 'Mã Giftcode này đã tồn tại!' }));
    }

    const items = [];
    if (Array.isArray(body.items)) {
      body.items.forEach(it => {
        const id = parseInt(it.id);
        const count = parseInt(it.count);
        if (id && count > 0) items.push({ id, count });
      });
    }

    const newGiftcode = {
      code,
      rewards: {
        gold: parseInt(body.gold || 0),
        stone: parseInt(body.stone || body.diamond || 0),
        sp: parseInt(body.sp || 0),
        arena_point: parseInt(body.arena_point || 0),
        items: items
      },
      maxUses: parseInt(body.maxUses || 999999),
      usedCount: 0,
      usedUsers: [],
      createdAt: new Date().toISOString(),
      expiresAt: body.expiresAt ? new Date(body.expiresAt).toISOString() : null,
      active: true
    };

    db.giftcodes.unshift(newGiftcode);
    saveDb(db);
    console.log(`>>> [GM Giftcode] Tạo thành công Giftcode mới: ${code}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, giftcode: newGiftcode }));
  }

  // Admin API: Toggle Giftcode Active
  if (pathname === '/api/giftcode/toggle' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    const g = (db.giftcodes || []).find(x => x.code === body.code);
    if (g) {
      g.active = !g.active;
      saveDb(db);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, active: g?.active }));
  }

  // Admin API: Delete Giftcode
  if (pathname === '/api/giftcode/delete' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    const idx = (db.giftcodes || []).findIndex(x => x.code === body.code);
    if (idx !== -1) {
      db.giftcodes.splice(idx, 1);
      saveDb(db);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // ==========================================
  // SERVER MANAGEMENT APIS
  // ==========================================

  // Admin API: Toggle Server Status
  if (pathname === '/api/server/toggle' && req.method === 'POST') {
    const id = parseInt(parsedUrl.searchParams.get('id'));
    const db = getDb();
    const s = db.servers.find(x => x.serverId === id);
    if (s) {
      s.status = s.status === 1 ? 0 : 1;
      saveDb(db);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // Admin API: Add Server
  if (pathname === '/api/server/add' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    const newId = (db.servers.length > 0 ? Math.max(...db.servers.map(s => s.serverId)) : 0) + 1;
    db.servers.push({
      serverId: newId,
      serverName: body.serverName || `S${newId} - Server Mới`,
      serverip: body.serverip || '192.168.0.152',
      serverport: parseInt(body.serverport) || WS_PORT,
      status: 1,
      newer: 1,
      remark: 'Hoạt động'
    });
    saveDb(db);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // ==========================================
  // GAME CLIENT CONFIG & HOTFIX ENDPOINTS
  // ==========================================

  // 1. Client Config Data (Game.initConfigData)
  if (pathname.includes('clientConfigData.json')) {
    console.log('>>> [Game Client] Đang tải clientConfigData.json...');
    const packageMap = {
      "com.fpx.ninja.gp": "quickgame",
      "cct.com.fpx.ninja.gp": "quickgame",
      "com.fpx.ninja": "quickgame",
      "com.huoying.test": "quickgame",
      "com.nr.web": "quickgame",
      "com.nrmr.gp4": "quickgame",
      "com.nrmr.gp4.apk": "quickgame",
      "packageName error": "quickgame",
      "official": "quickgame",
      "quickgame": "quickgame"
    };
    const configData = {
      language_list: ["en", "vn", "zh", "th", "id"],
      package_sdk: packageMap,
      packageNameMap: packageMap,
      costGold: 100,
      playerName: "Admin",
      hotfix_version: "1.0.0.11",
      review: 0,
      version: "1.0.0.11"
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(configData));
  }

  // 2. Project Manifest / Version Manifest
  if (pathname.includes('version.manifest')) {
    console.log('>>> [Game Client] Yêu cầu version.manifest -> Trả về version 1.0.0.11 (ALREADY_UP_TO_DATE)');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      packageUrl: `http://${req.headers.host}/static/hotfix/en/`,
      remoteManifestUrl: `http://${req.headers.host}/static/hotfix/en/project.manifest`,
      remoteVersionUrl: `http://${req.headers.host}/static/hotfix/en/version.manifest`,
      version: "1.0.0.11",
      engineVersion: "Cocos2d-JS v3.16"
    }));
  }

  if (pathname.includes('project.manifest')) {
    console.log('>>> [Game Client] Yêu cầu project.manifest -> Trả về manifest 1.0.0.11');
    const manifestPath = path.join(__dirname, 'data', 'project.manifest');
    if (fs.existsSync(manifestPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(fs.readFileSync(manifestPath, 'utf8'));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      packageUrl: `http://${req.headers.host}/static/hotfix/en/`,
      remoteManifestUrl: `http://${req.headers.host}/static/hotfix/en/project.manifest`,
      remoteVersionUrl: `http://${req.headers.host}/static/hotfix/en/version.manifest`,
      version: "1.0.0.11",
      assets: {},
      searchPaths: []
    }));
  }

  // ==========================================================
  // GAME CLIENT AUTH & GATEWAY ENDPOINTS (Supports /auth?api=...)
  // ==========================================================

  // 3. Check User / SDK Auth (Check_user) -> MUST RETURN ARRAY [userId, sessionKey]!
  if (api === 'check_user' || api.includes('check') || fullRoute.includes('check_user')) {
    console.log('>>> [Game Client] Xác thực Check_user -> Trả về phiên [10001, session_token]');
    const userSession = ["10001", "session_konoha_token_10001"];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(userSession));
  }

  // 4. Notifications (api=get_notifications) -> MUST RETURN [] TO DISMISS LOADING!
  if (api === 'get_notifications' || fullRoute.includes('get_notifications') || api.includes('notification')) {
    console.log('>>> [Game Client] Gửi thông báo rỗng [] -> Đóng cửa sổ load và hiện nút Vào Game');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([]));
  }

  // 5. Get Server List (api=get_server_list or get_server) -> MUST RETURN OBJECT { servers: [...] } !
  if (api === 'get_server_list' || api === 'get_server' || fullRoute.includes('get_server')) {
    console.log('>>> [Game Client] Gửi danh sách Server List { servers: [...] } ...');
    const db = getDb();
    const reqHost = (req.headers.host || '192.168.0.152').split(':')[0];
    const serverHost = (reqHost === 'localhost' || reqHost === '127.0.0.1') ? '192.168.0.152' : reqHost;
    const formattedServers = db.servers.map(s => {
      const host = (s.serverip && s.serverip !== '42.119.167.128') ? s.serverip : serverHost;
      const port = s.serverport || WS_PORT;
      return {
        id: s.serverId,
        serverId: s.serverId,
        name: s.serverName,
        serverName: s.serverName,
        serverip: `${host}:${port}/rpc`,
        serverport: port,
        host: host,
        port: port,
        status: s.status !== undefined ? s.status : 1,
        newer: s.newer || 1,
        hot: 1,
        remark: s.remark || 'Server hoạt động'
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ servers: formattedServers }));
  }

  // 6. Sign In (api=signin)
  if (api === 'signin' || fullRoute.includes('signin')) {
    const body = await parseBody(req);
    const db = getDb();
    let user = db.users.find(u => u.username === (body.username || body.user));
    
    if (!user) {
      const uid = String(10000 + db.users.length + 1);
      user = {
        uid,
        userId: uid,
        username: body.username || body.user || `User_${uid}`,
        password: body.password || '123456',
        role: 'user',
        status: 'active',
        gold: 10000000,
        diamond: 1000000,
        level: 50,
        vip: 10,
        created_at: new Date().toISOString()
      };
      initPlayerData(user);
      db.users.push(user);
      saveDb(db);
    }

    if (user.status === 'banned') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ err_code: 1, msg: 'Tài khoản của bạn đã bị khóa bởi Quản trị viên!' }));
    }

    console.log(`>>> [Game Client] Đăng nhập thành công: ${user.username} (UID: ${user.uid})`);
    const token = 'token_' + Buffer.from(`${user.uid}:${Date.now()}`).toString('base64');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      err_code: 0,
      uid: user.uid,
      userId: user.uid,
      token,
      username: user.username,
      data: user
    }));
  }

  // 7. General /auth fallback
  if (pathname === '/auth') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ err_code: 0, status: 1 }));
  }

  // Default fallback for QHinfo
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`http://${req.headers.host || '192.168.0.152'}`);
}

// Start HTTP Server on both Port 80 and 8080
HTTP_PORTS.forEach(port => {
  const s = http.createServer(handleRequest);
  s.listen(port, () => {
    console.log(`[HTTP Server] Đang lắng nghe tại cổng: ${port}`);
  });
  s.on('error', (err) => {
    console.warn(`[HTTP Server] Không thể mở cổng ${port}: ${err.message}`);
  });
});

console.log(`[Admin Panel] Quản trị GM: http://localhost:8080/admin`);
console.log(`[Public Register] Đăng ký Game: http://localhost:8080/register`);

// ==========================================
// 2. WEBSOCKET RPC GAME SERVER (PORT 9001)
// ==========================================
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`\n>>> [WebSocket] Client vừa kết nối: ${ip}`);

  ws.on('message', (message) => {
    let msgStr = message.toString('utf8');
    // Strip binary/length prefix if sent by client
    if (msgStr.charCodeAt(0) < 32 && msgStr.includes('{')) {
      const braceIdx = msgStr.indexOf('{');
      if (braceIdx > 0) {
        msgStr = msgStr.substring(braceIdx);
      }
    }
    console.log(`[WebSocket] Nhận được gói tin từ Client: ${msgStr}`);

    try {
      const pkg = JSON.parse(msgStr);
      const cmd = pkg.func_name;

      // Helper: get current user for this socket
      let user = activeSockets.get(ws);
      if (!user) {
        const db = getDb();
        user = db.users[0]; // fallback
        initPlayerData(user);
        activeSockets.set(ws, user);
      } else {
        // Refresh with latest data from DB
        const db = getDb();
        const fresh = db.users.find(u => String(u.uid) === String(user.uid));
        if (fresh) {
          user = initPlayerData(fresh);
          activeSockets.set(ws, user);
        }
      }

      const pd = user.player_data || {};

      if (cmd === 'Login') {
        const params = pkg.params || [];
        const requestedUid = String(params[0] || '10001');
        const roleId = params[2] || parseInt(requestedUid);
        
        const db = getDb();
        let matchedUser = db.users.find(u => String(u.uid) === requestedUid || u.username === requestedUid);
        if (!matchedUser) {
          matchedUser = db.users[0];
        }
        initPlayerData(matchedUser);
        activeSockets.set(ws, matchedUser);
        user = matchedUser;
        const currentPd = user.player_data;

        console.log(`>>> [WebSocket] Client Login thành công (User: ${user.username}, UID: ${user.uid}, RoleId: ${roleId})`);

        sendWsPacket(ws, {
          func_name: 'Login',
          data: {
            player_id: roleId,
            user_id: user.uid,
            team_name: currentPd.team_name || user.username,
            team_lv: currentPd.level || 100,
            vip_lv: currentPd.vip !== undefined ? currentPd.vip : 15,
            gold: currentPd.gold || 99999999,
            diamond: currentPd.stone || 99999999,
            power: 999999
          },
          error: 0
        });
      } else if (cmd === 'GetLastGuide') {
        sendWsPacket(ws, {
          func_name: 'GetLastGuide',
          data: {
            lastGuideId: 100
          },
          error: 0
        });
      } else if (cmd === 'Get') {
        sendWsPacket(ws, {
          func_name: 'Get',
          data: {
            value: 1
          },
          error: 0
        });
      } else if (cmd === 'SetLastGuide' || cmd === 'Set') {
        sendWsPacket(ws, {
          func_name: cmd,
          data: {
            success: 1
          },
          error: 0
        });
      } else if (cmd === 'PlayerInfo') {
        console.log(`>>> [WebSocket] Gửi thông tin PlayerInfo cho ${user.username} (UID: ${user.uid})...`);
        pushPlayerInfo(ws, user);
      } else if (cmd === 'BagInfo') {
        console.log(`>>> [WebSocket] Gửi thông tin BagInfo cho ${user.username} (UID: ${user.uid})...`);
        pushBagInfo(ws, user);
      } else if (cmd === 'GetSecrets') {
        sendWsPacket(ws, {
          func_name: 'GetSecrets',
          data: {
            secrets: []
          },
          error: 0
        });
      } else if (cmd === 'ChapterInfo') {
        console.log(`>>> [WebSocket] Gửi thông tin ChapterInfo (Mở khóa Ải thường & Tinh anh)...`);
        const ch1 = [];
        const ch2 = [];
        for (let s = 50001; s <= 50050; s++) {
          ch1.push({ chapter_id: s, star: 3 });
        }
        for (let s = 51001; s <= 51050; s++) {
          ch2.push({ chapter_id: s, star: 3 });
        }
        sendWsPacket(ws, {
          func_name: 'ChapterInfo',
          data: {
            chapters: {
              "1": ch1,
              "2": ch2
            }
          },
          error: 0
        });
      } else if (cmd === 'GetHeros') {
        console.log(`>>> [WebSocket] Gửi thông tin GetHeros cho ${user.username} (UID: ${user.uid})...`);
        pushHeros(ws, user);
      } else if (cmd === 'BeastInfo') {
        sendWsPacket(ws, {
          func_name: 'BeastInfo',
          data: {
            Beasts: {}
          },
          error: 0
        });
      } else if (cmd === 'SpInfo') {
        sendWsPacket(ws, {
          func_name: 'SpInfo',
          data: {
            sp: pd.sp !== undefined ? pd.sp : 300,
            spTime: Math.floor(Date.now() / 1000)
          },
          error: 0
        });
      } else if (cmd === 'ChapterCountInfo') {
        sendWsPacket(ws, {
          func_name: 'ChapterCountInfo',
          data: {
            todayCount: 0,
            resetCount: 0
          },
          error: 0
        });
      } else if (cmd === 'GetChapterPerDayCountMulti') {
        sendWsPacket(ws, {
          func_name: 'GetChapterPerDayCountMulti',
          data: {
            multi: 1
          },
          error: 0
        });
      } else if (cmd === 'HasSepcialChapterOpenInEvent') {
        sendWsPacket(ws, {
          func_name: 'HasSepcialChapterOpenInEvent',
          data: {
            open: 1
          },
          error: 0
        });
      } else if (cmd === 'DailyInfo') {
        sendWsPacket(ws, {
          func_name: 'DailyInfo',
          data: {
            daily: {}
          },
          error: 0
        });
      } else if (cmd === 'GetLvRewardInfo') {
        sendWsPacket(ws, {
          func_name: 'GetLvRewardInfo',
          data: {
            list: []
          },
          error: 0
        });
      } else if (cmd === 'GetAllEvents' || cmd === 'GetAllEventsProcess') {
        sendWsPacket(ws, {
          func_name: cmd,
          data: {
            events: [],
            process: []
          },
          error: 0
        });
      } else if (cmd === 'MessageInfo') {
        sendWsPacket(ws, {
          func_name: 'MessageInfo',
          data: {
            messages: []
          },
          error: 0
        });
      } else if (cmd === 'DailyGet') {
        sendWsPacket(ws, {
          func_name: 'DailyGet',
          data: {
            status: 1
          },
          error: 0
        });
      } else if (cmd === 'GetGroupHires') {
        sendWsPacket(ws, {
          func_name: 'GetGroupHires',
          data: {
            hires: []
          },
          error: 0
        });
      } else if (cmd.startsWith('Before') && cmd.includes('Fight')) {
        console.log(`>>> [WebSocket] Cho phép bắt đầu trận đánh (${cmd})`);
        sendWsPacket(ws, {
          func_name: cmd,
          data: {
            sign: 'battle_sign_' + Date.now(),
            items: []
          },
          error: 0
        });
      } else if (cmd.startsWith('After') && cmd.includes('Fight')) {
        console.log(`>>> [WebSocket] Kết thúc trận đánh (${cmd}) -> Thắng 3 Sao!`);
        // Reward EXP & Gold
        const db = getDb();
        const freshUser = db.users.find(u => String(u.uid) === String(user.uid));
        if (freshUser) {
          initPlayerData(freshUser);
          freshUser.player_data.gold = (freshUser.player_data.gold || 0) + 10000;
          freshUser.gold = freshUser.player_data.gold;
          saveDb(db);
        }
        sendWsPacket(ws, {
          func_name: cmd,
          data: {
            star: 3,
            exp: 1000,
            gold: 10000,
            items: []
          },
          error: 0
        });
      } else if (cmd === 'Time') {
        sendWsPacket(ws, {
          func_name: 'Time',
          data: { time: Math.floor(Date.now() / 1000), offset: 28800 },
          error: 0
        });
      } else if (cmd === 'ServerInfo') {
        sendWsPacket(ws, {
          func_name: 'ServerInfo',
          data: {
            server_time: Math.floor(Date.now() / 1000)
          },
          error: 0
        });
      } else if (cmd === 'BuyBox') {
        // Tavern Gacha draw
        console.log(`>>> [WebSocket] Người chơi ${user.username} mở rương chiêu mộ (BuyBox)`);
        const catalogs = getCatalogs();
        const heroPool = catalogs.heroes && catalogs.heroes.length > 0 ? catalogs.heroes : [
          { id: 10010 }, { id: 10020 }, { id: 10030 }, { id: 10040 }, { id: 10050 }, { id: 10100 }
        ];
        const randomHero = heroPool[Math.floor(Math.random() * heroPool.length)];
        const shardId = randomHero.id;

        // Add to user inventory
        const db = getDb();
        const freshUser = db.users.find(u => String(u.uid) === String(user.uid));
        if (freshUser) {
          initPlayerData(freshUser);
          const uItems = freshUser.player_data.items;
          const sKey = String(shardId);
          if (!uItems[sKey]) uItems[sKey] = { id: shardId, count: 0 };
          uItems[sKey].count += 10;
          saveDb(db);
        }

        sendWsPacket(ws, {
          func_name: 'BuyBox',
          data: {
            items: [
              { type: 1, item_id: shardId, amount: 10 }
            ]
          },
          error: 0
        });
      } else if (cmd === 'UseGiftBagCode') {
        // ==========================================
        // GIFTCODE REDEEM HANDLER
        // ==========================================
        const rawCode = (pkg.params && pkg.params[0] ? pkg.params[0] : '').trim().toUpperCase();
        console.log(`>>> [Giftcode] Người chơi ${user.username} (UID: ${user.uid}) yêu cầu đổi code: "${rawCode}"`);

        const db = getDb();
        const giftcode = (db.giftcodes || []).find(g => g.code.toUpperCase() === rawCode);
        const currentUser = db.users.find(u => String(u.uid) === String(user.uid)) || user;
        initPlayerData(currentUser);

        if (!giftcode) {
          console.warn(`[Giftcode] Code "${rawCode}" không tồn tại!`);
          sendWsPacket(ws, {
            func_name: 'UseGiftBagCode',
            error: 1,
            msg: 'Mã Giftcode không tồn tại trên hệ thống!'
          });
          return;
        }

        if (giftcode.active === false) {
          sendWsPacket(ws, {
            func_name: 'UseGiftBagCode',
            error: 1,
            msg: 'Mã Giftcode này hiện đã bị khóa!'
          });
          return;
        }

        if (giftcode.expiresAt && new Date(giftcode.expiresAt) < new Date()) {
          sendWsPacket(ws, {
            func_name: 'UseGiftBagCode',
            error: 1,
            msg: 'Mã Giftcode này đã hết hạn sử dụng!'
          });
          return;
        }

        if (giftcode.maxUses && giftcode.usedCount >= giftcode.maxUses) {
          sendWsPacket(ws, {
            func_name: 'UseGiftBagCode',
            error: 1,
            msg: 'Mã Giftcode này đã hết lượt sử dụng!'
          });
          return;
        }

        currentUser.player_data.used_codes = currentUser.player_data.used_codes || [];
        if (currentUser.player_data.used_codes.includes(giftcode.code)) {
          sendWsPacket(ws, {
            func_name: 'UseGiftBagCode',
            error: 1,
            msg: 'Bạn đã sử dụng mã Giftcode này rồi!'
          });
          return;
        }

        // Apply Rewards
        const rw = giftcode.rewards || {};
        const rewardItems = [];

        if (rw.gold && rw.gold > 0) {
          currentUser.player_data.gold = (currentUser.player_data.gold || 0) + rw.gold;
          currentUser.gold = currentUser.player_data.gold;
          rewardItems.push({ type: 3, amount: rw.gold });
        }
        if ((rw.stone || rw.diamond) && (rw.stone > 0 || rw.diamond > 0)) {
          const addStone = rw.stone || rw.diamond;
          currentUser.player_data.stone = (currentUser.player_data.stone || 0) + addStone;
          currentUser.diamond = currentUser.player_data.stone;
          rewardItems.push({ type: 4, amount: addStone });
        }
        if (rw.sp && rw.sp > 0) {
          currentUser.player_data.sp = (currentUser.player_data.sp || 0) + rw.sp;
          rewardItems.push({ type: 5, amount: rw.sp });
        }
        if (rw.arena_point && rw.arena_point > 0) {
          currentUser.player_data.arena_point = (currentUser.player_data.arena_point || 0) + rw.arena_point;
          rewardItems.push({ type: 6, amount: rw.arena_point });
        }
        if (rw.items && Array.isArray(rw.items)) {
          currentUser.player_data.items = currentUser.player_data.items || {};
          rw.items.forEach(it => {
            const itemId = String(it.id);
            if (!currentUser.player_data.items[itemId]) {
              currentUser.player_data.items[itemId] = { id: parseInt(itemId), count: 0 };
            }
            currentUser.player_data.items[itemId].count += parseInt(it.count);
            rewardItems.push({ type: 1, item_id: parseInt(itemId), amount: parseInt(it.count) });
          });
        }

        // Save status
        currentUser.player_data.used_codes.push(giftcode.code);
        giftcode.usedCount = (giftcode.usedCount || 0) + 1;
        giftcode.usedUsers = giftcode.usedUsers || [];
        giftcode.usedUsers.push(currentUser.uid);
        saveDb(db);
        activeSockets.set(ws, currentUser);

        console.log(`>>> [Giftcode] Đổi thành công code ${giftcode.code} cho ${currentUser.username}! Phần thưởng:`, rewardItems);

        // Send ExchangeRewardView payload
        sendWsPacket(ws, {
          func_name: 'UseGiftBagCode',
          data: {
            items: rewardItems
          },
          error: 0
        });

        // Push live PlayerInfo and BagInfo so the top bar and inventory immediately update!
        setTimeout(() => {
          pushPlayerInfo(ws, currentUser);
          pushBagInfo(ws, currentUser);
        }, 200);
      } else {
        // Fallback for any other game command
        console.log(`>>> [WebSocket] Gói tin khác: ${cmd}`);
        sendWsPacket(ws, {
          func_name: cmd,
          data: {},
          error: 0
        });
      }
    } catch (e) {
      console.error('[WebSocket] Lỗi xử lý gói tin:', e.message);
    }
  });

  ws.on('close', () => {
    activeSockets.delete(ws);
    console.log(`<<< [WebSocket] Client đã ngắt kết nối: ${ip}`);
  });

  ws.on('error', (err) => {
    activeSockets.delete(ws);
    console.error(`[WebSocket] Lỗi kết nối:`, err.message);
  });
});

console.log(`[WebSocket Server] Cổng RPC đang lắng nghe tại: ws://localhost:${WS_PORT}/rpc\n`);
