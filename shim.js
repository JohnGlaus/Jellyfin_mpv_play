const { WebSocket } = require('ws');
const axios = require('axios');
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');

const userConfig = require('./config.js');

const CONFIG = {
    serverUrl: userConfig.serverUrl,
    username: userConfig.username,
    password: userConfig.password,
    mpvPath: userConfig.mpvPath,
    deviceName: userConfig.deviceName,
    deviceId: userConfig.deviceId || `mpv-${crypto.randomBytes(8).toString('hex')}`,
    
    clientVersion: '2.0.0',
    ipcSocketPath: userConfig.ipcSocketPath || '\\\\.\\pipe\\mpv-ipc',
    mpvLoadDelayMs: 100
};

const TOKEN_FILE = path.join(__dirname, 'data', `jellyfin_token_${CONFIG.deviceId}.json`);
const POSITIONS_FILE = path.join(__dirname, 'data', `playback_positions_${CONFIG.deviceId}.json`);

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
let reconnectAttempts = 0;
let keepAliveInterval = null;

let pendingStreamUrl = null;
let pendingStartSeconds = 0;

function loadToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const data = fs.readFileSync(TOKEN_FILE, 'utf8');
            const tokenData = JSON.parse(data);
            accessToken = tokenData.AccessToken;
            userId = tokenData.User?.Id;
            console.log('✅ Saved token loaded successfully');
            return true;
        }
    } catch (error) {
        console.error('⚠️ Error loading saved token:', error.message);
    }
    return false;
}

function saveToken(authResponse) {
    try {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(authResponse, null, 2));
        accessToken = authResponse.AccessToken;
        userId = authResponse.User?.Id;
        console.log('💾 Token saved successfully');
    } catch (error) {
        console.error('⚠️ Error saving token:', error.message);
    }
}

async function authenticateUser() {
    try {
        console.log('🔐 Authenticating user...');
        
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
        console.log(`✅ Authentication successful for user: ${CONFIG.username}`);
        console.log(`🆔 User ID: ${userId}`);
        return true;
    } catch (error) {
        console.error('❌ Authentication error:', error.message);
        if (error.response) {
            console.error('📄 Details:', error.response.status, error.response.data);
        }
        return false;
    }
}

function loadPlaybackPositions() {
    try {
        if (fs.existsSync(POSITIONS_FILE)) {
            const data = fs.readFileSync(POSITIONS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('⚠️ Error loading saved positions:', error.message);
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
        console.log(`💾 Position saved locally: ${(positionTicks / 10000000).toFixed(2)}s for ${itemId}`);
    } catch (error) {
        console.error('⚠️ Error saving position:', error.message);
    }
}

function getSavedPosition(itemId) {
    const positions = loadPlaybackPositions();
    return positions[itemId]?.positionTicks || 0;
}

function getAuthHeaders() {
    return {
        'X-Emby-Token': accessToken,
        'X-Emby-Authorization': `MediaBrowser Client="${CONFIG.deviceName}", Device="${CONFIG.deviceName}", DeviceId="${CONFIG.deviceId}", Version="${CONFIG.clientVersion}"`
    };
}

async function connectWebSocket() {
    if (isReconnecting) {
        return;
    }
    
    isReconnecting = true;
    
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }

    if (ws) {
        try {
            ws.removeAllListeners();
            ws.close();
        } catch (e) {
        }
        ws = null;
    }
    
    const wsUrl = `${CONFIG.serverUrl.replace('http', 'ws')}/socket?api_key=${accessToken}&deviceId=${CONFIG.deviceId}`;
    
    console.log('🔌 Connecting to Jellyfin...');
    
    try {
        ws = new WebSocket(wsUrl);
        
        ws.on('open', () => {
            console.log('✅ WebSocket connection established.');
            isReconnecting = false;
            reconnectAttempts = 0;
            
            const msg = {
                MessageType: "SessionsStart",
                Data: "0,1500"
            };
            ws.send(JSON.stringify(msg));
            console.log('📤 SessionsStart message sent');
            
            keepAliveInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.send(JSON.stringify({ MessageType: 'KeepAlive' }));
                        reportCapabilities();
                    } catch (e) {
                        console.error('⚠️ Error sending keep-alive:', e.message);
                    }
                }
            }, 30000);
            
            if (reconnectInterval) {
                clearInterval(reconnectInterval);
                reconnectInterval = null;
            }
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.MessageType !== 'KeepAlive' && msg.MessageType !== 'ForceKeepAlive') {
                    console.log('📩 Message received:', msg.MessageType);
                }
                handleMessage(msg);
            } catch (e) {
                console.error('⚠️ Error parsing message:', e.message);
            }
        });

        ws.on('error', (error) => {
            console.error('❌ WebSocket error:', error.message);
            isReconnecting = false;
        });

        ws.on('close', () => {
            console.log('❌ Disconnected from server.');
            isReconnecting = false;
            
            if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
            }
            
            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                keepAliveInterval = null;
            }
            
            scheduleReconnect();
        });
        
    } catch (error) {
        console.error('❌ Error creating WebSocket:', error.message);
        isReconnecting = false;
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectInterval) {
        return;
    }
    
    reconnectAttempts++;
    let delaySeconds = Math.min(30, 5 * Math.pow(2, reconnectAttempts - 1));
    if (reconnectAttempts === 1) delaySeconds = 5;
    
    console.log(`🔄 Scheduling automatic reconnection in ${delaySeconds} seconds (Attempt ${reconnectAttempts})...`);
    
    reconnectInterval = setInterval(async () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
            return;
        }

        try {
            console.log('📡 Checking network connection before reconnecting...');
            const headers = getAuthHeaders();
            await axios.get(`${CONFIG.serverUrl}/System/Info`, { 
                headers,
                timeout: 3000
            });
            
            console.log('✅ Network connection active. Attempting WebSocket reconnection...');
            await connectWebSocket();
            
        } catch (error) {
            if (error.response && error.response.status === 401) {
                console.log('🔐 Token expired, reauthenticating...');
                const authenticated = await authenticateUser();
                if (authenticated) {
                    await connectWebSocket();
                } else {
                    console.error('❌ Reauthentication failed. Waiting for next attempt.');
                }
            } else {
                console.log(`⚠️ Server unavailable or network down. Retrying in ${delaySeconds}s...`);
                clearInterval(reconnectInterval);
                reconnectInterval = null;
                scheduleReconnect();
            }
        }
    }, delaySeconds * 1000);
}

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

    axios.post(`${CONFIG.serverUrl}/Sessions/Capabilities/Full`, payload, { 
        headers: getAuthHeaders()
    })
        .catch(err => {
            if (err.response && err.response.status !== 401) {
                console.error('❌ Error registering capabilities:', err.message);
            }
        });
}

function handleMessage(msg) {
    if (msg.MessageType === "Play") {
        console.log('▶️ PLAY command received from web!');
        const data = msg.Data || {};
        const itemIds = data.ItemIds || [];
        const startPosition = data.StartPositionTicks || 0;
        
        console.log('📋 Play command data:', { itemIds, startPositionTicks: startPosition });
        
        if (itemIds.length > 0) {
            const savedPosition = getSavedPosition(itemIds[0]);
            const finalStartPosition = startPosition === 0 && savedPosition > 0 
                ? savedPosition 
                : startPosition;
            
            if (savedPosition > 0 && startPosition === 0) {
                console.log(`🎯 Using saved local position: ${(savedPosition / 10000000).toFixed(2)}s`);
            }
            
            playMedia(itemIds[0], finalStartPosition);
        } else {
            console.error('⚠️ No ItemIds received in Play command');
        }
    } 
    else if (msg.MessageType === "Playstate") {
        const data = msg.Data || {};
        const command = data.Command;
        console.log(`⏯️ State command received: ${command}`);
        
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
                console.log(`⏩ Seek requested to ${seekSeconds.toFixed(2)}s`);
            }
        }
    }
}

async function getEpisodeInfo(itemId) {
    try {
        const headers = getAuthHeaders();
        
        const response = await axios.get(`${CONFIG.serverUrl}/Users/${userId}/Items/${itemId}`, { headers });
        const item = response.data;

        if (item.Type === 'Episode') {
            console.log(`📺 Episode detected: ${item.SeriesName} - T${item.ParentIndexNumber}E${item.IndexNumber}`);

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
            title: item.Name || 'Movie/Music',
            itemRuntime: item.RunTimeTicks ? item.RunTimeTicks / 10000000 : 0,
            userData: item.UserData || {}
        };
    } catch (error) {
        console.error('⚠️ Error getting episode info:', error.message);
        return { isSeries: false };
    }
}

async function playMedia(itemId, startTicks) {
    killMpv();
    
    currentItemId = itemId;
    currentPositionSeconds = startTicks / 10000000;
    currentEpisodeInfo = await getEpisodeInfo(itemId);
    playSessionId = crypto.randomUUID();

    pendingStreamUrl = `${CONFIG.serverUrl}/Videos/${itemId}/stream?static=true&api_key=${accessToken}`;
    pendingStartSeconds = startTicks / 10000000;

    console.log('🍿 Launching MPV (Idle Mode)...');
    console.log(`    Item ID: ${itemId}`);
    console.log(`    Stream URL: ${pendingStreamUrl}`);
    console.log(`    MPV Path: ${CONFIG.mpvPath}`);

    const args = [
        `--start=${pendingStartSeconds}`,
        '--idle=yes',
        '--force-window=immediate',
        `--title=Jellyfin - ${currentEpisodeInfo.isSeries ? currentEpisodeInfo.seriesName + ' ' + currentEpisodeInfo.seasonNumber + 'x' + currentEpisodeInfo.episodeNumber : itemId}`,
        '--keep-open=no',
        '--ontop',
        `--input-ipc-server=${CONFIG.ipcSocketPath}`,
        '--save-position-on-quit=no',
        '--hwdec=auto-safe',
        '--vo=gpu',
        '--cache=yes',
        '--demuxer-max-bytes=150M',
        '--demuxer-max-back-bytes=75M'
    ];

    console.log('🔧 MPV arguments:', args.join(' '));

    try {
        mpvProcess = spawn(CONFIG.mpvPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: false
        });
        
        console.log(`✅ MPV started with PID: ${mpvProcess.pid}`);

        reportPlaybackStart(itemId, startTicks);
        startProgressReporting(itemId);

        setTimeout(() => {
            connectToMpvIpc();
        }, 500);

        mpvProcess.stdout.on('data', (data) => { 
            console.log(`MPV stdout: ${data.toString().trim()}`); 
        });
        
        mpvProcess.stderr.on('data', (data) => { 
            console.error(`MPV stderr: ${data.toString().trim()}`); 
        });

        mpvProcess.on('error', (err) => {
            console.error('❌ Error executing MPV:', err.message);
            console.error('   Check mpvPath configuration:', CONFIG.mpvPath);
        });

        mpvProcess.on('close', (code, signal) => {
            console.log(`🛑 MPV closed (code ${code}, signal: ${signal})`);
            
            if (code === 1) {
                console.error('⚠️ MPV closed with error. Possible causes:');
                console.error('   - Command line argument issue');
                console.error('   - Cannot create window');
                console.error('   - Video driver problem');
                console.error('   - Insufficient permissions');
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
        console.error('❌ Critical error executing MPV:', err);
        console.error('   Stack:', err.stack);
    }
}

function connectToMpvIpc() {
    if (ipcClient) {
        ipcClient.destroy();
    }

    let connectionAttempts = 0;
    const maxAttempts = 10;
    const retryDelay = 500;

    function attemptConnection() {
        connectionAttempts++;
        
        if (!mpvProcess || mpvProcess.exitCode !== null) {
            console.error('❌ MPV not running, canceling IPC connection');
            return;
        }

        console.log(`🔗 Attempting to connect to MPV IPC (attempt ${connectionAttempts}/${maxAttempts})...`);
        
        ipcClient = net.connect(CONFIG.ipcSocketPath);
        let buffer = '';

        ipcClient.on('connect', () => {
            console.log('✅ Connected to MPV IPC');

            setTimeout(() => {
                if (pendingStreamUrl) {
                    console.log('📡 Sending LOADFILE command...');
                    sendMpvCommand('loadfile', [pendingStreamUrl, 'replace']); 
                    console.log('    ✅ Load command sent.');
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
            
            console.log('⌨️ Keys bound');
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
                    }
                }
            });
        });

        ipcClient.on('error', (err) => {
            console.error(`⚠️ IPC error (attempt ${connectionAttempts}):`, err.message);
            
            if (connectionAttempts < maxAttempts && mpvProcess && mpvProcess.exitCode === null) {
                console.log(`🔄 Retrying IPC connection in ${retryDelay}ms...`);
                setTimeout(attemptConnection, retryDelay);
            } else if (connectionAttempts >= maxAttempts) {
                console.error('❌ Maximum IPC connection attempts reached');
                killMpv();
            }
        });

        ipcClient.on('close', () => {
            console.log('🔌 Disconnected from MPV IPC');
            ipcClient = null;
        });
    }

    attemptConnection();
}

async function markItemAsWatched(itemId) {
    try {
        const headers = getAuthHeaders();
        await axios.post(`${CONFIG.serverUrl}/Users/${userId}/PlayedItems/${itemId}`, {}, { headers });
        console.log('✅ Item marked as watched in Jellyfin');

        const positions = loadPlaybackPositions();
        if (positions[itemId]) {
            delete positions[itemId];
            fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
            console.log('🗑️ Local position cleared (content watched)');
        }
    } catch (error) {
        console.error('⚠️ Error marking item as watched:', error.message);
    }
}

function killMpv() {
    if (mpvProcess) {
        console.log('⏹️ Forcing previous MPV shutdown...');
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
        console.error('⚠️ Error sending command to MPV:', e.message);
    }
}

function handleMpvEvent(event) {
    
    if (event.event === 'file-loaded') {
        console.log('✅ File loaded by MPV. Preparing Seek if necessary...');
        
        if (pendingStartSeconds > 0) {
            sendMpvCommand('seek', [pendingStartSeconds, 'absolute']);
            console.log(`⏩ Automatic seek to saved position: ${pendingStartSeconds.toFixed(2)}s`);
            
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
        console.log('🎬 eof-reached event detected (End of episode)');
        
        if (currentItemId) {
            markItemAsWatched(currentItemId);
        }
        
        playNextEpisode();
        return;
    }

    if (event.event === 'client-message' && event.args && event.args[0]) {
        if (event.args[0] === 'jellyfin-next') {
            console.log('⏭️ Next episode requested (Keypress)');
            playNextEpisode();
        } else if (event.args[0] === 'jellyfin-prev') {
            console.log('⏮️ Previous episode requested (Keypress)');
            playPreviousEpisode();
        }
    }
}

function playNextEpisode() {
    if (!currentEpisodeInfo || !currentEpisodeInfo.isSeries) {
        console.log('ℹ️ Not a series, ignoring Next command.');
        return;
    }

    if (!currentEpisodeInfo.nextEpisode) {
        console.log('ℹ️ No more episodes in this season, ending.');
        killMpv();
        return;
    }

    const nextEp = currentEpisodeInfo.nextEpisode;
    console.log(`▶️ Starting next episode: T${nextEp.ParentIndexNumber}E${nextEp.IndexNumber} - ${nextEp.Name}`);
    playMedia(nextEp.Id, 0);
}

function playPreviousEpisode() {
    if (!currentEpisodeInfo || !currentEpisodeInfo.isSeries) {
        console.log('ℹ️ Not a series, ignoring Previous command.');
        return;
    }

    if (currentPositionSeconds > 30) {
        console.log('↩️ Restarting current episode (time > 30s)');
        playMedia(currentItemId, 0);
        return;
    }

    if (!currentEpisodeInfo.previousEpisode) {
        console.log('ℹ️ This is the first episode of the season.');
        return;
    }

    const prevEp = currentEpisodeInfo.previousEpisode;
    console.log(`◀️ Starting previous episode: T${prevEp.ParentIndexNumber}E${prevEp.IndexNumber} - ${prevEp.Name}`);
    playMedia(prevEp.Id, 0);
}

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

    console.log('📡 Reporting playback start...');
    
    axios.post(`${CONFIG.serverUrl}/Sessions/Playing`, data, { headers })
        .catch(e => {
            console.error('⚠️ Error reporting start:', e.message);
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

    console.log(`📡 Reporting playback stop (position: ${(positionTicks / 10000000).toFixed(2)}s)...`);
    
    axios.post(`${CONFIG.serverUrl}/Sessions/Playing/Stopped`, data, { headers })
        .then(() => {
            console.log('✅ Playback stop reported correctly');
        })
        .catch(e => {
            console.error('⚠️ Error reporting stop:', e.message);
        });
}

process.on('SIGINT', () => {
    console.log('\n👋 Closing application...');
    
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

process.on('SIGTERM', () => {
    console.log('\n👋 Closing application (SIGTERM)...');
    
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

async function main() {
    console.log('\n🚀 Starting Jellyfin MPV Shim...\n');
    
	const dataDir = path.join(__dirname, 'data');
   if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
   }
	
    const hasToken = loadToken();
    
    if (!hasToken || !accessToken) {
        const authenticated = await authenticateUser();
        if (!authenticated) {
            console.error('❌ Could not authenticate. Check your CONFIG credentials.');
            process.exit(1);
        }
    }
    
    await connectWebSocket();
    
    console.log('\n✅ Script started correctly');
    console.log('💡 Open Jellyfin in your browser and use "Play on" to select this device.');
    console.log('💾 Local position system active');
    console.log('🔄 Automatic reconnection enabled with Exponential Backoff');
    console.log('⏭️ Use media keys or > and < keys to change episodes.\n');
}

main().catch(error => {
    console.error('❌ Fatal error!:', error);
    process.exit(1);
});
