# --- DOCKERFILE PARA SERVIDOR DEDICADO GODOT ---

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Atualiza e instala bibliotecas necessarias para o Godot rodar em Linux (Headless)
RUN apt-get update && apt-get install -y \
    wget \
    unzip \
    libfontconfig1 \
    libxrender1 \
    libdbus-1-3 \
    libpulse0 \
    libasound2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Baixa o Godot 4.3 (ou superior) para rodar via linha de comando
RUN wget https://github.com/godotengine/godot/releases/download/4.3-stable/Godot_v4.3-stable_linux.x86_64.zip \
    && unzip Godot_v4.3-stable_linux.x86_64.zip \
    && mv Godot_v4.3-stable_linux.x86_64 /usr/local/bin/godot \
    && rm Godot_v4.3-stable_linux.x86_64.zip

# Pasta do jogo
WORKDIR /app

# COPIA O SEU JOGO (Voce precisa colocar o seu 'server.pck' aqui nesta pasta!)
COPY server.pck /app/server.pck

# Abre a porta que o Railway escolher
EXPOSE 3000

# Comando para iniciar o Godot como servidor dedicado
# Passamos -- --server para o nosso script saber que ele deve agir como host
CMD godot --headless --main-pack server.pck -- --server --port $PORT
