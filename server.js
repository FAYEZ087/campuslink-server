const http = require("http");
const { Server } = require("socket.io");

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify({
    status: "✅ CampusLink server running",
    waiting: waitingQueue.length,
    activePairs: Object.keys(activePairs).length / 2,
  }))
})

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
})

// ─── State ────────────────────────────────────────────────────────────────────
const waitingQueue = []
const activePairs = {}
const userInterests = {}

function sharedInterests(a, b) {
  return a.filter((i) => b.includes(i)).length
}

function findBestMatch(newUser) {
  if (waitingQueue.length === 0) return null
  let bestIndex = 0
  let bestScore = -1
  waitingQueue.forEach((user, index) => {
    const score = sharedInterests(newUser.interests, user.interests)
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  })
  return waitingQueue.splice(bestIndex, 1)[0]
}

setInterval(() => {
  io.emit("online-count", io.engine.clientsCount)
}, 5000)

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`)
  socket.emit("online-count", io.engine.clientsCount)

  socket.on("find-match", ({ interests }) => {
    console.log(`🔍 ${socket.id} looking for match | interests: ${interests}`)
    userInterests[socket.id] = interests || []

    if (activePairs[socket.id]) {
      const oldPartner = activePairs[socket.id]
      socket.to(oldPartner).emit("partner-disconnected")
      delete activePairs[oldPartner]
      delete activePairs[socket.id]
    }

    const newUser = { socketId: socket.id, interests: userInterests[socket.id] }
    const match = findBestMatch(newUser)

    if (match) {
      activePairs[socket.id] = match.socketId
      activePairs[match.socketId] = socket.id
      const commonInterests = sharedInterests(newUser.interests, match.interests)

      socket.emit("match-found", {
        partnerId: match.socketId,
        isInitiator: true,
        sharedInterests: commonInterests,
      })
      io.to(match.socketId).emit("match-found", {
        partnerId: socket.id,
        isInitiator: false,
        sharedInterests: commonInterests,
      })
      console.log(`💚 Matched: ${socket.id} ↔ ${match.socketId}`)
    } else {
      waitingQueue.push(newUser)
      socket.emit("waiting")
      console.log(`⏳ ${socket.id} added to queue. Queue size: ${waitingQueue.length}`)
    }
  })

  socket.on("webrtc-offer", ({ offer, to }) => {
    socket.to(to).emit("webrtc-offer", { offer, from: socket.id })
  })

  socket.on("webrtc-answer", ({ answer, to }) => {
    socket.to(to).emit("webrtc-answer", { answer, from: socket.id })
  })

  socket.on("ice-candidate", ({ candidate, to }) => {
    socket.to(to).emit("ice-candidate", { candidate, from: socket.id })
  })

  socket.on("chat-message", ({ message }) => {
    const partnerId = activePairs[socket.id]
    if (partnerId) {
      io.to(partnerId).emit("chat-message", { message, from: socket.id })
    }
  })

  socket.on("next", () => {
    console.log(`⏭ ${socket.id} clicked Next`)
    const partnerId = activePairs[socket.id]

    if (partnerId) {
      io.to(partnerId).emit("partner-disconnected")
      delete activePairs[partnerId]
      delete activePairs[socket.id]
      const partnerInterests = userInterests[partnerId] || []
      waitingQueue.push({ socketId: partnerId, interests: partnerInterests })
      io.to(partnerId).emit("waiting")
    }

    const queueIndex = waitingQueue.findIndex((u) => u.socketId === socket.id)
    if (queueIndex !== -1) waitingQueue.splice(queueIndex, 1)

    const newUser = { socketId: socket.id, interests: userInterests[socket.id] || [] }
    const match = findBestMatch(newUser)

    if (match) {
      activePairs[socket.id] = match.socketId
      activePairs[match.socketId] = socket.id
      const commonInterests = sharedInterests(newUser.interests, match.interests)

      socket.emit("match-found", { partnerId: match.socketId, isInitiator: true, sharedInterests: commonInterests })
      io.to(match.socketId).emit("match-found", { partnerId: socket.id, isInitiator: false, sharedInterests: commonInterests })
      console.log(`💚 Re-matched: ${socket.id} ↔ ${match.socketId}`)
    } else {
      waitingQueue.push(newUser)
      socket.emit("waiting")
    }
  })

  socket.on("report", ({ reason }) => {
    const partnerId = activePairs[socket.id]
    console.log(`🚨 REPORT: ${socket.id} reported ${partnerId} | reason: ${reason}`)
    socket.emit("report-received", { message: "Report submitted. Thank you." })
  })

  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`)
    const partnerId = activePairs[socket.id]
    if (partnerId) {
      io.to(partnerId).emit("partner-disconnected")
      delete activePairs[partnerId]
    }
    delete activePairs[socket.id]
    delete userInterests[socket.id]
    const queueIndex = waitingQueue.findIndex((u) => u.socketId === socket.id)
    if (queueIndex !== -1) waitingQueue.splice(queueIndex, 1)
  })
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`🚀 CampusLink signaling server running on port ${PORT}`)
})