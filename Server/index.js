const express = require('express');
const mysql   = require('mysql2');
const cors    = require('cors');
const http    = require('http');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.json());
app.use(cors());

// ─────────────────────────────────────────
// CONFIGURAÇÃO DB
// ─────────────────────────────────────────
const dbConfig = {
    host:     process.env.DB_HOST     || process.env.MYSQLHOST     || 'localhost',
    user:     process.env.DB_USER     || process.env.MYSQLUSER     || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
    database: process.env.DB_NAME     || process.env.MYSQLDATABASE || 'railway',
    port:     process.env.DB_PORT     || process.env.MYSQLPORT     || 3306
};

const pool        = mysql.createPool(dbConfig);
const promisePool = pool.promise();

// ─────────────────────────────────────────
// INICIALIZA BANCO
// ─────────────────────────────────────────
async function initDB() {
    try {
        console.log("⏳ Preparando Banco de Dados...");

        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS server_rooms (
                room_id    VARCHAR(10)  PRIMARY KEY,
                host_ip    VARCHAR(50)  NOT NULL,
                local_ip   VARCHAR(50),
                host_name  VARCHAR(50),
                last_ping  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS global_players (
                ip           VARCHAR(50)  PRIMARY KEY,
                username     VARCHAR(50)  NOT NULL,
                current_room VARCHAR(10)  DEFAULT NULL,
                last_seen    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        console.log("✅ Banco de Dados Pronto!");
        startCleanupLoop();
    } catch (err) {
        console.error("❌ Erro ao iniciar DB:", err.message);
        setTimeout(initDB, 5000);
    }
}

// ─────────────────────────────────────────
// FAXINEIRO AUTOMÁTICO
// ─────────────────────────────────────────
function startCleanupLoop() {
    setInterval(async () => {
        try {
            await promisePool.query(
                "UPDATE global_players SET current_room = NULL WHERE last_seen < DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
            );
            await promisePool.query(
                "DELETE FROM server_rooms WHERE last_ping < DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
            );
            const [result] = await promisePool.query(
                "DELETE FROM global_players WHERE last_seen < DATE_SUB(NOW(), INTERVAL 7 MINUTE)"
            );
            if (result.affectedRows > 0)
                console.log(`🧹 Faxina: ${result.affectedRows} almas removidas.`);
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
    const ip      = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = ip.split(',')[0].trim();
    try {
        await promisePool.query(
            "REPLACE INTO global_players (ip, username, current_room, last_seen) VALUES (?, ?, ?, NOW())",
            [cleanIp, username, room_id || null]
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
        const [rows] = await promisePool.query("SELECT username FROM global_players WHERE ip = ?", [cleanIp]);
        res.json(rows.length > 0 ? { username: rows[0].username } : { username: "" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/global_players', async (req, res) => {
    try {
        const [rows] = await promisePool.query(
            "SELECT username, current_room FROM global_players WHERE last_seen > DATE_SUB(NOW(), INTERVAL 7 MINUTE) ORDER BY last_seen DESC"
        );
        res.json({ players: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/create_room', async (req, res) => {
    const { room_id, host_name } = req.body;
    const ip      = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = ip.split(',')[0].trim();
    try {
        await promisePool.query(
            "REPLACE INTO server_rooms (room_id, host_ip, local_ip, host_name, last_ping) VALUES (?, ?, ?, ?, NOW())",
            [room_id, cleanIp, cleanIp, host_name]
        );
        await promisePool.query(
            "UPDATE global_players SET current_room = ? WHERE username = ?",
            [room_id, host_name]
        );
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/list_rooms', async (req, res) => {
    try {
        const [rows] = await promisePool.query(
            "SELECT room_id, host_name FROM server_rooms WHERE last_ping > DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
        );
        res.json({ rooms: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/delete_room', async (req, res) => {
    const { room_id } = req.body;
    try {
        await promisePool.query("DELETE FROM server_rooms WHERE room_id = ?", [room_id]);
        console.log(`🗑️ Sala ${room_id} removida pelo Host via HTTP.`);
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/ping_room', async (req, res) => {
    const { room_id } = req.body;
    try {
        await promisePool.query("UPDATE server_rooms SET last_ping = NOW() WHERE room_id = ?", [room_id]);
        res.json({ status: "ok" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/clear_db', async (req, res) => {
    try {
        await promisePool.query("DELETE FROM server_rooms");
        await promisePool.query("DELETE FROM global_players");
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
