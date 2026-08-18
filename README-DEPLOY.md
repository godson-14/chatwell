Deploy notes — Chat App

Database setup (CockroachDB)
- The app connects to CockroachDB through `DATABASE_URL` (see `examhub.env`).
- To build/create the database schema inside CockroachDB, run:

  npm run db:setup

  This applies `schema.sql` (tables: `users`, `rooms`, `messages`, `room_members`,
  plus indexes) and ensures the default `Lobby` room exists. It is safe to re-run.
- The server also verifies/loads the schema state during startup.
- Configure `DATABASE_URL` in the deployment service. Do not commit the connection string
  (`examhub.env` is in `.gitignore`).
- Optional: set `DATABASE_SSL=false` only for a local non-TLS database.

DB Code connection
- In VS Code DB Code, use the `Ifechi-CockroachDB` connection and the database that
  `DATABASE_URL` points to (e.g. `chat well`).
- You can apply `schema.sql` there too (right-click the connection → Run SQL).
- Existing `users.json` and `chat-history.json` records are imported on first startup
  with conflict-safe inserts.

Testing
- With the server running (`npm start`), run the end-to-end auth smoke test:

  npm run test:smoke

  It registers a throwaway user, verifies duplicate rejection, logs in with a correct and
  an incorrect password, sends a chat message, then deletes the test data.

Problem
- Vercel serverless functions are not suitable for long-lived socket servers (Socket.IO). Attempting to run `server.js` as a Vercel Serverless Function will crash or time out.

Recommended fix
- Deploy the Node server as a standalone service (Render, Railway, Fly, DigitalOcean App Platform, or Docker host).
- Keep the static frontend on Vercel (or the same server) and point the client to the server URL.

Quick Deploy (Render)
1. Push your repo to GitHub (already done).
2. Sign in to https://render.com and create a new "Web Service".
   - Connect the GitHub repository and pick the branch (e.g., `master`).
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Port: `3000` (Render sets this automatically via $PORT; `server.js` already uses process.env.PORT)
3. After the service is live, note the service URL `https://your-server.onrender.com`.

Update frontend to use external server
- Edit `public/index.html` and add the following script before the `<script src="/socket.io/socket.io.js"></script>` line, replacing the URL with your deployed server:

<script>
  window.SOCKET_SERVER_URL = 'https://your-server.onrender.com';
</script>

- Or, deploy the entire app from the same server so same-origin will be used.

Docker deploy
- Build and run locally:

```bash
docker build -t chat-app .
docker run -p 3000:3000 chat-app
```

Alternative: Use a managed realtime provider
- If you prefer serverless hosting (Vercel), replace Socket.IO with a managed realtime service like Pusher, Ably, or Supabase Realtime. That requires changing the client to their SDK and using a tiny server to authenticate channels.

I can:
- Add the `window.SOCKET_SERVER_URL` injection to `public/index.html` for you if you tell me the server URL.
- Help create a Render or Railway service from this repo (I can prepare a `render.yaml` or `Dockerfile` — `Dockerfile` is already added).

