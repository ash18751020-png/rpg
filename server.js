// 크로니클 오브 아르텔 - 협동 사냥 멀티플레이 서버
// 실행: npm install && npm start
// Render 등에 배포하면 친구들이 https 주소로 접속 가능

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/', (req, res) => {
  res.send('크로니클 오브 아르텔 멀티플레이 서버 동작 중');
});

// rooms[roomCode] = {
//   players: { socketId: {id,name,icon,x,y,hp,hpMax,level,zone,facingLeft,...} },
//   zoneState: { zoneId: [ {netId, typeKey, kind, x, y, hp, hpMax, alive, ...} ] }
// }
const rooms = {};
// trades[tradeId] = { room, a, b, offerA, offerB, confirmedA, confirmedB }
const trades = {};

function getRoom(code){
  if(!rooms[code]) rooms[code] = { players: {}, zoneState: {} };
  return rooms[code];
}

function makeTradeId(){
  return 'trade_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// 특정 소켓이 참여 중이던 거래를 찾아서 정리 (연결 종료 시 사용)
function cleanupTradesFor(socketId){
  Object.keys(trades).forEach(tradeId => {
    const t = trades[tradeId];
    if(!t) return;
    if(t.a === socketId || t.b === socketId){
      const otherId = t.a === socketId ? t.b : t.a;
      io.to(otherId).emit('tradeCancelled');
      delete trades[tradeId];
    }
  });
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', ({ room, name, icon }) => {
    if(!room) return;
    currentRoom = String(room).slice(0, 24);
    socket.join(currentRoom);
    const r = getRoom(currentRoom);
    r.players[socket.id] = {
      id: socket.id, name: (name||'모험가').slice(0,16), icon: icon||'🙂',
      x: 0, y: 0, hp: 100, hpMax: 100, level: 1, zone: 'town', facingLeft: false,
    };
    socket.emit('joined', {
      selfId: socket.id,
      players: r.players,
      zoneState: r.zoneState,
    });
    socket.to(currentRoom).emit('playerJoined', r.players[socket.id]);
  });

  // 이동 + 캐릭터 상태(직업/탈것/애니메이션 등) 동기화
  socket.on('move', (data) => {
    if(!currentRoom || !rooms[currentRoom]) return;
    const p = rooms[currentRoom].players[socket.id];
    if(!p) return;
    Object.assign(p, data);
    socket.to(currentRoom).emit('playerMoved', { id: socket.id, ...data });
  });

  // 존에 처음 입장한 사람이 몬스터 배치를 생성해서 보내면,
  // 서버가 그 배치를 그 방의 "정답"으로 저장하고 나머지에게도 동일하게 전달
  socket.on('zoneEntities', ({ zone, entities }) => {
    if(!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];
    if(!r.zoneState[zone]){
      r.zoneState[zone] = entities;
      socket.emit('zoneEntitiesSet', { zone, entities, authoritative:false });
      socket.to(currentRoom).emit('zoneEntitiesSet', { zone, entities, authoritative:false });
    } else {
      // 이미 다른 사람이 먼저 만든 배치가 있으면 그걸 그대로 돌려줌
      socket.emit('zoneEntitiesSet', { zone, entities: r.zoneState[zone], authoritative:true });
    }
  });

  // 몬스터가 피해를 입으면 서버가 권위있는 HP를 갱신하고 모두에게 전파
  socket.on('monsterDamage', ({ zone, netId, hp, alive }) => {
    if(!currentRoom || !rooms[currentRoom]) return;
    const zs = rooms[currentRoom].zoneState[zone];
    if(zs){
      const en = zs.find(e => e.netId === netId);
      if(en){ en.hp = hp; en.alive = alive; }
    }
    socket.to(currentRoom).emit('monsterDamage', { zone, netId, hp, alive });
  });

  // 몬스터 리스폰(부활)도 동일하게 동기화 - 리젠 예정 시각(respawnAt)까지 함께 저장
  socket.on('monsterRespawn', ({ zone, netId, x, y, hp, hpMax, respawnAt }) => {
    if(!currentRoom || !rooms[currentRoom]) return;
    const zs = rooms[currentRoom].zoneState[zone];
    if(zs){
      const en = zs.find(e => e.netId === netId);
      if(en){
        en.hp = hp; en.hpMax = hpMax; en.alive = true; en.x = x; en.y = y;
        if(respawnAt !== undefined) en.respawnAt = respawnAt;
      }
    }
    socket.to(currentRoom).emit('monsterRespawn', { zone, netId, x, y, hp, hpMax, respawnAt });
  });

  socket.on('chat', (msg) => {
    if(!currentRoom) return;
    io.to(currentRoom).emit('chat', { id: socket.id, msg: String(msg).slice(0,200) });
  });

  // 공간술사 다중이동 - 시전자 주변에 있던 플레이어들을 함께 이동시킴
  socket.on('teleportGroup', (data) => {
    if(!currentRoom) return;
    socket.to(currentRoom).emit('teleportGroup', data);
  });

  // 스킬 시전 이펙트(캐스트 링 등) - 근처 플레이어들도 같이 볼 수 있도록 전파
  socket.on('skillCast', (data) => {
    if(!currentRoom) return;
    socket.to(currentRoom).emit('skillCast', data);
  });

  // 파티 버프(회복/버프 등) - 같은 방의 다른 플레이어에게 전파, 거리 판정은 클라이언트가 함
  socket.on('partyBuff', (data) => {
    if(!currentRoom) return;
    socket.to(currentRoom).emit('partyBuff', data);
  });

  // 기여도 기반 경험치 공유 - 조건을 만족한 특정 플레이어들에게만 개별 전송
  socket.on('expShare', ({ qualifiedIds, exp }) => {
    if(!Array.isArray(qualifiedIds) || !exp) return;
    qualifiedIds.forEach(id => {
      io.to(id).emit('expShareReceived', { exp });
    });
  });

  // ===== 거래(트레이드) 시스템 =====
  // 1) 요청 -> 2) 수락/거절 -> 3) 각자 제안 갱신 -> 4) 양쪽 확정 -> 5) 실행
  socket.on('tradeRequest', ({ targetId }) => {
    if(!currentRoom || !rooms[currentRoom] || !targetId) return;
    const r = rooms[currentRoom];
    if(!r.players[targetId]) return; // 대상이 같은 방에 없으면 무시
    const me = r.players[socket.id];
    io.to(targetId).emit('tradeRequestReceived', { fromId: socket.id, fromName: me ? me.name : '???' });
  });

  socket.on('tradeResponse', ({ targetId, accepted }) => {
    if(!currentRoom || !targetId) return;
    io.to(targetId).emit('tradeResponseReceived', { accepted: !!accepted });
    if(accepted){
      const tradeId = makeTradeId();
      trades[tradeId] = {
        room: currentRoom, a: targetId, b: socket.id,
        offerA: { gold:0, items:[] }, offerB: { gold:0, items:[] },
        confirmedA: false, confirmedB: false,
      };
      io.to(targetId).emit('tradeStarted', { tradeId, otherId: socket.id });
      io.to(socket.id).emit('tradeStarted', { tradeId, otherId: targetId });
    }
  });

  socket.on('tradeUpdateOffer', ({ tradeId, gold, items }) => {
    const t = trades[tradeId];
    if(!t) return;
    const isA = t.a === socket.id;
    if(isA){ t.offerA = { gold: gold||0, items: items||[] }; }
    else{ t.offerB = { gold: gold||0, items: items||[] }; }
    t.confirmedA = false; t.confirmedB = false;
    const otherId = isA ? t.b : t.a;
    io.to(otherId).emit('tradeOfferUpdated', { gold: gold||0, items: items||[] });
    io.to(t.a).emit('tradeConfirmReset');
    io.to(t.b).emit('tradeConfirmReset');
  });

  socket.on('tradeConfirm', ({ tradeId }) => {
    const t = trades[tradeId];
    if(!t) return;
    const isA = t.a === socket.id;
    if(isA) t.confirmedA = true; else t.confirmedB = true;
    const otherId = isA ? t.b : t.a;
    io.to(otherId).emit('tradeConfirmUpdated');
    if(t.confirmedA && t.confirmedB){
      io.to(t.a).emit('tradeExecute', { myOffer: t.offerA, theirOffer: t.offerB });
      io.to(t.b).emit('tradeExecute', { myOffer: t.offerB, theirOffer: t.offerA });
      delete trades[tradeId];
    }
  });

  socket.on('tradeCancel', ({ tradeId }) => {
    const t = trades[tradeId];
    if(!t) return;
    const otherId = t.a === socket.id ? t.b : t.a;
    io.to(otherId).emit('tradeCancelled');
    delete trades[tradeId];
  });

  socket.on('disconnect', () => {
    cleanupTradesFor(socket.id);
    if(currentRoom && rooms[currentRoom]){
      delete rooms[currentRoom].players[socket.id];
      socket.to(currentRoom).emit('playerLeft', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('멀티플레이 서버 실행 중, 포트: ' + PORT));
