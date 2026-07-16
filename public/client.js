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
const currentRoomName = document.getElementById('currentRoomName');

let currentUser = null;
let currentRoom = 'Lobby';
let currentRooms = [];
let pendingInvites = [];
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;

function setStatus(text) {
  statusBox.textContent = text;
}

function addMessage(message) {
  const messageEl = document.createElement('div');
  messageEl.className = 'message';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.innerHTML = `
    <span>${message.from} → ${message.to}</span>
    <span>${message.room}</span>
    <span>${new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
  `;
  messageEl.appendChild(meta);

  if (message.type === 'voice') {
    messageEl.classList.add('voice');
    const label = document.createElement('div');
    label.textContent = 'Voice note:';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = message.audioData;
    messageEl.appendChild(label);
    messageEl.appendChild(audio);
  } else {
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message.text;
    messageEl.appendChild(text);
  }

  messagesContainer.appendChild(messageEl);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
    userEl.textContent = user;
    if (user === currentUser) {
      userEl.textContent += ' (You)';
      userEl.style.opacity = '0.7';
    }
    usersList.appendChild(userEl);
  });
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
    roomButton.textContent = room;
    roomButton.addEventListener('click', () => {
      if (room !== currentRoom) {
        socket.emit('join-room', room);
      }
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

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  const to = recipientSelect.value;
  socket.emit('send-message', { to, text });
  messageInput.value = '';
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
  setStatus('Connected. Enter your name to join.');
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
  loginOverlay.classList.add('hidden');
  chatApp.classList.remove('hidden');
  currentRoomName.textContent = `(Lobby)`;
  setStatus(`Logged in as ${name}. Choose a room, recipient, and send a message or voice note.`);
});

socket.on('room-list', (rooms) => {
  updateRooms(rooms);
});

socket.on('joined-room', ({ room, history }) => {
  currentRoom = room;
  currentRoomName.textContent = `(${room})`;
  updateRooms(currentRooms);
  messagesContainer.innerHTML = '';
  history.forEach(addMessage);
  recipientSelect.value = 'All';
  setStatus(`Joined room ${room}.`);
});

socket.on('create-room-error', (message) => {
  createRoomError.textContent = message;
});

socket.on('invite-error', (message) => {
  setStatus(message);
});

socket.on('private-room-invite', ({ room, from, participants }) => {
  pendingInvites.push({ room, from, participants });
  renderNotifications();
  setStatus(`${from} invited you to private room ${room}.`);
});

socket.on('logged-out', () => {
  currentUser = null;
  currentRoom = 'Lobby';
  currentRooms = [];
  loginOverlay.classList.remove('hidden');
  chatApp.classList.add('hidden');
  loginError.textContent = '';
  usernameInput.value = '';
  if (passwordInput) passwordInput.value = '';
  messagesContainer.innerHTML = '';
  setStatus('Logged out. Please login or register.');
});

socket.on('join-room-error', (message) => {
  setStatus(message);
});

socket.on('user-list', (users) => {
  updateUsers(users);
});

socket.on('chat-message', (message) => {
  const shouldShow =
    message.room === currentRoom ||
    message.to === currentUser ||
    message.from === currentUser;
  if (!shouldShow) {
    return;
  }
  addMessage(message);
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
