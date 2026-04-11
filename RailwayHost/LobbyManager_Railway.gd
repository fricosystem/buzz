extends Control

# --- CONFIGURAÇÕES ---
# O Railway define a porta em uma variável de ambiente, o Godot lerá isso no Servidor.
# No Cliente, usaremos o link direto do seu app no Railway (WebSockets).
var server_url = "https://godot-multiplayer-railway-production.up.railway.app"
var websocket_url = "wss://godot-multiplayer-railway-production.up.railway.app" # URL do WebSocket

const DEFAULT_PORT = 3000

@onready var status_label = $CanvasLayer/MainMenu/CentralPanel/VBox/Status
@onready var name_input = $CanvasLayer/MainMenu/CentralPanel/VBox/NameInput
@onready var player_list_vc = $CanvasLayer/LobbyScreen/Panel/VBox/PlayerList

var peer = WebSocketMultiplayerPeer.new()
var players = {} 

func _ready():
	# VERIFICA SE ESTÁ RODANDO NO RAILWAY (SERVIDOR DEDICADO)
	var args = OS.get_cmdline_args()
	if "--server" in args:
		_start_dedicated_server()
		return # O servidor não precisa de UI

	_setup_client_ui()

# --- LÓGICA DO SERVIDOR (RAILWAY) ---

func _start_dedicated_server():
	print("--- INICIANDO SERVIDOR DEDICADO NO RAILWAY ---")
	
	var port = DEFAULT_PORT
	# Pega a porta que o Railway nos deu
	for i in range(OS.get_cmdline_args().size()):
		if OS.get_cmdline_args()[i] == "--port" and i + 1 < OS.get_cmdline_args().size():
			port = OS.get_cmdline_args()[i+1].to_int()

	var err = peer.create_server(port)
	if err != OK:
		print("❌ Erro ao abrir servidor WebSocket: ", err)
		return

	multiplayer.multiplayer_peer = peer
	multiplayer.peer_connected.connect(_on_player_connected)
	multiplayer.peer_disconnected.connect(_on_player_disconnected)
	
	print("🚀 Servidor pronto na porta: ", port)

# --- LÓGICA DO CLIENTE (SEU PC/ANDROID) ---

func _setup_client_ui():
	# (Aqui entra a sua lógica de UI normal que já temos no LobbyManager.gd)
	# Mas em vez de ENet, usaremos:
	pass

func _on_join_pressed():
	# Para conectar no Railway via WebSocket:
	status_label.text = "Conectando ao Coração do Além (Railway)..."
	
	var err = peer.create_client(websocket_url)
	if err != OK:
		status_label.text = "Erro ao invocar portal: " + str(err)
		return
		
	multiplayer.multiplayer_peer = peer
	multiplayer.connected_to_server.connect(_on_connected_ok)
	multiplayer.connection_failed.connect(_on_connected_fail)

func _on_connected_ok():
	status_label.text = "Conectado ao Servidor do Além!"
	rpc_id(1, "request_entry", name_input.text)

# (O restante das funções RPC continua igual ao seu LobbyManager.gd original)
