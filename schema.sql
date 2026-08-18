-- ============================================================
-- Chat App schema for CockroachDB (PostgreSQL-compatible DDL)
-- Apply via:  npm run db:setup   (or run in DB Code against
--             the `Ifechi-CockroachDB` connection)
-- ============================================================

-- Users (accounts used by the Register / Login forms)
CREATE TABLE IF NOT EXISTS users (
  username      STRING PRIMARY KEY,
  salt          STRING NOT NULL,
  password_hash STRING NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rooms (chat rooms; private rooms are created via invitations)
CREATE TABLE IF NOT EXISTS rooms (
  name        STRING PRIMARY KEY,
  is_private  BOOL NOT NULL DEFAULT false,
  locked      BOOL NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Membership for private/invite-only rooms
CREATE TABLE IF NOT EXISTS room_members (
  room_name STRING NOT NULL,
  username  STRING NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_name, username)
);

CREATE INDEX IF NOT EXISTS room_members_by_user ON room_members (username);

-- Messages (text, files, images, voice notes)
CREATE TABLE IF NOT EXISTS messages (
  id          STRING PRIMARY KEY,
  room_name   STRING NOT NULL,
  message_type STRING NOT NULL,
  from_user   STRING NOT NULL,
  to_user     STRING NOT NULL DEFAULT 'All',
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited      BOOL NOT NULL DEFAULT false,
  edited_at   TIMESTAMPTZ,
  text        STRING,
  file_name   STRING,
  file_data   STRING,
  mime_type   STRING,
  image_name  STRING,
  image_data  STRING,
  audio_data  STRING,
  audio_type  STRING,
  reactions   JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS messages_by_room ON messages (room_name, sent_at);
CREATE INDEX IF NOT EXISTS messages_by_user ON messages (from_user);
