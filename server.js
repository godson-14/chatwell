const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const users = new Map();
const userRooms = new Map();
const roomMembers = new Map();
const rooms = new Map();
const credentialsFile = path.join(__dirname, 'users.json');
const historyFile = path.join(__dirname, 'chat-history.json');

function cleanupUser(name) {
  if (!name) return;
  const room = userRooms.get(name);
  users.delete(name);
  userRooms.delete(name);
  if (room) {
    const members = roomMembers.get(room);
    if (members) {
      members.delete(name);
      io.to(room).emit('user-list', getRoomUsers(room));
    }
  }
}

function loadCredentials() {
  try {
    const raw = fs.readFileSync(credentialsFile, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return {};
  }
}

function saveCredentials(creds) {
  fs.writeFileSync(credentialsFile, JSON.stringify(creds, null, 2));
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
}

function createAccount(name, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const credentials = loadCredentials();
  credentials[name] = { salt, hash };
  saveCredentials(credentials);
}

function verifyAccount(name, password) {
  const credentials = loadCredentials();
  const record = credentials[name];
  if (!record) return false;
  const candidate = hashPassword(password, record.salt);
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(record.hash, 'hex'));
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(historyFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.rooms && typeof parsed.rooms === 'object') {
      return parsed.rooms;
    }
  } catch (error) {
    // file not found or invalid JSON
  }
  return { Lobby: [] };
}

function saveHistory() {
  const serialized = {
    rooms: Object.fromEntries(Array.from(rooms.entries())),
  };
  fs.writeFileSync(historyFile, JSON.stringify(serialized, null, 2));
}

function ensureRoom(room) {
  if (!rooms.has(room)) {
    rooms.set(room, []);
  }
  if (!roomMembers.has(room)) {
    roomMembers.set(room, new Set());
  }
}

function addRoomMessage(room, message) {
  ensureRoom(room);
  const history = rooms.get(room);
  history.push(message);
  if (history.length > 250) {
    history.shift();
  }
  saveHistory();
}

function broadcastRooms() {
  io.emit('room-list', Array.from(rooms.keys()));
}

function getRoomUsers(room) {
  return Array.from(roomMembers.get(room) || []);
}

function joinRoom(socket, username, room) {
  const currentRoom = userRooms.get(username);
  if (currentRoom === room) {
    return;
  }

  if (currentRoom) {
    socket.leave(currentRoom);
    const previousMembers = roomMembers.get(currentRoom);
    if (previousMembers) {
      previousMembers.delete(username);
      io.to(currentRoom).emit('user-list', getRoomUsers(currentRoom));
    }
  }

  ensureRoom(room);
  socket.join(room);
  userRooms.set(username, room);
  roomMembers.get(room).add(username);
  socket.emit('joined-room', { room, history: rooms.get(room) });
  io.to(room).emit('user-list', getRoomUsers(room));
}

const initialHistory = loadHistory();
Object.entries(initialHistory).forEach(([room, history]) => {
  rooms.set(room, Array.isArray(history) ? history : []);
  roomMembers.set(room, new Set());
});
ensureRoom('Lobby');
saveHistory();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  let username = null;

  socket.on('register', ({ name, password }) => {
    const cleanName = String(name || '').trim();
    const cleanPassword = String(password || '');

    if (!cleanName || cleanPassword.length < 6) {
      socket.emit('register-error', 'Name and password are required. Password must be at least 6 characters.');
      return;
    }

    const credentials = loadCredentials();
    if (credentials[cleanName]) {
      socket.emit('register-error', 'That username is already taken.');
      return;
    }

    createAccount(cleanName, cleanPassword);
    socket.emit('register-success', 'Account created. You can now log in.');
  });

  socket.on('login', ({ name, password }) => {
    const cleanName = String(name || '').trim();
    const cleanPassword = String(password || '');

    if (!cleanName || !cleanPassword) {
      socket.emit('login-error', 'Name and password are required.');
      return;
    }
    const credentials = loadCredentials();
    if (!credentials[cleanName] || !verifyAccount(cleanName, cleanPassword)) {
      socket.emit('login-error', 'Invalid username or password.');
      return;
    }
    if (users.has(cleanName)) {
      socket.emit('login-error', 'That username is already in use.');
      return;
    }

    username = cleanName;
    users.set(username, socket.id);
    socket.emit('login-success', username);
    socket.emit('room-list', Array.from(rooms.keys()));
    joinRoom(socket, username, 'Lobby');
    broadcastRooms();
  });

  socket.on('create-room', (roomName) => {
    if (!username) return;
    const cleanRoom = String(roomName || '').trim();
    if (!cleanRoom) {
      socket.emit('create-room-error', 'Enter a room name.');
      return;
    }
    if (rooms.has(cleanRoom)) {
      socket.emit('create-room-error', 'That room already exists.');
      return;
    }
    ensureRoom(cleanRoom);
    saveHistory();
    broadcastRooms();
    joinRoom(socket, username, cleanRoom);
  });

  socket.on('invite-private', (targetName) => {
    if (!username) return;
    const cleanTarget = String(targetName || '').trim();
    if (!cleanTarget || cleanTarget === username) return;
    const targetId = users.get(cleanTarget);
    if (!targetId) {
      socket.emit('invite-error', 'User is not online.');
      return;
    }
    const privateRoom = `private-${username}-${cleanTarget}-${Date.now()}`;
    ensureRoom(privateRoom);
    saveHistory();
    broadcastRooms();
    joinRoom(socket, username, privateRoom);
    io.to(targetId).emit('private-room-invite', {
      room: privateRoom,
      from: username,
    });
  });

  socket.on('accept-private-room', (roomName) => {
    if (!username) return;
    const cleanRoom = String(roomName || '').trim();
    if (!rooms.has(cleanRoom)) {
      socket.emit('join-room-error', 'Room does not exist.');
      return;
    }
    joinRoom(socket, username, cleanRoom);
  });

  socket.on('join-room', (roomName) => {
    if (!username) return;
    const cleanRoom = String(roomName || '').trim();
    if (!rooms.has(cleanRoom)) {
      socket.emit('join-room-error', 'Room does not exist.');
      return;
    }
    joinRoom(socket, username, cleanRoom);
  });

  socket.on('send-message', (data) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const message = {
      type: 'text',
      from: username,
      to: data.to || 'All',
      room,
      text: String(data.text || '').trim(),
      time: new Date().toISOString(),
    };
    if (!message.text) return;

    if (message.to === 'All') {
      addRoomMessage(room, message);
      io.to(room).emit('chat-message', message);
    } else {
      const targetId = users.get(message.to);
      if (targetId) {
        io.to(targetId).emit('chat-message', message);
        socket.emit('chat-message', message);
      }
    }
  });

  socket.on('send-voice', (data) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const payload = {
      type: 'voice',
      from: username,
      to: data.to || 'All',
      room,
      audioData: data.audioData,
      audioType: data.audioType || 'audio/webm',
      time: new Date().toISOString(),
    };
    if (!payload.audioData) return;

    if (payload.to === 'All') {
      addRoomMessage(room, payload);
      io.to(room).emit('chat-message', payload);
    } else {
      const targetId = users.get(payload.to);
      if (targetId) {
        io.to(targetId).emit('chat-message', payload);
        socket.emit('chat-message', payload);
      }
    }
  });

  socket.on('logout', () => {
    cleanupUser(username);
    username = null;
    socket.emit('logged-out');
  });

  socket.on('disconnect', () => {
    cleanupUser(username);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat server running at http://localhost:${PORT}`);
});
