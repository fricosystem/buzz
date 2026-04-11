const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIGURAÇÃO DB ---
const dbConfig = {
    host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
    user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
    database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'railway',
    port: process.env.DB_PORT || process.env.MYSQLPORT || 3306
};

const pool = mysql.createPool(dbConfig);
const promisePool = pool.promise();

// Inicializa tabelas
async function initDB() {
    try {
        console.log("⏳ Preparando Banco de Dados Temporário...");
        
        // Tabela de Salas (Expira em 5 min sem ping)
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS server_rooms (
                room_id VARCHAR(10) PRIMARY KEY,
                host_ip VARCHAR(50) NOT NULL,
                local_ip VARCHAR(50),
                host_name VARCHAR(50),
                last_ping TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        
        // Tabela de Jogadores Online (Temporária)
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS global_players (
                ip VARCHAR(50) PRIMARY KEY,
                username VARCHAR(50) NOT NULL,
                current_room VARCHAR(10) DEFAULT NULL,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        console.log("✅ Banco de Dados Pronto!");
        startCleanupLoop(); // Inicia o faxineiro do banco
    } catch (err) {
        console.error("❌ Erro ao iniciar DB:", err.message);
        setTimeout(initDB, 5000);
    }
}

// --- FAXINEIRO AUTOMÁTICO (Limpeza de Inatividade) ---
function startCleanupLoop() {
    setInterval(async () => {
        try {
            // 1. Remove das salas quem está inativo há mais de 5 minutos (volta pro lobby)
            await promisePool.query("UPDATE global_players SET current_room = NULL WHERE last_seen < DATE_SUB(NOW(), INTERVAL 5 MINUTE)");
            
            // 2. Deleta salas que o Host não manda ping há mais de 5 minutos
            await promisePool.query("DELETE FROM server_rooms WHERE last_ping < DATE_SUB(NOW(), INTERVAL 5 MINUTE)");

            // 3. REMOVE TOTALMENTE (Logout) quem sumiu há mais de 7 minutos
            const [result] = await promisePool.query("DELETE FROM global_players WHERE last_seen < DATE_SUB(NOW(), INTERVAL 7 MINUTE)");
            
            if (result.affectedRows > 0) {
                console.log(`🧹 Faxina concluída: ${result.affectedRows} almas inativas foram removidas.`);
            }
        } catch (err) {
            console.error("❌ Erro na limpeza automática:", err.message);
        }
    }, 60000); // Roda a cada 1 minuto
}

initDB();

// --- API DE CONEXÃO ---

// 1. Check-in de Jogador (Persistência e Presença Global)
app.post('/check_in', async (req, res) => {
    const { username, room_id } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
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

// 2. Buscar nome salvo pelo IP
app.get('/get_my_name', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = ip.split(',')[0].trim();

    try {
        const [rows] = await promisePool.query("SELECT username FROM global_players WHERE ip = ?", [cleanIp]);
        if (rows.length > 0) {
            res.json({ username: rows[0].username, ip: cleanIp });
        } else {
            res.json({ username: "", ip: cleanIp });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Listar todos os jogadores online (vistos nos últimos 7 minutos)
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
    const { room_id, host_ip, local_ip, host_name } = req.body;
    try {
        await promisePool.query(
            "REPLACE INTO server_rooms (room_id, host_ip, local_ip, host_name, last_ping) VALUES (?, ?, ?, ?, NOW())", 
            [room_id, host_ip, local_ip, host_name]
        );
        // Vincula o host à sala
        await promisePool.query("UPDATE global_players SET current_room = ? WHERE username = ?", [room_id, host_name]);
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/list_rooms', async (req, res) => {
    try {
        const [rows] = await promisePool.query("SELECT * FROM server_rooms WHERE last_ping > DATE_SUB(NOW(), INTERVAL 5 MINUTE)");
        res.json({ rooms: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/get_room/:id', async (req, res) => {
    try {
        const [rows] = await promisePool.query("SELECT host_ip, local_ip FROM server_rooms WHERE room_id = ?", [req.params.id]);
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ error: "Sala não encontrada" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
} );

app.post('/delete_room', async (req, res) => {
    const { room_id } = req.body;
    try {
        await promisePool.query("DELETE FROM server_rooms WHERE room_id = ?", [room_id]);
        console.log(`🗑️ Sala ${room_id} removida pelo Host.`);
        res.json({ status: "success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Limpar o Banco de Dados (Salas e Jogadores Antigos)
app.post('/clear_db', async (req, res) => {
    try {
        await promisePool.query("DELETE FROM server_rooms");
        await promisePool.query("DELETE FROM global_players");
        console.log("🧹 Banco de dados limpo pelo usuário!");
        res.json({ status: "success", message: "O além foi purificado!" });
    } catch (err) {
        console.error("❌ Erro ao limpar DB:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/my_ip', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = ip.split(',')[0].trim();
    res.json({ ip: cleanIp });
});

app.get('/', (req, res) => {
    res.send("<h1>Servidor de Lobby de Terror Online</h1><p>Status: Ativo e Amaldiçoado</p>");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
