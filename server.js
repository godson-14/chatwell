const express = require('express');
const fs = require('fs');
const http = require('http');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Kafka } = require('kafkajs');

// Load local env file (examhub.env or .env) if present, without adding a dependency.
function loadEnvFile() {
  const candidates = [path.join(__dirname, 'examhub.env'), path.join(__dirname, '.env')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^([^#=]+)="?([^"]*)"?$/);
      if (m) process.env[m[1].trim()] = m[2];
    });
    break;
  }
}
loadEnvFile();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Aiven Kafka Initialization (optional; skipped when certs are not present) ---
let producer = null;
const kafkaCerts = ['ca.pem', 'service.key', 'service.cert.txt'].every((file) =>
  fs.existsSync(path.join(__dirname, file))
);

if (process.env.KAFKA_BROKERS && kafkaCerts) {
  try {
    const kafka = new Kafka({
      clientId: 'chat-app',
      brokers: [process.env.KAFKA_BROKERS],
      ssl: {
        rejectUnauthorized: true,
        ca: [fs.readFileSync(path.join(__dirname, 'ca.pem'), 'utf-8')],
        key: fs.readFileSync(path.join(__dirname, 'service.key'), 'utf-8'),
        cert: fs.readFileSync(path.join(__dirname, 'service.cert.txt'), 'utf-8'),
      },
    });
    producer = kafka.producer();

    async function connectKafka() {
      try {
        await producer.connect();
        console.log('Successfully connected to Aiven Kafka!');
      } catch (err) {
        console.error('Kafka Connection Error:', err);
      }
    }
    connectKafka();
  } catch (err) {
    console.error('Kafka setup skipped:', err.message);
  }
} else {
  console.log('Kafka disabled (KAFKA_BROKERS or certificates not configured).');
}
// ----------------------------------

const users = new Map(); // username -> Set of socket ids
const userSockets = new Map(); // username -> Set of socket objects
const userRooms = new Map();
const roomMembers = new Map();
const rooms = new Map();
const roomLocks = new Map();
const roomPrivacy = new Map(); // room name -> is private (invite-only)
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
  if (!roomPrivacy.has(room)) roomPrivacy.set(room, false);
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
  
  if (producer) {
    try {
      await producer.send({
        topic: 'chat-messages',
        messages: [{ value: JSON.stringify(message) }],
      });
    } catch (kafkaErr) {
      console.error('Failed to stream message to Kafka:', kafkaErr);
    }
  }

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
  const online = Array.from(users.keys());
  online.forEach((name) => emitUserRooms(name));
}

// Emit the room list for one user: all public rooms + private rooms the user is a member of.
function emitUserRooms(username) {
  const sockets = userSockets.get(username) || [];
  const visible = Array.from(rooms.keys()).filter((room) =>
    roomPrivacy.has(room) && roomPrivacy.get(room)
      ? (roomMembers.get(room) || new Set()).has(username)
      : true
  );
  sockets.forEach((s) => s.emit('room-list', visible));
}

function addRoomMember(room, username) {
  ensureRoom(room);
  roomMembers.get(room).add(username);
  try {
    requireDatabase();
    pool.query('INSERT INTO room_members (room_name, username) VALUES ($1, $2) ON CONFLICT DO NOTHING', [room, username])
      .catch(() => {});
  } catch (e) { /* database not configured */ }
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
  if (!rooms.has(room)) {
    socket.emit('join-room-error', `Room "${room}" does not exist.`);
    return;
  }
  const isPrivate = roomPrivacy.get(room) === true;
  if (isPrivate && !(roomMembers.get(room) || new Set()).has(username)) {
    socket.emit('join-room-error', `You are not a member of the private room "${room}".`);
    return;
  }

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

  const roomResult = await pool.query('SELECT name, locked, is_private FROM rooms ORDER BY created_at');
  const messageResult = await pool.query('SELECT * FROM messages ORDER BY sent_at');
  roomResult.rows.forEach((room) => {
    rooms.set(room.name, []);
    roomLocks.set(room.name, room.locked);
    roomPrivacy.set(room.name, !!room.is_private);
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

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initializeDatabase();
    server.listen(PORT, () => {
      console.log(`Chat application running on port ${PORT}`);
    });
  } catch (err) {
    // Still serve so the front-end can load and show connection errors.
    console.error('Database initialization failed:', err.message);
    server.listen(PORT, () => {
      console.log(`Chat application running on port ${PORT} (WITHOUT database)`);
    });
  }
}

startServer();

io.on('connection', (socket) => {
  let username = null;

  // ---------- Authentication ----------
  socket.on('register', async (data = {}) => {
    try {
      requireDatabase();
    } catch (err) {
      socket.emit('register-error', 'Database is not configured (DATABASE_URL missing).');
      return;
    }
    const name = (data.name || '').trim();
    const password = data.password || '';
    if (!name || !password) {
      socket.emit('register-error', 'Username and password are required.');
      return;
    }
    if (password.length < 6) {
      socket.emit('register-error', 'Password must be at least 6 characters.');
      return;
    }
    try {
      const exists = await pool.query('SELECT username FROM users WHERE username = $1', [name]);
      if (exists.rows.length > 0) {
        socket.emit('register-error', 'That username is already taken.');
        return;
      }
      await createAccount(name, password);
      console.log(`New account registered: ${name}`);
      socket.emit('register-success', 'Account created. You can now log in.');
    } catch (err) {
      console.error('Register error:', err.message);
      socket.emit('register-error', 'Could not create account. Please try again.');
    }
  });

  socket.on('login', async (data = {}) => {
    try {
      requireDatabase();
    } catch (err) {
      socket.emit('login-error', 'Database is not configured (DATABASE_URL missing).');
      return;
    }
    const name = (data.name || '').trim();
    const password = data.password || '';
    if (!name || !password) {
      socket.emit('login-error', 'Username and password are required.');
      return;
    }
    try {
      const valid = await verifyAccount(name, password);
      if (!valid) {
        socket.emit('login-error', 'Invalid username or password.');
        return;
      }
      username = name;
      if (!users.has(username)) {
        users.set(username, new Set());
        userSockets.set(username, new Set());
      }
      users.get(username).add(socket.id);
      userSockets.get(username).add(socket);
      socket.emit('login-success', username);
      joinRoom(socket, username, 'Lobby');
      broadcastRooms();
      console.log(`User logged in: ${username}`);
    } catch (err) {
      console.error('Login error:', err.message);
      socket.emit('login-error', 'Login failed. Please try again.');
    }
  });

  function handleLogout() {
    if (!username) return;
    const idSockets = users.get(username);
    if (idSockets) idSockets.delete(socket.id);
    const socketSet = userSockets.get(username);
    if (socketSet) socketSet.delete(socket);
    if (users.get(username) && users.get(username).size === 0) {
      users.delete(username);
      userSockets.delete(username);
      const currentRoom = userRooms.get(username);
      if (currentRoom) {
        socket.leave(currentRoom);
        const members = roomMembers.get(currentRoom);
        if (members) {
          members.delete(username);
          io.to(currentRoom).emit('user-list', getRoomUsers(currentRoom));
        }
        const typing = typingUsers.get(currentRoom);
        if (typing) {
          typing.delete(username);
          broadcastTyping(currentRoom);
        }
      }
      userRooms.delete(username);
    }
  }

  socket.on('logout', () => {
    handleLogout();
    socket.emit('logged-out');
    console.log(`User logged out: ${username || 'unknown'}`);
    username = null;
  });

  // ---------- Rooms ----------
  socket.on('create-room', async (roomName) => {
    if (!username) return;
    const name = (roomName || '').trim();
    if (!name) {
      socket.emit('create-room-error', 'Please enter a room name.');
      return;
    }
    if (rooms.has(name)) {
      socket.emit('create-room-error', `Room "${name}" already exists.`);
      return;
    }
    ensureRoom(name);
    rooms.set(name, []);
    roomLocks.set(name, false);
    roomPrivacy.set(name, false);
    try {
      requireDatabase();
      await pool.query('INSERT INTO rooms (name, is_private, locked) VALUES ($1, false, false)', [name]);
    } catch (err) {
      console.error('create-room db error:', err.message);
    }
    broadcastRooms();
  });

  socket.on('join-room', (roomName) => {
    if (!username) return;
    joinRoom(socket, username, roomName);
  });

  socket.on('invite-private', async ({ targets } = {}) => {
    if (!username) return;
    const list = (Array.isArray(targets) ? targets : [])
      .map((t) => (t || '').trim())
      .filter((t) => t && t !== username);
    if (!list.length) {
      socket.emit('invite-error', 'No valid usernames entered.');
      return;
    }
    const roomName = `private-${username}-${Date.now()}`;
    ensureRoom(roomName);
    rooms.set(roomName, []);
    roomLocks.set(roomName, true);
    roomPrivacy.set(roomName, true);
    try {
      requireDatabase();
      await pool.query('INSERT INTO rooms (name, is_private, locked) VALUES ($1, true, true)', [roomName]);
    } catch (err) {
      console.error('invite-private db error:', err.message);
    }
    addRoomMember(roomName, username);
    list.forEach((target) => {
      addRoomMember(roomName, target);
      const sockets = userSockets.get(target) || [];
      sockets.forEach((s) =>
        s.emit('private-room-invite', {
          from: username,
          room: roomName,
          participants: [username, ...list],
        })
      );
    });
    socket.emit('invite-success', { room: roomName });
    broadcastRooms();
  });

  socket.on('group-invite', () => {
    if (!username) return;
    const room = userRooms.get(username);
    if (!room) return;
    io.to(room).emit('private-room-invite', {
      from: username,
      room,
      participants: getRoomUsers(room),
    });
  });

  socket.on('accept-private-room', (roomName) => {
    if (!username || !rooms.has(roomName)) return;
    if (roomPrivacy.get(roomName)) {
      addRoomMember(roomName, username);
    }
    if (roomLocks.get(roomName)) {
      roomLocks.set(roomName, false);
      try {
        requireDatabase();
        pool.query('UPDATE rooms SET locked = false WHERE name = $1', [roomName]).catch(() => {});
      } catch (e) { /* database not configured */ }
    }
    joinRoom(socket, username, roomName);
    broadcastRooms();
  });

  socket.on('clear-room', async (roomName) => {
    if (!username || !roomName) return;
    if (rooms.has(roomName)) rooms.set(roomName, []);
    try {
      requireDatabase();
      await pool.query('DELETE FROM messages WHERE room_name = $1', [roomName]);
    } catch (err) {
      console.error('clear-room db error:', err.message);
    }
  });

  socket.on('lock-room', async (roomName) => {
    if (!username || !rooms.has(roomName)) return;
    const nextLock = !roomLocks.get(roomName);
    roomLocks.set(roomName, nextLock);
    io.to(roomName).emit('room-lock-toggled', { room: roomName, locked: nextLock });
    try {
      requireDatabase();
      await pool.query('UPDATE rooms SET locked = $1 WHERE name = $2', [nextLock, roomName]);
    } catch (err) {
      console.error('lock-room db error:', err.message);
    }
  });

  // ---------- Messaging ----------
  async function sendMessage(type, to, extra = {}) {
    if (!username) return;
    const room = userRooms.get(username);
    if (!room) {
      socket.emit('join-room-error', 'You must be in a room to send messages.');
      return;
    }
    const message = createMessageBase(type, username, to || 'All', room, extra);
    try {
      await addRoomMessage(room, message);
    } catch (err) {
      console.error('sendMessage db error:', err.message);
    }
    if (message.to && message.to !== 'All') {
      // Direct/whisper message: only sender and recipient see it.
      const recipientSockets = userSockets.get(message.to) || [];
      socket.emit('chat-message', message);
      recipientSockets.forEach((s) => {
        if (s.id !== socket.id) s.emit('chat-message', message);
      });
    } else {
      io.to(room).emit('chat-message', message);
    }
  }

  socket.on('send-message', (data = {}) => {
    if (data.text) sendMessage('text', data.to, { text: data.text });
  });

  socket.on('send-voice', (data = {}) => {
    if (data.audioData) {
      sendMessage('voice', data.to, {
        audioData: data.audioData,
        audioType: data.audioType || 'audio/webm',
      });
    }
  });

  socket.on('send-file', (data = {}) => {
    if (data.fileData) {
      sendMessage('file', data.to, {
        fileName: data.fileName || 'attachment',
        fileData: data.fileData,
        mimeType: data.mimeType || 'application/octet-stream',
      });
    }
  });

  socket.on('send-image', (data = {}) => {
    if (data.fileData) {
      sendMessage('image', data.to, {
        imageName: data.fileName || 'image',
        imageData: data.fileData,
        mimeType: data.mimeType || 'image/png',
      });
    }
  });

  socket.on('edit-message', async ({ id, text } = {}) => {
    if (!username || !id || !text) return;
    const room = userRooms.get(username);
    if (!room) return;
    try {
      const updated = await updateRoomMessage(room, id, {
        text,
        edited: true,
        editedAt: new Date().toISOString(),
      });
      if (updated) {
        io.to(room).emit('message-updated', { room, message: updated });
      }
    } catch (err) {
      console.error('edit-message db error:', err.message);
    }
  });

  socket.on('delete-message', async ({ id } = {}) => {
    if (!username || !id) return;
    const room = userRooms.get(username);
    if (!room) return;
    try {
      const removed = await removeRoomMessage(room, id);
      if (removed) {
        io.to(room).emit('message-deleted', { room, id });
      }
    } catch (err) {
      console.error('delete-message db error:', err.message);
    }
  });

  socket.on('toggle-reaction', async ({ id, emoji } = {}) => {
    if (!username || !id || !emoji) return;
    const room = userRooms.get(username);
    if (!room) return;
    try {
      const history = rooms.get(room);
      const message = (history || []).find((m) => m.id === id);
      if (!message) return;
      const reactions = message.reactions || {};
      const emojiUsers = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
      reactions[emoji] = emojiUsers.includes(username)
        ? emojiUsers.filter((u) => u !== username)
        : [...emojiUsers, username];
      message.reactions = reactions;
      await pool.query(
        'UPDATE messages SET reactions = $1::jsonb WHERE id = $2 AND room_name = $3',
        [JSON.stringify(reactions), id, room]
      );
      io.to(room).emit('message-updated', { room, message });
    } catch (err) {
      console.error('toggle-reaction db error:', err.message);
    }
  });

  // ---------- Typing ----------
  socket.on('typing', () => {
    if (!username) return;
    const room = userRooms.get(username);
    if (!room) return;
    const typing = typingUsers.get(room);
    if (typing) {
      typing.add(username);
      broadcastTyping(room);
    }
  });

  socket.on('stop-typing', () => {
    if (!username) return;
    const room = userRooms.get(username);
    if (!room) return;
    const typing = typingUsers.get(room);
    if (typing) {
      typing.delete(username);
      broadcastTyping(room);
    }
  });

  // ---------- WebRTC calls ----------
  function relayToUser(event, target, payload) {
    if (!target) return;
    const sockets = userSockets.get(target) || [];
    sockets.forEach((s) => s.emit(event, payload));
  }

  socket.on('call-offer', ({ to, offer, type }) => {
    if (!username) return;
    relayToUser('call-offer', to, { from: username, offer, type: type || 'voice' });
  });

  socket.on('call-answer', ({ to, answer }) => {
    if (!username) return;
    relayToUser('call-answer', to, { answer });
  });

  socket.on('call-candidate', ({ to, candidate }) => {
    if (!username) return;
    relayToUser('call-candidate', to, { candidate });
  });

  socket.on('call-decline', ({ to }) => {
    if (!username) return;
    relayToUser('call-decline', to, {});
  });

  socket.on('call-end', ({ to }) => {
    if (!username) return;
    relayToUser('call-end', to, {});
  });

  // ---------- Disconnect ----------
  socket.on('disconnect', () => {
    handleLogout();
    if (username) console.log(`User disconnected: ${username}`);
    username = null;
  });

});

