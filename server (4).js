require('dotenv').config();
const express  = require("express");
const http     = require("http");
const crypto   = require("crypto");
const path     = require("path");
const jwt      = require("jsonwebtoken");
const { Server } = require("socket.io");
const {
    Client, GatewayIntentBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    EmbedBuilder, Events, ChannelType, Partials,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require("discord.js");
const mongoose = require("mongoose");

const LIFETIME_VALUE     = 9_999_999_999_999;
const BRAINROT_MAX       = 100;
const JOBID_MAX          = 500;
const PRESENCE_TTL       = 2  * 60 * 1_000;
const ONLINE_STALE_MS    = 30 * 1_000;
const RATE_LIMIT_MAX     = 60;
const RATE_LIMIT_WINDOW  = 60_000;
const BLOCK_DURATION     = 5  * 60 * 1_000;
const PENDING_EXPIRY_MS  = 15 * 60 * 1_000;
const KEY_WARN_BEFORE_MS = 30 * 60 * 1_000;
const MAX_SLOTS          = parseInt(process.env.MAX_SLOTS || "3");

const COLORS = {
    primary:  0x5865F2, success:  0x00E676, danger:   0xFF3C3C,
    warning:  0xFFA500, info:     0x00CCFF, gold:     0xFFD700,
    purple:   0x9B59B6, dark:     0x2F3136,
};

const BLOCKED_UA = ["python-requests","python-httpx","curl","wget","httpie","insomnia","postman","go-http-client","java/","axios","okhttp","libwww-perl","scrapy","aiohttp"];

function requireEnv(name) {
    const val = process.env[name];
    if (!val) { console.error(`[FATAL] Variável obrigatória não definida: ${name}`); process.exit(1); }
    return val;
}

const ADMIN_PASS    = requireEnv("ADMIN_PASS");
const SCRIPT_SECRET = requireEnv("SCRIPT_SECRET");
const XOR_KEY       = requireEnv("XOR_KEY");
const MONGODB_URI   = requireEnv("MONGODB_URI");
const JWT_SECRET    = process.env.JWT_SECRET || "bobjoiner_jwt_secret_2026";

const CLIENT_HEADER          = process.env.CLIENT_HEADER           || "BobJoiner-v2";
const PIX_KEY                = process.env.PIX_KEY                 || "";
const PIX_NAME               = process.env.PIX_NAME                || "";
const BUY_CHANNEL            = process.env.BUY_CHANNEL             || "";
const DISCORD_TOKEN_NOTIFIER = process.env.DISCORD_TOKEN_NOTIFIER  || "";
const DISCORD_TOKEN_LOGS     = process.env.DISCORD_TOKEN_LOGS      || "";
const DISCORD_TOKEN_PANEL    = process.env.DISCORD_TOKEN_PANEL     || "";
const DISCORD_TOKEN_PAYMENT  = process.env.DISCORD_TOKEN_PAYMENT   || "";
const DISCORD_CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID      || "";
const PANEL_CHANNEL_ID       = process.env.PANEL_CHANNEL_ID        || "";
const LOGS_CHANNEL_ID        = process.env.LOGS_CHANNEL_ID         || "";
const BOB_LOGS_PANEL_CHANNEL = process.env.BOB_LOGS_PANEL_CHANNEL  || "";
const SCRIPT_URL             = process.env.SCRIPT_URL              || "";
const FRONTEND_URL           = process.env.FRONTEND_URL            || "http://localhost:3001";
const DISCORD_CLIENT_ID      = process.env.DISCORD_CLIENT_ID       || "";
const DISCORD_CLIENT_SECRET  = process.env.DISCORD_CLIENT_SECRET   || "";
const REDIRECT_URI           = `${process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "http://localhost:3000"}/auth/callback`;

const ADMIN_ROLE_IDS = ["1477885793144930496","1501356382677373101","1477885797553148066"];
const RECHARGE_CHANNEL = "1511517095412895905";
const MIN_RECHARGE = 5;

const DEFAULT_PLANS = [
    { label: "1 Hora",   value: "1h",  price: 5,  hours: 1,  emoji: "🕐", active: true },
    { label: "2 Horas",  value: "2h",  price: 10, hours: 2,  emoji: "⏱️", active: true },
    { label: "4 Horas",  value: "4h",  price: 20, hours: 4,  emoji: "⚡", active: true },
    { label: "8 Horas",  value: "8h",  price: 35, hours: 8,  emoji: "🔥", active: false },
    { label: "24 Horas", value: "24h", price: 80, hours: 24, emoji: "👑", active: false },
];
let PLANS = [...DEFAULT_PLANS];

mongoose.connect(MONGODB_URI)
    .then(() => { console.log("[DB] MongoDB conectado!"); loadPlansFromDB(); })
    .catch(e => { console.error("[DB] Erro fatal:", e.message); process.exit(1); });

const KeySchema = new mongoose.Schema({
    name:      { type: String, required: true, unique: true },
    expiry:    { type: Number, default: LIFETIME_VALUE },
    paused:    { type: Boolean, default: false },
    remaining: { type: Number, default: 0 },
    hwid:      { type: String, default: null },
    discordId: { type: String, default: null },
    warnSent:  { type: Boolean, default: false },
    isAutoKey: { type: Boolean, default: false },
});
const KeyModel = mongoose.model("Key", KeySchema);

const PendingPaymentSchema = new mongoose.Schema({
    discordId: String, discordTag: String, hours: Number, price: Number,
    finalPrice: Number, label: String, couponUsed: String,
    warningSent: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
});
const PendingPayment = mongoose.model("PendingPayment", PendingPaymentSchema);

const SaleHistorySchema = new mongoose.Schema({
    discordId: String, discordTag: String, hours: Number, price: Number,
    label: String, keyName: String, couponUsed: String,
    confirmedBy: { type: String, default: "auto" },
    confirmedAt: { type: Date, default: Date.now },
});
const SaleHistory = mongoose.model("SaleHistory", SaleHistorySchema);

const CouponSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    discount: { type: Number, required: true },
    type: { type: String, default: "percent" },
    maxUses: { type: Number, default: 1 },
    usedCount: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    usedBy: [String],
    createdAt: { type: Date, default: Date.now },
});
const Coupon = mongoose.model("Coupon", CouponSchema);

const PlanSchema = new mongoose.Schema({
    label: String, value: { type: String, unique: true },
    price: Number, hours: Number, emoji: String,
    active: { type: Boolean, default: true },
});
const PlanModel = mongoose.model("Plan", PlanSchema);

const UserSchema = new mongoose.Schema({
    discordId:  { type: String, required: true, unique: true },
    discordTag: String, avatar: String,
    balance:    { type: Number, default: 0 },
    createdAt:  { type: Date, default: Date.now },
});
const User = mongoose.model("User", UserSchema);

const TransactionSchema = new mongoose.Schema({
    discordId: String, type: String, amount: Number,
    description: String, createdAt: { type: Date, default: Date.now },
});
const Transaction = mongoose.model("Transaction", TransactionSchema);

const RechargeSchema = new mongoose.Schema({
    discordId:  { type: String, required: true },
    discordTag: String,
    amount:     { type: Number, required: true },
    code:       { type: String, required: true, unique: true },
    status:     { type: String, default: "pending" }, // pending | confirmed | cancelled
    confirmedBy: { type: String, default: null },
    createdAt:  { type: Date, default: Date.now },
});
const Recharge = mongoose.model("Recharge", RechargeSchema);

const keys = {}, brainrots = [], presence = {}, kicked = {}, userJobIds = {};

function xorObfuscate(value) {
    if (!value) return value;
    const str = String(value); let result = "";
    for (let i = 0; i < str.length; i++)
        result += String.fromCharCode(str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    return Buffer.from(result, "binary").toString("base64");
}

function safeCompare(a, b) {
    try {
        const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
        if (ba.length !== bb.length) return false;
        return crypto.timingSafeEqual(ba, bb);
    } catch { return false; }
}

const wrongPass = (pass) => !safeCompare(pass, ADMIN_PASS);

const formatTime = (ms) => {
    if (ms === Infinity) return "Lifetime ♾️";
    if (ms <= 0) return "Expirado";
    let t = Math.floor(ms / 1000);
    const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(d + "d");
    if (h > 0) parts.push(h + "h");
    parts.push(m + "m");
    return parts.join(" ");
};

const formatTimeShort = (ms) => {
    if (ms <= 0) return "expirado";
    const m = Math.floor(ms / 60_000), s = Math.floor((ms % 60_000) / 1000);
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
};

const findKey    = (name) => Object.keys(keys).find(k => k.toLowerCase() === (name || "").trim().toLowerCase());
const tsRelative = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;

function generateBobKey() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let r = "BOB-";
    for (let i = 0; i < 8; i++) r += chars[Math.floor(Math.random() * chars.length)];
    return r;
}

function generateRechargeCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let r = "PIX-";
    for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
    return r;
}

function pushBrainrot(payload) {
    brainrots.push(payload);
    if (brainrots.length > BRAINROT_MAX) brainrots.shift();
    io.emit("brainrot", payload);
}

async function fetchUserFromAnyClient(userId) {
    for (const client of [clientLogs, clientPayment, clientPanel, clientNotifier]) {
        try { const u = await client.users.fetch(userId); if (u) return u; } catch {}
    }
    return null;
}

async function applyCoupon(code, userId, originalPrice) {
    if (!code) return { ok: false, finalPrice: originalPrice, msg: null };
    const coupon = await Coupon.findOne({ code: code.toUpperCase(), active: true });
    if (!coupon) return { ok: false, finalPrice: originalPrice, msg: "❌ Cupom inválido." };
    if (coupon.expiresAt && new Date() > coupon.expiresAt) return { ok: false, finalPrice: originalPrice, msg: "❌ Cupom expirado." };
    if (coupon.usedCount >= coupon.maxUses) return { ok: false, finalPrice: originalPrice, msg: "❌ Cupom esgotado." };
    if (coupon.usedBy.includes(userId)) return { ok: false, finalPrice: originalPrice, msg: "❌ Você já usou este cupom." };
    let finalPrice = originalPrice;
    if (coupon.type === "percent") finalPrice = Math.max(0, originalPrice - (originalPrice * coupon.discount / 100));
    else finalPrice = Math.max(0, originalPrice - coupon.discount);
    finalPrice = Math.round(finalPrice * 100) / 100;
    return { ok: true, finalPrice, discount: coupon.discount, type: coupon.type, coupon, msg: null };
}

async function consumeCoupon(code, userId) {
    await Coupon.updateOne({ code: code.toUpperCase() }, { $inc: { usedCount: 1 }, $push: { usedBy: userId } });
}

async function loadPlansFromDB() {
    try {
        const dbPlans = await PlanModel.find({});
        if (dbPlans.length > 0) {
            PLANS = dbPlans.map(p => ({ label: p.label, value: p.value, price: p.price, hours: p.hours, emoji: p.emoji, active: p.active }));
        } else {
            for (const p of DEFAULT_PLANS) await PlanModel.findOneAndUpdate({ value: p.value }, p, { upsert: true });
        }
    } catch (e) { console.error("[DB] Erro ao carregar planos:", e.message); }
}

async function loadKeys() {
    try {
        const docs = await KeyModel.find({});
        let expired = 0;
        for (const d of docs) {
            const expiry = d.expiry >= LIFETIME_VALUE ? Infinity : d.expiry;
            const remaining = d.remaining >= LIFETIME_VALUE ? Infinity : d.remaining;
            if (d.isAutoKey && d.expiry === 0 && d.paused) {
                keys[d.name] = { expiry: 0, paused: true, remaining: 0, hwid: d.hwid || null, discordId: d.discordId || null, warnSent: false, isAutoKey: true };
                continue;
            }
            if (expiry !== Infinity && !d.paused && expiry - Date.now() <= 0) {
                await KeyModel.deleteOne({ name: d.name }); expired++; continue;
            }
            keys[d.name] = {
                expiry, paused: d.paused, remaining, hwid: d.hwid || null,
                discordId: d.discordId || null, warnSent: d.warnSent || false,
                isAutoKey: d.isAutoKey || false,
            };
        }
        console.log(`[DB] ${Object.keys(keys).length} keys carregadas. ${expired} expiradas removidas.`);
    } catch (e) { console.error("[DB] Erro ao carregar keys:", e.message); }
}

async function saveKey(name) {
    try {
        const raw = { ...keys[name] };
        if (raw.expiry === Infinity) raw.expiry = LIFETIME_VALUE;
        if (raw.remaining === Infinity) raw.remaining = LIFETIME_VALUE;
        await KeyModel.findOneAndUpdate({ name }, { name, ...raw }, { upsert: true, new: true });
    } catch (e) { console.error("[DB] Erro ao salvar key:", e.message); }
}

async function deleteKey(name) {
    try { await KeyModel.deleteOne({ name }); } catch (e) { console.error("[DB] Erro ao deletar key:", e.message); }
}

async function createAutoKeyForUser(discordId, discordTag) {
    const discordIdStr = String(discordId);
    const existing = Object.entries(keys).find(([, d]) => d.discordId === discordIdStr);
    if (existing) {
        console.log(`[AUTH] Usuário ${discordTag} já tem key em memória: ${existing[0]}`);
        return existing[0];
    }
    const existingInDB = await KeyModel.findOne({ discordId: discordIdStr });
    if (existingInDB) {
        console.log(`[AUTH] Usuário ${discordTag} já tem key no banco: ${existingInDB.name}`);
        if (!keys[existingInDB.name]) {
            const expiry = existingInDB.expiry >= LIFETIME_VALUE ? Infinity : existingInDB.expiry;
            const remaining = existingInDB.remaining >= LIFETIME_VALUE ? Infinity : existingInDB.remaining;
            keys[existingInDB.name] = {
                expiry, paused: existingInDB.paused, remaining,
                hwid: existingInDB.hwid || null, discordId: discordIdStr,
                warnSent: existingInDB.warnSent || false, isAutoKey: existingInDB.isAutoKey || false,
            };
        }
        return existingInDB.name;
    }
    const keyName = generateBobKey();
    keys[keyName] = { expiry: 0, paused: true, remaining: 0, hwid: null, discordId: discordIdStr, warnSent: false, isAutoKey: true };
    await saveKey(keyName);
    console.log(`[AUTH] ✅ Key auto-gerada no login: ${keyName} → ${discordTag}`);
    return keyName;
}

setInterval(async () => {
    const now = Date.now();
    for (const [name, data] of Object.entries(keys)) {
        if (data.isAutoKey && data.expiry === 0 && data.paused) continue;
        if (data.expiry !== Infinity && !data.paused && data.expiry - now <= 0) {
            if (data.discordId) fetchUserFromAnyClient(data.discordId).then(user => {
                if (user) user.send({ embeds: [new EmbedBuilder().setColor(COLORS.danger).setTitle("⏰ Sua key expirou!").setDescription(`A key \`${name}\` expirou. Recarregue seu saldo para continuar usando.`).setTimestamp()] }).catch(() => {});
            });
            await KeyModel.deleteOne({ name });
            delete keys[name];
            continue;
        }
        if (data.expiry !== Infinity && !data.paused && !data.warnSent && data.expiry - now <= KEY_WARN_BEFORE_MS) {
            if (data.discordId) fetchUserFromAnyClient(data.discordId).then(user => {
                if (user) user.send({ embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle("⚠️ Sua key vai expirar!").setDescription(`A key \`${name}\` vai expirar em ${formatTime(data.expiry - now)}. Recarregue seu saldo para não perder o acesso.`).setTimestamp()] }).catch(() => {});
            });
            data.warnSent = true;
            await saveKey(name);
        }
    }
    for (const [sid, info] of Object.entries(presence)) {
        if (now - info.lastSeen > PRESENCE_TTL) {
            delete presence[sid];
        }
    }
}, 10_000);

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware para bloquear user-agents específicos
app.use((req, res, next) => {
    const ua = req.headers["user-agent"] || "";
    if (BLOCKED_UA.some(b => ua.toLowerCase().includes(b))) {
        return res.status(403).json({ error: "Acesso negado." });
    }
    next();
});

// Middleware de autenticação para rotas protegidas
function requireAuth(req, res, next) {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Token não fornecido." });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Token inválido." });
        req.user = user;
        next();
    });
}

function requireAdminAuth(req, res, next) {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Token não fornecido." });
    jwt.verify(token, JWT_SECRET, async (err, user) => {
        if (err) return res.status(403).json({ error: "Token inválido." });
        req.user = user;
        const dbUser = await User.findOne({ discordId: user.discordId });
        if (!dbUser || !ADMIN_ROLE_IDS.includes(dbUser.discordId)) return res.status(403).json({ error: "Acesso negado. Não é um administrador." });
        next();
    });
}

function requireClientHeader(req, res, next) {
    const clientHeader = req.headers["x-client-header"];
    if (clientHeader !== CLIENT_HEADER) return res.status(403).json({ status: "error", message: "Header de cliente inválido." });
    next();
}

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
    console.log("Socket conectado: ", socket.id);

    socket.on("checkKey", (key, secret, hwid, cb) => {
        const r = checkKey(key, secret, hwid);
        cb(r);
    });

    socket.on("presence", (key, secret, hwid, sessionId, name, jobId, discordId) => {
        const r = checkKey(key, secret, hwid);
        if (!r.ok) return;
        presence[sessionId] = { name: name || "Unknown", lastSeen: Date.now(), key: (key || "").trim() };
        if (jobId && name) userJobIds[name] = jobId;
        if (discordId && r.keyName) {
            const d = keys[r.keyName], cleanId = String(discordId).replace(/\D/g, "");
            if (cleanId.length >= 17 && !d.discordId) {
                d.discordId = cleanId;
                saveKey(r.keyName);
            }
        }
    });

    socket.on("disconnect", () => {
        console.log("Socket desconectado: ", socket.id);
        for (const sid in presence) {
            if (presence[sid].socketId === socket.id) {
                delete presence[sid];
                break;
            }
        }
    });
});

function checkKey(key, secret, hwid) {
    if (secret !== SCRIPT_SECRET) return { ok: false, error: "Secret inválido." };
    const keyName = findKey(key);
    if (!keyName) return { ok: false, error: "Key não encontrada." };
    const data = keys[keyName];
    if (data.paused) return { ok: false, error: "Key pausada." };
    if (data.expiry !== Infinity && data.expiry - Date.now() <= 0) return { ok: false, error: "Key expirada." };
    if (data.hwid && data.hwid !== hwid) return { ok: false, error: "HWID incorreto." };
    if (!data.hwid) {
        data.hwid = hwid;
        saveKey(keyName);
    }
    return { ok: true, data, keyName };
}

// ─── DISCORD CLIENTS ──────────────────────────────────────────────────────────
const clientPanel = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildPresences], partials: [Partials.Channel, Partials.Message, Partials.Reaction] });
clientPanel.on("ready", () => console.log(`[PANEL] Online: ${clientPanel.user.tag}`));

clientPanel.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("logs_")) return;
    await interaction.deferReply({ ephemeral: true });

    const id = interaction.customId;

    if (id === "logs_create") {
        const modal = new ModalBuilder().setCustomId("modal_create_key").setTitle("Criar Nova Key");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da Key").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_duration").setLabel("Duração (ex: 1h, 2d, lifetime)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_discordid").setLabel("Discord ID (opcional)").setStyle(TextInputStyle.Short).setRequired(false)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_lifetime") {
        const modal = new ModalBuilder().setCustomId("modal_lifetime_key").setTitle("Tornar Key Lifetime");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da Key").setStyle(TextInputStyle.Short).setRequired(true)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_revoke") {
        const modal = new ModalBuilder().setCustomId("modal_revoke_key").setTitle("Revogar Key");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da Key (ou 'all')").setStyle(TextInputStyle.Short).setRequired(true)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_pause") {
        const modal = new ModalBuilder().setCustomId("modal_pause_key").setTitle("Pausar/Retomar Key");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da Key (ou 'all')").setStyle(TextInputStyle.Short).setRequired(true)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_reset") {
        const modal = new ModalBuilder().setCustomId("modal_reset_hwid").setTitle("Resetar HWID da Key");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da Key (ou 'all')").setStyle(TextInputStyle.Short).setRequired(true)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_addtime") {
        const modal = new ModalBuilder().setCustomId("modal_add_time").setTitle("Adicionar Tempo à Key");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da Key (ou 'all')").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("time_duration").setLabel("Duração (ex: 1h, 2d)").setStyle(TextInputStyle.Short).setRequired(true)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_setexpiry") {
        const modal = new ModalBuilder().setCustomId("modal_set_expiry").setTitle("Definir Expiração da Key");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da Key").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("time_duration").setLabel("Duração (ex: 1h, 2d, lifetime)").setStyle(TextInputStyle.Short).setRequired(true)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_transfer") {
        const modal = new ModalBuilder().setCustomId("modal_transfer_key").setTitle("Transferir Key");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da Key").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("new_discordid").setLabel("Novo Discord ID").setStyle(TextInputStyle.Short).setRequired(true)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_sethwid") {
        const modal = new ModalBuilder().setCustomId("modal_set_hwid").setTitle("Definir HWID da Key");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da Key").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("new_hwid").setLabel("Novo HWID").setStyle(TextInputStyle.Short).setRequired(true)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_plans") {
        const modal = new ModalBuilder().setCustomId("modal_manage_plans").setTitle("Gerenciar Planos");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("plan_action").setLabel("Ação (add, edit, remove)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("plan_value").setLabel("Valor do Plano (ex: 1h)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("plan_label").setLabel("Label (ex: 1 Hora)").setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("plan_price").setLabel("Preço").setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("plan_hours").setLabel("Horas").setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("plan_emoji").setLabel("Emoji").setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("plan_active").setLabel("Ativo (true/false)").setStyle(TextInputStyle.Short).setRequired(false)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_coupons") {
        const modal = new ModalBuilder().setCustomId("modal_manage_coupons").setTitle("Gerenciar Cupons");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("coupon_action").setLabel("Ação (add, edit, remove)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("coupon_code").setLabel("Código do Cupom").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("coupon_discount").setLabel("Desconto (ex: 10 para 10% ou 5 para R$5)").setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("coupon_type").setLabel("Tipo (percent ou fixed)").setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("coupon_maxuses").setLabel("Usos Máximos").setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("coupon_expiresat").setLabel("Expira em (YYYY-MM-DD, opcional)").setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("coupon_active").setLabel("Ativo (true/false)").setStyle(TextInputStyle.Short).setRequired(false)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_users") {
        const modal = new ModalBuilder().setCustomId("modal_manage_users").setTitle("Gerenciar Usuários");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_action").setLabel("Ação (balance, remove)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_discordid").setLabel("Discord ID").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_amount").setLabel("Valor (para balance)").setStyle(TextInputStyle.Short).setRequired(false)),
        );
        await interaction.showModal(modal);
        return;
    }

    if (id === "logs_recharges") {
        const modal = new ModalBuilder().setCustomId("modal_manage_recharges").setTitle("Gerenciar Recargas");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("recharge_action").setLabel("Ação (confirm, cancel)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("recharge_code").setLabel("Código da Recarga").setStyle(TextInputStyle.Short).setRequired(true)),
        );
        await interaction.showModal(modal);
        return;
    }

    await interaction.editReply({ content: "Ação não reconhecida." });
});

clientPanel.on("modalSubmit", async (modal) => {
    await modal.deferReply({ ephemeral: true });
    const { customId } = modal;

    if (customId === "modal_create_key") {
        const keyName = modal.fields.getTextInputValue("key_name");
        const duration = modal.fields.getTextInputValue("key_duration");
        const discordId = modal.fields.getTextInputValue("key_discordid");

        let durationMs = 0;
        if (duration.toLowerCase() === "lifetime") durationMs = LIFETIME_VALUE;
        else {
            const match = duration.match(/^(\d+)([hdm])$/i);
            if (!match) { await modal.editReply({ content: "❌ Duração inválida. Use formatos como '1h', '2d', 'lifetime'." }); return; }
            const value = parseInt(match[1]);
            const unit = match[2].toLowerCase();
            if (unit === "h") durationMs = value * 60 * 60 * 1000;
            else if (unit === "d") durationMs = value * 24 * 60 * 60 * 1000;
            else if (unit === "m") durationMs = value * 30 * 24 * 60 * 60 * 1000; // Mês
        }

        if (findKey(keyName)) { await modal.editReply({ content: "❌ Key já existe." }); return; }

        keys[keyName] = { expiry: Date.now() + durationMs, paused: false, remaining: durationMs, hwid: null, discordId: discordId || null, warnSent: false, isAutoKey: false };
        await saveKey(keyName);
        await modal.editReply({ content: `✅ Key \`${keyName}\` criada com ${formatTime(durationMs)}.` });
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_lifetime_key") {
        const keyName = modal.fields.getTextInputValue("key_name");
        const t = findKey(keyName);
        if (!t) { await modal.editReply({ content: "❌ Key não encontrada." }); return; }
        keys[t].expiry = LIFETIME_VALUE;
        keys[t].remaining = LIFETIME_VALUE;
        keys[t].warnSent = false;
        await saveKey(t);
        await modal.editReply({ content: `✅ Key \`${t}\` definida como Lifetime.` });
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_revoke_key") {
        const keyName = modal.fields.getTextInputValue("key_name");
        const r = await opRevokeKey(keyName);
        await modal.editReply({ content: r.msg });
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_pause_key") {
        const keyName = modal.fields.getTextInputValue("key_name");
        const r = await opTogglePause(keyName);
        await modal.editReply({ content: r.msg });
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_reset_hwid") {
        const keyName = modal.fields.getTextInputValue("key_name");
        const r = await opResetHwid(keyName);
        await modal.editReply({ content: r.msg });
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_add_time") {
        const keyName = modal.fields.getTextInputValue("key_name");
        const duration = modal.fields.getTextInputValue("time_duration");

        let durationMs = 0;
        const match = duration.match(/^(\d+)([hdm])$/i);
        if (!match) { await modal.editReply({ content: "❌ Duração inválida. Use formatos como '1h', '2d'." }); return; }
        const value = parseInt(match[1]);
        const unit = match[2].toLowerCase();
        if (unit === "h") durationMs = value * 60 * 60 * 1000;
        else if (unit === "d") durationMs = value * 24 * 60 * 60 * 1000;
        else if (unit === "m") durationMs = value * 30 * 24 * 60 * 60 * 1000; // Mês

        const r = await opAddTime(keyName, durationMs);
        await modal.editReply({ content: r.msg });
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_set_expiry") {
        const keyName = modal.fields.getTextInputValue("key_name");
        const duration = modal.fields.getTextInputValue("time_duration");

        let durationMs = 0;
        if (duration.toLowerCase() === "lifetime") durationMs = LIFETIME_VALUE;
        else {
            const match = duration.match(/^(\d+)([hdm])$/i);
            if (!match) { await modal.editReply({ content: "❌ Duração inválida. Use formatos como '1h', '2d', 'lifetime'." }); return; }
            const value = parseInt(match[1]);
            const unit = match[2].toLowerCase();
            if (unit === "h") durationMs = value * 60 * 60 * 1000;
            else if (unit === "d") durationMs = value * 24 * 60 * 60 * 1000;
            else if (unit === "m") durationMs = value * 30 * 24 * 60 * 60 * 1000; // Mês
        }

        const r = await opSetExpiry(keyName, durationMs);
        await modal.editReply({ content: r.msg });
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_transfer_key") {
        const keyName = modal.fields.getTextInputValue("key_name");
        const newDiscordId = modal.fields.getTextInputValue("new_discordid");
        const t = findKey(keyName);
        if (!t) { await modal.editReply({ content: "❌ Key não encontrada." }); return; }
        keys[t].discordId = newDiscordId;
        await saveKey(t);
        await modal.editReply({ content: `✅ Key \`${t}\` transferida para ${newDiscordId}.` });
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_set_hwid") {
        const keyName = modal.fields.getTextInputValue("key_name");
        const newHwid = modal.fields.getTextInputValue("new_hwid");
        const t = findKey(keyName);
        if (!t) { await modal.editReply({ content: "❌ Key não encontrada." }); return; }
        keys[t].hwid = newHwid;
        await saveKey(t);
        await modal.editReply({ content: `✅ HWID da key \`${t}\` definido para ${newHwid}.` });
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_manage_plans") {
        const action = modal.fields.getTextInputValue("plan_action").toLowerCase();
        const value = modal.fields.getTextInputValue("plan_value");
        const label = modal.fields.getTextInputValue("plan_label");
        const price = parseFloat(modal.fields.getTextInputValue("plan_price"));
        const hours = parseInt(modal.fields.getTextInputValue("plan_hours"));
        const emoji = modal.fields.getTextInputValue("plan_emoji");
        const active = modal.fields.getTextInputValue("plan_active").toLowerCase() === "true";

        if (action === "add") {
            if (!value || !label || isNaN(price) || isNaN(hours) || !emoji) { await modal.editReply({ content: "❌ Dados incompletos para adicionar plano." }); return; }
            await PlanModel.findOneAndUpdate({ value }, { label, value, price, hours, emoji, active }, { upsert: true, new: true });
            PLANS = await PlanModel.find({});
            await modal.editReply({ content: `✅ Plano \`${label}\` adicionado/atualizado.` });
        } else if (action === "edit") {
            const existingPlan = await PlanModel.findOne({ value });
            if (!existingPlan) { await modal.editReply({ content: "❌ Plano não encontrado para edição." }); return; }
            const update = {};
            if (label) update.label = label;
            if (!isNaN(price)) update.price = price;
            if (!isNaN(hours)) update.hours = hours;
            if (emoji) update.emoji = emoji;
            if (modal.fields.getTextInputValue("plan_active")) update.active = active;
            await PlanModel.updateOne({ value }, update);
            PLANS = await PlanModel.find({});
            await modal.editReply({ content: `✅ Plano \`${value}\` atualizado.` });
        } else if (action === "remove") {
            await PlanModel.deleteOne({ value });
            PLANS = await PlanModel.find({});
            await modal.editReply({ content: `✅ Plano \`${value}\` removido.` });
        } else {
            await modal.editReply({ content: "❌ Ação de plano inválida. Use 'add', 'edit' ou 'remove'." });
        }
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_manage_coupons") {
        const action = modal.fields.getTextInputValue("coupon_action").toLowerCase();
        const code = modal.fields.getTextInputValue("coupon_code").toUpperCase();
        const discount = parseFloat(modal.fields.getTextInputValue("coupon_discount"));
        const type = modal.fields.getTextInputValue("coupon_type").toLowerCase();
        const maxUses = parseInt(modal.fields.getTextInputValue("coupon_maxuses"));
        const expiresAt = modal.fields.getTextInputValue("coupon_expiresat");
        const active = modal.fields.getTextInputValue("coupon_active").toLowerCase() === "true";

        if (action === "add") {
            if (!code || isNaN(discount) || !type) { await modal.editReply({ content: "❌ Dados incompletos para adicionar cupom." }); return; }
            const newCoupon = { code, discount, type, maxUses: isNaN(maxUses) ? 1 : maxUses, active: true };
            if (expiresAt) newCoupon.expiresAt = new Date(expiresAt);
            await Coupon.findOneAndUpdate({ code }, newCoupon, { upsert: true, new: true });
            await modal.editReply({ content: `✅ Cupom \`${code}\` adicionado/atualizado.` });
        } else if (action === "edit") {
            const existingCoupon = await Coupon.findOne({ code });
            if (!existingCoupon) { await modal.editReply({ content: "❌ Cupom não encontrado para edição." }); return; }
            const update = {};
            if (!isNaN(discount)) update.discount = discount;
            if (type) update.type = type;
            if (!isNaN(maxUses)) update.maxUses = maxUses;
            if (expiresAt) update.expiresAt = new Date(expiresAt);
            if (modal.fields.getTextInputValue("coupon_active")) update.active = active;
            await Coupon.updateOne({ code }, update);
            await modal.editReply({ content: `✅ Cupom \`${code}\` atualizado.` });
        } else if (action === "remove") {
            await Coupon.deleteOne({ code });
            await modal.editReply({ content: `✅ Cupom \`${code}\` removido.` });
        } else {
            await modal.editReply({ content: "❌ Ação de cupom inválida. Use 'add', 'edit' ou 'remove'." });
        }
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_manage_users") {
        const action = modal.fields.getTextInputValue("user_action").toLowerCase();
        const discordId = modal.fields.getTextInputValue("user_discordid");
        const amount = parseFloat(modal.fields.getTextInputValue("user_amount"));

        if (action === "balance") {
            if (!discordId || isNaN(amount)) { await modal.editReply({ content: "❌ Dados incompletos para ajustar saldo." }); return; }
            const user = await User.findOneAndUpdate({ discordId }, { $inc: { balance: amount } }, { new: true });
            if (!user) { await modal.editReply({ content: "❌ Usuário não encontrado." }); return; }
            await Transaction.create({ discordId, type: "admin_adjust", amount, description: `Ajuste de saldo por admin.` });
            await modal.editReply({ content: `✅ Saldo de ${user.discordTag} ajustado para R$${user.balance.toFixed(2)}.` });
        } else if (action === "remove") {
            if (!discordId) { await modal.editReply({ content: "❌ Discord ID do usuário não fornecido." }); return; }
            await User.deleteOne({ discordId });
            await KeyModel.deleteMany({ discordId }); // Remove keys associadas
            await modal.editReply({ content: `✅ Usuário com ID ${discordId} e suas keys removidos.` });
        } else {
            await modal.editReply({ content: "❌ Ação de usuário inválida. Use 'balance' ou 'remove'." });
        }
        await sendLogsPanel();
        return;
    }

    if (customId === "modal_manage_recharges") {
        const action = modal.fields.getTextInputValue("recharge_action").toLowerCase();
        const code = modal.fields.getTextInputValue("recharge_code");

        if (action === "confirm") {
            const recharge = await Recharge.findOne({ code, status: "pending" });
            if (!recharge) { await modal.editReply({ content: "❌ Recarga não encontrada ou já processada." }); return; }

            const updatedUser = await User.findOneAndUpdate(
                { discordId: recharge.discordId },
                { $inc: { balance: recharge.amount } },
                { new: true, upsert: true }
            );
            if (!updatedUser) { await modal.editReply({ content: "❌ Usuário não encontrado no banco." }); return; }

            await Transaction.create({
                discordId: recharge.discordId,
                type: "deposit",
                amount: recharge.amount,
                description: `Recarga Pix — ${code}`
            });

            await Recharge.updateOne({ code }, { status: "confirmed", confirmedBy: modal.user.id });

            fetchUserFromAnyClient(recharge.discordId).then(u => {
                if (u) u.send({ embeds: [new EmbedBuilder()
                    .setColor(COLORS.success)
                    .setTitle("💰 Recarga Confirmada!")
                    .setDescription(`**R$${recharge.amount.toFixed(2)}** foram adicionados ao seu saldo!\n**Novo saldo:** R$${updatedUser.balance.toFixed(2)}\n**Código:** \`${code}\``)
                    .setTimestamp()] }).catch(() => {});
            });

            await modal.editReply({ content: `✅ Recarga de R$${recharge.amount.toFixed(2)} confirmada para ${recharge.discordTag}!` });
        } else if (action === "cancel") {
            const recharge = await Recharge.findOne({ code, status: "pending" });
            if (!recharge) { await modal.editReply({ content: "❌ Recarga não encontrada ou já processada." }); return; }

            await Recharge.updateOne({ code }, { status: "cancelled" });

            fetchUserFromAnyClient(recharge.discordId).then(u => {
                if (u) u.send({ embeds: [new EmbedBuilder()
                    .setColor(COLORS.danger)
                    .setTitle("❌ Recarga Cancelada")
                    .setDescription(`Sua recarga de **R$${recharge.amount.toFixed(2)}** foi cancelada.\nCódigo: \`${code}\``)
                    .setTimestamp()] }).catch(() => {});
            });

            await modal.editReply({ content: `🗑️ Recarga \`${code}\` cancelada.` });
        } else {
            await modal.editReply({ content: "❌ Ação de recarga inválida. Use 'confirm' ou 'cancel'." });
        }
        await sendLogsPanel();
        return;
    }

    await modal.editReply({ content: "Ação de modal não reconhecida." });
});

async function sendLogsPanel() {
    if (!LOGS_CHANNEL_ID) return;
    try {
        const channel = await clientLogs.channels.fetch(LOGS_CHANNEL_ID);
        if (!channel) return;

        const all = Object.entries(keys), active = all.filter(([, d]) => !d.paused && (d.expiry === Infinity || d.expiry - Date.now() > 0)), paused = all.filter(([, d]) => d.paused);
        const online = Object.values(presence).filter(p => Date.now() - p.lastSeen < ONLINE_STALE_MS);
        const pendentes = await PendingPayment.countDocuments({ warningSent: false });
        const coupons = await Coupon.countDocuments({ active: true });
        const plans = await PlanModel.countDocuments({ active: true });

        const embed = new EmbedBuilder()
            .setTitle("⚙️ Bob Joiner — Painel Administrativo")
            .setColor(COLORS.primary)
            .setDescription("Gerencie keys, pagamentos, cupons e planos.")
            .addFields(
                { name: "Keys Ativas", value: `${active.length}`, inline: true },
                { name: "Keys Pausadas", value: `${paused.length}`, inline: true },
                { name: "Online Agora", value: `${online.length}`, inline: true },
                { name: "Pedidos Pendentes", value: `${pendentes}`, inline: true },
                { name: "Cupons Ativos", value: `${coupons}`, inline: true },
                { name: "Planos Ativos", value: `${plans}`, inline: true },
            )
            .setTimestamp();

        const rows = buildLogsRows();

        const messages = await channel.messages.fetch({ limit: 1 });
        const lastMessage = messages.first();

        if (lastMessage && lastMessage.author.id === clientLogs.user.id && lastMessage.embeds[0]?.title === embed.title) {
            await lastMessage.edit({ embeds: [embed], components: rows });
        } else {
            await channel.send({ embeds: [embed], components: rows });
        }

    } catch (e) { console.error("[LOGS PANEL] Erro ao enviar painel:", e.message); }
}

const clientPayment = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.DirectMessages], partials: [Partials.Channel, Partials.Message, Partials.Reaction] });
clientPayment.on("ready", () => console.log(`[PAYMENT] Online: ${clientPayment.user.tag}`));

clientPayment.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("recharge_")) return;
    await interaction.deferReply({ ephemeral: true });

    const id = interaction.customId;

    if (id.startsWith("recharge_confirm_")) {
        const code = id.replace("recharge_confirm_", "");
        const recharge = await Recharge.findOne({ code, status: "pending" });
        if (!recharge) { await interaction.editReply({ content: "❌ Recarga não encontrada ou já processada." }); return; }

        const updatedUser = await User.findOneAndUpdate(
            { discordId: recharge.discordId },
            { $inc: { balance: recharge.amount } },
            { new: true, upsert: true }
        );
        if (!updatedUser) { await interaction.editReply({ content: "❌ Usuário não encontrado no banco." }); return; }

        await Transaction.create({
            discordId: recharge.discordId,
            type: "deposit",
            amount: recharge.amount,
            description: `Recarga Pix — ${code}`
        });

        await Recharge.updateOne({ code }, { status: "confirmed", confirmedBy: interaction.user.id });

        // DM pro usuário
        fetchUserFromAnyClient(recharge.discordId).then(u => {
            if (u) u.send({ embeds: [new EmbedBuilder()
                .setColor(COLORS.success)
                .setTitle("💰 Recarga Confirmada!")
                .setDescription(`**R$${recharge.amount.toFixed(2)}** foram adicionados ao seu saldo!\n**Novo saldo:** R$${updatedUser.balance.toFixed(2)}\n**Código:** \`${code}\``)
                .setTimestamp()] }).catch(() => {});
        });

        // Edita a mensagem do Discord desabilitando os botões
        await interaction.message.edit({
            embeds: [new EmbedBuilder()
                .setColor(COLORS.success)
                .setTitle("✅ Recarga Confirmada")
                .addFields(
                    { name: "👤 Usuário", value: `${recharge.discordTag} (<@${recharge.discordId}>)`, inline: true },
                    { name: "💰 Valor", value: `R$${recharge.amount.toFixed(2)}`, inline: true },
                    { name: "🔑 Código", value: `\`${code}\``, inline: true },
                    { name: "✅ Confirmado por", value: `<@${interaction.user.id}>`, inline: false }
                ).setTimestamp()],
            components: []
        }).catch(() => {});

        await interaction.editReply({ content: `✅ Recarga de R$${recharge.amount.toFixed(2)} confirmada para ${recharge.discordTag}!` });
        return;
    }

    if (id.startsWith("recharge_cancel_")) {
        const code = id.replace("recharge_cancel_", "");
        const recharge = await Recharge.findOne({ code, status: "pending" });
        if (!recharge) { await interaction.editReply({ content: "❌ Recarga não encontrada ou já processada." }); return; }

        await Recharge.updateOne({ code }, { status: "cancelled" });

        fetchUserFromAnyClient(recharge.discordId).then(u => {
            if (u) u.send({ embeds: [new EmbedBuilder()
                .setColor(COLORS.danger)
                .setTitle("❌ Recarga Cancelada")
                .setDescription(`Sua recarga de **R$${recharge.amount.toFixed(2)}** foi cancelada.\nCódigo: \`${code}\``)
                .setTimestamp()] }).catch(() => {});
        });

        await interaction.message.edit({
            embeds: [new EmbedBuilder()
                .setColor(COLORS.danger)
                .setTitle("❌ Recarga Cancelada")
                .addFields(
                    { name: "👤 Usuário", value: `${recharge.discordTag}`, inline: true },
                    { name: "💰 Valor", value: `R$${recharge.amount.toFixed(2)}`, inline: true },
                    { name: "🔑 Código", value: `\`${code}\``, inline: true }
                ).setTimestamp()],
            components: []
        }).catch(() => {});

        await interaction.editReply({ content: `🗑️ Recarga cancelada.` });
        return;
    }
});

function requireDashAuth(req, res, next) { const pass = req.query.pass || req.headers["x-admin-pass"]; if (!safeCompare(pass, ADMIN_PASS)) return res.status(401).json({ error: "Unauthorized" }); next(); }

app.get("/api/dashboard", requireDashAuth, async (req, res) => {
    const now = Date.now(), all = Object.entries(keys), active = all.filter(([, d]) => !d.paused && (d.expiry === Infinity || d.expiry - now > 0)), paused = all.filter(([, d]) => d.paused), online = Object.values(presence).filter(p => now - p.lastSeen < ONLINE_STALE_MS);
    const pendentes = await PendingPayment.find().sort({ createdAt: -1 }), recentSales = await SaleHistory.find().sort({ confirmedAt: -1 }).limit(10), totalR = await SaleHistory.aggregate([{ $group: { _id: null, t: { $sum: "$price" } } }]), coupons = await Coupon.find({ active: true }), hoje = recentSales.filter(s => new Date(s.confirmedAt).toDateString() === new Date().toDateString());
    res.json({ stats: { totalKeys: all.length, activeKeys: active.length, pausedKeys: paused.length, onlineNow: online.length, pendingOrders: pendentes.length, totalRevenue: totalR[0]?.t || 0, todaySales: hoje.length }, keys: active.slice(0, 50).map(([name, d]) => ({ name, expiry: d.expiry === Infinity ? null : d.expiry, discordId: d.discordId, paused: d.paused })), online: online.map(p => p.name), pendingOrders: pendentes.map(p => ({ discordTag: p.discordTag, label: p.label, price: p.finalPrice || p.price, createdAt: p.createdAt })), recentSales: recentSales.map(s => ({ discordTag: s.discordTag, label: s.label, price: s.price, keyName: s.keyName, confirmedAt: s.confirmedAt })), coupons: coupons.map(c => ({ code: c.code, discount: c.discount, type: c.type, usedCount: c.usedCount, maxUses: c.maxUses })), plans: PLANS });
});

app.get("/dashboard", (req, res) => res.send("<h1>Bob Joiner Dashboard</h1><a href='/api/dashboard'>API</a>"));
app.get("/health", (_, res) => res.json({ status: "ok", time: Date.now() }));

// Servir o arquivo index.html na rota principal
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/validate", requireClientHeader, (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); res.json({ status: "success", time_left: r.data.expiry === Infinity ? LIFETIME_VALUE : r.data.expiry - Date.now() }); });
app.get("/get-brainrots", requireClientHeader, (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); if (!brainrots.length) return res.json({ status: "waiting" }); const latest = brainrots[brainrots.length - 1]; if (latest.id === req.query.lastId) return res.json({ status: "waiting" }); res.json({ status: "success", brainrot: latest }); });
app.get("/logs", requireClientHeader, (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); res.json(brainrots); });
app.get("/api/latest", requireClientHeader, (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); if (!brainrots.length) return res.json({ status: "waiting" }); res.json(brainrots[brainrots.length - 1]); });
app.post("/api/notify", requireClientHeader, (req, res) => { const { secret, name, jobId, value, description } = req.body; if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error" }); const payload = { id: Date.now().toString(), title: name || "Brainrot", description: description || name || "Novo!", brainrot: name || "Brainrot", name: name || "Brainrot", jobId: xorObfuscate(jobId) || null, value: String(value || "0"), players: "N/A" }; pushBrainrot(payload); res.json({ status: "ok", id: payload.id }); });
app.get("/kicked", requireClientHeader, (req, res) => { if (req.query.secret !== SCRIPT_SECRET) return res.json({ kicked: false }); const keyName = findKey(req.query.key); if (!keyName) return res.json({ kicked: false }); const ts = kicked[keyName.toLowerCase()]; if (ts) { delete kicked[keyName.toLowerCase()]; return res.json({ kicked: true }); } res.json({ kicked: false }); });
app.post("/presence", requireClientHeader, async (req, res) => { const { key, secret, hwid, sessionId, name, jobId, discordId } = req.query; const r = checkKey(key, secret, hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); presence[sessionId] = { name: name || "Unknown", lastSeen: Date.now(), key: (key || "").trim() }; if (jobId && name) userJobIds[name] = jobId; if (discordId && r.keyName) { const d = keys[r.keyName], cleanId = String(discordId).replace(/\D/g, ""); if (cleanId.length >= 17 && !d.discordId) { d.discordId = cleanId; await saveKey(r.keyName); } } res.json({ status: "ok" }); });
app.get("/presence", requireClientHeader, (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); const now = Date.now(), active = {}; for (const [sid, info] of Object.entries(presence)) { if (now - info.lastSeen < ONLINE_STALE_MS) active[info.name] = true; else delete presence[sid]; } res.json(Object.keys(active).sort()); });
app.get("/clients", requireClientHeader, (req, res) => { if (req.query.secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error" }); res.send(`Socket.IO: ${io.sockets.sockets.size} | Presença: ${Object.keys(presence).length}`); });
app.post("/push-brainrot", requireClientHeader, (req, res) => { const { secret, title, description, jobId, value, players } = req.body; if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error" }); const payload = { id: Date.now().toString(), title: title || "Brainrot", description: description || "", brainrot: title || "Brainrot", name: title || "Brainrot", jobId: xorObfuscate(jobId) || null, value: value || "0", players: players || "N/A" }; pushBrainrot(payload); res.json({ status: "ok", id: payload.id }); });
app.post("/link-discord", requireClientHeader, async (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); const cleanId = String(req.query.discordId || "").replace(/\D/g, ""); if (cleanId.length < 17) return res.status(400).json({ status: "error", message: "Discord ID invalido." }); const d = keys[r.keyName]; if (d.discordId && d.discordId !== cleanId) return res.status(409).json({ status: "error", message: "Key ja vinculada." }); d.discordId = cleanId; await saveKey(r.keyName); res.json({ status: "ok" }); });
app.post("/report-jobid", requireClientHeader, (req, res) => { if (req.query.secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error" }); const keyName = findKey(req.query.key); if (!keyName) return res.status(403).json({ status: "error" }); if (req.query.name && req.query.jobId) userJobIds[req.query.name] = req.query.jobId; res.json({ status: "ok" }); });

app.use((err, req, res, next) => { console.error("[EXPRESS]", err.message); res.status(500).json({ status: "error", message: "Erro interno." }); });
process.on("unhandledRejection", r => console.error("[PROCESS] Rejeição:", r));
process.on("uncaughtException", e => console.error("[PROCESS] Exceção:", e.message));

async function loginBot(client, token, label) { if (!token) { console.warn(`[${label}] Token ausente.`); return; } try { await client.login(token); } catch (e) { console.error(`[${label}] Erro:`, e.message); } }

loginBot(clientNotifier, DISCORD_TOKEN_NOTIFIER, "NOTIFIER");
loginBot(clientLogs,     DISCORD_TOKEN_LOGS,     "LOGS");
loginBot(clientPanel,    DISCORD_TOKEN_PANEL,    "PANEL");
loginBot(clientPayment,  DISCORD_TOKEN_PAYMENT,  "PAYMENT");

loadKeys();
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`[SERVER] Porta ${port} — Bob API online ✅`));
