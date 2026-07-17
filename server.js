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
const typingUsers = new Map();
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
      broadcastTyping(room);
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
  if (!typingUsers.has(room)) {
    typingUsers.set(room, new Set());
  }
}

function addRoomMessage(room, message) {
  ensureRoom(room);
  const history = rooms.get(room);
  history.push(message);
  if (history.length > 500) {
    history.shift();
  }
  saveHistory();
}

function updateRoomMessage(room, messageId, updater) {
  ensureRoom(room);
  const history = rooms.get(room);
  const index = history.findIndex((message) => message.id === messageId);
  if (index === -1) return null;
  const updated = { ...history[index], ...updater };
  history[index] = updated;
  saveHistory();
  return updated;
}

function removeRoomMessage(room, messageId) {
  ensureRoom(room);
  const history = rooms.get(room);
  const next = history.filter((message) => message.id !== messageId);
  if (next.length === history.length) return false;
  rooms.set(room, next);
  saveHistory();
  return true;
}

function broadcastRooms() {
  io.emit('room-list', Array.from(rooms.keys()));
}

function getRoomUsers(room) {
  return Array.from(roomMembers.get(room) || []);
}

function broadcastTyping(room) {
  ensureRoom(room);
  const active = Array.from(typingUsers.get(room) || []);
  io.to(room).emit('typing-update', { room, users: active });
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
  broadcastTyping(room);
}

function createMessageBase(type, from, to, room, extra = {}) {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    type,
    from,
    to,
    room,
    time: new Date().toISOString(),
    edited: false,
    reactions: {},
    ...extra,
  };
}

const initialHistory = loadHistory();
Object.entries(initialHistory).forEach(([room, history]) => {
  rooms.set(room, Array.isArray(history) ? history : []);
  roomMembers.set(room, new Set());
  typingUsers.set(room, new Set());
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

  socket.on('invite-private', ({ targets }) => {
    if (!username) return;
    if (!Array.isArray(targets) || targets.length === 0) {
      socket.emit('invite-error', 'No users provided for the invite.');
      return;
    }

    const cleanTargets = targets
      .map((name) => String(name || '').trim())
      .filter((name) => name && name !== username);

    if (cleanTargets.length === 0) {
      socket.emit('invite-error', 'No valid usernames provided.');
      return;
    }

    const onlineTargets = cleanTargets.filter((target) => users.has(target));

    if (onlineTargets.length === 0) {
      socket.emit('invite-error', 'None of the invited users are online.');
      return;
    }

    const participants = [username, ...onlineTargets].sort();
    const privateRoom = `private-${participants.join('-')}-${Date.now()}`;
    ensureRoom(privateRoom);
    saveHistory();
    broadcastRooms();
    joinRoom(socket, username, privateRoom);

    onlineTargets.forEach((target) => {
      const targetId = users.get(target);
      io.to(targetId).emit('private-room-invite', {
        room: privateRoom,
        from: username,
        participants,
      });
    });
    socket.emit('invite-success', { room: privateRoom, participants });
  });

  socket.on('group-invite', () => {
    if (!username) return;
    const currentRoom = userRooms.get(username) || 'Lobby';
    const members = Array.from(roomMembers.get(currentRoom) || []).filter((u) => u !== username);
    if (members.length === 0) {
      socket.emit('invite-error', 'No other members are present to invite.');
      return;
    }

    const participants = [username, ...members].sort();
    const privateRoom = `private-${participants.join('-')}-${Date.now()}`;
    ensureRoom(privateRoom);
    saveHistory();
    broadcastRooms();
    joinRoom(socket, username, privateRoom);

    members.forEach((target) => {
      const targetId = users.get(target);
      if (targetId) {
        io.to(targetId).emit('private-room-invite', {
          room: privateRoom,
          from: username,
          participants,
        });
      }
    });
    socket.emit('invite-success', { room: privateRoom, participants });
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

  socket.on('typing', () => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const typingSet = typingUsers.get(room);
    if (!typingSet) return;
    typingSet.add(username);
    broadcastTyping(room);
  });

  socket.on('stop-typing', () => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const typingSet = typingUsers.get(room);
    if (!typingSet) return;
    typingSet.delete(username);
    broadcastTyping(room);
  });

  socket.on('send-message', (data) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const message = createMessageBase('text', username, data.to || 'All', room, {
      text: String(data.text || '').trim(),
    });
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

    const typingSet = typingUsers.get(room);
    if (typingSet) {
      typingSet.delete(username);
      broadcastTyping(room);
    }
  });

  socket.on('send-file', (data) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const payload = createMessageBase('file', username, data.to || 'All', room, {
      fileName: String(data.fileName || 'attachment'),
      fileData: data.fileData,
      mimeType: data.mimeType || 'application/octet-stream',
    });
    if (!payload.fileData) return;

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

  socket.on('send-image', (data) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const payload = createMessageBase('image', username, data.to || 'All', room, {
      imageName: String(data.fileName || 'image'),
      imageData: data.fileData,
      mimeType: data.mimeType || 'image/png',
    });
    if (!payload.imageData) return;

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

  socket.on('send-voice', (data) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const payload = createMessageBase('voice', username, data.to || 'All', room, {
      audioData: data.audioData,
      audioType: data.audioType || 'audio/webm',
    });
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

  socket.on('edit-message', ({ id, text }) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const cleanText = String(text || '').trim();
    if (!cleanText) return;
    const updated = updateRoomMessage(room, id, {
      text: cleanText,
      edited: true,
      editedAt: new Date().toISOString(),
    });
    if (updated) {
      io.to(room).emit('message-updated', { room, message: updated });
    }
  });

  socket.on('delete-message', ({ id }) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const message = rooms.get(room)?.find((entry) => entry.id === id);
    if (!message || message.from !== username) return;
    const removed = removeRoomMessage(room, id);
    if (removed) {
      io.to(room).emit('message-deleted', { room, id });
    }
  });

  socket.on('toggle-reaction', ({ id, emoji }) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const message = rooms.get(room)?.find((entry) => entry.id === id);
    if (!message) return;
    const reactions = { ...(message.reactions || {}) };
    const currentUsers = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
    const nextUsers = currentUsers.includes(username)
      ? currentUsers.filter((entry) => entry !== username)
      : [...currentUsers, username];
    reactions[emoji] = nextUsers;
    const updated = updateRoomMessage(room, id, { reactions });
    if (updated) {
      io.to(room).emit('message-updated', { room, message: updated });
    }
  });

  socket.on('clear-room', (roomName) => {
    if (!username) return;
    const room = String(roomName || '').trim();
    if (!room || !rooms.has(room)) return;
    rooms.set(room, []);
    saveHistory();
    io.to(room).emit('room-cleared', { room });
  });

  socket.on('lock-room', (roomName) => {
    if (!username) return;
    const room = String(roomName || '').trim();
    if (!room || !rooms.has(room)) return;
    const current = rooms.get(room);
    const locked = current?.locked;
    const next = { ...current, locked: !locked };
    rooms.set(room, next);
    saveHistory();
    io.to(room).emit('room-locked', { room, locked: !locked });
  });

  socket.on('call-offer', ({ to, offer, type }) => {
    if (!username) return;
    const targetId = users.get(to);
    if (targetId) {
      io.to(targetId).emit('call-offer', { from: username, offer, type });
    }
  });

  socket.on('call-answer', ({ to, answer }) => {
    if (!username) return;
    const targetId = users.get(to);
    if (targetId) {
      io.to(targetId).emit('call-answer', { answer });
    }
  });

  socket.on('call-candidate', ({ to, candidate }) => {
    if (!username) return;
    const targetId = users.get(to);
    if (targetId) {
      io.to(targetId).emit('call-candidate', { candidate });
    }
  });

  socket.on('call-decline', ({ to }) => {
    if (!username) return;
    const targetId = users.get(to);
    if (targetId) {
      io.to(targetId).emit('call-decline');
    }
  });

  socket.on('call-end', ({ to }) => {
    if (!username) return;
    const targetId = users.get(to);
    if (targetId) {
      io.to(targetId).emit('call-end');
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
