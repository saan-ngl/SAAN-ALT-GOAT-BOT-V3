const fs = require("fs");
const path = require("path");
const { createCanvas } = require("canvas");

const MIN_N = 2;
const MAX_N = 6;
const DEFAULT_N = 4;
const IDLE_MS = 30 * 60 * 1000;
const EXACT_LIMIT = 20;
const EMO = ["🟢", "🔴"];
const WIN_REWARD = 20000;
const BOX_REWARD = 1000;
const COLORS = {
	1: { main: "#2dffb0", core: "#eafff6", dark: "#0a2e22", rgb: "45,255,176", name: "Green" },
	2: { main: "#ff3b3b", core: "#ffe1e1", dark: "#3a0808", rgb: "255,59,59", name: "Red" }
};
const LEVELS = { easy: "Easy", normal: "Normal", hard: "Hard" };

module.exports = {
	config: {
		name: "dots&boxes",
		aliases: ["dnb", "boxes", "dots"],
		version: "2.0",
		author: "Saan",
		countDown: 3,
		role: 0,
		description: "Dots and Boxes - play with a bot or a friend (canvas board)",
		category: "GAMES",
		guide: "{pn} [size 2-6] [easy|normal|hard] - vs bot"
			+ "\n{pn} [size 2-6] [@tag | reply] - vs friend"
			+ "\n{pn} join - join waiting game"
			+ "\n{pn} board - show board again"
			+ "\n{pn} stop - end game"
			+ "\n{pn} rules - how to play"
			+ "\n\nMove: reply with ONE or MORE line numbers (e.g. 5 or 5 12 27)"
	},

	onStart: async function ({ args, event, message, usersData, prefix, role }) {
		const { threadID, senderID } = event;
		const store = getStore();
		const p = prefix || "/";
		let g = getGame(threadID);

		const sub = (args[0] || "").toLowerCase();

		if (["help", "h", "?"].includes(sub) && args.length === 1)
			return message.reply(helpText(p, g));
		if (["rules", "rule", "how"].includes(sub))
			return message.reply(rulesText());

		if (["board", "show", "b", "status"].includes(sub)) {
			if (!g) return message.reply("❌ | No game in this chat.");
			if (g.status === "lobby")
				return message.reply("⏳ | Waiting for an opponent. Type: " + p + "dab join");
			return sendBoard(message, g, headerText(g) + "\n" + turnText(g));
		}

		if (["stop", "end", "quit", "leave", "cancel", "delete"].includes(sub)) {
			if (!g) return message.reply("❌ | No game to stop.");
			const allowed = g.players.some(pl => pl.id === senderID) || role >= 1;
			if (!allowed) return message.reply("⛔ | Only players or a group admin can stop this game.");
			store.delete(threadID);
			return message.reply("🛑 | Game ended.");
		}

		if (["join", "j", "accept"].includes(sub)) {
			if (!g || g.status !== "lobby") return message.reply("❌ | No waiting game. Create one: " + p + "dab");
			if (g.players[0].id === senderID) return message.reply("😅 | You created this game, wait for someone else to join.");
			g.players[1] = { id: senderID, name: await getName(usersData, senderID), isBot: false };
			g.status = "playing";
			g.turn = Math.random() < 0.5 ? 0 : 1;
			touch(g);
			return sendBoard(message, g, startText(g, true));
		}

		if (g) return message.reply("⚠️ | A game is already running.\nUse " + p + "dab board  or  " + p + "dab stop");

		let n = DEFAULT_N, level = "normal";
		for (const raw of args) {
			const t = String(raw).toLowerCase();
			const sz = t.match(/^(\d)(?:x\d)?$/);
			if (sz) {
				n = parseInt(sz[1], 10);
				if (n < MIN_N || n > MAX_N) return message.reply("🔢 | Size must be between " + MIN_N + " and " + MAX_N + ".");
			}
			else if (["easy", "e", "noob"].includes(t)) level = "easy";
			else if (["normal", "medium", "mid", "n", "m"].includes(t)) level = "normal";
			else if (["hard", "h", "pro", "expert"].includes(t)) level = "hard";
		}

		const meName = await getName(usersData, senderID);

		const mentioned = Object.keys(event.mentions || {}).filter(id => id !== senderID)[0];
		const replied = event.messageReply && event.messageReply.senderID && event.messageReply.senderID !== senderID
			? event.messageReply.senderID
			: null;
		const opponent = mentioned || replied;

		g = newGame(n, opponent ? "pvp" : "bot", level);
		g.players[0] = { id: senderID, name: meName, isBot: false };

		if (opponent) {
			g.players[1] = { id: opponent, name: await getName(usersData, opponent), isBot: false };
			g.status = "playing";
			g.turn = Math.random() < 0.5 ? 0 : 1;
			store.set(threadID, g);
			touch(g);
			return sendBoard(message, g, startText(g, true));
		}

		g.players[1] = { id: "BOT", name: "Bot", isBot: true };
		g.status = "playing";
		g.turn = 0;
		store.set(threadID, g);
		touch(g);
		return sendBoard(message, g, startText(g, false));
	},

	onChat: async function ({ event, message, usersData, api }) {
		const store = getStore();
		if (!store.size) return;
		const { threadID, senderID, body } = event;
		if (typeof body !== "string" || body.length > 40) return;

		const g = getGame(threadID);
		if (!g || g.status !== "playing") return;
		if (!g.players.some(pl => pl.id === senderID)) return;

		const nums = parseMoves(body);
		if (!nums.length) return;

		return async function () {
			await handleMoves(g, threadID, senderID, nums, message, usersData, api);
		};
	}
};

async function handleMoves(g, threadID, senderID, nums, message, usersData, api) {
	const idx = g.players.findIndex(pl => pl.id === senderID);
	if (g.turn !== idx)
		return message.reply("⏳ | Not your turn! Waiting for " + EMO[g.turn] + " " + g.players[g.turn].name);

	if (g.lastBoardMsgID) {
		try { await api.unsendMessage(g.lastBoardMsgID); } catch (e) { }
		g.lastBoardMsgID = null;
	}

	const lines = [];
	const played = [];
	let again = false;

	for (const num of nums) {
		if (isOver(g)) break;
		if (g.turn !== idx) break;

		const edges = listUndrawn(g);
		const e = edges[num - 1];
		if (!e) {
			lines.push("❌ invalid number: " + num);
			continue;
		}

		const done = playEdge(g, e, idx);
		played.push("#" + num + (done.length ? " (+" + done.length + ")" : ""));
		if (done.length > 0) again = true;
	}

	if (played.length) {
		lines.push(EMO[idx] + " " + g.players[idx].name + ": " + played.join(", ") + (again ? "  🎉" : ""));
	}

	if (!isOver(g) && g.players[g.turn].isBot) {
		const botLog = runBot(g);
		const parts = botLog.map(m => "#" + m.num + (m.got ? " (+" + m.got + ")" : ""));
		lines.push("🤖 Bot: " + parts.join(", "));
	}

	touch(g);

	if (isOver(g)) {
		getStore().delete(threadID);
		const result = await settleRewards(g, usersData);
		return sendBoard(message, g, lines.join("\n") + "\n\n" + resultText(g) + "\n" + result);
	}
	return sendBoard(message, g, lines.join("\n") + "\n\n" + scoreText(g) + "\n" + turnText(g));
}

async function settleRewards(g, usersData) {
	const summary = [];

	for (let i = 0; i < 2; i++) {
		const pl = g.players[i];
		if (pl.isBot) continue;

		const boxReward = g.scores[i] * BOX_REWARD;
		const winReward = g.scores[i] > g.scores[1 - i] ? WIN_REWARD : 0;
		const total = boxReward + winReward;

		try {
			const ud = await usersData.get(pl.id);
			const cur = parseInt(ud.money || 0);
			await usersData.set(pl.id, { money: cur + total });
		} catch (e) { }

		let line = EMO[i] + " " + pl.name + "  +$" + total.toLocaleString();
		if (boxReward) line += "  (boxes " + g.scores[i] + "×$" + BOX_REWARD.toLocaleString() + ")";
		if (winReward) line += "  🏆 +$" + WIN_REWARD.toLocaleString();
		summary.push(line);
	}

	if (!summary.length) return "";
	return "💰 REWARDS\n" + summary.join("\n");
}

function parseMoves(body) {
	return body
		.trim()
		.split(/\s+/)
		.map(x => x.replace(/^#/, ""))
		.filter(x => /^\d{1,3}$/.test(x))
		.map(x => parseInt(x, 10))
		.filter(x => x > 0);
}

function helpText(p, g) {
	let t = "🎮 DOTS & BOXES\n"
		+ "━━━━━━━━━━━━━━\n"
		+ p + "dab [2-6] [easy|normal|hard]  → vs bot\n"
		+ p + "dab [2-6] [@tag | reply]  → vs friend\n"
		+ p + "dab join  → join waiting game\n"
		+ p + "dab board  → show board\n"
		+ p + "dab stop  → end game\n"
		+ p + "dab rules  → how to play\n\n"
		+ "💰 Per box: $" + BOX_REWARD.toLocaleString() + "  |  Win: $" + WIN_REWARD.toLocaleString() + "\n"
		+ "✍️ Move: reply with NUMBERS (e.g. 5 or 5 12 27)";
	if (g) t += "\n\n📌 Game running (" + g.n + "x" + g.n + ", " + (g.status === "lobby" ? "waiting" : "in progress") + ").";
	return t;
}

function rulesText() {
	return "📖 DOTS & BOXES\n"
		+ "━━━━━━━━━━━━━━\n"
		+ "1️⃣ Take turns drawing lines between dots.\n"
		+ "2️⃣ Reply with one or more line NUMBERS.\n"
		+ "   Example: 5    or    5 12 27\n"
		+ "3️⃣ Close a box = +1 point and you go again.\n"
		+ "4️⃣ More boxes when board ends = winner.\n\n"
		+ "💰 Rewards:\n"
		+ "• Per box: $" + BOX_REWARD.toLocaleString() + "\n"
		+ "• Winner: +$" + WIN_REWARD.toLocaleString() + "\n\n"
		+ "💡 Avoid the 3rd side of a box!";
}

function startText(g, pvp) {
	const a = g.players[0], b = g.players[1];
	let t = "🎮 DOTS & BOXES  ·  " + g.n + "x" + g.n + "\n"
		+ EMO[0] + " " + a.name + "  vs  " + EMO[1] + " " + b.name + (b.isBot ? " [" + LEVELS[g.difficulty] + "]" : "") + "\n"
		+ "💰 Box=$" + BOX_REWARD.toLocaleString() + "  Win=$" + WIN_REWARD.toLocaleString() + "\n"
		+ "✍️ Reply one or more line NUMBERS.\n";
	if (pvp) t += "🎲 " + g.players[g.turn].name + " starts!\n";
	t += "\n" + turnText(g);
	return t;
}

function headerText(g) {
	return "🎮 DOTS & BOXES  ·  " + g.n + "x" + g.n + "\n" + scoreText(g);
}

function scoreText(g) {
	return "📊 " + EMO[0] + " " + g.players[0].name + " " + g.scores[0] + "  |  " + EMO[1] + " " + g.players[1].name + " " + g.scores[1];
}

function turnText(g) {
	return "👉 " + EMO[g.turn] + " " + g.players[g.turn].name + " — reply line number(s)!";
}

function resultText(g) {
	const [a, b] = g.scores;
	let t = "🏁 GAME OVER!\n" + scoreText(g) + "\n";
	if (a === b) return t + "🤝 Draw!";
	const w = a > b ? 0 : 1;
	if (g.mode === "bot")
		return t + (g.players[w].isBot ? "🤖 Bot wins!" : "🏆 " + g.players[w].name + " beat the bot! 🎉");
	return t + "🏆 " + EMO[w] + " " + g.players[w].name + " wins! 🎉";
}

function getStore() {
	if (!global.moduleData) global.moduleData = {};
	if (!global.moduleData.dotsAndBoxes) global.moduleData.dotsAndBoxes = new Map();
	return global.moduleData.dotsAndBoxes;
}

function getGame(threadID) {
	const store = getStore();
	const g = store.get(threadID);
	if (!g) return null;
	if (Date.now() - g.updatedAt > IDLE_MS) { store.delete(threadID); return null; }
	return g;
}

function touch(g) { g.updatedAt = Date.now(); }

function newGame(n, mode, difficulty) {
	const grid = (rows, cols) => Array.from({ length: rows }, () => new Array(cols).fill(0));
	return {
		n, mode, difficulty,
		status: "lobby",
		h: grid(n + 1, n),
		v: grid(n, n + 1),
		boxes: grid(n, n),
		players: [null, null],
		scores: [0, 0],
		turn: 0,
		last: null,
		lastBoxes: [],
		moves: 0,
		lastBoardMsgID: null,
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
}

async function getName(usersData, uid) {
	try {
		const name = await usersData.getName(uid);
		return String(name || "Player").slice(0, 24);
	} catch (e) { return "Player"; }
}

function adjBoxes(n, e) {
	const out = [];
	if (e.t === "h") {
		if (e.r > 0) out.push([e.r - 1, e.c]);
		if (e.r < n) out.push([e.r, e.c]);
	} else {
		if (e.c > 0) out.push([e.r, e.c - 1]);
		if (e.c < n) out.push([e.r, e.c]);
	}
	return out;
}

function boxSides(g, r, c) {
	return (g.h[r][c] ? 1 : 0) + (g.h[r + 1][c] ? 1 : 0) + (g.v[r][c] ? 1 : 0) + (g.v[r][c + 1] ? 1 : 0);
}

function applyEdge(g, e, pn) {
	(e.t === "h" ? g.h : g.v)[e.r][e.c] = pn;
	const done = [];
	for (const [br, bc] of adjBoxes(g.n, e)) {
		if (g.boxes[br][bc] === 0 && boxSides(g, br, bc) === 4) {
			g.boxes[br][bc] = pn;
			done.push([br, bc]);
		}
	}
	return done;
}

function playEdge(g, e, idx) {
	const done = applyEdge(g, e, idx + 1);
	g.scores[idx] += done.length;
	g.last = e;
	g.lastBoxes = done;
	g.moves++;
	if (done.length === 0) g.turn = 1 - g.turn;
	return done;
}

function isOver(g) { return g.scores[0] + g.scores[1] === g.n * g.n; }

function listUndrawn(g) {
	const out = [];
	for (let r = 0; r <= g.n; r++)
		for (let c = 0; c < g.n; c++)
			if (!g.h[r][c]) out.push({ t: "h", r, c });
	for (let r = 0; r < g.n; r++)
		for (let c = 0; c <= g.n; c++)
			if (!g.v[r][c]) out.push({ t: "v", r, c });
	return out;
}

function runBot(g) {
	const log = [];
	let guard = 0;
	while (!isOver(g) && g.players[g.turn].isBot && guard++ < 200) {
		const idx = g.turn;
		const edges = listUndrawn(g);
		const e = botChoose(g, g.difficulty);
		const num = edges.findIndex(x => x.t === e.t && x.r === e.r && x.c === e.c) + 1;
		const done = playEdge(g, e, idx);
		log.push({ e, num, got: done.length });
	}
	return log;
}

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function completes(g, e) {
	return adjBoxes(g.n, e).some(([r, c]) => g.boxes[r][c] === 0 && boxSides(g, r, c) === 3);
}

function isSafe(g, e) {
	return adjBoxes(g.n, e).every(([r, c]) => g.boxes[r][c] !== 0 || boxSides(g, r, c) <= 1);
}

function cloneGame(g) {
	return { n: g.n, h: g.h.map(r => r.slice()), v: g.v.map(r => r.slice()), boxes: g.boxes.map(r => r.slice()) };
}

function missingEdge(s, r, c) {
	if (!s.h[r][c]) return { t: "h", r, c };
	if (!s.h[r + 1][c]) return { t: "h", r: r + 1, c };
	if (!s.v[r][c]) return { t: "v", r, c };
	return { t: "v", r, c: c + 1 };
}

function captureCount(s) {
	let total = 0, progressed = true;
	while (progressed) {
		progressed = false;
		for (let r = 0; r < s.n && !progressed; r++) {
			for (let c = 0; c < s.n; c++) {
				if (s.boxes[r][c] === 0 && boxSides(s, r, c) === 3) {
					total += applyEdge(s, missingEdge(s, r, c), 9).length;
					progressed = true;
					break;
				}
			}
		}
	}
	return total;
}

function cheapestSacrifice(g, edges) {
	let best = Infinity, bestEdges = [];
	for (const e of edges) {
		const s = cloneGame(g);
		applyEdge(s, e, 1);
		const cost = captureCount(s);
		if (cost < best) { best = cost; bestEdges = [e]; }
		else if (cost === best) bestEdges.push(e);
	}
	return pick(bestEdges);
}

function solveExact(g, edges) {
	const n = g.n, R = edges.length;
	const need = new Int8Array(n * n);
	for (let r = 0; r < n; r++)
		for (let c = 0; c < n; c++)
			need[r * n + c] = g.boxes[r][c] ? 0 : 4 - boxSides(g, r, c);
	const adj = edges.map(e => adjBoxes(n, e).map(([r, c]) => r * n + c));
	const full = (1 << R) - 1;
	const memo = new Int8Array(1 << R).fill(127);

	function value(mask) {
		if (mask === full) return 0;
		if (memo[mask] !== 127) return memo[mask];
		let best = -127;
		for (let i = 0; i < R; i++) {
			if (mask & (1 << i)) continue;
			let k = 0;
			for (const b of adj[i]) if (--need[b] === 0) k++;
			const v = k > 0 ? k + value(mask | (1 << i)) : -value(mask | (1 << i));
			for (const b of adj[i]) need[b]++;
			if (v > best) best = v;
		}
		memo[mask] = best;
		return best;
	}

	let best = -127, bestEdges = [];
	for (let i = 0; i < R; i++) {
		let k = 0;
		for (const b of adj[i]) if (--need[b] === 0) k++;
		const v = k > 0 ? k + value(1 << i) : -value(1 << i);
		for (const b of adj[i]) need[b]++;
		if (v > best) { best = v; bestEdges = [edges[i]]; }
		else if (v === best) bestEdges.push(edges[i]);
	}
	return pick(bestEdges);
}

function botChoose(g, level) {
	const edges = listUndrawn(g);
	const closing = edges.filter(e => completes(g, e));

	if (level === "easy") {
		if (closing.length && Math.random() < 0.65) return pick(closing);
		return pick(edges);
	}
	if (level === "hard" && edges.length <= EXACT_LIMIT)
		return solveExact(g, edges);
	if (closing.length) return pick(closing);
	const safe = edges.filter(e => isSafe(g, e));
	if (safe.length) return pick(safe);
	if (level === "normal" && Math.random() < 0.25) return pick(edges);
	return cheapestSacrifice(g, edges);
}

let lastClean = 0;
function cleanOldFiles(dir) {
	if (Date.now() - lastClean < 5 * 60 * 1000) return;
	lastClean = Date.now();
	try {
		for (const f of fs.readdirSync(dir)) {
			if (!f.startsWith("dnb_")) continue;
			const fp = path.join(dir, f);
			if (Date.now() - fs.statSync(fp).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp);
		}
	} catch (e) { }
}

async function sendBoard(message, g, body) {
	const dir = path.join(__dirname, "cache");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	cleanOldFiles(dir);
	const file = path.join(dir, "dnb_" + Date.now() + "_" + Math.floor(Math.random() * 1e5) + ".png");
	const canvas = renderBoard(g);
	fs.writeFileSync(file, canvas.toBuffer("image/png"));
	const remove = () => setTimeout(() => fs.unlink(file, () => { }), 60 * 1000);

	return new Promise((resolve) => {
		message.reply({ body, attachment: fs.createReadStream(file) }, (err, info) => {
			remove();
			if (info && info.messageID) g.lastBoardMsgID = info.messageID;
			resolve(info);
		});
	});
}

function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function safeName(name, fallback) {
	const s = String(name || "").trim();
	return /^[\x20-\x7E\u00C0-\u024F]{1,}$/.test(s) ? s : fallback;
}

function fitText(ctx, text, maxW) {
	if (ctx.measureText(text).width <= maxW) return text;
	let t = text;
	while (t.length > 1 && ctx.measureText(t + "..").width > maxW) t = t.slice(0, -1);
	return t + "..";
}

function rrect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
	ctx.closePath();
}

function chamfer(ctx, x, y, w, h, k) {
	ctx.beginPath();
	ctx.moveTo(x + k, y);
	ctx.lineTo(x + w - k, y);
	ctx.lineTo(x + w, y + k);
	ctx.lineTo(x + w, y + h - k);
	ctx.lineTo(x + w - k, y + h);
	ctx.lineTo(x + k, y + h);
	ctx.lineTo(x, y + h - k);
	ctx.lineTo(x, y + k);
	ctx.closePath();
}

function layoutOf(g) {
	const n = g.n;
	const cell = Math.min(160, Math.floor(760 / n));
	const grid = cell * n;
	const PAD = 74, OUT = 26, HEAD = 118, FOOT = 68;
	const panel = grid + PAD * 2;
	const W = Math.max(860, panel + OUT * 2);
	const H = HEAD + panel + FOOT;
	const px = Math.round((W - panel) / 2), py = HEAD;
	return { n, cell, grid, PAD, OUT, HEAD, FOOT, panel, W, H, px, py, gx: px + PAD, gy: py + PAD };
}

function renderBoard(g) {
	const L = layoutOf(g);
	const canvas = createCanvas(L.W, L.H);
	drawBoard(canvas.getContext("2d"), g, L);
	return canvas;
}

function buildNumberMap(g) {
	const map = new Map();
	let n = 1;
	for (let r = 0; r <= g.n; r++)
		for (let c = 0; c < g.n; c++)
			if (!g.h[r][c]) map.set("h:" + r + ":" + c, n++);
	for (let r = 0; r < g.n; r++)
		for (let c = 0; c <= g.n; c++)
			if (!g.v[r][c]) map.set("v:" + r + ":" + c, n++);
	return map;
}

function drawBoard(ctx, g, L) {
	const { W, H, n, cell, gx, gy } = L;

	const bg = ctx.createLinearGradient(0, 0, 0, H);
	bg.addColorStop(0, "#05080c");
	bg.addColorStop(1, "#0a1016");
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, W, H);

	let glow = ctx.createRadialGradient(0, 0, 10, 0, 0, W * 0.7);
	glow.addColorStop(0, "rgba(45,255,176,0.13)");
	glow.addColorStop(1, "rgba(45,255,176,0)");
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, W, H);
	glow = ctx.createRadialGradient(W, H, 10, W, H, W * 0.7);
	glow.addColorStop(0, "rgba(255,59,59,0.13)");
	glow.addColorStop(1, "rgba(255,59,59,0)");
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, W, H);

	const rnd = mulberry32(7);
	for (let i = 0; i < 90; i++) {
		ctx.fillStyle = "rgba(255,255,255," + (0.03 + rnd() * 0.06).toFixed(3) + ")";
		ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
	}

	drawHeader(ctx, g, L);
	drawPanel(ctx, L);

	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			const x = gx + c * cell, y = gy + r * cell, s = cell - 10;
			const owner = g.boxes[r][c];
			if (!owner) {
				rrect(ctx, x + 5, y + 5, s, s, 8);
				const f = ctx.createLinearGradient(x, y, x + cell, y + cell);
				f.addColorStop(0, "#0d1217");
				f.addColorStop(1, "#080b0f");
				ctx.fillStyle = f;
				ctx.fill();
				ctx.strokeStyle = "rgba(255,255,255,0.05)";
				ctx.lineWidth = 1.5;
				ctx.stroke();
			} else {
				drawOwnedBox(ctx, x + 5, y + 5, s, owner, r * 17 + c * 5 + owner);
			}
		}
	}

	ctx.lineCap = "round";
	const lw = Math.max(6, Math.min(11, cell / 10));

	for (let r = 0; r <= n; r++)
		for (let c = 0; c < n; c++)
			if (!g.h[r][c]) groove(ctx, gx + c * cell, gy + r * cell, gx + (c + 1) * cell, gy + r * cell);
	for (let r = 0; r < n; r++)
		for (let c = 0; c <= n; c++)
			if (!g.v[r][c]) groove(ctx, gx + c * cell, gy + r * cell, gx + c * cell, gy + (r + 1) * cell);

	for (let r = 0; r <= n; r++)
		for (let c = 0; c < n; c++)
			if (g.h[r][c]) neonLine(ctx, gx + c * cell, gy + r * cell, gx + (c + 1) * cell, gy + r * cell, g.h[r][c], lw, isLast(g, "h", r, c));
	for (let r = 0; r < n; r++)
		for (let c = 0; c <= n; c++)
			if (g.v[r][c]) neonLine(ctx, gx + c * cell, gy + r * cell, gx + c * cell, gy + (r + 1) * cell, g.v[r][c], lw, isLast(g, "v", r, c));

	drawLineNumbers(ctx, g, L);

	const dr = Math.max(9, Math.min(13, cell / 8));
	for (let r = 0; r <= n; r++) {
		for (let c = 0; c <= n; c++) {
			const x = gx + c * cell, y = gy + r * cell;
			ctx.shadowBlur = 0;
			const f = ctx.createRadialGradient(x - dr * 0.3, y - dr * 0.3, 1, x, y, dr + 4);
			f.addColorStop(0, "#c9d4dc");
			f.addColorStop(0.55, "#6d7a85");
			f.addColorStop(1, "#262d34");
			ctx.beginPath();
			ctx.arc(x, y, dr, 0, Math.PI * 2);
			ctx.fillStyle = f;
			ctx.fill();
			ctx.lineWidth = 2.5;
			ctx.strokeStyle = "#0b0e12";
			ctx.stroke();
		}
	}

	drawFooter(ctx, g, L);
}

function drawLineNumbers(ctx, g, L) {
	const { cell, gx, gy } = L;
	const map = buildNumberMap(g);
	const R = Math.max(15, Math.min(20, cell / 6));

	const drawBadge = (x, y, num) => {
		ctx.shadowBlur = 0;
		ctx.beginPath();
		ctx.arc(x, y, R, 0, Math.PI * 2);
		ctx.fillStyle = "rgba(8,14,20,0.96)";
		ctx.fill();
		ctx.lineWidth = 2.5;
		ctx.strokeStyle = "rgba(200,225,245,0.95)";
		ctx.stroke();

		ctx.fillStyle = "#f2f8ff";
		ctx.font = "bold " + (R + 4) + "px Arial, sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(String(num), x, y + 1);
	};

	for (let r = 0; r <= g.n; r++) {
		for (let c = 0; c < g.n; c++) {
			if (g.h[r][c]) continue;
			const num = map.get("h:" + r + ":" + c);
			if (!num) continue;
			drawBadge(gx + (c + 0.5) * cell, gy + r * cell, num);
		}
	}
	for (let r = 0; r < g.n; r++) {
		for (let c = 0; c <= g.n; c++) {
			if (g.v[r][c]) continue;
			const num = map.get("v:" + r + ":" + c);
			if (!num) continue;
			drawBadge(gx + c * cell, gy + (r + 0.5) * cell, num);
		}
	}
}

function isLast(g, t, r, c) {
	return !!g.last && g.last.t === t && g.last.r === r && g.last.c === c;
}

function groove(ctx, x1, y1, x2, y2) {
	ctx.shadowBlur = 0;
	ctx.strokeStyle = "#1b232b";
	ctx.lineWidth = 5;
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();
}

function neonLine(ctx, x1, y1, x2, y2, owner, w, last) {
	const col = COLORS[owner];
	ctx.lineCap = "round";
	ctx.shadowColor = col.main;
	ctx.shadowBlur = last ? 30 : 18;
	ctx.strokeStyle = col.main;
	ctx.lineWidth = w;
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();

	ctx.shadowBlur = 0;
	ctx.strokeStyle = last ? "#ffffff" : col.core;
	ctx.globalAlpha = last ? 1 : 0.75;
	ctx.lineWidth = Math.max(2, w * 0.38);
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();
	ctx.globalAlpha = 1;
}

function drawOwnedBox(ctx, x, y, s, owner, seed) {
	const col = COLORS[owner];
	const cx = x + s / 2, cy = y + s / 2;
	const rnd = mulberry32(seed * 977 + 13);
	ctx.save();
	rrect(ctx, x, y, s, s, 8);
	ctx.clip();

	const base = ctx.createRadialGradient(cx, cy, 2, cx, cy, s * 0.75);
	base.addColorStop(0, owner === 1 ? "#0f3a2a" : "#3a0a0a");
	base.addColorStop(1, owner === 1 ? "#04120c" : "#120404");
	ctx.fillStyle = base;
	ctx.fillRect(x, y, s, s);

	ctx.lineCap = "round";
	if (owner === 1) {
		const arms = 6, turns = 1.35, R = s * 0.78;
		const rot = rnd() * Math.PI * 2;
		for (let a = 0; a < arms; a++) {
			for (let pass = 0; pass < 2; pass++) {
				ctx.beginPath();
				const off = pass * 0.11;
				for (let i = 0; i <= 36; i++) {
					const t = i / 36;
					const th = rot + (a / arms) * Math.PI * 2 + off + t * turns * Math.PI * 2;
					const rr = t * R;
					const px = cx + Math.cos(th) * rr, py = cy + Math.sin(th) * rr;
					if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
				}
				ctx.strokeStyle = pass === 0 ? "rgba(90,255,150,0.65)" : "rgba(190,255,90,0.35)";
				ctx.lineWidth = pass === 0 ? 1.8 : 1.1;
				ctx.stroke();
			}
		}
		for (let i = 0; i < 26; i++) {
			const th = rnd() * Math.PI * 2, rr = rnd() * R * 0.9;
			ctx.fillStyle = "rgba(170,255,120," + (0.25 + rnd() * 0.5).toFixed(2) + ")";
			ctx.fillRect(cx + Math.cos(th) * rr, cy + Math.sin(th) * rr, 2, 2);
		}
	} else {
		for (let ring = 0; ring < 9; ring++) {
			const base0 = 6 + ring * (s * 0.075);
			ctx.beginPath();
			for (let i = 0; i <= 90; i++) {
				const th = (i / 90) * Math.PI * 2;
				const rr = base0 + Math.sin(th * 5 + ring * 0.7) * (2 + ring * 0.5);
				const px = cx + Math.cos(th) * rr, py = cy + Math.sin(th) * rr;
				if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
			}
			ctx.closePath();
			ctx.strokeStyle = "rgba(255,80,80," + (0.55 - ring * 0.04).toFixed(2) + ")";
			ctx.lineWidth = 1.3;
			ctx.stroke();
		}
		for (let k = 0; k < 10; k++) {
			const th = (k / 10) * Math.PI * 2 + 0.3;
			ctx.beginPath();
			ctx.moveTo(cx, cy);
			ctx.lineTo(cx + Math.cos(th) * s * 0.52, cy + Math.sin(th) * s * 0.52);
			ctx.strokeStyle = "rgba(255,90,90,0.25)";
			ctx.lineWidth = 1.4;
			ctx.stroke();
		}
		for (let i = 0; i < 22; i++) {
			const th = rnd() * Math.PI * 2, rr = rnd() * s * 0.5;
			ctx.fillStyle = "rgba(255,110,110," + (0.2 + rnd() * 0.5).toFixed(2) + ")";
			ctx.fillRect(cx + Math.cos(th) * rr, cy + Math.sin(th) * rr, 2, 2);
		}
	}

	const core = ctx.createRadialGradient(cx, cy, 1, cx, cy, s * 0.2);
	core.addColorStop(0, owner === 1 ? "rgba(210,255,220,0.95)" : "rgba(255,220,220,0.95)");
	core.addColorStop(1, "rgba(" + col.rgb + ",0)");
	ctx.fillStyle = core;
	ctx.fillRect(x, y, s, s);
	ctx.restore();

	rrect(ctx, x, y, s, s, 8);
	ctx.strokeStyle = "rgba(" + col.rgb + ",0.45)";
	ctx.lineWidth = 2;
	ctx.stroke();
}

function drawPanel(ctx, L) {
	const { px, py, panel } = L;
	const k = 34;
	chamfer(ctx, px, py, panel, panel, k);
	const body = ctx.createLinearGradient(px, py, px + panel, py + panel);
	body.addColorStop(0, "#161b21");
	body.addColorStop(1, "#0b0e12");
	ctx.fillStyle = body;
	ctx.fill();

	const frame = ctx.createLinearGradient(px, 0, px + panel, 0);
	frame.addColorStop(0, COLORS[1].main);
	frame.addColorStop(0.47, COLORS[1].main);
	frame.addColorStop(0.53, COLORS[2].main);
	frame.addColorStop(1, COLORS[2].main);
	ctx.shadowColor = "rgba(255,255,255,0.35)";
	ctx.shadowBlur = 16;
	chamfer(ctx, px, py, panel, panel, k);
	ctx.strokeStyle = frame;
	ctx.lineWidth = 5;
	ctx.stroke();
	ctx.shadowBlur = 0;
	chamfer(ctx, px + 14, py + 14, panel - 28, panel - 28, k - 10);
	ctx.strokeStyle = "rgba(255,255,255,0.1)";
	ctx.lineWidth = 2;
	ctx.stroke();

	ctx.fillStyle = "#07090c";
	for (let i = 0; i < 3; i++) {
		rrect(ctx, px + panel * 0.3 + i * 18, py + 7, 12, 5, 2);
		ctx.fill();
		rrect(ctx, px + panel * 0.7 - i * 18, py + panel - 12, 12, 5, 2);
		ctx.fill();
	}
	const leds = [[px + 46, py + 8, 1], [px + 62, py + 8, 1], [px + panel - 74, py + 8, 2], [px + panel - 58, py + 8, 2],
	[px + 46, py + panel - 13, 1], [px + 62, py + panel - 13, 1], [px + panel - 74, py + panel - 13, 2], [px + panel - 58, py + panel - 13, 2]];
	for (const [x, y, o] of leds) {
		ctx.fillStyle = COLORS[o].main;
		ctx.globalAlpha = 0.9;
		ctx.fillRect(x, y, 10, 4);
	}
	ctx.globalAlpha = 1;
}

function drawHeader(ctx, g, L) {
	const { W, OUT } = L;
	const cardW = Math.min(300, (W - OUT * 2 - 150) / 2), cardH = 72, y = 22;
	const names = [safeName(g.players[0].name, "P1"), safeName(g.players[1].name, g.players[1].isBot ? "Bot" : "P2")];
	const over = isOver(g);

	for (let i = 0; i < 2; i++) {
		const col = COLORS[i + 1];
		const x = i === 0 ? OUT : W - OUT - cardW;
		const active = g.status === "playing" && !over && g.turn === i;
		rrect(ctx, x, y, cardW, cardH, 14);
		ctx.fillStyle = active ? "rgba(" + col.rgb + ",0.16)" : "rgba(255,255,255,0.04)";
		ctx.fill();
		ctx.shadowColor = col.main;
		ctx.shadowBlur = active ? 20 : 0;
		ctx.strokeStyle = active ? col.main : "rgba(" + col.rgb + ",0.35)";
		ctx.lineWidth = active ? 3 : 2;
		ctx.stroke();
		ctx.shadowBlur = 0;

		ctx.textBaseline = "middle";
		ctx.textAlign = i === 0 ? "left" : "right";
		const tx = i === 0 ? x + 16 : x + cardW - 16;
		ctx.font = "bold 21px Arial, sans-serif";
		ctx.fillStyle = col.main;
		ctx.fillText(fitText(ctx, names[i], cardW - 110), tx, y + 25);
		ctx.font = "13px Arial, sans-serif";
		ctx.fillStyle = "#8ea3b3";
		const sub = active ? "YOUR TURN" : (g.players[i].isBot ? "BOT · " + LEVELS[g.difficulty].toUpperCase() : "PLAYER " + (i + 1));
		ctx.fillText(sub, tx, y + 50);

		ctx.font = "bold 38px Arial, sans-serif";
		ctx.fillStyle = "#ffffff";
		ctx.textAlign = i === 0 ? "right" : "left";
		ctx.fillText(String(g.scores[i]), i === 0 ? x + cardW - 16 : x + 16, y + cardH / 2);
	}

	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const tg = ctx.createLinearGradient(W / 2 - 80, 0, W / 2 + 80, 0);
	tg.addColorStop(0, COLORS[1].main);
	tg.addColorStop(1, COLORS[2].main);
	ctx.fillStyle = tg;
	ctx.font = "bold 18px Arial, sans-serif";
	ctx.fillText("DOTS", W / 2, y + 22);
	ctx.fillText("& BOXES", W / 2, y + 44);
	ctx.fillStyle = "#6f8392";
	ctx.font = "13px Arial, sans-serif";
	ctx.fillText(g.n + " x " + g.n, W / 2, y + 66);
}

function drawFooter(ctx, g, L) {
	const { W, H, FOOT } = L;
	const y = H - FOOT / 2 - 4;
	ctx.shadowBlur = 0;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const names = [safeName(g.players[0].name, "P1"), safeName(g.players[1].name, g.players[1].isBot ? "Bot" : "P2")];

	if (isOver(g)) {
		const [a, b] = g.scores;
		ctx.font = "bold 28px Arial, sans-serif";
		if (a === b) {
			ctx.fillStyle = "#e8eef3";
			ctx.fillText("DRAW  " + a + " - " + b, W / 2, y);
		} else {
			const w = a > b ? 0 : 1;
			ctx.shadowColor = COLORS[w + 1].main;
			ctx.shadowBlur = 20;
			ctx.fillStyle = COLORS[w + 1].main;
			ctx.fillText(fitText(ctx, names[w], W - 260) + " WINS!", W / 2, y);
			ctx.shadowBlur = 0;
		}
		return;
	}
	const col = COLORS[g.turn + 1];
	ctx.font = "bold 22px Arial, sans-serif";
	ctx.fillStyle = col.main;
	ctx.fillText("Turn: " + fitText(ctx, names[g.turn], W - 320), W / 2, y - 12);
	ctx.font = "14px Arial, sans-serif";
	ctx.fillStyle = "#7c91a1";
	ctx.fillText("Reply one or more line NUMBERS", W / 2, y + 18);
}
