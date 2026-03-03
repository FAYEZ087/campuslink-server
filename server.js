const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
       origin: "*", // your Next.js frontend
        methods: ["GET", "POST"],
    },
});

// ─── State ────────────────────────────────────────────────────────────────────
const waitingQueue = []; // users waiting to be matched  [ { socketId, interests } ]
const activePairs = {}; // socketId → partnerSocketId
const userInterests = {}; // socketId → [interests]

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Count shared interests between two users
function sharedInterests(a, b) {
    return a.filter((i) => b.includes(i)).length;
}

// Find best match from queue for a new user
function findBestMatch(newUser) {
    if (waitingQueue.length === 0) return null;

    let bestIndex = 0;
    let bestScore = -1;

    waitingQueue.forEach((user, index) => {
        const score = sharedInterests(newUser.interests, user.interests);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    });

    // Remove matched user from queue and return them
    const matched = waitingQueue.splice(bestIndex, 1)[0];
    return matched;
}

// Broadcast live online count every 5 seconds
setInterval(() => {
    io.emit("online-count", io.engine.clientsCount);
}, 5000);

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
    console.log(`✅ User connected: ${socket.id}`);

    // Send current online count immediately on connect
    socket.emit("online-count", io.engine.clientsCount);

    // ── User joins the matching queue ──────────────────────────────────────────
    socket.on("find-match", ({ interests }) => {
        console.log(`🔍 ${socket.id} looking for match | interests: ${interests}`);

        // Save interests
        userInterests[socket.id] = interests || [];

        // If already paired, disconnect old pair first
        if (activePairs[socket.id]) {
            const oldPartner = activePairs[socket.id];
            socket.to(oldPartner).emit("partner-disconnected");
            delete activePairs[oldPartner];
            delete activePairs[socket.id];
        }

        const newUser = { socketId: socket.id, interests: userInterests[socket.id] };
        const match = findBestMatch(newUser);

        if (match) {
            // ✅ Match found — pair them up
            activePairs[socket.id] = match.socketId;
            activePairs[match.socketId] = socket.id;

            const commonInterests = sharedInterests(newUser.interests, match.interests);

            // Tell both users they are matched
            socket.emit("match-found", {
                partnerId: match.socketId,
                isInitiator: true, // this user starts the WebRTC offer
                sharedInterests: commonInterests,
            });

            io.to(match.socketId).emit("match-found", {
                partnerId: socket.id,
                isInitiator: false,
                sharedInterests: commonInterests,
            });

            console.log(`💚 Matched: ${socket.id} ↔ ${match.socketId} (${commonInterests} shared interests)`);
        } else {
            // ⏳ No match yet — add to waiting queue
            waitingQueue.push(newUser);
            socket.emit("waiting");
            console.log(`⏳ ${socket.id} added to queue. Queue size: ${waitingQueue.length}`);
        }
    });

    // ── WebRTC Signaling (relay between peers) ─────────────────────────────────

    // Relay WebRTC offer
    socket.on("webrtc-offer", ({ offer, to }) => {
        socket.to(to).emit("webrtc-offer", { offer, from: socket.id });
    });

    // Relay WebRTC answer
    socket.on("webrtc-answer", ({ answer, to }) => {
        socket.to(to).emit("webrtc-answer", { answer, from: socket.id });
    });

    // Relay ICE candidates
    socket.on("ice-candidate", ({ candidate, to }) => {
        socket.to(to).emit("ice-candidate", { candidate, from: socket.id });
    });

    // ── Chat messages ──────────────────────────────────────────────────────────
    socket.on("chat-message", ({ message }) => {
        const partnerId = activePairs[socket.id];
        if (partnerId) {
            io.to(partnerId).emit("chat-message", { message, from: socket.id });
        }
    });

    // ── Next button — skip current partner ────────────────────────────────────
    socket.on("next", () => {
        console.log(`⏭ ${socket.id} clicked Next`);

        const partnerId = activePairs[socket.id];

        if (partnerId) {
            // Tell partner they were skipped
            io.to(partnerId).emit("partner-disconnected");

            // Clean up pair
            delete activePairs[partnerId];
            delete activePairs[socket.id];

            // Put the skipped partner back in the queue
            const partnerInterests = userInterests[partnerId] || [];
            waitingQueue.push({ socketId: partnerId, interests: partnerInterests });
            io.to(partnerId).emit("waiting");
        }

        // Remove from queue if somehow still there
        const queueIndex = waitingQueue.findIndex((u) => u.socketId === socket.id);
        if (queueIndex !== -1) waitingQueue.splice(queueIndex, 1);

        // Find new match for this user
        const newUser = { socketId: socket.id, interests: userInterests[socket.id] || [] };
        const match = findBestMatch(newUser);

        if (match) {
            activePairs[socket.id] = match.socketId;
            activePairs[match.socketId] = socket.id;

            const commonInterests = sharedInterests(newUser.interests, match.interests);

            socket.emit("match-found", {
                partnerId: match.socketId,
                isInitiator: true,
                sharedInterests: commonInterests,
            });

            io.to(match.socketId).emit("match-found", {
                partnerId: socket.id,
                isInitiator: false,
                sharedInterests: commonInterests,
            });

            console.log(`💚 Re-matched: ${socket.id} ↔ ${match.socketId}`);
        } else {
            waitingQueue.push(newUser);
            socket.emit("waiting");
        }
    });

    // ── Report a user ──────────────────────────────────────────────────────────
    socket.on("report", ({ reason }) => {
        const partnerId = activePairs[socket.id];
        console.log(`🚨 REPORT: ${socket.id} reported ${partnerId} | reason: ${reason}`);
        // TODO: save to Supabase DB later
        socket.emit("report-received", { message: "Report submitted. Thank you." });
    });

    // ── Disconnect ─────────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
        console.log(`❌ User disconnected: ${socket.id}`);

        // Notify partner
        const partnerId = activePairs[socket.id];
        if (partnerId) {
            io.to(partnerId).emit("partner-disconnected");
            delete activePairs[partnerId];
        }

        // Clean up everything
        delete activePairs[socket.id];
        delete userInterests[socket.id];

        // Remove from waiting queue if they were in it
        const queueIndex = waitingQueue.findIndex((u) => u.socketId === socket.id);
        if (queueIndex !== -1) waitingQueue.splice(queueIndex, 1);
    });
});

// ─── Health check route ───────────────────────────────────────────────────────
app.get("/", (req, res) => {
    res.json({
        status: "✅ CampusLink server running",
        online: io.engine.clientsCount,
        waiting: waitingQueue.length,
        activePairs: Object.keys(activePairs).length / 2,
    });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = 3001;
server.listen(PORT, () => {
    console.log(`🚀 CampusLink signaling server running on http://localhost:${PORT}`);
});