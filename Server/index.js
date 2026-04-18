const WebSocket = require('ws');

// A porta fornecida automaticamente pelo Railway ou 3000 em testes locais
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// --- CONFIGURAÇÃO SUPABASE ---
// Configure estas variáveis no painel do Railway (Variables) para segurança
const SUPABASE_URL = process.env.SUPABASE_URL || "https://fajpyndasuhmlrwnobnv.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || ""; 

// Sistema rápido de salas armazenado inteiramente na RAM (Memória) do Railway
const rooms = new Map();

wss.on('connection', (ws) => {
    ws.roomId = null;
    ws.playerId = null;
    ws.playerName = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            // 1. O Jogador avisou que entrou em uma Sala
            if (data.type === 'join') {
                ws.roomId = data.roomId;
                ws.playerId = data.playerId;
                ws.playerName = data.playerName; // Agora recebemos o nome do Unity
                
                if (!rooms.has(ws.roomId)) {
                    rooms.set(ws.roomId, new Set());
                }
                rooms.get(ws.roomId).add(ws);
                console.log(`✅ Jogador ${ws.playerName || ws.playerId} conectou na sala ${ws.roomId}`);
            } 
            // 2. Broadcast Universal (Repassador)
            else if (ws.roomId) {
                const room = rooms.get(ws.roomId);
                if (room) {
                    for (const client of room) {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(message); 
                        }
                    }
                }
            }
        } catch (e) { }
    });

    ws.on('close', async () => {
        if (ws.roomId && rooms.has(ws.roomId)) {
            const room = rooms.get(ws.roomId);
            room.delete(ws);
            console.log(`⛔ Jogador ${ws.playerName || ws.playerId} desconectou da sala ${ws.roomId}`);

            // --- Lógica de Atualização do Supabase na Saída ---
            if (SUPABASE_KEY && ws.playerName) {
                try {
                    await atualizarSairSalaSupabase(ws.roomId, ws.playerName);
                } catch (err) {
                    console.error("❌ Erro ao atualizar Supabase na saída:", err.message);
                }
            }

            if (room.size === 0) {
                rooms.delete(ws.roomId); 
            }
        }
    });
});

async function atualizarSairSalaSupabase(roomId, nomeSair) {
    // 1. Busca o estado atual da sala
    const res = await fetch(`${SUPABASE_URL}/rest/v1/salas_ativas?id=eq.${roomId}&select=*`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
    });
    
    const salas = await res.json();
    if (!salas || salas.length === 0) return;

    const sala = salas[0];
    let moderador = sala.moderador;
    let jogadores = [];

    // 2. Coleta todos os jogadores atuais nos slots (1 a 10) sem buracos
    for (let i = 1; i <= 10; i++) {
        let n = sala[`jogador${i}`];
        if (n && n !== "" && n !== "null") jogadores.push(n);
    }

    // 3. Remove o jogador que está saindo da lista de slots
    jogadores = jogadores.filter(n => n !== nomeSair);

    // --- NOVA LÓGICA: Excluir sala se ficar vazia (0 jogadores) ---
    if (jogadores.length === 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/salas_ativas?id=eq.${roomId}`, {
            method: 'DELETE',
            headers: { 
                "apikey": SUPABASE_KEY, 
                "Authorization": `Bearer ${SUPABASE_KEY}`,
                "Prefer": "return=minimal"
            }
        });
        console.log(`🗑️ Sala ${roomId} excluída por estar vazia (0/10).`);
        return; 
    }

    // 4. Se o moderador for quem saiu, promove o novo jogador 1 (se existir)
    if (moderador === nomeSair) {
        moderador = jogadores.length > 0 ? jogadores[0] : null;
    }

    // 5. Monta o objeto de atualização limpando tudo e re-preenchendo (Shift Left)
    const updateData = {
        moderador: moderador,
        quantidade_jogadores: jogadores.length
    };

    // Atualiza slots de 1 a 10
    for (let i = 1; i <= 10; i++) {
        updateData[`jogador${i}`] = (i <= jogadores.length) ? jogadores[i - 1] : null;
    }

    // 6. Envia o PATCH para o Supabase
    await fetch(`${SUPABASE_URL}/rest/v1/salas_ativas?id=eq.${roomId}`, {
        method: 'PATCH',
        headers: { 
            "apikey": SUPABASE_KEY, 
            "Authorization": `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
        },
        body: JSON.stringify(updateData)
    });
    
    console.log(`♻️ Sala ${roomId} sincronizada. Novo Mod: ${moderador}. Qtd: ${jogadores.length}`);
}

console.log(`🚀 Sincronizador Realtime Ligado na Porta: ${PORT}`);
