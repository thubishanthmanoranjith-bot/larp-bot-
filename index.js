/**
 * LARP TP - Discord Bot + API
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

// Dossier writable (Render free)
const DATA_DIR = process.env.DATA_DIR || "/tmp";
const DATA_FILE = path.join(DATA_DIR, "larp-data.json");
const LOCAL_FALLBACK = path.join(__dirname, "data.json");

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

const commands = [
  new SlashCommandBuilder()
    .setName("createkey")
    .setDescription("Creer une cle LARP TP")
    .addStringOption((o) =>
      o.setName("duration").setDescription("30m / 1h / 1d / lifetime").setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Nombre de cles (1-20)").setMinValue(1).setMaxValue(20)
    ),
  new SlashCommandBuilder()
    .setName("givekey")
    .setDescription("Creer une cle et lenvoyer en MP")
    .addUserOption((o) => o.setName("user").setDescription("Membre").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("30m / 1h / 1d / lifetime").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("redeem")
    .setDescription("Utiliser une cle")
    .addStringOption((o) => o.setName("key").setDescription("Cle LARP-XXXX").setRequired(true))
    .addStringOption((o) =>
      o.setName("username").setDescription("Pseudo Roblox").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("checkkey")
    .setDescription("Verifier une cle")
    .addStringOption((o) => o.setName("key").setDescription("Cle").setRequired(true)),
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Whitelist sans cle")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("1h / lifetime").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Retirer whitelist")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true)),
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("Info joueur")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true)),
  new SlashCommandBuilder().setName("list").setDescription("Liste whitelist"),
  new SlashCommandBuilder()
    .setName("spin")
    .setDescription("Tour quotidien — chance de gagner une cle 1h (1 fois / jour)"),
  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("Choisis une couleur — si ca match, tu gagnes une cle 1h")
    .addStringOption((o) =>
      o
        .setName("color")
        .setDescription("Ta couleur")
        .setRequired(true)
        .addChoices(
          { name: "Red", value: "Red" },
          { name: "Orange", value: "Orange" },
          { name: "Yellow", value: "Yellow" },
          { name: "Green", value: "Green" },
          { name: "Blue", value: "Blue" },
          { name: "Purple", value: "Purple" }
        )
    ),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", () => {
  console.log("[BOT] Connecte:", client.user.tag);
  console.log("[BOT] Admins Discord IDs:", BOT_ADMINS.join(", ") || "(aucun)");
});
// compat anciennes versions discord.js
client.once("ready", () => {
  console.log("[BOT] Connecte (ready):", client.user.tag);
  console.log("[BOT] Admins Discord IDs:", BOT_ADMINS.join(", ") || "(aucun)");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  console.log("[CMD]", cmd, "by", interaction.user.id, interaction.user.tag);

  // spin/dice = public (tout le monde voit), reste = ephemeral
  const publicVisible = ["spin", "dice"];
  try {
    await interaction.deferReply({ ephemeral: !publicVisible.includes(cmd) });
  } catch (e) {
    console.error("defer failed", e);
    return;
  }

  const publicCmds = ["redeem", "checkkey", "info", "spin", "dice"];
  const needsAdmin = !publicCmds.includes(cmd);

  if (needsAdmin && !isBotAdmin(interaction.user.id)) {
    return interaction.editReply({
      content:
        "Permission refusee. Ton ID: `" +
        interaction.user.id +
        "` — ajoute-le dans BOT_ADMINS sur Render.",
    });
  }

  try {
    const data = loadData();

    if (cmd === "createkey") {
      const durationStr = interaction.options.getString("duration");
      const amount = interaction.options.getInteger("amount") || 1;
      const parsed = parseDuration(durationStr);
      if (!parsed) {
        return interaction.editReply({ content: "Duree invalide. Ex: 30m, 1h, 1d, lifetime" });
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
            .setTitle(amount + " cle(s) creee(s)")
            .setDescription(created.map((k) => "`" + k + "`").join("\n") + "\n\nDuree: **" + durationStr + "**")
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "givekey") {
      const user = interaction.options.getUser("user");
      const durationStr = interaction.options.getString("duration");
      const parsed = parseDuration(durationStr);
      if (!parsed) return interaction.editReply({ content: "Duree invalide." });
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
              .setTitle("Cle LARP TP")
              .setDescription(
                "`" +
                  key +
                  "`\nDuree: **" +
                  durationStr +
                  "**\n\nEn jeu: My Key → Redeem\nOu `/redeem`"
              ),
          ],
        });
        return interaction.editReply({ content: "Cle envoyee en MP a **" + user.tag + "**." });
      } catch {
        return interaction.editReply({
          content: "MP impossible. Cle: `" + key + "`",
        });
      }
    }

    if (cmd === "redeem") {
      const keyInput = interaction.options.getString("key").trim().toUpperCase();
      const username = interaction.options.getString("username").trim();
      const keyData = data.keys[keyInput];
      if (!keyData) {
        return interaction.editReply({ content: "Cle invalide." });
      }
      if (keyData.used) {
        return interaction.editReply({
          content: "Cle deja utilisee" + (keyData.robloxUsername ? " par **" + keyData.robloxUsername + "**." : "."),
        });
      }
      const uname = username.toLowerCase();
      // pas de cumul
      if (data.lifetimeWhitelist[uname]) {
        return interaction.editReply({ content: "Ce compte a deja lifetime. Pas de cumul." });
      }
      const now = Math.floor(Date.now() / 1000);
      if (data.whitelist[uname] && data.whitelist[uname] > now) {
        return interaction.editReply({ content: "Ce compte a deja du temps. Pas de cumul." });
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
        content:
          "Cle acceptee pour **" +
          username +
          "** — " +
          (keyData.lifetime ? "LIFETIME" : keyData.duration),
      });
    }

    if (cmd === "checkkey") {
      const keyInput = interaction.options.getString("key").trim().toUpperCase();
      const keyData = data.keys[keyInput];
      if (!keyData) return interaction.editReply({ content: "Cle introuvable." });
      if (keyData.used) {
        return interaction.editReply({
          content: "Deja utilisee — " + (keyData.robloxUsername || keyData.usedBy || "?"),
        });
      }
      return interaction.editReply({ content: "Valide — duree **" + keyData.duration + "**" });
    }

    if (cmd === "add") {
      const username = interaction.options.getString("username").toLowerCase();
      const durationStr = interaction.options.getString("duration");
      const parsed = parseDuration(durationStr);
      if (!parsed) return interaction.editReply({ content: "Duree invalide." });
      applyAccess(data, username, parsed);
      saveData(data);
      return interaction.editReply({ content: "**" + username + "** → **" + durationStr + "**" });
    }

    if (cmd === "remove") {
      const username = interaction.options.getString("username").toLowerCase();
      delete data.whitelist[username];
      delete data.pausedWhitelist[username];
      delete data.lifetimeWhitelist[username];
      saveData(data);
      return interaction.editReply({ content: "**" + username + "** retire." });
    }

    if (cmd === "info") {
      const username = interaction.options.getString("username").toLowerCase();
      const now = Math.floor(Date.now() / 1000);
      let status = "Aucun acces";
      if (data.admins.includes(username)) status = "ADMIN";
      else if (data.lifetimeWhitelist[username]) status = "LIFETIME";
      else if (data.whitelist[username] && data.whitelist[username] > now)
        status = "WHITELIST (" + Math.floor((data.whitelist[username] - now) / 60) + "m)";
      return interaction.editReply({ content: "**" + username + "** — " + status });
    }

    if (cmd === "list") {
      const now = Math.floor(Date.now() / 1000);
      const life = Object.keys(data.lifetimeWhitelist).join(", ") || "aucun";
      const active = [];
      for (const [n, exp] of Object.entries(data.whitelist)) {
        if (exp > now) active.push(n);
      }
      return interaction.editReply({
        content: "Lifetime: " + life + "\nActifs: " + (active.join(", ") || "aucun"),
      });
    }


    if (cmd === "spin") {
      const uid = interaction.user.id;
      const mention = "<@" + uid + ">";
      data.spins = data.spins || {};
      const now = Date.now();
      const last = data.spins[uid] || 0;
      const dayMs = 24 * 60 * 60 * 1000;
      if (now - last < dayMs) {
        const left = dayMs - (now - last);
        const h = Math.ceil(left / 3600000);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xee6767)
              .setTitle("Casino Wheel Spin")
              .setDescription(
                mention +
                  " a deja tourne aujourd hui.\\nReviens dans ~**" +
                  h +
                  "h**."
              ),
          ],
        });
      }

      // Animation roulette (public)
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
              .setTitle("Casino Wheel Spin")
              .setDescription(
                mention +
                  " is spinning the wheel...\n\n`" +
                  frames[i] +
                  "`"
              ),
          ],
        });
        await new Promise((r) => setTimeout(r, 350));
      }

      data.spins[uid] = now;
      // Poids: 0h 70%, 1h 20%, 3h 8%, 6h 2%
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

      let keyLine = "";
      if (prizeHours > 0) {
        const key = generateKey();
        data.keys[key] = {
          duration: prizeHours + "h",
          lifetime: false,
          seconds: prizeHours * 3600,
          durationSeconds: prizeHours * 3600,
          used: false,
          usedBy: null,
          createdBy: "spin",
          createdAt: new Date().toISOString(),
        };
        keyLine =
          "\n\nCle : `" +
          key +
          "`\nUtilise `/redeem` ou **Code d echange** en jeu.";
      }
      saveData(data);
      addLog("spin", interaction.user.tag, "", prizeLabel);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(prizeHours > 0 ? 0x50e6a0 : 0xe74c3c)
            .setTitle("Casino Wheel Spin")
            .setDescription(
              "**The wheel stopped!**\n\n" +
                "💀 You got: **" +
                prizeLabel +
                "**" +
                keyLine +
                "\n\nBetter luck tomorrow, " +
                mention +
                "!"
            )
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "dice") {
      const uid = interaction.user.id;
      const mention = "<@" + uid + ">";
      data.dice = data.dice || {};
      const now = Date.now();
      const last = data.dice[uid] || 0;
      const dayMs = 24 * 60 * 60 * 1000;
      if (now - last < dayMs) {
        const h = Math.ceil((dayMs - (now - last)) / 3600000);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xee6767)
              .setTitle("Dice Roll")
              .setDescription(mention + " a deja joue aujourd hui.\nReviens dans ~**" + h + "h**."),
          ],
        });
      }

      const COLORS = ["Red", "Orange", "Yellow", "Green", "Blue", "Purple"];
      const EMOJI = {
        Red: "🔴",
        Orange: "🟠",
        Yellow: "🟡",
        Green: "🟢",
        Blue: "🔵",
        Purple: "🟣",
      };
      const pick = interaction.options.getString("color");
      if (!COLORS.includes(pick)) {
        return interaction.editReply({ content: "Couleur invalide." });
      }

      // Animation publique
      for (let i = 0; i < 6; i++) {
        const flash = COLORS[i % COLORS.length];
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf1c40f)
              .setTitle("Dice Roll")
              .setDescription(
                mention +
                  " lance le de...\n\n" +
                  EMOJI[flash] +
                  " **" +
                  flash +
                  "**"
              ),
          ],
        });
        await new Promise((r) => setTimeout(r, 300));
      }

      data.dice[uid] = now;
      const rolled = COLORS[Math.floor(Math.random() * COLORS.length)];
      const match = pick === rolled;
      let keyLine = "";
      if (match) {
        const key = generateKey();
        data.keys[key] = {
          duration: "1h",
          lifetime: false,
          seconds: 3600,
          durationSeconds: 3600,
          used: false,
          usedBy: null,
          createdBy: "dice",
          createdAt: new Date().toISOString(),
        };
        keyLine =
          "\n\nMatch ! Cle **1h** : `" +
          key +
          "`\nUtilise `/redeem` ou **Code d echange** en jeu.";
      } else {
        keyLine = "\n\nPas de match. Better luck tomorrow!";
      }
      saveData(data);
      addLog("dice", interaction.user.tag, "", pick + " vs " + rolled);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(match ? 0x50e6a0 : 0xe74c3c)
            .setTitle("Dice Roll")
            .setDescription(
              mention +
                " a choisi **" +
                EMOJI[pick] +
                " " +
                pick +
                "**\nLe de affiche **" +
                EMOJI[rolled] +
                " " +
                rolled +
                "**" +
                keyLine
            )
            .setTimestamp(),
        ],
      });
    }



    return interaction.editReply({ content: "Commande inconnue." });
  } catch (err) {
    console.error("[ERR]", cmd, err);
    try {
      await interaction.editReply({ content: "Erreur: " + (err.message || "server") });
    } catch (_) {}
  }
});

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("[BOT] Commandes enregistrees.");
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

app.listen(PORT, () => console.log("[API] Port", PORT));/**
 * LARP TP - Discord Bot + API
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

// Dossier writable (Render free)
const DATA_DIR = process.env.DATA_DIR || "/tmp";
const DATA_FILE = path.join(DATA_DIR, "larp-data.json");
const LOCAL_FALLBACK = path.join(__dirname, "data.json");

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

const commands = [
  new SlashCommandBuilder()
    .setName("createkey")
    .setDescription("Creer une cle LARP TP")
    .addStringOption((o) =>
      o.setName("duration").setDescription("30m / 1h / 1d / lifetime").setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Nombre de cles (1-20)").setMinValue(1).setMaxValue(20)
    ),
  new SlashCommandBuilder()
    .setName("givekey")
    .setDescription("Creer une cle et lenvoyer en MP")
    .addUserOption((o) => o.setName("user").setDescription("Membre").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("30m / 1h / 1d / lifetime").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("redeem")
    .setDescription("Utiliser une cle")
    .addStringOption((o) => o.setName("key").setDescription("Cle LARP-XXXX").setRequired(true))
    .addStringOption((o) =>
      o.setName("username").setDescription("Pseudo Roblox").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("checkkey")
    .setDescription("Verifier une cle")
    .addStringOption((o) => o.setName("key").setDescription("Cle").setRequired(true)),
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Whitelist sans cle")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("1h / lifetime").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Retirer whitelist")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true)),
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("Info joueur")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true)),
  new SlashCommandBuilder().setName("list").setDescription("Liste whitelist"),
  new SlashCommandBuilder()
    .setName("spin")
    .setDescription("Tour quotidien — chance de gagner une cle 1h (1 fois / jour)"),
  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("Choisis une couleur — si ca match, tu gagnes une cle 1h")
    .addStringOption((o) =>
      o
        .setName("color")
        .setDescription("Ta couleur")
        .setRequired(true)
        .addChoices(
          { name: "Red", value: "Red" },
          { name: "Orange", value: "Orange" },
          { name: "Yellow", value: "Yellow" },
          { name: "Green", value: "Green" },
          { name: "Blue", value: "Blue" },
          { name: "Purple", value: "Purple" }
        )
    ),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", () => {
  console.log("[BOT] Connecte:", client.user.tag);
  console.log("[BOT] Admins Discord IDs:", BOT_ADMINS.join(", ") || "(aucun)");
});
// compat anciennes versions discord.js
client.once("ready", () => {
  console.log("[BOT] Connecte (ready):", client.user.tag);
  console.log("[BOT] Admins Discord IDs:", BOT_ADMINS.join(", ") || "(aucun)");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  console.log("[CMD]", cmd, "by", interaction.user.id, interaction.user.tag);

  // spin/dice = public (tout le monde voit), reste = ephemeral
  const publicVisible = ["spin", "dice"];
  try {
    await interaction.deferReply({ ephemeral: !publicVisible.includes(cmd) });
  } catch (e) {
    console.error("defer failed", e);
    return;
  }

  const publicCmds = ["redeem", "checkkey", "info", "spin", "dice"];
  const needsAdmin = !publicCmds.includes(cmd);

  if (needsAdmin && !isBotAdmin(interaction.user.id)) {
    return interaction.editReply({
      content:
        "Permission refusee. Ton ID: `" +
        interaction.user.id +
        "` — ajoute-le dans BOT_ADMINS sur Render.",
    });
  }

  try {
    const data = loadData();

    if (cmd === "createkey") {
      const durationStr = interaction.options.getString("duration");
      const amount = interaction.options.getInteger("amount") || 1;
      const parsed = parseDuration(durationStr);
      if (!parsed) {
        return interaction.editReply({ content: "Duree invalide. Ex: 30m, 1h, 1d, lifetime" });
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
            .setTitle(amount + " cle(s) creee(s)")
            .setDescription(created.map((k) => "`" + k + "`").join("\n") + "\n\nDuree: **" + durationStr + "**")
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "givekey") {
      const user = interaction.options.getUser("user");
      const durationStr = interaction.options.getString("duration");
      const parsed = parseDuration(durationStr);
      if (!parsed) return interaction.editReply({ content: "Duree invalide." });
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
              .setTitle("Cle LARP TP")
              .setDescription(
                "`" +
                  key +
                  "`\nDuree: **" +
                  durationStr +
                  "**\n\nEn jeu: My Key → Redeem\nOu `/redeem`"
              ),
          ],
        });
        return interaction.editReply({ content: "Cle envoyee en MP a **" + user.tag + "**." });
      } catch {
        return interaction.editReply({
          content: "MP impossible. Cle: `" + key + "`",
        });
      }
    }

    if (cmd === "redeem") {
      const keyInput = interaction.options.getString("key").trim().toUpperCase();
      const username = interaction.options.getString("username").trim();
      const keyData = data.keys[keyInput];
      if (!keyData) {
        return interaction.editReply({ content: "Cle invalide." });
      }
      if (keyData.used) {
        return interaction.editReply({
          content: "Cle deja utilisee" + (keyData.robloxUsername ? " par **" + keyData.robloxUsername + "**." : "."),
        });
      }
      const uname = username.toLowerCase();
      // pas de cumul
      if (data.lifetimeWhitelist[uname]) {
        return interaction.editReply({ content: "Ce compte a deja lifetime. Pas de cumul." });
      }
      const now = Math.floor(Date.now() / 1000);
      if (data.whitelist[uname] && data.whitelist[uname] > now) {
        return interaction.editReply({ content: "Ce compte a deja du temps. Pas de cumul." });
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
        content:
          "Cle acceptee pour **" +
          username +
          "** — " +
          (keyData.lifetime ? "LIFETIME" : keyData.duration),
      });
    }

    if (cmd === "checkkey") {
      const keyInput = interaction.options.getString("key").trim().toUpperCase();
      const keyData = data.keys[keyInput];
      if (!keyData) return interaction.editReply({ content: "Cle introuvable." });
      if (keyData.used) {
        return interaction.editReply({
          content: "Deja utilisee — " + (keyData.robloxUsername || keyData.usedBy || "?"),
        });
      }
      return interaction.editReply({ content: "Valide — duree **" + keyData.duration + "**" });
    }

    if (cmd === "add") {
      const username = interaction.options.getString("username").toLowerCase();
      const durationStr = interaction.options.getString("duration");
      const parsed = parseDuration(durationStr);
      if (!parsed) return interaction.editReply({ content: "Duree invalide." });
      applyAccess(data, username, parsed);
      saveData(data);
      return interaction.editReply({ content: "**" + username + "** → **" + durationStr + "**" });
    }

    if (cmd === "remove") {
      const username = interaction.options.getString("username").toLowerCase();
      delete data.whitelist[username];
      delete data.pausedWhitelist[username];
      delete data.lifetimeWhitelist[username];
      saveData(data);
      return interaction.editReply({ content: "**" + username + "** retire." });
    }

    if (cmd === "info") {
      const username = interaction.options.getString("username").toLowerCase();
      const now = Math.floor(Date.now() / 1000);
      let status = "Aucun acces";
      if (data.admins.includes(username)) status = "ADMIN";
      else if (data.lifetimeWhitelist[username]) status = "LIFETIME";
      else if (data.whitelist[username] && data.whitelist[username] > now)
        status = "WHITELIST (" + Math.floor((data.whitelist[username] - now) / 60) + "m)";
      return interaction.editReply({ content: "**" + username + "** — " + status });
    }

    if (cmd === "list") {
      const now = Math.floor(Date.now() / 1000);
      const life = Object.keys(data.lifetimeWhitelist).join(", ") || "aucun";
      const active = [];
      for (const [n, exp] of Object.entries(data.whitelist)) {
        if (exp > now) active.push(n);
      }
      return interaction.editReply({
        content: "Lifetime: " + life + "\nActifs: " + (active.join(", ") || "aucun"),
      });
    }


    if (cmd === "spin") {
      const uid = interaction.user.id;
      const mention = "<@" + uid + ">";
      data.spins = data.spins || {};
      const now = Date.now();
      const last = data.spins[uid] || 0;
      const dayMs = 24 * 60 * 60 * 1000;
      if (now - last < dayMs) {
        const left = dayMs - (now - last);
        const h = Math.ceil(left / 3600000);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xee6767)
              .setTitle("Casino Wheel Spin")
              .setDescription(
                mention +
                  " a deja tourne aujourd hui.\\nReviens dans ~**" +
                  h +
                  "h**."
              ),
          ],
        });
      }

      // Animation roulette (public)
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
              .setTitle("Casino Wheel Spin")
              .setDescription(
                mention +
                  " is spinning the wheel...\n\n`" +
                  frames[i] +
                  "`"
              ),
          ],
        });
        await new Promise((r) => setTimeout(r, 350));
      }

      data.spins[uid] = now;
      // Poids: 0h 70%, 1h 20%, 3h 8%, 6h 2%
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

      let keyLine = "";
      if (prizeHours > 0) {
        const key = generateKey();
        data.keys[key] = {
          duration: prizeHours + "h",
          lifetime: false,
          seconds: prizeHours * 3600,
          durationSeconds: prizeHours * 3600,
          used: false,
          usedBy: null,
          createdBy: "spin",
          createdAt: new Date().toISOString(),
        };
        keyLine =
          "\n\nCle : `" +
          key +
          "`\nUtilise `/redeem` ou **Code d echange** en jeu.";
      }
      saveData(data);
      addLog("spin", interaction.user.tag, "", prizeLabel);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(prizeHours > 0 ? 0x50e6a0 : 0xe74c3c)
            .setTitle("Casino Wheel Spin")
            .setDescription(
              "**The wheel stopped!**\n\n" +
                "💀 You got: **" +
                prizeLabel +
                "**" +
                keyLine +
                "\n\nBetter luck tomorrow, " +
                mention +
                "!"
            )
            .setTimestamp(),
        ],
      });
    }

    if (cmd === "dice") {
      const uid = interaction.user.id;
      const mention = "<@" + uid + ">";
      data.dice = data.dice || {};
      const now = Date.now();
      const last = data.dice[uid] || 0;
      const dayMs = 24 * 60 * 60 * 1000;
      if (now - last < dayMs) {
        const h = Math.ceil((dayMs - (now - last)) / 3600000);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xee6767)
              .setTitle("Dice Roll")
              .setDescription(mention + " a deja joue aujourd hui.\nReviens dans ~**" + h + "h**."),
          ],
        });
      }

      const COLORS = ["Red", "Orange", "Yellow", "Green", "Blue", "Purple"];
      const EMOJI = {
        Red: "🔴",
        Orange: "🟠",
        Yellow: "🟡",
        Green: "🟢",
        Blue: "🔵",
        Purple: "🟣",
      };
      const pick = interaction.options.getString("color");
      if (!COLORS.includes(pick)) {
        return interaction.editReply({ content: "Couleur invalide." });
      }

      // Animation publique
      for (let i = 0; i < 6; i++) {
        const flash = COLORS[i % COLORS.length];
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf1c40f)
              .setTitle("Dice Roll")
              .setDescription(
                mention +
                  " lance le de...\n\n" +
                  EMOJI[flash] +
                  " **" +
                  flash +
                  "**"
              ),
          ],
        });
        await new Promise((r) => setTimeout(r, 300));
      }

      data.dice[uid] = now;
      const rolled = COLORS[Math.floor(Math.random() * COLORS.length)];
      const match = pick === rolled;
      let keyLine = "";
      if (match) {
        const key = generateKey();
        data.keys[key] = {
          duration: "1h",
          lifetime: false,
          seconds: 3600,
          durationSeconds: 3600,
          used: false,
          usedBy: null,
          createdBy: "dice",
          createdAt: new Date().toISOString(),
        };
        keyLine =
          "\n\nMatch ! Cle **1h** : `" +
          key +
          "`\nUtilise `/redeem` ou **Code d echange** en jeu.";
      } else {
        keyLine = "\n\nPas de match. Better luck tomorrow!";
      }
      saveData(data);
      addLog("dice", interaction.user.tag, "", pick + " vs " + rolled);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(match ? 0x50e6a0 : 0xe74c3c)
            .setTitle("Dice Roll")
            .setDescription(
              mention +
                " a choisi **" +
                EMOJI[pick] +
                " " +
                pick +
                "**\nLe de affiche **" +
                EMOJI[rolled] +
                " " +
                rolled +
                "**" +
                keyLine
            )
            .setTimestamp(),
        ],
      });
    }



    return interaction.editReply({ content: "Commande inconnue." });
  } catch (err) {
    console.error("[ERR]", cmd, err);
    try {
      await interaction.editReply({ content: "Erreur: " + (err.message || "server") });
    } catch (_) {}
  }
});

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("[BOT] Commandes enregistrees.");
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
