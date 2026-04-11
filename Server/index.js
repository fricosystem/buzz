const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Configuração do Banco de Dados Railway
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

// --- ENDPOINTS ---

app.get('/', (req, res) => res.send("<h1>Lobby de Terror Online - Ativo</h1>"));

// Criar Sala
app.post('/create_room', async (req, res) => {
    const { room_id, host_name, uid } = req.body;
    try {
        await promisePool.query(
            "INSERT INTO server_rooms (room_id, host_name, uid, last_heartbeat) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE last_heartbeat = NOW()",
            [room_id, host_name, uid]
        );
        res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Listar Salas
app.get('/list_rooms', async (req, res) => {
    try {
        const [rows] = await promisePool.query("SELECT * FROM server_rooms WHERE last_heartbeat > NOW() - INTERVAL 5 MINUTE");
        res.json({ rooms: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deletar Sala
app.post('/delete_room', async (req, res) => {
    const { room_id } = req.body;
    try {
        await promisePool.query("DELETE FROM server_rooms WHERE room_id = ?", [room_id]);
        res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Check-in Global (Aparecer na lista de Almas Online)
app.post('/check_in', async (req, res) => {
    const { username, uid } = req.body;
    try {
        await promisePool.query(
            "INSERT INTO global_players (username, uid, last_seen) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE last_seen = NOW()",
            [username, uid]
        );
        res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/global_players', async (req, res) => {
    try {
        const [rows] = await promisePool.query("SELECT username FROM global_players WHERE last_seen > NOW() - INTERVAL 2 MINUTE");
        res.json({ players: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Limpeza Automática (Faxineiro)
setInterval(async () => {
    await promisePool.query("DELETE FROM server_rooms WHERE last_heartbeat < NOW() - INTERVAL 5 MINUTE");
    await promisePool.query("DELETE FROM global_players WHERE last_seen < NOW() - INTERVAL 7 MINUTE");
}, 60000);

app.listen(process.env.PORT || 3000, () => console.log("Lobby Matchmaking Online!"));
