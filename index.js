const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');

// ============================================================
// CONFIGURAÇÕES
// ============================================================
const RESPOSTA = '🤖 usuário indisponível. Tente mais tarde';
const RESPONDER_GRUPO = false;      // true = também responde em grupos
const HORARIO_COMERCIAL = false;    // true = só responde entre 8h e 18h

// ⏱️ Intervalo mínimo entre respostas ao MESMO contato (em minutos)
const INTERVALO_MINUTOS = 5;

// Número alvo (só para exibir no log)
const MEU_NUMERO = '258849681904';
// ============================================================

const ultimaResposta = new Map(); // jid -> timestamp da última resposta
let tentativas = 0;
const MAX_TENTATIVAS = 10;

async function start() {
  tentativas++;
  console.log(`\n🔄 [Tentativa ${tentativas}/${MAX_TENTATIVAS}] Conectando...`);

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  console.log(`📦 Protocolo WhatsApp: ${version.join('.')}`);
  console.log(`📦 Registrado: ${state.creds.registered ? 'SIM ✅' : 'NÃO (escaneie o QR)'}`);
  console.log(`📞 Número alvo: ${MEU_NUMERO}`);
  console.log(`⏱️  Intervalo por contato: ${INTERVALO_MINUTOS} minutos`);

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

  // ---------- QR Code ----------
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.clear();
      console.log('\n═══════════════════════════════════════════');
      console.log('📱 ESCANEIE O QR CODE ABAIXO');
      console.log('═══════════════════════════════════════════');
      console.log('\nNo celular (número 849681904):');
      console.log('  1. WhatsApp > Configurações > Dispositivos conectados');
      console.log('  2. "Conectar um dispositivo"');
      console.log('  3. Aponte a câmera para o QR abaixo\n');

      qrcode.generate(qr, { small: true });

      try {
        await QRCode.toFile('qrcode.png', qr, { width: 400 });
        console.log('\n📷 QR também salvo em: qrcode.png (abra e escaneie)');
      } catch (e) {}

      console.log('\n⏰ O QR expira em ~60 segundos. Se expirar, um novo aparece.\n');
    }

    // ---------- Desconexão ----------
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'sem mensagem';

      console.log(`\n❌ Desconectado.`);
      console.log(`   Código: ${statusCode} | Motivo: ${reason}`);

      if (statusCode === 515) {
        console.log('ℹ️  Código 515 = reinício normal após autenticar. Reconectando...\n');
        setTimeout(() => start(), 2000);
        return;
      }

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log('\n🚫 Sessão inválida. Apague auth_info e rode novamente:');
        console.log('   Remove-Item -Recurse -Force auth_info\n');
        process.exit(1);
      }

      if (statusCode === DisconnectReason.badSession) {
        console.log('\n🚫 Sessão corrompida. Apague auth_info e rode novamente.\n');
        process.exit(1);
      }

      if (tentativas >= MAX_TENTATIVAS) {
        console.log(`\n🚫 Limite de tentativas. Apague auth_info:\n`);
        console.log('   Remove-Item -Recurse -Force auth_info\n');
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
      console.log(`📤 Resposta: "${RESPOSTA}"`);
      console.log(`⏱️  Intervalo por contato: ${INTERVALO_MINUTOS} min\n`);
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

        if (HORARIO_COMERCIAL) {
          const h = new Date().getHours();
          if (h < 8 || h >= 18) continue;
        }

        // ⏱️ Verifica o intervalo mínimo de 5 minutos por contato
        const agora = Date.now();
        const ultima = ultimaResposta.get(jid);
        const intervaloMs = INTERVALO_MINUTOS * 60 * 1000;

        if (ultima && (agora - ultima) < intervaloMs) {
          const restante = Math.ceil((intervaloMs - (agora - ultima)) / 1000);
          console.log(`⏳ Ignorado (${jid}) — faltam ${restante}s para poder responder de novo`);
          continue;
        }

        // Responde
        await sock.sendMessage(
          jid,
          { text: RESPOSTA },
          { quoted: msg }
        );

        ultimaResposta.set(jid, agora);
        console.log(`✅ Resposta enviada para: ${jid}`);

        // 🧹 Limpa entradas antigas da memória (mais de 24h)
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

// ---------- Encerramento ----------
process.on('SIGINT', () => {
  console.log('\n👋 Bot encerrado.');
  process.exit(0);
});

process.on('uncaughtException', (err) => console.error('❌ Erro:', err.message));
process.on('unhandledRejection', (err) => console.error('❌ Promise:', err?.message || err));

start();