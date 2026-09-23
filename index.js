/**
 * LARP TP - Discord Bot + API
 * Invites · Keydrop · Logs · Spin · Dice
 * Language: English
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const API_SECRET = process.env.API_SECRET || "change_me";
const PORT = process.env.PORT || 3000;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || ""; // optional Discord channel for live logs
const BOT_ADMINS = (process.env.BOT_ADMINS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const DATA_DIR = process.env.DATA_DIR || "/tmp";
const DATA_FILE = path.join(DATA_DIR, "larp-data.json");
const LOCAL_FALLBACK = path.join(__dirname, "data.json");

const DAY_MS = 24 * 60 * 60 * 1000;

const INVITE_COST_1H = 1;
const INVITE_COST_SPINS = 1;
const INVITE_COST_1D = 5;
const SPINS_REWARD = 2;

const DICE_COLORS = [
  { name: "Red", emoji: "🔴", value: "Red", color: 0xe74c3c },
  { name: "Blue", emoji: "🔵", value: "Blue", color: 0x3498db },
  { name: "Green", emoji: "🟢", value: "Green", color: 0x2ecc71 },
  { name: "Yellow", emoji: "🟡", value: "Yellow", color: 0xf1c40f },
  { name: "Orange", emoji: "🟠", value: "Orange", color: 0xe67e22 },
  { name: "Violet", emoji: "🟣", value: "Violet", color: 0x9b59b6 },
];

// Active keydrops: messageId → { keysLeft, duration, claimed: Set }
const activeDrops = new Map();

// Guess the number: guildId → game state
const guessGames = new Map();

// Raffle: guildId → { prize, entrants: Set, messageId, active }
const activeRaffles = new Map();

function loadData() {
  for (const file of [DATA_FILE, LOCAL_FALLBACK]) {
    try {
      if (fs.existsSync(file)) {
        const d = JSON.parse(fs.readFileSync(file, "utf8"));
        d.keys = d.keys || {};
        d.admins = d.admins || ["narutosde2p"];
        d.whitelist = d.whitelist || {};
        d.pausedWhitelist = d.pausedWhitelist || {};
        d.lifetimeWhitelist = d.lifetimeWhitelist || {};
        d.logs = d.logs || [];
        d.spins = d.spins || {};
        d.dice = d.dice || {};
        d.spinsBonus = d.spinsBonus || {};
        d.diceBonus = d.diceBonus || {};
        d.globalSpinBonus = d.globalSpinBonus || 0;
        d.globalDiceBonus = d.globalDiceBonus || 0;
        d.invites = d.invites || {};
        d.invitesUsed = d.invitesUsed || {};
        d.invitedUsers = d.invitedUsers || {};
        d.tpLogs = d.tpLogs || [];
        d.stats = d.stats || {}; // userId -> { spinWins, diceWins, redeems, codes }
        d.streaks = d.streaks || {}; // userId -> { count, lastDay }
        d.codes = d.codes || {}; // CODE -> { duration, maxUses, uses, reward, expiresAt }
        d.blacklist = d.blacklist || {}; // robloxUsername -> { reason, by, at }
        return d;
      }
    } catch (e) {
      console.warn("loadData", file, e.message);
    }
  }
  return {
    admins: ["narutosde2p"],
    whitelist: {},
    pausedWhitelist: {},
    lifetimeWhitelist: {},
    keys: {},
    logs: [],
    spins: {},
    dice: {},
    spinsBonus: {},
    diceBonus: {},
    globalSpinBonus: 0,
    globalDiceBonus: 0,
    invites: {},
    invitesUsed: {},
    invitedUsers: {},
    tpLogs: [],
    stats: {},
    streaks: {},
    codes: {},
    blacklist: {},
  };
}

function bumpStat(data, userId, field, n) {
  data.stats = data.stats || {};
  if (!data.stats[userId]) data.stats[userId] = { spinWins: 0, diceWins: 0, redeems: 0, codes: 0 };
  data.stats[userId][field] = (data.stats[userId][field] || 0) + (n || 1);
}

function dayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function saveData(data) {
  try {
    if (data.logs && data.logs.length > 200) data.logs = data.logs.slice(-200);
    if (data.tpLogs && data.tpLogs.length > 200) data.tpLogs = data.tpLogs.slice(-200);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn("saveData failed", e.message);
    try {
      fs.writeFileSync(LOCAL_FALLBACK, JSON.stringify(data, null, 2));
    } catch (e2) {
      console.warn("saveData fallback failed", e2.message);
    }
  }
}

function addLog(action, by, target, details) {
  try {
    const data = loadData();
    const entry = {
      at: new Date().toISOString(),
      action,
      by: by || "",
      target: target || "",
      details: details || "",
    };
    data.logs.push(entry);
    saveData(data);
    // Live log to Discord channel if configured
    if (LOG_CHANNEL_ID && client.isReady()) {
      const ch = client.channels.cache.get(LOG_CHANNEL_ID);
      if (ch && ch.send) {
        const colors = {
          redeem: 0x2ecc71,
          tp: 0x3498db,
          createkey: 0x00e5ff,
          keydrop: 0xf1c40f,
          spin_win: 0x2ecc71,
          dice_win: 0x2ecc71,
          invite_claim: 0x9b59b6,
        };
        ch.send({
          embeds: [
            new EmbedBuilder()
              .setColor(colors[action] || 0x95a5a6)
              .setTitle("📋 " + String(action).toUpperCase())
              .setDescription(
                "**By:** " +
                  (by || "—") +
                  "\n**Target:** " +
                  (target || "—") +
                  "\n**Details:** " +
                  (details || "—")
              )
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn("addLog", e.message);
  }
}

function parseDuration(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().replace(/\s+/g, "");
  if (["life", "lifetime", "perm", "permanent"].includes(s)) {
    return { lifetime: true, seconds: 0 };
  }
  const m = s.match(/^(\d+)(m|min|mins|h|hr|hrs|d|day|days|mo|month|months)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  let seconds = 0;
  if (["m", "min", "mins"].includes(unit)) seconds = n * 60;
  else if (["h", "hr", "hrs"].includes(unit)) seconds = n * 3600;
  else if (["d", "day", "days"].includes(unit)) seconds = n * 86400;
  else if (["mo", "month", "months"].includes(unit)) seconds = n * 2592000;
  return { lifetime: false, seconds };
}

function isBotAdmin(userId) {
  return BOT_ADMINS.includes(String(userId));
}

function generateKey() {
  const part = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return "LARP-" + part() + "-" + part() + "-" + part();
}

function applyAccess(data, username, parsed) {
  const key = username.toLowerCase();
  delete data.whitelist[key];
  delete data.pausedWhitelist[key];
  delete data.lifetimeWhitelist[key];
  if (parsed.lifetime) data.lifetimeWhitelist[key] = true;
  else data.whitelist[key] = Math.floor(Date.now() / 1000) + parsed.seconds;
}

function timeLeft(ms) {
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `~**${h}h ${m}m**`;
  return `~**${m}m**`;
}

function makeKey(durationStr, seconds, source) {
  const key = generateKey();
  return {
    key,
    data: {
      duration: durationStr,
      lifetime: false,
      seconds,
      durationSeconds: seconds,
      used: false,
      usedBy: null,
      createdBy: source,
      createdAt: new Date().toISOString(),
    },
  };
}

function makeKey1h(source) {
  return makeKey("1h", 3600, source);
}

async function sendKeyDM(user, key, durationStr) {
  try {
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x00e5ff)
          .setTitle("🔑 Your LARP TP Key")
          .setDescription(
            "Here is your key:\n\n🔑 `" +
              key +
              "`\n⏱️ Duration: **" +
              durationStr +
              "**\n\n" +
              "➡️ In-game: **My Key → Redeem**\n" +
              "➡️ Or `/redeem` on Discord"
          )
          .setFooter({ text: "LARP TP" })
          .setTimestamp(),
      ],
    });
    return true;
  } catch {
    return false;
  }
}

function getBonus(data, type, uid) {
  if (type === "spin") {
    return (data.spinsBonus[uid] || 0) + (data.globalSpinBonus || 0);
  }
  return (data.diceBonus[uid] || 0) + (data.globalDiceBonus || 0);
}

function consumeBonus(data, type, uid) {
  if (type === "spin") {
    if ((data.spinsBonus[uid] || 0) > 0) {
      data.spinsBonus[uid] -= 1;
      return;
    }
    if ((data.globalSpinBonus || 0) > 0) data.globalSpinBonus -= 1;
  } else {
    if ((data.diceBonus[uid] || 0) > 0) {
      data.diceBonus[uid] -= 1;
      return;
    }
    if ((data.globalDiceBonus || 0) > 0) data.globalDiceBonus -= 1;
  }
}

function getInvitePoints(data, uid) {
  return data.invites[uid] || 0;
}

function addInvitePoints(data, uid, amount) {
  data.invites[uid] = (data.invites[uid] || 0) + amount;
}

function spendInvitePoints(data, uid, amount) {
  const cur = data.invites[uid] || 0;
  if (cur < amount) return false;
  data.invites[uid] = cur - amount;
  data.invitesUsed[uid] = (data.invitesUsed[uid] || 0) + amount;
  return true;
}

function spinVisual(roll, win) {
  const fill = Math.min(10, Math.floor(roll / 10));
  const bar = "▰".repeat(fill) + "▱".repeat(10 - fill);
  return (
    "```\n" +
    "  🎰  LARP SPIN  🎰\n" +
    "  ┌──────────────┐\n" +
    "  │  " +
    bar +
    "  │\n" +
    "  │    " +
    String(roll).padStart(3, " ") +
    " / 100    │\n" +
    "  └──────────────┘\n" +
    "```\n" +
    (win ? "✨ **JACKPOT** ✨" : "💨 *nothing this time...*")
  );
}

function diceVisual(pickEmoji, pick, rolledEmojis, match) {
  const line = rolledEmojis.join("  ");
  return (
    "```\n" +
    "  🎲  LARP DICE  🎲\n" +
    "  ┌──────────────────┐\n" +
    "  │  " +
    line +
    "  │\n" +
    "  └──────────────────┘\n" +
    "```\n" +
    "You picked " +
    pickEmoji +
    " **" +
    pick +
    "**\n" +
    "The 4 colors: " +
    line +
    "\n\n" +
    (match
      ? "🎉🎊 **YOUR COLOR APPEARED!** You win a **1h** key 🔑"
      : "💔 Your color did not appear... try again tomorrow!")
  );
}

function buildInvitePanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("🎟️ Invite Panel — LARP TP")
    .setDescription(
      "Exchange your **invite points** for rewards!\n\n" +
        "**Rates:**\n" +
        "• `1` invite → 🔑 **1h** key *(sent in DM)*\n" +
        "• `1` invite → 🎰 **2 spins**\n" +
        "• `5` invites → 🔑 **1 day** key *(sent in DM)*\n\n" +
        "⚠️ Each point can only be **spent once**.\n" +
        "Admins grant points with `/addinvites`.\n" +
        "Click a button below to claim."
    )
    .setFooter({ text: "LARP TP • Invites" })
    .setTimestamp();
}

function buildInvitePanelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("inv_claim_1h")
      .setLabel("1 invite → 1h key")
      .setEmoji("🔑")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("inv_claim_spins")
      .setLabel("1 invite → 2 Spins")
      .setEmoji("🎰")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("inv_claim_1d")
      .setLabel("5 invites → 1d key")
      .setEmoji("💎")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("inv_check")
      .setLabel("My invites")
      .setEmoji("📊")
      .setStyle(ButtonStyle.Secondary)
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName("createkey")
    .setDescription("🔑 Create LARP TP key(s)")
    .addStringOption((o) =>
      o.setName("duration").setDescription("30m / 1h / 1d / lifetime").setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Number of keys (1-20)").setMinValue(1).setMaxValue(20)
    ),
  new SlashCommandBuilder()
    .setName("givekey")
    .setDescription("🎁 Create a key and DM it")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("30m / 1h / 1d / lifetime").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("redeem")
    .setDescription("✅ Redeem a key")
    .addStringOption((o) => o.setName("key").setDescription("LARP-XXXX key").setRequired(true))
    .addStringOption((o) =>
      o.setName("username").setDescription("Roblox username").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("checkkey")
    .setDescription("🔍 Check a key")
    .addStringOption((o) => o.setName("key").setDescription("Key").setRequired(true)),
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("➕ Whitelist without key")
    .addStringOption((o) => o.setName("username").setDescription("Roblox username").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("1h / lifetime").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("➖ Remove from whitelist")
    .addStringOption((o) => o.setName("username").setDescription("Roblox username").setRequired(true)),
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("👤 Player info")
    .addStringOption((o) => o.setName("username").setDescription("Roblox username").setRequired(true)),
  new SlashCommandBuilder().setName("list").setDescription("📋 Whitelist list"),
  new SlashCommandBuilder()
    .setName("spin")
    .setDescription("🎰 Daily spin — chance to win a 1h key (1× / day)"),
  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("🎲 Pick 1 color — 4 roll, if yours appears = 1h key (1×/day)")
    .addStringOption((o) =>
      o
        .setName("color")
        .setDescription("Your color")
        .setRequired(true)
        .addChoices(
          { name: "🔴 Red", value: "Red" },
          { name: "🔵 Blue", value: "Blue" },
          { name: "🟢 Green", value: "Green" },
          { name: "🟡 Yellow", value: "Yellow" },
          { name: "🟠 Orange", value: "Orange" },
          { name: "🟣 Violet", value: "Violet" }
        )
    ),
  new SlashCommandBuilder()
    .setName("resetspin")
    .setDescription("🔄 Reset spin cooldown (user or all)")
    .addUserOption((o) => o.setName("user").setDescription("Member"))
    .addBooleanOption((o) => o.setName("all").setDescription("Reset everyone")),
  new SlashCommandBuilder()
    .setName("resetdice")
    .setDescription("🔄 Reset dice cooldown (user or all)")
    .addUserOption((o) => o.setName("user").setDescription("Member"))
    .addBooleanOption((o) => o.setName("all").setDescription("Reset everyone")),
  new SlashCommandBuilder()
    .setName("giveallspin")
    .setDescription("🎁 Reset cooldown + global spin bonus for everyone")
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Global bonus (default 1)").setMinValue(1).setMaxValue(10)
    ),
  new SlashCommandBuilder()
    .setName("givealldice")
    .setDescription("🎁 Reset cooldown + global dice bonus for everyone")
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Global bonus (default 1)").setMinValue(1).setMaxValue(10)
    ),
  new SlashCommandBuilder()
    .setName("givespin")
    .setDescription("🎁 Give spins to a user")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Amount (default 1)").setMinValue(1).setMaxValue(20)
    ),
  new SlashCommandBuilder()
    .setName("givedice")
    .setDescription("🎁 Give dice to a user")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Amount (default 1)").setMinValue(1).setMaxValue(20)
    ),
  new SlashCommandBuilder().setName("invites").setDescription("🎟️ Check your invite points"),
  new SlashCommandBuilder()
    .setName("invitepanel")
    .setDescription("📌 Post the invite panel (stays in channel)"),
  new SlashCommandBuilder()
    .setName("addinvites")
    .setDescription("➕ Add invite points to a user (admin)")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Points").setRequired(true).setMinValue(1).setMaxValue(100)
    ),
  new SlashCommandBuilder()
    .setName("setinvites")
    .setDescription("✏️ Set invite points for a user (admin)")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("New total").setRequired(true).setMinValue(0).setMaxValue(999)
    ),
  // GUESS THE NUMBER
  new SlashCommandBuilder()
    .setName("guessstart")
    .setDescription("🎯 Start Guess the Number (you pick the secret number)")
    .addIntegerOption((o) =>
      o
        .setName("number")
        .setDescription("The secret number players must find")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(1000000)
    )
    .addIntegerOption((o) =>
      o.setName("min").setDescription("Min range shown to players (default 1)").setMinValue(0)
    )
    .addIntegerOption((o) =>
      o.setName("max").setDescription("Max range shown to players (default 100)").setMinValue(1)
    )
    .addBooleanOption((o) =>
      o.setName("reward").setDescription("Give a 1h key to the winner? (default true)")
    ),
  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("🎯 Guess the secret number")
    .addIntegerOption((o) =>
      o.setName("number").setDescription("Your guess").setRequired(true).setMinValue(0).setMaxValue(1000000)
    ),
  new SlashCommandBuilder()
    .setName("guessend")
    .setDescription("🛑 End the current Guess the Number game"),
  new SlashCommandBuilder()
    .setName("guessinfo")
    .setDescription("ℹ️ Info about the current Guess the Number game"),
  // KEYDROP
  new SlashCommandBuilder()
    .setName("keydrop")
    .setDescription("🎁 Drop claimable keys in this channel")
    .addStringOption((o) =>
      o.setName("duration").setDescription("Key duration (e.g. 1h, 1d)").setRequired(true)
    )
    .addIntegerOption((o) =>
      o
        .setName("amount")
        .setDescription("How many keys can be claimed")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(50)
    ),
  // LOGS
  new SlashCommandBuilder()
    .setName("logs")
    .setDescription("📋 View recent bot logs")
    .addIntegerOption((o) =>
      o.setName("limit").setDescription("How many (default 15)").setMinValue(5).setMaxValue(30)
    )
    .addStringOption((o) =>
      o
        .setName("type")
        .setDescription("Filter by type")
        .addChoices(
          { name: "All", value: "all" },
          { name: "Redeem", value: "redeem" },
          { name: "TP", value: "tp" },
          { name: "Keydrop", value: "keydrop" },
          { name: "Spin/Dice", value: "games" },
          { name: "Invites", value: "invite" }
        )
    ),
  new SlashCommandBuilder()
    .setName("tplogs")
    .setDescription("📍 View recent in-game TP logs")
    .addIntegerOption((o) =>
      o.setName("limit").setDescription("How many (default 15)").setMinValue(5).setMaxValue(30)
    ),
  // LEADERBOARD
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("🏆 Leaderboard")
    .addStringOption((o) =>
      o
        .setName("type")
        .setDescription("Category")
        .setRequired(true)
        .addChoices(
          { name: "Invites", value: "invites" },
          { name: "Spin wins", value: "spins" },
          { name: "Dice wins", value: "dice" },
          { name: "Redeems", value: "redeems" }
        )
    ),
  // DAILY STREAK
  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("📅 Claim your daily streak reward"),
  new SlashCommandBuilder()
    .setName("streak")
    .setDescription("🔥 Check your daily streak"),
  // PROMO CODES
  new SlashCommandBuilder()
    .setName("createcode")
    .setDescription("🏷️ Create a promo code (admin)")
    .addStringOption((o) => o.setName("code").setDescription("Code text").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("Key duration e.g. 1h / 1d").setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("maxuses").setDescription("Max redemptions (default 1)").setMinValue(1).setMaxValue(500)
    )
    .addIntegerOption((o) =>
      o.setName("hours").setDescription("Code expires after X hours (0 = never)").setMinValue(0).setMaxValue(720)
    ),
  new SlashCommandBuilder()
    .setName("code")
    .setDescription("🏷️ Redeem a promo code")
    .addStringOption((o) => o.setName("code").setDescription("The code").setRequired(true)),
  new SlashCommandBuilder()
    .setName("listcodes")
    .setDescription("🏷️ List active promo codes (admin)"),
  new SlashCommandBuilder()
    .setName("deletecode")
    .setDescription("🗑️ Delete a promo code (admin)")
    .addStringOption((o) => o.setName("code").setDescription("Code to delete").setRequired(true)),
  // BLACKLIST
  new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("🚫 Blacklist a Roblox username (admin)")
    .addStringOption((o) => o.setName("username").setDescription("Roblox username").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder()
    .setName("unblacklist")
    .setDescription("✅ Remove from blacklist (admin)")
    .addStringOption((o) => o.setName("username").setDescription("Roblox username").setRequired(true)),
  new SlashCommandBuilder()
    .setName("blacklistcheck")
    .setDescription("🔍 Check if a Roblox user is blacklisted")
    .addStringOption((o) => o.setName("username").setDescription("Roblox username").setRequired(true)),
  // EXPIRATION
  new SlashCommandBuilder()
    .setName("checkexpires")
    .setDescription("⏰ List whitelist entries expiring soon (admin)")
    .addIntegerOption((o) =>
      o.setName("hours").setDescription("Within how many hours (default 24)").setMinValue(1).setMaxValue(168)
    ),
  // RAFFLE
  new SlashCommandBuilder()
    .setName("raffle")
    .setDescription("🎊 Start a raffle (admin)")
    .addStringOption((o) =>
      o.setName("prize").setDescription("Prize description e.g. 1h key").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("raffleend")
    .setDescription("🎊 Draw raffle winner (admin)"),
].map((c) => c.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("clientReady", () => {
  console.log("[BOT] Connected:", client.user.tag);
  console.log("[BOT] Admin IDs:", BOT_ADMINS.join(", ") || "(none)");
});
client.once("ready", () => {
  console.log("[BOT] Connected (ready):", client.user.tag);
  console.log("[BOT] Admin IDs:", BOT_ADMINS.join(", ") || "(none)");
});

client.on("interactionCreate", async (interaction) => {
  // ─── BUTTONS ───────────────────────────────────────────
  if (interaction.isButton()) {
    const id = interaction.customId;

    // Keydrop claim
    if (id.startsWith("keydrop_claim_")) {
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch {
        return;
      }
      const msgId = id.replace("keydrop_claim_", "");
      const drop = activeDrops.get(msgId);
      if (!drop) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Drop expired")
              .setDescription("This keydrop is no longer active."),
          ],
        });
      }
      if (drop.claimed.has(interaction.user.id)) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("⚠️ Already claimed")
              .setDescription("You already claimed a key from this drop."),
          ],
        });
      }
      if (drop.keysLeft <= 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Sold out")
              .setDescription("All keys from this drop have been claimed."),
          ],
        });
      }

      drop.keysLeft -= 1;
      drop.claimed.add(interaction.user.id);

      const data = loadData();
      const parsed = parseDuration(drop.duration);
      const { key, data: kData } = makeKey(
        drop.duration,
        parsed ? parsed.seconds : 3600,
        "keydrop"
      );
      data.keys[key] = kData;
      saveData(data);
      addLog("keydrop", interaction.user.tag, "", key + " (" + drop.duration + ")");

      const dmOk = await sendKeyDM(interaction.user, key, drop.duration);

      // Update drop message
      try {
        const embed = EmbedBuilder.from(drop.embedData);
        embed.setDescription(
          drop.baseDesc +
            "\n\n**Remaining:** `" +
            drop.keysLeft +
            "` / `" +
            drop.total +
            "`"
        );
        if (drop.keysLeft <= 0) {
          embed.setColor(0x95a5a6);
          embed.setTitle("🎁 Keydrop — SOLD OUT");
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("keydrop_claim_" + msgId)
            .setLabel(drop.keysLeft > 0 ? "Claim key" : "Sold out")
            .setEmoji("🔑")
            .setStyle(ButtonStyle.Success)
            .setDisabled(drop.keysLeft <= 0)
        );
        await interaction.message.edit({ embeds: [embed], components: [row] });
      } catch (_) {}

      if (drop.keysLeft <= 0) activeDrops.delete(msgId);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Key claimed!")
            .setDescription(
              dmOk
                ? "📩 **" + drop.duration + "** key sent to your **DMs**!"
                : "⚠️ DMs closed — key: `" + key + "`"
            )
            .setTimestamp(),
        ],
      });
    }

    // Invite buttons
    // Raffle join
    if (id === "raffle_join") {
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch {
        return;
      }
      const guildId = interaction.guildId || "dm";
      const raffle = activeRaffles.get(guildId);
      if (!raffle || !raffle.active) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ No active raffle")
              .setDescription("This raffle has ended."),
          ],
        });
      }
      if (raffle.entrants.has(interaction.user.id)) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("⚠️ Already joined")
              .setDescription("You are already in this raffle."),
          ],
        });
      }
      raffle.entrants.add(interaction.user.id);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Joined raffle!")
            .setDescription(
              "Prize: **" +
                raffle.prize +
                "**\nEntrants: **" +
                raffle.entrants.size +
                "**"
            ),
        ],
      });
    }

    if (!id.startsWith("inv_")) return;

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch {
      return;
    }

    const uid = interaction.user.id;
    const data = loadData();
    data.invites = data.invites || {};
    data.invitesUsed = data.invitesUsed || {};
    data.spinsBonus = data.spinsBonus || {};
    data.keys = data.keys || {};

    if (id === "inv_check") {
      const pts = getInvitePoints(data, uid);
      const used = data.invitesUsed[uid] || 0;
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle("📊 Your invites")
            .setDescription(
              "🎟️ Available points: **" +
                pts +
                "**\n" +
                "✅ Already spent: **" +
                used +
                "**\n\n" +
                "**Rates:**\n• 1 → 1h key\n• 1 → 2 spins\n• 5 → 1 day key"
            )
            .setTimestamp(),
        ],
      });
    }

    if (id === "inv_claim_1h") {
      if (!spendInvitePoints(data, uid, INVITE_COST_1H)) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Not enough invites")
              .setDescription(
                "You need **1** invite.\nYou have: **" + getInvitePoints(data, uid) + "**"
              ),
          ],
        });
      }
      const { key, data: kData } = makeKey1h("invite");
      data.keys[key] = kData;
      saveData(data);
      addLog("invite_claim", interaction.user.tag, "", "1h key " + key);
      const dmOk = await sendKeyDM(interaction.user, key, "1h");
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ 1h key claimed!")
            .setDescription(
              "🎟️ -1 invite\n\n" +
                (dmOk ? "📩 Key sent to your **DMs**!" : "⚠️ DMs closed — key: `" + key + "`")
            )
            .setFooter({ text: "Left: " + getInvitePoints(data, uid) + " invite(s)" })
            .setTimestamp(),
        ],
      });
    }

    if (id === "inv_claim_spins") {
      if (!spendInvitePoints(data, uid, INVITE_COST_SPINS)) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Not enough invites")
              .setDescription(
                "You need **1** invite.\nYou have: **" + getInvitePoints(data, uid) + "**"
              ),
          ],
        });
      }
      data.spinsBonus[uid] = (data.spinsBonus[uid] || 0) + SPINS_REWARD;
      delete data.spins[uid];
      saveData(data);
      addLog("invite_claim", interaction.user.tag, "", "2 spins");
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ 2 Spins claimed!")
            .setDescription("🎟️ -1 invite\n\n🎰 You received **2 bonus spins**.\nUse `/spin` now!")
            .setFooter({ text: "Left: " + getInvitePoints(data, uid) + " invite(s)" })
            .setTimestamp(),
        ],
      });
    }

    if (id === "inv_claim_1d") {
      if (!spendInvitePoints(data, uid, INVITE_COST_1D)) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Not enough invites")
              .setDescription(
                "You need **5** invites.\nYou have: **" + getInvitePoints(data, uid) + "**"
              ),
          ],
        });
      }
      const { key, data: kData } = makeKey("1d", 86400, "invite");
      data.keys[key] = kData;
      saveData(data);
      addLog("invite_claim", interaction.user.tag, "", "1d key " + key);
      const dmOk = await sendKeyDM(interaction.user, key, "1d");
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ 1 day key claimed!")
            .setDescription(
              "🎟️ -5 invites\n\n" +
                (dmOk ? "📩 Key sent to your **DMs**!" : "⚠️ DMs closed — key: `" + key + "`")
            )
            .setFooter({ text: "Left: " + getInvitePoints(data, uid) + " invite(s)" })
            .setTimestamp(),
        ],
      });
    }

    return interaction.editReply({ content: "❓ Unknown button." });
  }

  // ─── SLASH COMMANDS ────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  console.log("[CMD]", cmd, "by", interaction.user.id, interaction.user.tag);

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (e) {
    console.error("defer failed", e);
    return;
  }

  const publicCmds = [
    "redeem",
    "checkkey",
    "info",
    "spin",
    "dice",
    "invites",
    "guess",
    "guessinfo",
    "leaderboard",
    "daily",
    "streak",
    "code",
    "blacklistcheck",
  ];
  const needsAdmin = !publicCmds.includes(cmd);

  if (needsAdmin && !isBotAdmin(interaction.user.id)) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle("⛔ Access denied")
          .setDescription(
            "You don't have permission.\nYour ID: `" +
              interaction.user.id +
              "`\nAdd it to **BOT_ADMINS** on your host."
          )
          .setTimestamp(),
      ],
    });
  }

  try {
    const data = loadData();
    data.spins = data.spins || {};
    data.dice = data.dice || {};
    data.spinsBonus = data.spinsBonus || {};
    data.diceBonus = data.diceBonus || {};
    data.globalSpinBonus = data.globalSpinBonus || 0;
    data.globalDiceBonus = data.globalDiceBonus || 0;
    data.invites = data.invites || {};
    data.invitesUsed = data.invitesUsed || {};
    data.invitedUsers = data.invitedUsers || {};
    data.tpLogs = data.tpLogs || [];
    data.logs = data.logs || [];

    if (cmd === "createkey") {
      const durationStr = interaction.options.getString("duration");
      const amount = interaction.options.getInteger("amount") || 1;
      const parsed = parseDuration(durationStr);
      if (!parsed) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Invalid duration")
              .setDescription("Examples: `30m` · `1h` · `1d` · `lifetime`"),
          ],
        });
      }
      const created = [];
      for (let i = 0; i < amount; i++) {
        const key = generateKey();
        data.keys[key] = {
          duration: durationStr,
          lifetime: parsed.lifetime,
          seconds: parsed.seconds,
          durationSeconds: parsed.seconds,
          used: false,
          usedBy: null,
          usedAt: null,
          robloxUsername: null,
          createdBy: interaction.user.tag,
          createdAt: new Date().toISOString(),
        };
        created.push(key);
      }
      saveData(data);
      addLog("createkey", interaction.user.tag, "", amount + "x " + durationStr);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00e5ff)
            .setTitle("🔑 " + amount + " key(s) created")
            .setDescription(
              created.map((k) => "🔑 `" + k + "`").join("\n") +
                "\n\n⏱️ Duration: **" +
                durationStr +
                "**"
            )
            .setFooter({ text: "LARP TP • Keys" })
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "givekey") {
      const user = interaction.options.getUser("user");
      const durationStr = interaction.options.getString("duration");
      const parsed = parseDuration(durationStr);
      if (!parsed) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Invalid duration")
              .setDescription("Examples: `30m` · `1h` · `1d` · `lifetime`"),
          ],
        });
      }
      const key = generateKey();
      data.keys[key] = {
        duration: durationStr,
        lifetime: parsed.lifetime,
        seconds: parsed.seconds,
        durationSeconds: parsed.seconds,
        used: false,
        usedBy: null,
        createdBy: interaction.user.tag,
        createdAt: new Date().toISOString(),
        note: "DM " + user.tag,
      };
      saveData(data);
      const dmOk = await sendKeyDM(user, key, durationStr);
      addLog("givekey", interaction.user.tag, user.tag, durationStr);
      if (dmOk) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("✅ Key sent")
              .setDescription("DM sent to **" + user.tag + "** 🎉"),
          ],
        });
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf39c12)
            .setTitle("⚠️ DM failed")
            .setDescription("Key: `" + key + "`\nGive it manually."),
        ],
      });
    }

    if (cmd === "redeem") {
      const keyInput = interaction.options.getString("key").trim().toUpperCase();
      const username = interaction.options.getString("username").trim();
      const keyData = data.keys[keyInput];
      if (!keyData) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Invalid key")
              .setDescription("This key does not exist."),
          ],
        });
      }
      if (keyData.used) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("🔒 Key already used")
              .setDescription(
                keyData.robloxUsername
                  ? "Used by **" + keyData.robloxUsername + "**"
                  : "This key has already been redeemed."
              ),
          ],
        });
      }
      const uname = username.toLowerCase();
      data.blacklist = data.blacklist || {};
      if (data.blacklist[uname]) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("🚫 Blacklisted")
              .setDescription(
                "**" +
                  username +
                  "** is blacklisted.\nReason: " +
                  (data.blacklist[uname].reason || "—")
              ),
          ],
        });
      }
      if (data.lifetimeWhitelist[uname]) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ No stacking")
              .setDescription("This account already has **lifetime** ♾️"),
          ],
        });
      }
      const now = Math.floor(Date.now() / 1000);
      if (data.whitelist[uname] && data.whitelist[uname] > now) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ No stacking")
              .setDescription("This account already has time remaining."),
          ],
        });
      }
      applyAccess(data, username, {
        lifetime: keyData.lifetime,
        seconds: keyData.seconds || keyData.durationSeconds || 3600,
      });
      keyData.used = true;
      keyData.usedBy = interaction.user.tag;
      keyData.usedAt = new Date().toISOString();
      keyData.robloxUsername = uname;
      bumpStat(data, interaction.user.id, "redeems");
      saveData(data);
      addLog(
        "redeem",
        interaction.user.tag,
        uname,
        keyInput + " → " + (keyData.lifetime ? "LIFETIME" : keyData.duration)
      );
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Key accepted!")
            .setDescription(
              "👤 Player: **" +
                username +
                "**\n" +
                "⏱️ Access: **" +
                (keyData.lifetime ? "LIFETIME ♾️" : keyData.duration) +
                "**"
            )
            .setFooter({ text: "LARP TP • Redeem" })
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "checkkey") {
      const keyInput = interaction.options.getString("key").trim().toUpperCase();
      const keyData = data.keys[keyInput];
      if (!keyData) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Not found")
              .setDescription("This key does not exist."),
          ],
        });
      }
      if (keyData.used) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("🔒 Already used")
              .setDescription(
                "By: **" + (keyData.robloxUsername || keyData.usedBy || "?") + "**"
              ),
          ],
        });
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Valid key")
            .setDescription("⏱️ Duration: **" + keyData.duration + "**"),
        ],
      });
    }

    if (cmd === "add") {
      const username = interaction.options.getString("username").toLowerCase();
      const durationStr = interaction.options.getString("duration");
      const parsed = parseDuration(durationStr);
      if (!parsed) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Invalid duration")
              .setDescription("Examples: `1h` · `lifetime`"),
          ],
        });
      }
      applyAccess(data, username, parsed);
      saveData(data);
      addLog("add", interaction.user.tag, username, durationStr);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("➕ Whitelisted")
            .setDescription("👤 **" + username + "** → ⏱️ **" + durationStr + "**"),
        ],
      });
    }

    if (cmd === "remove") {
      const username = interaction.options.getString("username").toLowerCase();
      delete data.whitelist[username];
      delete data.pausedWhitelist[username];
      delete data.lifetimeWhitelist[username];
      saveData(data);
      addLog("remove", interaction.user.tag, username, "");
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("➖ Removed")
            .setDescription("👤 **" + username + "** no longer has access."),
        ],
      });
    }

    if (cmd === "info") {
      const username = interaction.options.getString("username").toLowerCase();
      const now = Math.floor(Date.now() / 1000);
      let status = "❌ No access";
      let color = 0x95a5a6;
      if (data.admins.includes(username)) {
        status = "👑 **ADMIN**";
        color = 0xf1c40f;
      } else if (data.lifetimeWhitelist[username]) {
        status = "♾️ **LIFETIME**";
        color = 0x9b59b6;
      } else if (data.whitelist[username] && data.whitelist[username] > now) {
        const mins = Math.floor((data.whitelist[username] - now) / 60);
        status = "🟢 **WHITELIST** — " + mins + " min left";
        color = 0x2ecc71;
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(color)
            .setTitle("👤 Player info")
            .setDescription("**" + username + "**\n" + status)
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "list") {
      const now = Math.floor(Date.now() / 1000);
      const life = Object.keys(data.lifetimeWhitelist);
      const active = [];
      for (const [n, exp] of Object.entries(data.whitelist)) {
        if (exp > now) active.push(n);
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00e5ff)
            .setTitle("📋 LARP TP Whitelist")
            .addFields(
              {
                name: "♾️ Lifetime (" + life.length + ")",
                value: life.length ? life.map((n) => "• " + n).join("\n") : "_none_",
                inline: false,
              },
              {
                name: "🟢 Active (" + active.length + ")",
                value: active.length ? active.map((n) => "• " + n).join("\n") : "_none_",
                inline: false,
              }
            )
            .setFooter({ text: "LARP TP" })
            .setTimestamp(),
        ],
      });
    }

    // SPIN
    if (cmd === "spin") {
      const uid = interaction.user.id;
      const now = Date.now();
      const last = data.spins[uid] || 0;
      const bonus = getBonus(data, "spin", uid);
      const onCooldown = now - last < DAY_MS;

      if (onCooldown && bonus <= 0) {
        const left = DAY_MS - (now - last);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("🎰 SPIN — Cooldown")
              .setDescription("⏳ You already spun today!\n\nCome back in " + timeLeft(left) + ".")
              .setFooter({ text: "1 free spin / day • LARP TP" })
              .setTimestamp(),
          ],
        });
      }

      if (onCooldown && bonus > 0) consumeBonus(data, "spin", uid);
      else data.spins[uid] = now;

      const win = Math.random() < 0.15;
      const roll = Math.floor(Math.random() * 100) + 1;
      const remaining = getBonus(data, "spin", uid);

      if (win) {
        const { key, data: kData } = makeKey1h("spin");
        data.keys[key] = kData;
        saveData(data);
        bumpStat(data, interaction.user.id, "spinWins");
        addLog("spin_win", interaction.user.tag, "", key);
        const dmOk = await sendKeyDM(interaction.user, key, "1h");
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🎰 SPIN — 🎉 WIN!")
              .setDescription(
                spinVisual(roll, true) +
                  "\n\n" +
                  (dmOk
                    ? "📩 **1h** key sent to your **DMs**!"
                    : "⚠️ DMs closed — key: `" + key + "`")
              )
              .setFooter({ text: "Bonus left: " + remaining + " • 1 spin / day" })
              .setTimestamp(),
          ],
        });
      }

      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x7f8c8d)
            .setTitle("🎰 SPIN — Miss")
            .setDescription(spinVisual(roll, false) + "\n\nCome back tomorrow 🍀")
            .setFooter({ text: "Bonus left: " + remaining + " • 1 spin / day" })
            .setTimestamp(),
        ],
      });
    }

    // DICE
    if (cmd === "dice") {
      const uid = interaction.user.id;
      const now = Date.now();
      const last = data.dice[uid] || 0;
      const bonus = getBonus(data, "dice", uid);
      const onCooldown = now - last < DAY_MS;

      if (onCooldown && bonus <= 0) {
        const left = DAY_MS - (now - last);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("🎲 DICE — Cooldown")
              .setDescription("⏳ You already played today!\n\nCome back in " + timeLeft(left) + ".")
              .setFooter({ text: "1 free dice / day • LARP TP" })
              .setTimestamp(),
          ],
        });
      }

      if (onCooldown && bonus > 0) consumeBonus(data, "dice", uid);
      else data.dice[uid] = now;

      const pick = interaction.options.getString("color");
      const pickObj = DICE_COLORS.find((c) => c.value === pick) || DICE_COLORS[0];
      const rolled = [];
      for (let i = 0; i < 4; i++) {
        rolled.push(DICE_COLORS[Math.floor(Math.random() * DICE_COLORS.length)]);
      }
      const rolledEmojis = rolled.map((c) => c.emoji);
      const match = rolled.some((c) => c.value === pick);
      const remaining = getBonus(data, "dice", uid);

      if (match) {
        const { key, data: kData } = makeKey1h("dice");
        data.keys[key] = kData;
        saveData(data);
        bumpStat(data, interaction.user.id, "diceWins");
        addLog("dice_win", interaction.user.tag, "", key);
        const dmOk = await sendKeyDM(interaction.user, key, "1h");
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🎲 DICE — 🎉 WIN!")
              .setDescription(
                diceVisual(pickObj.emoji, pick, rolledEmojis, true) +
                  "\n\n" +
                  (dmOk
                    ? "📩 **1h** key sent to your **DMs**!"
                    : "⚠️ DMs closed — key: `" + key + "`")
              )
              .setFooter({ text: "Bonus left: " + remaining + " • 1 dice / day" })
              .setTimestamp(),
          ],
        });
      }

      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("🎲 DICE — Loss")
            .setDescription(diceVisual(pickObj.emoji, pick, rolledEmojis, false))
            .setFooter({ text: "Bonus left: " + remaining + " • 1 dice / day" })
            .setTimestamp(),
        ],
      });
    }

    // RESET / GIVE
    if (cmd === "resetspin") {
      const user = interaction.options.getUser("user");
      const all = interaction.options.getBoolean("all");
      if (all) {
        data.spins = {};
        saveData(data);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x3498db)
              .setTitle("🔄 Reset Spin")
              .setDescription("Spin cooldown reset for **everyone** ✅"),
          ],
        });
      }
      if (!user) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Missing argument")
              .setDescription("Provide a `user` **or** set `all: True`."),
          ],
        });
      }
      delete data.spins[user.id];
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("🔄 Reset Spin")
            .setDescription("Spin cooldown reset for **" + user.tag + "** ✅"),
        ],
      });
    }

    if (cmd === "resetdice") {
      const user = interaction.options.getUser("user");
      const all = interaction.options.getBoolean("all");
      if (all) {
        data.dice = {};
        saveData(data);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x3498db)
              .setTitle("🔄 Reset Dice")
              .setDescription("Dice cooldown reset for **everyone** ✅"),
          ],
        });
      }
      if (!user) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Missing argument")
              .setDescription("Provide a `user` **or** set `all: True`."),
          ],
        });
      }
      delete data.dice[user.id];
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("🔄 Reset Dice")
            .setDescription("Dice cooldown reset for **" + user.tag + "** ✅"),
        ],
      });
    }

    if (cmd === "giveallspin") {
      const amount = interaction.options.getInteger("amount") || 1;
      data.spins = {};
      data.globalSpinBonus = (data.globalSpinBonus || 0) + amount;
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🎁 Give All Spin")
            .setDescription(
              "✅ Spin cooldown reset for everyone\n🎁 **+" +
                amount +
                "** global spin bonus\n\nEveryone can spin again!"
            )
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "givealldice") {
      const amount = interaction.options.getInteger("amount") || 1;
      data.dice = {};
      data.globalDiceBonus = (data.globalDiceBonus || 0) + amount;
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🎁 Give All Dice")
            .setDescription(
              "✅ Dice cooldown reset for everyone\n🎁 **+" +
                amount +
                "** global dice bonus\n\nEveryone can play again!"
            )
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "givespin") {
      const user = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount") || 1;
      data.spinsBonus[user.id] = (data.spinsBonus[user.id] || 0) + amount;
      delete data.spins[user.id];
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🎁 Spins given")
            .setDescription("**" + amount + "** spin(s) → **" + user.tag + "**\nCooldown reset ✅"),
        ],
      });
    }

    if (cmd === "givedice") {
      const user = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount") || 1;
      data.diceBonus[user.id] = (data.diceBonus[user.id] || 0) + amount;
      delete data.dice[user.id];
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🎁 Dice given")
            .setDescription("**" + amount + "** dice → **" + user.tag + "**\nCooldown reset ✅"),
        ],
      });
    }

    // INVITES
    if (cmd === "invites") {
      const uid = interaction.user.id;
      const pts = getInvitePoints(data, uid);
      const used = data.invitesUsed[uid] || 0;
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle("🎟️ Your invites")
            .setDescription(
              "Available points: **" +
                pts +
                "**\nAlready spent: **" +
                used +
                "**\n\nExchange via the **panel** in the channel."
            )
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "invitepanel") {
      try {
        await interaction.deleteReply().catch(() => {});
      } catch (_) {}
      await interaction.channel.send({
        embeds: [buildInvitePanelEmbed()],
        components: [buildInvitePanelButtons()],
      });
      try {
        await interaction.followUp({ content: "✅ Invite panel posted.", ephemeral: true });
      } catch (_) {}
      return;
    }

    if (cmd === "addinvites") {
      const user = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount");
      addInvitePoints(data, user.id, amount);
      saveData(data);
      addLog("addinvites", interaction.user.tag, user.tag, "+" + amount);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("➕ Invites added")
            .setDescription(
              "**+" +
                amount +
                "** → **" +
                user.tag +
                "**\nTotal: **" +
                getInvitePoints(data, user.id) +
                "**"
            ),
        ],
      });
    }

    if (cmd === "setinvites") {
      const user = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount");
      data.invites[user.id] = amount;
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("✏️ Invites set")
            .setDescription("**" + user.tag + "** → **" + amount + "** point(s)"),
        ],
      });
    }

    // ─── GUESS THE NUMBER ───────────────────────────────────
    if (cmd === "guessstart") {
      const guildId = interaction.guildId || "dm";
      if (guessGames.has(guildId) && guessGames.get(guildId).active) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("⚠️ Game already running")
              .setDescription(
                "A Guess the Number game is already active.\nUse `/guessend` first."
              ),
          ],
        });
      }
      const number = interaction.options.getInteger("number");
      let min = interaction.options.getInteger("min");
      let max = interaction.options.getInteger("max");
      if (min == null) min = 1;
      if (max == null) max = 100;
      if (min > max) {
        const t = min;
        min = max;
        max = t;
      }
      if (number < min || number > max) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Number out of range")
              .setDescription(
                "Secret number **" +
                  number +
                  "** must be between **" +
                  min +
                  "** and **" +
                  max +
                  "**."
              ),
          ],
        });
      }
      const rewardOpt = interaction.options.getBoolean("reward");
      const reward = rewardOpt === null ? true : rewardOpt;

      guessGames.set(guildId, {
        active: true,
        number,
        min,
        max,
        reward,
        startedBy: interaction.user.tag,
        startedById: interaction.user.id,
        guesses: 0,
        tried: new Set(),
        channelId: interaction.channelId,
      });

      // Public announcement
      try {
        await interaction.deleteReply().catch(() => {});
      } catch (_) {}
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle("🎯 GUESS THE NUMBER!")
            .setDescription(
              "A new game has started!\n\n" +
                "🔢 Range: **" +
                min +
                "** – **" +
                max +
                "**\n" +
                (reward ? "🎁 Winner gets a **1h key** (DM)\n" : "") +
                "\nUse `/guess number:<your number>` to play!"
            )
            .setFooter({ text: "Started by " + interaction.user.tag })
            .setTimestamp(),
        ],
      });
      addLog("guess_start", interaction.user.tag, "", min + "-" + max + (reward ? " +reward" : ""));
      try {
        await interaction.followUp({
          content: "✅ Game started. Secret number is **" + number + "** (only you know).",
          ephemeral: true,
        });
      } catch (_) {}
      return;
    }

    if (cmd === "guess") {
      const guildId = interaction.guildId || "dm";
      const game = guessGames.get(guildId);
      if (!game || !game.active) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ No active game")
              .setDescription("There is no Guess the Number game right now."),
          ],
        });
      }
      const n = interaction.options.getInteger("number");
      if (n < game.min || n > game.max) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("⚠️ Out of range")
              .setDescription(
                "Guess between **" + game.min + "** and **" + game.max + "**."
              ),
          ],
        });
      }
      game.guesses += 1;
      game.tried.add(interaction.user.id);

      if (n === game.number) {
        game.active = false;
        guessGames.delete(guildId);
        addLog("guess_win", interaction.user.tag, "", "number " + n + " in " + game.guesses + " guesses");

        let rewardMsg = "";
        if (game.reward) {
          const { key, data: kData } = makeKey1h("guess");
          data.keys[key] = kData;
          saveData(data);
          const dmOk = await sendKeyDM(interaction.user, key, "1h");
          rewardMsg = dmOk
            ? "\n\n🎁 **1h key** sent to your **DMs**!"
            : "\n\n⚠️ DMs closed — key: `" + key + "`";
        }

        try {
          await interaction.channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x2ecc71)
                .setTitle("🎉 CORRECT!")
                .setDescription(
                  "**" +
                    interaction.user.tag +
                    "** found the number **" +
                    n +
                    "**!\n" +
                    "Total guesses: **" +
                    game.guesses +
                    "**" +
                    rewardMsg
                )
                .setTimestamp(),
            ],
          });
        } catch (_) {}

        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🎉 You won!")
              .setDescription(
                "The number was **" + n + "**!" + rewardMsg
              )
              .setTimestamp(),
          ],
        });
      }

      // Hint: higher / lower
      const hint = n < game.number ? "📈 **Higher!**" : "📉 **Lower!**";
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle("🎯 Wrong guess")
            .setDescription(
              "You guessed **" +
                n +
                "**\n" +
                hint +
                "\n\nRange: **" +
                game.min +
                "** – **" +
                game.max +
                "**\nGuesses so far: **" +
                game.guesses +
                "**"
            )
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "guessend") {
      const guildId = interaction.guildId || "dm";
      const game = guessGames.get(guildId);
      if (!game || !game.active) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("ℹ️ No active game")
              .setDescription("Nothing to end."),
          ],
        });
      }
      const secret = game.number;
      game.active = false;
      guessGames.delete(guildId);
      addLog("guess_end", interaction.user.tag, "", "was " + secret);
      try {
        await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("🛑 Game ended")
              .setDescription(
                "Guess the Number was stopped by **" +
                  interaction.user.tag +
                  "**.\nThe number was **" +
                  secret +
                  "**."
              )
              .setTimestamp(),
          ],
        });
      } catch (_) {}
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x95a5a6)
            .setTitle("🛑 Ended")
            .setDescription("Game closed. Number was **" + secret + "**."),
        ],
      });
    }

    if (cmd === "guessinfo") {
      const guildId = interaction.guildId || "dm";
      const game = guessGames.get(guildId);
      if (!game || !game.active) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("ℹ️ No active game")
              .setDescription("No Guess the Number game is running."),
          ],
        });
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle("ℹ️ Guess the Number")
            .setDescription(
              "🔢 Range: **" +
                game.min +
                "** – **" +
                game.max +
                "**\n" +
                "🎯 Guesses: **" +
                game.guesses +
                "**\n" +
                "🎁 Reward: **" +
                (game.reward ? "1h key" : "none") +
                "**\n" +
                "👤 Started by: **" +
                game.startedBy +
                "**"
            )
            .setTimestamp(),
        ],
      });
    }

    // KEYDROP
    if (cmd === "keydrop") {
      const durationStr = interaction.options.getString("duration");
      const amount = interaction.options.getInteger("amount");
      const parsed = parseDuration(durationStr);
      if (!parsed || parsed.lifetime) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Invalid duration")
              .setDescription("Use timed durations only: `30m`, `1h`, `1d` (no lifetime)."),
          ],
        });
      }

      const baseDesc =
        "A keydrop is live!\n\n" +
        "⏱️ Duration per key: **" +
        durationStr +
        "**\n" +
        "🔑 Total keys: **" +
        amount +
        "**\n\n" +
        "Click **Claim key** — one claim per person.\nKeys are sent in **DM**.";

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle("🎁 KEYDROP!")
        .setDescription(baseDesc + "\n\n**Remaining:** `" + amount + "` / `" + amount + "`")
        .setFooter({ text: "LARP TP • Keydrop" })
        .setTimestamp();

      try {
        await interaction.deleteReply().catch(() => {});
      } catch (_) {}

      const msg = await interaction.channel.send({
        embeds: [embed],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("keydrop_claim_PENDING")
              .setLabel("Claim key")
              .setEmoji("🔑")
              .setStyle(ButtonStyle.Success)
          ),
        ],
      });

      // Fix button customId with real message id
      await msg.edit({
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("keydrop_claim_" + msg.id)
              .setLabel("Claim key")
              .setEmoji("🔑")
              .setStyle(ButtonStyle.Success)
          ),
        ],
      });

      activeDrops.set(msg.id, {
        keysLeft: amount,
        total: amount,
        duration: durationStr,
        claimed: new Set(),
        baseDesc,
        embedData: embed.toJSON(),
      });

      addLog("keydrop", interaction.user.tag, "", amount + "x " + durationStr);
      try {
        await interaction.followUp({
          content: "✅ Keydrop posted (" + amount + "× " + durationStr + ").",
          ephemeral: true,
        });
      } catch (_) {}
      return;
    }

    // LOGS
    if (cmd === "logs") {
      const limit = interaction.options.getInteger("limit") || 15;
      const type = interaction.options.getString("type") || "all";
      let logs = [...(data.logs || [])].reverse();
      if (type === "redeem") logs = logs.filter((l) => l.action === "redeem");
      else if (type === "tp") logs = logs.filter((l) => l.action === "tp");
      else if (type === "keydrop") logs = logs.filter((l) => l.action === "keydrop");
      else if (type === "games")
        logs = logs.filter((l) => l.action === "spin_win" || l.action === "dice_win");
      else if (type === "invite")
        logs = logs.filter((l) => String(l.action).includes("invite"));

      logs = logs.slice(0, limit);
      if (!logs.length) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("📋 Logs")
              .setDescription("No logs found."),
          ],
        });
      }
      const lines = logs.map((l) => {
        const t = (l.at || "").replace("T", " ").slice(0, 19);
        return (
          "`" +
          t +
          "` **" +
          l.action +
          "** — " +
          (l.by || "?") +
          (l.target ? " → " + l.target : "") +
          (l.details ? " _(" + l.details + ")_" : "")
        );
      });
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00e5ff)
            .setTitle("📋 Recent logs")
            .setDescription(lines.join("\n").slice(0, 4000))
            .setFooter({ text: "Filter: " + type })
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "tplogs") {
      const limit = interaction.options.getInteger("limit") || 15;
      const logs = [...(data.tpLogs || [])].reverse().slice(0, limit);
      if (!logs.length) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("📍 TP Logs")
              .setDescription(
                "No TP logs yet.\n\nYour game should POST to `/api/log/tp` with the API secret."
              ),
          ],
        });
      }
      const lines = logs.map((l) => {
        const t = (l.at || "").replace("T", " ").slice(0, 19);
        return (
          "`" +
          t +
          "` **" +
          (l.username || "?") +
          "**" +
          (l.from ? " from `" + l.from + "`" : "") +
          (l.to ? " → `" + l.to + "`" : "") +
          (l.details ? " _(" + l.details + ")_" : "")
        );
      });
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("📍 Recent TP logs")
            .setDescription(lines.join("\n").slice(0, 4000))
            .setTimestamp(),
        ],
      });
    }

    // ─── LEADERBOARD ───────────────────────────────────────
    if (cmd === "leaderboard") {
      const type = interaction.options.getString("type");
      data.stats = data.stats || {};
      data.invites = data.invites || {};
      let rows = [];
      if (type === "invites") {
        rows = Object.entries(data.invites)
          .map(([id, pts]) => ({ id, score: (pts || 0) + (data.invitesUsed[id] || 0) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10);
      } else {
        const field =
          type === "spins" ? "spinWins" : type === "dice" ? "diceWins" : "redeems";
        rows = Object.entries(data.stats)
          .map(([id, s]) => ({ id, score: s[field] || 0 }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10);
      }
      if (!rows.length) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("🏆 Leaderboard")
              .setDescription("No data yet for **" + type + "**."),
          ],
        });
      }
      const medals = ["🥇", "🥈", "🥉"];
      const lines = rows.map((r, i) => {
        const m = medals[i] || "`" + (i + 1) + ".`";
        return m + " <@" + r.id + "> — **" + r.score + "**";
      });
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle("🏆 Leaderboard — " + type)
            .setDescription(lines.join("\n"))
            .setTimestamp(),
        ],
      });
    }

    // ─── DAILY STREAK ──────────────────────────────────────
    if (cmd === "daily") {
      const uid = interaction.user.id;
      data.streaks = data.streaks || {};
      const today = dayKey();
      const st = data.streaks[uid] || { count: 0, lastDay: "" };
      if (st.lastDay === today) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("📅 Already claimed")
              .setDescription(
                "You already claimed today.\n🔥 Streak: **" + st.count + "** day(s)"
              ),
          ],
        });
      }
      const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
      if (st.lastDay === yesterday) st.count += 1;
      else st.count = 1;
      st.lastDay = today;
      data.streaks[uid] = st;

      // Reward: 1 bonus spin, every 7 days a 1h key
      data.spinsBonus[uid] = (data.spinsBonus[uid] || 0) + 1;
      delete data.spins[uid];
      let extra = "";
      if (st.count > 0 && st.count % 7 === 0) {
        const { key, data: kData } = makeKey1h("streak");
        data.keys[key] = kData;
        const dmOk = await sendKeyDM(interaction.user, key, "1h");
        extra = dmOk
          ? "\n\n🎁 **7-day streak!** 1h key sent to your **DMs**!"
          : "\n\n🎁 **7-day streak!** Key: `" + key + "`";
      }
      saveData(data);
      addLog("daily", interaction.user.tag, "", "streak " + st.count);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle("🔥 Daily claimed!")
            .setDescription(
              "🔥 Streak: **" +
                st.count +
                "** day(s)\n🎰 **+1 bonus spin**" +
                extra
            )
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "streak") {
      const uid = interaction.user.id;
      const st = (data.streaks || {})[uid] || { count: 0, lastDay: "" };
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle("🔥 Your streak")
            .setDescription(
              "Current streak: **" +
                st.count +
                "** day(s)\nLast claim: **" +
                (st.lastDay || "never") +
                "**\n\nUse `/daily` every day. Every **7** days → 1h key!"
            )
            .setTimestamp(),
        ],
      });
    }

    // ─── PROMO CODES ───────────────────────────────────────
    if (cmd === "createcode") {
      const raw = interaction.options.getString("code").trim().toUpperCase();
      const durationStr = interaction.options.getString("duration");
      const maxUses = interaction.options.getInteger("maxuses") || 1;
      const hours = interaction.options.getInteger("hours");
      const parsed = parseDuration(durationStr);
      if (!parsed) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Invalid duration")
              .setDescription("Examples: `1h`, `1d`"),
          ],
        });
      }
      data.codes = data.codes || {};
      data.codes[raw] = {
        duration: durationStr,
        lifetime: parsed.lifetime,
        seconds: parsed.seconds,
        maxUses,
        uses: 0,
        expiresAt: hours && hours > 0 ? Date.now() + hours * 3600000 : null,
        createdBy: interaction.user.tag,
        createdAt: new Date().toISOString(),
      };
      saveData(data);
      addLog("createcode", interaction.user.tag, "", raw + " " + durationStr);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🏷️ Code created")
            .setDescription(
              "Code: `" +
                raw +
                "`\nDuration: **" +
                durationStr +
                "**\nMax uses: **" +
                maxUses +
                "**" +
                (hours ? "\nExpires in: **" + hours + "h**" : "\nExpires: **never**")
            ),
        ],
      });
    }

    if (cmd === "code") {
      const raw = interaction.options.getString("code").trim().toUpperCase();
      data.codes = data.codes || {};
      const c = data.codes[raw];
      if (!c) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Invalid code")
              .setDescription("This promo code does not exist."),
          ],
        });
      }
      if (c.expiresAt && Date.now() > c.expiresAt) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Code expired")
              .setDescription("This code is no longer valid."),
          ],
        });
      }
      if (c.uses >= c.maxUses) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Code exhausted")
              .setDescription("All uses of this code have been claimed."),
          ],
        });
      }
      c.usedBy = c.usedBy || [];
      if (c.usedBy.includes(interaction.user.id)) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("⚠️ Already used")
              .setDescription("You already redeemed this code."),
          ],
        });
      }
      c.uses += 1;
      c.usedBy.push(interaction.user.id);
      const { key, data: kData } = makeKey(
        c.duration,
        c.seconds || 3600,
        "code:" + raw
      );
      data.keys[key] = kData;
      bumpStat(data, interaction.user.id, "codes");
      saveData(data);
      addLog("code", interaction.user.tag, "", raw + " → " + key);
      const dmOk = await sendKeyDM(interaction.user, key, c.duration);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Code redeemed!")
            .setDescription(
              dmOk
                ? "📩 **" + c.duration + "** key sent to your **DMs**!"
                : "⚠️ DMs closed — key: `" + key + "`"
            )
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "listcodes") {
      data.codes = data.codes || {};
      const entries = Object.entries(data.codes);
      if (!entries.length) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("🏷️ Codes")
              .setDescription("No codes."),
          ],
        });
      }
      const lines = entries.map(([code, c]) => {
        const left = c.maxUses - c.uses;
        const exp =
          c.expiresAt && Date.now() > c.expiresAt
            ? "EXPIRED"
            : c.expiresAt
              ? "exp " + new Date(c.expiresAt).toISOString().slice(0, 16)
              : "no exp";
        return (
          "`" +
          code +
          "` — **" +
          c.duration +
          "** · " +
          left +
          "/" +
          c.maxUses +
          " left · " +
          exp
        );
      });
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00e5ff)
            .setTitle("🏷️ Promo codes")
            .setDescription(lines.join("\n").slice(0, 4000)),
        ],
      });
    }

    if (cmd === "deletecode") {
      const raw = interaction.options.getString("code").trim().toUpperCase();
      data.codes = data.codes || {};
      if (!data.codes[raw]) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Not found")
              .setDescription("Code `" + raw + "` does not exist."),
          ],
        });
      }
      delete data.codes[raw];
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("🗑️ Code deleted")
            .setDescription("`" + raw + "` removed."),
        ],
      });
    }

    // ─── BLACKLIST ─────────────────────────────────────────
    if (cmd === "blacklist") {
      const username = interaction.options.getString("username").toLowerCase();
      const reason = interaction.options.getString("reason") || "No reason";
      data.blacklist = data.blacklist || {};
      data.blacklist[username] = {
        reason,
        by: interaction.user.tag,
        at: new Date().toISOString(),
      };
      // also remove access
      delete data.whitelist[username];
      delete data.lifetimeWhitelist[username];
      saveData(data);
      addLog("blacklist", interaction.user.tag, username, reason);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("🚫 Blacklisted")
            .setDescription("**" + username + "**\nReason: " + reason),
        ],
      });
    }

    if (cmd === "unblacklist") {
      const username = interaction.options.getString("username").toLowerCase();
      data.blacklist = data.blacklist || {};
      if (!data.blacklist[username]) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("ℹ️ Not blacklisted")
              .setDescription("**" + username + "** is not on the list."),
          ],
        });
      }
      delete data.blacklist[username];
      saveData(data);
      addLog("unblacklist", interaction.user.tag, username, "");
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Unblacklisted")
            .setDescription("**" + username + "** removed from blacklist."),
        ],
      });
    }

    if (cmd === "blacklistcheck") {
      const username = interaction.options.getString("username").toLowerCase();
      data.blacklist = data.blacklist || {};
      const b = data.blacklist[username];
      if (!b) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("✅ Not blacklisted")
              .setDescription("**" + username + "** is clean."),
          ],
        });
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("🚫 Blacklisted")
            .setDescription(
              "**" +
                username +
                "**\nReason: " +
                (b.reason || "—") +
                "\nBy: " +
                (b.by || "?") +
                "\nAt: " +
                (b.at || "?")
            ),
        ],
      });
    }

    // ─── CHECK EXPIRES ─────────────────────────────────────
    if (cmd === "checkexpires") {
      const hours = interaction.options.getInteger("hours") || 24;
      const now = Math.floor(Date.now() / 1000);
      const limit = now + hours * 3600;
      const soon = [];
      for (const [name, exp] of Object.entries(data.whitelist || {})) {
        if (exp > now && exp <= limit) {
          const leftMin = Math.floor((exp - now) / 60);
          soon.push("• **" + name + "** — " + leftMin + " min left");
        }
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf39c12)
            .setTitle("⏰ Expiring within " + hours + "h")
            .setDescription(soon.length ? soon.join("\n") : "_Nobody expiring soon._")
            .setTimestamp(),
        ],
      });
    }

    // ─── RAFFLE ────────────────────────────────────────────
    if (cmd === "raffle") {
      const prize = interaction.options.getString("prize");
      const guildId = interaction.guildId || "dm";
      if (activeRaffles.has(guildId) && activeRaffles.get(guildId).active) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("⚠️ Raffle already running")
              .setDescription("End it with `/raffleend` first."),
          ],
        });
      }
      try {
        await interaction.deleteReply().catch(() => {});
      } catch (_) {}
      const msg = await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe91e63)
            .setTitle("🎊 RAFFLE!")
            .setDescription(
              "Prize: **" +
                prize +
                "**\n\nClick **Join** to enter!\nAdmin ends with `/raffleend`."
            )
            .setFooter({ text: "LARP TP • Raffle" })
            .setTimestamp(),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("raffle_join")
              .setLabel("Join")
              .setEmoji("🎟️")
              .setStyle(ButtonStyle.Primary)
          ),
        ],
      });
      activeRaffles.set(guildId, {
        active: true,
        prize,
        entrants: new Set(),
        messageId: msg.id,
        channelId: interaction.channelId,
      });
      addLog("raffle", interaction.user.tag, "", prize);
      try {
        await interaction.followUp({ content: "✅ Raffle started.", ephemeral: true });
      } catch (_) {}
      return;
    }

    if (cmd === "raffleend") {
      const guildId = interaction.guildId || "dm";
      const raffle = activeRaffles.get(guildId);
      if (!raffle || !raffle.active) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("ℹ️ No active raffle")
              .setDescription("Nothing to draw."),
          ],
        });
      }
      raffle.active = false;
      const list = [...raffle.entrants];
      if (!list.length) {
        activeRaffles.delete(guildId);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ No entrants")
              .setDescription("Nobody joined the raffle."),
          ],
        });
      }
      const winnerId = list[Math.floor(Math.random() * list.length)];
      activeRaffles.delete(guildId);
      addLog("raffle_win", "<@" + winnerId + ">", "", raffle.prize);

      // If prize looks like a key duration, give a key
      const parsed = parseDuration(raffle.prize.replace(/\s/g, ""));
      let prizeExtra = "";
      if (parsed && !parsed.lifetime) {
        try {
          const user = await client.users.fetch(winnerId);
          const { key, data: kData } = makeKey(
            raffle.prize.match(/\d+\s*[mhd]/i)
              ? raffle.prize.match(/\d+\s*[a-z]+/i)[0].replace(/\s/g, "")
              : "1h",
            parsed.seconds || 3600,
            "raffle"
          );
          data.keys[key] = kData;
          saveData(data);
          const dmOk = await sendKeyDM(user, key, kData.duration);
          prizeExtra = dmOk
            ? "\n📩 Key sent to winner's DMs."
            : "\nKey: `" + key + "`";
        } catch (_) {}
      }

      try {
        await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🎊 Raffle winner!")
              .setDescription(
                "Prize: **" +
                  raffle.prize +
                  "**\nWinner: <@" +
                  winnerId +
                  ">\nEntrants: **" +
                  list.length +
                  "**" +
                  prizeExtra
              )
              .setTimestamp(),
          ],
        });
      } catch (_) {}

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🎊 Drawn")
            .setDescription("Winner: <@" + winnerId + ">"),
        ],
      });
    }

    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle("❓ Unknown command")],
    });
  } catch (err) {
    console.error("[ERR]", cmd, err);
    try {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("❌ Error")
            .setDescription("`" + (err.message || "server") + "`"),
        ],
      });
    } catch (_) {}
  }
});

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("[BOT] Commands registered.");
}

const app = express();
app.use(cors());
app.use(express.json());

function checkSecret(req, res, next) {
  const secret = req.headers["x-api-secret"] || req.query.secret;
  if (secret !== API_SECRET) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

app.get("/api/data", checkSecret, (req, res) => {
  const data = loadData();
  const now = Math.floor(Date.now() / 1000);
  for (const [name, expiry] of Object.entries(data.whitelist)) {
    if (expiry <= now) delete data.whitelist[name];
  }
  saveData(data);
  res.json({
    ok: true,
    admins: data.admins,
    whitelist: data.whitelist,
    pausedWhitelist: data.pausedWhitelist,
    lifetimeWhitelist: data.lifetimeWhitelist,
  });
});

app.get("/api/keys", checkSecret, (req, res) => {
  const data = loadData();
  res.json({ ok: true, keys: data.keys || {} });
});

app.post("/api/keys/use", checkSecret, (req, res) => {
  const body = req.body || {};
  const key = String(body.key || "").toUpperCase().replace(/\s+/g, "");
  const username = String(body.username || "").toLowerCase();
  const data = loadData();
  if (!data.keys[key]) return res.json({ ok: false, error: "unknown" });
  data.keys[key].used = true;
  data.keys[key].usedBy = username;
  data.keys[key].robloxUsername = username;
  data.keys[key].usedAt = new Date().toISOString();
  saveData(data);
  addLog("redeem", username, username, "API use " + key);
  res.json({ ok: true });
});

// In-game TP log endpoint
app.post("/api/log/tp", checkSecret, (req, res) => {
  const body = req.body || {};
  const username = String(body.username || body.player || "unknown");
  const from = String(body.from || body.fromPlace || "");
  const to = String(body.to || body.toPlace || body.destination || "");
  const details = String(body.details || body.reason || "");
  const data = loadData();
  data.tpLogs = data.tpLogs || [];
  data.tpLogs.push({
    at: new Date().toISOString(),
    username,
    from,
    to,
    details,
  });
  saveData(data);
  addLog("tp", username, to || from, details || (from + " → " + to));
  res.json({ ok: true });
});

// Generic activity log from game
app.post("/api/log", checkSecret, (req, res) => {
  const body = req.body || {};
  const action = String(body.action || "game");
  const by = String(body.by || body.username || "unknown");
  const target = String(body.target || "");
  const details = String(body.details || "");
  addLog(action, by, target, details);
  res.json({ ok: true });
});

app.get("/", (req, res) => res.send("LARP TP API running."));

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Configure DISCORD_TOKEN, CLIENT_ID, GUILD_ID");
  process.exit(1);
}

registerCommands()
  .then(() => client.login(DISCORD_TOKEN))
  .catch((e) => console.error(e));

app.listen(PORT, () => console.log("[API] Port", PORT));
