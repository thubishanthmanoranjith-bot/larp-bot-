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
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");

function isSnowflake(id) {
  return typeof id === "string" && /^\d{17,20}$/.test(String(id));
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const API_SECRET = process.env.API_SECRET || "change_me";
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || ""; // optional Discord channel for live logs
const LOG_WEBHOOK_URL =
  process.env.LOG_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1553063841213190225/kXISAUrl-HEQOmBcHWxR1H4pdMJC4yhWOKGd8ZpXpd2DUTjYtw7f4dxtBf_hBODiKUdp";
const BOT_ADMINS = (process.env.BOT_ADMINS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const WHITELIST_ROLE_ID = process.env.WHITELIST_ROLE_ID || "";
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || "";
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || "";

const TICKET_TYPES = {
  buy: { label: "Buy", emoji: "💰", color: 0x2ecc71, title: "💰 Purchase" },
  help: { label: "Help", emoji: "❓", color: 0x3498db, title: "❓ Help" },
  key: { label: "Key issue", emoji: "🔑", color: 0xf1c40f, title: "🔑 Key issue" },
  bug: { label: "Bug", emoji: "🐛", color: 0xe74c3c, title: "🐛 Bug report" },
};

async function createTicketChannel(guild, user, botId, typeKey) {
  const type = TICKET_TYPES[typeKey] || TICKET_TYPES.help;
  const safe =
    String(user.username || "user")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 16) || String(user.id).slice(-6);

  // Create with NO permissionOverwrites first (fixes "not a cached User or Role")
  const opts = {
    name: typeKey + "-" + safe,
    type: ChannelType.GuildText,
    reason: "LARP TP ticket: " + type.label,
  };

  const ch = await guild.channels.create(opts);

  // Permissions after create — use Role/User objects when possible
  try {
    await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
  } catch (e) {
    console.warn("[TICKET] everyone", e.message);
  }
  try {
    const member = await guild.members.fetch(user.id).catch(() => null);
    await ch.permissionOverwrites.edit(member || user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    });
  } catch (e) {
    console.warn("[TICKET] user", e.message);
  }
  if (botId) {
    try {
      const botMember = await guild.members.fetch(String(botId)).catch(() => null);
      await ch.permissionOverwrites.edit(botMember || String(botId), {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        ManageChannels: true,
      });
    } catch (e) {
      console.warn("[TICKET] bot", e.message);
    }
  }
  for (const adminId of BOT_ADMINS) {
    if (!isSnowflake(String(adminId))) continue;
    if (String(adminId) === String(user.id)) continue;
    try {
      const m = await guild.members.fetch(String(adminId)).catch(() => null);
      if (!m) continue;
      await ch.permissionOverwrites.edit(m, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
    } catch (e) {
      console.warn("[TICKET] admin", adminId, e.message);
    }
  }

  return ch;
}

// Do NOT use /tmp by default — wiped on redeploy
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "larp-data.json");
const LOCAL_FALLBACK = path.join(__dirname, "data.json");
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.warn("[DATA] mkdir", e.message);
}

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
const claimingUsers = new Set(); // anti double-click race
const activeDrops = new Map();

// Guess the number: guildId → game state
const guessGames = new Map();

// Raffle: guildId → { prize, entrants: Set, messageId, active }
const activeRaffles = new Map();
const activeGiveaways = new Map();
const lastGiveaways = new Map(); // guildId -> last ended giveaway for /reroll

async function lockGuessChannel(channel, reason) {
  if (!channel || !channel.permissionOverwrites) return;
  try {
    const everyone = channel.guild.roles.everyone;
    await channel.permissionOverwrites.edit(everyone, {
      SendMessages: false,
      AddReactions: false,
    });
    await channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x95a5a6)
            .setTitle("🔒 Channel locked")
            .setDescription(reason || "Guess the Number is over. Chat is locked."),
        ],
      })
      .catch(() => {});
  } catch (e) {
    console.warn("lockGuessChannel", e.message);
  }
}

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
        d.keydropDaily = d.keydropDaily || {};
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
  const json = JSON.stringify(data, null, 2);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, json);
  } catch (e) {
    console.warn("saveData primary failed", e.message);
  }
  try {
    fs.writeFileSync(LOCAL_FALLBACK, json);
  } catch (e2) {
    console.warn("saveData fallback failed", e2.message);
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

    const colors = {
      redeem: 0x2ecc71,
      tp: 0x3498db,
      createkey: 0x00e5ff,
      keydrop: 0xf1c40f,
      spin_win: 0x2ecc71,
      spin_lose: 0xe74c3c,
      dice_win: 0x2ecc71,
      dice_lose: 0xe74c3c,
      invite_claim: 0x9b59b6,
      guess_start: 0xe67e22,
      guess_win: 0x2ecc71,
      guess_end: 0x95a5a6,
      daily: 0xe67e22,
      code: 0x2ecc71,
      blacklist: 0xe74c3c,
      raffle: 0xe91e63,
      raffle_win: 0x2ecc71,
      giveaway: 0xf1c40f,
      giveaway_win: 0x2ecc71,
      giveaway_end: 0x95a5a6,
      giveaway_reroll: 0xf1c40f,
    };
    const color = colors[action] || 0x95a5a6;
    const embed = {
      title: "📋 " + String(action).toUpperCase(),
      color: color,
      description:
        "**By:** " +
        (by || "—") +
        "\n**Target:** " +
        (target || "—") +
        "\n**Details:** " +
        (details || "—"),
      timestamp: new Date().toISOString(),
      footer: { text: "LARP TP Logs" },
    };

    // Webhook (always)
    if (LOG_WEBHOOK_URL) {
      fetch(LOG_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "LARP TP Logs",
          embeds: [embed],
        }),
      }).catch((e) => console.warn("webhook log", e.message));
    }

    // Optional channel
    if (LOG_CHANNEL_ID && client.isReady()) {
      const ch = client.channels.cache.get(LOG_CHANNEL_ID);
      if (ch && ch.send) {
        ch.send({
          embeds: [
            new EmbedBuilder()
              .setColor(color)
              .setTitle(embed.title)
              .setDescription(embed.description)
              .setTimestamp()
              .setFooter({ text: "LARP TP Logs" }),
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

function diceVisual(pickEmoji, pick, rolledEmojis, match, extra) {
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
    (extra
      ? extra
      : match
        ? "🎉🎊 **YOUR COLOR APPEARED!** You win a **1h** key 🔑"
        : "💔 Your color did not appear... try again tomorrow!")
  );
}

/** True if the player's chosen color appears 2+ times in the 4 rolls */
function diceHasDuplicate(rolled, pick) {
  let n = 0;
  for (const c of rolled) {
    if (c.value === pick) {
      n++;
      if (n >= 2) return true;
    }
  }
  return false;
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
    .setName("purgekeys")
    .setDescription("🗑️ Delete ALL keys (unused + used) — admin")
    .addBooleanOption((o) =>
      o.setName("confirm").setDescription("Must be true to confirm").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("deletekey")
    .setDescription("🗑️ Delete one key — admin")
    .addStringOption((o) =>
      o.setName("key").setDescription("LARP-XXXX key to delete").setRequired(true)
    ),
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
  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("🎁 Start a timed giveaway (admin)")
    .addStringOption((o) =>
      o.setName("prize").setDescription("Prize e.g. 1h key").setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("minutes").setDescription("Duration minutes (default 10)").setMinValue(1).setMaxValue(10080)
    )
    .addIntegerOption((o) =>
      o.setName("winners").setDescription("Number of winners (default 1)").setMinValue(1).setMaxValue(20)
    ),
  new SlashCommandBuilder()
    .setName("giveawayend")
    .setDescription("🎁 End giveaway early and draw (admin)"),
  new SlashCommandBuilder()
    .setName("reroll")
    .setDescription("🎲 Reroll last giveaway winners (admin)")
    .addIntegerOption((o) =>
      o.setName("winners").setDescription("Number of winners (default: same as last)").setMinValue(1).setMaxValue(20)
    ),
  new SlashCommandBuilder().setName("stats").setDescription("📊 Bot statistics (admin)"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("👤 Your access status")
    .addStringOption((o) => o.setName("username").setDescription("Roblox username")),
  new SlashCommandBuilder().setName("statuspanel").setDescription("📌 Post My Status panel (admin)"),
  new SlashCommandBuilder().setName("backup").setDescription("💾 Backup data to DMs (admin)"),
  new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("🪙 Coin flip (1×/day) — win = 1 bonus spin"),
  new SlashCommandBuilder().setName("quest").setDescription("📜 Daily quest progress / claim"),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("⚠️ Warn a member (admin)")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder()
    .setName("warns")
    .setDescription("📋 View warns")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder()
    .setName("clearwarns")
    .setDescription("🧹 Clear warns (admin)")
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder()
    .setName("poll")
    .setDescription("📊 Create a poll (admin)")
    .addStringOption((o) => o.setName("question").setDescription("Question").setRequired(true))
    .addStringOption((o) => o.setName("option1").setDescription("Option 1").setRequired(true))
    .addStringOption((o) => o.setName("option2").setDescription("Option 2").setRequired(true))
    .addStringOption((o) => o.setName("option3").setDescription("Option 3"))
    .addStringOption((o) => o.setName("option4").setDescription("Option 4")),
  new SlashCommandBuilder().setName("ticket").setDescription("🎫 Open a support ticket"),
  new SlashCommandBuilder().setName("ticketpanel").setDescription("📌 Post ticket panel (admin)"),
  new SlashCommandBuilder().setName("closeticket").setDescription("🔒 Close this ticket"),
  new SlashCommandBuilder()
    .setName("welcome")
    .setDescription("👋 Post welcome message (admin)")
    .addStringOption((o) => o.setName("text").setDescription("Custom text")),
  new SlashCommandBuilder()
    .setName("duel")
    .setDescription("⚔️ Challenge to a spin duel")
    .addUserOption((o) => o.setName("opponent").setDescription("Opponent").setRequired(true)),
].map((c) => c.toJSON());

const activePolls = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", () => {
  console.log("[BOT] Connected:", client.user.tag);
  console.log("[BOT] Admin IDs:", BOT_ADMINS.join(", ") || "(none)");
});
client.once("ready", () => {
  console.log("[BOT] Connected (ready):", client.user.tag);
  console.log("[BOT] Admin IDs:", BOT_ADMINS.join(", ") || "(none)");
});

// Guess the number via chat: just type the number (no slash command needed)
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !message.guild) return;
    const content = (message.content || "").trim();
    if (!/^\d+$/.test(content)) return;

    const guildId = message.guild.id;
    const game = guessGames.get(guildId);
    if (!game || !game.active) return;
    if (game.channelId && message.channel.id !== game.channelId) return;

    const n = parseInt(content, 10);
    if (Number.isNaN(n)) return;

    if (n < game.min || n > game.max) {
      await message
        .reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setDescription(
                "⚠️ Out of range — guess between **" +
                  game.min +
                  "** and **" +
                  game.max +
                  "**."
              ),
          ],
        })
        .catch(() => {});
      return;
    }

    game.guesses += 1;
    game.tried.add(message.author.id);

    if (n === game.number) {
      game.active = false;
      guessGames.delete(guildId);
      addLog(
        "guess_win",
        message.author.tag,
        "",
        "number " + n + " in " + game.guesses + " guesses (chat)"
      );

      let rewardMsg = "";
      if (game.reward) {
        const data = loadData();
        const { key, data: kData } = makeKey1h("guess");
        data.keys[key] = kData;
        saveData(data);
        const dmOk = await sendKeyDM(message.author, key, "1h");
        rewardMsg = dmOk
          ? "\n\n🎁 **1h key** sent to your **DMs**!"
          : "\n\n⚠️ DMs closed — key: `" + key + "`";
      }

      await message
        .reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🎉 CORRECT!")
              .setDescription(
                "**" +
                  message.author.tag +
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
        })
        .catch(() => {});
      await lockGuessChannel(
        message.channel,
        "🎯 **" + message.author.tag + "** found the number. Channel locked."
      );
      return;
    }

    // Mauvais essai: aucun message (silencieux)
  } catch (err) {
    console.error("[guess chat]", err);
  }
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
      const uid = interaction.user.id;
      // Anti double-clic / spam
      if (claimingUsers.has(uid)) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("⏳ Wait")
              .setDescription("Claim already in progress…"),
          ],
        });
      }
      claimingUsers.add(uid);
      try {
        const msgId = id.replace("keydrop_claim_", "");
        const drop = activeDrops.get(msgId);
        if (!drop) {
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor(0xe74c3c)
                .setTitle("❌ Expired")
                .setDescription("This keydrop is no longer active."),
            ],
          });
        }
        // 1 seule claim par user PAR drop (memoire)
        if (drop.claimed.has(uid)) {
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor(0xf39c12)
                .setTitle("⚠️ Already claimed")
                .setDescription("You already claimed a key from this drop."),
            ],
          });
        }
        // 1 claim keydrop max par jour (persistant)
        const data = loadData();
        data.keydropDaily = data.keydropDaily || {};
        const day = dayKey();
        if (data.keydropDaily[uid] === day) {
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor(0xe74c3c)
                .setTitle("🔒 Limit: 1 keydrop / day")
                .setDescription(
                  "You already claimed a keydrop today.\nCome back tomorrow."
                ),
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

        // Reserve IMMEDIATELY (avant DM) pour bloquer les doubles
        drop.keysLeft -= 1;
        drop.claimed.add(uid);
        data.keydropDaily[uid] = day;

        const parsed = parseDuration(drop.duration);
        const { key, data: kData } = makeKey(
          drop.duration,
          parsed ? parsed.seconds : 3600,
          "keydrop"
        );
        kData.ownerDiscordId = uid;
        data.keys[key] = kData;
        saveData(data);
        addLog("keydrop", interaction.user.tag, "", key + " (" + drop.duration + ")");

        const dmOk = await sendKeyDM(interaction.user, key, drop.duration);

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
                  ? "📩 **" + drop.duration + "** key sent to your **DMs**!\n*(1 keydrop max / day)*"
                  : "⚠️ DMs closed — key: `" + key + "`\n*(1 keydrop max / day)*"
              )
              .setTimestamp(),
          ],
        });
      } finally {
        claimingUsers.delete(uid);
      }
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


    if (id === "giveaway_join") {
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch {
        return;
      }
      const guildId = interaction.guildId || "dm";
      const g = activeGiveaways.get(guildId);
      if (!g || !g.active) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ No active giveaway")
              .setDescription("This giveaway has ended."),
          ],
        });
      }
      if (g.entrants.has(interaction.user.id)) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("⚠️ Already joined")
              .setDescription("You are already in this giveaway."),
          ],
        });
      }
      g.entrants.add(interaction.user.id);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Joined giveaway!")
            .setDescription(
              "Prize: **" + g.prize + "**\nEntrants: **" + g.entrants.size + "**"
            ),
        ],
      });
    }

    // Status / ticket / poll / duel / rules (must run BEFORE inv_ filter)
    if (
      id === "status_check" ||
      id === "ticket_open" ||
      id.startsWith("ticket_open_") ||
      id === "rules_ack" ||
      id.startsWith("poll_") ||
      id.startsWith("duel_accept_")
    ) {
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch {
        return;
      }

      if (id === "rules_ack") {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("✅ Thanks!")
              .setDescription("You're all set. Have fun!"),
          ],
        });
      }

      if (id === "status_check") {
        const data = loadData();
        data.discordToRoblox = data.discordToRoblox || {};
        const uname = data.discordToRoblox[interaction.user.id];
        if (!uname) {
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor(0xf39c12)
                .setTitle("👤 No linked account")
                .setDescription("Redeem a key with `/redeem` first."),
            ],
          });
        }
        const now = Math.floor(Date.now() / 1000);
        let status = "❌ No active access";
        let color = 0x95a5a6;
        if (data.lifetimeWhitelist && data.lifetimeWhitelist[uname]) {
          status = "♾️ **LIFETIME**";
          color = 0x9b59b6;
        } else if (data.whitelist[uname] && data.whitelist[uname] > now) {
          status =
            "🟢 **WHITELIST** — " +
            Math.floor((data.whitelist[uname] - now) / 60) +
            " min left";
          color = 0x2ecc71;
        }
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(color)
              .setTitle("👤 Your status")
              .setDescription("Roblox: **" + uname + "**\n" + status)
              .setTimestamp(),
          ],
        });
      }

      if (id === "ticket_open" || id.startsWith("ticket_open_")) {
        const guild = interaction.guild;
        if (!guild) return interaction.editReply({ content: "Guild only." });
        const typeKey =
          id === "ticket_open" ? "help" : id.replace("ticket_open_", "") || "help";
        const type = TICKET_TYPES[typeKey] || TICKET_TYPES.help;
        try {
          const ch = await createTicketChannel(
            guild,
            interaction.user,
            client.user.id,
            typeKey
          );
          await ch.send({
            content: "<@" + interaction.user.id + ">",
            embeds: [
              new EmbedBuilder()
                .setColor(type.color)
                .setTitle(type.emoji + " " + type.title)
                .setDescription(
                  "Category: **" +
                    type.label +
                    "**\nUser: <@" +
                    interaction.user.id +
                    ">\n\nDescribe your request below.\nStaff: close with `/closeticket`."
                )
                .setTimestamp(),
            ],
          });
          return interaction.editReply({
            content: "✅ " + type.emoji + " Ticket created: <#" + ch.id + ">",
          });
        } catch (e) {
          return interaction.editReply({
            content:
              "❌ Ticket error (v3): `" +
              e.message +
              "`\nBot needs **Manage Channels**. Role must be high in the list.",
          });
        }
      }

      if (id.startsWith("poll_")) {
        const opt = parseInt(id.split("_")[1], 10);
        const poll = activePolls.get(interaction.message.id);
        if (!poll) return interaction.editReply({ content: "Poll closed." });
        for (const set of Object.values(poll.votes)) set.delete(interaction.user.id);
        if (!poll.votes[opt]) poll.votes[opt] = new Set();
        poll.votes[opt].add(interaction.user.id);
        const lines = poll.options.map(
          (o, i) =>
            i +
            1 +
            ". **" +
            o +
            "** — " +
            ((poll.votes[i] && poll.votes[i].size) || 0) +
            " vote(s)"
        );
        try {
          await interaction.message.edit({
            embeds: [
              new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle("📊 " + poll.question)
                .setDescription(lines.join("\n"))
                .setFooter({ text: "Click to vote" })
                .setTimestamp(),
            ],
          });
        } catch (_) {}
        return interaction.editReply({ content: "✅ Vote recorded." });
      }

      if (id.startsWith("duel_accept_")) {
        const challengerId = id.replace("duel_accept_", "");
        if (interaction.user.id === challengerId)
          return interaction.editReply({ content: "Can't accept your own duel." });
        const a = Math.floor(Math.random() * 100) + 1;
        const b = Math.floor(Math.random() * 100) + 1;
        let result;
        if (a > b)
          result = "<@" + challengerId + "> wins (**" + a + "** vs **" + b + "**)!";
        else if (b > a)
          result = "<@" + interaction.user.id + "> wins (**" + b + "** vs **" + a + "**)!";
        else result = "Tie! (**" + a + "** vs **" + b + "**)";
        try {
          await interaction.message.edit({
            components: [],
            embeds: [
              new EmbedBuilder()
                .setColor(0xe67e22)
                .setTitle("⚔️ Duel result")
                .setDescription(result)
                .setTimestamp(),
            ],
          });
        } catch (_) {}
        return interaction.editReply({ content: "⚔️ " + result });
      }
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

    if (id === "status_check") {
      data.discordToRoblox = data.discordToRoblox || {};
      const uname = data.discordToRoblox[interaction.user.id];
      if (!uname) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("👤 No linked account")
              .setDescription("Redeem a key with `/redeem` first."),
          ],
        });
      }
      const now = Math.floor(Date.now() / 1000);
      let status = "❌ No active access";
      let color = 0x95a5a6;
      if (data.lifetimeWhitelist && data.lifetimeWhitelist[uname]) {
        status = "♾️ **LIFETIME**";
        color = 0x9b59b6;
      } else if (data.whitelist[uname] && data.whitelist[uname] > now) {
        status =
          "🟢 **WHITELIST** — " +
          Math.floor((data.whitelist[uname] - now) / 60) +
          " min left";
        color = 0x2ecc71;
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(color)
            .setTitle("👤 Your status")
            .setDescription("Roblox: **" + uname + "**\n" + status)
            .setTimestamp(),
        ],
      });
    }

    // ticket handled earlier (before inv_ filter)

    if (id.startsWith("poll_")) {
      const opt = parseInt(id.split("_")[1], 10);
      const poll = activePolls.get(interaction.message.id);
      if (!poll) return interaction.editReply({ content: "Poll closed." });
      for (const set of Object.values(poll.votes)) set.delete(interaction.user.id);
      if (!poll.votes[opt]) poll.votes[opt] = new Set();
      poll.votes[opt].add(interaction.user.id);
      const lines = poll.options.map(
        (o, i) =>
          i + 1 + ". **" + o + "** — " + ((poll.votes[i] && poll.votes[i].size) || 0) + " vote(s)"
      );
      try {
        await interaction.message.edit({
          embeds: [
            new EmbedBuilder()
              .setColor(0x3498db)
              .setTitle("📊 " + poll.question)
              .setDescription(lines.join("\n"))
              .setFooter({ text: "Click to vote" })
              .setTimestamp(),
          ],
        });
      } catch (_) {}
      return interaction.editReply({ content: "✅ Vote recorded." });
    }

    if (id.startsWith("duel_accept_")) {
      const challengerId = id.replace("duel_accept_", "");
      if (interaction.user.id === challengerId)
        return interaction.editReply({ content: "Can't accept your own duel." });
      const a = Math.floor(Math.random() * 100) + 1;
      const b = Math.floor(Math.random() * 100) + 1;
      let result;
      if (a > b) result = "<@" + challengerId + "> wins (**" + a + "** vs **" + b + "**)!";
      else if (b > a)
        result = "<@" + interaction.user.id + "> wins (**" + b + "** vs **" + a + "**)!";
      else result = "Tie! (**" + a + "** vs **" + b + "**)";
      try {
        await interaction.message.edit({
          components: [],
          embeds: [
            new EmbedBuilder()
              .setColor(0xe67e22)
              .setTitle("⚔️ Duel result")
              .setDescription(result)
              .setTimestamp(),
          ],
        });
      } catch (_) {}
      return interaction.editReply({ content: "⚔️ " + result });
    }

    if (id === "rules_ack") {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Thanks!")
            .setDescription("You're all set. Have fun!"),
        ],
      });
    }

    return interaction.editReply({ content: "❓ Unknown button." });
  }

  // ─── SLASH COMMANDS ────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  console.log("[CMD]", cmd, "by", interaction.user.id, interaction.user.tag);

  // spin + dice = PUBLIC (tout le monde voit qui gagne)
  const publicVisible = ["spin", "dice"];
  try {
    await interaction.deferReply({ ephemeral: !publicVisible.includes(cmd) });
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
    "status",
    "coinflip",
    "quest",
    "warns",
    "ticket",
    "duel",
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

    // SPIN — Casino Wheel (PUBLIC)
    if (cmd === "spin") {
      const uid = interaction.user.id;
      const mention = "<@" + uid + ">";
      const now = Date.now();
      const last = data.spins[uid] || 0;
      const bonus = getBonus(data, "spin", uid);
      const onCooldown = now - last < DAY_MS;

      if (onCooldown && bonus <= 0) {
        const left = DAY_MS - (now - last);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("🎡 Casino Wheel Spin")
              .setDescription(
                mention +
                  " already spun today!\nCome back in " +
                  timeLeft(left) +
                  "."
              )
              .setFooter({ text: "1 free spin / day • LARP TP" }),
          ],
        });
      }

      // Animation visible par tout le monde
      const frames = [
        "[ 🔴 ⚪ ⚪ ⚪ ⚪ ]",
        "[ ⚪ 🔴 ⚪ ⚪ ⚪ ]",
        "[ ⚪ ⚪ 🔴 ⚪ ⚪ ]",
        "[ ⚪ ⚪ ⚪ 🔴 ⚪ ]",
        "[ ⚪ ⚪ ⚪ ⚪ 🔴 ]",
        "[ ⚪ ⚪ 🔴 ⚪ ⚪ ]",
        "[ ⚪ 🔴 ⚪ ⚪ ⚪ ]",
        "[ 🔴 ⚪ ⚪ ⚪ ⚪ ]",
      ];
      for (let i = 0; i < frames.length; i++) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf1c40f)
              .setTitle("🎡 Casino Wheel Spin")
              .setDescription(
                mention + " is spinning the wheel...\n\n`" + frames[i] + "`"
              ),
          ],
        });
        await new Promise((r) => setTimeout(r, 350));
      }

      if (onCooldown && bonus > 0) consumeBonus(data, "spin", uid);
      else data.spins[uid] = now;

      // 0h 70% · 1h 20% · 3h 8% · 6h 2%
      const r = Math.random();
      let prizeHours = 0;
      let prizeLabel = "0 Timer (Nothing this time)";
      if (r < 0.02) {
        prizeHours = 6;
        prizeLabel = "6h Timer";
      } else if (r < 0.1) {
        prizeHours = 3;
        prizeLabel = "3h Timer";
      } else if (r < 0.3) {
        prizeHours = 1;
        prizeLabel = "1h Timer";
      }

      const remaining = getBonus(data, "spin", uid);
      let extra = "";
      if (prizeHours > 0) {
        const { key, data: kData } = makeKey(prizeHours + "h", prizeHours * 3600, "spin");
        data.keys[key] = kData;
        bumpStat(data, uid, "spinWins");
        addLog("spin_win", interaction.user.tag, "", prizeLabel + " " + key);
        const dmOk = await sendKeyDM(interaction.user, key, prizeHours + "h");
        extra = dmOk
          ? "\n\n📩 Key sent to " + mention + "'s **DMs**!"
          : "\n\n🔑 Key for " + mention + ": `" + key + "`";
      } else {
        addLog("spin_lose", interaction.user.tag, "", "0 Timer");
      }
      saveData(data);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(prizeHours > 0 ? 0x2ecc71 : 0xe74c3c)
            .setTitle("🎡 Casino Wheel Spin")
            .setDescription(
              "**The wheel stopped!**\n\n" +
                "💀 You got: **" +
                prizeLabel +
                "**" +
                extra +
                "\n\nBetter luck tomorrow, " +
                mention +
                "!"
            )
            .setFooter({
              text: "Bonus left: " + remaining + " • 1 spin / day • LARP TP",
            })
            .setTimestamp(),
        ],
      });
    }

    // DICE — PUBLIC
    if (cmd === "dice") {
      const uid = interaction.user.id;
      const mention = "<@" + uid + ">";
      const now = Date.now();
      const last = data.dice[uid] || 0;
      const bonus = getBonus(data, "dice", uid);
      const onCooldown = now - last < DAY_MS;
      data.diceReroll = data.diceReroll || {};
      const pendingReroll = data.diceReroll[uid] || null;

      if (!pendingReroll && onCooldown && bonus <= 0) {
        const left = DAY_MS - (now - last);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("🎲 DICE — Cooldown")
              .setDescription(
                mention + " already played today!\nCome back in " + timeLeft(left) + "."
              )
              .setFooter({ text: "1 free dice / day • LARP TP" })
              .setTimestamp(),
          ],
        });
      }

      const pick = interaction.options.getString("color");
      const pickObj = DICE_COLORS.find((c) => c.value === pick) || DICE_COLORS[0];

      if (pendingReroll && pendingReroll.previousPick === pick) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("🎲 DICE — Reroll required")
              .setDescription(
                mention +
                  " must pick a **different** color!\nYou already used **" +
                  pendingReroll.previousPick +
                  "**.\nChoose another with `/dice`."
              )
              .setTimestamp(),
          ],
        });
      }

      for (let i = 0; i < 5; i++) {
        const flash = DICE_COLORS[i % DICE_COLORS.length];
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf1c40f)
              .setTitle(pendingReroll ? "🎲 Dice REROLL" : "🎲 Dice Roll")
              .setDescription(
                mention + " is rolling...\n\n" + flash.emoji + " **" + flash.name + "**"
              ),
          ],
        });
        await new Promise((r) => setTimeout(r, 280));
      }

      if (!pendingReroll) {
        if (onCooldown && bonus > 0) consumeBonus(data, "dice", uid);
        else data.dice[uid] = now;
      }

      const rolled = [];
      for (let i = 0; i < 4; i++) {
        rolled.push(DICE_COLORS[Math.floor(Math.random() * DICE_COLORS.length)]);
      }
      const rolledEmojis = rolled.map((c) => c.emoji);
      // Reroll only if YOUR chosen color appears 2+ times
      const hasDup = diceHasDuplicate(rolled, pick);
      const remaining = getBonus(data, "dice", uid);

      if (hasDup) {
        if (pendingReroll) {
          delete data.diceReroll[uid];
          saveData(data);
          addLog("dice_lose", interaction.user.tag, "", pick + " (double-duplicate)");
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor(0xe74c3c)
                .setTitle("🎲 DICE — Loss (double your color)")
                .setDescription(
                  mention +
                    " lost...\n\n" +
                    diceVisual(
                      pickObj.emoji,
                      pick,
                      rolledEmojis,
                      false,
                      "💥 **Your color appeared 2× again** on the reroll — you lose!"
                    )
                )
                .setFooter({ text: "Bonus left: " + remaining + " • 1 dice / day" })
                .setTimestamp(),
            ],
          });
        }
        data.diceReroll[uid] = { previousPick: pick, at: now };
        saveData(data);
        addLog("dice_reroll", interaction.user.tag, "", pick + " (your color x2)");
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("🎲 DICE — Your color x2! Reroll")
              .setDescription(
                mention +
                  "\n\n" +
                  diceVisual(
                    pickObj.emoji,
                    pick,
                    rolledEmojis,
                    false,
                    "⚠️ **Your color appeared 2 times!**\nFree **reroll** — pick a **different** color with `/dice`.\nIf your new color appears 2× again → **you lose**."
                  )
              )
              .setFooter({ text: "Free reroll • pick another color" })
              .setTimestamp(),
          ],
        });
      }

      delete data.diceReroll[uid];
      const match = rolled.some((c) => c.value === pick);

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
                mention +
                  " won!\n\n" +
                  diceVisual(pickObj.emoji, pick, rolledEmojis, true) +
                  "\n\n" +
                  (dmOk
                    ? "📩 **1h** key sent to " + mention + "'s **DMs**!"
                    : "🔑 Key for " + mention + ": `" + key + "`")
              )
              .setFooter({ text: "Bonus left: " + remaining + " • 1 dice / day" })
              .setTimestamp(),
          ],
        });
      }

      saveData(data);
      addLog("dice_lose", interaction.user.tag, "", pick);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("🎲 DICE — Loss")
            .setDescription(
              mention + " lost...\n\n" + diceVisual(pickObj.emoji, pick, rolledEmojis, false)
            )
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
                "\nJust **type a number** in this chat to guess!\n(You can still use `/guess` too)"
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

        await lockGuessChannel(
          interaction.channel,
          "🎯 **" + interaction.user.tag + "** found the number. Channel locked."
        );

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

      // Mauvais essai: silencieux
      try {
        await interaction.deleteReply();
      } catch (_) {
        await interaction.editReply({ content: "\u200b" }).catch(() => {});
      }
      return;
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

    if (cmd === "giveaway") {
      const prize = interaction.options.getString("prize");
      const minutes = interaction.options.getInteger("minutes") || 10;
      const winnersCount = interaction.options.getInteger("winners") || 1;
      const guildId = interaction.guildId || "dm";
      if (activeGiveaways.has(guildId) && activeGiveaways.get(guildId).active) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("⚠️ Giveaway already running")
              .setDescription("End it with `/giveawayend` first."),
          ],
        });
      }
      try {
        await interaction.deleteReply().catch(() => {});
      } catch (_) {}
      const endsAt = Date.now() + minutes * 60 * 1000;
      const msg = await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle("🎁 GIVEAWAY!")
            .setDescription(
              "Prize: **" +
                prize +
                "**\nWinners: **" +
                winnersCount +
                "**\nDuration: **" +
                minutes +
                " min**\n\nClick **Enter** to join!\nEnds <t:" +
                Math.floor(endsAt / 1000) +
                ":R>"
            )
            .setFooter({ text: "LARP TP • Giveaway" })
            .setTimestamp(),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("giveaway_join")
              .setLabel("Enter")
              .setEmoji("🎁")
              .setStyle(ButtonStyle.Success)
          ),
        ],
      });
      const drawGiveaway = async () => {
        const g = activeGiveaways.get(guildId);
        if (!g || !g.active) return;
        g.active = false;
        activeGiveaways.delete(guildId);
        const list = [...g.entrants];
        let channel;
        try {
          channel = await client.channels.fetch(g.channelId);
        } catch (_) {}
        if (!list.length) {
          addLog("giveaway_end", "system", "", "no entrants — " + g.prize);
          if (channel) {
            channel
              .send({
                embeds: [
                  new EmbedBuilder()
                    .setColor(0xe74c3c)
                    .setTitle("🎁 Giveaway ended")
                    .setDescription("Prize: **" + g.prize + "**\nNobody joined."),
                ],
              })
              .catch(() => {});
          }
          return;
        }
        const shuffled = list.sort(() => Math.random() - 0.5);
        const winners = shuffled.slice(0, Math.min(g.winnersCount, list.length));
        let prizeExtra = "";
        const data = loadData();
        const parsed = parseDuration(String(g.prize).replace(/\s/g, ""));
        if (parsed && !parsed.lifetime) {
          for (const wid of winners) {
            try {
              const user = await client.users.fetch(wid);
              const durMatch = String(g.prize).match(/\d+\s*[a-zA-Z]+/);
              const durStr = durMatch ? durMatch[0].replace(/\s/g, "") : "1h";
              const { key, data: kData } = makeKey(durStr, parsed.seconds || 3600, "giveaway");
              data.keys[key] = kData;
              const dmOk = await sendKeyDM(user, key, kData.duration);
              prizeExtra += "\n<@" + wid + ">: " + (dmOk ? "📩 key in DM" : "`" + key + "`");
            } catch (_) {}
          }
          saveData(data);
        }
        lastGiveaways.set(guildId, {
          prize: g.prize,
          winnersCount: g.winnersCount,
          entrants: list,
          previousWinners: winners,
          channelId: g.channelId,
        });
        addLog(
          "giveaway_win",
          winners.map((id) => "<@" + id + ">").join(", "),
          "",
          g.prize + " · " + list.length + " entrants"
        );
        if (channel) {
          channel
            .send({
              embeds: [
                new EmbedBuilder()
                  .setColor(0x2ecc71)
                  .setTitle("🎁 Giveaway winners!")
                  .setDescription(
                    "Prize: **" +
                      g.prize +
                      "**\nWinners: " +
                      winners.map((id) => "<@" + id + ">").join(", ") +
                      "\nEntrants: **" +
                      list.length +
                      "**" +
                      prizeExtra
                  )
                  .setTimestamp(),
              ],
            })
            .catch(() => {});
        }
      };
      activeGiveaways.set(guildId, {
        active: true,
        prize,
        winnersCount,
        entrants: new Set(),
        messageId: msg.id,
        channelId: interaction.channelId,
        endsAt,
        timer: setTimeout(drawGiveaway, minutes * 60 * 1000),
      });
      addLog("giveaway", interaction.user.tag, "", prize + " · " + minutes + "m · x" + winnersCount);
      try {
        await interaction.followUp({ content: "✅ Giveaway started.", ephemeral: true });
      } catch (_) {}
      return;
    }

    if (cmd === "giveawayend") {
      const guildId = interaction.guildId || "dm";
      const g = activeGiveaways.get(guildId);
      if (!g || !g.active) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("ℹ️ No active giveaway")
              .setDescription("Nothing to end."),
          ],
        });
      }
      if (g.timer) clearTimeout(g.timer);
      g.active = false;
      const list = [...g.entrants];
      activeGiveaways.delete(guildId);
      if (!list.length) {
        addLog("giveaway_end", interaction.user.tag, "", "early — no entrants");
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("🎁 Ended")
              .setDescription("Nobody joined."),
          ],
        });
      }
      const shuffled = list.sort(() => Math.random() - 0.5);
      const winners = shuffled.slice(0, Math.min(g.winnersCount, list.length));
      lastGiveaways.set(guildId, {
        prize: g.prize,
        winnersCount: g.winnersCount,
        entrants: list,
        previousWinners: winners,
        channelId: interaction.channelId,
      });
      addLog(
        "giveaway_win",
        winners.map((id) => "<@" + id + ">").join(", "),
        "",
        "early · " + g.prize
      );
      try {
        await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🎁 Giveaway winners!")
              .setDescription(
                "Prize: **" +
                  g.prize +
                  "**\nWinners: " +
                  winners.map((id) => "<@" + id + ">").join(", ") +
                  "\nEntrants: **" +
                  list.length +
                  "**"
              )
              .setTimestamp(),
          ],
        });
      } catch (_) {}
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🎁 Drawn")
            .setDescription("Winners: " + winners.map((id) => "<@" + id + ">").join(", ")),
        ],
      });
    }

    if (cmd === "reroll") {
      const guildId = interaction.guildId || "dm";
      const last = lastGiveaways.get(guildId);
      if (!last || !last.entrants || !last.entrants.length) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Nothing to reroll")
              .setDescription("No finished giveaway in this server yet."),
          ],
        });
      }
      const count =
        interaction.options.getInteger("winners") || last.winnersCount || 1;
      const pool = last.entrants.filter(
        (id) => !(last.previousWinners || []).includes(id)
      );
      // If everyone already won, allow full pool again
      const usePool = pool.length >= count ? pool : last.entrants.slice();
      if (!usePool.length) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ No entrants")
              .setDescription("Last giveaway had no participants."),
          ],
        });
      }
      const shuffled = usePool.sort(() => Math.random() - 0.5);
      const winners = shuffled.slice(0, Math.min(count, usePool.length));
      last.previousWinners = [
        ...(last.previousWinners || []),
        ...winners,
      ];
      lastGiveaways.set(guildId, last);
      addLog(
        "giveaway_reroll",
        winners.map((id) => "<@" + id + ">").join(", "),
        "",
        last.prize
      );
      try {
        await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf1c40f)
              .setTitle("🎲 Giveaway REROLL!")
              .setDescription(
                "Prize: **" +
                  last.prize +
                  "**\nNew winner(s): " +
                  winners.map((id) => "<@" + id + ">").join(", ") +
                  "\nPool: **" +
                  usePool.length +
                  "** entrants"
              )
              .setTimestamp(),
          ],
        });
      } catch (_) {}
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🎲 Rerolled")
            .setDescription(
              "New winner(s): " + winners.map((id) => "<@" + id + ">").join(", ")
            ),
        ],
      });
    }

    if (cmd === "deletekey") {
      const raw = String(interaction.options.getString("key") || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
      const data = loadData();
      data.keys = data.keys || {};
      let found = null;
      for (const k of Object.keys(data.keys)) {
        if (String(k).toUpperCase() === raw) {
          found = k;
          break;
        }
      }
      if (!found) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Key not found")
              .setDescription("`" + raw + "` does not exist."),
          ],
        });
      }
      delete data.keys[found];
      saveData(data);
      addLog("deletekey", interaction.user.tag, "", found);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🗑️ Key deleted")
            .setDescription("Removed `" + found + "`"),
        ],
      });
    }

    if (cmd === "purgekeys") {
      const confirm = interaction.options.getBoolean("confirm");
      if (!confirm) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("⚠️ Confirmation required")
              .setDescription("Use `/purgekeys confirm:True` to delete **all** keys."),
          ],
        });
      }
      const data = loadData();
      const count = Object.keys(data.keys || {}).length;
      data.keys = {};
      saveData(data);
      addLog("purgekeys", interaction.user.tag, "", count + " keys deleted");
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("🗑️ All keys deleted")
            .setDescription("Removed **" + count + "** key(s) from the database."),
        ],
      });
    }

    // ─── NEW FEATURES ─────────────────────────────────────
    if (cmd === "stats") {
      const now = Math.floor(Date.now() / 1000);
      const keys = Object.values(data.keys || {});
      const unused = keys.filter((k) => !k.used).length;
      const used = keys.filter((k) => k.used).length;
      const activeWl = Object.values(data.whitelist || {}).filter((e) => e > now).length;
      const life = Object.keys(data.lifetimeWhitelist || {}).length;
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00e5ff)
            .setTitle("📊 LARP TP Stats")
            .addFields(
              { name: "🔑 Keys", value: "Unused **" + unused + "** · Used **" + used + "**", inline: true },
              { name: "🟢 Access", value: "Timed **" + activeWl + "** · Life **" + life + "**", inline: true }
            )
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "status") {
      data.discordToRoblox = data.discordToRoblox || {};
      let uname = (interaction.options.getString("username") || "").toLowerCase();
      if (!uname) uname = data.discordToRoblox[interaction.user.id] || "";
      if (!uname) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("👤 No account")
              .setDescription("Provide a username or redeem a key first."),
          ],
        });
      }
      const now = Math.floor(Date.now() / 1000);
      let status = "❌ No active access";
      let color = 0x95a5a6;
      if (data.lifetimeWhitelist && data.lifetimeWhitelist[uname]) {
        status = "♾️ **LIFETIME**";
        color = 0x9b59b6;
      } else if (data.whitelist[uname] && data.whitelist[uname] > now) {
        status = "🟢 **" + Math.floor((data.whitelist[uname] - now) / 60) + " min left**";
        color = 0x2ecc71;
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(color)
            .setTitle("👤 Status")
            .setDescription("**" + uname + "**\n" + status)
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "statuspanel") {
      try { await interaction.deleteReply().catch(() => {}); } catch (_) {}
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00e5ff)
            .setTitle("👤 My Status — LARP TP")
            .setDescription("Click **My Status** to see your access time.")
            .setTimestamp(),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("status_check")
              .setLabel("My Status")
              .setEmoji("👤")
              .setStyle(ButtonStyle.Primary)
          ),
        ],
      });
      try { await interaction.followUp({ content: "✅ Panel posted.", ephemeral: true }); } catch (_) {}
      return;
    }

    if (cmd === "backup") {
      const json = JSON.stringify(data, null, 2);
      try {
        await interaction.user.send({
          content: "💾 Backup " + new Date().toISOString(),
          files: [{ attachment: Buffer.from(json, "utf8"), name: "larp-backup.json" }],
        });
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle("💾 Backup sent in DMs")],
        });
      } catch {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle("❌ Open your DMs")],
        });
      }
    }

    if (cmd === "coinflip") {
      const uid = interaction.user.id;
      const today = dayKey();
      data.coinflip = data.coinflip || {};
      if (data.coinflip[uid] === today) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("🪙 Coinflip — Already used")
              .setDescription(
                "<@" + uid + "> already flipped today!\nCome back **tomorrow**."
              )
              .setFooter({ text: "1 coinflip / day • LARP TP" })
              .setTimestamp(),
          ],
        });
      }
      data.coinflip[uid] = today;
      const win = Math.random() < 0.5;
      if (win) {
        data.spinsBonus[uid] = (data.spinsBonus[uid] || 0) + 1;
        delete data.spins[uid];
        saveData(data);
        addLog("coinflip", interaction.user.tag, "", "win +1 spin");
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🪙 Heads — You win!")
              .setDescription("🎁 **+1 bonus spin** — use `/spin`!\n\n_1 flip per day._")
              .setFooter({ text: "1 coinflip / day" })
              .setTimestamp(),
          ],
        });
      }
      saveData(data);
      addLog("coinflip", interaction.user.tag, "", "lose");
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x95a5a6)
            .setTitle("🪙 Tails — No luck")
            .setDescription("No bonus this time.\nTry again **tomorrow**.")
            .setFooter({ text: "1 coinflip / day" })
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "quest") {
      const uid = interaction.user.id;
      const today = dayKey();
      data.quests = data.quests || {};
      if (!data.quests[uid] || data.quests[uid].day !== today) {
        data.quests[uid] = { day: today, spin: false, dice: false, claimed: false };
        saveData(data);
      }
      const q = data.quests[uid];
      if (q.claimed) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xf39c12).setTitle("📜 Already claimed today")],
        });
      }
      if (!(q.spin && q.dice)) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x3498db)
              .setTitle("📜 Daily Quest")
              .setDescription(
                (q.spin ? "✅" : "⬜") +
                  " `/spin`\n" +
                  (q.dice ? "✅" : "⬜") +
                  " `/dice`\n\nReward: **+1 spin**"
              ),
          ],
        });
      }
      q.claimed = true;
      data.spinsBonus[uid] = (data.spinsBonus[uid] || 0) + 1;
      delete data.spins[uid];
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder().setColor(0x2ecc71).setTitle("📜 Quest complete!").setDescription("✅ **+1 bonus spin**"),
        ],
      });
    }

    if (cmd === "warn") {
      const user = interaction.options.getUser("user");
      const reason = interaction.options.getString("reason");
      data.warns = data.warns || {};
      data.warns[user.id] = data.warns[user.id] || [];
      data.warns[user.id].push({ reason, by: interaction.user.tag, at: new Date().toISOString() });
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf39c12)
            .setTitle("⚠️ Warned")
            .setDescription("**" + user.tag + "** — " + reason + "\nTotal: **" + data.warns[user.id].length + "**"),
        ],
      });
    }

    if (cmd === "warns") {
      const user = interaction.options.getUser("user");
      const list = (data.warns && data.warns[user.id]) || [];
      if (!list.length) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle("📋 No warns for " + user.tag)],
        });
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf39c12)
            .setTitle("📋 Warns — " + user.tag)
            .setDescription(
              list
                .slice(-10)
                .map((w, i) => i + 1 + ". " + w.reason + " — _" + w.by + "_")
                .join("\n")
            ),
        ],
      });
    }

    if (cmd === "clearwarns") {
      const user = interaction.options.getUser("user");
      data.warns = data.warns || {};
      const n = (data.warns[user.id] || []).length;
      data.warns[user.id] = [];
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🧹 Cleared")
            .setDescription("Removed **" + n + "** warn(s) from **" + user.tag + "**"),
        ],
      });
    }

    if (cmd === "poll") {
      const question = interaction.options.getString("question");
      const options = [
        interaction.options.getString("option1"),
        interaction.options.getString("option2"),
        interaction.options.getString("option3"),
        interaction.options.getString("option4"),
      ].filter(Boolean);
      try { await interaction.deleteReply().catch(() => {}); } catch (_) {}
      const row = new ActionRowBuilder();
      options.forEach((o, i) => {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId("poll_" + i)
            .setLabel(i + 1 + ". " + o.slice(0, 70))
            .setStyle(ButtonStyle.Secondary)
        );
      });
      const msg = await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("📊 " + question)
            .setDescription(options.map((o, i) => i + 1 + ". **" + o + "** — 0").join("\n"))
            .setTimestamp(),
        ],
        components: [row],
      });
      activePolls.set(msg.id, { question, options, votes: {} });
      try { await interaction.followUp({ content: "✅ Poll posted.", ephemeral: true }); } catch (_) {}
      return;
    }

    if (cmd === "ticket" || cmd === "ticketpanel") {
      if (cmd === "ticketpanel") {
        try { await interaction.deleteReply().catch(() => {}); } catch (_) {}
        await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x9b59b6)
              .setTitle("🎫 Need help?")
              .setDescription(
                "Click a button below to open a **private ticket**.\n" +
                  "Our staff will get back to you shortly.\n\n" +
                  "💰 **Buy** — purchase / payment\n" +
                  "❓ **Help** — general support\n" +
                  "🔑 **Key issue** — redeem / key problems\n" +
                  "🐛 **Bug** — report a bug"
              )
              .setFooter({ text: "LARP TP • Support" })
              .setTimestamp(),
          ],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId("ticket_open_buy")
                .setLabel("Buy")
                .setEmoji("💰")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId("ticket_open_help")
                .setLabel("Help")
                .setEmoji("❓")
                .setStyle(ButtonStyle.Primary),
              new ButtonBuilder()
                .setCustomId("ticket_open_key")
                .setLabel("Key issue")
                .setEmoji("🔑")
                .setStyle(ButtonStyle.Secondary),
              new ButtonBuilder()
                .setCustomId("ticket_open_bug")
                .setLabel("Bug")
                .setEmoji("🐛")
                .setStyle(ButtonStyle.Danger)
            ),
          ],
        });
        try { await interaction.followUp({ content: "✅ Ticket panel posted.", ephemeral: true }); } catch (_) {}
        return;
      }
      // /ticket → general help
      const guild = interaction.guild;
      if (!guild) return interaction.editReply({ content: "Guild only." });
      try {
        const ch = await createTicketChannel(
          guild,
          interaction.user,
          client.user.id,
          "help"
        );
        await ch.send({
          content: "<@" + interaction.user.id + ">",
          embeds: [
            new EmbedBuilder()
              .setColor(0x3498db)
              .setTitle("❓ Help")
              .setDescription("Describe your issue. Close with `/closeticket`.")
              .setTimestamp(),
          ],
        });
        return interaction.editReply({ content: "✅ Ticket: <#" + ch.id + ">" });
      } catch (e) {
        return interaction.editReply({
          content: "❌ Ticket error (v3): `" + e.message + "`",
        });
      }
    }

    if (cmd === "closeticket") {
      const ch = interaction.channel;
      if (
        !ch ||
        !ch.name ||
        !(
          String(ch.name).startsWith("ticket-") ||
          String(ch.name).startsWith("buy-") ||
          String(ch.name).startsWith("help-") ||
          String(ch.name).startsWith("key-") ||
          String(ch.name).startsWith("bug-")
        )
      ) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle("❌ Not a ticket channel")],
        });
      }
      await interaction.editReply({ content: "🔒 Closing in 3s…" });
      setTimeout(() => ch.delete().catch(() => {}), 3000);
      return;
    }

    if (cmd === "welcome") {
      const custom = interaction.options.getString("text");
      try { await interaction.deleteReply().catch(() => {}); } catch (_) {}
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle("👋 Welcome to LARP TP")
            .setDescription(
              custom ||
                "• `/redeem` — activate a key\n• `/spin` / `/dice` — daily games\n• `/ticket` — need help?"
            )
            .setTimestamp(),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("rules_ack")
              .setLabel("I have read the rules")
              .setEmoji("✅")
              .setStyle(ButtonStyle.Success)
          ),
        ],
      });
      try { await interaction.followUp({ content: "✅ Posted.", ephemeral: true }); } catch (_) {}
      return;
    }

    if (cmd === "duel") {
      const opponent = interaction.options.getUser("opponent");
      if (opponent.id === interaction.user.id || opponent.bot) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle("❌ Invalid opponent")],
        });
      }
      try { await interaction.deleteReply().catch(() => {}); } catch (_) {}
      await interaction.channel.send({
        content: "<@" + opponent.id + ">",
        embeds: [
          new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle("⚔️ Spin duel!")
            .setDescription(
              "<@" + interaction.user.id + "> challenges <@" + opponent.id + ">!\nClick **Accept**."
            )
            .setTimestamp(),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("duel_accept_" + interaction.user.id)
              .setLabel("Accept")
              .setEmoji("⚔️")
              .setStyle(ButtonStyle.Danger)
          ),
        ],
      });
      try { await interaction.followUp({ content: "✅ Challenge sent.", ephemeral: true }); } catch (_) {}
      return;
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

app.listen(PORT, "0.0.0.0", () => console.log("[API] Port", PORT, "on 0.0.0.0"));
