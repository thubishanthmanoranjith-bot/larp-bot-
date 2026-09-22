/**
 * LARP TP - Discord Bot + API
 * + système d'invites (conversion clés / spins) + panel permanent
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
const BOT_ADMINS = (process.env.BOT_ADMINS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const DATA_DIR = process.env.DATA_DIR || "/tmp";
const DATA_FILE = path.join(DATA_DIR, "larp-data.json");
const LOCAL_FALLBACK = path.join(__dirname, "data.json");

const DAY_MS = 24 * 60 * 60 * 1000;

// Coûts invites
const INVITE_COST_1H = 1; // 1 invite → clé 1h
const INVITE_COST_SPINS = 1; // 1 invite → 2 spins
const INVITE_COST_1D = 5; // 5 invites → clé 1d
const SPINS_REWARD = 2;

// ─── Couleurs dice ─────────────────────────────────────────
const DICE_COLORS = [
  { name: "Red", emoji: "🔴", value: "Red", color: 0xe74c3c },
  { name: "Blue", emoji: "🔵", value: "Blue", color: 0x3498db },
  { name: "Green", emoji: "🟢", value: "Green", color: 0x2ecc71 },
  { name: "Yellow", emoji: "🟡", value: "Yellow", color: 0xf1c40f },
  { name: "Orange", emoji: "🟠", value: "Orange", color: 0xe67e22 },
  { name: "Violet", emoji: "🟣", value: "Violet", color: 0x9b59b6 },
];

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
        d.invites = d.invites || {}; // userId → points disponibles
        d.invitesUsed = d.invitesUsed || {}; // userId → total déjà dépensé
        d.invitedUsers = d.invitedUsers || {}; // invitedUserId → inviterId (anti multi-compte simple)
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
  };
}

function saveData(data) {
  try {
    if (data.logs && data.logs.length > 150) data.logs = data.logs.slice(-150);
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
    data.logs.push({
      at: new Date().toISOString(),
      action,
      by,
      target: target || "",
      details: details || "",
    });
    saveData(data);
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
  if (ms <= 0) return "maintenant";
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

/** Envoie la clé en MP à l'utilisateur. Retourne true si OK. */
async function sendKeyDM(user, key, durationStr) {
  try {
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x00e5ff)
          .setTitle("🔑 Ta clé LARP TP")
          .setDescription(
            "Voici ta clé :\n\n🔑 `" +
              key +
              "`\n⏱️ Durée: **" +
              durationStr +
              "**\n\n" +
              "➡️ En jeu: **My Key → Redeem**\n" +
              "➡️ Ou `/redeem` sur Discord"
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
    (win ? "✨ **JACKPOT** ✨" : "💨 *rien cette fois...*")
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
    "Tu as choisi " +
    pickEmoji +
    " **" +
    pick +
    "**\n" +
    "Les 4 couleurs : " +
    line +
    "\n\n" +
    (match
      ? "🎉🎊 **TA COULEUR EST SORTIE !** Tu gagnes une clé **1h** 🔑"
      : "💔 Ta couleur n'est pas sortie... retente demain !")
  );
}

function buildInvitePanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("🎟️ Panel Invites — LARP TP")
    .setDescription(
      "Échange tes **points d'invites** contre des récompenses !\n\n" +
        "**Taux d'échange :**\n" +
        "• `1` invite → 🔑 clé **1h** *(envoyée en MP)*\n" +
        "• `1` invite → 🎰 **2 spins**\n" +
        "• `5` invites → 🔑 clé **1 jour** *(envoyée en MP)*\n\n" +
        "⚠️ Chaque point ne peut être **dépensé qu'une seule fois**.\n" +
        "Les admins attribuent les points avec `/addinvites`.\n" +
        "Clique sur un bouton ci-dessous pour échanger."
    )
    .setFooter({ text: "LARP TP • Invites" })
    .setTimestamp();
}

function buildInvitePanelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("inv_claim_1h")
      .setLabel("1 invite → Clé 1h")
      .setEmoji("🔑")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("inv_claim_spins")
      .setLabel("1 invite → 2 Spins")
      .setEmoji("🎰")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("inv_claim_1d")
      .setLabel("5 invites → Clé 1j")
      .setEmoji("💎")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("inv_check")
      .setLabel("Mes invites")
      .setEmoji("📊")
      .setStyle(ButtonStyle.Secondary)
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName("createkey")
    .setDescription("🔑 Créer une clé LARP TP")
    .addStringOption((o) =>
      o.setName("duration").setDescription("30m / 1h / 1d / lifetime").setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Nombre de clés (1-20)").setMinValue(1).setMaxValue(20)
    ),
  new SlashCommandBuilder()
    .setName("givekey")
    .setDescription("🎁 Créer une clé et l'envoyer en MP")
    .addUserOption((o) => o.setName("user").setDescription("Membre").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("30m / 1h / 1d / lifetime").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("redeem")
    .setDescription("✅ Utiliser une clé")
    .addStringOption((o) => o.setName("key").setDescription("Clé LARP-XXXX").setRequired(true))
    .addStringOption((o) =>
      o.setName("username").setDescription("Pseudo Roblox").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("checkkey")
    .setDescription("🔍 Vérifier une clé")
    .addStringOption((o) => o.setName("key").setDescription("Clé").setRequired(true)),
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("➕ Whitelist sans clé")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("1h / lifetime").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("➖ Retirer whitelist")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true)),
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("👤 Info joueur")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true)),
  new SlashCommandBuilder().setName("list").setDescription("📋 Liste whitelist"),
  new SlashCommandBuilder()
    .setName("spin")
    .setDescription("🎰 Tour quotidien — chance de gagner une clé 1h (1× / jour)"),
  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("🎲 Choisis 1 couleur — 4 sortent au hasard, si la tienne apparaît = clé 1h (1×/jour)")
    .addStringOption((o) =>
      o
        .setName("color")
        .setDescription("Ta couleur")
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
    .setDescription("🔄 Reset le cooldown spin (user ou all)")
    .addUserOption((o) => o.setName("user").setDescription("Membre"))
    .addBooleanOption((o) => o.setName("all").setDescription("Reset tout le monde")),
  new SlashCommandBuilder()
    .setName("resetdice")
    .setDescription("🔄 Reset le cooldown dice (user ou all)")
    .addUserOption((o) => o.setName("user").setDescription("Membre"))
    .addBooleanOption((o) => o.setName("all").setDescription("Reset tout le monde")),
  new SlashCommandBuilder()
    .setName("giveallspin")
    .setDescription("🎁 Reset cooldown + bonus spin pour tout le monde")
    .addIntegerOption((o) =>
      o
        .setName("amount")
        .setDescription("Bonus globaux (défaut 1)")
        .setMinValue(1)
        .setMaxValue(10)
    ),
  new SlashCommandBuilder()
    .setName("givealldice")
    .setDescription("🎁 Reset cooldown + bonus dice pour tout le monde")
    .addIntegerOption((o) =>
      o
        .setName("amount")
        .setDescription("Bonus globaux (défaut 1)")
        .setMinValue(1)
        .setMaxValue(10)
    ),
  new SlashCommandBuilder()
    .setName("givespin")
    .setDescription("🎁 Donne des spins à un user")
    .addUserOption((o) => o.setName("user").setDescription("Membre").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Nombre (défaut 1)").setMinValue(1).setMaxValue(20)
    ),
  new SlashCommandBuilder()
    .setName("givedice")
    .setDescription("🎁 Donne des dice à un user")
    .addUserOption((o) => o.setName("user").setDescription("Membre").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Nombre (défaut 1)").setMinValue(1).setMaxValue(20)
    ),
  // ─── INVITES ─────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("invites")
    .setDescription("🎟️ Voir tes points d'invites"),
  new SlashCommandBuilder()
    .setName("invitepanel")
    .setDescription("📌 Poster le panel d'invites (reste dans le salon)"),
  new SlashCommandBuilder()
    .setName("addinvites")
    .setDescription("➕ Ajouter des points d'invites à un user (admin)")
    .addUserOption((o) => o.setName("user").setDescription("Membre").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Nombre de points").setRequired(true).setMinValue(1).setMaxValue(100)
    ),
  new SlashCommandBuilder()
    .setName("setinvites")
    .setDescription("✏️ Définir les points d'invites d'un user (admin)")
    .addUserOption((o) => o.setName("user").setDescription("Membre").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Nouveau total").setRequired(true).setMinValue(0).setMaxValue(999)
    ),
].map((c) => c.toJSON());

// GuildMembers retiré → compatible Bot-Hosting (pas d'intent privilégié)
// Les points d'invites se donnent avec /addinvites (admin)
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("clientReady", () => {
  console.log("[BOT] Connecté:", client.user.tag);
  console.log("[BOT] Admins Discord IDs:", BOT_ADMINS.join(", ") || "(aucun)");
});
client.once("ready", () => {
  console.log("[BOT] Connecté (ready):", client.user.tag);
  console.log("[BOT] Admins Discord IDs:", BOT_ADMINS.join(", ") || "(aucun)");
});

client.on("interactionCreate", async (interaction) => {
  // ─── BOUTONS PANEL INVITES ─────────────────────────────
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (!id.startsWith("inv_")) return;

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
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
            .setTitle("📊 Tes invites")
            .setDescription(
              "🎟️ Points disponibles: **" +
                pts +
                "**\n" +
                "✅ Déjà dépensés: **" +
                used +
                "**\n\n" +
                "**Échanges :**\n" +
                "• 1 → clé 1h\n" +
                "• 1 → 2 spins\n" +
                "• 5 → clé 1 jour"
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
              .setTitle("❌ Pas assez d'invites")
              .setDescription(
                "Il te faut **1** invite.\nTu as: **" + getInvitePoints(data, uid) + "**"
              ),
          ],
        });
      }
      const { key, data: kData } = makeKey1h("invite");
      data.keys[key] = kData;
      saveData(data);
      addLog("inv_claim_1h", interaction.user.tag, "", key);
      const dmOk = await sendKeyDM(interaction.user, key, "1h");
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Clé 1h obtenue !")
            .setDescription(
              "🎟️ -1 invite\n\n" +
                (dmOk
                  ? "📩 Clé envoyée en **MP** !"
                  : "⚠️ MP fermés — clé: `" + key + "`")
            )
            .setFooter({ text: "Restant: " + getInvitePoints(data, uid) + " invite(s)" })
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
              .setTitle("❌ Pas assez d'invites")
              .setDescription(
                "Il te faut **1** invite.\nTu as: **" + getInvitePoints(data, uid) + "**"
              ),
          ],
        });
      }
      data.spinsBonus[uid] = (data.spinsBonus[uid] || 0) + SPINS_REWARD;
      delete data.spins[uid]; // reset cooldown pour pouvoir spin tout de suite
      saveData(data);
      addLog("inv_claim_spins", interaction.user.tag, "", String(SPINS_REWARD));
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ 2 Spins obtenus !")
            .setDescription(
              "🎟️ -1 invite\n\n🎰 Tu as reçu **2 spins** bonus.\nUtilise `/spin` maintenant !"
            )
            .setFooter({ text: "Restant: " + getInvitePoints(data, uid) + " invite(s)" })
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
              .setTitle("❌ Pas assez d'invites")
              .setDescription(
                "Il te faut **5** invites.\nTu as: **" + getInvitePoints(data, uid) + "**"
              ),
          ],
        });
      }
      const { key, data: kData } = makeKey("1d", 86400, "invite");
      data.keys[key] = kData;
      saveData(data);
      addLog("inv_claim_1d", interaction.user.tag, "", key);
      const dmOk = await sendKeyDM(interaction.user, key, "1d");
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Clé 1 jour obtenue !")
            .setDescription(
              "🎟️ -5 invites\n\n" +
                (dmOk
                  ? "📩 Clé envoyée en **MP** !"
                  : "⚠️ MP fermés — clé: `" + key + "`")
            )
            .setFooter({ text: "Restant: " + getInvitePoints(data, uid) + " invite(s)" })
            .setTimestamp(),
        ],
      });
    }

    return interaction.editReply({ content: "❓ Bouton inconnu." });
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
          .setTitle("⛔ Accès refusé")
          .setDescription(
            "Tu n'as pas la permission.\nTon ID: `" +
              interaction.user.id +
              "`\nAjoute-le dans **BOT_ADMINS** sur Render."
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

    // ─── CREATEKEY ─────────────────────────────────────────
    if (cmd === "createkey") {
      const durationStr = interaction.options.getString("duration");
      const amount = interaction.options.getInteger("amount") || 1;
      const parsed = parseDuration(durationStr);
      if (!parsed) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Durée invalide")
              .setDescription("Exemples: `30m` · `1h` · `1d` · `lifetime`"),
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
            .setTitle("🔑 " + amount + " clé(s) créée(s)")
            .setDescription(
              created.map((k) => "🔑 `" + k + "`").join("\n") +
                "\n\n⏱️ Durée: **" +
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
              .setTitle("❌ Durée invalide")
              .setDescription("Exemples: `30m` · `1h` · `1d` · `lifetime`"),
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
      try {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x00e5ff)
              .setTitle("🎁 Clé LARP TP")
              .setDescription(
                "Tu as reçu une clé !\n\n🔑 `" +
                  key +
                  "`\n⏱️ Durée: **" +
                  durationStr +
                  "**\n\n" +
                  "➡️ En jeu: **My Key → Redeem**\n" +
                  "➡️ Ou utilise `/redeem`"
              )
              .setFooter({ text: "LARP TP" })
              .setTimestamp(),
          ],
        });
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("✅ Clé envoyée")
              .setDescription("MP envoyé à **" + user.tag + "** 🎉"),
          ],
        });
      } catch {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("⚠️ MP impossible")
              .setDescription("Clé: `" + key + "`\nDonne-la manuellement."),
          ],
        });
      }
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
              .setTitle("❌ Clé invalide")
              .setDescription("Cette clé n'existe pas."),
          ],
        });
      }
      if (keyData.used) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("🔒 Clé déjà utilisée")
              .setDescription(
                keyData.robloxUsername
                  ? "Utilisée par **" + keyData.robloxUsername + "**"
                  : "Cette clé a déjà été consommée."
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
              .setTitle("❌ Pas de cumul")
              .setDescription("Ce compte a déjà **lifetime** ♾️"),
          ],
        });
      }
      const now = Math.floor(Date.now() / 1000);
      if (data.whitelist[uname] && data.whitelist[uname] > now) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Pas de cumul")
              .setDescription("Ce compte a déjà du temps restant."),
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
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Clé acceptée !")
            .setDescription(
              "👤 Joueur: **" +
                username +
                "**\n" +
                "⏱️ Accès: **" +
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
              .setTitle("❌ Introuvable")
              .setDescription("Cette clé n'existe pas."),
          ],
        });
      }
      if (keyData.used) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("🔒 Déjà utilisée")
              .setDescription(
                "Par: **" + (keyData.robloxUsername || keyData.usedBy || "?") + "**"
              ),
          ],
        });
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Clé valide")
            .setDescription("⏱️ Durée: **" + keyData.duration + "**"),
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
              .setTitle("❌ Durée invalide")
              .setDescription("Exemples: `1h` · `lifetime`"),
          ],
        });
      }
      applyAccess(data, username, parsed);
      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("➕ Whitelist ajoutée")
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
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("➖ Retiré")
            .setDescription("👤 **" + username + "** n'a plus d'accès."),
        ],
      });
    }

    if (cmd === "info") {
      const username = interaction.options.getString("username").toLowerCase();
      const now = Math.floor(Date.now() / 1000);
      let status = "❌ Aucun accès";
      let color = 0x95a5a6;
      if (data.admins.includes(username)) {
        status = "👑 **ADMIN**";
        color = 0xf1c40f;
      } else if (data.lifetimeWhitelist[username]) {
        status = "♾️ **LIFETIME**";
        color = 0x9b59b6;
      } else if (data.whitelist[username] && data.whitelist[username] > now) {
        const mins = Math.floor((data.whitelist[username] - now) / 60);
        status = "🟢 **WHITELIST** — " + mins + " min restantes";
        color = 0x2ecc71;
      }
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(color)
            .setTitle("👤 Info joueur")
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
            .setTitle("📋 Whitelist LARP TP")
            .addFields(
              {
                name: "♾️ Lifetime (" + life.length + ")",
                value: life.length ? life.map((n) => "• " + n).join("\n") : "_aucun_",
                inline: false,
              },
              {
                name: "🟢 Actifs (" + active.length + ")",
                value: active.length ? active.map((n) => "• " + n).join("\n") : "_aucun_",
                inline: false,
              }
            )
            .setFooter({ text: "LARP TP" })
            .setTimestamp(),
        ],
      });
    }

    // ─── SPIN ──────────────────────────────────────────────
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
              .setDescription(
                "⏳ Tu as déjà tourné aujourd'hui !\n\n" +
                  "Reviens dans " +
                  timeLeft(left) +
                  "."
              )
              .setFooter({ text: "1 spin gratuit / jour • LARP TP" })
              .setTimestamp(),
          ],
        });
      }

      if (onCooldown && bonus > 0) {
        consumeBonus(data, "spin", uid);
      } else {
        data.spins[uid] = now;
      }

      const win = Math.random() < 0.15;
      const roll = Math.floor(Math.random() * 100) + 1;
      const remaining = getBonus(data, "spin", uid);

      if (win) {
        const { key, data: kData } = makeKey1h("spin");
        data.keys[key] = kData;
        saveData(data);
        const dmOk = await sendKeyDM(interaction.user, key, "1h");
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🎰 SPIN — 🎉 GAGNÉ !")
              .setDescription(
                spinVisual(roll, true) +
                  "\n\n" +
                  (dmOk
                    ? "📩 Clé **1h** envoyée en **MP** !"
                    : "⚠️ MP fermés — clé: `" + key + "`")
              )
              .setFooter({
                text: "Bonus restants: " + remaining + " • 1 spin / jour",
              })
              .setTimestamp(),
          ],
        });
      }

      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x7f8c8d)
            .setTitle("🎰 SPIN — Raté")
            .setDescription(
              spinVisual(roll, false) + "\n\nReviens demain pour un nouveau tour 🍀"
            )
            .setFooter({
              text: "Bonus restants: " + remaining + " • 1 spin / jour",
            })
            .setTimestamp(),
        ],
      });
    }

    // ─── DICE ──────────────────────────────────────────────
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
              .setDescription(
                "⏳ Tu as déjà joué aujourd'hui !\n\n" +
                  "Reviens dans " +
                  timeLeft(left) +
                  "."
              )
              .setFooter({ text: "1 dice gratuit / jour • LARP TP" })
              .setTimestamp(),
          ],
        });
      }

      if (onCooldown && bonus > 0) {
        consumeBonus(data, "dice", uid);
      } else {
        data.dice[uid] = now;
      }

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
        const dmOk = await sendKeyDM(interaction.user, key, "1h");
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🎲 DICE — 🎉 GAGNÉ !")
              .setDescription(
                diceVisual(pickObj.emoji, pick, rolledEmojis, true) +
                  "\n\n" +
                  (dmOk
                    ? "📩 Clé **1h** envoyée en **MP** !"
                    : "⚠️ MP fermés — clé: `" + key + "`")
              )
              .setFooter({
                text: "Bonus restants: " + remaining + " • 1 dice / jour",
              })
              .setTimestamp(),
          ],
        });
      }

      saveData(data);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("🎲 DICE — Perdu")
            .setDescription(diceVisual(pickObj.emoji, pick, rolledEmojis, false))
            .setFooter({
              text: "Bonus restants: " + remaining + " • 1 dice / jour",
            })
            .setTimestamp(),
        ],
      });
    }

    // ─── RESET / GIVE SPIN DICE ────────────────────────────
    if (cmd === "resetspin") {
      const user = interaction.options.getUser("user");
      const all = interaction.options.getBoolean("all");
      if (all) {
        data.spins = {};
        saveData(data);
        addLog("resetspin", interaction.user.tag, "ALL", "");
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x3498db)
              .setTitle("🔄 Reset Spin")
              .setDescription("Cooldown **spin** reset pour **tout le monde** ✅"),
          ],
        });
      }
      if (!user) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Argument manquant")
              .setDescription("Précise un `user` **ou** mets `all: True`."),
          ],
        });
      }
      delete data.spins[user.id];
      saveData(data);
      addLog("resetspin", interaction.user.tag, user.tag, "");
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("🔄 Reset Spin")
            .setDescription("Cooldown **spin** reset pour **" + user.tag + "** ✅"),
        ],
      });
    }

    if (cmd === "resetdice") {
      const user = interaction.options.getUser("user");
      const all = interaction.options.getBoolean("all");
      if (all) {
        data.dice = {};
        saveData(data);
        addLog("resetdice", interaction.user.tag, "ALL", "");
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x3498db)
              .setTitle("🔄 Reset Dice")
              .setDescription("Cooldown **dice** reset pour **tout le monde** ✅"),
          ],
        });
      }
      if (!user) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("❌ Argument manquant")
              .setDescription("Précise un `user` **ou** mets `all: True`."),
          ],
        });
      }
      delete data.dice[user.id];
      saveData(data);
      addLog("resetdice", interaction.user.tag, user.tag, "");
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("🔄 Reset Dice")
            .setDescription("Cooldown **dice** reset pour **" + user.tag + "** ✅"),
        ],
      });
    }

    if (cmd === "giveallspin") {
      const amount = interaction.options.getInteger("amount") || 1;
      data.spins = {};
      data.globalSpinBonus = (data.globalSpinBonus || 0) + amount;
      saveData(data);
      addLog("giveallspin", interaction.user.tag, "ALL", String(amount));
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🎁 Give All Spin")
            .setDescription(
              "✅ Cooldown **spin** reset pour tout le monde\n" +
                "🎁 **+" +
                amount +
                "** spin(s) bonus global(aux)\n\n" +
                "Tout le monde peut rejouer maintenant !"
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
      addLog("givealldice", interaction.user.tag, "ALL", String(amount));
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🎁 Give All Dice")
            .setDescription(
              "✅ Cooldown **dice** reset pour tout le monde\n" +
                "🎁 **+" +
                amount +
                "** dice bonus global(aux)\n\n" +
                "Tout le monde peut rejouer maintenant !"
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
      addLog("givespin", interaction.user.tag, user.tag, String(amount));
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🎁 Spin donné")
            .setDescription(
              "**" + amount + "** spin(s) → **" + user.tag + "**\nCooldown reset ✅"
            ),
        ],
      });
    }

    if (cmd === "givedice") {
      const user = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount") || 1;
      data.diceBonus[user.id] = (data.diceBonus[user.id] || 0) + amount;
      delete data.dice[user.id];
      saveData(data);
      addLog("givedice", interaction.user.tag, user.tag, String(amount));
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("🎁 Dice donné")
            .setDescription(
              "**" + amount + "** dice → **" + user.tag + "**\nCooldown reset ✅"
            ),
        ],
      });
    }

    // ─── INVITES COMMANDS ──────────────────────────────────
    if (cmd === "invites") {
      const uid = interaction.user.id;
      const pts = getInvitePoints(data, uid);
      const used = data.invitesUsed[uid] || 0;
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle("🎟️ Tes invites")
            .setDescription(
              "Points disponibles: **" +
                pts +
                "**\n" +
                "Déjà dépensés: **" +
                used +
                "**\n\n" +
                "Échange via le **panel** du salon ou les boutons."
            )
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "invitepanel") {
      // Message public (pas ephemeral) qui reste dans le salon
      try {
        await interaction.deleteReply().catch(() => {});
      } catch (_) {}
      await interaction.channel.send({
        embeds: [buildInvitePanelEmbed()],
        components: [buildInvitePanelButtons()],
      });
      // confirmation éphémère si possible
      try {
        await interaction.followUp({
          content: "✅ Panel invites posté dans ce salon.",
          ephemeral: true,
        });
      } catch (_) {}
      addLog("invitepanel", interaction.user.tag, interaction.channelId, "");
      return;
    }

    if (cmd === "addinvites") {
      const user = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount");
      addInvitePoints(data, user.id, amount);
      saveData(data);
      addLog("addinvites", interaction.user.tag, user.tag, String(amount));
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("➕ Invites ajoutées")
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
      addLog("setinvites", interaction.user.tag, user.tag, String(amount));
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("✏️ Invites définies")
            .setDescription("**" + user.tag + "** → **" + amount + "** point(s)"),
        ],
      });
    }

    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle("❓ Commande inconnue")],
    });
  } catch (err) {
    console.error("[ERR]", cmd, err);
    try {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("❌ Erreur")
            .setDescription("`" + (err.message || "server") + "`"),
        ],
      });
    } catch (_) {}
  }
});

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("[BOT] Commandes enregistrées.");
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
