require("dotenv").config();
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
const SCRIPT_SECRET = requireEnv("SCRIPT_SECRET"); // Secret para o Joiner
const RAILWAY_SECRET = requireEnv("RAILWAY_SECRET"); // Secret para o Hopper
const XOR_KEY       = requireEnv("XOR_KEY");
const MONGODB_URI   = requireEnv("MONGODB_URI");
const JWT_SECRET    = process.env.JWT_SECRET || "bobjoiner_jwt_secret_2026";

const CLIENT_HEADER          = process.env.CLIENT_HEADER           || "BobJoiner-v2";
const RAILWAY_CLIENT         = process.env.RAILWAY_CLIENT          || "Bobnotify"; // Client para o Hopper
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
const BACKEND_URL            = "https://bob-notifier.up.railway.app"; // URL da API Railway
const FRONTEND_URL           = process.env.FRONTEND_URL            || "https://bob-html-one.vercel.app"; // URL do site Vercel
const DISCORD_CLIENT_ID      = process.env.DISCORD_CLIENT_ID       || "";
const DISCORD_CLIENT_SECRET  = process.env.DISCORD_CLIENT_SECRET   || "";
const REDIRECT_URI           = `${BACKEND_URL}/auth/callback`; // Callback vai pro Railway

// Validação das credenciais do Discord
if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    console.error("[FATAL] DISCORD_CLIENT_ID ou DISCORD_CLIENT_SECRET não configurado!");
    console.error("[FATAL] Configure as variáveis de ambiente no Railway");
}
console.log("[CONFIG] BACKEND_URL:", BACKEND_URL);
console.log("[CONFIG] FRONTEND_URL:", FRONTEND_URL);
console.log("[CONFIG] REDIRECT_URI:", REDIRECT_URI);
console.log("[CONFIG] DISCORD_CLIENT_ID:", DISCORD_CLIENT_ID ? "✓ Configurado" : "✗ FALTANDO");

const ADMIN_ROLE_IDS = process.env.ADMIN_ROLE_IDS ? process.env.ADMIN_ROLE_IDS.split(",") : ["1477885793144930496","1501356382677373101","1477885797553148066"];
const RECHARGE_CHANNEL = process.env.RECHARGE_CHANNEL || "1511517095412895905";
const MIN_RECHARGE = parseInt(process.env.MIN_RECHARGE || "5");

// --- INITIALIZE DISCORD CLIENTS FIRST ---
const clientNotifier = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildWebhooks] });
const clientLogs     = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMembers], partials: [Partials.Channel, Partials.Message] });
const clientPanel    = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [Partials.Channel, Partials.Message] });
const clientPayment  = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [Partials.Channel, Partials.Message] });

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

// Schema para pagamentos automáticos via gateway
const PaymentSchema = new mongoose.Schema({
    discordId:    { type: String, required: true },
    discordTag:   String,
    amount:       { type: Number, required: true },
    method:       { type: String, required: true }, // pix | crypto
    gatewayId:    { type: String, unique: true }, // ID do pagamento no gateway
    status:       { type: String, default: "pending" }, // pending | paid | expired | cancelled
    pixCode:      String, // Código PIX (se método for PIX)
    pixQrCode:    String, // QR Code base64 (se método for PIX)
    cryptoAddress: String, // Endereço da carteira (se método for cripto)
    cryptoCurrency: String, // BTC, LTC, etc
    cryptoAmount: Number, // Quantidade em cripto que deve ser enviada
    webhookDeliveryId: String, // ID da entrega do webhook (idempotência)
    expiresAt:    Date,
    paidAt:       Date,
    createdAt:    { type: Date, default: Date.now },
});
const Payment = mongoose.model("Payment", PaymentSchema);

const keys = {}, brainrots = [], presence = {}, kicked = {}, userJobIds = {}, blockedIPs = {};

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

async function opCreateKey(name, durationMs) {
    if (keys[name]) return { ok: false, msg: `❌ Key \`${name}\` já existe!` };
    keys[name] = { expiry: Date.now() + durationMs, paused: false, remaining: 0, hwid: null, discordId: null, warnSent: false, isAutoKey: false };
    await saveKey(name);
    return { ok: true, msg: `✅ Key \`${name}\` criada com sucesso por ${formatTime(durationMs)}!` };
}

async function opCreateLifetime(name) {
    if (keys[name]) return { ok: false, msg: `❌ Key \`${name}\` já existe!` };
    keys[name] = { expiry: Infinity, paused: false, remaining: Infinity, hwid: null, discordId: null, warnSent: false, isAutoKey: false };
    await saveKey(name);
    return { ok: true, msg: `✅ Key \`${name}\` Lifetime criada com sucesso!` };
}

async function opRevokeKey(name) {
    if (name.toLowerCase() === "all") {
        const count = Object.keys(keys).length;
        for (const k of Object.keys(keys)) { delete keys[k]; await deleteKey(k); }
        return { ok: true, msg: `🗑️ **${count}** keys removidas.` };
    }
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Key não encontrada." };
    delete keys[t];
    await deleteKey(t);
    return { ok: true, msg: `🗑️ Key \`${t}\` removida.` };
}

async function opTogglePause(name) {
    if (name.toLowerCase() === "all") {
        let p = 0, r = 0;
        for (const k of Object.keys(keys)) {
            const d = keys[k];
            if (d.paused) {
                d.expiry = Date.now() + d.remaining;
                d.paused = false;
                r++;
            } else {
                d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now();
                d.paused = true;
                p++;
            }
            await saveKey(k);
        }
        return { ok: true, msg: `⏸️ ${p} pausadas, ${r} retomadas.` };
    }
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Key não encontrada." };
    const d = keys[t];
    if (d.paused) {
        d.expiry = Date.now() + d.remaining;
        d.paused = false;
        await saveKey(t);
        return { ok: true, msg: `▶️ Key \`${t}\` retomada!` };
    }
    d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now();
    d.paused = true;
    await saveKey(t);
    return { ok: true, msg: `⏸️ Key \`${t}\` pausada!` };
}

async function opResetHwid(name) {
    if (name.toLowerCase() === "all") {
        let count = 0;
        for (const k of Object.keys(keys)) {
            keys[k].hwid = null;
            kicked[k.toLowerCase()] = Date.now();
            await saveKey(k);
            count++;
        }
        return { ok: true, msg: `✅ HWID de **${count}** keys resetado!` };
    }
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Key não encontrada." };
    keys[t].hwid = null;
    kicked[t.toLowerCase()] = Date.now();
    await saveKey(t);
    return { ok: true, msg: `✅ HWID de \`${t}\` resetado!` };
}

async function opAddTime(name, extraMs) {
    if (extraMs <= 0) return { ok: false, msg: "❌ Tempo inválido!" };
    if (name.toLowerCase() === "all") {
        let count = 0;
        for (const k of Object.keys(keys)) {
            const d = keys[k];
            if (d.paused) d.remaining += extraMs;
            else if (d.expiry !== Infinity) d.expiry += extraMs;
            d.warnSent = false;
            await saveKey(k);
            count++;
        }
        return { ok: true, msg: `✅ **${formatTime(extraMs)}** adicionado a **${count}** keys!` };
    }
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Key não encontrada." };
    const d = keys[t];
    if (d.paused) d.remaining += extraMs;
    else if (d.expiry !== Infinity) d.expiry += extraMs;
    d.warnSent = false;
    await saveKey(t);
    return { ok: true, msg: `✅ **${formatTime(extraMs)}** adicionado a \`${t}\`!` };
}

async function opSetExpiry(name, durationMs) {
    if (durationMs <= 0) return { ok: false, msg: "❌ Duração inválida!" };
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Key não encontrada." };
    const d = keys[t];
    if (d.paused) d.remaining = durationMs;
    else { d.expiry = Date.now() + durationMs; d.remaining = durationMs; }
    d.warnSent = false;
    await saveKey(t);
    return { ok: true, msg: `✅ Expiração de \`${t}\` → **${formatTime(durationMs)}**!` };
}

async function opTransferKey(oldName, newName) {
    const oldKey = findKey(oldName);
    if (!oldKey) return { ok: false, msg: "❌ Key antiga não encontrada." };
    if (keys[newName]) return { ok: false, msg: `❌ Nova key \`${newName}\` já existe!` };

    const data = { ...keys[oldKey] };
    delete keys[oldKey];
    await deleteKey(oldKey);

    keys[newName] = data;
    await saveKey(newName);
    return { ok: true, msg: `✅ Key \`${oldKey}\` transferida para \`${newName}\`!` };
}

async function opSetHwid(name, hwid) {
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Key não encontrada." };
    keys[t].hwid = hwid;
    await saveKey(t);
    return { ok: true, msg: `✅ HWID de \`${t}\` definido para \`${hwid}\`!` };
}

async function opLookupKey(name) {
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Key não encontrada." };
    const d = keys[t];
    const now = Date.now();
    const timeLeft = d.expiry === Infinity ? "Lifetime ♾️" : (d.paused ? formatTime(d.remaining) : formatTime(d.expiry - now));
    const hwidInfo = d.hwid ? `HWID: \`${d.hwid}\`` : "HWID: Não definido";
    const discordInfo = d.discordId ? `Discord: <@${d.discordId}>` : "Discord: Não linkado";
    const status = d.paused ? "Pausada ⏸️" : (d.expiry !== Infinity && d.expiry - now <= 0 ? "Expirada ❌" : "Ativa ✅");
    return { ok: true, msg: `**Key:** \`${t}\`\n**Status:** ${status}\n**Tempo Restante:** ${timeLeft}\n${hwidInfo}\n${discordInfo}` };
}

async function opUnblockIp(ip) {
    if (!blockedIPs[ip]) return { ok: false, msg: "❌ IP não bloqueado." };
    delete blockedIPs[ip];
    return { ok: true, msg: `✅ IP \`${ip}\` desbloqueado!` };
}

async function opCleanLogs() {
    brainrots.length = 0;
    return { ok: true, msg: "✅ Logs de brainrots limpos!" };
}

async function confirmarPagamento(user, hours, channel, adminId, price, label, couponUsed) {
    const keyEntry = Object.entries(keys).find(([, d]) => d.discordId === user.id);
    let keyName;
    if (keyEntry) {
        keyName = keyEntry[0];
        const d = keys[keyName];
        if (d.paused) {
            d.expiry = Date.now() + d.remaining + (hours * 3600 * 1000);
            d.paused = false;
        } else if (d.expiry === Infinity) {
            // Lifetime key, no change needed
        } else {
            d.expiry += (hours * 3600 * 1000);
        }
        d.warnSent = false;
        await saveKey(keyName);
    } else {
        keyName = generateBobKey();
        keys[keyName] = { expiry: Date.now() + (hours * 3600 * 1000), paused: false, remaining: 0, hwid: null, discordId: user.id, warnSent: false, isAutoKey: false };
        await saveKey(keyName);
    }

    await SaleHistory.create({ discordId: user.id, discordTag: user.tag, hours, price, label, keyName, couponUsed, confirmedBy: adminId });

    if (channel) {
        await channel.send(`✅ Pagamento de ${user.tag} confirmado por <@${adminId}>. Key \`${keyName}\` adicionada/atualizada com ${hours} horas.`);
    }
    user.send(`✅ Seu pagamento de ${label} foi confirmado! Sua key é \`${keyName}\`.`).catch(() => {});
}

setInterval(async () => {
    const now = Date.now();
    for (const [name, data] of Object.entries(keys)) {
        if (data.isAutoKey && data.expiry === 0 && data.paused) continue;
        if (data.expiry !== Infinity && !data.paused && data.expiry - now <= 0) {
            if (data.discordId) fetchUserFromAnyClient(data.discordId).then(user => {
                if (user) user.send(`⚠️ Sua key \`${name}\` expirou!`).catch(() => {});
            });
            await KeyModel.deleteOne({ name });
            delete keys[name];
            console.log(`[KEY] Key ${name} expirada e removida.`);
        } else if (data.expiry !== Infinity && !data.paused && data.expiry - now <= KEY_WARN_BEFORE_MS && !data.warnSent) {
            if (data.discordId) fetchUserFromAnyClient(data.discordId).then(user => {
                if (user) user.send(`⚠️ Sua key \`${name}\` irá expirar em menos de ${formatTime(KEY_WARN_BEFORE_MS)}!`).catch(() => {});
            });
            keys[name].warnSent = true;
            await saveKey(name);
        }
    }

    // Limpar IPs bloqueados expirados
    for (const ip in blockedIPs) {
        if (now > blockedIPs[ip]) {
            delete blockedIPs[ip];
        }
    }

    // Verificar pagamentos pendentes expirados
    const expiredPayments = await PendingPayment.find({ createdAt: { $lt: new Date(now - PENDING_EXPIRY_MS) } });
    for (const payment of expiredPayments) {
        if (!payment.warningSent) {
            fetchUserFromAnyClient(payment.discordId).then(user => {
                if (user) user.send(`⚠️ Seu pedido de ${payment.label} no valor de R$${payment.finalPrice || payment.price} expirou. Faça um novo pedido se ainda tiver interesse.`).catch(() => {});
            });
            await PendingPayment.updateOne({ _id: payment._id }, { warningSent: true });
        } else {
            await PendingPayment.deleteOne({ _id: payment._id });
            console.log(`[PAYMENT] Pedido de ${payment.discordTag} expirado e removido.`);
        }
    }
}, 60_000);

// Middleware para autenticação de administrador
async function isAdmin(member) {
    if (!member) return false;
    if (member.permissions.has("Administrator")) return true;
    const roles = member.roles.cache.map(r => r.id);
    return ADMIN_ROLE_IDS.some(id => roles.includes(id));
}

// Middleware para verificar o cabeçalho do cliente
function requireClientHeader(req, res, next) {
    const clientHeader = req.headers["x-bob-client"];
    const secret = req.headers["x-bob-secret"];

    if (clientHeader === CLIENT_HEADER && secret === SCRIPT_SECRET) {
        // Requisição do Joiner
        next();
    } else if (clientHeader === RAILWAY_CLIENT && secret === RAILWAY_SECRET) {
        // Requisição do Hopper
        next();
    } else {
        console.warn(`[AUTH] Acesso negado: Client-Header \'${clientHeader}\' ou Secret \'${secret}\' inválido.`);
        res.status(403).send("Forbidden");
    }
}

// Middleware para autenticação JWT (para o frontend)
function requireAuth(req, res, next) {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Token não fornecido" });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Token inválido" });
        req.user = user;
        next();
    });
}

// Middleware para autenticação de administrador para rotas
async function requireAdminAuth(req, res, next) {
    // Para rotas de API, o req.user vem do JWT, que contém o discordId e roles
    // Para interações do Discord, o isAdmin é chamado diretamente com o member
    if (!req.user || !ADMIN_ROLE_IDS.some(id => req.user.roles?.includes(id))) {
        // Se não houver req.user (ex: API key), ou se o usuário não tiver a role de admin
        // Precisamos de uma forma de verificar se a requisição é de um admin para API
        // Por enquanto, vamos assumir que o req.user.roles é preenchido pelo JWT se for um admin logado via Discord OAuth
        // Ou, para chamadas de API internas/scripts, podemos usar um secret adicional
        const secret = req.headers["x-admin-secret"];
        if (secret && safeCompare(secret, ADMIN_PASS)) {
            return next(); // Permite acesso se o secret de admin estiver correto
        } else {
            return res.status(403).json({ error: "Acesso negado. Requer privilégios de administrador ou secret válido." });
        }
    }
    next();
}

// --- EXPRESS APP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// CORS para permitir requisições do Vercel
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", FRONTEND_URL);
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-secret, x-client, x-script-secret, x-railway-secret");
    res.header("Access-Control-Allow-Credentials", "true");
    
    // Handle preflight
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

app.get("/", (req, res) => {
    res.json({ 
        status: "online", 
        message: "Bob Joiner API",
        frontend: "https://bob-html-one.vercel.app"
    });
});

// --- ROTAS DA API ---
app.post("/api/auth", requireClientHeader, async (req, res) => {
    const { key, hwid } = req.body;
    const keyName = findKey(key);

    if (!keyName) {
        console.warn(`[AUTH] Tentativa de login com key inexistente: ${key}`);
        return res.status(401).json({ error: "Key inválida ou expirada." });
    }

    const data = keys[keyName];
    const now = Date.now();

    if (data.paused) {
        console.warn(`[AUTH] Tentativa de login com key pausada: ${keyName}`);
        return res.status(401).json({ error: "Key pausada." });
    }

    if (data.expiry !== Infinity && data.expiry - now <= 0) {
        console.warn(`[AUTH] Tentativa de login com key expirada: ${keyName}`);
        await KeyModel.deleteOne({ name: keyName });
        delete keys[keyName];
        return res.status(401).json({ error: "Key expirada." });
    }

    if (data.hwid && data.hwid !== hwid) {
        if (kicked[keyName.toLowerCase()] && (now - kicked[keyName.toLowerCase()] < BLOCK_DURATION)) {
            console.warn(`[AUTH] Tentativa de login com HWID diferente (bloqueado): ${keyName}, HWID: ${hwid}`);
            return res.status(401).json({ error: "HWID diferente. Tente novamente em alguns minutos." });
        }
        console.warn(`[AUTH] Tentativa de login com HWID diferente: ${keyName}, HWID antigo: ${data.hwid}, HWID novo: ${hwid}`);
        kicked[keyName.toLowerCase()] = now;
        return res.status(401).json({ error: "HWID diferente. Se o erro persistir, resete seu HWID no painel." });
    }

    if (!data.hwid) {
        keys[keyName].hwid = hwid;
        await saveKey(keyName);
        console.log(`[AUTH] HWID definido para key ${keyName}: ${hwid}`);
    }

    // Atualiza o discordId se a key for auto-gerada e não tiver um discordId associado
    if (data.isAutoKey && !data.discordId && req.user && req.user.discordId) {
        keys[keyName].discordId = req.user.discordId;
        await saveKey(keyName);
        console.log(`[AUTH] Key auto-gerada ${keyName} associada ao Discord ID ${req.user.discordId}`);
    }

    const timeLeft = data.expiry === Infinity ? Infinity : data.expiry - now;
    res.json({ ok: true, timeLeft, isLifetime: data.expiry === Infinity });
});

app.post("/api/presence", requireClientHeader, async (req, res) => {
    const { key, name, jobId } = req.body;
    const keyName = findKey(key);
    if (!keyName) return res.status(401).json({ error: "Key inválida." });

    presence[keyName] = { name, jobId, lastSeen: Date.now(), key: keyName };
    io.emit("presence", { key: keyName, name, jobId, lastSeen: Date.now() });
    res.status(200).send("OK");
});

app.post("/api/brainrot", requireClientHeader, async (req, res) => {
    const { brainrot, name, jobId, value, owner, players, maxPlayers, placeId, inDuel } = req.body;
    pushBrainrot({ 
        id: Date.now().toString(), 
        brainrot, 
        name, 
        jobId, 
        value, 
        owner,
        players: players || "?",
        maxPlayers: maxPlayers || "?",
        placeId: placeId || "109983668079237",
        inDuel: inDuel || false
    });
    res.status(200).send("OK");
});

app.get("/api/latest", requireClientHeader, (req, res) => {
    const latest = brainrots.length > 0 ? brainrots[brainrots.length - 1] : null;
    if (latest) {
        res.json(latest);
    } else {
        res.json({ id: null });
    }
});

app.post("/api/clear", requireAdminAuth, async (req, res) => {
    brainrots.length = 0;
    res.status(200).send("OK");
});

app.post("/api/log", requireClientHeader, async (req, res) => {
    const { message } = req.body;
    console.log(`[CLIENT LOG] ${message}`);
    res.status(200).send("OK");
});

app.post("/api/update-key-status", requireClientHeader, async (req, res) => {
    const { key, paused, remaining } = req.body;
    const keyName = findKey(key);
    if (!keyName) return res.status(401).json({ error: "Key inválida." });

    keys[keyName].paused = paused;
    keys[keyName].remaining = remaining;
    await saveKey(keyName);
    res.status(200).send("OK");
});

// ─── DISCORD OAUTH2 ───────────────────────────────────────────────────────────
app.get("/auth/discord", (req, res) => {
    console.log("[AUTH] DISCORD_CLIENT_ID:", DISCORD_CLIENT_ID);
    console.log("[AUTH] REDIRECT_URI:", REDIRECT_URI);
    const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: "identify" });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get("/auth/callback", async (req, res) => {
    const { code } = req.query;
    console.log("[AUTH CALLBACK] Recebido code:", code ? "SIM" : "NÃO");
    if (!code) return res.redirect(`${FRONTEND_URL}?error=no_code`);
    try {
        console.log("[AUTH CALLBACK] Enviando requisição para Discord...");
        console.log("[AUTH CALLBACK] client_id:", DISCORD_CLIENT_ID);
        console.log("[AUTH CALLBACK] redirect_uri:", REDIRECT_URI);
        
        const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
        });
        
        console.log("[AUTH CALLBACK] Status da resposta:", tokenRes.status);
        const tokenData = await tokenRes.json();
        console.log("[AUTH CALLBACK] Token data completo:", JSON.stringify(tokenData, null, 2));
        
        if (!tokenData.access_token) {
            console.error("[AUTH CALLBACK] ❌ Sem access_token! Erro:", tokenData.error, tokenData.error_description);
            return res.redirect(`${FRONTEND_URL}?error=token`);
        }
        const userRes = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
        const discordUser = await userRes.json();
        console.log("[AUTH CALLBACK] Discord user:", discordUser.username);
        
        await User.findOneAndUpdate({ discordId: discordUser.id }, { discordTag: discordUser.username, avatar: discordUser.avatar }, { upsert: true, new: true });
        const autoKeyName = await createAutoKeyForUser(discordUser.id, discordUser.username);
        console.log(`[AUTH] Key do usuário ${discordUser.username}: ${autoKeyName}`);
        
        const token = jwt.sign({ discordId: discordUser.id, discordTag: discordUser.username, avatar: discordUser.avatar }, JWT_SECRET, { expiresIn: "7d" });
        const redirectUrl = `${FRONTEND_URL}/?token=${token}`;
        console.log("[AUTH CALLBACK] ✅ Redirecionando para:", redirectUrl);
        res.redirect(redirectUrl);
    } catch (e) { console.error("[AUTH]", e.message); res.redirect(`${FRONTEND_URL}?error=auth_failed`); }
});

app.get("/auth/logout", (req, res) => { res.json({ ok: true }); });

app.get("/auth/me", requireAuth, async (req, res) => {
    const user = await User.findOne({ discordId: req.user.discordId });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    const keyEntry = Object.entries(keys).find(([, d]) => d.discordId === user.discordId);
    let keyData = null;
    if (keyEntry) {
        const [keyName, kd] = keyEntry;
        const now = Date.now();
        const hasTime = kd.expiry === Infinity || (!kd.paused && kd.expiry - now > 0) || (kd.paused && kd.remaining > 0);
        keyData = {
            name: keyName,
            expiry: kd.expiry === Infinity ? null : kd.expiry,
            expiryMs: kd.expiry === Infinity ? null : kd.expiry - now,
            paused: kd.paused,
            isAutoKey: kd.isAutoKey || false,
            hasTime,
            timeLeft: kd.expiry === Infinity ? "Lifetime" : kd.paused ? formatTime(kd.remaining) : formatTime(kd.expiry - now),
        };
    }
    res.json({ discordId: user.discordId, discordTag: user.discordTag, avatar: user.avatar, balance: user.balance, key: keyData, plans: PLANS.filter(p => p.active) });
});

app.get("/api/online", (req, res) => {
    const now = Date.now();
    const onlineByKey = {};
    for (const [, info] of Object.entries(presence)) {
        if (now - info.lastSeen > ONLINE_STALE_MS) continue;
        const keyName = info.key ? findKey(info.key) : null;
        if (keyName && !onlineByKey[keyName]) onlineByKey[keyName] = { name: info.name || "Unknown" };
    }
    const onlineUsers = [];
    for (const [keyName, info] of Object.entries(onlineByKey)) {
        const d = keys[keyName];
        if (!d) continue;
        onlineUsers.push({
            keyPrefix: keyName.substring(0, 7) + "***",
            robloxName: info.name,
            expiryMs: d.expiry === Infinity ? null : d.expiry - now,
            isLifetime: d.expiry === Infinity,
            paused: d.paused,
        });
    }
    res.json({ online: onlineUsers, count: onlineUsers.length, maxSlots: MAX_SLOTS, slotsUsed: onlineUsers.length, slotsAvailable: Math.max(0, MAX_SLOTS - onlineUsers.length), serverTime: now });
});

app.post("/api/buy", requireAuth, async (req, res) => {
    const { planValue } = req.body;
    const plan = PLANS.find(p => p.value === planValue && p.active);
    if (!plan) return res.status(400).json({ error: "Plano inválido" });
    const user = await User.findOne({ discordId: req.user.discordId });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    if (user.balance < plan.price) return res.status(400).json({ error: "Saldo insuficiente" });
    user.balance -= plan.price; await user.save();
    await confirmarPagamento({ id: user.discordId, tag: user.discordTag }, plan.hours, null, "auto", plan.price, plan.label, null);
    await Transaction.create({ discordId: user.discordId, type: "purchase", amount: -plan.price, description: `Compra: ${plan.label}` });
    res.json({ ok: true, newBalance: user.balance, plan: plan.label });
});

app.get("/api/transactions", requireAuth, async (req, res) => {
    const transactions = await Transaction.find({ discordId: req.user.discordId }).sort({ createdAt: -1 }).limit(20);
    res.json(transactions);
});

// ─── RECARGA PIX MANUAL ───────────────────────────────────────────────────────
app.post("/api/recharge/create", requireAuth, async (req, res) => {
    const { amount } = req.body;
    if (!amount || isNaN(amount) || amount < MIN_RECHARGE) {
        return res.status(400).json({ error: `Valor mínimo é R$${MIN_RECHARGE}` });
    }
    const user = await User.findOne({ discordId: req.user.discordId });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    // Cancela recargas pendentes antigas do mesmo usuário
    await Recharge.updateMany({ discordId: req.user.discordId, status: "pending" }, { status: "cancelled" });

    const code = generateRechargeCode();
    await Recharge.create({ discordId: req.user.discordId, discordTag: user.discordTag, amount: Number(amount), code });

    // Notifica no Discord
    try {
        const ch = await clientPayment.channels.fetch(RECHARGE_CHANNEL);
        if (ch) {
            const embed = new EmbedBuilder()
                .setColor(COLORS.info)
                .setTitle("💸 Nova Solicitação de Recarga")
                .addFields(
                    { name: "👤 Usuário", value: `${user.discordTag} (<@${user.discordId}>)`, inline: true },
                    { name: "💰 Valor", value: `**R$${Number(amount).toFixed(2)}**`, inline: true },
                    { name: "🔑 Código", value: `\`${code}\``, inline: true },
                    { name: "📋 Instrução", value: `Verifique o Pix recebido com o código **${code}** na descrição e confirme abaixo.`, inline: false }
                )
                .setTimestamp();
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`recharge_confirm_${code}`).setLabel("✅ Confirmar Pagamento").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`recharge_cancel_${code}`).setLabel("❌ Cancelar").setStyle(ButtonStyle.Danger),
            );
            await ch.send({ embeds: [embed], components: [row] });
        }
    } catch(e) { console.error("[RECHARGE] Erro ao notificar Discord:", e.message); }

    res.json({ ok: true, code, amount: Number(amount), pixKey: PIX_KEY, pixName: PIX_NAME });
});

app.get("/api/recharge/status", requireAuth, async (req, res) => {
    const recharge = await Recharge.findOne({ discordId: req.user.discordId, status: "pending" }).sort({ createdAt: -1 });
    res.json(recharge ? { pending: true, code: recharge.code, amount: recharge.amount, createdAt: recharge.createdAt } : { pending: false });
});

// ─── PAGAMENTO AUTOMÁTICO (GOATPAY) ───────────────────────────────────────────
const GOATPAY_API_KEY = process.env.GOATPAY_API_KEY || "";
const GOATPAY_API_URL = "https://api.goatpay.com.br/v1";
const GOATPAY_WEBHOOK_SECRET = process.env.GOATPAY_WEBHOOK_SECRET || "";
const MIN_DEPOSIT = 1.00; // R$ 1,00

app.post("/api/payment/create", requireAuth, async (req, res) => {
    const { amount, method, currency } = req.body; // method: 'pix' ou 'crypto', currency: 'btc' ou 'ltc'
    
    if (!amount || isNaN(amount) || amount < MIN_DEPOSIT) {
        return res.status(400).json({ error: `Valor mínimo é R$${MIN_DEPOSIT.toFixed(2)}` });
    }
    
    if (!['pix', 'crypto'].includes(method)) {
        return res.status(400).json({ error: "Método inválido. Use 'pix' ou 'crypto'" });
    }
    
    if (method === 'crypto' && !['btc', 'ltc'].includes(currency)) {
        return res.status(400).json({ error: "Moeda inválida. Use 'btc' ou 'ltc'" });
    }
    
    const user = await User.findOne({ discordId: req.user.discordId });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    
    try {
        // Cancela pagamentos pendentes antigos
        await Payment.updateMany({ 
            discordId: req.user.discordId, 
            status: "pending",
            method 
        }, { status: "cancelled" });
        
        let goatpayData;
        
        if (method === 'pix') {
            // Cria cobrança PIX no GoatPay
            console.log("[PAYMENT] Criando cobrança PIX no GoatPay...");
            console.log("[PAYMENT] Valor solicitado:", Number(amount), "BRL");
            
            // Usa timestamp único para evitar duplicatas no GoatPay
            const uniqueRef = `${req.user.discordId}_${Date.now()}`;
            
            const goatpayResponse = await fetch(`${GOATPAY_API_URL}/payment-pix/create`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-Key": GOATPAY_API_KEY
                },
                body: JSON.stringify({
                    amount: Number(amount),
                    description: `Depósito ${Number(amount).toFixed(2)} - ${user.discordTag}`,
                    externalReference: uniqueRef,
                    coverFee: false
                })
            });
            
            const responseData = await goatpayResponse.json();
            console.log("[PAYMENT] Resposta GoatPay:", responseData);
            
            if (!responseData.success) {
                return res.status(500).json({ error: responseData.message || "Erro ao criar pagamento" });
            }
            
            goatpayData = responseData.data;
            
            // Salva ou atualiza no banco (usando upsert para evitar duplicatas)
            const payment = await Payment.findOneAndUpdate(
                { gatewayId: goatpayData.id },
                {
                    discordId: req.user.discordId,
                    discordTag: user.discordTag,
                    amount: Number(amount),
                    method,
                    gatewayId: goatpayData.id,
                    pixCode: goatpayData.copyPaste,
                    pixQrCode: goatpayData.qrCodeBase64?.replace('data:image/png;base64,', ''),
                    expiresAt: new Date(goatpayData.expiresAt),
                    status: "pending"
                },
                { upsert: true, new: true }
            );
            
            res.json({
                ok: true,
                paymentId: payment._id,
                gatewayId: payment.gatewayId,
                method: payment.method,
                amount: payment.amount,
                pixCode: payment.pixCode,
                pixQrCode: payment.pixQrCode,
                expiresAt: payment.expiresAt
            });
            
        } else if (method === 'crypto') {
            // Mapeia currency para payCurrency do GoatPay
            const payCurrencyMap = {
                'btc': 'btc',
                'ltc': 'ltc'
            };
            const payCurrency = payCurrencyMap[currency];
            
            console.log("[PAYMENT] Criando depósito cripto no GoatPay...");
            
            // Usa timestamp único para evitar duplicatas no GoatPay
            const uniqueRef = `${req.user.discordId}_${Date.now()}`;
            
            const goatpayResponse = await fetch(`${GOATPAY_API_URL}/payment-crypto/create`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-Key": GOATPAY_API_KEY
                },
                body: JSON.stringify({
                    amount: Number(amount),
                    payCurrency: payCurrency,
                    description: `Depósito ${currency.toUpperCase()} ${Number(amount).toFixed(2)} - ${user.discordTag}`,
                    externalReference: uniqueRef,
                    coverFee: false
                })
            });
            
            const responseData = await goatpayResponse.json();
            console.log("[PAYMENT] Resposta GoatPay Cripto:", responseData);
            
            if (!responseData.success) {
                return res.status(500).json({ error: responseData.message || "Erro ao criar pagamento cripto" });
            }
            
            goatpayData = responseData.data;
            
            // Salva ou atualiza no banco (usando upsert para evitar duplicatas)
            const payment = await Payment.findOneAndUpdate(
                { gatewayId: goatpayData.id },
                {
                    discordId: req.user.discordId,
                    discordTag: user.discordTag,
                    amount: Number(amount),
                    method,
                    gatewayId: goatpayData.id,
                    cryptoAddress: goatpayData.payAddress,
                    cryptoCurrency: currency.toUpperCase(),
                    cryptoAmount: goatpayData.payAmount,
                    expiresAt: new Date(goatpayData.expiresAt),
                    status: "pending"
                },
                { upsert: true, new: true }
            );
            
            res.json({
                ok: true,
                paymentId: payment._id,
                gatewayId: payment.gatewayId,
                method: payment.method,
                amount: payment.amount,
                cryptoAddress: payment.cryptoAddress,
                cryptoCurrency: payment.cryptoCurrency,
                cryptoAmount: payment.cryptoAmount,
                expiresAt: payment.expiresAt
            });
        }
        
    } catch (e) {
        console.error("[PAYMENT] Erro ao criar pagamento:", e.message);
        res.status(500).json({ error: "Erro ao processar pagamento" });
    }
});

app.get("/api/payment/status/:paymentId", requireAuth, async (req, res) => {
    const payment = await Payment.findOne({ _id: req.params.paymentId, discordId: req.user.discordId });
    if (!payment) return res.status(404).json({ error: "Pagamento não encontrado" });
    
    res.json({
        status: payment.status,
        amount: payment.amount,
        method: payment.method,
        createdAt: payment.createdAt,
        paidAt: payment.paidAt,
        expiresAt: payment.expiresAt
    });
});

// Webhook do GoatPay (chamado automaticamente quando o pagamento é confirmado)
app.post("/api/payment/webhook", async (req, res) => {
    console.log("[GOATPAY WEBHOOK] Recebido:", JSON.stringify(req.body, null, 2));
    console.log("[GOATPAY WEBHOOK] Headers:", req.headers);
    
    try {
        // Verifica assinatura HMAC do GoatPay
        const signature = req.headers['x-goatpay-signature'];
        if (GOATPAY_WEBHOOK_SECRET) {
            const rawBody = JSON.stringify(req.body);
            const expectedSignature = 'sha256=' + crypto.createHmac('sha256', GOATPAY_WEBHOOK_SECRET)
                .update(rawBody)
                .digest('hex');
            
            if (signature !== expectedSignature) {
                console.error("[GOATPAY WEBHOOK] ❌ Assinatura inválida!");
                return res.status(401).json({ error: "Assinatura inválida" });
            }
        }
        
        const { id: deliveryId, event, data } = req.body;
        
        // Idempotência: verifica se já processou essa entrega
        if (await Payment.findOne({ 'webhookDeliveryId': deliveryId })) {
            console.log("[GOATPAY WEBHOOK] Entrega já processada:", deliveryId);
            return res.status(200).json({ ok: true });
        }
        
        // Processa evento payment.paid (PIX)
        if (event === 'payment.paid' && data.type === 'PIX_IN') {
            const payment = await Payment.findOne({ gatewayId: data.id, status: "pending" });
            
            if (!payment) {
                console.log("[GOATPAY WEBHOOK] Pagamento PIX não encontrado ou já processado:", data.id);
                return res.status(200).json({ ok: true });
            }
            
            // Atualiza status do pagamento
            payment.status = "paid";
            payment.paidAt = new Date(data.completedAt || Date.now());
            payment.webhookDeliveryId = deliveryId;
            await payment.save();
            
            // Adiciona saldo ao usuário
            const user = await User.findOne({ discordId: payment.discordId });
            if (user) {
                user.balance += payment.amount;
                await user.save();
                
                await Transaction.create({
                    discordId: payment.discordId,
                    type: "deposit",
                    amount: payment.amount,
                    description: `Depósito via PIX - ID: ${data.id}`
                });
                
                console.log(`[GOATPAY WEBHOOK] ✅ Saldo adicionado! Usuário: ${user.discordTag}, Valor: R$${payment.amount}`);
                
                // Notifica no Discord
                try {
                    const ch = await clientPayment.channels.fetch(RECHARGE_CHANNEL);
                    if (ch) {
                        const embed = new EmbedBuilder()
                            .setColor(COLORS.success)
                            .setTitle("💰 Pagamento PIX Confirmado (GoatPay)")
                            .addFields(
                                { name: "👤 Usuário", value: `${user.discordTag} (<@${payment.discordId}>)`, inline: true },
                                { name: "💵 Valor", value: `**R$${payment.amount.toFixed(2)}**`, inline: true },
                                { name: "💳 Método", value: "PIX", inline: true },
                                { name: "🆔 Transaction ID", value: `\`${data.id}\``, inline: false },
                                { name: "🔗 End-to-End", value: `\`${data.endToEndId || 'N/A'}\``, inline: false },
                                { name: "💰 Novo Saldo", value: `**R$${user.balance.toFixed(2)}**`, inline: false }
                            )
                            .setTimestamp();
                        await ch.send({ embeds: [embed] });
                    }
                } catch(e) { console.error("[GOATPAY WEBHOOK] Erro ao notificar Discord:", e.message); }
            }
        }
        
        // Processa evento payment.crypto.paid (CRIPTO)
        if (event === 'payment.crypto.paid' && data.type === 'CRYPTO_IN') {
            const payment = await Payment.findOne({ gatewayId: data.id, status: "pending" });
            
            if (!payment) {
                console.log("[GOATPAY WEBHOOK] Pagamento CRIPTO não encontrado ou já processado:", data.id);
                return res.status(200).json({ ok: true });
            }
            
            // Atualiza status do pagamento
            payment.status = "paid";
            payment.paidAt = new Date(data.completedAt || Date.now());
            payment.webhookDeliveryId = deliveryId;
            await payment.save();
            
            // Adiciona saldo ao usuário
            const user = await User.findOne({ discordId: payment.discordId });
            if (user) {
                user.balance += payment.amount;
                await user.save();
                
                await Transaction.create({
                    discordId: payment.discordId,
                    type: "deposit",
                    amount: payment.amount,
                    description: `Depósito via ${payment.cryptoCurrency} - ID: ${data.id}`
                });
                
                console.log(`[GOATPAY WEBHOOK] ✅ Saldo cripto adicionado! Usuário: ${user.discordTag}, Valor: R$${payment.amount}`);
                
                // Notifica no Discord
                try {
                    const ch = await clientPayment.channels.fetch(RECHARGE_CHANNEL);
                    if (ch) {
                        const embed = new EmbedBuilder()
                            .setColor(COLORS.success)
                            .setTitle("🪙 Pagamento CRIPTO Confirmado (GoatPay)")
                            .addFields(
                                { name: "👤 Usuário", value: `${user.discordTag} (<@${payment.discordId}>)`, inline: true },
                                { name: "💵 Valor (BRL)", value: `**R$${payment.amount.toFixed(2)}**`, inline: true },
                                { name: "💳 Moeda", value: payment.cryptoCurrency, inline: true },
                                { name: "💎 Quantidade", value: `${payment.cryptoAmount} ${payment.cryptoCurrency}`, inline: true },
                                { name: "📬 Endereço", value: `\`${payment.cryptoAddress}\``, inline: false },
                                { name: "🆔 Transaction ID", value: `\`${data.id}\``, inline: false },
                                { name: "💰 Novo Saldo", value: `**R$${user.balance.toFixed(2)}**`, inline: false }
                            )
                            .setTimestamp();
                        await ch.send({ embeds: [embed] });
                    }
                } catch(e) { console.error("[GOATPAY WEBHOOK] Erro ao notificar Discord:", e.message); }
            }
        }
        
        res.status(200).json({ ok: true });
        
    } catch (e) {
        console.error("[GOATPAY WEBHOOK] Erro:", e.message);
        res.status(500).json({ error: "Erro ao processar webhook" });
    }
});

app.post("/api/admin/balance", requireAdminAuth, async (req, res) => {
    const { discordId, amount, description } = req.body;
    if (!discordId || !amount) return res.status(400).json({ error: "Dados inválidos" });
    const user = await User.findOneAndUpdate({ discordId }, { $inc: { balance: Number(amount) } }, { new: true });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado. Peça para ele logar primeiro." });
    await Transaction.create({ discordId, type: "deposit", amount: Number(amount), description: description || "Depósito admin" });
    res.json({ ok: true, newBalance: user.balance, discordTag: user.discordTag });
});

app.post("/api/admin/slots", requireAdminAuth, async (req, res) => {
    const { maxSlots } = req.body;
    if (!maxSlots || isNaN(maxSlots) || maxSlots < 1) return res.status(400).json({ error: "Valor inválido" });
    process.env.MAX_SLOTS = String(maxSlots);
    res.json({ ok: true, maxSlots: parseInt(maxSlots) });
});

app.get("/api/admin/users", requireAdminAuth, async (req, res) => {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users.map(u => { const keyEntry = Object.entries(keys).find(([, d]) => d.discordId === u.discordId); return { discordId: u.discordId, discordTag: u.discordTag, balance: u.balance, hasKey: !!keyEntry, keyName: keyEntry?.[0] || null, createdAt: u.createdAt }; }));
});

// ─── ONLINE MONITORING ───────────────────────────────────────────────────────
const onlineIntervals = {};

function buildOnlineEmbed() {
    const now = Date.now();
    const onlineByKey = {};
    for (const [k, info] of Object.entries(presence)) {
        if (now - info.lastSeen > ONLINE_STALE_MS) continue;
        const keyName = findKey(k);
        if (keyName && !onlineByKey[keyName]) onlineByKey[keyName] = { name: info.name, lastSeen: info.lastSeen };
    }

    const onlineList = Object.entries(onlineByKey).map(([k, info]) => {
        const d = keys[k];
        const timeLeft = d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - now);
        const discordTag = d.discordId ? `<@${d.discordId}>` : "Desconhecido";
        return `✅ **${info.name}** (${discordTag}) — \`${timeLeft}\``;
    });

    const embed = new EmbedBuilder()
        .setTitle(`🟢 Players Online — ${onlineList.length}/${MAX_SLOTS}`)
        .setColor(COLORS.success)
        .setTimestamp();

    if (onlineList.length > 0) {
        embed.setDescription(onlineList.join("\n").substring(0, 4000));
    } else {
        embed.setDescription("Nenhum player online no momento.");
    }

    return embed;
}

function startOnlineInterval(channelId, message) {
    if (onlineIntervals[channelId]) clearInterval(onlineIntervals[channelId]);
    onlineIntervals[channelId] = setInterval(async () => {
        try {
            await message.edit({ embeds: [buildOnlineEmbed()] });
        } catch (e) {
            console.error("[ONLINE] Erro ao atualizar mensagem:", e.message);
            clearInterval(onlineIntervals[channelId]);
            delete onlineIntervals[channelId];
        }
    }, 15000);
}

function stopOnlineInterval(channelId) {
    if (onlineIntervals[channelId]) {
        clearInterval(onlineIntervals[channelId]);
        delete onlineIntervals[channelId];
    }
}

// ─── BOTS (mesmos do original) ────────────────────────────────────────────────
clientNotifier.on("ready", () => console.log(`[NOTIFIER] Online: ${clientNotifier.user.tag}`));
clientNotifier.on("messageCreate", async (message) => {
    if (message.author.bot && message.author.id === clientNotifier.user?.id) return;
    if (message.channel.id !== DISCORD_CHANNEL_ID) return;
    if (!message.embeds.length) return;
    const embed = message.embeds[0]; let jobId = null, value = "0", players = "N/A";
    for (const f of (embed.fields || [])) { const fn = f.name.toLowerCase(); if (fn.includes("jobid") || fn.includes("job")) jobId = f.value.trim(); if (fn.includes("value") || fn.includes("valor")) value = f.value.trim(); if (fn.includes("player")) players = f.value.trim(); }
    pushBrainrot({ id: Date.now().toString(), brainrot: embed.title || "Bob!", name: embed.title || "Brainrot", jobId: xorObfuscate(jobId), value, players });
});

clientLogs.on("ready", async () => { console.log(`[LOGS] Online: ${clientLogs.user.tag}`); await sendLogsPanel(); });

function buildLogsEmbed() { return new EmbedBuilder().setTitle("⚙️ Bob Joiner — Painel Administrativo").setColor(COLORS.primary).setDescription("Gerencie keys, pagamentos, cupons e planos.").setTimestamp(); }
function buildLogsRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_create").setLabel("Criar Key").setEmoji("🔑").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_lifetime").setLabel("Lifetime").setEmoji("♾️").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_revoke").setLabel("Revogar").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("logs_pause").setLabel("Pausar").setEmoji("⏸️").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_reset").setLabel("Reset HWID").setEmoji("🔄").setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_addtime").setLabel("Add Tempo").setEmoji("⏱️").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_setexpiry").setLabel("Set Expiração").setEmoji("📅").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_transfer").setLabel("Transfer").setEmoji("🔀").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_sethwid").setLabel("Set HWID").setEmoji("💻").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_lookup").setLabel("Lookup").setEmoji("🔍").setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_online").setLabel("Online").setEmoji("🟢").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_stoponline").setLabel("Stop Online").setEmoji("🛑").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("logs_stats").setLabel("Stats").setEmoji("📊").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_listkeys").setLabel("Listar Keys").setEmoji("📋").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_jobids").setLabel("JobIDs").setEmoji("🎮").setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_pendentes").setLabel("Pendentes").setEmoji("⏳").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_confirmar_manual").setLabel("Confirmar Pgto").setEmoji("💳").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_cancelar_pedido").setLabel("Cancelar Pedido").setEmoji("❌").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("logs_vendas").setLabel("Vendas").setEmoji("💰").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_historico").setLabel("Histórico").setEmoji("📜").setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_coupon_create").setLabel("Criar Cupom").setEmoji("🎟️").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_coupon_list").setLabel("Listar Cupons").setEmoji("🎫").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_plan_edit").setLabel("Editar Plano").setEmoji("📦").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_blocked").setLabel("IPs Bloqueados").setEmoji("🔒").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_unblock").setLabel("Desbloquear IP").setEmoji("🔓").setStyle(ButtonStyle.Secondary)
        )
    ];
}

async function sendLogsPanel() {
    if (!LOGS_CHANNEL_ID) return;
    try {
        const channel = await clientLogs.channels.fetch(LOGS_CHANNEL_ID);
        if (!channel || channel.type !== ChannelType.GuildText) return;

        const embed = buildLogsEmbed();
        const rows = buildLogsRows();

        const messages = await channel.messages.fetch({ limit: 10 });
        const existingMessage = messages.find(msg =>
            msg.author.id === clientLogs.user.id &&
            msg.embeds.length > 0 &&
            msg.embeds[0].title === "⚙️ Bob Joiner — Painel Administrativo"
        );

        if (existingMessage) {
            await existingMessage.edit({ embeds: [embed], components: rows });
            console.log(`[LOGS] Painel administrativo atualizado no canal ${channel.name}`);
        } else {
            await channel.send({ embeds: [embed], components: rows });
            console.log(`[LOGS] Painel administrativo enviado para o canal ${channel.name}`);
        }
    } catch (e) { console.error("[LOGS] Erro ao enviar/atualizar painel administrativo:", e.message); }
}

clientLogs.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isModalSubmit()) { await handleLogsModal(interaction); return; }
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("logs_") && !interaction.customId.startsWith("pay_")) return;
    if (!await isAdmin(interaction.member)) { await interaction.reply({ content: "❌ Sem permissão.", ephemeral: true }); return; }
    const id = interaction.customId;
    if (id === "logs_online") { await interaction.deferReply({ ephemeral: false }); const sentMsg = await interaction.editReply({ embeds: [buildOnlineEmbed()] }); startOnlineInterval(interaction.channelId, sentMsg); return; }
    if (id === "logs_stoponline") { await interaction.deferReply({ ephemeral: true }); stopOnlineInterval(interaction.channelId); await interaction.editReply({ content: "⏹️ Parado." }); return; }
    if (id === "logs_stats") { await interaction.deferReply({ ephemeral: true }); const all = Object.values(keys).filter(k => !k.isAutoKey || k.remaining > 0), active = all.filter(k => !k.paused && (k.expiry === Infinity || k.expiry - Date.now() > 0)), paused = all.filter(k => k.paused), lt = all.filter(k => k.expiry === Infinity), online = Object.values(presence).filter(p => Date.now() - p.lastSeen < ONLINE_STALE_MS); const pendentes = await PendingPayment.countDocuments(), totalVendas = await SaleHistory.aggregate([{ $group: { _id: null, total: { $sum: "$price" } } }]); await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("📊 Stats").setColor(COLORS.primary).addFields({ name: "🔑 Total", value: `\`${all.length}\``, inline: true },{ name: "✅ Ativas", value: `\`${active.length}\``, inline: true },{ name: "⏸️ Pausadas", value: `\`${paused.length}\``, inline: true },{ name: "♾️ Lifetime", value: `\`${lt.length}\``, inline: true },{ name: "🟢 Online", value: `\`${online.length}\``, inline: true },{ name: "⏳ Pendentes", value: `\`${pendentes}\``, inline: true },{ name: "💰 Receita", value: `\`R$${totalVendas[0]?.total || 0}\``, inline: true }).setTimestamp()] }); return; }
    if (id === "logs_listkeys") { await interaction.deferReply({ ephemeral: true }); const ks = Object.keys(keys); if (!ks.length) { await interaction.editReply({ content: "Nenhuma key." }); return; } const now = Date.now(); await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("🔑 Keys").setColor(COLORS.primary).setDescription(ks.map(k => { const d = keys[k], t = d.paused ? d.remaining : (d.expiry === Infinity ? Infinity : d.expiry - now); return `• \`${k}\`: \`${formatTime(t)}\` ${d.paused ? "⏸️" : "✅"} ${d.discordId ? `<@${d.discordId}>` : ""}`; }).join("\n").substring(0, 4000)).setTimestamp()] }); return; }
    if (id === "logs_jobids") { await interaction.deferReply({ ephemeral: true }); const entries = Object.entries(userJobIds); if (!entries.length) { await interaction.editReply({ content: "Nenhum JobID." }); return; } await interaction.editReply({ content: "🎮 **JobIDs:**\n" + entries.map(([n, j]) => `• **${n}**: \`${j}\``).join("\n") }); return; }
    if (id === "logs_blocked") { await interaction.deferReply({ ephemeral: true }); const now = Date.now(), active = Object.entries(blockedIPs).filter(([, u]) => now < u); if (!active.length) { await interaction.editReply({ content: "Nenhum IP bloqueado." }); return; } await interaction.editReply({ content: "🔒 **IPs:**\n" + active.map(([ip, u]) => `• \`${ip}\` — ${Math.ceil((u - now) / 1000)}s`).join("\n") }); return; }
    if (id === "logs_pendentes") { await interaction.deferReply({ ephemeral: true }); const pendentes = await PendingPayment.find().sort({ createdAt: -1 }); if (!pendentes.length) { await interaction.editReply({ content: "✅ Nenhum pendente!" }); return; } const now = Date.now(); await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle(`⏳ Pendentes (${pendentes.length})`).setDescription(pendentes.map(p => { const rem = PENDING_EXPIRY_MS - (now - new Date(p.createdAt).getTime()); return `• **${p.discordTag}** — ${p.label} R$${p.finalPrice || p.price} — ⏳ ${rem > 0 ? formatTimeShort(rem) : "expirando..."}`; }).join("\n")).setTimestamp()] }); return; }
    if (id === "logs_confirmar_manual") { await interaction.showModal(new ModalBuilder().setCustomId("modal_pay_confirm").setTitle("Confirmar Pagamento").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_id").setLabel("ID Discord:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("horas").setLabel("Horas:").setStyle(TextInputStyle.Short).setRequired(true)))); return; }
    if (id === "logs_cancelar_pedido") { await interaction.showModal(new ModalBuilder().setCustomId("modal_cancel_pedido").setTitle("Cancelar Pedido").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_id").setLabel("ID Discord:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("motivo").setLabel("Motivo:").setStyle(TextInputStyle.Short).setRequired(false)))); return; }
    if (id === "logs_vendas") { await interaction.deferReply({ ephemeral: true }); const sales = await SaleHistory.find().sort({ confirmedAt: -1 }), totalR = sales.reduce((a, s) => a + (s.price || 0), 0), hoje = sales.filter(s => new Date(s.confirmedAt).toDateString() === new Date().toDateString()), hojeR = hoje.reduce((a, s) => a + (s.price || 0), 0); await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("💰 Vendas").addFields({ name: "📦 Total", value: `\`${sales.length}\``, inline: true },{ name: "💰 Receita", value: `\`R$${totalR}\``, inline: true },{ name: "📅 Hoje", value: `\`${hoje.length}\``, inline: true },{ name: "💵 Hoje R$", value: `\`R$${hojeR}\``, inline: true }).setTimestamp()] }); return; }
    if (id === "logs_historico") { await interaction.deferReply({ ephemeral: true }); const sales = await SaleHistory.find().sort({ confirmedAt: -1 }).limit(20); if (!sales.length) { await interaction.editReply({ content: "Nenhuma venda." }); return; } await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("📜 Histórico").setDescription(sales.map(s => `• <@${s.discordId}> — **${s.label}** R$${s.price} — \`${s.keyName}\` — ${tsRelative(s.confirmedAt)}`).join("\n").substring(0, 4000)).setTimestamp()] }); return; }
    if (id === "logs_coupon_create") { await interaction.showModal(new ModalBuilder().setCustomId("modal_coupon_create").setTitle("🎟️ Criar Cupom").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("code").setLabel("Código:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("discount").setLabel("Desconto:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("type").setLabel("Tipo (percent/fixed):").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("maxuses").setLabel("Máx usos:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha:").setStyle(TextInputStyle.Short).setRequired(true)))); return; }
    if (id === "logs_coupon_list") { await interaction.deferReply({ ephemeral: true }); const coupons = await Coupon.find({ active: true }); if (!coupons.length) { await interaction.editReply({ content: "Nenhum cupom." }); return; } await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.gold).setTitle("🎟️ Cupons").setDescription(coupons.map(c => `• \`${c.code}\` — **${c.discount}${c.type === "percent" ? "%" : " R$"}** — ${c.usedCount}/${c.maxUses}`).join("\n")).setTimestamp()] }); return; }
    if (id === "logs_plan_edit") { await interaction.showModal(new ModalBuilder().setCustomId("modal_plan_edit").setTitle("📦 Editar Plano").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("value").setLabel("ID do plano:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("price").setLabel("Preço:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("active").setLabel("Ativo? (sim/nao):").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha:").setStyle(TextInputStyle.Short).setRequired(true)))); return; }
    if (id.startsWith("pay_confirm_")) { await interaction.deferReply({ ephemeral: true }); const parts = id.split("_"), targetId = parts[2], hours = parseInt(parts[3]); const pending = await PendingPayment.findOne({ discordId: targetId }); const target = await fetchUserFromAnyClient(targetId); if (!target) { await interaction.editReply({ content: "❌ Não encontrado!" }); return; } await confirmarPagamento(target, hours, interaction.channel, interaction.user.id, pending?.finalPrice || pending?.price, pending?.label, pending?.couponUsed); if (pending?.couponUsed) await consumeCoupon(pending.couponUsed, targetId); await PendingPayment.deleteOne({ discordId: targetId }); await interaction.editReply({ content: `✅ Confirmado!` }); return; }
    if (id.startsWith("pay_cancel_")) { await interaction.deferReply({ ephemeral: true }); const targetId = id.replace("pay_cancel_", ""); const pending = await PendingPayment.findOne({ discordId: targetId }); if (!pending) { await interaction.editReply({ content: "❌ Não encontrado." }); return; } await PendingPayment.deleteOne({ discordId: targetId }); await interaction.editReply({ content: `🗑️ Cancelado.` }); return; }
    const modalMap = { logs_create: buildModal_create, logs_lifetime: buildModal_lifetime, logs_revoke: buildModal_revoke, logs_pause: buildModal_pause, logs_reset: buildModal_reset, logs_addtime: buildModal_addtime, logs_setexpiry: buildModal_setexpiry, logs_transfer: buildModal_transfer, logs_sethwid: buildModal_sethwid, logs_lookup: buildModal_lookup, logs_unblock: buildModal_unblock, logs_cleanlogs: buildModal_cleanlogs };
    if (modalMap[id]) await interaction.showModal(modalMap[id]());
});

async function handleLogsModal(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id = interaction.customId;
    const getField = (name) => { try { return interaction.fields.getTextInputValue(name); } catch { return ""; } };
    const pass = getField("key_pass");
    
    if (id !== "modal_lookup" && wrongPass(pass)) {
        return interaction.editReply({ content: "❌ Senha administrativa incorreta!" });
    }

    if (id === "modal_create") {
        const name = getField("key_name").trim();
        const h = parseInt(getField("key_h")) || 0;
        const m = parseInt(getField("key_m")) || 0;
        const ms = (h * 3600 + m * 60) * 1000;
        const { msg } = await opCreateKey(name, ms);
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_lifetime") {
        const name = getField("key_name").trim();
        const { msg } = await opCreateLifetime(name);
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_revoke") {
        const name = getField("key_name").trim();
        const { msg } = await opRevokeKey(name);
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_pause") {
        const name = getField("key_name").trim();
        const { msg } = await opTogglePause(name);
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_reset") {
        const name = getField("key_name").trim();
        const { msg } = await opResetHwid(name);
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_addtime") {
        const name = getField("key_name").trim();
        const h = parseInt(getField("key_h")) || 0;
        const m = parseInt(getField("key_m")) || 0;
        const ms = (h * 3600 + m * 60) * 1000;
        const { msg } = await opAddTime(name, ms);
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_setexpiry") {
        const name = getField("key_name").trim();
        const h = parseInt(getField("key_h")) || 0;
        const m = parseInt(getField("key_m")) || 0;
        const ms = (h * 3600 + m * 60) * 1000;
        const { msg } = await opSetExpiry(name, ms);
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_transfer") {
        const oldName = getField("key_old").trim();
        const newName = getField("key_new").trim();
        const { msg } = await opTransferKey(oldName, newName);
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_sethwid") {
        const name = getField("key_name").trim();
        const hwid = getField("key_hwid").trim();
        const { msg } = await opSetHwid(name, hwid);
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_lookup") {
        const name = getField("key_name").trim();
        const { msg } = await opLookupKey(name);
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_unblock") {
        const ip = getField("ip_address").trim();
        const { msg } = await opUnblockIp(ip);
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_cleanlogs") {
        const { msg } = await opCleanLogs();
        return interaction.editReply({ content: msg });
    }

    if (id === "modal_pay_confirm") { const userId = getField("user_id").trim(), hours = parseInt(getField("horas").trim()); if (isNaN(hours) || hours <= 0) { await interaction.editReply({ content: "❌ Horas inválidas!" }); return; } const pending = await PendingPayment.findOne({ discordId: userId }); const target = await fetchUserFromAnyClient(userId); if (!target) { await interaction.editReply({ content: "❌ Não encontrado!" }); return; } await confirmarPagamento(target, hours, interaction.channel, interaction.user.id, pending?.finalPrice || pending?.price, pending?.label, pending?.couponUsed); if (pending?.couponUsed) await consumeCoupon(pending.couponUsed, userId); await PendingPayment.deleteOne({ discordId: userId }); await interaction.editReply({ content: `✅ Key gerada!` }); return; }
    if (id === "modal_cancel_pedido") { const userId = getField("user_id").replace(/\D/g, ""), motivo = getField("motivo").trim() || "Sem motivo"; const pending = await PendingPayment.findOne({ discordId: userId }); if (!pending) { await interaction.editReply({ content: "❌ Não encontrado." }); return; } await PendingPayment.deleteOne({ discordId: userId }); await interaction.editReply({ content: `🗑️ Cancelado. Motivo: *${motivo}*` }); return; }
    if (id === "modal_coupon_create") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const code = getField("code").trim().toUpperCase(), discount = parseFloat(getField("discount").trim()), type = getField("type").trim().toLowerCase() === "fixed" ? "fixed" : "percent", maxUses = parseInt(getField("maxuses").trim()) || 1; if (!code || isNaN(discount)) { await interaction.editReply({ content: "❌ Dados inválidos!" }); return; } const existing = await Coupon.findOne({ code }); if (existing) { await interaction.editReply({ content: `❌ \`${code}\` já existe!` }); return; } await Coupon.create({ code, discount, type, maxUses }); await interaction.editReply({ content: `✅ Cupom \`${code}\` criado!` }); return; }
    if (id === "modal_plan_edit") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const value = getField("value").trim().toLowerCase(), price = parseFloat(getField("price").trim()), activeRaw = getField("active").trim().toLowerCase(), active = activeRaw === "sim" || activeRaw === "yes" || activeRaw === "true"; const plan = PLANS.find(p => p.value === value); if (!plan) { await interaction.editReply({ content: `❌ Plano \`${value}\` não encontrado.` }); return; } if (!isNaN(price)) plan.price = price; plan.active = active; await PlanModel.findOneAndUpdate({ value }, { price: plan.price, active }, { upsert: true }); await interaction.editReply({ content: `✅ Plano \`${value}\` atualizado!` }); return; }
}

// Funções auxiliares para modais e interações
const mkInput = (id, label, placeholder = "", required = true) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setPlaceholder(placeholder));

function buildModal_create() { return new ModalBuilder().setCustomId("modal_create").setTitle("🔑 Criar Key").addComponents(mkInput("key_name","Nome"),mkInput("key_h","Horas","24"),mkInput("key_m","Minutos","0",false),mkInput("key_pass","Senha")); }
function buildModal_lifetime() { return new ModalBuilder().setCustomId("modal_lifetime").setTitle("♾️ Lifetime").addComponents(mkInput("key_name","Nome"),mkInput("key_pass","Senha")); }
function buildModal_revoke() { return new ModalBuilder().setCustomId("modal_revoke").setTitle("🗑️ Revogar").addComponents(mkInput("key_name","Nome (ou \'all\')"),mkInput("key_pass","Senha")); }
function buildModal_pause() { return new ModalBuilder().setCustomId("modal_pause").setTitle("⏸️ Pausar").addComponents(mkInput("key_name","Nome (ou \'all\')"),mkInput("key_pass","Senha")); }
function buildModal_reset() { return new ModalBuilder().setCustomId("modal_reset").setTitle("🔄 Reset HWID").addComponents(mkInput("key_name","Nome (ou \'all\')"),mkInput("key_pass","Senha")); }
function buildModal_addtime() { return new ModalBuilder().setCustomId("modal_addtime").setTitle("⏱️ Add Tempo").addComponents(mkInput("key_name","Nome (ou \'all\')"),mkInput("key_h","Horas","12"),mkInput("key_m","Minutos","0",false),mkInput("key_pass","Senha")); }
function buildModal_setexpiry() { return new ModalBuilder().setCustomId("modal_setexpiry").setTitle("📅 Set Expiração").addComponents(mkInput("key_name","Nome"),mkInput("key_h","Horas"),mkInput("key_m","Minutos","0",false),mkInput("key_pass","Senha")); }
function buildModal_transfer() { return new ModalBuilder().setCustomId("modal_transfer").setTitle("🔀 Transfer").addComponents(mkInput("key_old","Nome atual"),mkInput("key_new","Novo nome"),mkInput("key_pass","Senha")); }
function buildModal_sethwid() { return new ModalBuilder().setCustomId("modal_sethwid").setTitle("💻 Set HWID").addComponents(mkInput("key_name","Nome"),mkInput("key_hwid","HWID"),mkInput("key_pass","Senha")); }
function buildModal_lookup() { return new ModalBuilder().setCustomId("modal_lookup").setTitle("🔍 Lookup").addComponents(mkInput("key_name","Nome")); }
function buildModal_unblock() { return new ModalBuilder().setCustomId("modal_unblock").setTitle("🔓 Desbloquear IP").addComponents(mkInput("ip_address","IP"),mkInput("key_pass","Senha")); }
function buildModal_cleanlogs() { return new ModalBuilder().setCustomId("modal_cleanlogs").setTitle("🧹 Limpar Logs").addComponents(mkInput("key_pass","Senha")); }

clientPanel.on("ready", async () => {
    console.log(`[PANEL] Online: ${clientPanel.user.tag}`);
    if (!PANEL_CHANNEL_ID) return;
    try { const ch = await clientPanel.channels.fetch(PANEL_CHANNEL_ID); if (!ch) return; const msgs = await ch.messages.fetch({ limit: 10 }); for (const [, msg] of msgs) { if (msg.author.id === clientPanel.user.id) await msg.delete().catch(() => {}); } await ch.send({ embeds: [new EmbedBuilder().setTitle("🤖 Bob Auto Joiner").setColor(COLORS.primary).setDescription("Clique nos botões para gerenciar sua key.")], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel_redeem").setLabel("Redeem Key").setEmoji("🔑").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId("panel_script").setLabel("Get Script").setEmoji("📋").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("panel_stats").setLabel("Key Info").setEmoji("📊").setStyle(ButtonStyle.Secondary)),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel_role").setLabel("Get Role").setEmoji("👤").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("panel_hwid").setLabel("Reset HWID").setEmoji("⚙️").setStyle(ButtonStyle.Secondary))] }); } catch (e) { console.error("[PANEL] Erro:", e.message); }
});

const awaitingInput = {}; // Para gerenciar inputs de DM

clientPanel.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.channel.type === ChannelType.DM) {
        const state = awaitingInput[message.author.id];
        if (!state) return;

        const key = message.content.trim();
        const keyName = findKey(key);

        if (!keyName) {
            await message.reply("❌ Key não encontrada!");
            delete awaitingInput[message.author.id];
            return;
        }

        const data = keys[keyName];
        const now = Date.now();

        if (data.paused) {
            await message.reply("⏸️ Key pausada.");
            delete awaitingInput[message.author.id];
            return;
        }

        if (data.expiry !== Infinity && data.expiry - now <= 0) {
            await message.reply("⌛ Key expirada!");
            delete awaitingInput[message.author.id];
            return;
        }

        switch (state.step) {
            case "redeem_key":
                // Lógica para resgatar key (se aplicável, ou apenas confirmar que é válida)
                await message.reply(`✅ Key \`${keyName}\` válida! Tempo restante: ${formatTime(data.expiry === Infinity ? Infinity : data.expiry - now)}`);
                break;
            case "script_key":
                await message.reply(`📋 Seu script: \`${SCRIPT_URL}\``);
                break;
            case "role_key":
                // Lógica para dar role, se o bot tiver permissão e o usuário estiver no servidor
                // Isso requer mais contexto (guildId, roleId) e permissões do bot.
                await message.reply("👤 Funcionalidade de dar role não implementada neste contexto. Contate um administrador.");
                break;
            case "hwid_key":
                if (data.hwid) {
                    keys[keyName].hwid = null;
                    kicked[keyName.toLowerCase()] = Date.now();
                    await saveKey(keyName);
                    await message.reply(`✅ HWID da key \`${keyName}\` resetado!`);
                } else {
                    await message.reply(`ℹ️ A key \`${keyName}\` não possui HWID definido.`);
                }
                break;
            case "stats_key":
                const timeLeft = data.expiry === Infinity ? "Lifetime ♾️" : (data.paused ? formatTime(data.remaining) : formatTime(data.expiry - now));
                const hwidInfo = data.hwid ? `HWID: \`${data.hwid}\`` : "HWID: Não definido";
                const discordInfo = data.discordId ? `Discord: <@${data.discordId}>` : "Discord: Não linkado";
                const status = data.paused ? "Pausada ⏸️" : (data.expiry !== Infinity && data.expiry - now <= 0 ? "Expirada ❌" : "Ativa ✅");
                await message.reply(`**Key:** \`${keyName}\`\n**Status:** ${status}\n**Tempo Restante:** ${timeLeft}\n${hwidInfo}\n${discordInfo}`);
                break;
        }
        delete awaitingInput[message.author.id];
    }
});

clientPanel.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const user = interaction.user; 
    const id = interaction.customId;

    if (id.startsWith("panel_")) {
        await interaction.deferReply({ ephemeral: true });
        const steps = { panel_redeem: "redeem_key", panel_script: "script_key", panel_role: "role_key", panel_hwid: "hwid_key", panel_stats: "stats_key" };
        const msgs = { panel_redeem: "🔑 Envie sua key:", panel_script: "📋 Envie sua key:", panel_role: "👤 Envie sua key:", panel_hwid: "⚙️ Envie sua key:", panel_stats: "📊 Envie sua key:" };
        const step = steps[interaction.customId];
        if (step) { 
            awaitingInput[user.id] = { step, guildId: interaction.guildId }; 
            try { 
                await user.send(msgs[interaction.customId]); 
                await interaction.editReply({ content: "📩 Te mandei uma DM!" }); 
            } catch { 
                await interaction.editReply({ content: "❌ Habilite mensagens privadas!" }); 
            } 
        }
    }
});

const pendingCoupon = {};

function getActivePlans() { return PLANS.filter(p => p.active); }

clientPayment.on("ready", async () => {
    console.log(`[PAYMENT] Online: ${clientPayment.user.tag}`);
    if (!BUY_CHANNEL) return;
    try { const ch = await clientPayment.channels.fetch(BUY_CHANNEL); if (!ch) return; const msgs = await ch.messages.fetch({ limit: 10 }); for (const [, msg] of msgs) { if (msg.author.id === clientPayment.user.id) await msg.delete().catch(() => {}); } const activePlans = getActivePlans(); const rows = []; for (let i = 0; i < activePlans.length; i += 4) { const row = new ActionRowBuilder(); activePlans.slice(i, i + 4).forEach(p => row.addComponents(new ButtonBuilder().setCustomId(`buy_${p.value}`).setLabel(`${p.emoji} ${p.label} — R$${p.price}`).setStyle(ButtonStyle.Success))); rows.push(row); } rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("buy_minhakey").setLabel("🔑 Minha Key").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("buy_cupom").setLabel("🎟️ Cupom").setStyle(ButtonStyle.Primary))); await ch.send({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🛒 Bob Keys").setDescription(activePlans.map(p => `${p.emoji} **${p.label}** — R$${p.price},00`).join("\n") + "\n\n> ⏱️ 15 minutos para pagar após escolher.\n> 🔄 Key ativa será renovada!").setTimestamp()], components: rows }); } catch (e) { console.error("[PAYMENT] Erro:", e.message); }
});

clientPayment.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;
    const id = interaction.customId, user = interaction.user;
    if (interaction.isModalSubmit() && id === "modal_cupom") { await interaction.deferReply({ ephemeral: true }); const planValue = pendingCoupon[user.id]?.plan, couponCode = interaction.fields.getTextInputValue("coupon_code").trim().toUpperCase(); const plan = getActivePlans().find(p => p.value === planValue); if (!plan) { await interaction.editReply({ content: "❌ Sessão expirada." }); return; } const result = await applyCoupon(couponCode, user.id, plan.price); if (!result.ok) { await interaction.editReply({ content: result.msg }); return; } pendingCoupon[user.id] = { plan: planValue, coupon: couponCode, finalPrice: result.finalPrice }; await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🎟️ Cupom Aplicado!").setDescription(`**${couponCode}** — ${result.discount}${result.type === "percent" ? "%" : " R$"} off\n**Preço final: R$${result.finalPrice}**`).setTimestamp()] }); return; }
    if (!interaction.isButton()) return;
    await interaction.deferReply({ ephemeral: true });
    if (id === "buy_cupom") { await interaction.deleteReply().catch(() => {}); await interaction.showModal(new ModalBuilder().setCustomId("modal_cupom").setTitle("🎟️ Cupom").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("coupon_code").setLabel("Código:").setStyle(TextInputStyle.Short).setRequired(true)))); return; }
    if (id.startsWith("buy_") && id !== "buy_minhakey") { const planValue = id.replace("buy_", ""), plan = getActivePlans().find(p => p.value === planValue); if (!plan) { await interaction.editReply({ content: "❌ Plano inválido!" }); return; } const existing = await PendingPayment.findOne({ discordId: user.id }); const now = Date.now(); if (existing) { const rem = PENDING_EXPIRY_MS - (now - new Date(existing.createdAt).getTime()); if (rem > 0) { await interaction.editReply({ content: `⚠️ Pedido ativo! Expira em **${formatTimeShort(rem)}**.` }); return; } } const couponData = pendingCoupon[user.id]?.plan === planValue ? pendingCoupon[user.id] : null; let finalPrice = plan.price, couponUsed = null; if (couponData) { finalPrice = couponData.finalPrice; couponUsed = couponData.coupon; delete pendingCoupon[user.id]; } await PendingPayment.findOneAndUpdate({ discordId: user.id }, { discordId: user.id, discordTag: user.tag, hours: plan.hours, price: plan.price, finalPrice, label: plan.label, couponUsed, warningSent: false, createdAt: new Date() }, { upsert: true, new: true }); await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle("💳 Pix").setDescription(`**${plan.emoji} ${plan.label}** — R$${finalPrice},00\n\n**Chave Pix:**\n\`\`\`${PIX_KEY}\`\`\`**Nome:** ${PIX_NAME}\n\n> Envie o comprovante aqui!\n> ⏳ **15 minutos** para pagar.`).setTimestamp()] }); return; }
    if (id === "buy_minhakey") { const userKeys = Object.entries(keys).filter(([, d]) => d.discordId === user.id); if (!userKeys.length) { await interaction.editReply({ content: "❌ Nenhuma key!" }); return; } const now = Date.now(); await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🔑 Suas Keys").setDescription(userKeys.map(([k, d]) => `\`${k}\` — ${d.expiry === Infinity ? "Lifetime ♾️" : (d.expiry - now > 0 ? formatTime(d.expiry - now) : "❌")} ${d.paused ? "⏸️" : "✅"}`).join("\n")).setTimestamp()] }); return; }

    // ── RECARGA PIX MANUAL ──
    if (id.startsWith("recharge_confirm_")) {
        const code = id.replace("recharge_confirm_", "");
        const recharge = await Recharge.findOne({ code, status: "pending" });
        if (!recharge) { await interaction.editReply({ content: "❌ Recarga não encontrada ou já processada." }); return; }

        // Adiciona saldo
        const updatedUser = await User.findOneAndUpdate(
            { discordId: recharge.discordId },
            { $inc: { balance: recharge.amount } },
            { new: true }
        );
        await Transaction.create({ discordId: recharge.discordId, type: "recharge", amount: recharge.amount, description: `Recarga Pix (${recharge.code})` });
        await Recharge.updateOne({ _id: recharge._id }, { status: "confirmed", confirmedBy: interaction.user.id });
        await interaction.editReply({ content: `✅ Recarga de R$${recharge.amount} para <@${recharge.discordId}> confirmada!` });
        fetchUserFromAnyClient(recharge.discordId).then(u => u?.send(`✅ Sua recarga de R$${recharge.amount} foi confirmada! Seu novo saldo é R$${updatedUser.balance}.`));
        return;
    }

    if (id.startsWith("recharge_cancel_")) {
        const code = id.replace("recharge_cancel_", "");
        const recharge = await Recharge.findOne({ code, status: "pending" });
        if (!recharge) { await interaction.editReply({ content: "❌ Recarga não encontrada ou já processada." }); return; }

        await Recharge.updateOne({ _id: recharge._id }, { status: "cancelled", confirmedBy: interaction.user.id });
        await interaction.editReply({ content: `🗑️ Recarga de R$${recharge.amount} para <@${recharge.discordId}> cancelada.` });
        fetchUserFromAnyClient(recharge.discordId).then(u => u?.send(`❌ Sua solicitação de recarga de R$${recharge.amount} foi cancelada.`));
        return;
    }
});

// Login dos bots
if (DISCORD_TOKEN_NOTIFIER) clientNotifier.login(DISCORD_TOKEN_NOTIFIER);
if (DISCORD_TOKEN_LOGS) clientLogs.login(DISCORD_TOKEN_LOGS);
if (DISCORD_TOKEN_PANEL) clientPanel.login(DISCORD_TOKEN_PANEL);
if (DISCORD_TOKEN_PAYMENT) clientPayment.login(DISCORD_TOKEN_PAYMENT);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

// Socket.io para atualizações em tempo real
io.on("connection", (socket) => {
    console.log("Cliente conectado ao Socket.io");
    socket.emit("brainrots", brainrots);
    socket.emit("presence", Object.values(presence).filter(p => Date.now() - p.lastSeen < ONLINE_STALE_MS));

    socket.on("disconnect", () => {
        console.log("Cliente desconectado do Socket.io");
    });
});
