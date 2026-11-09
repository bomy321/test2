"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { Game, COLS, ROWS, MAX_PLAYERS, TICK_MS } = require("./game");

const PORT = Number(process.env.PORT) || 3000;
const PAGE_PATH = path.join(__dirname, "snake_test2.html");
const MAX_CONNECTIONS = 32; // 玩家上限 6 人，其餘連線只能觀戰
const MAX_NAME_LENGTH = 12;
const HEARTBEAT_MS = 15000;

const game = new Game();

// 只提供遊戲頁面，不開放讀取專案內的其他檔案。
const server = http.createServer((request, response) => {
  const { pathname } = new URL(request.url, "http://localhost");
  if (pathname !== "/") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  fs.readFile(PAGE_PATH, (error, page) => {
    if (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("找不到遊戲頁面");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache"
    });
    response.end(page);
  });
});

const sockets = new WebSocketServer({ server, maxPayload: 256 });

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcastState() {
  const payload = JSON.stringify(game.snapshot());
  for (const socket of sockets.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\p{C}/gu, "").trim();
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join("");
}

function handleMessage(socket, message) {
  switch (message.t) {
    case "join": {
      if (socket.player) return;
      const player = game.addPlayer(cleanName(message.name));
      if (!player) {
        send(socket, { t: "full" });
        return;
      }
      socket.player = player;
      send(socket, { t: "joined", id: player.id });
      broadcastState();
      break;
    }
    case "start":
      if (socket.player && game.requestStart(socket.player.id)) broadcastState();
      break;
    case "dir":
      if (socket.player) game.setDirection(socket.player.id, message.d);
      break;
    default:
      break;
  }
}

sockets.on("connection", (socket) => {
  if (sockets.clients.size > MAX_CONNECTIONS) {
    socket.close(1013, "too many connections");
    return;
  }

  socket.player = null;
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message && typeof message === "object") handleMessage(socket, message);
  });

  socket.on("close", () => {
    if (!socket.player) return;
    game.removePlayer(socket.player.id);
    socket.player = null;
    broadcastState();
  });

  socket.on("error", () => socket.terminate());

  send(socket, { t: "hello", cols: COLS, rows: ROWS, maxPlayers: MAX_PLAYERS });
  send(socket, game.snapshot());
});

setInterval(() => {
  if (game.step()) broadcastState();
}, TICK_MS);

// 清掉已經斷線但沒有正常關閉的連線（例如手機斷網），避免佔用玩家名額。
setInterval(() => {
  for (const socket of sockets.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`連接埠 ${PORT} 已被使用，請設定 PORT 環境變數改用其他連接埠。`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log("貪吃蛇伺服器已啟動");
  console.log(`  本機：http://localhost:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        console.log(`  區網：http://${address.address}:${PORT}`);
      }
    }
  }
});
