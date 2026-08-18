// End-to-end smoke test: register, duplicate register, login (good + bad password), message send.
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const USER = 'smoketest_' + Date.now();
const PASS = 'secret123';
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`);
}

function connect(name, password) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], reconnection: false, timeout: 8000 });
    const timer = setTimeout(() => reject(new Error('connect timeout')), 10000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitFor(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

(async () => {
  try {
    // 1. Register a brand-new user
    const reg = await connect(USER, PASS);
    const regOk = waitFor(reg, 'register-success');
    const regBad = waitFor(reg, 'register-error').then(() => 'unexpected-error').catch(() => null);
    reg.emit('register', { name: USER, password: PASS });
    const regMsg = await regOk;
    record('register new account', true, regMsg);
    reg.close();

    // 2. Register the same user again -> should error (duplicate)
    const dup = await connect(USER, PASS);
    const dupErr = waitFor(dup, 'register-error');
    dup.emit('register', { name: USER, password: PASS });
    const dupMsg = await dupErr;
    record('duplicate register rejected', true, dupMsg);
    dup.close();

    // 3. Login with correct password
    const good = await connect(USER, PASS);
    const loginOk = waitFor(good, 'login-success');
    const joined = waitFor(good, 'joined-room');
    good.emit('login', { name: USER, password: PASS });
    const loginUser = await loginOk;
    const joinData = await joined;
    record('login correct password', loginUser === USER, `user=${loginUser} room=${joinData.room}`);
    await new Promise((r) => setTimeout(r, 300));

    // 4. Send a message and receive it back
    const gotMsg = waitFor(good, 'chat-message');
    good.emit('send-message', { text: 'hello from smoke test', to: 'All' });
    const msg = await gotMsg;
    record('send/receive message', msg.text === 'hello from smoke test' && msg.from === USER,
      `room=${msg.room} to=${msg.to}`);
    good.close();

    // 5. Login with wrong password -> should error
    const bad = await connect(USER, 'wrongpass');
    const loginErr = waitFor(bad, 'login-error');
    bad.emit('login', { name: USER, password: 'wrongpass' });
    const errMsg = await loginErr;
    record('login wrong password rejected', true, errMsg);
    bad.close();

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

    // Clean up the test account + messages so the real database stays tidy.
    const { Pool } = require('pg');
    const fs = require('fs');
    fs.readFileSync(require('path').join(__dirname, '..', 'examhub.env'), 'utf8')
      .split(/\r?\n/)
      .forEach((l) => {
        const m = l.match(/^([^#=]+)="?([^"]*)"?$/);
        if (m) process.env[m[1].trim()] = m[2];
      });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query('DELETE FROM messages WHERE from_user = $1', [USER]);
    await pool.query('DELETE FROM room_members WHERE username = $1', [USER]);
    await pool.query('DELETE FROM users WHERE username = $1', [USER]);
    await pool.end();
    console.log('Smoke-test account removed from database.');

    process.exit(failed.length ? 1 : 0);
  } catch (err) {
    console.error('TEST ERROR:', err.message);
    process.exit(1);
  }
})();
