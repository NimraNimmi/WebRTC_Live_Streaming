// server.js
// Multi-room live-commerce prototype.
//
// Architecture:
//   - Any connected user can start their OWN live room (become a broadcaster).
//   - A real-time room directory is broadcast to everyone, so new users land
//     on a page listing all currently-live rooms with a "Join" button.
//   - Joining a room subscribes you to that room's WebRTC stream + that
//     room's isolated chat feed. Chat from one room never leaks into another.
//   - "Bids" are just chat messages tagged with an amount (per product
//     decision: text-based bidding, no separate ledger logic yet).
//   - State is in-memory (Map-based). Swapping in MongoDB later only means
//     replacing the functions in the "STATE" section below with DB calls —
//     the Socket.io event contracts do not need to change.
//
// Run: npm install && npm start
// Test with 3 users: open http://localhost:3000 in 3 browser profiles.

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// STATE (in-memory). Swap this section for MongoDB later without touching
// the Socket.io event handlers below — keep the same function signatures.
// ---------------------------------------------------------------------------

/**
 * rooms: Map<roomId, {
 *   roomId, hostId, hostName, itemName, startedAt,
 *   viewerIds: Set<socketId>,
 *   messages: [{ id, authorId, authorName, text, kind: 'chat'|'bid', amount?, timestamp }]
 * }>
 */
const rooms = new Map();

// socketId -> { displayName, currentRoomId | null }
const users = new Map();

function createRoom({ hostId, hostName, itemName }) {
  const roomId = hostId; // one room per host keeps lookups trivial and unique
  const room = {
    roomId,
    hostId,
    hostName,
    itemName: itemName || `${hostName}'s Live Session`,
    startedAt: Date.now(),
    viewerIds: new Set(),
    messages: [],
  };
  rooms.set(roomId, room);
  return room;
}

function endRoom(roomId) {
  rooms.delete(roomId);
}

function getPublicRoomList() {
  return Array.from(rooms.values()).map((r) => ({
    roomId: r.roomId,
    hostName: r.hostName,
    itemName: r.itemName,
    viewerCount: r.viewerIds.size,
    startedAt: r.startedAt,
  }));
}

function broadcastRoomList() {
  io.emit('rooms:list', getPublicRoomList());
}

// ---------------------------------------------------------------------------
// SOCKET.IO EVENT HANDLING
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  users.set(socket.id, { displayName: 'Guest', currentRoomId: null });

  // Always send the current room directory immediately on connect.
  socket.emit('rooms:list', getPublicRoomList());

  socket.on('identity:set', ({ displayName }) => {
    const user = users.get(socket.id);
    if (user) user.displayName = (displayName || 'Guest').slice(0, 30);
  });

  // -----------------------------------------------------------------------
  // GO LIVE — start a new room
  // -----------------------------------------------------------------------
  socket.on('room:create', ({ itemName }) => {
    const user = users.get(socket.id);
    if (!user) return;

    // A user can only host one room at a time.
    if (rooms.has(socket.id)) {
      socket.emit('room:error', { message: 'You are already live.' });
      return;
    }

    const room = createRoom({ hostId: socket.id, hostName: user.displayName, itemName });
    socket.join(room.roomId);
    user.currentRoomId = room.roomId;

    socket.emit('room:created', {
      roomId: room.roomId,
      itemName: room.itemName,
      hostName: room.hostName,
    });
    broadcastRoomList();
  });

  // -----------------------------------------------------------------------
  // JOIN an existing room as a viewer
  // -----------------------------------------------------------------------
  socket.on('room:join', ({ roomId }) => {
    const room = rooms.get(roomId);
    const user = users.get(socket.id);
    if (!room || !user) {
      socket.emit('room:error', { message: 'That live session has ended.' });
      return;
    }
    if (room.hostId === socket.id) return; // host doesn't "join" their own room

    // Leave any previous room first (a viewer can only watch one room at a time).
    if (user.currentRoomId && user.currentRoomId !== roomId) {
      leaveCurrentRoom(socket, user);
    }

    socket.join(roomId);
    room.viewerIds.add(socket.id);
    user.currentRoomId = roomId;

    // Send the new viewer full context: who's hosting + chat history so far.
    socket.emit('room:joined', {
      roomId: room.roomId,
      hostId: room.hostId,
      hostName: room.hostName,
      itemName: room.itemName,
      messages: room.messages,
      viewerCount: room.viewerIds.size,
    });

    // Tell the host a new viewer arrived so they can create a WebRTC offer for them.
    io.to(room.hostId).emit('webrtc:viewer-joined', { viewerId: socket.id });

    io.to(roomId).emit('room:viewerCount', { roomId, viewerCount: room.viewerIds.size });
    broadcastRoomList();
  });

  // -----------------------------------------------------------------------
  // LEAVE a room (explicit, e.g. user clicks "Leave")
  // -----------------------------------------------------------------------
  socket.on('room:leave', () => {
    const user = users.get(socket.id);
    if (!user) return;
    leaveCurrentRoom(socket, user);
  });

  function leaveCurrentRoom(socket, user) {
    const roomId = user.currentRoomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    socket.leave(roomId);
    user.currentRoomId = null;

    if (room && room.viewerIds.has(socket.id)) {
      room.viewerIds.delete(socket.id);
      io.to(roomId).emit('room:viewerCount', { roomId, viewerCount: room.viewerIds.size });
      io.to(roomId).emit('webrtc:peer-disconnected', { peerId: socket.id });
      broadcastRoomList();
    }
  }

  // -----------------------------------------------------------------------
  // END a hosted room (host clicks "End live")
  // -----------------------------------------------------------------------
  socket.on('room:end', () => {
    const user = users.get(socket.id);
    if (!user) return;
    const room = rooms.get(socket.id); // hostId === roomId
    if (!room || room.hostId !== socket.id) return;

    io.to(room.roomId).emit('room:ended', { roomId: room.roomId });
    endRoom(room.roomId);
    user.currentRoomId = null;
    broadcastRoomList();
  });

  // -----------------------------------------------------------------------
  // CHAT + TEXT-BASED BIDDING (scoped strictly to the sender's current room)
  // -----------------------------------------------------------------------
  socket.on('room:message', ({ text, kind, amount }) => {
    const user = users.get(socket.id);
    if (!user || !user.currentRoomId) return;

    const room = rooms.get(user.currentRoomId);
    if (!room) return;
    if (!text || !text.trim()) return;

    const message = {
      id: `${socket.id}-${Date.now()}`,
      authorId: socket.id,
      authorName: user.displayName,
      text: text.trim().slice(0, 280),
      kind: kind === 'bid' ? 'bid' : 'chat',
      amount: kind === 'bid' ? Number(amount) || 0 : undefined,
      timestamp: Date.now(),
    };

    room.messages.push(message);
    if (room.messages.length > 200) room.messages.shift();

    io.to(room.roomId).emit('room:message', message);
  });

  // -----------------------------------------------------------------------
  // WEBRTC SIGNALING — relay only, scoped by explicit target socket id.
  // Since rooms map 1:1 to host socket ids, this naturally stays isolated
  // per room without extra bookkeeping.
  // -----------------------------------------------------------------------
  socket.on('webrtc:offer', ({ to, sdp }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, sdp });
  });

  socket.on('webrtc:answer', ({ to, sdp }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, sdp });
  });

  socket.on('webrtc:ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice-candidate', { from: socket.id, candidate });
  });

  // -----------------------------------------------------------------------
  // DISCONNECT CLEANUP
  // -----------------------------------------------------------------------
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;

    // If this socket was hosting a room, end it for everyone watching.
    if (rooms.has(socket.id)) {
      const room = rooms.get(socket.id);
      io.to(room.roomId).emit('room:ended', { roomId: room.roomId });
      endRoom(socket.id);
    } else if (user.currentRoomId) {
      leaveCurrentRoom(socket, user);
    }

    users.delete(socket.id);
    broadcastRoomList();
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Live-commerce demo running at http://localhost:${PORT}`);
});