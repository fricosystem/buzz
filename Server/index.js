const WebSocket = require('ws');

// A porta fornecida automaticamente pelo Railway ou 3000 em testes locais
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// Sistema rápido de salas armazenado inteiramente na RAM (Memória) do Railway
// Formato: { "id_sala": Set(Conexões) }
const rooms = new Map();

wss.on('connection', (ws) => {
    ws.roomId = null;
    ws.playerId = null;

    // Quando o servidor Railway recebe qualquer pacote do Unity
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // 1. O Jogador avisou que entrou em uma Sala
            if (data.type === 'join') {
                ws.roomId = data.roomId;
                ws.playerId = data.playerId;
                
                if (!rooms.has(ws.roomId)) {
                    rooms.set(ws.roomId, new Set());
                }
                rooms.get(ws.roomId).add(ws);
                console.log(`✅ Jogador ${ws.playerId} conectou na sala ${ws.roomId}`);
            } 
            // 2. O Jogador enviou qualquer pacote (posicao, soco, pulo, airdrop, etc)
            else if (ws.roomId) {
                const room = rooms.get(ws.roomId);
                if (room) {
                    // Repassa (faz o Broadcast) rapidamente para todos os outros
                    // jogadores na MESMA sala invisivelmente.
                    for (const client of room) {
                        // Não devolve o pacote para o próprio remetente
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(message); // Repassa o buffer recebido (universal)
                        }
                    }
                }
            }
        } catch (e) {
            console.error("❌ Erro ao parsear mensagem JSON:", e.message);
        }
    });

    // Quando o jogador fecha o jogo ou a internet cai
    ws.on('close', () => {
        if (ws.roomId && rooms.has(ws.roomId)) {
            const room = rooms.get(ws.roomId);
            room.delete(ws);
            
            // Destrói a sala para economizar RAM caso todos saiam
            if (room.size === 0) {
                rooms.delete(ws.roomId); 
            }
            console.log(`⛔ Jogador desconectou da sala ${ws.roomId}`);
        }
    });
});

console.log(`🚀 Sincronizador Realtime Ligado na Porta: ${PORT}`);
