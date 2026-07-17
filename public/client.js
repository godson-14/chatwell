// Allow connecting to an external socket server by setting
// `window.SOCKET_SERVER_URL` in the page (optional). Falls back to same origin.
const SOCKET_SERVER_URL = (typeof window !== 'undefined' && window.SOCKET_SERVER_URL)
  ? window.SOCKET_SERVER_URL
  : (location.protocol + '//' + location.hostname + (location.port ? ':' + location.port : ''));
const socket = io(SOCKET_SERVER_URL);
const loginOverlay = document.getElementById('loginOverlay');
const loginForm = document.getElementById('loginForm');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const registerForm = document.getElementById('registerForm');
const registerUsernameInput = document.getElementById('registerUsernameInput');
const registerPasswordInput = document.getElementById('registerPasswordInput');
const registerConfirmInput = document.getElementById('registerConfirmInput');
const showLoginBtn = document.getElementById('showLoginBtn');
const showRegisterBtn = document.getElementById('showRegisterBtn');
const loginError = document.getElementById('loginError');
const chatApp = document.getElementById('chatApp');
const messagesContainer = document.getElementById('messages');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const recipientSelect = document.getElementById('recipientSelect');
const usersList = document.getElementById('usersList');
const statusBox = document.getElementById('statusBox');
const voiceButton = document.getElementById('voiceButton');
const recordingIndicator = document.getElementById('recordingIndicator');
const roomsList = document.getElementById('roomsList');
const notificationsList = document.getElementById('notificationsList');
const createRoomForm = document.getElementById('createRoomForm');
const newRoomInput = document.getElementById('newRoomInput');
const createRoomError = document.getElementById('createRoomError');
const logoutButton = document.getElementById('logoutButton');
const inviteButton = document.getElementById('inviteButton');
const groupInviteButton = document.getElementById('groupInviteButton');
const currentRoomName = document.getElementById('currentRoomName');
const searchInput = document.getElementById('searchInput');
const typingIndicator = document.getElementById('typingIndicator');
const emojiPicker = document.getElementById('emojiPicker');
const emojiButton = document.getElementById('emojiButton');
const fileInput = document.getElementById('fileInput');
const themeToggle = document.getElementById('themeToggle');
const soundToggle = document.getElementById('soundToggle');
const mobileToggle = document.getElementById('mobileToggle');
const sidebar = document.getElementById('sidebar');
const clearRoomButton = document.getElementById('clearRoomButton');
const lockRoomButton = document.getElementById('lockRoomButton');

let currentUser = null;
let currentRoom = 'Lobby';
let currentRooms = [];
let pendingInvites = [];
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let roomMessages = new Map();
let editingMessageId = null;
let typingTimer = null;
let typingActive = false;
let activeTypingUsers = [];
let unreadRooms = new Set();
let readReceipts = new Map();
let currentTheme = localStorage.getItem('chatwell-theme') || 'dark';
let soundEnabled = true;

function setStatus(text) {
  statusBox.textContent = text;
}

function applyTheme(theme) {
  currentTheme = theme;
  document.body.dataset.theme = theme;
  localStorage.setItem('chatwell-theme', theme);
  themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function updateTypingIndicator() {
  const visible = activeTypingUsers.filter((user) => user !== currentUser);
  typingIndicator.textContent = visible.length
    ? `${visible.join(', ')} ${visible.length === 1 ? 'is' : 'are'} typing...`
    : '';
}

function renderMessages() {
  const roomMessagesForCurrentRoom = roomMessages.get(currentRoom) || [];
  const searchTerm = searchInput.value.trim().toLowerCase();
  const filtered = roomMessagesForCurrentRoom.filter((message) => {
    if (!searchTerm) return true;
    const haystack = `${message.from || ''} ${message.to || ''} ${message.text || ''} ${message.fileName || ''}`.toLowerCase();
    return haystack.includes(searchTerm);
  });

  messagesContainer.innerHTML = '';
  const grouped = [];
  filtered.forEach((message) => {
    const day = new Date(message.time).toLocaleDateString();
    const previous = grouped[grouped.length - 1];
    if (!previous || previous.day !== day) {
      grouped.push({ day, items: [message] });
    } else {
      previous.items.push(message);
    }
  });

  grouped.forEach(({ day, items }) => {
    const divider = document.createElement('div');
    divider.className = 'day-divider';
    divider.textContent = day;
    messagesContainer.appendChild(divider);
    items.forEach((message) => messagesContainer.appendChild(createMessageElement(message)));
  });
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function getAvatarInitials(name) {
  return (name || 'U').split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase();
}

function createMessageElement(message) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${message.from === currentUser ? 'own' : ''}`;
  wrapper.dataset.messageId = message.id;

  const header = document.createElement('div');
  header.className = 'message-header';
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = getAvatarInitials(message.from);
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const timeLabel = new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.innerHTML = `
    <span>${message.from} → ${message.to}</span>
    <span>${message.room}</span>
    <span>${timeLabel}</span>
  `;
  header.appendChild(avatar);
  header.appendChild(meta);
  wrapper.appendChild(header);

  if (message.type === 'voice') {
    wrapper.classList.add('voice');
    const label = document.createElement('div');
    label.textContent = 'Voice note:';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = message.audioData;
    wrapper.appendChild(label);
    wrapper.appendChild(audio);
  } else if (message.type === 'file') {
    wrapper.classList.add('file');
    const fileLink = document.createElement('a');
    fileLink.className = 'file-link';
    fileLink.href = message.fileData;
    fileLink.download = message.fileName || 'attachment';
    fileLink.textContent = `📎 ${message.fileName || 'attachment'}`;
    wrapper.appendChild(fileLink);
  } else if (message.type === 'image') {
    wrapper.classList.add('image');
    const image = document.createElement('img');
    image.className = 'message-image';
    image.src = message.imageData;
    image.alt = message.imageName || 'Shared image';
    wrapper.appendChild(image);
  } else {
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message.text || '';
    wrapper.appendChild(text);
  }

  if (message.edited) {
    const editedLabel = document.createElement('div');
    editedLabel.className = 'edited-label';
    editedLabel.textContent = 'Edited';
    wrapper.appendChild(editedLabel);
  }

  const statusRow = document.createElement('div');
  statusRow.className = 'message-status';
  const seen = message.from === currentUser && readReceipts.get(currentRoom);
  statusRow.textContent = seen ? 'Seen' : 'Delivered';
  wrapper.appendChild(statusRow);

  const reactionWrap = document.createElement('div');
  reactionWrap.className = 'reaction-wrap';
  const reactionButtons = ['👍', '❤️', '😂', '🔥', '🎉'];
  reactionButtons.forEach((emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reaction-button';
    button.textContent = emoji;
    button.addEventListener('click', () => {
      socket.emit('toggle-reaction', { id: message.id, emoji });
    });
    reactionWrap.appendChild(button);
  });

  const reactionList = document.createElement('div');
  reactionList.className = 'reaction-list';
  Object.entries(message.reactions || {}).forEach(([emoji, users]) => {
    if (Array.isArray(users) && users.length) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'reaction-pill';
      pill.textContent = `${emoji} ${users.length}`;
      pill.addEventListener('click', () => {
        socket.emit('toggle-reaction', { id: message.id, emoji });
      });
      reactionList.appendChild(pill);
    }
  });

  wrapper.appendChild(reactionWrap);
  if (reactionList.children.length) {
    wrapper.appendChild(reactionList);
  }

  if (message.from === currentUser) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.textContent = 'Edit';
    editButton.addEventListener('click', () => {
      editingMessageId = message.id;
      sendButton.textContent = 'Save';
      messageInput.value = message.text || '';
      messageInput.focus();
    });
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => {
      socket.emit('delete-message', { id: message.id });
    });
    actions.appendChild(editButton);
    actions.appendChild(deleteButton);
    wrapper.appendChild(actions);
  }

  return wrapper;
}

function updateUsers(users) {
  recipientSelect.innerHTML = '<option value="All">All</option>';
  usersList.innerHTML = '';

  users.forEach((user) => {
    const option = document.createElement('option');
    option.value = user;
    option.textContent = user;
    recipientSelect.appendChild(option);

    const userEl = document.createElement('div');
    userEl.className = 'user-badge';
    userEl.innerHTML = `<span class="avatar small">${getAvatarInitials(user)}</span><span class="presence-dot"></span><span>${user}${user === currentUser ? ' (You)' : ''}</span>`;
    usersList.appendChild(userEl);
  });
}

function playSound(name) {
  if (!soundEnabled) return;
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = new AudioCtor();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = name === 'mention' ? 660 : name === 'invite' ? 520 : 440;
    gain.gain.value = 0.06;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.12);
    setTimeout(() => ctx.close(), 200);
  } catch (error) {
    // Ignore browser audio limitations.
  }
}

function markRoomRead(room) {
  unreadRooms.delete(room);
  readReceipts.set(room, Date.now());
  updateRooms(currentRooms);
}

function updateRooms(rooms) {
  currentRooms = rooms;
  roomsList.innerHTML = '';
  rooms.forEach((room) => {
    const roomButton = document.createElement('button');
    roomButton.type = 'button';
    roomButton.className = 'room-button';
    if (room === currentRoom) {
      roomButton.classList.add('active');
    }
    if (unreadRooms.has(room)) {
      roomButton.classList.add('unread');
      roomButton.textContent = `${room} •`;
    } else {
      roomButton.textContent = room;
    }
    roomButton.addEventListener('click', () => {
      if (room !== currentRoom) {
        socket.emit('join-room', room);
      }
      markRoomRead(room);
    });
    roomsList.appendChild(roomButton);
  });
}

function renderNotifications() {
  notificationsList.innerHTML = '';
  pendingInvites.forEach((invite, index) => {
    const card = document.createElement('div');
    card.className = 'notification-card';
    const text = document.createElement('p');
    text.textContent = `${invite.from} invited you to join room ${invite.room}. Participants: ${invite.participants.join(', ')}.`;
    const actions = document.createElement('div');
    actions.className = 'notification-actions';
    const acceptButton = document.createElement('button');
    acceptButton.type = 'button';
    acceptButton.className = 'accept';
    acceptButton.textContent = 'Accept';
    acceptButton.addEventListener('click', () => {
      socket.emit('accept-private-room', invite.room);
      pendingInvites.splice(index, 1);
      renderNotifications();
    });
    const declineButton = document.createElement('button');
    declineButton.type = 'button';
    declineButton.className = 'decline';
    declineButton.textContent = 'Decline';
    declineButton.addEventListener('click', () => {
      pendingInvites.splice(index, 1);
      renderNotifications();
    });
    actions.appendChild(acceptButton);
    actions.appendChild(declineButton);
    card.appendChild(text);
    card.appendChild(actions);
    notificationsList.appendChild(card);
  });
}

function stopTyping() {
  if (typingTimer) {
    clearTimeout(typingTimer);
  }
  if (typingActive) {
    socket.emit('stop-typing');
    typingActive = false;
  }
}

function startTyping() {
  if (!typingActive) {
    socket.emit('typing');
    typingActive = true;
  }
  if (typingTimer) {
    clearTimeout(typingTimer);
  }
  typingTimer = setTimeout(stopTyping, 1400);
}

function resetComposer() {
  editingMessageId = null;
  sendButton.textContent = 'Send';
  messageInput.value = '';
  messageInput.focus();
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  loginError.textContent = '';
  const name = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!name || !password) {
    loginError.textContent = 'Username and password are required.';
    return;
  }
  socket.emit('login', { name, password });
});

registerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  loginError.textContent = '';
  const name = registerUsernameInput.value.trim();
  const password = registerPasswordInput.value;
  const confirm = registerConfirmInput.value;

  if (!name || !password) {
    loginError.textContent = 'Username and password are required.';
    return;
  }
  if (password !== confirm) {
    loginError.textContent = 'Passwords do not match.';
    return;
  }
  if (password.length < 6) {
    loginError.textContent = 'Password must be at least 6 characters.';
    return;
  }
  socket.emit('register', { name, password });
});

showLoginBtn.addEventListener('click', () => {
  loginForm.classList.remove('hidden');
  registerForm.classList.add('hidden');
  showLoginBtn.classList.add('active');
  showRegisterBtn.classList.remove('active');
  loginError.textContent = '';
});

showRegisterBtn.addEventListener('click', () => {
  loginForm.classList.add('hidden');
  registerForm.classList.remove('hidden');
  showLoginBtn.classList.remove('active');
  showRegisterBtn.classList.add('active');
  loginError.textContent = '';
});

createRoomForm.addEventListener('submit', (event) => {
  event.preventDefault();
  createRoomError.textContent = '';
  const roomName = newRoomInput.value.trim();
  if (!roomName) {
    createRoomError.textContent = 'Please enter a room name.';
    return;
  }
  socket.emit('create-room', roomName);
  newRoomInput.value = '';
});

logoutButton.addEventListener('click', () => {
  socket.emit('logout');
});

inviteButton.addEventListener('click', () => {
  const targets = prompt('Enter usernames to invite for a private room, separated by commas:');
  if (!targets) return;
  const cleaned = targets
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name && name !== currentUser);
  if (!cleaned.length) {
    setStatus('No valid usernames entered.');
    return;
  }
  socket.emit('invite-private', { targets: cleaned });
});

groupInviteButton.addEventListener('click', () => {
  if (!currentRoom) {
    setStatus('You must be in a room to send a group invite.');
    return;
  }
  const memberCount = usersList.children.length;
  if (memberCount <= 0) {
    setStatus('No other members are in the room to invite.');
    return;
  }
  socket.emit('group-invite');
  setStatus(`Group invite sent for room ${currentRoom}. Inviting ${memberCount} member(s).`);
});

searchInput.addEventListener('input', renderMessages);

emojiButton.addEventListener('click', () => {
  emojiPicker.classList.toggle('hidden');
});

emojiPicker.addEventListener('click', (event) => {
  const emoji = event.target.dataset.emoji;
  if (!emoji) return;
  messageInput.value = `${messageInput.value}${emoji}`;
  messageInput.focus();
});

fileInput.addEventListener('change', (event) => {
  const [file] = event.target.files || [];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const payload = {
      to: recipientSelect.value,
      fileName: file.name,
      mimeType: file.type,
      fileData: reader.result,
    };
    if (file.type.startsWith('image/')) {
      socket.emit('send-image', payload);
    } else {
      socket.emit('send-file', payload);
    }
    fileInput.value = '';
  };
  reader.readAsDataURL(file);
});

themeToggle.addEventListener('click', () => {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

soundToggle.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  soundToggle.textContent = soundEnabled ? '🔊' : '🔈';
  soundToggle.title = soundEnabled ? 'Mute sounds' : 'Enable sounds';
});

mobileToggle.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

clearRoomButton.addEventListener('click', () => {
  if (!currentRoom) return;
  roomMessages.set(currentRoom, []);
  if (currentRoom !== 'Lobby') {
    socket.emit('clear-room', currentRoom);
  }
  renderMessages();
  setStatus(`Cleared ${currentRoom}`);
});

lockRoomButton.addEventListener('click', () => {
  if (!currentRoom) return;
  socket.emit('lock-room', currentRoom);
  setStatus(`${currentRoom} lock toggled`);
});

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text && !editingMessageId) return;
  if (editingMessageId) {
    socket.emit('edit-message', { id: editingMessageId, text });
    editingMessageId = null;
    sendButton.textContent = 'Send';
  } else {
    socket.emit('send-message', { text, to: recipientSelect.value });
  }
  stopTyping();
  resetComposer();
});

messageInput.addEventListener('focus', startTyping);
messageInput.addEventListener('input', () => {
  if (!messageInput.value.trim()) {
    stopTyping();
    return;
  }
  startTyping();
});
messageInput.addEventListener('blur', stopTyping);

socket.on('connect', () => {
  setStatus('Connected');
});

socket.on('login-success', (username) => {
  currentUser = username;
  chatApp.classList.remove('hidden');
  loginOverlay.classList.add('hidden');
  setStatus(`Logged in as ${username}`);
});

socket.on('logged-out', () => {
  currentUser = null;
  currentRoom = 'Lobby';
  roomMessages.clear();
  editingMessageId = null;
  activeTypingUsers = [];
  unreadRooms.clear();
  readReceipts.clear();
  updateTypingIndicator();
  messagesContainer.innerHTML = '';
  chatApp.classList.add('hidden');
  loginOverlay.classList.remove('hidden');
  setStatus('Logged out');
});

socket.on('register-success', (message) => {
  loginError.textContent = message;
});

socket.on('register-error', (message) => {
  loginError.textContent = message;
});

socket.on('login-error', (message) => {
  loginError.textContent = message;
});

socket.on('room-list', (rooms) => {
  updateRooms(rooms);
});

socket.on('joined-room', ({ room, history }) => {
  currentRoom = room;
  currentRoomName.textContent = `(${room})`;
  roomMessages.set(room, history || []);
  markRoomRead(room);
  renderMessages();
  updateRooms(currentRooms);
});

socket.on('user-list', (users) => {
  updateUsers(users);
});

socket.on('chat-message', (message) => {
  if (!roomMessages.has(message.room)) {
    roomMessages.set(message.room, []);
  }
  const roomHistory = roomMessages.get(message.room);
  if (!roomHistory.some((entry) => entry.id === message.id)) {
    roomHistory.push(message);
  }
  if (message.room !== currentRoom) {
    unreadRooms.add(message.room);
    updateRooms(currentRooms);
  }
  if (message.room === currentRoom) {
    renderMessages();
  }
  if (message.from !== currentUser) {
    if (message.text && currentUser && message.text.includes(currentUser)) {
      playSound('mention');
    } else {
      playSound('message');
    }
  }
});

socket.on('message-updated', ({ room, message }) => {
  if (!roomMessages.has(room)) {
    roomMessages.set(room, []);
  }
  const roomHistory = roomMessages.get(room);
  const index = roomHistory.findIndex((entry) => entry.id === message.id);
  if (index >= 0) {
    roomHistory[index] = message;
  } else {
    roomHistory.push(message);
  }
  if (room === currentRoom) {
    renderMessages();
  }
});

socket.on('message-deleted', ({ room, id }) => {
  if (!roomMessages.has(room)) return;
  const roomHistory = roomMessages.get(room);
  const next = roomHistory.filter((entry) => entry.id !== id);
  roomMessages.set(room, next);
  if (room === currentRoom) {
    renderMessages();
  }
});

socket.on('typing-update', ({ room, users }) => {
  if (room === currentRoom) {
    activeTypingUsers = users;
    updateTypingIndicator();
  }
});

socket.on('private-room-invite', (invite) => {
  pendingInvites.push(invite);
  renderNotifications();
  playSound('invite');
  setStatus(`Invite received for ${invite.room}`);
});

socket.on('invite-success', ({ room }) => {
  setStatus(`Invite created for ${room}`);
});

socket.on('join-room-error', (message) => {
  setStatus(message);
});

socket.on('create-room-error', (message) => {
  createRoomError.textContent = message;
});

socket.on('invite-error', (message) => {
  setStatus(message);
});

applyTheme(currentTheme);

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text && !editingMessageId) return;
  if (editingMessageId) {
    socket.emit('edit-message', { id: editingMessageId, text });
    editingMessageId = null;
    sendButton.textContent = 'Send';
  } else {
    socket.emit('send-message', { text, to: recipientSelect.value });
  }
  stopTyping();
  resetComposer();
});

voiceButton.addEventListener('click', async () => {
  if (!mediaRecorder) {
    setStatus('Microphone access is required to record voice notes.');
    return;
  }

  if (!isRecording) {
    recordedChunks = [];
    mediaRecorder.start();
    isRecording = true;
    recordingIndicator.classList.remove('hidden');
    voiceButton.textContent = 'Stop recording';
    setStatus('Recording voice note...');
  } else {
    mediaRecorder.stop();
  }
});

socket.on('connect', () => {
  setStatus('Connected');
});

socket.on('disconnect', () => {
  setStatus('Disconnected. Reload to reconnect.');
});

socket.on('login-error', (message) => {
  loginError.textContent = message;
});

socket.on('register-error', (message) => {
  loginError.textContent = message;
});

socket.on('register-success', (message) => {
  loginError.textContent = message;
  showLoginBtn.click();
});

socket.on('login-success', (name) => {
  currentUser = name;
  chatApp.classList.remove('hidden');
  loginOverlay.classList.add('hidden');
  currentRoomName.textContent = '(Lobby)';
  setStatus(`Logged in as ${name}`);
});

socket.on('room-list', (rooms) => {
  updateRooms(rooms);
});

socket.on('joined-room', ({ room, history }) => {
  currentRoom = room;
  currentRoomName.textContent = `(${room})`;
  roomMessages.set(room, history || []);
  markRoomRead(room);
  renderMessages();
  updateRooms(currentRooms);
  recipientSelect.value = 'All';
});

socket.on('create-room-error', (message) => {
  createRoomError.textContent = message;
});

socket.on('invite-error', (message) => {
  setStatus(message);
});

socket.on('invite-success', ({ room }) => {
  setStatus(`Invite created for ${room}`);
});

socket.on('private-room-invite', (invite) => {
  pendingInvites.push(invite);
  renderNotifications();
  playSound('invite');
  setStatus(`Invite received for ${invite.room}`);
});

socket.on('logged-out', () => {
  currentUser = null;
  currentRoom = 'Lobby';
  roomMessages.clear();
  editingMessageId = null;
  activeTypingUsers = [];
  unreadRooms.clear();
  readReceipts.clear();
  updateTypingIndicator();
  messagesContainer.innerHTML = '';
  chatApp.classList.add('hidden');
  loginOverlay.classList.remove('hidden');
  setStatus('Logged out');
});

socket.on('join-room-error', (message) => {
  setStatus(message);
});

socket.on('user-list', (users) => {
  updateUsers(users);
});

socket.on('chat-message', (message) => {
  if (!roomMessages.has(message.room)) {
    roomMessages.set(message.room, []);
  }
  const roomHistory = roomMessages.get(message.room);
  if (!roomHistory.some((entry) => entry.id === message.id)) {
    roomHistory.push(message);
  }
  if (message.room !== currentRoom) {
    unreadRooms.add(message.room);
    updateRooms(currentRooms);
  }
  if (message.room === currentRoom) {
    renderMessages();
  }
  if (message.from !== currentUser) {
    if (message.text && currentUser && message.text.includes(currentUser)) {
      playSound('mention');
    } else {
      playSound('message');
    }
  }
});

async function setupMedia() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener('stop', async () => {
      isRecording = false;
      recordingIndicator.classList.add('hidden');
      voiceButton.textContent = 'Record voice note';

      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      const reader = new FileReader();

      reader.onloadend = () => {
        const audioData = reader.result;
        socket.emit('send-voice', {
          to: recipientSelect.value,
          audioData,
          audioType: blob.type,
        });
        setStatus('Voice note sent.');
      };
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    setStatus('Unable to access microphone. Voice notes will be unavailable.');
    voiceButton.disabled = true;
  }
}

setupMedia();
