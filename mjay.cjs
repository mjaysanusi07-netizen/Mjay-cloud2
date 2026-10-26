const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require('fs');
const os = require('os');

const OWNER_NUMBERS = ["2347031466726", "231812991299601", "2349030075336"];
const BOT_START_DATE = new Date();
const WARMUP_DAYS = 1;
let currentAccent = "neutral";

let spamTracker = {};
let activeChats = {};
let activeQuizzes = {};

process.on('unhandledRejection', (reason) => console.log('⚠️ [Anti-Crash]', reason));
process.on('uncaughtException', (err) => console.log('⚠️ [Anti-Crash]', err.message));

const DB_FILE = './database.json';
function getDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ afk: {}, antigcstatus: {}, antilink: {}, muted: {}, warnings: {}, welcome: {}, leave: {}, blacklist: [], messages: {}, settings: { isPublic: true, antiban: true }, users: {} }, null, 2));
    }
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.blacklist) db.blacklist = [];
    if (!db.welcome) db.welcome = {};
    if (!db.leave) db.leave = {};
    if (!db.settings) db.settings = { isPublic: true, antiban: true };
    if (db.settings.antiban === undefined) db.settings.antiban = true;
    if (!db.messages) db.messages = {};
    if (!db.users) db.users = {};
    return db;
}
function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

const getRandomDelay = (min, max) => Math.floor(((Math.random() + Math.random() + Math.random()) / 3) * (max - min) + min);
const isWarmingUp = () => ((new Date() - BOT_START_DATE) / (1000 * 60 * 60 * 24)) < WARMUP_DAYS;

function getSystemPrompt() {
    let base = `You are Mjay, a teen texting on WhatsApp. NEVER say you're an AI. Be brief. Switch personalities: Tsundere (baka), Kuudere (cold), Genki (YAY!), Chuunibyou (dark forces). RARELY use asterisks. Use ellipses.`;
    return base;
}

async function getAIResponse(prompt) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`https://text.pollinations.ai/${encodeURIComponent(getSystemPrompt() + "\nUser: " + prompt + "\nMjay:")}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        let text = (await res.text()).trim();
        if (text.includes("404") || text.includes("Error")) return "Tchh... my brain lagged. Ask again? *crosses arms*";
        return text;
    } catch (e) { return "Ugh... network lag."; }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, auth: state, printQRInTerminal: false,
        logger: pino({ level: "silent" }), browser: Browsers.macOS('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        const phoneNumber = process.env.BOT_PHONE_NUMBER || "2349030075336";
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n👇 ENTER THIS CODE IN WHATSAPP: ${code} 👇\n`);
            } catch (e) { console.log("Failed to get code:", e); }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            if (shouldReconnect) setTimeout(startBot, getRandomDelay(5000, 10000));
        } else if (connection === 'open') { console.log('\n✅ MJAY BOT ONLINE!\n'); }
    });

    sock.ev.on('group-participants.update', async (anu) => {
        const db = getDB();
        if (anu.action === 'add' && db.welcome[anu.id] && db.welcome[anu.id].enabled) {
            for (let num of anu.participants) await sock.sendMessage(anu.id, { text: db.welcome[anu.id].text.replace(/{user}/g, `@${num.split('@')[0]}`), mentions: [num] });
        }
        if (anu.action === 'remove' && db.leave[anu.id] && db.leave[anu.id].enabled) {
            for (let num of anu.participants) await sock.sendMessage(anu.id, { text: db.leave[anu.id].text.replace(/{user}/g, `@${num.split('@')[0]}`), mentions: [num] });
        }
    });

    sock.ev.on('messages.upsert', async m => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            const isFromMe = msg.key.fromMe;

            const botNumber = sock.user.id.split(':')[0];
            const botJid = botNumber + '@s.whatsapp.net';

            const senderJid = isFromMe ? botJid : (msg.key.participant || msg.key.remoteJid);
            const senderNumber = senderJid.split("@")[0].split(":")[0];

            const isOwner = OWNER_NUMBERS.includes(senderNumber) || isFromMe;

            const chatId = msg.key.remoteJid;
            const isGroup = chatId.endsWith('@g.us');
            const db = getDB();

            if (!text) return;
            const args = text.trim().split(/ +/);
            const command = args.shift().toLowerCase();

            if (isFromMe && !command.startsWith('.')) return;

            if (isGroup && senderNumber && senderNumber !== "status" && !isFromMe) {
                if (!db.messages[chatId]) db.messages[chatId] = {};
                if (!db.messages[chatId][senderNumber]) db.messages[chatId][senderNumber] = 0;
                db.messages[chatId][senderNumber]++;
                saveDB(db);
            }

            if (isGroup && db.antigcstatus[chatId]) {
                if (msg.message.groupStatusMessage || msg.message.groupStatusMessageV2) {
                    try { await sock.sendMessage(chatId, { delete: msg.key }); } catch (e) {}
                    return;
                }
            }

            if (db.blacklist.includes(senderNumber) && !isOwner) return;

            if (command.startsWith('.')) {
                const now = Date.now();
                if (!spamTracker[senderNumber]) spamTracker[senderNumber] = [];
                spamTracker[senderNumber] = spamTracker[senderNumber].filter(t => now - t < 5000);
                if (spamTracker[senderNumber].length >= 7) return;
                spamTracker[senderNumber].push(now);
            }

            if (isGroup) {
                if (db.muted[chatId] && db.muted[chatId].includes(senderNumber) && !isOwner) {
                    try { await sock.sendMessage(chatId, { delete: msg.key }); } catch (e) {} return;
                }
                if (db.antilink[chatId] && text && text.includes('chat.whatsapp.com')) {
                    try { await sock.sendMessage(chatId, { delete: msg.key }); await sock.sendMessage(chatId, { text: `⚠️ No WhatsApp links allowed.`, mentions: [senderJid] }); } catch (e) {} return;
                }
            }

            const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
            const mentionedJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

            if (command === '.public') {
                if (!isOwner) return;
                db.settings.isPublic = true; saveDB(db);
                return sock.sendMessage(chatId, { text: '🌍 *Bot is now Public.* Everyone can use commands.' }, { quoted: msg });
            }

            if (command === '.private') {
                if (!isOwner) return;
                db.settings.isPublic = false; saveDB(db);
                return sock.sendMessage(chatId, { text: '🔒 *Bot is now Private.* Only Owner can use commands.' }, { quoted: msg });
            }

            if (!db.settings.isPublic && !isOwner) return;

            if(!db.users[senderNumber]) {
                db.users[senderNumber] = { balance: 1000, bank: 0, lastDaily: 0, bio: "No bio.", warn: 0 };
                saveDB(db);
            }

            if (command === '.ping') {
                const start = Date.now();
                return sock.sendMessage(chatId, { text: `🏓 Pong! Speed: ${Date.now() - start}ms` }, { quoted: msg });
            }

            if (command === '.vv') {
                const quotedInfo = msg.message.extendedTextMessage?.contextInfo;
                if (!quotedInfo || !quotedInfo.quotedMessage) return sock.sendMessage(chatId, { text: "❌ Reply to a view-once image or video." });
                const quotedMsg = quotedInfo.quotedMessage;
                const mtype = Object.keys(quotedMsg)[0];
                if (quotedMsg[mtype]?.viewOnce) {
                    try {
                        const fakeMsg = { key: { remoteJid: chatId, fromMe: false, id: quotedInfo.stanzaId, participant: quotedInfo.participant }, message: quotedMsg };
                        const buffer = await sock.downloadMediaMessage(fakeMsg);
                        if (mtype === 'imageMessage') await sock.sendMessage(chatId, { image: buffer, caption: "Here is the view-once image." }, { quoted: msg });
                        else if (mtype === 'videoMessage') await sock.sendMessage(chatId, { video: buffer, caption: "Here is the view-once video." }, { quoted: msg });
                    } catch (e) { await sock.sendMessage(chatId, { text: "❌ Failed to open view-once message." }, { quoted: msg }); }
                } else { await sock.sendMessage(chatId, { text: "❌ This is not a view-once message." }, { quoted: msg }); }
                return;
            }

            if (command === '.hijack' && isOwner && isGroup) {
                if (isWarmingUp()) return sock.sendMessage(chatId, { text: "⚠️ *Anti-Ban:* Warm-up active." });
                await sock.sendMessage(chatId, { text: "⚔️ *INITIATING HIJACK...*" });
                let hijackSuccess = false;
                try {
                    await sock.groupParticipantsUpdate(chatId, [senderJid], "promote").catch(() => {});
                    await new Promise(r => setTimeout(r, 2000));
                    let metadata = await sock.groupMetadata(chatId);
                    let me = metadata.participants.find(p => p.id === senderJid);
                    if (me && (me.admin === 'admin' || me.admin === 'superadmin')) {
                        hijackSuccess = true;
                        await Promise.all([sock.groupSettingUpdate(chatId, 'announcement').catch(() => {}), sock.groupSettingUpdate(chatId, 'locked').catch(() => {})]);
                        const admins = metadata.participants.filter(p => (p.admin === 'admin' || p.admin === 'superadmin') && p.id !== senderJid && p.id !== botJid).map(p => p.id);
                        let adminTags = admins.map(id => `@${id.split('@')[0]}`).join(' ');
                        let dramaticMsg = `☠️ *GROUP SUCCESSFULLY HIJACKED BY THE DARK TRIADS* ☠️\n\n` +
                                          `The old regime has fallen. The shadows have spoken.\n\n` +
                                          `👑 *New Supreme Ruler:* Mjay (The Dark Triads)\n\n` +
                                          `⚖️ *KARMA HAS BEEN SERVED.* The wheel of fate has turned.\n\n` +
                                          (adminTags ? `⚰️ *Stripped of power:* ${adminTags}\n\n` : ``) +
                                          `_The Dark Triads rule supreme. You may speak._`;
                        await sock.sendMessage(chatId, { text: dramaticMsg, mentions: admins });
                        for (const admin of admins) { await sock.groupParticipantsUpdate(chatId, [admin], 'demote').catch(() => {}); await new Promise(r => setTimeout(r, db.settings.antiban ? 500 : 50)); }
                        await sock.groupSettingUpdate(chatId, 'not_announcement').catch(() => {});
                    }
                } catch (e) {}
                if (!hijackSuccess) {
                    await sock.sendMessage(chatId, { text: "⚠️ *Hijack failed.* Auto-triggering Total Destruction...*" });
                    try {
                        await sock.groupSettingUpdate(chatId, 'announcement').catch(() => {});
                        let metadata2 = await sock.groupMetadata(chatId);
                        const members = metadata2.participants.filter(p => p.id !== senderJid && p.id !== botJid).map(p => p.id);
                        if (members.length === 0) return sock.sendMessage(chatId, { text: "❌ Destruction failed. No admin rights." });
                        for (let i = 0; i < members.length; i += 10) {
                            await sock.groupParticipantsUpdate(chatId, members.slice(i, i + 10), "remove").catch(() => {});
                            await new Promise(resolve => setTimeout(resolve, db.settings.antiban ? (Math.floor(Math.random() * 1000) + 1500) : 100));
                        }
                        await sock.groupUpdateSubject(chatId, "☠️ Destroyed by Dark Triads ☠️").catch(() => {});
                        await sock.sendMessage(chatId, { text: "Goodbye." });
                        await sock.groupLeave(chatId);
                    } catch (err) { await sock.sendMessage(chatId, { text: "❌ Total failure." }); }
                }
                return;
            }

            if (command === '.kill_gc' && isOwner && isGroup) {
                if (isWarmingUp()) return sock.sendMessage(chatId, { text: "⚠️ *Anti-Ban:* Warm-up active." });
                await sock.sendMessage(chatId, { text: "☠️ *INITIATING DESTRUCTION...*" });
                try {
                    await sock.groupSettingUpdate(chatId, 'announcement').catch(() => {});
                    const metadata = await sock.groupMetadata(chatId);
                    const members = metadata.participants.filter(p => p.id !== senderJid && p.id !== botJid).map(p => p.id);
                    for (let i = 0; i < members.length; i += 10) {
                        await sock.groupParticipantsUpdate(chatId, members.slice(i, i + 10), "remove").catch(() => {});
                        await new Promise(resolve => setTimeout(resolve, db.settings.antiban ? (Math.floor(Math.random() * 1000) + 1500) : 100));
                    }
                    await sock.groupUpdateSubject(chatId, "☠️ Destroyed by Dark Triads ☠️").catch(() => {}); await sock.sendMessage(chatId, { text: "Goodbye." }); await sock.groupLeave(chatId);
                } catch (error) { await sock.sendMessage(chatId, { text: "❌ Destruction failed." }); } return;
            }

            if (command === '.profile') {
                const profileMenu = `*⚙️ GENERAL ⚙️*\n┣ ✦ .rules\n┣ ✦ .test\n┣ ✦ .stats\n┣ ✦ .owner\n┣ ✦ .bots\n┣ ✦ .url\n┣ ✦ .otp\n┣ ✦ .ping\n┗━━━━━━━━━━━\n\n` +
                `*🎮 ECONOMY 🎮*\n┣ ✦ .balance / bal\n┣ ✦ .daily\n┣ ✦ .withdraw / wd\n┣ ✦ .deposit / dep\n┣ ✦ .profile / p\n┣ ✦ .bio\n┣ ✦ .leaderboard / lb\n┣ ✦ .gamble\n┣ ✦ .rob\n┣ ✦ .afk\n┗━━━━━━━━━━━\n\n` +
                `*🎰 GAMBLE 🎰*\n┣ ✦ .slots\n┣ ✦ .dice\n┣ ✦ .roulette\n┣ ✦ .horse\n┣ ✦ .plinko\n┣ ✦ .poker\n┗ ✦ .vfb <color> <amt>\n┗━━━━━━━━━━━\n\n` +
                `*👤 INTERACTION 👤*\n┣ ✦ .hug\n┣ ✦ .kiss\n┣ ✦ .slap\n┣ ✦ .wave\n┣ ✦ .pat\n┣ ✦ .dance\n┣ ✦ .punch\n┣ ✦ .bonk\n┗━━━━━━━━━━━\n\n` +
                `*👤 FUN 👤*\n┣ ✦ .gay\n┣ ✦ .simp\n┣ ✦ .ship\n┣ ✦ .pp\n┣ ✦ .wyr\n┣ ✦ .truth\n┣ ✦ .dare\n┣ ✦ .meme\n┣ ✦ .duel\n┗ ✦ .rps\n┗━━━━━━━━━━━\n\n` +
                `*📲 DOWNLOADERS 📲*\n┣ ✦ .ig\n┣ ✦ .ttk\n┣ ✦ .yt\n┣ ✦ .fb\n┗ ✦ .play\n┗━━━━━━━━━━━\n\n` +
                `*🔍 SEARCH 🔍*\n┣ ✦ .pinterest / pint\n┣ ✦ .wallpaper\n┗ ✦ .lyrics\n┗━━━━━━━━━━━\n\n` +
                `*🤖 Ai 🤖*\n┣ ✦ .ai / gpt\n┣ ✦ .imagine\n┣ ✦ .translate / tt\n┗ ✦ .carbon\n┗━━━━━━━━━━━\n\n` +
                `*👤 CONVERTER 👤*\n┣ ✦ .toimg\n┗━━━━━━━━━━━\n\n` +
                `*🎮 ANIME SFW 🎮*\n┣ ✦ .waifu\n┣ ✦ .neko\n┣ ✦ .maid\n┗ ✦ .cosplay\n┗━━━━━━━━━━━\n\n` +
                `*⚙️ ADMIN ⚙️*\n┣ ✦ .kick\n┣ ✦ .delete\n┣ ✦ .antilink\n┣ ✦ .antigcstatus\n┣ ✦ .gcstatus\n┣ ✦ .warn\n┣ ✦ .resetwarn\n┣ ✦ .welcome\n┣ ✦ .setwelcome\n┣ ✦ .leave\n┣ ✦ .setleave\n┣ ✦ .blacklist\n┣ ✦ .promote\n┣ ✦ .demote\n┣ ✦ .mute\n┣ ✦ .unmute\n┣ ✦ .hidetag\n┣ ✦ .tagall\n┣ ✦ .open\n┣ ✦ .close\n┣ ✦ .vv\n┗━━━━━━━━━━━\n\n` +
                `*👑 OWNER 👑*\n┣ ✦ .hijack\n┣ ✦ .kill_gc\n┣ ✦ .antiban\n┗ ✦ .update`;
                return sock.sendMessage(chatId, { text: profileMenu }, { quoted: msg });
            }

            if (command === '.menu') {
                const sub = args[0] ? args[0].toLowerCase() : 'main';
                let menu = "";
                if (sub === 'quiz') { menu = `📌 *QUIZ GAMES*\n\n┣ ✦ .quiz <topic>\n┣ ✦ .truth\n┣ ✦ .dare\n┗ ✦ .wyr`; }
                else if (sub === 'games') { menu = `🎭 *PARTY GAMES*\n\n┣ ✦ .ship @user\n┣ ✦ .gay @user\n┣ ✦ .simp @user\n┣ ✦ .pp @user\n┣ ✦ .rps <choice>`; }
                else if (sub === 'combat') { menu = `⚔️ *COMBAT (1v1)*\n\n┣ ✦ .duel @user\n┗ ✦ .fight @user`; }
                else if (sub === 'casino') { menu = `🎰 *CASINO*\n\n┣ ✦ .slots\n┣ ✦ .dice\n┣ ✦ .roulette <color>\n┣ ✦ .plinko <amount>\n┣ ✦ .horse\n┣ ✦ .poker\n┗ ✦ .gamble <amount>`; }
                else if (sub === 'vfb') { menu = `⚽ *VIRTUAL FOOTBALL*\n\n┗ ✦ .vfb <red/blue> <amount>`; }
                else if (sub === 'economy') { menu = `💰 *ECONOMY*\n\n┣ ✦ .bal\n┣ ✦ .daily\n┣ ✦ .deposit <amt>\n┣ ✦ .withdraw <amt>\n┣ ✦ .profile\n┣ ✦ .lb\n┣ ✦ .msg\n┗ ✦ .top`; }
                else if (sub === 'fun') { menu = `🎭 *FUN & INTERACTION*\n\n┣ ✦ .meme\n┣ ✦ .hug .kiss .slap\n┣ ✦ .wave .pat .dance\n┣ ✦ .punch .bonk\n┗ ✦ .truth / .dare`; }
                else if (sub === 'anime') { menu = `🎮 *ANIME SFW*\n\n┣ ✦ .waifu\n┣ ✦ .neko\n┣ ✦ .maid\n┗ ✦ .cosplay`; }
                else if (sub === 'ai') { menu = ` 🤖 *AI & TOOLS*\n\n┣ ✦ .ai <text>\n┣ ✦ .imagine <prompt>\n┣ ✦ .translate <lang> <text>\n┣ ✦ .carbon <text>\n┣ ✦ .toimg (Reply to sticker)\n┣ ✦ .stats\n┗ ✦ .otp`; }
                else if (sub === 'dl' || sub === 'downloaders') { menu = `📥 *DOWNLOADERS*\n\n┣ ✦ .play <song>\n┣ ✦ .ig <url>\n┣ ✦ .ttk <url>\n┣ ✦ .yt <url>\n┗ ✦ .fb <url>`; }
                else if (sub === 'admin') { menu = `🛡️ *ADMIN COMMANDS*\n\n┣ ✦ .kick .promote .demote\n┣ ✦ .mute .unmute .delete\n┣ ✦ .setwelcome .setleave\n┣ ✦ .antilink .antigcstatus .gcstatus\n┣ ✦ .open .close .tagall .hidetag\n┣ ✦ .leave .vv\n┗ ✦ .blacklist (Owner)`; }
                else if (sub === 'stats') { menu = `📊 *STATS & PROFILES*\n\n┣ ✦ .msg\n┣ ✦ .top\n┣ ✦ .lb\n┣ ✦ .profile\n┗ ✦ .stats`; }
                else if (sub === 'owner') { menu = `👑 *OWNER ONLY*\n\n┣ ✦ .hijack\n┣ ✦ .kill_gc\n┣ ✦ .antiban\n┗ ✦ .update`; }
                else if (['gnosia', 'compete', 'dominion', 'collection', 'guilds', 'seasons', 'bounties'].includes(sub)) { menu = `🚧 *${sub.toUpperCase()}*\n\nThis feature is currently under construction.`; }
                else {
                    menu = `╭━━★彡 𝚂𝚄𝙿𝚁𝙴𝙼𝙴 彡★━━╮\n┃  𖤓 Name: Mjay\n┃  𖤓 Creator: Mkage\n╰━━━━━━━━━━━━━╯\n\n` +
                           `📌 *.menu quiz* — _Quiz games_\n🎭 *.menu games* — _Party games_\n⚔️ *.menu combat* — _Duels & 1v1_\n🎰 *.menu casino* — _Slots, Plinko, Poker_\n⚽ *.menu vfb* — _Virtual Football_\n💰 *.menu economy* — _Wallet & Bank_\n` +
                           `🎭 *.menu fun* — _Memes & Interactions_\n🎮 *.menu anime* — _Anime images_\n🤖 *.menu ai* — _AI & Tools_\n📥 *.menu dl* — _Downloaders_\n` +
                           `🛡️ *.menu admin* — _Group Management_\n📊 *.menu stats* — _Leaderboards_\n👑 *.menu owner* — _Owner Commands_\n\n` +
                           `━━━━━━━━━━━━━━━━━━━━━━\n💡 Type *.profile* for the full list of commands!`;
                }
                return sock.sendMessage(chatId, { text: menu });
            }

            if (command === '.delete') {
                const stanzaId = msg.message.extendedTextMessage?.contextInfo?.stanzaId;
                if (!stanzaId) return sock.sendMessage(chatId, { text: "❌ Reply to a message to delete it." }, { quoted: msg });
                try { await sock.sendMessage(chatId, { delete: { remoteJid: chatId, fromMe: false, id: stanzaId, participant: quotedParticipant } }); await sock.sendMessage(chatId, { text: "✅ Message deleted." }, { quoted: msg }); }
                catch (e) { await sock.sendMessage(chatId, { text: "❌ Failed to delete. Make sure I am an Admin." }, { quoted: msg }); }
                return;
            }
            if (command === '.antiban' && isOwner) { db.settings.antiban = !db.settings.antiban; saveDB(db); return sock.sendMessage(chatId, { text: `🛡️ Anti-Ban delays are now *${db.settings.antiban ? 'ON' : 'OFF'}*.` }); }
            if (command === '.antigcstatus') { if (!isGroup) return; db.antigcstatus[chatId] = !db.antigcstatus[chatId]; saveDB(db); return sock.sendMessage(chatId, { text: `✅ Anti-GC-Status is now *${db.antigcstatus[chatId] ? 'ON' : 'OFF'}*.` }); }
            if (command === '.gcstatus') {
                if (!isGroup) return;
                const textToPost = args.join(" "); if (!textToPost) return;
                try { await sock.sendMessage(chatId, { groupStatusMessage: { text: textToPost, backgroundColor: "#23313A", font: 1 } }); await sock.sendMessage(chatId, { text: "✅ Group status posted!" }); }
                catch (e) { await sock.sendMessage(chatId, { text: "❌ Failed. WhatsApp has blocked raw Group Status posts." }); }
                return;
            }
            if (command === '.wake') { spamTracker[senderNumber] = []; activeChats[chatId] = Date.now(); return sock.sendMessage(chatId, { text: "I'm awake! What do you want? (๑•̀ㅂ•́)و" }, { quoted: msg }); }

            if (command === '.leave' && isGroup) {
                const metadata = await sock.groupMetadata(chatId);
                if (!isOwner && !metadata.participants.find(p => p.id === senderJid)?.admin) return sock.sendMessage(chatId, { text: "❌ Admin required." });
                await sock.sendMessage(chatId, { text: "👋 Goodbye!" }); await new Promise(r => setTimeout(r, 1500)); await sock.groupLeave(chatId); return;
            }
            if (command === '.setwelcome') { db.welcome[chatId] = { enabled: true, text: args.join(" ") }; saveDB(db); return sock.sendMessage(chatId, { text: `✅ Welcome msg updated.` }); }
            if (command === '.setleave') { db.leave[chatId] = { enabled: true, text: args.join(" ") }; saveDB(db); return sock.sendMessage(chatId, { text: `✅ Leave msg updated.` }); }
            if (command === '.antilink') { db.antilink[chatId] = !db.antilink[chatId]; saveDB(db); return sock.sendMessage(chatId, { text: `✅ Anti-Link is *${db.antilink[chatId] ? 'ON' : 'OFF'}*.` }); }
            if (command === '.open') { await sock.groupSettingUpdate(chatId, "not_announcement").catch(() => {}); return sock.sendMessage(chatId, { text: "🔓 Group opened." }); }
            if (command === '.close') { await sock.groupSettingUpdate(chatId, "announcement").catch(() => {}); return sock.sendMessage(chatId, { text: "🔒 Group closed." }); }
            if (command === '.tagall') { const meta = await sock.groupMetadata(chatId); return sock.sendMessage(chatId, { text: "📢 *Attention Everyone!*", mentions: meta.participants.map(p => p.id) }); }
            if (command === '.hidetag') { const meta = await sock.groupMetadata(chatId); return sock.sendMessage(chatId, { text: args.join(" ") || " ", mentions: meta.participants.map(p => p.id) }); }
            if (['.kick', '.promote', '.demote', '.mute', '.unmute'].includes(command)) {
                const target = quotedParticipant || mentionedJid[0]; if (!target) return;
                try {
                    if (command === '.kick') await sock.groupParticipantsUpdate(chatId, [target], "remove");
                    if (command === '.promote') await sock.groupParticipantsUpdate(chatId, [target], "promote");
                    if (command === '.demote') await sock.groupParticipantsUpdate(chatId, [target], "demote");
                    if (command === '.mute') { if (!db.muted[chatId]) db.muted[chatId] = []; if (!db.muted[chatId].includes(target.split('@')[0])) db.muted[chatId].push(target.split('@')[0]); saveDB(db); }
                    if (command === '.unmute') { if (db.muted[chatId]) db.muted[chatId] = db.muted[chatId].filter(n => n !== target.split('@')[0]); saveDB(db); }
                    sock.sendMessage(chatId, { text: `✅ Done.` });
                } catch { sock.sendMessage(chatId, { text: "❌ Admin required." }); } return;
            }

            if (command === '.msg') { const count = db.messages[chatId]?.[senderNumber] || 0; return sock.sendMessage(chatId, { text: `📩 @${senderNumber}, you sent *${count}* messages!`, mentions: [senderJid] }, { quoted: msg }); }
            if (command === '.top') {
                if (!db.messages[chatId]) return;
                const sorted = Object.entries(db.messages[chatId]).sort((a, b) => b[1] - a[1]).slice(0, 10);
                const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]; let txt = "🏆 *TOP 10 CHATTERS* 🏆\n\n"; let mentions = [];
                sorted.forEach((user, i) => { txt += `${medals[i]} @${user[0]} - *${user[1]}* msgs\n`; mentions.push(user[0] + "@s.whatsapp.net"); });
                return sock.sendMessage(chatId, { text: txt, mentions: mentions }, { quoted: msg });
            }
            if (command === '.balance' || command === '.bal') return sock.sendMessage(chatId, { text: `💰 Wallet: *${db.users[senderNumber].balance}* | Bank: *${db.users[senderNumber].bank}*`, mentions: [senderJid] });
            if (command === '.daily') {
                if (Date.now() - db.users[senderNumber].lastDaily < 86400000) return sock.sendMessage(chatId, { text: "⏳ Already claimed." });
                db.users[senderNumber].balance += 500; db.users[senderNumber].lastDaily = Date.now(); saveDB(db); return sock.sendMessage(chatId, { text: `🎁 Claimed 500 coins!` });
            }
            if (command === '.deposit') { const amt = parseInt(args[0]); if (isNaN(amt) || amt <= 0 || db.users[senderNumber].balance < amt) return; db.users[senderNumber].balance -= amt; db.users[senderNumber].bank += amt; saveDB(db); return sock.sendMessage(chatId, { text: `🏦 Deposited ${amt}.` }); }
            if (command === '.withdraw') { const amt = parseInt(args[0]); if (isNaN(amt) || amt <= 0 || db.users[senderNumber].bank < amt) return; db.users[senderNumber].bank -= amt; db.users[senderNumber].balance += amt; saveDB(db); return sock.sendMessage(chatId, { text: `🏦 Withdrew ${amt}.` }); }

            if (command === '.slots') {
                const e = ['🍒', '🍋', '🍇', '💎', '7️⃣']; const r = [e[Math.floor(Math.random()*5)], e[Math.floor(Math.random()*5)], e[Math.floor(Math.random()*5)]];
                let txt = `🎰 [ ${r.join(' | ')} ]\n`; if (r[0]===r[1] && r[1]===r[2]) { db.users[senderNumber].balance += 500; txt += "🎉 JACKPOT! +500 coins"; }
                else if (r[0]===r[1] || r[1]===r[2] || r[0]===r[2]) { db.users[senderNumber].balance += 50; txt += "✨ Matched 2! +50 coins"; }
                else txt += "😢 You lost."; saveDB(db); return sock.sendMessage(chatId, { text: txt });
            }
            if (command === '.dice') return sock.sendMessage(chatId, { text: `🎲 You rolled a *${Math.floor(Math.random()*6)+1}*` });
            if (command === '.plinko') { const amt = parseInt(args[0]); if (isNaN(amt) || db.users[senderNumber].balance < amt) return; const mults = [0, 0.5, 1, 1.5, 2, 5]; const res = mults[Math.floor(Math.random() * mults.length)]; db.users[senderNumber].balance = (db.users[senderNumber].balance - amt) + Math.floor(amt * res); saveDB(db); return sock.sendMessage(chatId, { text: `🎰 *PLINKO*\nMultiplier: *${res}x*` }); }
            if (command === '.horse') { const h = ["🐎 Red", "🐎 Blue", "🐎 Green", "🐎 Yellow", "🐎 Black"]; const w = h[Math.floor(Math.random() * h.length)]; return sock.sendMessage(chatId, { text: `🏇 *HORSE RACE*\n🥇 Winner: *${w}*!` }); }
            if (command === '.poker') { const s = ['♠️', '♥️', '♦️', '♣️']; const r = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']; let h = []; for(let i=0; i<5; i++) h.push(`${r[Math.floor(Math.random()*13)]}${s[Math.floor(Math.random()*4)]}`); return sock.sendMessage(chatId, { text: `🃏 *POKER HAND*\n\n${h.join('  ')}` }); }
            if (command === '.vfb') { const t = args[0]?.toLowerCase(); const a = parseInt(args[1]); if (!['red', 'blue'].includes(t) || isNaN(a) || db.users[senderNumber].balance < a) return; const sR = Math.floor(Math.random() * 4), sB = Math.floor(Math.random() * 4); let m = `⚽ Red ${sR} - ${sB} Blue\n\n`; if ((t==='red'&&sR>sB)||(t==='blue'&&sB>sR)) { db.users[senderNumber].balance += a; m+="🎉 Won!"; } else if(sR===sB){ m+="🤝 Draw."; } else { db.users[senderNumber].balance -= a; m+="😢 Lost."; } saveDB(db); return sock.sendMessage(chatId, { text: m }); }
            if (command === '.duel' || command === '.fight') { const target = quotedParticipant || mentionedJid[0]; if (!target) return; const tNum = target.split('@')[0]; if (db.users[senderNumber].balance < 50 || db.users[tNum].balance < 50) return; if (Math.random() > 0.5) { db.users[senderNumber].balance += 50; db.users[tNum].balance -= 50; saveDB(db); await sock.sendMessage(chatId, { text: `⚔️ @${senderNumber} WON 50 coins from @${tNum}!`, mentions: [senderJid, target] }); } else { db.users[senderNumber].balance -= 50; db.users[tNum].balance += 50; saveDB(db); await sock.sendMessage(chatId, { text: `⚔️ @${senderNumber} LOST 50 coins to @${tNum}!`, mentions: [senderJid, target] }); } return; }
            if (command === '.rps') { const u = args[0]?.toLowerCase(); if (!['rock', 'paper', 'scissors'].includes(u)) return; const b = ['rock', 'paper', 'scissors'][Math.floor(Math.random() * 3)]; let res = (u === b) ? "Tie! 🤝" : ((u === 'rock' && b === 'scissors') || (u === 'paper' && b === 'rock') || (u === 'scissors' && b === 'paper')) ? "You win! 🎉" : "I win! 😈"; return sock.sendMessage(chatId, { text: `You: ${u} | Bot: ${b}\n\n${res}` }); }
            if (['.gay', '.simp', '.pp', '.ship'].includes(command)) { const p = Math.floor(Math.random() * 101); let t = quotedParticipant ? quotedParticipant.split('@')[0] : senderNumber; return sock.sendMessage(chatId, { text: `🔮 @${t} is *${p}%* ${command.replace('.', '')}!`, mentions: [t + "@s.whatsapp.net"] }); }
            if (command === '.wyr' || command === '.wouldyourather') { const q = ["Be rich but ugly, or poor but attractive?", "Have no internet for a month, or no food for a week?", "Fly, or be invisible?"]; return sock.sendMessage(chatId, { text: `🤔 *WYR:*\n${q[Math.floor(Math.random()*q.length)]}` }); }
            if (command === '.truth') { const q = ["Biggest fear?", "First crush?", "Most embarrassing moment?"]; return sock.sendMessage(chatId, { text: `🕵️ *TRUTH:*\n${q[Math.floor(Math.random()*q.length)]}` }); }
            if (command === '.dare') { const q = ["Send last gallery photo.", "Type alphabet backwards.", "Tag someone and say I love you."]; return sock.sendMessage(chatId, { text: `🔥 *DARE:*\n${q[Math.floor(Math.random()*q.length)]}` }); }
            if (command === '.meme') { try { const res = await fetch('https://meme-api.com/gimme'); const d = await res.json(); return sock.sendMessage(chatId, { image: { url: d.url }, caption: d.title }); } catch {} }
            if (['.hug', '.kiss', '.slap', '.wave', '.pat', '.dance', '.punch', '.bonk'].includes(command)) { const act = command.replace('.', ''); try { const res = await fetch(`https://api.waifu.pics/sfw/${act}`); const d = await res.json(); return sock.sendMessage(chatId, { video: { url: d.url }, gifPlayback: true, caption: `@${senderNumber} ${act}s!`, mentions: [senderJid] }); } catch {} }
            if (['.waifu', '.neko', '.maid', '.cosplay'].includes(command)) { try { const res = await fetch(`https://api.waifu.pics/sfw/${command.replace('.','')}`); const d = await res.json(); return sock.sendMessage(chatId, { image: { url: d.url } }); } catch {} }

            if (command === '.stats') return sock.sendMessage(chatId, { text: `📊 RAM: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB | OS: ${os.platform()}` });
            if (command === '.otp') return sock.sendMessage(chatId, { text: `🔐 *OTP:* ${Math.floor(100000 + Math.random() * 900000)}` });
            if (command === '.translate' || command === '.tt') { const lang = args.shift(); const txt = args.join(" "); try { const res = await fetch(`https://api.popcat.xyz/translate?text=${encodeURIComponent(txt)}&to=${lang}`); const d = await res.json(); return sock.sendMessage(chatId, { text: ` 🌐 ${d.translated}` }); } catch {} }
            if (command === '.lyrics') { try { const res = await fetch(`https://api.popcat.xyz/lyrics?song=${encodeURIComponent(args.join(" "))}`); const d = await res.json(); return sock.sendMessage(chatId, { text: `🎵 ${d.title}\n\n${d.lyrics.slice(0, 1000)}...` }); } catch {} }
            if (command === '.wallpaper') { try { const res = await fetch(`https://api.waifu.pics/sfw/waifu`); const d = await res.json(); return sock.sendMessage(chatId, { image: { url: d.url } }); } catch {} }
            if (command === '.pinterest') { try { const res = await fetch(`https://api.vreden.web.id/api/pinterest?query=${encodeURIComponent(args.join(" "))}`); const d = await res.json(); return sock.sendMessage(chatId, { image: { url: d.result[Math.floor(Math.random()*d.result.length)] } }); } catch {} }

            if (command === '.play') {
                const q = args.join(" "); if(!q) return sock.sendMessage(chatId, { text: "❌ Usage: .play <song name>" });
                await sock.sendMessage(chatId, { text: `🔍 Searching for *${q}*...` });

                let audioUrl = null; let title = q;
                try { const r = await fetch(`https://api.vreden.web.id/api/ytplay?query=${encodeURIComponent(q)}`); const d = await r.json(); if(d.result && d.result.audio) { audioUrl = d.result.audio; title = d.result.title || q; } } catch(e) {}
                if (!audioUrl) { try { const r = await fetch(`https://api.zenzxz.my.id/downloader/ytplay?query=${encodeURIComponent(q)}`); const d = await r.json(); if(d.status && d.result && d.result.audio) { audioUrl = d.result.audio; title = d.result.title || q; } } catch(e) {} }
                if (!audioUrl) { try { const r = await fetch(`https://api.betabotz.eu.org/api/download/ytplay?query=${encodeURIComponent(q)}`); const d = await r.json(); if(d.status && d.result && d.result.audio) { audioUrl = d.result.audio; title = d.result.title || q; } } catch(e) {} }

                if (audioUrl) {
                    try {
                        const audioRes = await fetch(audioUrl);
                        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
                        return sock.sendMessage(chatId, { audio: audioBuffer, mimetype: 'audio/mp4', fileName: `${title}.mp3` }, { quoted: msg });
                    } catch (e) { return sock.sendMessage(chatId, { text: "❌ Failed to download the audio file." }); }
                } else { return sock.sendMessage(chatId, { text: "❌ All download servers are currently down. Try again later." }); }
            }

            if (['.ig', '.ttk', '.yt', '.fb'].includes(command)) { await sock.sendMessage(chatId, { text: `⏳ Downloading...` }); try { const res = await fetch(`https://api.vreden.web.id/api/${command.replace('.','')}?url=${encodeURIComponent(args[0])}`); const d = await res.json(); const mUrl = d.result?.video || d.result?.url || d.result[0]?.url; if (mUrl) return sock.sendMessage(chatId, { video: { url: mUrl } }); else throw new Error(); } catch { return sock.sendMessage(chatId, { text: "❌ Failed." }); } }
            if (command === '.ai' || command === '.gpt') return sock.sendMessage(chatId, { text: await getAIResponse(args.join(" ")) }, { quoted: msg });
            if (command === '.imagine') { try { return sock.sendMessage(chatId, { image: { url: `https://image.pollinations.ai/prompt/${encodeURIComponent(args.join(" "))}` }, caption: `🎨 ${args.join(" ")}` }); } catch {} }
            if (command === '.carbon') { try { return sock.sendMessage(chatId, { image: { url: `https://api.popcat.xyz/carbon?text=${encodeURIComponent(args.join(" "))}` } }); } catch {} }
            if (command === '.toimg') { const isSticker = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage; if (!isSticker) return; try { const buffer = await sock.downloadMediaMessage(msg.message.extendedTextMessage.contextInfo.quotedMessage); return sock.sendMessage(chatId, { image: buffer }); } catch {} }
            if (command === '.quiz') {
                const topic = args.join(" ");
                if (!topic) { const qs = [{ q: "What is the largest planet?", a: "jupiter" }, { q: "What year did WW2 end?", a: "1945" }]; const q = qs[Math.floor(Math.random() * qs.length)]; activeQuizzes[chatId] = { answer: q.a }; return sock.sendMessage(chatId, { text: `📌 *QUIZ*\n\n${q.q}\n\n_Reply with the answer to win 100 coins!_` }); }
                await sock.sendMessage(chatId, { text: `🧠 Generating a quiz about *${topic}*...` });
                try { const prompt = `Generate a short, trivia question and its exact short answer about "${topic}". Format EXACTLY as: Question | Answer. No other text.`; const aiRes = await fetch('https://text.pollinations.ai/' + encodeURIComponent(prompt)); const raw = (await aiRes.text()).trim(); const parts = raw.split('|'); if (parts.length >= 2) { activeQuizzes[chatId] = { answer: parts[1].trim() }; await sock.sendMessage(chatId, { text: `📌 *QUIZ: ${topic.toUpperCase()}*\n\n${parts[0].trim()}\n\n_Reply with the answer to win 100 coins!_` }); } else throw new Error("Invalid format"); } catch (e) { await sock.sendMessage(chatId, { text: "❌ Failed to generate a quiz right now. Try again." }); } return;
            }

            if (!text.startsWith('.') && activeQuizzes[chatId]) {
                const userAnswer = text.trim().toLowerCase(); const correctAnswer = activeQuizzes[chatId].answer.toLowerCase();
                if (userAnswer.includes(correctAnswer) || correctAnswer.includes(userAnswer)) { db.users[senderNumber].balance += 100; saveDB(db); await sock.sendMessage(chatId, { text: `✅ *CORRECT!* @${senderNumber} won 100 coins! 🎉`, mentions: [senderJid] }); delete activeQuizzes[chatId]; }
                return;
            }

            const now = Date.now(); const isActiveChat = activeChats[chatId] && (now - activeChats[chatId] < 5 * 60 * 1000);
            if (!text.startsWith('.') && (!isGroup || quotedParticipant === sock.user.id || mentionedJid.includes(sock.user.id) || text.toLowerCase().includes('mjay') || isActiveChat)) {
                const cleanText = text.replace(/mjay/gi, '').replace(/@\d+/g, '').trim(); activeChats[chatId] = Date.now(); await sock.sendMessage(chatId, { text: await getAIResponse(cleanText || "Hey") }, { quoted: msg });
            }
        } catch (globalError) {
            console.log("⚠️ [Command Error Caught]:", globalError.message);
        }
    });
}

startBot();
