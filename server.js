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
//   players: { socketId: {id,name,icon,x,y,hp,hpMax,level,zone,facingLeft} },
//   zoneState: { zoneId: [ {netId, typeKey, kind, x, y, hp, hpMax, alive, ...} ] }
// }
const rooms = {};

function getRoom(code){
  if(!rooms[code]) rooms[code] = { players: {}, zoneState: {} };
  return rooms[code];
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

  // 몬스터 리스폰(부활)도 동일하게 동기화
  socket.on('monsterRespawn', ({ zone, netId, x, y, hp, hpMax }) => {
    if(!currentRoom || !rooms[currentRoom]) return;
    const zs = rooms[currentRoom].zoneState[zone];
    if(zs){
      const en = zs.find(e => e.netId === netId);
      if(en){ en.hp = hp; en.hpMax = hpMax; en.alive = true; en.x = x; en.y = y; }
    }
    socket.to(currentRoom).emit('monsterRespawn', { zone, netId, x, y, hp, hpMax });
  });

  socket.on('chat', (msg) => {
    if(!currentRoom) return;
    io.to(currentRoom).emit('chat', { id: socket.id, msg: String(msg).slice(0,200) });
  });

  socket.on('disconnect', () => {
    if(currentRoom && rooms[currentRoom]){
      delete rooms[currentRoom].players[socket.id];
      socket.to(currentRoom).emit('playerLeft', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('멀티플레이 서버 실행 중, 포트: ' + PORT));
