const { WebSocket } = require('ws');
const axios = require('axios');
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');

const userConfig = require('./config.js');

const CONFIG = {
    // Datos del usuario (desde config.js)
    serverUrl: userConfig.serverUrl,
    username: userConfig.username,
    password: userConfig.password,
    mpvPath: userConfig.mpvPath,
    deviceName: userConfig.deviceName,
    deviceId: userConfig.deviceId || `mpv-${crypto.randomBytes(8).toString('hex')}`,
    
    // Constantes técnicas (no necesitan cambio)
    clientVersion: '2.0.0',
    ipcSocketPath: userConfig.ipcSocketPath || '\\\\.\\pipe\\mpv-ipc',
    mpvLoadDelayMs: 100
};

// NUEVA LÍNEA: Archivo de token único por dispositivo
const TOKEN_FILE = path.join(__dirname, 'data', `jellyfin_token_${CONFIG.deviceId}.json`);
const POSITIONS_FILE = path.join(__dirname, 'data', `playback_positions_${CONFIG.deviceId}.json`);

/// Variables de estado
let mpvProcess = null;
let currentItemId = null;
let progressInterval = null;
let ipcClient = null;
let currentEpisodeInfo = null;
let ipcCommandId = 1;
let playSessionId = null;
let currentPositionSeconds = 0;
let isReportingStop = false;
let accessToken = null;
let userId = null;
let ws = null;
let reconnectInterval = null;
let isReconnecting = false;
let reconnectAttempts = 0; // NUEVO: Contador de intentos de reconexión
let keepAliveInterval = null; // NUEVO: Para el KeepAlive periódico

let pendingStreamUrl = null;
let pendingStartSeconds = 0;


// --- NUEVO: SISTEMA DE AUTENTICACIÓN ---
function loadToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const data = fs.readFileSync(TOKEN_FILE, 'utf8');
            const tokenData = JSON.parse(data);
            accessToken = tokenData.AccessToken;
            userId = tokenData.User?.Id;
            console.log('✅ Token guardado cargado correctamente');
            return true;
        }
    } catch (error) {
        console.error('⚠️ Error cargando token guardado:', error.message);
    }
    return false;
}

function saveToken(authResponse) {
    try {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(authResponse, null, 2));
        accessToken = authResponse.AccessToken;
        userId = authResponse.User?.Id;
        console.log('💾 Token guardado correctamente');
    } catch (error) {
        console.error('⚠️ Error guardando token:', error.message);
    }
}

async function authenticateUser() {
    try {
        console.log('🔐 Autenticando usuario...');
        
        const authHeader = `MediaBrowser Client="${CONFIG.deviceName}", Device="${CONFIG.deviceName}", DeviceId="${CONFIG.deviceId}", Version="${CONFIG.clientVersion}"`;
        
        const response = await axios.post(
            `${CONFIG.serverUrl}/Users/AuthenticateByName`,
            {
                Username: CONFIG.username,
                Pw: CONFIG.password
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Emby-Authorization': authHeader
                }
            }
        );

        saveToken(response.data);
        console.log(`✅ Autenticación exitosa para usuario: ${CONFIG.username}`);
        console.log(`🆔 User ID: ${userId}`);
        return true;
    } catch (error) {
        console.error('❌ Error en autenticación:', error.message);
        if (error.response) {
            console.error('📄 Detalles:', error.response.status, error.response.data);
        }
        return false;
    }
}

// --- SISTEMA DE GUARDADO LOCAL DE POSICIONES ---
function loadPlaybackPositions() {
    try {
        if (fs.existsSync(POSITIONS_FILE)) {
            const data = fs.readFileSync(POSITIONS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('⚠️ Error cargando posiciones guardadas:', error.message);
    }
    return {};
}

function savePlaybackPosition(itemId, positionTicks) {
    try {
        const positions = loadPlaybackPositions();
        positions[itemId] = {
            positionTicks: positionTicks,
            lastUpdated: new Date().toISOString()
        };
        fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
        console.log(`💾 Posición guardada localmente: ${(positionTicks / 10000000).toFixed(2)}s para ${itemId}`);
    } catch (error) {
        console.error('⚠️ Error guardando posición:', error.message);
    }
}

function getSavedPosition(itemId) {
    const positions = loadPlaybackPositions();
    return positions[itemId]?.positionTicks || 0;
}

// --- MODIFICADO: Función para obtener headers con el access token ---
function getAuthHeaders() {
    return {
        'X-Emby-Token': accessToken,
        'X-Emby-Authorization': `MediaBrowser Client="${CONFIG.deviceName}", Device="${CONFIG.deviceName}", DeviceId="${CONFIG.deviceId}", Version="${CONFIG.clientVersion}"`
    };
}

// --- MODIFICADO: CONEXIÓN WEBSOCKET ---
async function connectWebSocket() {
    // Si ya estamos reconectando, no hacer nada
    if (isReconnecting) {
        return;
    }
    
    isReconnecting = true;
    
    // Limpiar KeepAlive anterior
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }

    // Cerrar WebSocket anterior si existe
    if (ws) {
        try {
            ws.removeAllListeners();
            ws.close();
        } catch (e) {
            // Ignorar errores al cerrar
        }
        ws = null;
    }
    
    const wsUrl = `${CONFIG.serverUrl.replace('http', 'ws')}/socket?api_key=${accessToken}&deviceId=${CONFIG.deviceId}`;
    
    console.log('🔌 Conectando a Jellyfin...');
    
    try {
        ws = new WebSocket(wsUrl);
        
        ws.on('open', () => {
            console.log('✅ Conexión WebSocket establecida.');
            isReconnecting = false;
            reconnectAttempts = 0; // REINICIAR: Reiniciar contador de intentos al conectar
            
            const msg = {
                MessageType: "SessionsStart",
                Data: "0,1500"
            };
            ws.send(JSON.stringify(msg));
            console.log('📤 Mensaje SessionsStart enviado');
            
            // NUEVO: Intervalo de Keep-Alive/Capacidades más limpio
            keepAliveInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.send(JSON.stringify({ MessageType: 'KeepAlive' }));
                        reportCapabilities();
                    } catch (e) {
                        console.error('⚠️ Error enviando keep-alive:', e.message);
                    }
                }
            }, 30000); // Cada 30 segundos
            
            // Limpiar intervalo de reconexión si existe
            if (reconnectInterval) {
                clearInterval(reconnectInterval);
                reconnectInterval = null;
            }
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.MessageType !== 'KeepAlive' && msg.MessageType !== 'ForceKeepAlive') {
                    console.log('📩 Mensaje recibido:', msg.MessageType);
                }
                handleMessage(msg);
            } catch (e) {
                console.error('⚠️ Error parseando mensaje:', e.message);
            }
        });

        ws.on('error', (error) => {
            console.error('❌ Error en WebSocket:', error.message);
            isReconnecting = false;
        });

        ws.on('close', () => {
            console.log('❌ Desconectado del servidor.');
            isReconnecting = false;
            
            if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
            }
            
            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                keepAliveInterval = null;
            }
            
            // Intentar reconectar automáticamente
            scheduleReconnect();
        });
        
    } catch (error) {
        console.error('❌ Error creando WebSocket:', error.message);
        isReconnecting = false;
        scheduleReconnect();
    }
}


/**
 * NUEVO: Programar reconexión automática con Backoff Exponencial Limitado (Capped Exponential Backoff).
 * Esto aumenta el tiempo de espera entre intentos, reduciendo el uso de CPU después de un fallo.
 */
function scheduleReconnect() {
    if (reconnectInterval) {
        return; // Ya hay una reconexión programada
    }
    
    // Calcular tiempo de espera: 5s, 10s, 20s, 30s, 30s... (max 30s)
    reconnectAttempts++;
    let delaySeconds = Math.min(30, 5 * Math.pow(2, reconnectAttempts - 1));
    if (reconnectAttempts === 1) delaySeconds = 5; // Primer intento siempre a los 5s
    
    console.log(`🔄 Programando reconexión automática en ${delaySeconds} segundos (Intento ${reconnectAttempts})...`);
    
    reconnectInterval = setInterval(async () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            // Ya está conectado, limpiar intervalo
            clearInterval(reconnectInterval);
            reconnectInterval = null;
            return;
        }

        // NUEVO: PING HTTP LIGERO para verificar si la red está arriba
        try {
            console.log('📡 Verificando conexión de red antes de reconectar...');
            // Endpoint System/Info es ligero y requiere autenticación
            const headers = getAuthHeaders();
            await axios.get(`${CONFIG.serverUrl}/System/Info`, { 
                headers,
                timeout: 3000 // Timeout corto para saber rápido si hay red
            });
            
            console.log('✅ Conexión de red activa. Intentando reconexión WebSocket...');
            
            // Token y red válidos, reconectar WebSocket
            await connectWebSocket();
            
            // Si connectWebSocket tiene éxito (ws.on('open') se dispara), el intervalo se limpia allí.
            
        } catch (error) {
            // Error de conexión o timeout (la red podría estar caída o el servidor inaccesible)
            if (error.response && error.response.status === 401) {
                // Token inválido, reautenticar
                console.log('🔐 Token expirado, reautenticando...');
                const authenticated = await authenticateUser();
                if (authenticated) {
                    // Si la reautenticación es exitosa, intentar conectar WS
                    await connectWebSocket();
                } else {
                    // Si la reautenticación falla, esperar el siguiente ciclo (o detenerse)
                    console.error('❌ Reautenticación fallida. Esperando el siguiente intento.');
                }
            } else {
                console.log(`⚠️ Servidor no disponible o red caída. Reintentando en ${delaySeconds}s...`);
                
                // Si falla, limpiar y volver a programar para calcular el próximo retraso
                clearInterval(reconnectInterval);
                reconnectInterval = null;
                scheduleReconnect();
            }
        }
    }, delaySeconds * 1000);
}


// --- MODIFICADO: REGISTRAR EL DISPOSITIVO ---
function reportCapabilities() {
    const payload = {
        PlayableMediaTypes: ["Audio", "Video"],
        SupportedCommands: [
            "Play",
            "Playstate",
            "PlayNext",
            "PlayMediaSource"
        ],
        SupportsMediaControl: true,
        SupportsPersistentIdentifier: true,
        SupportsSync: false,
        SupportsContentUploading: false,
        SupportsRemoteControl: true
    };

    // console.log('📡 Registrando capacidades del dispositivo...'); // MENOS VERBOSO
    
    axios.post(`${CONFIG.serverUrl}/Sessions/Capabilities/Full`, payload, { 
        headers: getAuthHeaders()
    })
        .catch(err => {
            // Solo loguear errores críticos, no es necesario ser verboso
            if (err.response && err.response.status !== 401) {
                // Si es 401 (token expirado) ya se manejará en el flujo de reconexión/autenticación
                console.error('❌ Error registrando capacidades:', err.message);
            }
        });
}

// --- MANEJAR COMANDOS DE JELLYFIN (Sin Cambios Relevantes) ---
function handleMessage(msg) {
    if (msg.MessageType === "Play") {
        console.log('▶️ Comando PLAY recibido desde la web!');
        const data = msg.Data || {};
        const itemIds = data.ItemIds || [];
        const startPosition = data.StartPositionTicks || 0;
        
        console.log('📋 Datos del comando Play:', { itemIds, startPositionTicks: startPosition });
        
        if (itemIds.length > 0) {
            const savedPosition = getSavedPosition(itemIds[0]);
            const finalStartPosition = startPosition === 0 && savedPosition > 0 
                ? savedPosition 
                : startPosition;
            
            if (savedPosition > 0 && startPosition === 0) {
                console.log(`🎯 Usando posición guardada localmente: ${(savedPosition / 10000000).toFixed(2)}s`);
            }
            
            playMedia(itemIds[0], finalStartPosition);
        } else {
            console.error('⚠️ No se recibieron ItemIds en el comando Play');
        }
    } 
    else if (msg.MessageType === "Playstate") {
        const data = msg.Data || {};
        const command = data.Command;
        console.log(`⏯️ Comando de estado recibido: ${command}`);
        
        if (command === 'Stop') {
            killMpv();
        } else if (command === 'Pause') {
            sendMpvCommand('set_property', ['pause', true]);
        } else if (command === 'Unpause') {
            sendMpvCommand('set_property', ['pause', false]);
        } else if (command === 'Seek') {
            if (data.SeekPositionTicks !== undefined) {
                const seekSeconds = data.SeekPositionTicks / 10000000;
                sendMpvCommand('seek', [seekSeconds, 'absolute']);
                console.log(`⏩ Seek solicitado a ${seekSeconds.toFixed(2)}s`);
            }
        }
    }
    // El KeepAlive ahora se gestiona en un setInterval dedicado, no es necesario responder aquí.
    else if (msg.MessageType === 'KeepAlive' || msg.MessageType === 'ForceKeepAlive') {
        // Ignorar o responder con un KeepAlive si es necesario (Jellyfin generalmente espera la respuesta solo si recibe ForceKeepAlive)
        // Ya que tenemos un KeepAlive periódico, podemos omitir responder al KeepAlive normal aquí.
    }
}

// --- OBTENER INFORMACIÓN DEL EPISODIO (Sin Cambios Relevantes) ---
async function getEpisodeInfo(itemId) {
    try {
        const headers = getAuthHeaders();
        
        const response = await axios.get(`${CONFIG.serverUrl}/Users/${userId}/Items/${itemId}`, { headers });
        const item = response.data;

        if (item.Type === 'Episode') {
            console.log(`📺 Episodio detectado: ${item.SeriesName} - T${item.ParentIndexNumber}E${item.IndexNumber}`);

            const seasonResponse = await axios.get(`${CONFIG.serverUrl}/Shows/${item.SeriesId}/Episodes`, {
                headers,
                params: {
                    seasonId: item.SeasonId,
                    userId: userId,
                    fields: 'Path,IndexNumber,ParentIndexNumber,SeriesName,Name,UserData'
                }
            });

            const episodes = seasonResponse.data.Items.sort((a, b) => a.IndexNumber - b.IndexNumber);
            const currentIndex = episodes.findIndex(ep => ep.Id === itemId);

            return {
                isSeries: true,
                currentIndex,
                episodes,
                nextEpisode: currentIndex < episodes.length - 1 ? episodes[currentIndex + 1] : null,
                previousEpisode: currentIndex > 0 ? episodes[currentIndex - 1] : null,
                seriesName: item.SeriesName,
                seasonNumber: item.ParentIndexNumber,
                episodeNumber: item.IndexNumber,
                itemRuntime: item.RunTimeTicks ? item.RunTimeTicks / 10000000 : 0,
                userData: item.UserData || {}
            };
        }

        return {
            isSeries: false,
            title: item.Name || 'Película/Música',
            itemRuntime: item.RunTimeTicks ? item.RunTimeTicks / 10000000 : 0,
            userData: item.UserData || {}
        };
    } catch (error) {
        console.error('⚠️ Error obteniendo info del episodio:', error.message);
        return { isSeries: false };
    }
}

// --- FUNCIÓN MODIFICADA: playMedia ---
// Se añade más logging para detectar problemas y se ajustan los argumentos de MPV
// --- FUNCIÓN MODIFICADA: playMedia ---
// Se añade más logging para detectar problemas y se ajustan los argumentos de MPV
async function playMedia(itemId, startTicks) {
    killMpv();
    
    currentItemId = itemId;
    currentPositionSeconds = startTicks / 10000000;
    currentEpisodeInfo = await getEpisodeInfo(itemId);
    playSessionId = crypto.randomUUID();

    pendingStreamUrl = `${CONFIG.serverUrl}/Videos/${itemId}/stream?static=true&api_key=${accessToken}`;
    pendingStartSeconds = startTicks / 10000000;

    console.log('🍿 Lanzando MPV (Modo Idle)...');
    console.log(`    Item ID: ${itemId}`);
    console.log(`    Stream URL: ${pendingStreamUrl}`);
    console.log(`    MPV Path: ${CONFIG.mpvPath}`);

    // MODIFICADO: Argumentos simplificados y más robustos (SIN --focus-on que no existe en todas las versiones)
    const args = [
        `--start=${pendingStartSeconds}`,
        '--idle=yes',
        '--force-window=immediate',
        `--title=Jellyfin - ${currentEpisodeInfo.isSeries ? currentEpisodeInfo.seriesName + ' ' + currentEpisodeInfo.seasonNumber + 'x' + currentEpisodeInfo.episodeNumber : itemId}`,
        '--keep-open=no',
        '--ontop',
        // ELIMINADO: '--focus-on=open' - No existe en todas las versiones de MPV
        `--input-ipc-server=${CONFIG.ipcSocketPath}`,
        '--save-position-on-quit=no',
        '--hwdec=auto-safe',
        '--vo=gpu',
        '--cache=yes',
        '--demuxer-max-bytes=150M',
        '--demuxer-max-back-bytes=75M'
    ];

    console.log('🔧 Argumentos de MPV:', args.join(' '));

    try {
        mpvProcess = spawn(CONFIG.mpvPath, args, {
            // NUEVO: Opciones de spawn para mejor manejo de errores
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: false
        });
        
        console.log(`✅ MPV iniciado con PID: ${mpvProcess.pid}`);

        reportPlaybackStart(itemId, startTicks);
        startProgressReporting(itemId);

        setTimeout(() => {
            connectToMpvIpc();
        }, 500);

        // MODIFICADO: Más logging para detectar errores
        mpvProcess.stdout.on('data', (data) => { 
            console.log(`MPV stdout: ${data.toString().trim()}`); 
        });
        
        mpvProcess.stderr.on('data', (data) => { 
            console.error(`MPV stderr: ${data.toString().trim()}`); 
        });

        mpvProcess.on('error', (err) => {
            console.error('❌ Error ejecutando MPV:', err.message);
            console.error('   Verifica que mpvPath esté correctamente configurado:', CONFIG.mpvPath);
        });

        mpvProcess.on('close', (code, signal) => {
            console.log(`🛑 MPV cerrado (código ${code}, señal: ${signal})`);
            
            // NUEVO: Detectar cierre anormal
            if (code === 1) {
                console.error('⚠️ MPV se cerró con error. Posibles causas:');
                console.error('   - Problema con los argumentos de línea de comandos');
                console.error('   - No puede crear la ventana');
                console.error('   - Problema con los drivers de video');
                console.error('   - Permisos insuficientes');
            }
            
            if (currentItemId && currentPositionSeconds > 0) {
                const positionTicks = Math.round(currentPositionSeconds * 10000000);
                savePlaybackPosition(currentItemId, positionTicks);
            }
            if (currentItemId && !isReportingStop) {
                const runtime = currentEpisodeInfo?.itemRuntime || 0;
                const completionThreshold = 0.9;
                if (runtime > 0 && currentPositionSeconds >= runtime * completionThreshold) {
                    markItemAsWatched(currentItemId);
                }
                reportPlaybackStop(currentItemId, Math.round(currentPositionSeconds * 10000000));
            }
            mpvProcess = null;
            if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
            if (ipcClient) { ipcClient.destroy(); ipcClient = null; }
            currentItemId = null;
            currentEpisodeInfo = null;
            isReportingStop = false;
        });
    } catch (err) {
        console.error('❌ Error crítico al intentar ejecutar MPV:', err);
        console.error('   Stack:', err.stack);
    }
}

// --- FUNCIÓN MODIFICADA: connectToMpvIpc ---
// Se añaden reintentos y mejor manejo de errores
function connectToMpvIpc() {
    if (ipcClient) {
        ipcClient.destroy();
    }

    // NUEVO: Variable para reintentos
    let connectionAttempts = 0;
    const maxAttempts = 10;
    const retryDelay = 500;

    function attemptConnection() {
        connectionAttempts++;
        
        if (!mpvProcess || mpvProcess.exitCode !== null) {
            console.error('❌ MPV no está ejecutándose, cancelando conexión IPC');
            return;
        }

        console.log(`🔗 Intentando conectar al IPC de MPV (intento ${connectionAttempts}/${maxAttempts})...`);
        
        ipcClient = net.connect(CONFIG.ipcSocketPath);
        let buffer = '';

        ipcClient.on('connect', () => {
            console.log('✅ Conectado al IPC de MPV');

            setTimeout(() => {
                if (pendingStreamUrl) {
                    console.log('📡 Enviando comando LOADFILE...');
                    sendMpvCommand('loadfile', [pendingStreamUrl, 'replace']); 
                    console.log('    ✅ Comando de carga enviado.');
                }
            }, CONFIG.mpvLoadDelayMs);

            sendMpvCommand('observe_property', [1, 'eof-reached']);
            sendMpvCommand('observe_property', [2, 'time-pos']);
            sendMpvCommand('observe_property', [3, 'pause']);
            sendMpvCommand('observe_property', [4, 'duration']);
            
            sendMpvCommand('keybind', ['MEDIA_NEXT', 'script-message jellyfin-next']);
            sendMpvCommand('keybind', ['MEDIA_PREV', 'script-message jellyfin-prev']);
            sendMpvCommand('keybind', ['>', 'script-message jellyfin-next']);
            sendMpvCommand('keybind', ['<', 'script-message jellyfin-prev']);
            
            console.log('⌨️ Teclas enlazadas');
        });

        ipcClient.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            lines.forEach(line => {
                if (line.trim()) {
                    try {
                        const response = JSON.parse(line);
                        handleMpvEvent(response);
                        
                        if (response.error && response.error !== 'success') {
                            console.error('⚠️ MPV Error:', response.error, JSON.stringify(response.command));
                        }
                    } catch (e) {
                        // Ignorar
                    }
                }
            });
        });

        ipcClient.on('error', (err) => {
            console.error(`⚠️ Error en IPC (intento ${connectionAttempts}):`, err.message);
            
            // MODIFICADO: Reintentar la conexión si MPV sigue vivo
            if (connectionAttempts < maxAttempts && mpvProcess && mpvProcess.exitCode === null) {
                console.log(`🔄 Reintentando conexión IPC en ${retryDelay}ms...`);
                setTimeout(attemptConnection, retryDelay);
            } else if (connectionAttempts >= maxAttempts) {
                console.error('❌ Número máximo de intentos de conexión IPC alcanzado');
                killMpv();
            }
        });

        ipcClient.on('close', () => {
            console.log('🔌 Desconectado del IPC de MPV');
            ipcClient = null;
        });
    }

    // NUEVO: Iniciar primer intento
    attemptConnection();
}


// --- FUNCIÓN: Marcar elemento como visto (Sin Cambios Relevantes) ---
async function markItemAsWatched(itemId) {
    try {
        const headers = getAuthHeaders();
        await axios.post(`${CONFIG.serverUrl}/Users/${userId}/PlayedItems/${itemId}`, {}, { headers });
        console.log('✅ Elemento marcado como visto en Jellyfin');

        const positions = loadPlaybackPositions();
        if (positions[itemId]) {
            delete positions[itemId];
            fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
            console.log('🗑️ Posición local limpiada (contenido visto)');
        }
    } catch (error) {
        console.error('⚠️ Error marcando elemento como visto:', error.message);
    }
}

function killMpv() {
    if (mpvProcess) {
        console.log('⏹️ Forzando cierre de MPV anterior...');
        isReportingStop = true;
        mpvProcess.kill();
        mpvProcess = null;
    }
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
    if (ipcClient) {
        ipcClient.destroy();
        ipcClient = null;
    }
}

// --- FUNCIÓN MODIFICADA: connectToMpvIpc ---
// Se añaden reintentos y mejor manejo de errores
function connectToMpvIpc() {
    if (ipcClient) {
        ipcClient.destroy();
    }

    // NUEVO: Variable para reintentos
    let connectionAttempts = 0;
    const maxAttempts = 10;
    const retryDelay = 500;

    function attemptConnection() {
        connectionAttempts++;
        
        if (!mpvProcess || mpvProcess.exitCode !== null) {
            console.error('❌ MPV no está ejecutándose, cancelando conexión IPC');
            return;
        }

        console.log(`🔗 Intentando conectar al IPC de MPV (intento ${connectionAttempts}/${maxAttempts})...`);
        
        ipcClient = net.connect(CONFIG.ipcSocketPath);
        let buffer = '';

        ipcClient.on('connect', () => {
            console.log('✅ Conectado al IPC de MPV');

            setTimeout(() => {
                if (pendingStreamUrl) {
                    console.log('📡 Enviando comando LOADFILE...');
                    sendMpvCommand('loadfile', [pendingStreamUrl, 'replace']); 
                    console.log('    ✅ Comando de carga enviado.');
                }
            }, CONFIG.mpvLoadDelayMs);

            sendMpvCommand('observe_property', [1, 'eof-reached']);
            sendMpvCommand('observe_property', [2, 'time-pos']);
            sendMpvCommand('observe_property', [3, 'pause']);
            sendMpvCommand('observe_property', [4, 'duration']);
            
            sendMpvCommand('keybind', ['MEDIA_NEXT', 'script-message jellyfin-next']);
            sendMpvCommand('keybind', ['MEDIA_PREV', 'script-message jellyfin-prev']);
            sendMpvCommand('keybind', ['>', 'script-message jellyfin-next']);
            sendMpvCommand('keybind', ['<', 'script-message jellyfin-prev']);
            
            console.log('⌨️ Teclas enlazadas');
        });

        ipcClient.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            lines.forEach(line => {
                if (line.trim()) {
                    try {
                        const response = JSON.parse(line);
                        handleMpvEvent(response);
                        
                        if (response.error && response.error !== 'success') {
                            console.error('⚠️ MPV Error:', response.error, JSON.stringify(response.command));
                        }
                    } catch (e) {
                        // Ignorar
                    }
                }
            });
        });

        ipcClient.on('error', (err) => {
            console.error(`⚠️ Error en IPC (intento ${connectionAttempts}):`, err.message);
            
            // MODIFICADO: Reintentar la conexión si MPV sigue vivo
            if (connectionAttempts < maxAttempts && mpvProcess && mpvProcess.exitCode === null) {
                console.log(`🔄 Reintentando conexión IPC en ${retryDelay}ms...`);
                setTimeout(attemptConnection, retryDelay);
            } else if (connectionAttempts >= maxAttempts) {
                console.error('❌ Número máximo de intentos de conexión IPC alcanzado');
                killMpv();
            }
        });

        ipcClient.on('close', () => {
            console.log('🔌 Desconectado del IPC de MPV');
            ipcClient = null;
        });
    }

    // NUEVO: Iniciar primer intento
    attemptConnection();
}

// --- ENVIAR COMANDO A MPV VÍA IPC (Sin Cambios Relevantes) ---
function sendMpvCommand(command, args = []) {
    if (!ipcClient || ipcClient.destroyed) {
        return;
    }

    const cmd = {
        command: [command, ...args],
        request_id: ipcCommandId++
    };

    try {
        const cmdStr = JSON.stringify(cmd) + '\n';
        ipcClient.write(cmdStr);
    } catch (e) {
        console.error('⚠️ Error enviando comando a MPV:', e.message);
    }
}

// --- MANEJAR EVENTOS DE MPV (MODIFICADO para file-loaded) ---
function handleMpvEvent(event) {
    
    // NUEVO: Ejecutar Seek después de que el archivo cargue
    if (event.event === 'file-loaded') {
        console.log('✅ Archivo cargado por MPV. Preparando Seek si es necesario...');
        
        // Si tenemos una posición inicial guardada, la ejecutamos ahora.
        if (pendingStartSeconds > 0) {
            // El 'seek' necesita el tiempo y la acción ('absolute' para ir a un segundo específico)
            sendMpvCommand('seek', [pendingStartSeconds, 'absolute']);
            console.log(`⏩ Seek automático a posición guardada: ${pendingStartSeconds.toFixed(2)}s`);
            
            // Limpiamos la posición y la URL pendiente después del seek exitoso
            pendingStartSeconds = 0; 
            pendingStreamUrl = null; 
        }
        return;
    }

    if (event.event === 'property-change' && event.name === 'time-pos' && typeof event.data === 'number') {
        currentPositionSeconds = event.data;
        return;
    }

    if (event.event === 'property-change' && event.name === 'eof-reached' && event.data === true) {
        // ... (Tu lógica de fin de archivo)
        console.log('🎬 Evento eof-reached detectado (Fin del episodio)');
        
        if (currentItemId) {
            markItemAsWatched(currentItemId);
        }
        
        playNextEpisode();
        return;
    }

    if (event.event === 'client-message' && event.args && event.args[0]) {
        if (event.args[0] === 'jellyfin-next') {
            console.log('⏭️ Siguiente episodio solicitado (Keypress)');
            playNextEpisode();
        } else if (event.args[0] === 'jellyfin-prev') {
            console.log('⏮️ Episodio anterior solicitado (Keypress)');
            playPreviousEpisode();
        }
    }
}

// --- REPRODUCIR SIGUIENTE/ANTERIOR EPISODIO (Sin Cambios Relevantes) ---
function playNextEpisode() {
    if (!currentEpisodeInfo || !currentEpisodeInfo.isSeries) {
        console.log('ℹ️ No es una serie, ignorando comando Siguiente.');
        return;
    }

    if (!currentEpisodeInfo.nextEpisode) {
        console.log('ℹ️ No hay más episodios en esta temporada, terminando.');
        killMpv();
        return;
    }

    const nextEp = currentEpisodeInfo.nextEpisode;
    console.log(`▶️ Iniciando siguiente episodio: T${nextEp.ParentIndexNumber}E${nextEp.IndexNumber} - ${nextEp.Name}`);
    playMedia(nextEp.Id, 0);
}

function playPreviousEpisode() {
    if (!currentEpisodeInfo || !currentEpisodeInfo.isSeries) {
        console.log('ℹ️ No es una serie, ignorando comando Anterior.');
        return;
    }

    if (currentPositionSeconds > 30) {
        console.log('↩️ Reiniciando episodio actual (tiempo > 30s)');
        playMedia(currentItemId, 0);
        return;
    }

    if (!currentEpisodeInfo.previousEpisode) {
        console.log('ℹ️ Este es el primer episodio de la temporada.');
        return;
    }

    const prevEp = currentEpisodeInfo.previousEpisode;
    console.log(`◀️ Iniciando episodio anterior: T${prevEp.ParentIndexNumber}E${prevEp.IndexNumber} - ${prevEp.Name}`);
    playMedia(prevEp.Id, 0);
}

// --- REPORTAR INICIO, PROGRESO, STOP (Sin Cambios Relevantes) ---
function reportPlaybackStart(itemId, positionTicks) {
    const headers = getAuthHeaders();
    
    const data = {
        ItemId: itemId,
        PositionTicks: positionTicks,
        IsPaused: false,
        IsMuted: false,
        VolumeLevel: 100,
        PlayMethod: 'DirectPlay',
        PlaySessionId: playSessionId,
        CanSeek: true
    };

    console.log('📡 Reportando inicio de reproducción...');
    
    axios.post(`${CONFIG.serverUrl}/Sessions/Playing`, data, { headers })
        .catch(e => {
            console.error('⚠️ Error reportando inicio:', e.message);
        });
}

function startProgressReporting(itemId) {
    if (progressInterval) {
        clearInterval(progressInterval);
    }

    progressInterval = setInterval(() => {
        if (!mpvProcess || !currentItemId) {
            clearInterval(progressInterval);
            progressInterval = null;
            return;
        }

        const currentTicks = Math.round(currentPositionSeconds * 10000000);
        reportPlaybackProgress(currentItemId, currentTicks);

        if (currentPositionSeconds > 10) {
            savePlaybackPosition(currentItemId, currentTicks);
        }
    }, 10000);
}

function reportPlaybackProgress(itemId, positionTicks) {
    const headers = getAuthHeaders();
    
    const data = {
        ItemId: itemId,
        PositionTicks: positionTicks,
        IsPaused: false,
        IsMuted: false,
        VolumeLevel: 100,
        PlayMethod: 'DirectPlay',
        PlaySessionId: playSessionId
    };

    axios.post(`${CONFIG.serverUrl}/Sessions/Playing/Progress`, data, { headers })
        .catch(e => {
            // Ignorar errores silenciosamente
        });
}

function reportPlaybackStop(itemId, positionTicks) {
    if (!itemId || isReportingStop) {
        return;
    }
    
    isReportingStop = true;
    
    const headers = getAuthHeaders();
    
    const data = {
        ItemId: itemId,
        PositionTicks: positionTicks,
        PlaySessionId: playSessionId
    };

    console.log(`📡 Reportando fin de reproducción (posición: ${(positionTicks / 10000000).toFixed(2)}s)...`);
    
    axios.post(`${CONFIG.serverUrl}/Sessions/Playing/Stopped`, data, { headers })
        .then(() => {
            console.log('✅ Fin de reproducción reportado correctamente');
        })
        .catch(e => {
            console.error('⚠️ Error reportando stop:', e.message);
        });
}

/// Manejo de cierre gracioso
process.on('SIGINT', () => {
    console.log('\n👋 Cerrando aplicación...');
    
    if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
    }
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
    
    killMpv();
    if (ws) {
        ws.close();
    }
    process.exit(0);
});

// NUEVO: Manejar otras señales de cierre
process.on('SIGTERM', () => {
    console.log('\n👋 Cerrando aplicación (SIGTERM)...');
    
    if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
    }
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
    
    killMpv();
    if (ws) {
        ws.close();
    }
    process.exit(0);
});

// --- INICIALIZACIÓN PRINCIPAL ---
async function main() {
    console.log('\n🚀 Iniciando Jellyfin MPV Shim...\n');
    
	const dataDir = path.join(__dirname, 'data');
   if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
   }
	
    const hasToken = loadToken();
    
    if (!hasToken || !accessToken) {
        const authenticated = await authenticateUser();
        if (!authenticated) {
            console.error('❌ No se pudo autenticar. Verifica tus credenciales en CONFIG.');
            process.exit(1);
        }
    }
    
    // Conectar WebSocket
    await connectWebSocket();
    
    console.log('\n✅ Script iniciado correctamente');
    console.log('💡 Abre Jellyfin en tu navegador y usa "Reproducir en" para seleccionar este dispositivo.');
    console.log('💾 Sistema de posiciones locales activado');
    console.log('🔄 Reconexión automática habilitada con Backoff Exponencial');
    console.log('⏭️ Usa las teclas multimedia o las teclas > y < para cambiar de episodio.\n');
}

// Iniciar la aplicación
main().catch(error => {
    console.error('❌ Error fatal:', error);
    process.exit(1);
});