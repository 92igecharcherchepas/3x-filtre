require('dotenv').config();
const {
  Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const GREY = 0x808080;
const PM2 = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';

// ───────────────────────── Owners ─────────────────────────
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = '&';
const MAIN_OWNER = (process.env.MAIN_OWNER_ID || '').trim(); // owner principal (toi)
const OWNERS_FILE = path.join(__dirname, 'owners.json');

let owners = new Set();
try { owners = new Set(JSON.parse(fs.readFileSync(OWNERS_FILE, 'utf8'))); } catch { /* premier lancement */ }

const saveOwners = () => fs.writeFileSync(OWNERS_FILE, JSON.stringify([...owners], null, 2));
const isMain = (id) => id === MAIN_OWNER;
const isOwner = (id) => isMain(id) || owners.has(id);

// ───────────────────────── PM2 helpers ─────────────────────────
async function pm2(args) {
  return run(PM2, args, { shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024 });
}

// Liste des bots PM2 (on exclut ce bot-ci pour ne pas se couper la branche)
async function getBots() {
  const { stdout } = await pm2(['jlist']);
  const list = JSON.parse(stdout.slice(stdout.indexOf('[')));
  return list
    .filter((p) => p.pid !== process.pid)
    .map((p) => ({
      name: p.name,
      status: p.pm2_env.status,
      restarts: p.pm2_env.restart_time,
      uptime: p.pm2_env.status === 'online' ? Date.now() - p.pm2_env.pm_uptime : 0,
      mem: p.monit?.memory || 0,
    }));
}

async function restartBot(name) {
  const bots = await getBots();
  if (!bots.some((b) => b.name === name)) throw new Error(`Bot introuvable : \`${name}\``);
  await pm2(['restart', name]); // execFile + nom validé = pas d'injection
}

async function restartAll() {
  const bots = await getBots();
  for (const b of bots) await pm2(['restart', b.name]);
  return bots.map((b) => b.name);
}

// ───────────────────────── UI (Components V2) ─────────────────────────
const fmtUptime = (ms) => {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}j ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};
const statusIcon = (s) => (s === 'online' ? '🟢' : s === 'stopped' ? '🔴' : s === 'errored' ? '🟠' : '⚪');

const sep = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const text = (c) => new TextDisplayBuilder().setContent(c);

function box(...parts) {
  const c = new ContainerBuilder().setAccentColor(GREY);
  parts.forEach((p, i) => {
    if (i) c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(text(p));
  });
  return c;
}

const payload = (container) => ({ components: [container], flags: MessageFlags.IsComponentsV2 });

async function panel() {
  const bots = await getBots();
  if (!bots.length) return payload(box('## 🤖 Gestion des bots', 'Aucun autre bot trouvé dans PM2.'));

  const lines = bots
    .map((b) => `${statusIcon(b.status)} **${b.name}**\n-# ${b.status} • uptime ${fmtUptime(b.uptime)} • ${b.restarts} restart(s) • ${(b.mem / 1024 / 1024).toFixed(0)} Mo`)
    .join('\n\n');

  const c = box('## 🤖 Gestion des bots', lines);
  c.addSeparatorComponents(sep());
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('restart_select')
        .setPlaceholder('Choisis un bot à redémarrer…')
        .addOptions(bots.slice(0, 25).map((b) => ({ label: b.name, value: b.name, description: b.status, emoji: statusIcon(b.status) }))),
    ),
  );
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('refresh').setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('restart_all').setLabel('Tout redémarrer').setEmoji('♻️').setStyle(ButtonStyle.Danger),
    ),
  );
  return payload(c);
}

// ───────────────────────── Bot ─────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const commands = [
  new SlashCommandBuilder().setName('bots').setDescription('Afficher le panneau de gestion des bots'),
  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Redémarrer un bot')
    .addStringOption((o) => o.setName('bot').setDescription('Nom du bot (ou "all")').setAutocomplete(true).setRequired(true)),
].map((c) => c.toJSON());

client.once(Events.ClientReady, async (c) => {
  const rest = new REST().setToken(process.env.TOKEN);
  const route = process.env.GUILD_ID
    ? Routes.applicationGuildCommands(c.user.id, process.env.GUILD_ID)
    : Routes.applicationCommands(c.user.id);
  await rest.put(route, { body: commands });
  console.log(`✅ Connecté en tant que ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    // Autocomplete (pas de check owner nécessaire, ça ne fait que lister)
    if (i.isAutocomplete()) {
      const focused = i.options.getFocused().toLowerCase();
      const names = ['all', ...(await getBots()).map((b) => b.name)];
      return i.respond(names.filter((n) => n.toLowerCase().includes(focused)).slice(0, 25).map((n) => ({ name: n, value: n })));
    }

    // Sécurité : seuls les owners peuvent utiliser le bot
    if (!isOwner(i.user.id)) {
      return i.reply({ ...payload(box('## ⛔ Accès refusé', "Tu n'as pas la permission d'utiliser ce bot.")), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    }

    // /bots
    if (i.isChatInputCommand() && i.commandName === 'bots') {
      await i.deferReply();
      return i.editReply(await panel());
    }

    // /restart
    if (i.isChatInputCommand() && i.commandName === 'restart') {
      await i.deferReply();
      const name = i.options.getString('bot');
      if (name === 'all') {
        const done = await restartAll();
        return i.editReply(payload(box('## ♻️ Redémarrage terminé', done.length ? done.map((n) => `✅ \`${n}\``).join('\n') : 'Aucun bot à redémarrer.')));
      }
      await restartBot(name);
      return i.editReply(payload(box('## ♻️ Redémarrage terminé', `✅ **${name}** a été redémarré.`)));
    }

    // Menu déroulant
    if (i.isStringSelectMenu() && i.customId === 'restart_select') {
      await i.deferUpdate();
      const name = i.values[0];
      await restartBot(name);
      const p = await panel();
      p.components.unshift(box(`✅ **${name}** a été redémarré par <@${i.user.id}>`));
      return i.editReply(p);
    }

    // Boutons
    if (i.isButton() && i.customId === 'refresh') {
      await i.deferUpdate();
      return i.editReply(await panel());
    }
    if (i.isButton() && i.customId === 'restart_all') {
      await i.deferUpdate();
      const done = await restartAll();
      const p = await panel();
      p.components.unshift(box(`♻️ ${done.length} bot(s) redémarré(s) par <@${i.user.id}>`));
      return i.editReply(p);
    }
  } catch (err) {
    console.error(err);
    const msg = payload(box('## ❌ Erreur', `\`\`\`${String(err.message || err).slice(0, 1500)}\`\`\``));
    if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
    else await i.reply({ ...msg, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ───────────────────────── Commandes préfixées (&owner / &unowner) ─────────────────────────
const parseUserId = (arg) => {
  const m = arg?.match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return m ? m[1] || m[2] : null;
};

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !msg.content.startsWith(PREFIX)) return;

  const [cmd, ...args] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const name = cmd?.toLowerCase();
  if (name !== 'owner' && name !== 'unowner') return;

  const reply = (...parts) =>
    msg.reply({ ...payload(box(...parts)), allowedMentions: { parse: [], repliedUser: false } });

  if (!isOwner(msg.author.id)) {
    return reply('## ⛔ Accès refusé', "Tu n'as pas la permission d'utiliser cette commande.");
  }

  // &unowner <@user|id>  ou  &owner remove <@user|id>
  // &owner add <@user|id>
  // &owner list
  const action = name === 'unowner' ? 'remove' : args[0]?.toLowerCase();
  const targetArg = name === 'unowner' ? args[0] : args[1];

  if (action === 'list') {
    const list = [...owners].map((id) => `• <@${id}> \`${id}\``).join('\n') || '*Aucun owner ajouté.*';
    return reply('## 👑 Owners', `**Owner principal**\n<@${MAIN_OWNER}> \`${MAIN_OWNER}\``, `**Owners (${owners.size})**\n${list}`);
  }

  if (action !== 'add' && action !== 'remove') {
    return reply('## ℹ️ Utilisation', `\`${PREFIX}owner add <@user|id>\`\n\`${PREFIX}unowner <@user|id>\`\n\`${PREFIX}owner list\``);
  }

  // Seul l'owner principal peut ajouter / retirer des owners
  if (!isMain(msg.author.id)) {
    return reply('## ⛔ Accès refusé', "Seul l'**owner principal** peut ajouter ou retirer des owners.");
  }

  const id = parseUserId(targetArg);
  if (!id) return reply('## ❌ Utilisateur invalide', 'Mentionne un utilisateur ou donne son ID.');
  if (isMain(id)) return reply('## ❌ Impossible', "C'est déjà l'owner principal.");

  if (action === 'add') {
    if (owners.has(id)) return reply('## ❌ Déjà owner', `<@${id}> est déjà owner.`);
    owners.add(id);
    saveOwners();
    return reply('## ✅ Owner ajouté', `<@${id}> peut maintenant utiliser le bot.`);
  }

  if (!owners.has(id)) return reply('## ❌ Pas owner', `<@${id}> n'est pas owner.`);
  owners.delete(id);
  saveOwners();
  return reply('## ✅ Owner retiré', `<@${id}> ne peut plus utiliser le bot.`);
});

if (!MAIN_OWNER) console.warn('⚠️  MAIN_OWNER_ID manquant dans le .env : personne ne pourra utiliser le bot !');

client.login(process.env.TOKEN);