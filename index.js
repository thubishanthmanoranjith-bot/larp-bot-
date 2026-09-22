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
  };
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

  const publicCmds = ["redeem", "checkkey", "info", "spin", "dice", "invites"];
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
