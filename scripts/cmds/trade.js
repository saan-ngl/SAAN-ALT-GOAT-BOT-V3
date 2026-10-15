if (!global.tradeLimitData) {
  global.tradeLimitData = new Map();
}

module.exports = {
  config: {
    name: "trade",
    aliases: ["quotex", "qx"],
    version: "3.9",
    author: "𝐒𝐈𝐀𝐌 𝐀𝐇𝐌𝐄𝐃 𝐒𝐀𝐀𝐍",
    countDown: 13,
    role: 0,
    shortDescription: "Binary Options Trading Game",
    longDescription: "Predict market movement (up/down) and win virtual money.",
    category: "GAMES",
    guide: "{pn} <amount> <up/down>"
  },

  onStart: async function ({ api, event, args, usersData, message }) {
    const { senderID } = event;

    const MIN_BET = 10;
    const MAX_BET = 1e9; // 1 Billion
    const TRADE_LIMIT = 15;
    const RESET_TIME = 12 * 60 * 60 * 1000;
    const WIN_RATE = 65;
    const PAYOUT = 1.85;

    const formatMoney = (num) => {
      const n = Number(num);
      if (!Number.isFinite(n)) return "∞";

      if (Math.abs(n) < 1000) {
        return Math.floor(n).toString();
      }

      const units = [
        { v: 1e12, s: "T" },
        { v: 1e9, s: "B" },
        { v: 1e6, s: "M" },
        { v: 1e3, s: "K" }
      ];

      for (const u of units) {
        if (Math.abs(n) >= u.v) {
          return (n / u.v).toFixed(2).replace(/\.?0+$/, "") + u.s;
        }
      }

      return n.toLocaleString();
    };

    const parseAmount = (input) => {
      if (!input) return NaN;

      const a = input.toLowerCase().trim();
      const match = a.match(/^(\d+(?:\.\d+)?)([kmbt]?)$/);

      if (!match) return NaN;

      const value = Number(match[1]);
      const suffix = match[2];

      const multipliers = {
        "": 1,
        k: 1e3,
        m: 1e6,
        b: 1e9,
        t: 1e12
      };

      return value * multipliers[suffix];
    };

    if (args.length < 2) {
      return message.reply(
        "⚠️ Invalid format!\n" +
        "━━━━━━━━━━━━━━━━━━\n" +
        "📌 Example: /trade 1k up\n" +
        "📌 Example: /trade 100m down\n" +
        "📌 Maximum: 1B"
      );
    }

    const betAmount = parseAmount(args[0]);
    const prediction = args[1].toLowerCase();

    if (!Number.isFinite(betAmount) || betAmount < MIN_BET) {
      return message.reply(
        `🎰 Minimum trade: $${formatMoney(MIN_BET)}`
      );
    }

    if (betAmount > MAX_BET) {
      return message.reply(
        `🚫 Maximum trade: $${formatMoney(MAX_BET)}`
      );
    }

    if (!["up", "down", "call", "put"].includes(prediction)) {
      return message.reply(
        "⚠️ Choose either UP (Call) or DOWN (Put)!"
      );
    }

    const userData = await usersData.get(senderID);

    if (!userData) {
      return message.reply("❌ User data not found. Try again.");
    }

    const balance = Number(userData.money || 0);

    if (!Number.isFinite(balance) || balance < betAmount) {
      return message.reply(
        `💸 Insufficient balance!\n` +
        `💳 Balance: $${formatMoney(balance)}`
      );
    }

    const now = Date.now();
    let tradeData = global.tradeLimitData.get(senderID);

    if (!tradeData || now >= tradeData.resetAt) {
      tradeData = {
        count: 0,
        resetAt: now + RESET_TIME
      };
    }

    if (tradeData.count >= TRADE_LIMIT) {
      const remaining = Math.max(0, tradeData.resetAt - now);
      const hours = Math.floor(remaining / 3600000);
      const minutes = Math.floor((remaining % 3600000) / 60000);

      global.tradeLimitData.set(senderID, tradeData);

      return message.reply(
        `🚫 𝗧𝗥𝗔𝗗𝗘 𝗟𝗜𝗠𝗜𝗧 𝗥𝗘𝗔𝗖𝗛𝗘𝗗\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 Used: ${TRADE_LIMIT}/${TRADE_LIMIT}\n` +
        `⏳ Reset in: ${hours}h ${minutes}m\n` +
        `🔒 Try again after the limit resets.`
      );
    }

    tradeData.count++;
    global.tradeLimitData.set(senderID, tradeData);

    const isCall = prediction === "up" || prediction === "call";
    const direction = isCall ? "🟢 CALL (UP)" : "🔴 PUT (DOWN)";
    const tradeNumber = tradeData.count;

    const sentMsg = await message.reply(
      `📊 𝗤𝗨𝗢𝗧𝗘 𝗧𝗥𝗔𝗗𝗘 𝗦𝗧𝗔𝗥𝗧𝗘𝗗\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🎯 Direction: ${direction}\n` +
      `💰 Investment: $${formatMoney(betAmount)}\n` +
      `📈 Trade: ${tradeNumber}/${TRADE_LIMIT}\n` +
      `⏳ Status: Analyzing market...`
    );

    setTimeout(async () => {
      try {
        const isWin = Math.random() * 100 < WIN_RATE;
        let finalMoney;
        let resultText;

        // Re-fetch balance so the result uses the latest saved data.
        const latestData = await usersData.get(senderID);

        if (!latestData) {
          throw new Error("User data not found during trade settlement.");
        }

        const currentBalance = Number(latestData.money || 0);

        if (isWin) {
          const profit = Math.floor(betAmount * (PAYOUT - 1));
          finalMoney = currentBalance + profit;
          latestData.money = finalMoney;

          await usersData.set(senderID, latestData);

          resultText =
            `🎉 𝗜𝗧𝗠 — 𝗧𝗥𝗔𝗗𝗘 𝗪𝗢𝗡\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📈 Result: ${isCall ? "UP 🟢" : "DOWN 🔴"}\n` +
            `💰 Profit: +$${formatMoney(profit)}\n` +
            `💳 Balance: $${formatMoney(finalMoney)}\n` +
            `📊 Trades: ${tradeNumber}/${TRADE_LIMIT}`;
        } else {
          finalMoney = Math.max(0, currentBalance - betAmount);
          latestData.money = finalMoney;

          await usersData.set(senderID, latestData);

          resultText =
            `💀 𝗢𝗧𝗠 — 𝗧𝗥𝗔𝗗𝗘 𝗟𝗢𝗦𝗧\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📉 Result: ${isCall ? "DOWN 🔴" : "UP 🟢"}\n` +
            `💸 Loss: -$${formatMoney(betAmount)}\n` +
            `💳 Balance: $${formatMoney(finalMoney)}\n` +
            `📊 Trades: ${tradeNumber}/${TRADE_LIMIT}`;
        }

        if (sentMsg?.messageID) {
          try {
            await api.unsendMessage(sentMsg.messageID);
          } catch (e) {}
        }

        return message.reply(resultText);
      } catch (error) {
        console.error("Trade Error:", error);

        if (sentMsg?.messageID) {
          try {
            await api.unsendMessage(sentMsg.messageID);
          } catch (e) {}
        }

        return message.reply(
          "❌ An error occurred while processing your trade."
        );
      }
    }, 7000);
  }
};