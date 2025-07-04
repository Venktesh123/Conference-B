const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Store active rooms, participants, and chat messages
const rooms = {};

app.get("/", (req, res) => {
  res.send("<h1>Video Conference Server is Running</h1>");
});

// API endpoint to create a new room
app.post("/api/room", (req, res) => {
  const roomId = generateRoomId(); // Use a shorter, more user-friendly ID
  rooms[roomId] = {
    id: roomId,
    participants: {},
    waitingRoom: {},
    chatMessages: [],
    hostId: null,
    createdAt: new Date(),
    settings: {
      requireApproval: true,
      allowChat: true,
    },
  };
  console.log(`✅ Created room: ${roomId}`);
  res.json({ roomId });
});

// Generate a shorter, more user-friendly room ID
function generateRoomId() {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// Get room info
app.get("/api/room/:roomId", (req, res) => {
  const { roomId } = req.params;
  const room = rooms[roomId];

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  res.json({
    roomId: room.id,
    participantCount: Object.keys(room.participants).length,
    waitingCount: Object.keys(room.waitingRoom).length,
    hasHost: !!room.hostId,
    settings: room.settings,
    createdAt: room.createdAt,
  });
});

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  // Handle joining a room
  socket.on("join-room", ({ roomId, username, peerId }) => {
    console.log(
      `👤 ${username} trying to join room ${roomId} with peer ID ${peerId}`
    );

    // Check if room exists
    if (!rooms[roomId]) {
      console.log(`❌ Room ${roomId} does not exist`);
      socket.emit("room-error", { message: "Room does not exist" });
      return;
    }

    const room = rooms[roomId];
    const participantId = socket.id;

    // Validate inputs
    if (!username || !peerId || !roomId) {
      socket.emit("room-error", {
        message: "Username, Room ID, and Peer ID are required",
      });
      return;
    }

    // Check for duplicate usernames in both participants and waiting room
    const allUsers = { ...room.participants, ...room.waitingRoom };
    const existingUser = Object.values(allUsers).find(
      (user) => user.username.toLowerCase() === username.toLowerCase()
    );

    if (existingUser) {
      socket.emit("room-error", {
        message:
          "A user with this name is already in the meeting. Please choose a different name.",
      });
      return;
    }

    // If no host exists, make this person the host
    if (!room.hostId || Object.keys(room.participants).length === 0) {
      room.hostId = participantId;

      // Add host directly to the room
      socket.join(roomId);
      room.participants[participantId] = {
        id: participantId,
        username,
        peerId,
        socketId: socket.id,
        joinedAt: new Date(),
        audioEnabled: true,
        videoEnabled: true,
        isHost: true,
      };

      console.log(`👑 ${username} joined as HOST of room ${roomId}`);

      // Emit admission status to the host
      socket.emit("admission-status", {
        status: "approved",
        isHost: true,
        chatMessages: room.chatMessages,
        participants: room.participants,
      });

      // Send current participants (empty for new room)
      socket.emit("room-participants", { participants: {} });
    } else {
      // Add to waiting room for approval
      room.waitingRoom[participantId] = {
        id: participantId,
        username,
        peerId,
        socketId: socket.id,
        requestedAt: new Date(),
      };

      console.log(`⏳ ${username} added to waiting room for room ${roomId}`);

      // Emit waiting status
      socket.emit("admission-status", {
        status: "waiting",
        message: "Waiting for host approval...",
      });

      // Notify host about new participant waiting
      if (room.hostId && io.sockets.sockets.get(room.hostId)) {
        io.to(room.hostId).emit("participant-waiting", {
          participantId,
          username,
          peerId,
          requestedAt: new Date(),
        });

        // Send updated waiting list to host
        const waitingList = Object.values(room.waitingRoom);
        io.to(room.hostId).emit("waiting-room-update", {
          waitingParticipants: waitingList,
        });

        console.log(`📢 Notified host about ${username} waiting to join`);
      }
    }
  });

  // Handle host approving participants
  socket.on("approve-participant", ({ roomId, participantId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("error", {
        message: "Unauthorized: Only host can approve participants",
      });
      return;
    }

    const waitingParticipant = room.waitingRoom[participantId];
    if (!waitingParticipant) {
      socket.emit("error", {
        message: "Participant not found in waiting room",
      });
      return;
    }

    // Move from waiting room to participants
    room.participants[participantId] = {
      ...waitingParticipant,
      joinedAt: new Date(),
      audioEnabled: true,
      videoEnabled: true,
      isHost: false,
    };

    delete room.waitingRoom[participantId];

    // Join the socket to the room
    const participantSocket = io.sockets.sockets.get(participantId);
    if (participantSocket) {
      participantSocket.join(roomId);

      // Notify approved participant
      participantSocket.emit("admission-status", {
        status: "approved",
        isHost: false,
        chatMessages: room.chatMessages,
      });

      // Send existing participants to newly approved user
      const existingParticipants = {};
      Object.entries(room.participants).forEach(([id, participant]) => {
        if (id !== participantId) {
          existingParticipants[id] = participant;
        }
      });

      participantSocket.emit("room-participants", {
        participants: existingParticipants,
      });

      // Notify existing participants about new user
      socket.to(roomId).emit("user-joined", {
        participantId,
        username: waitingParticipant.username,
        peerId: waitingParticipant.peerId,
      });

      console.log(
        `✅ Host approved ${waitingParticipant.username} to join room ${roomId}`
      );
    }

    // Update waiting room for host
    const waitingList = Object.values(room.waitingRoom);
    socket.emit("waiting-room-update", { waitingParticipants: waitingList });
  });

  // Handle host denying participants
  socket.on("deny-participant", ({ roomId, participantId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("error", {
        message: "Unauthorized: Only host can deny participants",
      });
      return;
    }

    const waitingParticipant = room.waitingRoom[participantId];
    if (!waitingParticipant) {
      socket.emit("error", {
        message: "Participant not found in waiting room",
      });
      return;
    }

    // Notify denied participant
    const participantSocket = io.sockets.sockets.get(participantId);
    if (participantSocket) {
      participantSocket.emit("admission-status", {
        status: "denied",
        message:
          "Access denied by host. The host has rejected your request to join this meeting.",
      });

      // Disconnect the denied participant after a delay
      setTimeout(() => {
        participantSocket.disconnect(true);
      }, 2000);
    }

    delete room.waitingRoom[participantId];
    console.log(
      `❌ Host denied ${waitingParticipant.username} access to room ${roomId}`
    );

    // Update waiting room for host
    const waitingList = Object.values(room.waitingRoom);
    socket.emit("waiting-room-update", { waitingParticipants: waitingList });
  });

  // Handle chat messages
  socket.on("send-message", ({ roomId, message, username }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }

    if (!room.participants[socket.id]) {
      socket.emit("error", { message: "You are not in this room" });
      return;
    }

    if (!message || message.trim().length === 0) {
      socket.emit("error", { message: "Message cannot be empty" });
      return;
    }

    if (message.trim().length > 500) {
      socket.emit("error", {
        message: "Message too long (max 500 characters)",
      });
      return;
    }

    const chatMessage = {
      id: uuidv4(),
      username,
      message: message.trim(),
      timestamp: new Date(),
      senderId: socket.id,
      isHost: room.hostId === socket.id,
    };

    // Store message in room
    room.chatMessages.push(chatMessage);

    // Keep only last 100 messages
    if (room.chatMessages.length > 100) {
      room.chatMessages = room.chatMessages.slice(-100);
    }

    // Broadcast message to all participants in the room
    io.to(roomId).emit("new-message", chatMessage);

    console.log(`💬 ${username} sent message in room ${roomId}`);
  });

  // Handle audio/video toggles
  socket.on("toggle-audio", ({ roomId, peerId, enabled }) => {
    const room = rooms[roomId];
    if (room && room.participants[socket.id]) {
      room.participants[socket.id].audioEnabled = enabled;
      socket.to(roomId).emit("user-toggle-audio", {
        participantId: socket.id,
        peerId,
        enabled,
      });
    }
  });

  socket.on("toggle-video", ({ roomId, peerId, enabled }) => {
    const room = rooms[roomId];
    if (room && room.participants[socket.id]) {
      room.participants[socket.id].videoEnabled = enabled;
      socket.to(roomId).emit("user-toggle-video", {
        participantId: socket.id,
        peerId,
        enabled,
      });
    }
  });

  // Handle removing a participant (by host)
  socket.on("remove-participant", ({ roomId, participantId, peerId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("error", {
        message: "Unauthorized: Only host can remove participants",
      });
      return;
    }

    if (room.participants[participantId]) {
      const removedParticipant = room.participants[participantId];

      // Notify the participant they're being removed
      io.to(participantId).emit("you-were-removed", {
        message: "You have been removed from the meeting by the host",
      });

      // Notify other participants
      socket.to(roomId).emit("user-removed", {
        participantId,
        peerId,
        username: removedParticipant.username,
      });

      // Remove from room data
      delete room.participants[participantId];

      // Force disconnect the removed user
      const removedSocket = io.sockets.sockets.get(participantId);
      if (removedSocket) {
        setTimeout(() => {
          removedSocket.disconnect(true);
        }, 1000);
      }

      console.log(
        `🚫 Host removed ${removedParticipant.username} from room ${roomId}`
      );
    }
  });

  // Get waiting room participants (for host)
  socket.on("get-waiting-room", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("error", {
        message: "Unauthorized: Only host can view waiting room",
      });
      return;
    }

    const waitingList = Object.values(room.waitingRoom);
    socket.emit("waiting-room-update", { waitingParticipants: waitingList });
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`🔌 User disconnected: ${socket.id}`);

    // Find which room this user was in
    for (const roomId in rooms) {
      const room = rooms[roomId];

      // Check if user was in participants
      if (room.participants[socket.id]) {
        const participant = room.participants[socket.id];
        console.log(`👋 ${participant.username} left room ${roomId}`);

        // If this was the host, transfer host to another participant
        if (room.hostId === socket.id) {
          const remainingParticipants = Object.keys(room.participants).filter(
            (id) => id !== socket.id
          );

          if (remainingParticipants.length > 0) {
            // Transfer host to first remaining participant
            const newHostId = remainingParticipants[0];
            room.hostId = newHostId;
            room.participants[newHostId].isHost = true;

            io.to(newHostId).emit("host-transferred", {
              isHost: true,
              message: "You are now the host of this meeting",
            });

            io.to(roomId).emit("host-changed", {
              newHostId,
              newHostUsername: room.participants[newHostId].username,
              message: `${room.participants[newHostId].username} is now the host`,
            });

            console.log(
              `👑 Host transferred to ${room.participants[newHostId].username}`
            );
          } else {
            room.hostId = null;
          }
        }

        // Notify other participants
        socket.to(roomId).emit("user-left", {
          participantId: socket.id,
          peerId: participant.peerId,
          username: participant.username,
        });

        // Remove from room data
        delete room.participants[socket.id];
      }

      // Check if user was in waiting room
      if (room.waitingRoom[socket.id]) {
        const waitingParticipant = room.waitingRoom[socket.id];
        delete room.waitingRoom[socket.id];

        // Update waiting room for host
        if (room.hostId) {
          const waitingList = Object.values(room.waitingRoom);
          io.to(room.hostId).emit("waiting-room-update", {
            waitingParticipants: waitingList,
          });
        }

        console.log(
          `⏳ ${waitingParticipant.username} left waiting room for ${roomId}`
        );
      }

      // Clean up empty rooms
      if (
        Object.keys(room.participants).length === 0 &&
        Object.keys(room.waitingRoom).length === 0
      ) {
        setTimeout(() => {
          if (
            rooms[roomId] &&
            Object.keys(rooms[roomId].participants).length === 0 &&
            Object.keys(rooms[roomId].waitingRoom).length === 0
          ) {
            delete rooms[roomId];
            console.log(`🗑️ Room ${roomId} has been removed due to inactivity`);
          }
        }, 30000); // Remove after 30 seconds of inactivity
      }
    }
  });

  // Handle ping for connection testing
  socket.on("ping", (callback) => {
    if (typeof callback === "function") {
      callback("pong");
    }
  });
});

// Debug endpoint to see all rooms
app.get("/api/debug/rooms", (req, res) => {
  const roomSummary = {};
  Object.keys(rooms).forEach((roomId) => {
    const room = rooms[roomId];
    roomSummary[roomId] = {
      participantCount: Object.keys(room.participants).length,
      waitingCount: Object.keys(room.waitingRoom).length,
      messageCount: room.chatMessages.length,
      hostId: room.hostId,
      createdAt: room.createdAt,
      participants: Object.values(room.participants).map((p) => ({
        username: p.username,
        isHost: p.isHost,
        joinedAt: p.joinedAt,
      })),
      waiting: Object.values(room.waitingRoom).map((p) => ({
        username: p.username,
        requestedAt: p.requestedAt,
      })),
    };
  });
  res.json(roomSummary);
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    rooms: Object.keys(rooms).length,
    totalParticipants: Object.values(rooms).reduce(
      (sum, room) => sum + Object.keys(room.participants).length,
      0
    ),
    totalWaiting: Object.values(rooms).reduce(
      (sum, room) => sum + Object.keys(room.waitingRoom).length,
      0
    ),
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔧 Debug endpoint: http://localhost:${PORT}/api/debug/rooms`);
  console.log(`❤️ Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.log("Shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
