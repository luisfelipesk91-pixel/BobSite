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
const SCRIPT_SECRET = requireEnv("SCRIPT_SECRET"); // Secret para o Joiner
const RAILWAY_SECRET = requireEnv("RAILWAY_SECRET"); // Secret para o Hopper
const RAILWAY_CLIENT = process.env.RAILWAY_CLIENT || "Bobnotify"; // Client para o Hopper
const XOR_KEY       = requireEnv("XOR_KEY");
const MONGODB_URI   = requireEnv("MONGODB_URI");
const JWT_SECRET    = process.env.JWT_SECRET || "bobjoiner_jwt_secret_2026";

const CLIENT_HEADER          = RAILWAY_CLIENT || "BobJoiner-v2"; // Usar o mesmo client header para Joiner e Hopper
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
const FRONTEND_URL           = process.env.FRONTEND_URL            || "http://localhost:3000";
const DISCORD_CLIENT_ID      = process.env.DISCORD_CLIENT_ID       || "";
const DISCORD_CLIENT_SECRET  = process.env.DISCORD_CLIENT_SECRET   || "";
const REDIRECT_URI           = `${FRONTEND_URL}/auth/callback`;

const ADMIN_ROLE_IDS = ["1477885793144930496","1501356382677373101","1477885797553148066"];
const RECHARGE_CHANNEL = "1511517095412895905";
const MIN_RECHARGE = 5;

// --- INITIALIZE DISCORD CLIENTS FIRST ---
const clientNotifier = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const clientLogs     = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const clientPanel    = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const clientPayment  = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

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

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

function requireClientHeader(req, res, next) {
    if (req.headers["user-agent"] && BLOCKED_UA.some(ua => req.headers["user-agent"].toLowerCase().includes(ua)))
        return res.status(403).send("Forbidden");
    const clientHeader = req.headers["x-bob-client"] || req.headers["x-client-header"];
    if (clientHeader !== CLIENT_HEADER && clientHeader !== RAILWAY_CLIENT)
        return res.status(403).send("Forbidden");
    next();
}

function checkKey(keyName, secret, hwid) {
    if (secret !== SCRIPT_SECRET && secret !== RAILWAY_SECRET) return { ok: false, error: "Secret invalida." };
    const realName = findKey(keyName);
    if (!realName) return { ok: false, error: "Key inexistente." };
    const d = keys[realName];
    if (d.paused) return { ok: false, error: "Key pausada." };
    if (d.expiry !== Infinity && d.expiry - Date.now() <= 0) return { ok: false, error: "Key expirada." };
    if (hwid) {
        if (!d.hwid) { d.hwid = hwid; saveKey(realName); }
        else if (d.hwid !== hwid) return { ok: false, error: "HWID incompativel." };
    }
    return { ok: true, keyName: realName, data: d };
}

// Rotas para o Hopper
app.post("/api/hopper/brainrot", requireClientHeader, async (req, res) => {
    if (!safeCompare(req.headers["x-railway-secret"], RAILWAY_SECRET)) return res.status(403).send("Forbidden");
    const { payload } = req.body;
    if (!payload) return res.status(400).send("Payload ausente");
    pushBrainrot(payload);
    res.status(200).send("OK");
});

app.post("/api/hopper/logs", requireClientHeader, async (req, res) => {
    if (!safeCompare(req.headers["x-railway-secret"], RAILWAY_SECRET)) return res.status(403).send("Forbidden");
    const { message } = req.body;
    if (!message) return res.status(400).send("Mensagem ausente");
    if (clientLogs && LOGS_CHANNEL_ID) {
        const channel = await clientLogs.channels.fetch(LOGS_CHANNEL_ID);
        if (channel) channel.send(`[HOPPER LOG] ${message}`);
    }
    res.status(200).send("OK");
});

app.post("/api/notify", requireClientHeader, async (req, res) => {
    if (!safeCompare(req.headers["x-railway-secret"], RAILWAY_SECRET)) return res.status(403).send("Forbidden");
    const { type, message, embed } = req.body;
    if (!type || !message) return res.status(400).send("Tipo e mensagem ausentes");

    let targetClient = clientNotifier;
    let targetChannelId = DISCORD_CHANNEL_ID;

    if (type === "log") {
        targetClient = clientLogs;
        targetChannelId = LOGS_CHANNEL_ID;
    } else if (type === "panel") {
        targetClient = clientPanel;
        targetChannelId = PANEL_CHANNEL_ID;
    }

    if (targetClient && targetChannelId) {
        try {
            const channel = await targetClient.channels.fetch(targetChannelId);
            if (channel) {
                if (embed) {
                    const discordEmbed = new EmbedBuilder(embed);
                    await channel.send({ embeds: [discordEmbed] });
                } else {
                    await channel.send(message);
                }
            }
        } catch (error) {
            console.error(`[API/NOTIFY] Erro ao enviar notificação para ${type}: ${error.message}`);
        }
    }
    res.status(200).send("OK");
});


// Lógica para enviar o painel de chaves do BOB LOGS para o CHANNEL ID após o deploy
clientPanel.on(Events.ClientReady, async () => {
    console.log(`[PANEL] Logado como ${clientPanel.user.tag}`);
    if (BOB_LOGS_PANEL_CHANNEL) {
        const channel = await clientPanel.channels.fetch(BOB_LOGS_PANEL_CHANNEL);
        if (channel && channel.type === ChannelType.GuildText) {
            const embed = new EmbedBuilder()
                .setColor(COLORS.dark)
                .setTitle("🔑 Painel de Gerenciamento de Keys")
                .setDescription("Use os botões abaixo para gerenciar as keys do Bob Joiner.")
                .setTimestamp()
                .setFooter({ text: "Bob Joiner Panel" });

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId("panel_list_keys")
                        .setLabel("Listar Keys")
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId("panel_create_key")
                        .setLabel("Criar Key")
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId("panel_delete_key")
                        .setLabel("Deletar Key")
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId("panel_edit_key")
                        .setLabel("Editar Key")
                        .setStyle(ButtonStyle.Secondary),
                );

            // Tenta encontrar a mensagem existente para editar, se não encontrar, envia uma nova
            try {
                const messages = await channel.messages.fetch({ limit: 100 });
                const existingMessage = messages.find(msg => 
                    msg.author.id === clientPanel.user.id && 
                    msg.embeds.length > 0 && 
                    msg.embeds[0].title === "🔑 Painel de Gerenciamento de Keys"
                );

                if (existingMessage) {
                    await existingMessage.edit({ embeds: [embed], components: [row] });
                    console.log(`[PANEL] Painel de keys atualizado no canal ${channel.name}`);
                } else {
                    await channel.send({ embeds: [embed], components: [row] });
                    console.log(`[PANEL] Painel de keys enviado para o canal ${channel.name}`);
                }
            } catch (error) {
                console.error(`[PANEL] Erro ao enviar/atualizar painel de keys: ${error.message}`);
            }
        }
    }
});

// --- AUTH ROUTES ---
app.get("/auth/callback", async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect("/?error=no_code");
    try {
        const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
            method: "POST",
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                code,
                grant_type: "authorization_code",
                redirect_uri: REDIRECT_URI,
                scope: "identify",
            }),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        const tokenData = await tokenResponse.json();
        if (tokenData.error) return res.redirect(`/?error=${tokenData.error}`);

        const userResponse = await fetch("https://discord.com/api/users/@me", {
            headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
        });
        const userData = await userResponse.json();

        let user = await User.findOne({ discordId: userData.id });
        if (!user) {
            user = new User({ discordId: userData.id, discordTag: `${userData.username}#${userData.discriminator}`, avatar: userData.avatar });
            await user.save();
        } else {
            user.discordTag = `${userData.username}#${userData.discriminator}`;
            user.avatar = userData.avatar;
            await user.save();
        }

        await createAutoKeyForUser(userData.id, user.discordTag);

        const token = jwt.sign({ id: user.discordId, tag: user.discordTag }, JWT_SECRET, { expiresIn: "7d" });
        res.redirect(`/?token=${token}`);
    } catch (error) {
        console.error("[AUTH] Erro:", error);
        res.redirect("/?error=server_error");
    }
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

app.get("/auth/me", authenticateToken, async (req, res) => {
    try {
        const user = await User.findOne({ discordId: req.user.id });
        if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
        const keyName = await createAutoKeyForUser(user.discordId, user.discordTag);
        const keyData = keys[keyName];
        const transactions = await Transaction.find({ discordId: user.discordId }).sort({ createdAt: -1 }).limit(10);
        const onlineUsers = Object.values(presence).filter(p => Date.now() - p.lastSeen < ONLINE_STALE_MS);

        res.json({
            discordId: user.discordId,
            discordTag: user.discordTag,
            avatar: user.avatar,
            balance: user.balance,
            key: {
                name: keyName,
                hasTime: keyData.expiry === Infinity || keyData.expiry > Date.now(),
                timeLeft: formatTime(keyData.expiry === Infinity ? Infinity : keyData.expiry - Date.now()),
                paused: keyData.paused
            },
            plans: PLANS,
            transactions,
            onlineUsers: onlineUsers.map(p => ({ robloxName: p.name, expiryMs: 0, isLifetime: false })),
            maxSlots: MAX_SLOTS
        });
    } catch (error) {
        res.status(500).json({ error: "Erro interno" });
    }
});

app.post("/api/buy", authenticateToken, async (req, res) => {
    const { planValue, couponCode } = req.body;
    const plan = PLANS.find(p => p.value === planValue);
    if (!plan) return res.status(400).json({ error: "Plano inválido" });

    const user = await User.findOne({ discordId: req.user.id });
    const couponResult = await applyCoupon(couponCode, user.discordId, plan.price);
    const finalPrice = couponResult.finalPrice;

    if (user.balance < finalPrice) return res.status(400).json({ error: "Saldo insuficiente" });

    user.balance -= finalPrice;
    await user.save();

    if (couponResult.ok) await consumeCoupon(couponCode, user.discordId);

    const keyName = await createAutoKeyForUser(user.discordId, user.discordTag);
    const key = keys[keyName];
    const addMs = plan.hours * 3600 * 1000;
    if (key.expiry === Infinity) { /* já é lifetime */ }
    else if (plan.value === "lifetime") { key.expiry = Infinity; key.paused = false; }
    else {
        const currentRemaining = (key.expiry > Date.now()) ? (key.expiry - Date.now()) : 0;
        key.expiry = Date.now() + currentRemaining + addMs;
        key.paused = false;
    }
    await saveKey(keyName);

    await new Transaction({ discordId: user.discordId, type: "purchase", amount: -finalPrice, description: `Compra de plano: ${plan.label}` }).save();
    res.json({ ok: true, plan: plan.label });
});

app.get("/health", (_, res) => res.json({ status: "ok", time: Date.now() }));

// --- HOPPER API ROUTES ---
app.post("/api", requireClientHeader, async (req, res) => {
    const { key, secret, hwid, brainrot, jobId, placeId, players } = req.body;
    const check = checkKey(key, secret, hwid);
    if (!check.ok) return res.status(403).json({ error: check.error });

    if (brainrot) {
        pushBrainrot({ ...brainrot, jobId, placeId, players, key: check.keyName, hwid });
        console.log(`[RAILWAY] Enviando brainrot: ${brainrot.name} | Owner: ${brainrot.owner} | ${brainrot.genText}`);
        // Opcional: Enviar para o canal de logs do Discord
        if (clientLogs && LOGS_CHANNEL_ID) {
            const embed = new EmbedBuilder()
                .setColor(COLORS.gold)
                .setTitle(`🧠 Brainrot Encontrado!`) 
                .setDescription(`**Key:** 
${check.keyName}
**HWID:** 
${hwid}
**Brainrot:** 
${brainrot.name}
**Owner:** 
${brainrot.owner}
**Geração:** 
${brainrot.genText}
**Job ID:** 
${jobId}
**Place ID:** 
${placeId}
**Players:** 
${players}`)
                .setTimestamp();
            clientLogs.channels.cache.get(LOGS_CHANNEL_ID)?.send({ embeds: [embed] }).catch(console.error);
        }
    }
    res.json({ ok: true });
});

app.post("/api/validate", requireClientHeader, async (req, res) => {
    const { key, secret, hwid } = req.body;
    const check = checkKey(key, secret, hwid);
    if (!check.ok) return res.status(403).json({ error: check.error });
    res.json({ ok: true, key: check.keyName, data: check.data });
});

app.post("/api/kicked", requireClientHeader, async (req, res) => {
    const { key, secret, hwid, jobId } = req.body;
    const check = checkKey(key, secret, hwid);
    if (!check.ok) return res.status(403).json({ error: check.error });
    kicked[check.keyName] = jobId;
    res.json({ ok: true });
});

app.get("/api/latest", requireClientHeader, async (req, res) => {
    const { key, secret, hwid } = req.query;
    const check = checkKey(key, secret, hwid);
    if (!check.ok) return res.status(403).json({ error: check.error });
    res.json({ ok: true, brainrots: brainrots });
});



// --- JOINER API ROUTES (Existing) ---
app.get("/api/plans", authenticateToken, async (req, res) => {
    res.json({ ok: true, plans: PLANS });
});

app.get("/api/coupons", authenticateToken, async (req, res) => {
    const coupons = await Coupon.find({});
    res.json({ ok: true, coupons });
});

app.post("/api/coupons/create", authenticateToken, async (req, res) => {
    const { code, discount, type, maxUses, expiresAt } = req.body;
    if (!code || !discount) return res.status(400).json({ error: "Código e desconto são obrigatórios." });
    const newCoupon = new Coupon({ code: code.toUpperCase(), discount, type, maxUses, expiresAt });
    await newCoupon.save();
    res.json({ ok: true, coupon: newCoupon });
});

app.post("/api/coupons/delete", authenticateToken, async (req, res) => {
    const { code } = req.body;
    await Coupon.deleteOne({ code: code.toUpperCase() });
    res.json({ ok: true });
});

app.post("/api/plans/create", authenticateToken, async (req, res) => {
    const { label, value, price, hours, emoji, active } = req.body;
    if (!label || !value || !price || !hours) return res.status(400).json({ error: "Dados do plano incompletos." });
    const newPlan = new PlanModel({ label, value, price, hours, emoji, active });
    await newPlan.save();
    PLANS.push(newPlan);
    res.json({ ok: true, plan: newPlan });
});

app.post("/api/plans/update", authenticateToken, async (req, res) => {
    const { value, ...updates } = req.body;
    await PlanModel.findOneAndUpdate({ value }, updates);
    loadPlansFromDB(); // Recarrega os planos para atualizar a lista em memória
    res.json({ ok: true });
});

app.post("/api/plans/delete", authenticateToken, async (req, res) => {
    const { value } = req.body;
    await PlanModel.deleteOne({ value });
    loadPlansFromDB();
    res.json({ ok: true });
});

app.get("/api/users", authenticateToken, async (req, res) => {
    const users = await User.find({});
    res.json({ ok: true, users });
});

app.post("/api/users/update", authenticateToken, async (req, res) => {
    const { discordId, balance, ...updates } = req.body;
    await User.findOneAndUpdate({ discordId }, { balance, ...updates });
    res.json({ ok: true });
});

app.post("/api/users/delete", authenticateToken, async (req, res) => {
    const { discordId } = req.body;
    await User.deleteOne({ discordId });
    res.json({ ok: true });
});

app.get("/api/keys", authenticateToken, async (req, res) => {
    const allKeys = await KeyModel.find({});
    res.json({ ok: true, keys: allKeys });
});

app.post("/api/keys/create", authenticateToken, async (req, res) => {
    const { name, expiry, paused, remaining, hwid, discordId, isAutoKey } = req.body;
    const newKey = new KeyModel({ name, expiry, paused, remaining, hwid, discordId, isAutoKey });
    await newKey.save();
    loadKeys();
    res.json({ ok: true, key: newKey });
});

app.post("/api/keys/update", authenticateToken, async (req, res) => {
    const { name, ...updates } = req.body;
    await KeyModel.findOneAndUpdate({ name }, updates);
    loadKeys();
    res.json({ ok: true });
});

app.post("/api/keys/delete", authenticateToken, async (req, res) => {
    const { name } = req.body;
    await KeyModel.deleteOne({ name });
    loadKeys();
    res.json({ ok: true });
});

app.get("/api/recharges", authenticateToken, async (req, res) => {
    const recharges = await Recharge.find({});
    res.json({ ok: true, recharges });
});

app.post("/api/recharges/confirm", authenticateToken, async (req, res) => {
    const { code, adminId, adminTag } = req.body;
    const recharge = await Recharge.findOne({ code });
    if (!recharge) return res.status(404).json({ error: "Recarga não encontrada." });
    if (recharge.status !== "pending") return res.status(400).json({ error: "Recarga já processada." });

    recharge.status = "confirmed";
    recharge.confirmedBy = adminTag;
    await recharge.save();

    const user = await User.findOne({ discordId: recharge.discordId });
    if (user) {
        user.balance += recharge.amount;
        await user.save();
        await new Transaction({ discordId: user.discordId, type: "recharge", amount: recharge.amount, description: `Recarga confirmada por ${adminTag}` }).save();
    }

    res.json({ ok: true, recharge });
});

app.post("/api/recharges/cancel", authenticateToken, async (req, res) => {
    const { code, adminTag } = req.body;
    const recharge = await Recharge.findOne({ code });
    if (!recharge) return res.status(404).json({ error: "Recarga não encontrada." });
    if (recharge.status !== "pending") return res.status(400).json({ error: "Recarga já processada." });

    recharge.status = "cancelled";
    recharge.confirmedBy = adminTag;
    await recharge.save();
    res.json({ ok: true, recharge });
});

app.get("/api/sales", authenticateToken, async (req, res) => {
    const sales = await SaleHistory.find({});
    res.json({ ok: true, sales });
});

app.get("/api/transactions", authenticateToken, async (req, res) => {
    const transactions = await Transaction.find({});
    res.json({ ok: true, transactions });
});

// Rotas para o Hopper (Roblox Script)
app.post("/api/brainrot", requireClientHeader, async (req, res) => {
    const { key, secret, hwid } = req.query;
    const { name, genStr, numVal, owner } = req.body;

    const check = checkKey(key, secret, hwid);
    if (!check.ok) return res.status(403).json({ error: check.error });

    pushBrainrot({ name, genStr, numVal, owner, key: check.keyName });
    res.json({ ok: true });
});

app.post("/api/log", requireClientHeader, async (req, res) => {
    const { key, secret, hwid } = req.query;
    const { message, level = "info" } = req.body;

    const check = checkKey(key, secret, hwid);
    if (!check.ok) return res.status(403).json({ error: check.error });

    console.log(`[ROBLOX LOG - ${level.toUpperCase()}] Key: ${check.keyName} | ${message}`);
    res.json({ ok: true });
});

app.post("/api/update-key-status", requireClientHeader, async (req, res) => {
    const { key, secret, hwid } = req.query;
    const { status } = req.body; // 'paused', 'resumed'

    const check = checkKey(key, secret, hwid);
    if (!check.ok) return res.status(403).json({ error: check.error });

    const realName = check.keyName;
    if (status === "paused") {
        keys[realName].paused = true;
        console.log(`[KEY STATUS] Key ${realName} pausada.`);
    } else if (status === "resumed") {
        keys[realName].paused = false;
        console.log(`[KEY STATUS] Key ${realName} resumida.`);
    }
    await saveKey(realName);
    res.json({ ok: true });
});


app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

async function loginBot(client, token, label) { if (!token) { console.warn(`[${label}] Token ausente.`); return; } try { await client.login(token); } catch (e) { console.error(`[${label}] Erro:`, e.message); } }

loginBot(clientNotifier, DISCORD_TOKEN_NOTIFIER, "NOTIFIER");
loginBot(clientLogs,     DISCORD_TOKEN_LOGS,     "LOGS");
loginBot(clientPanel,    DISCORD_TOKEN_PANEL,    "PANEL");
loginBot(clientPayment,  DISCORD_TOKEN_PAYMENT,  "PAYMENT");

loadKeys();
const port = process.env.PORT || 8080;
server.listen(port, () => console.log(`[SERVER] Porta ${port} — Bob API online ✅`));
