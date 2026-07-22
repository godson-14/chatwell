const express = require('express');
const fs = require('fs');
const http = require('http');
const { Pool } = require('pg');
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
const roomLocks = new Map();
const typingUsers = new Map();
const credentialsFile = path.join(__dirname, 'users.json');
const historyFile = path.join(__dirname, 'chat-history.json');
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
}) : null;

function requireDatabase() {
  if (!pool) throw new Error('DATABASE_URL is required');
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
}

function loadLegacyCredentials() {
  try { return JSON.parse(fs.readFileSync(credentialsFile, 'utf8')); } catch (error) { return {}; }
}

function loadLegacyHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    return parsed && parsed.rooms && typeof parsed.rooms === 'object' ? parsed.rooms : { Lobby: [] };
  } catch (error) { return { Lobby: [] }; }
}

async function createAccount(name, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  await pool.query('INSERT INTO users (username, salt, password_hash) VALUES ($1, $2, $3)', [name, salt, hashPassword(password, salt)]);
}

async function verifyAccount(name, password) {
  const result = await pool.query('SELECT salt, password_hash FROM users WHERE username = $1', [name]);
  const record = result.rows[0];
  if (!record) return false;
  const candidate = hashPassword(password, record.salt);
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(record.password_hash, 'hex'));
}

function ensureRoom(room) {
  if (!rooms.has(room)) rooms.set(room, []);
  if (!roomMembers.has(room)) roomMembers.set(room, new Set());
  if (!typingUsers.has(room)) typingUsers.set(room, new Set());
  if (!roomLocks.has(room)) roomLocks.set(room, false);
}

function messageToRow(message) {
  return [message.id, message.room, message.type, message.from, message.to, message.time, message.edited,
    message.text || null, message.fileName || null, message.fileData || null, message.mimeType || null,
    message.imageName || null, message.imageData || null, message.audioData || null, message.audioType || null,
    JSON.stringify(message.reactions || {})];
}

function rowToMessage(row) {
  return { id: row.id, type: row.message_type, from: row.from_user, to: row.to_user, room: row.room_name,
    time: new Date(row.sent_at).toISOString(), edited: row.edited, reactions: row.reactions || {},
    ...(row.edited_at ? { editedAt: new Date(row.edited_at).toISOString() } : {}),
    ...(row.text ? { text: row.text } : {}), ...(row.file_name ? { fileName: row.file_name } : {}),
    ...(row.file_data ? { fileData: row.file_data } : {}), ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.image_name ? { imageName: row.image_name } : {}), ...(row.image_data ? { imageData: row.image_data } : {}),
    ...(row.audio_data ? { audioData: row.audio_data } : {}), ...(row.audio_type ? { audioType: row.audio_type } : {}) };
}

async function addRoomMessage(room, message) {
  ensureRoom(room);
  const history = rooms.get(room);
  history.push(message);
  await pool.query(`INSERT INTO messages (id, room_name, message_type, from_user, to_user, sent_at, edited, text, file_name, file_data, mime_type, image_name, image_data, audio_data, audio_type, reactions)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`, messageToRow(message));
  if (history.length > 500) {
    const removed = history.shift();
    await pool.query('DELETE FROM messages WHERE id = $1 AND room_name = $2', [removed.id, room]);
  }
}

async function updateRoomMessage(room, messageId, updater) {
  ensureRoom(room);
  const history = rooms.get(room);
  const index = history.findIndex((message) => message.id === messageId);
  if (index === -1) return null;
  const updated = { ...history[index], ...updater };
  history[index] = updated;
  await pool.query('UPDATE messages SET text = $1, edited = $2, edited_at = $3, reactions = $4::jsonb WHERE id = $5 AND room_name = $6',
    [updated.text || null, updated.edited, updated.editedAt || null, JSON.stringify(updated.reactions || {}), messageId, room]);
  return updated;
}

async function removeRoomMessage(room, messageId) {
  ensureRoom(room);
  const history = rooms.get(room);
  const next = history.filter((message) => message.id !== messageId);
  if (next.length === history.length) return false;
  rooms.set(room, next);
  await pool.query('DELETE FROM messages WHERE id = $1 AND room_name = $2', [messageId, room]);
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

async function initializeDatabase() {
  requireDatabase();
  const legacyCredentials = loadLegacyCredentials();
  for (const [username, record] of Object.entries(legacyCredentials)) {
    await pool.query(
      'INSERT INTO users (username, salt, password_hash) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING',
      [username, record.salt, record.hash],
    );
  }

  const legacyRooms = loadLegacyHistory();
  for (const [room, history] of Object.entries(legacyRooms)) {
    await pool.query('INSERT INTO rooms (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [room]);
    for (const message of (Array.isArray(history) ? history : [])) {
      await pool.query(`INSERT INTO messages (id, room_name, message_type, from_user, to_user, sent_at, edited, text, file_name, file_data, mime_type, image_name, image_data, audio_data, audio_type, reactions)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb) ON CONFLICT (id) DO NOTHING`, messageToRow(message));
    }
  }
  await pool.query("INSERT INTO rooms (name) VALUES ('Lobby') ON CONFLICT (name) DO NOTHING");

  const roomResult = await pool.query('SELECT name, locked FROM rooms ORDER BY created_at');
  const messageResult = await pool.query('SELECT * FROM messages ORDER BY sent_at');
  roomResult.rows.forEach((room) => {
    rooms.set(room.name, []);
    roomLocks.set(room.name, room.locked);
    roomMembers.set(room.name, new Set());
    typingUsers.set(room.name, new Set());
  });
  messageResult.rows.forEach((row) => {
    ensureRoom(row.room_name);
    rooms.get(row.room_name).push(rowToMessage(row));
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  let username = null;

  socket.on('register', async ({ name, password }) => {
    const cleanName = String(name || '').trim();
    const cleanPassword = String(password || '');

    if (!cleanName || cleanPassword.length < 6) {
      socket.emit('register-error', 'Name and password are required. Password must be at least 6 characters.');
      return;
    }

    const existing = await pool.query('SELECT 1 FROM users WHERE username = $1', [cleanName]);
    if (existing.rowCount) {
      socket.emit('register-error', 'That username is already taken.');
      return;
    }

    await createAccount(cleanName, cleanPassword);
    socket.emit('register-success', 'Account created. You can now log in.');
  });

  socket.on('login', async ({ name, password }) => {
    const cleanName = String(name || '').trim();
    const cleanPassword = String(password || '');

    if (!cleanName || !cleanPassword) {
      socket.emit('login-error', 'Name and password are required.');
      return;
    }
    if (!await verifyAccount(cleanName, cleanPassword)) {
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

  socket.on('create-room', async (roomName) => {
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
    await pool.query('INSERT INTO rooms (name) VALUES ($1)', [cleanRoom]);
    broadcastRooms();
    joinRoom(socket, username, cleanRoom);
  });

  socket.on('invite-private', async ({ targets }) => {
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
    await pool.query('INSERT INTO rooms (name) VALUES ($1)', [privateRoom]);
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

  socket.on('group-invite', async () => {
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
    await pool.query('INSERT INTO rooms (name) VALUES ($1)', [privateRoom]);
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

  socket.on('send-message', async (data) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const message = createMessageBase('text', username, data.to || 'All', room, {
      text: String(data.text || '').trim(),
    });
    if (!message.text) return;

    if (message.to === 'All') {
      await addRoomMessage(room, message);
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

  socket.on('send-file', async (data) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const payload = createMessageBase('file', username, data.to || 'All', room, {
      fileName: String(data.fileName || 'attachment'),
      fileData: data.fileData,
      mimeType: data.mimeType || 'application/octet-stream',
    });
    if (!payload.fileData) return;

    if (payload.to === 'All') {
      await addRoomMessage(room, payload);
      io.to(room).emit('chat-message', payload);
    } else {
      const targetId = users.get(payload.to);
      if (targetId) {
        io.to(targetId).emit('chat-message', payload);
        socket.emit('chat-message', payload);
      }
    }
  });

  socket.on('send-image', async (data) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const payload = createMessageBase('image', username, data.to || 'All', room, {
      imageName: String(data.fileName || 'image'),
      imageData: data.fileData,
      mimeType: data.mimeType || 'image/png',
    });
    if (!payload.imageData) return;

    if (payload.to === 'All') {
      await addRoomMessage(room, payload);
      io.to(room).emit('chat-message', payload);
    } else {
      const targetId = users.get(payload.to);
      if (targetId) {
        io.to(targetId).emit('chat-message', payload);
        socket.emit('chat-message', payload);
      }
    }
  });

  socket.on('send-voice', async (data) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const payload = createMessageBase('voice', username, data.to || 'All', room, {
      audioData: data.audioData,
      audioType: data.audioType || 'audio/webm',
    });
    if (!payload.audioData) return;

    if (payload.to === 'All') {
      await addRoomMessage(room, payload);
      io.to(room).emit('chat-message', payload);
    } else {
      const targetId = users.get(payload.to);
      if (targetId) {
        io.to(targetId).emit('chat-message', payload);
        socket.emit('chat-message', payload);
      }
    }
  });

  socket.on('edit-message', async ({ id, text }) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const cleanText = String(text || '').trim();
    if (!cleanText) return;
    const updated = await updateRoomMessage(room, id, {
      text: cleanText,
      edited: true,
      editedAt: new Date().toISOString(),
    });
    if (updated) {
      io.to(room).emit('message-updated', { room, message: updated });
    }
  });

  socket.on('delete-message', async ({ id }) => {
    if (!username) return;
    const room = userRooms.get(username) || 'Lobby';
    const message = rooms.get(room)?.find((entry) => entry.id === id);
    if (!message || message.from !== username) return;
    const removed = await removeRoomMessage(room, id);
    if (removed) {
      io.to(room).emit('message-deleted', { room, id });
    }
  });

  socket.on('toggle-reaction', async ({ id, emoji }) => {
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
    const updated = await updateRoomMessage(room, id, { reactions });
    if (updated) {
      io.to(room).emit('message-updated', { room, message: updated });
    }
  });

  socket.on('clear-room', async (roomName) => {
    if (!username) return;
    const room = String(roomName || '').trim();
    if (!room || !rooms.has(room)) return;
    rooms.set(room, []);
    await pool.query('DELETE FROM messages WHERE room_name = $1', [room]);
    io.to(room).emit('room-cleared', { room });
  });

  socket.on('lock-room', async (roomName) => {
    if (!username) return;
    const room = String(roomName || '').trim();
    if (!room || !rooms.has(room)) return;
    const locked = !roomLocks.get(room);
    roomLocks.set(room, locked);
    await pool.query('UPDATE rooms SET locked = $1 WHERE name = $2', [locked, room]);
    io.to(room).emit('room-locked', { room, locked });
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
initializeDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Chat server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
