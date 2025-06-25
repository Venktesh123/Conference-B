const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();

// Middleware
app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? ["https://your-frontend-domain.com"]
        : ["http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
  })
);
app.use(express.json());

// Serve static files in production
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "build")));
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin:
      process.env.NODE_ENV === "production"
        ? ["https://your-frontend-domain.com"]
        : ["http://localhost:3000", "http://127.0.0.1:3000"],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Store active rooms and participants
const rooms = {};

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    activeRooms: Object.keys(rooms).length,
  });
});

// API endpoint to create a new room
app.post("/api/room", (req, res) => {
  try {
    const roomId = uuidv4();
    rooms[roomId] = {
      id: roomId,
      participants: {},
      createdAt: new Date(),
      maxParticipants: req.body.maxParticipants || 10,
    };
    console.log(`Created room: ${roomId}`);
    res.json({ roomId, success: true });
  } catch (error) {
    console.error("Error creating room:", error);
    res.status(500).json({ error: "Failed to create room" });
  }
});

// Get room info
app.get("/api/room/:roomId", (req, res) => {
  try {
    const { roomId } = req.params;
    const room = rooms[roomId];

    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    res.json({
      roomId: room.id,
      participantCount: Object.keys(room.participants).length,
      maxParticipants: room.maxParticipants,
      createdAt: room.createdAt,
      participants: Object.values(room.participants).map((p) => ({
        username: p.username,
        joinedAt: p.joinedAt,
        audioEnabled: p.audioEnabled,
        videoEnabled: p.videoEnabled,
      })),
    });
  } catch (error) {
    console.error("Error getting room info:", error);
    res.status(500).json({ error: "Failed to get room info" });
  }
});

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle joining a room
  socket.on("join-room", ({ roomId, username, peerId }) => {
    try {
      console.log(
        `${username} trying to join room ${roomId} with peer ID ${peerId}`
      );

      // Validate input
      if (!roomId || !username || !peerId) {
        socket.emit("room-error", { message: "Missing required parameters" });
        return;
      }

      // Check if room exists
      if (!rooms[roomId]) {
        console.log(`Room ${roomId} does not exist`);
        socket.emit("room-error", { message: "Room does not exist" });
        return;
      }

      // Check room capacity
      const room = rooms[roomId];
      if (Object.keys(room.participants).length >= room.maxParticipants) {
        socket.emit("room-error", { message: "Room is full" });
        return;
      }

      // Check if username is already taken
      const existingUser = Object.values(room.participants).find(
        (p) => p.username === username
      );
      if (existingUser) {
        socket.emit("room-error", { message: "Username already taken" });
        return;
      }

      // Add user to socket room
      socket.join(roomId);

      // Store participant info
      const participantId = socket.id;
      rooms[roomId].participants[participantId] = {
        id: participantId,
        username,
        peerId,
        socketId: socket.id,
        joinedAt: new Date(),
        audioEnabled: true,
        videoEnabled: true,
      };

      console.log(
        `${username} joined room ${roomId}. Total participants: ${
          Object.keys(rooms[roomId].participants).length
        }`
      );

      // Notify existing participants about the new user
      socket.to(roomId).emit("user-joined", {
        participantId,
        username,
        peerId,
      });

      // Send current participants to the new user
      const existingParticipants = {};
      Object.entries(rooms[roomId].participants).forEach(
        ([id, participant]) => {
          if (id !== participantId) {
            existingParticipants[id] = participant;
          }
        }
      );

      socket.emit("room-participants", {
        participants: existingParticipants,
      });

      socket.emit("join-success", {
        roomId,
        participantId,
        username,
      });

      console.log(
        `Sent ${
          Object.keys(existingParticipants).length
        } existing participants to ${username}`
      );
    } catch (error) {
      console.error("Error joining room:", error);
      socket.emit("room-error", { message: "Failed to join room" });
    }
  });

  // Handle user muting/unmuting audio
  socket.on("toggle-audio", ({ roomId, peerId, enabled }) => {
    try {
      console.log(`Audio toggle: ${socket.id} - ${enabled}`);

      if (rooms[roomId] && rooms[roomId].participants[socket.id]) {
        rooms[roomId].participants[socket.id].audioEnabled = enabled;

        // Notify other participants
        socket.to(roomId).emit("user-toggle-audio", {
          participantId: socket.id,
          peerId,
          enabled,
        });
      }
    } catch (error) {
      console.error("Error toggling audio:", error);
    }
  });

  // Handle user muting/unmuting video
  socket.on("toggle-video", ({ roomId, peerId, enabled }) => {
    try {
      console.log(`Video toggle: ${socket.id} - ${enabled}`);

      if (rooms[roomId] && rooms[roomId].participants[socket.id]) {
        rooms[roomId].participants[socket.id].videoEnabled = enabled;

        // Notify other participants
        socket.to(roomId).emit("user-toggle-video", {
          participantId: socket.id,
          peerId,
          enabled,
        });
      }
    } catch (error) {
      console.error("Error toggling video:", error);
    }
  });

  // Handle chat messages
  socket.on("send-message", ({ roomId, message, username }) => {
    try {
      if (rooms[roomId] && rooms[roomId].participants[socket.id]) {
        const chatMessage = {
          id: uuidv4(),
          username,
          message,
          timestamp: new Date(),
          participantId: socket.id,
        };

        // Broadcast to all participants in the room
        io.to(roomId).emit("receive-message", chatMessage);
      }
    } catch (error) {
      console.error("Error sending message:", error);
    }
  });

  // Handle removing a participant (by admin)
  socket.on("remove-participant", ({ roomId, participantId, peerId }) => {
    try {
      console.log(`Removing participant: ${participantId}`);

      if (rooms[roomId] && rooms[roomId].participants[participantId]) {
        // Notify the participant they're being removed
        io.to(participantId).emit("you-were-removed");

        // Notify other participants
        socket.to(roomId).emit("user-removed", {
          participantId,
          peerId,
        });

        // Remove from room data
        delete rooms[roomId].participants[participantId];

        // Force disconnect the removed user
        const targetSocket = io.sockets.sockets.get(participantId);
        if (targetSocket) {
          targetSocket.disconnect(true);
        }
      }
    } catch (error) {
      console.error("Error removing participant:", error);
    }
  });

  // Handle screen sharing
  socket.on("start-screen-share", ({ roomId, peerId }) => {
    try {
      if (rooms[roomId] && rooms[roomId].participants[socket.id]) {
        socket.to(roomId).emit("user-screen-share", {
          participantId: socket.id,
          peerId,
          isSharing: true,
        });
      }
    } catch (error) {
      console.error("Error starting screen share:", error);
    }
  });

  socket.on("stop-screen-share", ({ roomId, peerId }) => {
    try {
      if (rooms[roomId] && rooms[roomId].participants[socket.id]) {
        socket.to(roomId).emit("user-screen-share", {
          participantId: socket.id,
          peerId,
          isSharing: false,
        });
      }
    } catch (error) {
      console.error("Error stopping screen share:", error);
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    try {
      console.log(`User disconnected: ${socket.id}`);

      // Find which room this user was in
      for (const roomId in rooms) {
        if (rooms[roomId].participants[socket.id]) {
          const participant = rooms[roomId].participants[socket.id];

          console.log(`${participant.username} left room ${roomId}`);

          // Notify other participants
          socket.to(roomId).emit("user-left", {
            participantId: socket.id,
            peerId: participant.peerId,
          });

          // Remove from room data
          delete rooms[roomId].participants[socket.id];

          console.log(
            `Room ${roomId} now has ${
              Object.keys(rooms[roomId].participants).length
            } participants`
          );

          // If room is empty, remove it after a delay
          if (Object.keys(rooms[roomId].participants).length === 0) {
            setTimeout(() => {
              if (
                rooms[roomId] &&
                Object.keys(rooms[roomId].participants).length === 0
              ) {
                delete rooms[roomId];
                console.log(
                  `Room ${roomId} has been removed due to inactivity`
                );
              }
            }, 60000); // Remove after 1 minute of inactivity
          }

          break;
        }
      }
    } catch (error) {
      console.error("Error handling disconnect:", error);
    }
  });

  // Handle ping for connection testing
  socket.on("ping", (callback) => {
    if (typeof callback === "function") {
      callback("pong");
    }
  });
});

// Debug endpoint to see all rooms (only in development)
if (process.env.NODE_ENV !== "production") {
  app.get("/api/debug/rooms", (req, res) => {
    try {
      const roomSummary = {};
      Object.keys(rooms).forEach((roomId) => {
        roomSummary[roomId] = {
          participantCount: Object.keys(rooms[roomId].participants).length,
          maxParticipants: rooms[roomId].maxParticipants,
          createdAt: rooms[roomId].createdAt,
          participants: Object.values(rooms[roomId].participants).map((p) => ({
            username: p.username,
            peerId: p.peerId,
            joinedAt: p.joinedAt,
            audioEnabled: p.audioEnabled,
            videoEnabled: p.videoEnabled,
          })),
        };
      });
      res.json(roomSummary);
    } catch (error) {
      console.error("Error getting debug info:", error);
      res.status(500).json({ error: "Failed to get debug info" });
    }
  });
}

// Catch all handler for production
if (process.env.NODE_ENV === "production") {
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "build", "index.html"));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  if (process.env.NODE_ENV !== "production") {
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Debug endpoint: http://localhost:${PORT}/api/debug/rooms`);
  }
});
