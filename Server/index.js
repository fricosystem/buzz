const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
app.use(express.json());
app.use(cors());

// Criamos um servidor HTTP para compartilhar com o WebSocket
const server = http.createServer(app);

// Relay WebSocket - os jogadores se conectam aqui
const wss = new WebSocketServer({ server });

// Mapa de salas: { "room_id": [ ws1, ws2, ... ] }
const rooms = {};

wss.on('connection', (ws) => {
    ws.room = null;
    ws.player_name = "Desconhecido";

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            // Jogador entra numa sala
            if (msg.type === 'join_room') {
                ws.room = msg.room_id;
                ws.player_name = msg.player_name;

                if (!rooms[ws.room]) rooms[ws.room] = [];
                rooms[ws.room].push(ws);

                console.log(`✅ ${ws.player_name} entrou na sala ${ws.room}`);

                // Avisa todos na sala sobre o novo jogador
                broadcast(ws.room, {
                    type: 'player_joined',
                    player_name: ws.player_name,
                    player_count: rooms[ws.room].length
                });
            }

            // Jogador marca pronto
            if (msg.type === 'toggle_ready') {
                ws.is_ready = !ws.is_ready;
                broadcast(ws.room, {
                    type: 'player_ready',
                    player_name: ws.player_name,
                    is_ready: ws.is_ready
                });

                // Verifica se todos estão prontos
                const all_ready = rooms[ws.room]?.every(c => c.is_ready);
                if (all_ready && rooms[ws.room]?.length > 1) {
                    broadcast(ws.room, { type: 'all_ready' });
                }
            }

            // Host inicia a partida
            if (msg.type === 'start_game') {
                broadcast(ws.room, { type: 'game_starting' });
            }

        } catch (e) {
            console.error("Mensagem inválida:", e.message);
        }
    });

    ws.on('close', () => {
        if (ws.room && rooms[ws.room]) {
            rooms[ws.room] = rooms[ws.room].filter(c => c !== ws);
            if (rooms[ws.room].length === 0) delete rooms[ws.room];
            else broadcast(ws.room, { type: 'player_left', player_name: ws.player_name });
            console.log(`💀 ${ws.player_name} saiu da sala ${ws.room}`);
        }
    });
});

function broadcast(room_id, message) {
    if (!rooms[room_id]) return;
    const data = JSON.stringify(message);
    rooms[room_id].forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    });
}

// --- ENDPOINTS HTTP (Matchmaking) ---

const pool = mysql.createPool({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port: process.env.MYSQLPORT || 3306,
    waitForConnections: true,
    connectionLimit: 10
});
const promisePool = pool.promise();

app.get('/', (req, res) => res.send("<h1>Lobby de Terror - Ativo e Amaldiçoado!</h1>"));

// Inicializa as tabelas com schema correto
async function initDatabase() {
    try {
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS server_rooms (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id VARCHAR(50) UNIQUE NOT NULL,
                host_name VARCHAR(100) NOT NULL,
                uid VARCHAR(200) DEFAULT '',
                last_heartbeat DATETIME DEFAULT NOW()
            )
        `);
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS global_players (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(100) NOT NULL,
                uid VARCHAR(200) UNIQUE DEFAULT '',
                last_seen DATETIME DEFAULT NOW()
            )
        `);
        // Adiciona coluna uid nas tabelas existentes se não tiver
        await promisePool.query(`ALTER TABLE server_rooms ADD COLUMN IF NOT EXISTS uid VARCHAR(200) DEFAULT ''`).catch(() => {});
        await promisePool.query(`ALTER TABLE server_rooms ADD COLUMN IF NOT EXISTS last_heartbeat DATETIME DEFAULT NOW()`).catch(() => {});
        await promisePool.query(`ALTER TABLE global_players ADD COLUMN IF NOT EXISTS uid VARCHAR(200) DEFAULT ''`).catch(() => {});
        console.log("✅ Banco de dados inicializado com sucesso!");
    } catch (err) {
        console.error("❌ Erro ao inicializar banco:", err.message);
    }
}

app.post('/create_room', async (req, res) => {
    const { room_id, host_name, uid } = req.body;
    try {
        await promisePool.query(
            `INSERT INTO server_rooms (room_id, host_ip, local_ip, host_name, last_ping) 
             VALUES (?, ?, ?, ?, NOW()) 
             ON DUPLICATE KEY UPDATE last_ping = NOW(), host_name = ?`,
            [room_id, uid || 'RAILWAY', 'RAILWAY', host_name, host_name]
        );
        console.log(`✅ Sala criada: ${room_id} por ${host_name}`);
        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erro create_room:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/list_rooms', async (req, res) => {
    try {
        const [rows] = await promisePool.query(
            "SELECT * FROM server_rooms WHERE last_ping > NOW() - INTERVAL 5 MINUTE ORDER BY last_ping DESC"
        );
        res.json({ rooms: rows });
    } catch (err) {
        console.error("❌ Erro list_rooms:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/delete_room', async (req, res) => {
    const { room_id } = req.body;
    try {
        await promisePool.query("DELETE FROM server_rooms WHERE room_id = ?", [room_id]);
        console.log(`🗑️ Sala deletada: ${room_id}`);
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/check_in', async (req, res) => {
    const { username, uid } = req.body;
    try {
        await promisePool.query(
            `INSERT INTO global_players (ip, username, current_room, last_seen) 
             VALUES (?, ?, ?, NOW()) 
             ON DUPLICATE KEY UPDATE last_seen = NOW(), username = ?`,
            [uid || 'FIREBASE', username, '', username]
        );
        console.log(`👤 Check-in: ${username}`);
        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erro check_in:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/global_players', async (req, res) => {
    try {
        const [rows] = await promisePool.query(
            "SELECT username FROM global_players WHERE last_seen > NOW() - INTERVAL 2 MINUTE"
        );
        res.json({ players: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Faxineiro automático
setInterval(async () => {
    await promisePool.query("DELETE FROM server_rooms WHERE last_ping < NOW() - INTERVAL 5 MINUTE");
    await promisePool.query("DELETE FROM global_players WHERE last_seen < NOW() - INTERVAL 7 MINUTE");
    console.log("🧹 Faxineiro executado");
}, 60000);

// ⚠️ IMPORTANTE: usar server.listen em vez de app.listen
const PORT = process.env.PORT || 3000;
initDatabase().then(() => {
    server.listen(PORT, () => console.log(`🚀 Servidor Relay Online na porta ${PORT}`));
});
