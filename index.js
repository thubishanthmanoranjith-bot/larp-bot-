/**
 * MEOWL TP - Discord Bot + API (version clés complète)
 * Commandes: clés, whitelist, admins, redeem, check, givekey, etc.
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

const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    d.keys = d.keys || {};
    d.invites = d.invites || {};
    d.admins = d.admins || ["narutosde2p"];
    d.whitelist = d.whitelist || {};
    d.pausedWhitelist = d.pausedWhitelist || {};
    d.lifetimeWhitelist = d.lifetimeWhitelist || {};
    d.logs = d.logs || [];
    return d;
  } catch {
    return {
      admins: ["narutosde2p"],
      whitelist: {},
      pausedWhitelist: {},
      lifetimeWhitelist: {},
      keys: {},
      invites: {},
      logs: [],
    };
  }
}

function saveData(data) {
  if (data.logs && data.logs.length > 150) data.logs = data.logs.slice(-150);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function addLog(action, by, target, details) {
  const data = loadData();
  data.logs.push({
    at: new Date().toISOString(),
    action,
    by,
    target: target || "",
    details: details || "",
  });
  saveData(data);
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

function formatTime(seconds) {
  if (!seconds || seconds <= 0) return "0m";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
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
  if (parsed.lifetime) {
    data.lifetimeWhitelist[key] = true;
  } else {
    data.whitelist[key] = Math.floor(Date.now() / 1000) + parsed.seconds;
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName("createkey")
    .setDescription("Creer une cle MEOWL TP")
    .addStringOption((o) =>
      o.setName("duration").setDescription("30m / 1h / 1d / 1mo / lifetime").setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Nombre de cles (1-20)").setMinValue(1).setMaxValue(20)
    )
    .addStringOption((o) => o.setName("note").setDescription("Note interne (optionnel)")),
  new SlashCommandBuilder()
    .setName("givekey")
    .setDescription("Creer une cle et l envoyer en MP")
    .addUserOption((o) => o.setName("user").setDescription("Membre Discord").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("30m / 1h / 1d / lifetime").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("redeem")
    .setDescription("Utiliser une cle pour obtenir l acces MEOWL TP")
    .addStringOption((o) =>
      o.setName("key").setDescription("Ta cle (ex: MEOWL-XXXX-XXXX-XXXX)").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("username").setDescription("Ton pseudo Roblox").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("checkkey")
    .setDescription("Verifier si une cle est valide / utilisee")
    .addStringOption((o) => o.setName("key").setDescription("Cle a verifier").setRequired(true)),
  new SlashCommandBuilder()
    .setName("deletekey")
    .setDescription("Supprimer une cle (admin)")
    .addStringOption((o) => o.setName("key").setDescription("Cle a supprimer").setRequired(true)),
  new SlashCommandBuilder().setName("listkeys").setDescription("Lister les cles recentes (admin)"),
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Ajouter un joueur a la whitelist (sans cle)")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("30m / 1h / 1d / lifetime").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Retirer un joueur de la whitelist")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true)),
  new SlashCommandBuilder()
    .setName("addtime")
    .setDescription("Ajouter du temps a un joueur")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true))
    .addStringOption((o) => o.setName("duration").setDescription("Ex: 1h").setRequired(true)),
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("Voir le statut d un joueur Roblox")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true)),
  new SlashCommandBuilder().setName("list").setDescription("Lister whitelist / admins / lifetime"),
  new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Ajouter ou retirer un admin Roblox")
    .addStringOption((o) =>
      o
        .setName("action")
        .setDescription("add ou remove")
        .setRequired(true)
        .addChoices({ name: "add", value: "add" }, { name: "remove", value: "remove" })
    )
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true)),
  new SlashCommandBuilder().setName("logs").setDescription("Voir les 15 derniers logs"),
  new SlashCommandBuilder()
    .setName("usertoid")
    .setDescription("Aide pour trouver un UserId Roblox")
    .addStringOption((o) => o.setName("username").setDescription("Pseudo Roblox").setRequired(true)),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log("[BOT] Connecte: " + client.user.tag);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  const publicCmds = ["redeem", "checkkey", "info", "usertoid"];
  const needsAdmin = !publicCmds.includes(cmd);

  if (needsAdmin && !isBotAdmin(interaction.user.id)) {
    return interaction.reply({
      content: "Tu n as pas la permission d utiliser cette commande.",
      ephemeral: true,
    });
  }

  const data = loadData();

  try {
    if (cmd === "createkey") {
      const durationStr = interaction.options.getString("duration");
      const amount = interaction.options.getInteger("amount") || 1;
      const note = interaction.options.getString("note") || "";
      const parsed = parseDuration(durationStr);
      if (!parsed) {
        return interaction.reply({
          content: "Duree invalide. Ex: 30m, 1h, 1d, lifetime",
          ephemeral: true,
        });
      }
      const created = [];
      for (let i = 0; i < amount; i++) {
        const key = generateKey();
        data.keys[key] = {
          duration: durationStr,
          lifetime: parsed.lifetime,
          seconds: parsed.seconds,
          used: false,
          usedBy: null,
          usedAt: null,
          robloxUsername: null,
          createdBy: interaction.user.tag,
          createdAt: new Date().toISOString(),
          note,
        };
        created.push(key);
      }
      saveData(data);
      addLog("createkey", interaction.user.tag, "", amount + "x " + durationStr);
      const list = created.map((k) => "`" + k + "`").join("\n");
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x7cdea7)
            .setTitle(amount + " cle(s) creee(s)")
            .setDescription(list + "\n\nDuree: **" + durationStr + "**")
            .setFooter({ text: note || "MEOWL TP" })
            .setTimestamp(),
        ],
        ephemeral: true,
      });
    }

    if (cmd === "givekey") {
      const user = interaction.options.getUser("user");
      const durationStr = interaction.options.getString("duration");
      const parsed = parseDuration(durationStr);
      if (!parsed) {
        return interaction.reply({ content: "Duree invalide.", ephemeral: true });
      }
      const key = generateKey();
      data.keys[key] = {
        duration: durationStr,
        lifetime: parsed.lifetime,
        seconds: parsed.seconds,
        used: false,
        usedBy: null,
        usedAt: null,
        robloxUsername: null,
        createdBy: interaction.user.tag,
        createdAt: new Date().toISOString(),
        note: "DM to " + user.tag,
      };
      saveData(data);
      addLog("givekey", interaction.user.tag, user.tag, durationStr);
      try {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf8f6f2)
              .setTitle("Ta cle MEOWL TP")
              .setDescription(
                "Voici ta cle :\n\n`" +
                  key +
                  "`\n\n**Duree:** " +
                  durationStr +
                  "\n\nPour l activer:\n`/redeem key:" +
                  key +
                  " username:TonPseudoRoblox`"
              )
              .setTimestamp(),
          ],
        });
        return interaction.reply({
          content: "Cle envoyee en MP a **" + user.tag + "**.",
          ephemeral: true,
        });
      } catch {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xca8b58)
              .setTitle("MP impossible")
              .setDescription("Impossible d envoyer un MP.\nCle:\n`" + key + "`"),
          ],
          ephemeral: true,
        });
      }
    }

    if (cmd === "redeem") {
      const keyInput = interaction.options.getString("key").trim().toUpperCase();
      const username = interaction.options.getString("username").trim();
      const keyData = data.keys[keyInput];

      if (!keyData) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xee6767)
              .setTitle("Cle invalide")
              .setDescription("Cette cle n existe pas. Verifie que tu l as bien copiee."),
          ],
          ephemeral: true,
        });
      }

      if (keyData.used) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xee6767)
              .setTitle("Cle deja utilisee")
              .setDescription(
                "Cette cle a deja ete utilisee" +
                  (keyData.robloxUsername ? " par **" + keyData.robloxUsername + "**." : ".")
              ),
          ],
          ephemeral: true,
        });
      }

      applyAccess(data, username, {
        lifetime: keyData.lifetime,
        seconds: keyData.seconds,
      });
      keyData.used = true;
      keyData.usedBy = interaction.user.tag;
      keyData.usedAt = new Date().toISOString();
      keyData.robloxUsername = username.toLowerCase();
      saveData(data);
      addLog("redeem", interaction.user.tag, username, keyInput);

      const durText = keyData.lifetime ? "LIFETIME" : keyData.duration;
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x7cdea7)
            .setTitle("Cle acceptee")
            .setDescription(
              "Acces **" +
                durText +
                "** ajoute pour **" +
                username +
                "**.\n\nTu peux rejoindre le jeu et ouvrir le panel (touche **C**)."
            )
            .setTimestamp(),
        ],
        ephemeral: true,
      });
    }

    if (cmd === "checkkey") {
      const keyInput = interaction.options.getString("key").trim().toUpperCase();
      const keyData = data.keys[keyInput];
      if (!keyData) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xee6767)
              .setTitle("Cle introuvable")
              .setDescription("Cette cle n existe pas dans la base."),
          ],
          ephemeral: true,
        });
      }
      if (keyData.used) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xca8b58)
              .setTitle("Cle deja utilisee")
              .addFields(
                { name: "Duree", value: keyData.duration, inline: true },
                {
                  name: "Utilisee par",
                  value: keyData.robloxUsername || keyData.usedBy || "?",
                  inline: true,
                },
                {
                  name: "Date",
                  value: keyData.usedAt ? keyData.usedAt.slice(0, 19) : "?",
                  inline: true,
                }
              ),
          ],
          ephemeral: true,
        });
      }
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x7cdea7)
            .setTitle("Cle valide (non utilisee)")
            .addFields(
              { name: "Duree", value: keyData.duration, inline: true },
              { name: "Creee par", value: keyData.createdBy || "?", inline: true }
            ),
        ],
        ephemeral: true,
      });
    }

    if (cmd === "deletekey") {
      const keyInput = interaction.options.getString("key").trim().toUpperCase();
      if (!data.keys[keyInput]) {
        return interaction.reply({ content: "Cle introuvable.", ephemeral: true });
      }
      delete data.keys[keyInput];
      saveData(data);
      addLog("deletekey", interaction.user.tag, keyInput, "");
      return interaction.reply({
        content: "Cle `" + keyInput + "` supprimee.",
        ephemeral: true,
      });
    }

    if (cmd === "listkeys") {
      const entries = Object.entries(data.keys).slice(-20).reverse();
      if (!entries.length) {
        return interaction.reply({ content: "Aucune cle.", ephemeral: true });
      }
      const lines = entries.map(([k, v]) => {
        const status = v.used ? "used (" + (v.robloxUsername || "?") + ")" : "free";
        return "`" + k + "` — " + v.duration + " — " + status;
      });
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf8f6f2)
            .setTitle("Dernieres cles")
            .setDescription(lines.join("\n"))
            .setTimestamp(),
        ],
        ephemeral: true,
      });
    }

    if (cmd === "add") {
      const username = interaction.options.getString("username").toLowerCase();
      const durationStr = interaction.options.getString("duration");
      const parsed = parseDuration(durationStr);
      if (!parsed) {
        return interaction.reply({ content: "Duree invalide.", ephemeral: true });
      }
      applyAccess(data, username, parsed);
      saveData(data);
      addLog("add", interaction.user.tag, username, durationStr);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x7cdea7)
            .setTitle("Whitelist")
            .setDescription("**" + username + "** → **" + durationStr + "**"),
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
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xee6767)
            .setTitle("Retire")
            .setDescription("**" + username + "** retire de la whitelist."),
        ],
      });
    }

    if (cmd === "addtime") {
      const username = interaction.options.getString("username").toLowerCase();
      const durationStr = interaction.options.getString("duration");
      const parsed = parseDuration(durationStr);
      if (!parsed || parsed.lifetime) {
        return interaction.reply({ content: "Utilise une duree (ex: 1h).", ephemeral: true });
      }
      if (data.lifetimeWhitelist[username]) {
        return interaction.reply({ content: "Deja lifetime.", ephemeral: true });
      }
      const now = Math.floor(Date.now() / 1000);
      if (data.pausedWhitelist[username]) {
        data.pausedWhitelist[username].remaining =
          (data.pausedWhitelist[username].remaining || 0) + parsed.seconds;
      } else {
        const current = data.whitelist[username] || now;
        data.whitelist[username] = Math.max(current, now) + parsed.seconds;
      }
      saveData(data);
      addLog("addtime", interaction.user.tag, username, "+" + durationStr);
      return interaction.reply({
        content: "**+" + durationStr + "** pour **" + username + "**",
      });
    }

    if (cmd === "info") {
      const username = interaction.options.getString("username").toLowerCase();
      const now = Math.floor(Date.now() / 1000);
      let status = "Aucun acces";
      let color = 0xee6767;
      if (data.admins.includes(username)) {
        status = "**ADMIN**";
        color = 0xf8f6f2;
      } else if (data.lifetimeWhitelist[username]) {
        status = "**LIFETIME**";
        color = 0x7cdea7;
      } else if (data.pausedWhitelist[username]) {
        status = "**PAUSED** — " + formatTime(data.pausedWhitelist[username].remaining || 0);
        color = 0xca8b58;
      } else if (data.whitelist[username] && data.whitelist[username] > now) {
        status = "**WHITELIST** — " + formatTime(data.whitelist[username] - now);
        color = 0x7cdea7;
      }
      return interaction.reply({
        embeds: [
          new EmbedBuilder().setColor(color).setTitle("Info — " + username).setDescription(status),
        ],
        ephemeral: true,
      });
    }

    if (cmd === "list") {
      const now = Math.floor(Date.now() / 1000);
      const admins = data.admins.join(", ") || "aucun";
      const lifetime = Object.keys(data.lifetimeWhitelist).join(", ") || "aucun";
      const active = [];
      for (const [name, expiry] of Object.entries(data.whitelist)) {
        if (expiry > now) active.push(name + " (" + formatTime(expiry - now) + ")");
      }
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf8f6f2)
            .setTitle("MEOWL TP")
            .addFields(
              { name: "Admins", value: admins },
              { name: "Lifetime", value: lifetime },
              { name: "Whitelist active", value: active.length ? active.join("\n") : "aucun" }
            ),
        ],
        ephemeral: true,
      });
    }

    if (cmd === "admin") {
      const action = interaction.options.getString("action");
      const username = interaction.options.getString("username").toLowerCase();
      if (action === "add") {
        if (!data.admins.includes(username)) data.admins.push(username);
        saveData(data);
        addLog("admin_add", interaction.user.tag, username, "");
        return interaction.reply({ content: "**" + username + "** est admin." });
      }
      if (username === "narutosde2p") {
        return interaction.reply({
          content: "Impossible de retirer le owner.",
          ephemeral: true,
        });
      }
      data.admins = data.admins.filter((a) => a !== username);
      saveData(data);
      addLog("admin_remove", interaction.user.tag, username, "");
      return interaction.reply({ content: "**" + username + "** n est plus admin." });
    }

    if (cmd === "logs") {
      const recent = (data.logs || []).slice(-15).reverse();
      if (!recent.length) return interaction.reply({ content: "Aucun log.", ephemeral: true });
      const text = recent
        .map((l) => "`" + l.at.slice(0, 16) + "` **" + l.action + "** " + l.target + " " + l.details)
        .join("\n");
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xf8f6f2).setTitle("Logs").setDescription(text)],
        ephemeral: true,
      });
    }

    if (cmd === "usertoid") {
      const username = interaction.options.getString("username");
      return interaction.reply({
        content:
          "Pour **" +
          username +
          "**, regarde l URL du profil Roblox:\nhttps://www.roblox.com/search/users?keyword=" +
          encodeURIComponent(username),
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error(err);
    if (!interaction.replied) {
      interaction.reply({ content: "Erreur serveur.", ephemeral: true }).catch(() => {});
    }
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

app.post("/api/pause", checkSecret, (req, res) => {
  const body = req.body || {};
  const username = body.username;
  const remaining = body.remaining;
  if (!username) return res.status(400).json({ ok: false });
  const data = loadData();
  const key = String(username).toLowerCase();
  delete data.whitelist[key];
  data.pausedWhitelist[key] = {
    remaining: Number(remaining) || 0,
    expiry: Math.floor(Date.now() / 1000) + (Number(remaining) || 0),
  };
  saveData(data);
  res.json({ ok: true });
});

app.post("/api/resume", checkSecret, (req, res) => {
  const body = req.body || {};
  const username = body.username;
  const remaining = body.remaining;
  if (!username) return res.status(400).json({ ok: false });
  const data = loadData();
  const key = String(username).toLowerCase();
  delete data.pausedWhitelist[key];
  data.whitelist[key] = Math.floor(Date.now() / 1000) + (Number(remaining) || 0);
  saveData(data);
  res.json({ ok: true });
});


// ===== KEYS API for Roblox =====
app.get("/api/keys", checkSecret, (req, res) => {
  const data = loadData();
  res.json({ ok: true, keys: data.keys || {} });
});

app.post("/api/keys/use", checkSecret, (req, res) => {
  const body = req.body || {};
  const key = String(body.key || "").toUpperCase().replace(/\s+/g, "");
  const username = String(body.username || "").toLowerCase();
  const data = loadData();
  if (!data.keys[key]) {
    return res.json({ ok: false, error: "unknown key" });
  }
  data.keys[key].used = true;
  data.keys[key].usedBy = username || data.keys[key].usedBy;
  data.keys[key].usedAt = new Date().toISOString();
  data.keys[key].robloxUsername = username;
  saveData(data);
  addLog("redeem_roblox", "roblox", username, key);
  res.json({ ok: true });
});

app.get("/", (req, res) => res.send("LARP TP API running."));


if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Configure DISCORD_TOKEN, CLIENT_ID, GUILD_ID dans .env");
  process.exit(1);
}

registerCommands()
  .then(() => client.login(DISCORD_TOKEN))
  .catch((e) => console.error(e));

app.listen(PORT, () => {
  console.log("[API] Port " + PORT);
});
