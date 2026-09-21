/* ============================================================
   꼬꼬 아레나 — 서버
   Node.js + Express + Socket.io
   Glitch 에 그대로 올려서 쓰는 권위형(서버 판정) 멀티플레이 서버
   ============================================================ */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/* ============================== 상수 ============================== */
const MAP_R      = 152;   // 맵 반경 (고정)
const ZONE_R     = 9;     // 오로라 반경
const BASE_SPEED = 3.8;   // m/s — 클라이언트와 반드시 같아야 함
const TICK_HZ    = 15;    // 상태 브로드캐스트 주기
const SWING_CD   = 1100;  // 휘두르기 쿨다운 (ms)
const SWING_RANGE= 3.0;   // 사람 타격 거리
const HEN_RANGE  = 3.2;   // 닭 타격 거리
const SHIELD_MS  = 3000;  // 퀴즈 종료 후 무적
const QUIZ_CD    = 2200;  // 다음 문제까지 쿨다운
const MAX_SPEED_FACTOR = 3.2; // 치트 방지용 여유 배수

const DEFAULT_CFG = {
  round: 240,     // 라운드 시간(초)
  gap: 45,        // 오로라 간격(초)
  window: 30,     // 오로라 유지(초)
  limit: 5,       // 한 문제 제한(초)
  seekers: 2,     // 술래 수
  npc: 30,        // NPC 수
  hens: 12,       // 돌아다니는 닭
  speed: 1,       // 이동 속도 배수
  jiggle: 1.1,    // 흐물 강도
  tod: 'day'      // 낮/노을/밤
};

const NICKS = ['치킨무','삐약이','깃털도둑','푸드덕','홰치기','촉촉이','꼬끼오','병아리대장',
  '달걀후라이','양념반','닭강정','알품은','벼슬부자','찰흙맨','물렁이','젤리발','흐물흐물','계산왕'];

/* ============================== 문제 ============================== */
function ri(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function makeQuestion() {
  const k = ri(0, 3);
  let a, b, ans, txt, type;
  if (k === 0)      { a = ri(13, 89); b = ri(6, 59);  ans = a + b; txt = a + ' + ' + b; type = '덧셈'; }
  else if (k === 1) { a = ri(31, 99); b = ri(6, a - 5); ans = a - b; txt = a + ' − ' + b; type = '뺄셈'; }
  else if (k === 2) { a = ri(3, 9);   b = ri(3, 9);   ans = a * b; txt = a + ' × ' + b; type = '곱셈'; }
  else              { b = ri(2, 9);   ans = ri(2, 9); a = b * ans; txt = a + ' ÷ ' + b; type = '나눗셈'; }

  const set = [ans];
  let guard = 0;
  while (set.length < 4 && guard++ < 80) {
    const span = (k === 2 || k === 3) ? 6 : 9;
    const v = ans + ri(1, span) * (Math.random() < 0.5 ? -1 : 1);
    if (v > 0 && set.indexOf(v) < 0) set.push(v);
  }
  while (set.length < 4) set.push(ans + set.length * 11);

  // 보기 섞기
  const order = set.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const choices = order.map(i => String(set[i]));
  return { text: txt + ' = ?', choices, ansIdx: order.indexOf(0), type };
}

/* ============================== 방 ============================== */
const rooms = new Map();

function makeRoom(code) {
  const room = {
    code,
    seed: Math.floor(Math.random() * 1e9),   // 모든 클라이언트가 같은 지형을 그리도록
    players: new Map(),
    npcs: [],
    hens: [],
    hostId: null,
    phase: 'lobby',                          // lobby | play | over
    cfg: Object.assign({}, DEFAULT_CFG),
    timeLeft: DEFAULT_CFG.round,
    aurOpen: false,
    aurT: 0,
    lastTick: Date.now(),
    timer: null
  };
  rooms.set(code, room);
  room.timer = setInterval(() => tick(room), 1000 / TICK_HZ);
  return room;
}
function getRoom(code) {
  const key = String(code || 'main').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16) || 'main';
  return rooms.get(key) || makeRoom(key);
}
function dropRoomIfEmpty(room) {
  if (room.players.size > 0) return;
  clearInterval(room.timer);
  rooms.delete(room.code);
}

function spreadPos() {
  const t = Math.random() * Math.PI * 2;
  const r = MAP_R * Math.sqrt(Math.random()) * 0.96;
  return { x: Math.cos(t) * r, z: Math.sin(t) * r };
}
function newWanderTarget() {
  const t = Math.random() * Math.PI * 2;
  const r = Math.random() * MAP_R * 0.85;
  return { tx: Math.cos(t) * r, tz: Math.sin(t) * r, wait: 0.6 + Math.random() * 3.2 };
}

function spawnCrowd(room) {
  room.npcs = [];
  for (let i = 0; i < room.cfg.npc; i++) {
    const p = spreadPos();
    room.npcs.push(Object.assign({
      id: 'n' + i, x: p.x, z: p.z, ry: Math.random() * 6.28, mv: 0,
      aurWilling: Math.random() < 0.3, goAur: false, dead: false
    }, newWanderTarget()));
  }
  room.hens = [];
  for (let i = 0; i < room.cfg.hens; i++) {
    const p = spreadPos();
    room.hens.push(Object.assign({
      id: 'h' + i, x: p.x, y: 0, z: p.z, ry: 0, fly: null
    }, newWanderTarget()));
  }
}

/* ============================== 라운드 ============================== */
function startRound(room) {
  room.phase = 'play';
  room.seed = Math.floor(Math.random() * 1e9);
  room.timeLeft = room.cfg.round;
  room.aurOpen = false;
  room.aurT = Math.min(8, room.cfg.gap);

  spawnCrowd(room);

  // 술래를 무작위로 뽑는다 — 술래끼리도 서로 모른다
  const ids = Array.from(room.players.keys());
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const nSeek = Math.max(1, Math.min(room.cfg.seekers, Math.max(1, ids.length - 1)));

  ids.forEach((id, idx) => {
    const p = room.players.get(id);
    const pos = spreadPos();
    p.x = pos.x; p.z = pos.z; p.ry = Math.atan2(-p.x, -p.z); p.mv = 0;
    p.alive = true;
    p.seeker = ids.length > 1 ? idx < nSeek : false;
    p.score = 0;
    p.asked = 0;
    p.wrong = {};
    p.shieldUntil = 0;
    p.quiz = null;
    p.quizCoolUntil = 0;
    p.exposedUntil = 0;
    p.swingUntil = 0;
    p.survived = 0;
  });

  io.to(room.code).emit('roundStart', {
    seed: room.seed,
    cfg: room.cfg,
    timeLeft: room.timeLeft
  });
  // 역할은 본인에게만
  room.players.forEach(p => {
    io.to(p.id).emit('role', { seeker: p.seeker });
  });
  sendRoster(room);
}

function endRound(room, reason) {
  if (room.phase !== 'play') return;
  room.phase = 'over';
  room.aurOpen = false;
  const scores = [];
  room.players.forEach(p => {
    if (p.quiz) { p.quiz = null; }
    const eras = Object.keys(p.wrong || {}).sort((a, b) => p.wrong[b] - p.wrong[a]);
    scores.push({
      id: p.id, name: p.name, score: p.score, alive: p.alive,
      seeker: p.seeker, asked: p.asked, weak: eras.slice(0, 2).map(k => k + ' ' + p.wrong[k] + '회')
    });
  });
  scores.sort((a, b) => b.score - a.score);
  io.to(room.code).emit('roundEnd', { reason, scores });
  sendRoster(room);
}

function sendRoster(room) {
  const list = [];
  room.players.forEach(p => list.push({
    id: p.id, name: p.name, alive: p.alive, score: p.score,
    host: p.id === room.hostId, seeker: p.seeker
  }));
  io.to(room.code).emit('roster', {
    phase: room.phase, hostId: room.hostId, list,
    cfg: room.cfg
  });
}

/* ============================== 틱 ============================== */
function tick(room) {
  const now = Date.now();
  const dt = Math.min(0.2, (now - room.lastTick) / 1000);
  room.lastTick = now;

  if (room.phase === 'play') {
    room.timeLeft -= dt;

    /* 오로라 개폐 */
    room.aurT -= dt;
    if (room.aurT <= 0) {
      room.aurOpen = !room.aurOpen;
      room.aurT = room.aurOpen ? room.cfg.window : room.cfg.gap;
      io.to(room.code).emit('aurora', { open: room.aurOpen, t: room.aurT });
      if (!room.aurOpen) {
        // 닫히는 순간 모두 3초 무적 — 몰려 있던 술래에게 몰살당하지 않게
        room.players.forEach(p => {
          if (!p.alive) return;
          p.shieldUntil = Math.max(p.shieldUntil, now + SHIELD_MS);
          if (p.quiz) { closeQuiz(room, p, 'closed'); }
        });
      }
    }

    /* 퀴즈 발급 / 시간 초과 */
    room.players.forEach(p => {
      if (!p.alive) return;
      p.survived = room.cfg.round - room.timeLeft;
      const inZone = room.aurOpen && Math.hypot(p.x, p.z) < ZONE_R;
      if (p.quiz) {
        if (now > p.quiz.until) closeQuiz(room, p, 'timeout');
        else if (!inZone) closeQuiz(room, p, 'left');
      } else if (inZone && now > p.quizCoolUntil) {
        const q = makeQuestion();
        p.quiz = { q, until: now + room.cfg.limit * 1000, id: 'q' + now + Math.random().toString(36).slice(2, 6) };
        p.asked++;
        io.to(p.id).emit('quiz', {
          id: p.quiz.id, text: q.text, choices: q.choices, type: q.type, limit: room.cfg.limit
        });
      }
    });

    /* NPC 군중 */
    const npcSpeed = BASE_SPEED * room.cfg.speed;
    for (const n of room.npcs) {
      if (room.aurOpen && n.aurWilling && !n.goAur && Math.random() < dt * 0.12) n.goAur = true;
      if (!room.aurOpen) n.goAur = false;
      let tx, tz;
      if (n.goAur) {
        const a = (parseInt(n.id.slice(1), 10) % 16) / 16 * Math.PI * 2;
        tx = Math.cos(a) * ZONE_R * 0.6; tz = Math.sin(a) * ZONE_R * 0.6;
      } else {
        n.wait -= dt;
        if (n.wait <= 0 || Math.hypot(n.tx - n.x, n.tz - n.z) < 1.5) Object.assign(n, newWanderTarget());
        tx = n.tx; tz = n.tz;
      }
      const dx = tx - n.x, dz = tz - n.z, d = Math.hypot(dx, dz);
      if (d > 0.5) {
        const sp = (n.goAur ? npcSpeed * 0.95 : npcSpeed * 0.55) * dt;
        n.x += dx / d * sp; n.z += dz / d * sp;
        n.ry = Math.atan2(dx, dz);
        n.mv = n.goAur ? 0.85 : 0.5;
      } else n.mv = 0;
    }

    /* 닭 */
    for (const h of room.hens) {
      if (h.fly) {
        h.fly.vy -= 24 * dt;
        h.x += h.fly.vx * dt; h.y += h.fly.vy * dt; h.z += h.fly.vz * dt;
        const rr = Math.hypot(h.x, h.z);
        if (rr > MAP_R) { h.x *= MAP_R / rr; h.z *= MAP_R / rr; h.fly.vx *= -0.4; h.fly.vz *= -0.4; }
        if (h.y <= 0) {
          h.y = 0; h.fly.vy *= -0.42; h.fly.vx *= 0.55; h.fly.vz *= 0.55;
          if (Math.abs(h.fly.vy) < 1.6) { h.fly = null; Object.assign(h, newWanderTarget()); }
        }
      } else {
        h.wait -= dt;
        if (h.wait <= 0 || Math.hypot(h.tx - h.x, h.tz - h.z) < 1) Object.assign(h, newWanderTarget());
        const dx = h.tx - h.x, dz = h.tz - h.z, d = Math.hypot(dx, dz);
        if (d > 0.4) { const sp = 1.5 * dt; h.x += dx / d * sp; h.z += dz / d * sp; h.ry = Math.atan2(dx, dz); }
      }
    }

    /* 종료 조건 */
    let aliveHider = 0, aliveSeeker = 0;
    room.players.forEach(p => { if (p.alive) { if (p.seeker) aliveSeeker++; else aliveHider++; } });
    if (room.timeLeft <= 0) endRound(room, 'time');
    else if (room.players.size > 1 && aliveHider === 0) endRound(room, 'seekers');
    else if (room.players.size > 1 && aliveSeeker === 0) endRound(room, 'hiders');
  }

  /* 상태 브로드캐스트 — 좌표는 소수점 2자리로 줄여 보낸다 */
  const P = [];
  room.players.forEach(p => {
    P.push([p.id, r2(p.x), r2(p.z), r2(p.ry), p.mv ? 1 : 0,
            p.alive ? 1 : 0, p.shieldUntil > now ? 1 : 0, p.exposedUntil > now ? 1 : 0]);
  });
  const N = room.npcs.map(n => [n.id, r2(n.x), r2(n.z), r2(n.ry), n.mv ? 1 : 0]);
  const H = room.hens.map(h => [h.id, r2(h.x), r2(h.y), r2(h.z), r2(h.ry), h.fly ? 1 : 0]);

  io.to(room.code).emit('state', {
    t: now, phase: room.phase,
    timeLeft: Math.max(0, room.timeLeft),
    aurOpen: room.aurOpen, aurT: Math.max(0, room.aurT),
    P, N, H
  });
}
function r2(v) { return Math.round(v * 100) / 100; }

function closeQuiz(room, p, how) {
  if (!p.quiz) return;
  const q = p.quiz.q;
  if (how === 'timeout') {
    p.wrong[q.type] = (p.wrong[q.type] || 0) + 1;
    io.to(p.id).emit('quizResult', { ok: false, timeout: true, correctIdx: q.ansIdx, score: p.score });
    p.shieldUntil = Math.max(p.shieldUntil, Date.now() + SHIELD_MS);
    p.quizCoolUntil = Date.now() + QUIZ_CD;
  } else if (how === 'left') {
    io.to(p.id).emit('quizResult', { ok: false, left: true, correctIdx: q.ansIdx, score: p.score });
  } else if (how === 'closed') {
    io.to(p.id).emit('quizResult', { ok: false, left: true, correctIdx: q.ansIdx, score: p.score });
  }
  p.quiz = null;
}

/* ============================== 소켓 ============================== */
io.on('connection', socket => {
  let room = null;
  let me = null;

  socket.on('join', data => {
    data = data || {};
    room = getRoom(data.room);
    socket.join(room.code);
    const name = String(data.name || '').trim().slice(0, 10) ||
                 NICKS[Math.floor(Math.random() * NICKS.length)];
    const pos = spreadPos();
    me = {
      id: socket.id, name,
      x: pos.x, z: pos.z, ry: 0, mv: 0,
      alive: room.phase !== 'play',   // 진행 중 난입은 관전으로 시작
      seeker: false, score: 0, asked: 0, wrong: {},
      shieldUntil: 0, quizCoolUntil: 0, exposedUntil: 0, swingUntil: 0,
      quiz: null, survived: 0, lastMove: Date.now()
    };
    room.players.set(socket.id, me);
    if (!room.hostId) room.hostId = socket.id;

    socket.emit('welcome', {
      you: socket.id, room: room.code, seed: room.seed, cfg: room.cfg,
      phase: room.phase, host: room.hostId === socket.id,
      mapR: MAP_R, zoneR: ZONE_R, baseSpeed: BASE_SPEED,
      joinedMidRound: room.phase === 'play'
    });
    sendRoster(room);
  });

  socket.on('move', d => {
    if (!room || !me || !me.alive) return;
    const now = Date.now();
    const dt = Math.max(0.016, Math.min(0.5, (now - me.lastMove) / 1000));
    me.lastMove = now;
    const maxStep = BASE_SPEED * room.cfg.speed * MAX_SPEED_FACTOR * dt;
    const nx = Number(d.x), nz = Number(d.z);
    if (!isFinite(nx) || !isFinite(nz)) return;
    // 과도한 순간이동은 잘라낸다
    const dx = nx - me.x, dz = nz - me.z, dist = Math.hypot(dx, dz);
    if (dist > maxStep) { me.x += dx / dist * maxStep; me.z += dz / dist * maxStep; }
    else { me.x = nx; me.z = nz; }
    const rr = Math.hypot(me.x, me.z);
    if (rr > MAP_R) { me.x *= MAP_R / rr; me.z *= MAP_R / rr; }
    me.ry = Number(d.ry) || 0;
    me.mv = d.mv ? 1 : 0;
  });

  socket.on('answer', d => {
    if (!room || !me || !me.quiz) return;
    if (!d || d.id !== me.quiz.id) return;
    const q = me.quiz.q;
    const ok = Number(d.idx) === q.ansIdx;
    const now = Date.now();
    if (ok) me.score += 1;
    else me.wrong[q.type] = (me.wrong[q.type] || 0) + 1;
    me.quiz = null;
    me.shieldUntil = Math.max(me.shieldUntil, now + SHIELD_MS);
    me.quizCoolUntil = now + QUIZ_CD;
    socket.emit('quizResult', {
      ok, correctIdx: q.ansIdx, score: me.score,
      joker: ok ? pickJoker() : null, shield: SHIELD_MS
    });
    sendRoster(room);
  });

  socket.on('swing', () => {
    if (!room || !me || !me.alive || room.phase !== 'play') return;
    const now = Date.now();
    if (now < me.swingUntil) return;
    me.swingUntil = now + SWING_CD;
    io.to(room.code).emit('swing', { id: me.id });

    const fx = Math.sin(me.ry), fz = Math.cos(me.ry);
    // 1) 사람
    let target = null, best = 99;
    room.players.forEach(p => {
      if (p.id === me.id || !p.alive) return;
      const dx = p.x - me.x, dz = p.z - me.z, d = Math.hypot(dx, dz);
      if (d > SWING_RANGE) return;
      if ((dx * fx + dz * fz) / (d || 1) < 0.3) return;
      if (d < best) { best = d; target = p; }
    });
    if (target) {
      if (target.shieldUntil > now) {
        socket.emit('feed', { kind: 'bad', text: target.name + ' 는 무적 상태였다' });
        return;
      }
      target.alive = false;
      target.quiz = null;
      target.survived = room.cfg.round - room.timeLeft;
      let text;
      if (target.seeker && !me.seeker)      { me.score += 3; text = me.name + ' 가 술래 ' + target.name + ' 를 잡았다!'; }
      else if (me.seeker)                   { me.score += 2; text = target.name + ' 가 당했다'; }
      else                                  { me.score = Math.max(0, me.score - 2); text = me.name + ' 가 무고한 ' + target.name + ' 를 쳤다…'; }
      io.to(room.code).emit('kill', {
        byId: me.id, byName: me.name, victimId: target.id, victimName: target.name,
        victimSeeker: target.seeker, text
      });
      io.to(target.id).emit('youDied', { byName: me.name });
      sendRoster(room);
      return;
    }
    // 2) NPC (벌점)
    let npc = null; best = 99;
    for (const n of room.npcs) {
      const dx = n.x - me.x, dz = n.z - me.z, d = Math.hypot(dx, dz);
      if (d > SWING_RANGE) continue;
      if ((dx * fx + dz * fz) / (d || 1) < 0.3) continue;
      if (d < best) { best = d; npc = n; }
    }
    if (npc) {
      me.score = Math.max(0, me.score - 1);
      me.exposedUntil = now + 3000;
      socket.emit('feed', { kind: 'bad', text: 'NPC였다! 3초간 위치가 드러난다' });
      sendRoster(room);
      return;
    }
    // 3) 닭 — 날려보낸다
    let hen = null; best = 99;
    for (const h of room.hens) {
      const dx = h.x - me.x, dz = h.z - me.z, d = Math.hypot(dx, dz);
      if (d > HEN_RANGE) continue;
      if ((dx * fx + dz * fz) / (d || 1) < 0.2) continue;
      if (d < best) { best = d; hen = h; }
    }
    if (hen) {
      hen.fly = {
        vx: fx * 16 + (Math.random() - 0.5) * 4,
        vy: 9 + Math.random() * 3,
        vz: fz * 16 + (Math.random() - 0.5) * 4
      };
      io.to(room.code).emit('henFly', { id: hen.id });
      socket.emit('feed', { kind: 'gold', text: '꼬꼬댁!! 닭이 날아갔다' });
      return;
    }
    socket.emit('feed', { kind: 'bad', text: '허공을 쳤다' });
  });

  /* ---------- 관리자 ---------- */
  function isHost() { return room && me && room.hostId === me.id; }

  socket.on('admin:start', () => { if (isHost()) startRound(room); });
  socket.on('admin:stop',  () => { if (isHost()) endRound(room, 'stopped'); });
  socket.on('admin:cfg', d => {
    if (!isHost() || !d) return;
    const c = room.cfg;
    const clamp = (v, lo, hi, def) => (isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : def);
    c.round   = clamp(d.round,   60, 900, c.round);
    c.gap     = clamp(d.gap,     15, 120, c.gap);
    c.window  = clamp(d.window,  10,  60, c.window);
    c.limit   = clamp(d.limit,    3,  15, c.limit);
    c.seekers = clamp(d.seekers,  1,   8, c.seekers);
    c.npc     = clamp(d.npc,      0,  80, c.npc);
    c.hens    = clamp(d.hens,     0,  30, c.hens);
    c.speed   = clamp(d.speed,  0.4,   3, c.speed);
    c.jiggle  = clamp(d.jiggle,   0, 2.4, c.jiggle);
    if (typeof d.tod === 'string' && ['day','dusk','night'].indexOf(d.tod) >= 0) c.tod = d.tod;
    io.to(room.code).emit('cfg', c);
    sendRoster(room);
  });
  socket.on('admin:kick', d => {
    if (!isHost() || !d || !d.id || d.id === me.id) return;
    const t = room.players.get(d.id);
    if (!t) return;
    io.to(d.id).emit('kicked');
    const s = io.sockets.sockets.get(d.id);
    if (s) s.disconnect(true);
  });

  socket.on('chatName', d => {
    if (!me) return;
    const n = String((d && d.name) || '').trim().slice(0, 10);
    if (n) { me.name = n; sendRoster(room); }
  });

  socket.on('disconnect', () => {
    if (!room || !me) return;
    room.players.delete(me.id);
    if (room.hostId === me.id) {
      const next = room.players.keys().next();
      room.hostId = next.done ? null : next.value;
      if (room.hostId) io.to(room.hostId).emit('youAreHost');
    }
    sendRoster(room);
    dropRoomIfEmpty(room);
  });
});

const JOKERS = [
  { n: '🔍 AI 감별기', d: '3초간 술래가 빨갛게 보입니다', reveal: true },
  { n: '🪶 깃털 위장', d: '술래가 잠시 놓칩니다' },
  { n: '🥚 알 함정',  d: '술래를 느리게 만듭니다' }
];
function pickJoker() { return JOKERS[Math.floor(Math.random() * JOKERS.length)]; }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('꼬꼬 아레나 서버 실행 중 : ' + PORT));
