const express = require('express');
try { require('dotenv').config(); } catch (e) {}
const mongoose = require('mongoose');
const cors    = require('cors');
const http    = require('http');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.json());
app.use(cors());

// ─────────────────────────────────────────
// CONFIGURAÇÃO DB (100% CLOUD - MONGODB ATLAS)
// ─────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URL || process.env.MONGODB_URL;

if (!MONGO_URI) {
    console.error("❌ ERRO CRÍTICO: MONGO_URL não encontrada nas variáveis de ambiente!");
    process.exit(1);
}

// ─────────────────────────────────────────
// MODELOS (SCHEMAS)
// ─────────────────────────────────────────

const ServerRoomSchema = new mongoose.Schema({
    room_id:   { type: String, required: true, unique: true },
    host_ip:   { type: String, required: true },
    local_ip:  { type: String },
    host_name: { type: String },
    last_ping: { type: Date, default: Date.now }
});
const ServerRoom = mongoose.model('ServerRoom', ServerRoomSchema);

const PlayerPositionSchema = new mongoose.Schema({
    room_id:     { type: String, required: true },
    player_name: { type: String, required: true },
    pos_x: Number, pos_y: Number, pos_z: Number,
    rot_x: Number, rot_y: Number, rot_z: Number,
    last_update: { type: Date, default: Date.now }
});
PlayerPositionSchema.index({ room_id: 1, player_name: 1 }, { unique: true });
const PlayerPosition = mongoose.model('PlayerPosition', PlayerPositionSchema);

const GlobalPlayerSchema = new mongoose.Schema({
    ip:           { type: String, required: true, unique: true },
    username:     { type: String, required: true },
    current_room: { type: String, default: null },
    last_seen:    { type: Date, default: Date.now }
});
const GlobalPlayer = mongoose.model('GlobalPlayer', GlobalPlayerSchema);

// ─────────────────────────────────────────
// INICIALIZA BANCO
// ─────────────────────────────────────────
async function initDB() {
    try {
        console.log("⏳ Conectando ao MongoDB...");
        await mongoose.connect(MONGO_URI);
        console.log("✅ MongoDB Conectado!");
        startCleanupLoop();
    } catch (err) {
        console.error("❌ Erro ao conectar ao MongoDB:", err.message);
        setTimeout(initDB, 5000);
    }
}

// ─────────────────────────────────────────
// FAXINEIRO AUTOMÁTICO
// ─────────────────────────────────────────
function startCleanupLoop() {
    setInterval(async () => {
        try {
            const fiveMinsAgo = new Date(Date.now() - 5 * 60000);
            const sevenMinsAgo = new Date(Date.now() - 7 * 60000);

            await GlobalPlayer.updateMany(
                { last_seen: { $lt: fiveMinsAgo } },
                { current_room: null }
            );

            await ServerRoom.deleteMany({ last_ping: { $lt: fiveMinsAgo } });

            const result = await GlobalPlayer.deleteMany({ last_seen: { $lt: sevenMinsAgo } });
            
            if (result.deletedCount > 0)
                console.log(`🧹 Faxina: ${result.deletedCount} almas removidas.`);
        } catch (err) {
            console.error("❌ Erro na limpeza:", err.message);
        }
    }, 60000);
}

initDB();


// ─────────────────────────────────────────
// WEBSOCKET — controle de salas em memória
// rooms: Map<room_id, Array<{ws, player_name, is_ready}>>
// ─────────────────────────────────────────
const rooms = new Map();

function broadcastToRoom(room_id, data, excludeWs = null) {
    if (!rooms.has(room_id)) return;
    const msg = JSON.stringify(data);
    for (const client of rooms.get(room_id)) {
        if (client.ws !== excludeWs && client.ws.readyState === 1 /* OPEN */) {
            client.ws.send(msg);
        }
    }
}

function broadcastToAll(room_id, data) {
    broadcastToRoom(room_id, data, null);
}

function removeClientFromRoom(ws) {
    for (const [room_id, clients] of rooms.entries()) {
        const idx = clients.findIndex(c => c.ws === ws);
        if (idx !== -1) {
            const [removed] = clients.splice(idx, 1);
            broadcastToRoom(room_id, { type: 'player_left', player_name: removed.player_name });
            console.log(`👋 ${removed.player_name} saiu da sala ${room_id}. Restam: ${clients.length}`);
            if (clients.length === 0) {
                rooms.delete(room_id);
                console.log(`🗑️ Sala ${room_id} vazia — removida da memória.`);
            }
            return { room_id, player_name: removed.player_name };
        }
    }
    return null;
}

// ─────────────────────────────────────────
// HTTP + WS COMPARTILHAM A MESMA PORTA
// ─────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('🔌 Nova conexão WebSocket');

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        const type = msg.type || '';

        // ── ENTRAR NA SALA ──────────────────────────────
        if (type === 'join_room') {
            const { room_id, player_name } = msg;
            if (!room_id || !player_name) return;

            // Garante que o slot de sala existe
            if (!rooms.has(room_id)) rooms.set(room_id, []);
            const roomClients = rooms.get(room_id);

            // Evita duplicata (reconexão rápida)
            const alreadyIn = roomClients.findIndex(c => c.player_name === player_name);
            if (alreadyIn !== -1) roomClients.splice(alreadyIn, 1);

            roomClients.push({ ws, player_name, is_ready: false });
            console.log(`👤 ${player_name} entrou na sala ${room_id}. Total: ${roomClients.length}`);

            // Envia estado atual para o recém-chegado
            ws.send(JSON.stringify({
                type: 'room_state',
                players: roomClients.map(c => ({
                    name:     c.player_name,
                    is_ready: c.is_ready
                }))
            }));

            // Avisa todos os OUTROS na sala
            broadcastToRoom(room_id, { type: 'player_joined', player_name }, ws);
            return;
        }

        // ── TOGGLE PRONTO ──────────────────────────────
        if (type === 'toggle_ready') {
            const { player_name } = msg;
            for (const [room_id, clients] of rooms.entries()) {
                const client = clients.find(c => c.ws === ws);
                if (!client) continue;

                client.is_ready = !client.is_ready;
                broadcastToAll(room_id, {
                    type:        'player_ready',
                    player_name: client.player_name,
                    is_ready:    client.is_ready
                });

                // Verifica se todos estão prontos (mínimo 2 jogadores)
                const allReady = clients.length >= 2 && clients.every(c => c.is_ready);
                if (allReady) broadcastToAll(room_id, { type: 'all_ready' });
                break;
            }
            return;
        }

        // ── INICIAR JOGO ──────────────────────────────
        if (type === 'start_game') {
            for (const [room_id, clients] of rooms.entries()) {
                const found = clients.find(c => c.ws === ws);
                if (!found) continue;
                broadcastToAll(room_id, { type: 'game_starting' });
                console.log(`🎮 Jogo iniciado na sala ${room_id}`);
                break;
            }
            return;
        }

        // ── SAIR DA SALA (voluntary) ──────────────────
        if (type === 'leave_room') {
            removeClientFromRoom(ws);
            return;
        }
    });

    ws.on('close', () => {
        const removed = removeClientFromRoom(ws);
        if (removed) console.log(`🔌 WS fechado: ${removed.player_name} removido de ${removed.room_id}`);
    });

    ws.on('error', (err) => {
        console.error('❌ Erro WS:', err.message);
    });
});

// ─────────────────────────────────────────
// REST API
// ─────────────────────────────────────────

app.post('/check_in', async (req, res) => {
    const { username, room_id } = req.body;
    console.log(`📩 Request: /check_in de ${username} na sala ${room_id}`);
    const ip      = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = ip.split(',')[0].trim();
    try {
        await GlobalPlayer.findOneAndUpdate(
            { ip: cleanIp },
            { username, current_room: room_id || null, last_seen: Date.now() },
            { upsert: true }
        );
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/get_my_name', async (req, res) => {
    const ip      = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = ip.split(',')[0].trim();
    try {
        const player = await GlobalPlayer.findOne({ ip: cleanIp });
        res.json(player ? { username: player.username } : { username: "" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/global_players', async (req, res) => {
    try {
        const sevenMinsAgo = new Date(Date.now() - 7 * 60000);
        const players = await GlobalPlayer.find(
            { last_seen: { $gt: sevenMinsAgo } },
            'username current_room'
        ).sort({ last_seen: -1 });
        res.json({ players });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/create_room', async (req, res) => {
    const { room_id, host_name } = req.body;
    const ip      = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = ip.split(',')[0].trim();
    try {
        await ServerRoom.findOneAndUpdate(
            { room_id },
            { host_ip: cleanIp, local_ip: cleanIp, host_name, last_ping: Date.now() },
            { upsert: true }
        );
        await GlobalPlayer.updateOne(
            { username: host_name },
            { current_room: room_id }
        );
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/list_rooms', async (req, res) => {
    try {
        const fiveMinsAgo = new Date(Date.now() - 5 * 60000);
        const rooms = await ServerRoom.find(
            { last_ping: { $gt: fiveMinsAgo } },
            'room_id host_name'
        );
        res.json({ rooms });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/start_match', async (req, res) => {
    const { room_id } = req.body;
    try {
        await ServerRoom.deleteOne({ room_id });
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/update_position', async (req, res) => {
    const { room_id, player_name, px, py, pz, rx, ry, rz } = req.body;
    if (!room_id || !player_name) return res.json({status: "ok"});
    console.log(`📍 Pos: ${player_name} em [${px.toFixed(1)}, ${py.toFixed(1)}, ${pz.toFixed(1)}]`);
    try {
        await PlayerPosition.findOneAndUpdate(
            { room_id, player_name },
            { pos_x: px, pos_y: py, pos_z: pz, rot_x: rx, rot_y: ry, rot_z: rz, last_update: Date.now() },
            { upsert: true }
        );
        res.json({status: "ok"});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/get_positions', async (req, res) => {
    const { room_id } = req.query;
    if (!room_id) return res.json({ players: [] });
    try {
        const fifteenSecondsAgo = new Date(Date.now() - 15000);
        const players = await PlayerPosition.find({
            room_id,
            last_update: { $gt: fifteenSecondsAgo }
        });
        res.json({ players });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/delete_room', async (req, res) => {
    const { room_id } = req.body;
    try {
        await ServerRoom.deleteOne({ room_id });
        console.log(`🗑️ Sala ${room_id} removida pelo Host via HTTP.`);
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/ping_room', async (req, res) => {
    const { room_id } = req.body;
    try {
        await ServerRoom.updateOne({ room_id }, { last_ping: Date.now() });
        res.json({ status: "ok" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/clear_db', async (req, res) => {
    try {
        await ServerRoom.deleteMany({});
        await GlobalPlayer.deleteMany({});
        await PlayerPosition.deleteMany({});
        rooms.clear();
        console.log("🧹 Banco e salas em memória limpos!");
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/my_ip', (req, res) => {
    const ip      = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = ip.split(',')[0].trim();
    res.json({ ip: cleanIp });
});

app.get('/', (_req, res) => {
    res.send("<h1>🩸 Servidor de Lobby de Terror</h1><p>Status: Ativo e Amaldiçoado</p>");
});

// ─────────────────────────────────────────
// INICIA (HTTP + WS juntos)
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor HTTP+WS rodando na porta ${PORT}`);
});
