import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import readline from 'readline';

// ============================================================
// CONFIGURAÇÕES
// ============================================================
const RESPOSTA = '🤖 usuário indisponível. Tente mais tarde';
const RESPONDER_GRUPO = false;      
const HORARIO_COMERCIAL = false;    
const INTERVALO_MINUTOS = 5;
const MEU_NUMERO = '258849681904';
// ============================================================

const ultimaResposta = new Map();
let tentativas = 0;
const MAX_TENTATIVAS = 10;

async function start() {
  tentativas++;
  console.log(`\n🔄 [Tentativa ${tentativas}/${MAX_TENTATIVAS}] Conectando...`);

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  console.log(`📦 Protocolo WhatsApp: ${version.join('.')}`);
  console.log(`📦 Registrado: ${state.creds.registered ? 'SIM ✅' : 'NÃO (escaneie o QR)'}`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'warn' }),
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
  });

  // ---------- QR Code (Agora via Link) ----------
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.clear();
      console.log('\n═══════════════════════════════════════════');
      console.log('📱 LINK PARA O QR CODE');
      console.log('═══════════════════════════════════════════');
      console.log('\n1. Copie o link abaixo e cole no navegador do celular:');
      console.log(`\n👉 https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(qr)} 👈\n`);
      console.log('2. A imagem do QR vai abrir.');
      console.log('3. Abra o WhatsApp > Dispositivos Conectados > Conectar dispositivo.');
      console.log('4. Aponte a câmera para o QR na tela do celular (ou salve a imagem e use "Escanear do rolo da câmera").');
      console.log('\n⏰ O QR expira em ~60 segundos. Se expirar, um novo link aparece.\n');
    }

    // ---------- Desconexão ----------
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'sem mensagem';

      console.log(`\n❌ Desconectado. Código: ${statusCode} | Motivo: ${reason}`);

      if (statusCode === 515) {
        console.log('ℹ️  Código 515 = reinício normal após autenticar. Reconectando...\n');
        setTimeout(() => start(), 2000);
        return;
      }

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log('\n🚫 Sessão inválida. Apague a pasta auth_info e faça o redeploy.\n');
        process.exit(1);
      }

      if (tentativas >= MAX_TENTATIVAS) {
        console.log(`\n🚫 Limite de tentativas. Apague a pasta auth_info e faça o redeploy.\n`);
        process.exit(1);
      }

      const espera = 3000 * tentativas;
      console.log(`⏳ Reconectando em ${espera / 1000}s...\n`);
      setTimeout(() => start(), espera);
    }

    // ---------- Conectado ----------
    if (connection === 'open') {
      console.log('\n✅ Bot conectado ao WhatsApp com sucesso!');
      console.log(`📞 Número: ${MEU_NUMERO}`);
      console.log(`📤 Resposta: "${RESPOSTA}"\n`);
      tentativas = 0;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ---------- Mensagens recebidas ----------
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid) continue;

        const isGroup = jid.endsWith('@g.us');
        if (isGroup && !RESPONDER_GRUPO) continue;

        const agora = Date.now();
        const ultima = ultimaResposta.get(jid);
        const intervaloMs = INTERVALO_MINUTOS * 60 * 1000;

        if (ultima && (agora - ultima) < intervaloMs) {
          continue;
        }

        await sock.sendMessage(jid, { text: RESPOSTA }, { quoted: msg });
        ultimaResposta.set(jid, agora);
        console.log(`✅ Resposta enviada para: ${jid}`);

        const UM_DIA = 24 * 60 * 60 * 1000;
        for (const [key, ts] of ultimaResposta.entries()) {
          if (agora - ts > UM_DIA) ultimaResposta.delete(key);
        }

      } catch (err) {
        console.error('❌ Erro ao processar mensagem:', err.message);
      }
    }
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', (err) => console.error('❌ Erro:', err.message));
process.on('unhandledRejection', (err) => console.error('❌ Promise:', err?.message || err));

start();