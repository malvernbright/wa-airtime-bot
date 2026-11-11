// WhatsApp bot (Baileys) for Termux/Linux.
//  - Airtime catcher: watches ONE channel, extracts the voucher, dials USSD via Android.
//  - Draft assistant: writes suggested replies (NEVER sends anything to WhatsApp).
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const SEEN_FILE = './seen.json';
const seen = new Set(fs.existsSync(SEEN_FILE) ? JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) : []);
const codeRe = new RegExp(cfg.airtime.codeRegex);
const log = (...a) => cfg.debug && console.log(new Date().toISOString(), ...a);

let channelJid = cfg.airtime.channelJid || '';
let lastDial = 0;
const history = new Map(); // jid -> [{role, content}]

// ---------- helpers ----------
function textOf(m) {
  const x = m?.message;
  if (!x) return '';
  return (
    x.conversation ||
    x.extendedTextMessage?.text ||
    x.imageMessage?.caption ||
    x.videoMessage?.caption ||
    ''
  );
}

function dial(code) {
  const ussd = cfg.airtime.ussdTemplate.replace('{code}', code).replace('#', '%23');
  if (cfg.airtime.dryRun) return log('[dryRun] would dial', ussd);
  execFile('am', ['start', '-a', 'android.intent.action.CALL', '-d', `tel:${ussd}`], (err) => {
    if (err) console.error('dial failed:', err.message);
  });
}

function handleAirtime(text) {
  const m = text.match(codeRe);
  if (!m) return;
  const code = m.slice(1).join('');
  if (seen.has(code)) return;
  seen.add(code);
  // Dial first, persist after: speed matters here.
  const wait = Math.max(0, cfg.airtime.minGapMs - (Date.now() - lastDial));
  lastDial = Date.now() + wait;
  setTimeout(() => dial(code), wait);
  setTimeout(() => fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen])), 0);
  log('airtime code caught', code, 'wait', wait);
}

// ---------- draft assistant (never sends) ----------
async function notify(text) {
  const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  fs.appendFileSync('./drafts.log', text + '\n---\n');
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return console.log(text);
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  }).catch((e) => console.error('telegram error', e.message));
}

async function draftReply(jid, name, text) {
  const h = history.get(jid) || [];
  h.push({ role: 'user', content: `${name}: ${text}` });
  history.set(jid, h.slice(-12));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.drafts.model,
      max_tokens: 400,
      system: cfg.drafts.persona + ' Output only the reply text.',
      messages: history.get(jid),
    }),
  });
  const data = await res.json();
  const draft = data?.content?.[0]?.text?.trim();
  if (draft) await notify(`Draft reply to ${name}:\n\n${draft}`);
}

// ---------- main ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false, // don't show you as online
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'open') {
      console.log('connected');
      try {
        if (cfg.airtime.enabled && !channelJid && cfg.airtime.channelInvite) {
          const meta = await sock.newsletterMetadata('invite', cfg.airtime.channelInvite);
          channelJid = meta.id;
          console.log('channel resolved:', meta.name, channelJid, '(put this in config.json)');
        }
        if (channelJid && sock.subscribeNewsletterUpdates) {
          await sock.subscribeNewsletterUpdates(channelJid);
        }
      } catch (e) {
        console.error('channel setup error:', e.message);
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) start();
      else console.log('logged out; delete ./auth and re-scan');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      const jid = m.key.remoteJid || '';
      const text = textOf(m);
      log('msg from', jid, JSON.stringify(text.slice(0, 60)));

      // 1) airtime channel: hot path, nothing slow before this
      if (cfg.airtime.enabled && channelJid && jid === channelJid) {
        handleAirtime(text);
        continue;
      }

      // 2) drafts: incoming 1:1/group messages from allow-listed chats only
      if (
        cfg.drafts.enabled &&
        !m.key.fromMe &&
        text &&
        !jid.endsWith('@newsletter') &&
        jid !== 'status@broadcast' &&
        (cfg.drafts.allowChats.length === 0 || cfg.drafts.allowChats.includes(jid))
      ) {
        draftReply(jid, m.pushName || jid, text).catch((e) => console.error('draft error', e.message));
      }
    }
  });
}

start();
