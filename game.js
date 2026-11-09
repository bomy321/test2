"use strict";

// 多人貪吃蛇的遊戲規則。不碰網路，由 server.js 呼叫。

const COLS = 40;
const ROWS = 24;
const MAX_PLAYERS = 6;
const TICK_MS = 200;
const COUNTDOWN_TICKS = 15; // 3 秒
const START_LENGTH = 3;

const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};
const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };

// 依玩家位置（slot）決定出生點，彼此分開且面向場地中央。
const SPAWNS = [
  { x: 7, y: 4, dir: "right" },
  { x: 32, y: 19, dir: "left" },
  { x: 32, y: 4, dir: "left" },
  { x: 7, y: 19, dir: "right" },
  { x: 7, y: 12, dir: "right" },
  { x: 32, y: 12, dir: "left" }
];

const FRUIT_KINDS = [
  { kind: "apple", points: 10, weight: 70 },
  { kind: "grape", points: 20, weight: 22 },
  { kind: "star", points: 50, weight: 8 }
];

function fruitTarget(playerCount) {
  return 8 + playerCount * 2;
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function pickFruitKind(random) {
  const total = FRUIT_KINDS.reduce((sum, fruit) => sum + fruit.weight, 0);
  let roll = random() * total;
  for (const fruit of FRUIT_KINDS) {
    roll -= fruit.weight;
    if (roll < 0) return fruit.kind;
  }
  return FRUIT_KINDS[0].kind;
}

class Game {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.players = new Map();
    this.fruits = [];
    this.phase = "lobby"; // lobby | countdown | playing
    this.countdownTicks = 0;
    this.roundSize = 0;
    this.result = null;
    this.nextId = 1;
  }

  addPlayer(name) {
    if (this.players.size >= MAX_PLAYERS) return null;
    const used = new Set([...this.players.values()].map((player) => player.slot));
    let slot = 0;
    while (used.has(slot)) slot += 1;

    const player = {
      id: this.nextId,
      name: name || `玩家${slot + 1}`,
      slot,
      score: 0,
      alive: false,
      dir: SPAWNS[slot].dir,
      queue: [],
      snake: []
    };
    this.nextId += 1;
    this.players.set(player.id, player);

    if (this.phase === "countdown") {
      this.placeOnSpawn(player);
      this.roundSize = this.players.size;
      this.fruits = this.fruits.filter(
        (fruit) => !player.snake.some((cell) => cell.x === fruit.x && cell.y === fruit.y)
      );
      this.refillFruits();
    }
    return player;
  }

  removePlayer(id) {
    if (!this.players.delete(id)) return;
    if (this.phase === "countdown") {
      this.roundSize = this.players.size;
      if (this.players.size === 0) {
        this.phase = "lobby";
        this.fruits = [];
      }
    } else if (this.phase === "playing") {
      this.checkRoundEnd([]);
    }
  }

  requestStart(id) {
    if (this.phase !== "lobby" || !this.players.has(id)) return false;
    this.phase = "countdown";
    this.countdownTicks = COUNTDOWN_TICKS;
    this.result = null;
    this.fruits = [];
    this.roundSize = this.players.size;
    for (const player of this.players.values()) {
      player.score = 0;
      this.placeOnSpawn(player);
    }
    this.refillFruits();
    return true;
  }

  placeOnSpawn(player) {
    const spawn = SPAWNS[player.slot];
    const step = DIRECTIONS[spawn.dir];
    player.alive = true;
    player.dir = spawn.dir;
    player.queue = [];
    player.snake = [];
    for (let i = 0; i < START_LENGTH; i += 1) {
      player.snake.push({ x: spawn.x - step.x * i, y: spawn.y - step.y * i });
    }
  }

  // 用佇列保留快速連按的兩次轉向，避免一步之內被覆蓋或撞上自己的脖子。
  setDirection(id, dir) {
    const player = this.players.get(id);
    // dir 來自連線端，可能不是字串，也可能是 "__proto__" 這類會命中原型鏈的值。
    if (!player || !player.alive) return;
    if (typeof dir !== "string" || !Object.hasOwn(DIRECTIONS, dir)) return;
    if (player.queue.length >= 2) return;
    const last = player.queue.length ? player.queue[player.queue.length - 1] : player.dir;
    if (dir === last || dir === OPPOSITE[last]) return;
    player.queue.push(dir);
  }

  // 推進一步；回傳 true 表示狀態有變，需要廣播。
  step() {
    if (this.phase === "countdown") {
      this.countdownTicks -= 1;
      if (this.countdownTicks <= 0) this.phase = "playing";
      return true;
    }
    if (this.phase === "playing") {
      this.advance();
      return true;
    }
    return false;
  }

  advance() {
    const movers = [...this.players.values()].filter((player) => player.alive);
    const moves = movers.map((player) => {
      if (player.queue.length) player.dir = player.queue.shift();
      const step = DIRECTIONS[player.dir];
      const head = { x: player.snake[0].x + step.x, y: player.snake[0].y + step.y };
      const fruitIndex = this.fruits.findIndex((fruit) => fruit.x === head.x && fruit.y === head.y);
      return { player, head, eats: fruitIndex !== -1 };
    });

    // 所有蛇同時移動：沒吃到果實的蛇尾會讓出位置，所以先把它排除再判斷碰撞。
    const bodies = new Set();
    const headCounts = new Map();
    for (const { player, head, eats } of moves) {
      const cells = eats ? player.snake : player.snake.slice(0, -1);
      for (const cell of cells) bodies.add(cellKey(cell.x, cell.y));
      const key = cellKey(head.x, head.y);
      headCounts.set(key, (headCounts.get(key) || 0) + 1);
    }

    const died = [];
    for (const { player, head, eats } of moves) {
      const key = cellKey(head.x, head.y);
      const hitWall = head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS;
      if (hitWall || bodies.has(key) || headCounts.get(key) > 1) {
        died.push(player);
        continue;
      }
      player.snake.unshift(head);
      if (eats) {
        const index = this.fruits.findIndex((fruit) => fruit.x === head.x && fruit.y === head.y);
        const kind = this.fruits[index].kind;
        player.score += FRUIT_KINDS.find((fruit) => fruit.kind === kind).points;
        this.fruits.splice(index, 1);
      } else {
        player.snake.pop();
      }
    }

    for (const player of died) {
      player.alive = false;
      player.snake = [];
      player.queue = [];
    }

    this.refillFruits();
    this.checkRoundEnd(died);
  }

  refillFruits() {
    const occupied = new Set();
    for (const player of this.players.values()) {
      for (const cell of player.snake) occupied.add(cellKey(cell.x, cell.y));
    }
    for (const fruit of this.fruits) occupied.add(cellKey(fruit.x, fruit.y));

    const target = fruitTarget(this.players.size);
    while (this.fruits.length < target) {
      const free = [];
      for (let y = 0; y < ROWS; y += 1) {
        for (let x = 0; x < COLS; x += 1) {
          if (!occupied.has(cellKey(x, y))) free.push({ x, y });
        }
      }
      if (!free.length) return;
      const cell = free[Math.floor(this.random() * free.length)];
      occupied.add(cellKey(cell.x, cell.y));
      this.fruits.push({ x: cell.x, y: cell.y, kind: pickFruitKind(this.random) });
    }
  }

  checkRoundEnd(diedThisStep) {
    const alive = [...this.players.values()].filter((player) => player.alive);
    const solo = this.roundSize < 2;
    if (solo ? alive.length > 0 : alive.length > 1) return;

    let winners = alive;
    if (!winners.length && !solo && diedThisStep.length) {
      // 最後的玩家同一步陣亡時，比分數；同分就是平手。
      const best = Math.max(...diedThisStep.map((player) => player.score));
      winners = diedThisStep.filter((player) => player.score === best);
    }

    const finalScore = solo && diedThisStep.length ? diedThisStep[0].score : 0;
    this.phase = "lobby";
    this.result = {
      solo,
      winners: solo ? [] : winners.map((player) => player.name),
      score: finalScore
    };
  }

  snapshot() {
    return {
      t: "state",
      phase: this.phase,
      countdown: Math.ceil((this.countdownTicks * TICK_MS) / 1000),
      result: this.result,
      fruits: this.fruits,
      players: [...this.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        slot: player.slot,
        score: player.score,
        alive: player.alive,
        dir: player.dir,
        snake: player.snake
      }))
    };
  }
}

module.exports = { Game, COLS, ROWS, MAX_PLAYERS, TICK_MS, COUNTDOWN_TICKS, FRUIT_KINDS, fruitTarget };
