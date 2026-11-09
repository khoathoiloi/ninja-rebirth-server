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

// --- Helper: Read / Write Database ---
function getDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    return { servers: [], users: [], notifications: [] };
  }
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
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
  
  console.log(`[HTTP ${req.method}] ${pathname}${parsedUrl.search}`);

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

  // Admin API: Get all data
  if (pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(getDb()));
  }

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

  // Admin API: Add User
  if (pathname === '/api/user/add' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    const uid = String(10000 + db.users.length + 1);
    db.users.push({
      uid,
      username: body.username,
      password: body.password || '123456',
      role: body.role || 'user',
      gold: 99999999,
      diamond: 99999999,
      level: 100,
      vip: 15,
      created_at: new Date().toISOString()
    });
    saveDb(db);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, uid }));
  }

  // Admin API: Edit User (GM Command)
  if (pathname === '/api/user/edit' && req.method === 'POST') {
    const body = await parseBody(req);
    const db = getDb();
    const user = db.users.find(u => u.uid === body.uid);
    if (user) {
      if (body.gold !== undefined) user.gold = body.gold;
      if (body.diamond !== undefined) user.diamond = body.diamond;
      if (body.level !== undefined) user.level = body.level;
      if (body.vip !== undefined) user.vip = body.vip;
      saveDb(db);
    }
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
        gold: 10000000,
        diamond: 1000000,
        level: 50,
        vip: 10,
        created_at: new Date().toISOString()
      };
      db.users.push(user);
      saveDb(db);
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
    console.log(`>>> [Game Client] Yêu cầu /auth khác -> Phản hồi thành công`);
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

// ==========================================
// 2. WEBSOCKET RPC GAME SERVER (PORT 9001)
// ==========================================
const wss = new WebSocketServer({ port: WS_PORT });

// Helper: Send WebSocket packet with 4-byte length prefix as a TEXT frame (required by Cocos Netty client)
function sendWsPacket(ws, obj) {
  try {
    const jsonStr = typeof obj === 'string' ? obj : JSON.stringify(obj);
    const jsonLen = Buffer.byteLength(jsonStr, 'utf8');
    // Quan trọng: Client Cocos Netty tính alllen = 4 byte header + độ dài chuỗi json,
    // sau đó gọi buff.substring(4, alllen). Do đó alllen bắt buộc phải là jsonLen + 4!
    const alllen = jsonLen + 4;
    const p1 = (alllen >> 24) & 0xFF;
    const p2 = (alllen >> 16) & 0xFF;
    const p3 = (alllen >> 8) & 0xFF;
    const p4 = alllen & 0xFF;
    const header = String.fromCharCode(p1, p2, p3, p4);
    // Crucial: Must be sent as a TEXT frame (String), NOT a Buffer!
    if (ws.readyState === ws.OPEN) {
      ws.send(header + jsonStr);
    }
  } catch (e) {
    console.error('[WebSocket] Lỗi gửi gói tin:', e.message);
  }
}

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

      if (cmd === 'Login') {
        const params = pkg.params || [];
        const roleId = params[2] || 10001;
        console.log(`>>> [WebSocket] Client Login (UserId: ${params[0] || '10001'}, RoleId: ${roleId}) -> Vào Game!`);
        // Trả về dữ liệu người chơi trực tiếp (không gửi roles để bỏ qua dialog chọn nhân vật và vào thẳng game)
        sendWsPacket(ws, {
          func_name: 'Login',
          data: {
            player_id: roleId,
            user_id: params[0] || '10001',
            team_name: "Admin Naruto",
            team_lv: 100,
            vip_lv: 15,
            gold: 99999999,
            diamond: 99999999,
            power: 999999
          },
          error: 0
        });
      } else if (cmd === 'GetLastGuide') {
        console.log(`>>> [WebSocket] Client yêu cầu GetLastGuide -> Gửi lastGuideId: 100 (Bỏ qua tân thủ)`);
        sendWsPacket(ws, {
          func_name: 'GetLastGuide',
          data: {
            lastGuideId: 100
          },
          error: 0
        });
      } else if (cmd === 'Get') {
        const key = (pkg.params && pkg.params[0]) || '';
        console.log(`>>> [WebSocket] Client yêu cầu Get (${key})`);
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
        console.log(`>>> [WebSocket] Gửi thông tin PlayerInfo...`);
        sendWsPacket(ws, {
          func_name: 'PlayerInfo',
          data: {
            player: {
              id: 10001,
              user_id: 10001,
              user_name: "Admin Naruto",
              platform: "android",
              create_time: Math.floor(Date.now() / 1000),
              last_signin_time: Math.floor(Date.now() / 1000),
              last_signin_ip: "127.0.0.1"
            },
            player_attr: {
              team_name: "Admin Naruto",
              team_lv: 100,
              team_exp: 0,
              vip_lv: 15,
              vip_exp: 0,
              gold: 99999999,
              stone: 99999999,
              sp: 200,
              arena_point: 999999
            }
          },
          error: 0
        });
      } else if (cmd === 'BagInfo') {
        console.log(`>>> [WebSocket] Gửi thông tin BagInfo...`);
        sendWsPacket(ws, {
          func_name: 'BagInfo',
          data: {
            items: {},
            equip: {}
          },
          error: 0
        });
      } else if (cmd === 'GetSecrets') {
        console.log(`>>> [WebSocket] Gửi thông tin GetSecrets...`);
        sendWsPacket(ws, {
          func_name: 'GetSecrets',
          data: {
            secrets: []
          },
          error: 0
        });
      } else if (cmd === 'ChapterInfo') {
        console.log(`>>> [WebSocket] Gửi thông tin ChapterInfo...`);
        sendWsPacket(ws, {
          func_name: 'ChapterInfo',
          data: {
            chapters: {} // Empty object để an toàn, không chứa "1": [] gây lỗi [0].chapter_id
          },
          error: 0
        });
      } else if (cmd === 'GetHeros') {
        console.log(`>>> [WebSocket] Gửi thông tin GetHeros...`);
        sendWsPacket(ws, {
          func_name: 'GetHeros',
          data: {
            heros: {}
          },
          error: 0
        });
      } else if (cmd === 'BeastInfo') {
        console.log(`>>> [WebSocket] Gửi thông tin BeastInfo -> Khởi tạo MainScene...`);
        sendWsPacket(ws, {
          func_name: 'BeastInfo',
          data: {
            Beasts: {}
          },
          error: 0
        });
      } else if (cmd === 'Time') {
        sendWsPacket(ws, {
          func_name: 'Time',
          data: { time: Math.floor(Date.now() / 1000), offset: 28800 },
          error: 0
        });
      } else {
        console.log(`>>> [WebSocket] Xử lý gói tin khác: ${cmd}`);
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
    console.log(`<<< [WebSocket] Client đã ngắt kết nối: ${ip}`);
  });

  ws.on('error', (err) => {
    console.error(`[WebSocket] Lỗi kết nối:`, err.message);
  });
});

console.log(`[WebSocket Server] Cổng RPC đang lắng nghe tại: ws://localhost:${WS_PORT}/rpc\n`);
