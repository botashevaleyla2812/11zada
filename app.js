'use strict';

// Signaling endpoint supplied in the assignment.
const SIGNALING_URL = 'wss://inai-col3.fishrungames.com/signaling/';

const el = (id) => document.getElementById(id);
const ui = {
  localVideo: el('localVideo'),
  remoteVideo: el('remoteVideo'),
  localPlaceholder: el('localPlaceholder'),
  remotePlaceholder: el('remotePlaceholder'),
  connectBtn: el('connectBtn'),
  hangupBtn: el('hangupBtn'),
  micBtn: el('micBtn'),
  camBtn: el('camBtn'),
  micIcon: el('micIcon'),
  camIcon: el('camIcon'),
  micLabel: el('micLabel'),
  camLabel: el('camLabel'),
  statusText: el('statusText'),
  statusDot: el('statusDot'),
  hint: el('hint'),
  localState: el('localState'),
  remoteState: el('remoteState')
};

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

const state = {
  id: makeId(),
  socket: null,
  pc: null,
  localStream: null,
  remoteStream: null,
  peerId: null,
  sessionId: null,
  connected: false,
  started: false,
  manualDisconnect: false,
  makingOffer: false,
  offerStarted: false,
  localDescriptionSent: false,
  outgoingCandidates: [],
  incomingCandidates: [],
  micEnabled: true,
  cameraEnabled: true
};

function setStatus(text, online = false) {
  ui.statusText.textContent = text;
  ui.statusDot.classList.toggle('online', online);
}

function setHint(text) {
  ui.hint.textContent = text;
}

function setCallControls(enabled) {
  ui.micBtn.disabled = !enabled;
  ui.camBtn.disabled = !enabled;
  ui.hangupBtn.disabled = !enabled;
  ui.connectBtn.disabled = enabled;
}

function updateMediaButtons() {
  ui.micIcon.textContent = state.micEnabled ? '♩' : '⊘';
  ui.camIcon.textContent = state.cameraEnabled ? '▣' : '⊘';
  ui.micLabel.textContent = state.micEnabled ? 'Микрофон' : 'Микрофон выключен';
  ui.camLabel.textContent = state.cameraEnabled ? 'Камера' : 'Камера выключена';
}

function sendSignal(message) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify({ ...message, from: state.id }));
    return true;
  } catch (error) {
    console.error('Не удалось отправить signaling-сообщение:', error);
    setHint('Не удалось отправить данные подключения. Проверьте соединение.');
    return false;
  }
}

function clearPeerConnection() {
  if (state.pc) {
    const oldPc = state.pc;
    oldPc.ontrack = null;
    oldPc.onicecandidate = null;
    oldPc.onnegotiationneeded = null;
    oldPc.onconnectionstatechange = null;
    oldPc.oniceconnectionstatechange = null;
    oldPc.close();
  }
  state.pc = null;
  state.remoteStream = null;
  state.peerId = null;
  state.sessionId = null;
  state.makingOffer = false;
  state.offerStarted = false;
  state.localDescriptionSent = false;
  state.outgoingCandidates = [];
  state.incomingCandidates = [];
  ui.remoteVideo.srcObject = null;
  ui.remotePlaceholder.hidden = false;
  ui.remoteState.textContent = 'Пока не подключён';
}

function createPeerConnection() {
  if (state.pc) return state.pc;
  if (!state.localStream) throw new Error('Сначала включите камеру и микрофон.');

  const pc = new RTCPeerConnection(rtcConfig);
  state.pc = pc;
  state.remoteStream = new MediaStream();

  state.localStream.getTracks().forEach((track) => {
    pc.addTrack(track, state.localStream);
  });

  pc.ontrack = (event) => {
    if (state.pc !== pc) return;
    const incomingStream = event.streams && event.streams[0];
    if (incomingStream) {
      ui.remoteVideo.srcObject = incomingStream;
    } else if (!state.remoteStream.getTracks().some((track) => track.id === event.track.id)) {
      state.remoteStream.addTrack(event.track);
      ui.remoteVideo.srcObject = state.remoteStream;
    }
    ui.remotePlaceholder.hidden = true;
    ui.remoteState.textContent = 'Получаем видео и аудио…';
    ui.remoteVideo.play().catch(() => {
      // Браузер может ждать первого пользовательского взаимодействия для autoplay.
    });
  };

  pc.onicecandidate = (event) => {
    if (state.pc !== pc || !event.candidate) return;
    const candidateMessage = {
      type: 'candidate',
      candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
      sessionId: state.sessionId
    };
    if (state.localDescriptionSent) {
      sendSignal(candidateMessage);
    } else {
      state.outgoingCandidates.push(candidateMessage);
    }
  };

  pc.onnegotiationneeded = () => {
    // Только участник с меньшим ID начинает offer. Это исключает одновременные offer.
    maybeCreateOffer().catch(handleNegotiationError);
  };

  pc.onconnectionstatechange = () => {
    if (state.pc !== pc) return;
    if (pc.connectionState === 'connected') {
      ui.remoteState.textContent = 'На связи';
      setStatus('Видеосвязь активна', true);
      setHint('Соединение установлено. Можно начинать собеседование.');
    } else if (pc.connectionState === 'connecting') {
      ui.remoteState.textContent = 'Устанавливаем соединение…';
    } else if (pc.connectionState === 'disconnected') {
      ui.remoteState.textContent = 'Связь прервалась';
      setHint('Связь с собеседником прервалась. Ожидаем восстановления или отключения.');
    } else if (pc.connectionState === 'failed') {
      ui.remoteState.textContent = 'Не удалось соединиться';
      setHint('WebRTC не смог установить медиасоединение. В некоторых сетях нужен TURN-сервер.');
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (state.pc !== pc) return;
    if (pc.iceConnectionState === 'checking') {
      ui.remoteState.textContent = 'Проверяем сетевой маршрут…';
    }
  };

  return pc;
}

function flushOutgoingCandidates() {
  const queued = state.outgoingCandidates.splice(0);
  queued.forEach((message) => sendSignal(message));
}

async function flushIncomingCandidates() {
  const pc = state.pc;
  if (!pc || !pc.remoteDescription) return;
  const queued = state.incomingCandidates.splice(0);
  for (const item of queued) {
    if (item.sessionId && state.sessionId && item.sessionId !== state.sessionId) continue;
    try {
      await pc.addIceCandidate(item.candidate);
    } catch (error) {
      console.warn('Не удалось добавить отложенный ICE candidate:', error);
    }
  }
}

async function maybeCreateOffer() {
  const pc = state.pc;
  if (!pc || !state.peerId || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (state.id.localeCompare(state.peerId) >= 0) return;
  if (state.offerStarted || state.makingOffer || pc.signalingState !== 'stable') return;

  state.offerStarted = true;
  state.makingOffer = true;
  state.sessionId = makeId();
  state.localDescriptionSent = false;
  state.outgoingCandidates = [];

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sent = sendSignal({
      type: 'offer',
      sdp: pc.localDescription.sdp,
      sessionId: state.sessionId
    });
    if (!sent) throw new Error('WebSocket не готов отправлять offer.');
    state.localDescriptionSent = true;
    flushOutgoingCandidates();
    setHint('Предложение отправлено. Ожидаем ответ собеседника…');
  } catch (error) {
    state.offerStarted = false;
    throw error;
  } finally {
    state.makingOffer = false;
  }
}

function handleNegotiationError(error) {
  console.error('Ошибка WebRTC negotiation:', error);
  setHint(`Не удалось начать WebRTC-соединение: ${error.message || error}`);
}

function setPeer(peerId) {
  if (!peerId || peerId === state.id) return;
  if (state.peerId && state.peerId !== peerId) {
    clearPeerConnection();
  }
  state.peerId = peerId;
  createPeerConnection();
  maybeCreateOffer().catch(handleNegotiationError);
}

async function handleSignalMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch (error) {
    console.warn('Получено не JSON-сообщение signaling:', event.data);
    return;
  }

  if (!message || typeof message !== 'object') return;

  if (message.type === 'peer-left') {
    clearPeerConnection();
    setHint('Собеседник отключился. Ожидаем нового участника.');
    setStatus('Ожидание собеседника', true);
    return;
  }

  if (message.type === 'hello' || message.type === 'hello-ack') {
    if (!message.id || message.id === state.id) return;
    setPeer(message.id);
    if (message.type === 'hello') {
      sendSignal({ type: 'hello-ack', id: state.id });
    }
    return;
  }

  // Сообщения старого участника не должны вмешиваться в новую пару.
  if (message.from && state.peerId && message.from !== state.peerId) return;

  if (message.type === 'offer') {
    if (!message.sdp) return;
    try {
      const pc = createPeerConnection();
      state.sessionId = message.sessionId || makeId();
      state.localDescriptionSent = false;
      state.outgoingCandidates = [];
      await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      await flushIncomingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const sent = sendSignal({
        type: 'answer',
        sdp: pc.localDescription.sdp,
        sessionId: state.sessionId
      });
      if (!sent) throw new Error('WebSocket не готов отправлять answer.');
      state.localDescriptionSent = true;
      flushOutgoingCandidates();
      setHint('Ответ отправлен. Устанавливаем видеосоединение…');
    } catch (error) {
      handleNegotiationError(error);
    }
    return;
  }

  if (message.type === 'answer') {
    if (!message.sdp || !state.pc) return;
    if (message.sessionId && state.sessionId && message.sessionId !== state.sessionId) return;
    try {
      await state.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      await flushIncomingCandidates();
      setHint('Ответ получен. Устанавливаем видеосоединение…');
    } catch (error) {
      handleNegotiationError(error);
    }
    return;
  }

  if (message.type === 'candidate' || message.type === 'ice-candidate') {
    const candidate = message.candidate || message.iceCandidate;
    if (!candidate) return;
    if (message.sessionId && state.sessionId && message.sessionId !== state.sessionId) return;
    if (!state.pc || !state.pc.remoteDescription) {
      state.incomingCandidates.push({ candidate, sessionId: message.sessionId || null });
      return;
    }
    try {
      await state.pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn('Не удалось добавить ICE candidate:', error);
    }
  }
}

async function startCall() {
  if (state.started) return;
  ui.connectBtn.disabled = true;
  setHint('Запрашиваем доступ к камере и микрофону…');

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    ui.connectBtn.disabled = false;
    setHint('Браузер не разрешает доступ к камере. Откройте сайт через HTTPS или localhost.');
    return;
  }

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (error) {
    ui.connectBtn.disabled = false;
    setHint(`Нет доступа к камере или микрофону: ${error.message}. Разрешите доступ в браузере и попробуйте снова.`);
    return;
  }

  state.started = true;
  state.manualDisconnect = false;
  state.micEnabled = true;
  state.cameraEnabled = true;
  ui.localVideo.srcObject = state.localStream;
  ui.localPlaceholder.hidden = true;
  ui.localState.textContent = 'Камера и микрофон включены';
  updateMediaButtons();

  try {
    const socket = new WebSocket(SIGNALING_URL);
    state.socket = socket;

    socket.onopen = () => {
      if (state.socket !== socket || state.manualDisconnect) return;
      state.connected = true;
      setStatus('Сервер подключён', true);
      setCallControls(true);
      setHint('Вы подключены к signaling-серверу. Ожидаем второго участника…');
      // Handshake нужен, потому что сервер пересылает только сообщения между клиентами.
      sendSignal({ type: 'hello', id: state.id });
    };

    socket.onmessage = (event) => {
      if (state.socket !== socket || state.manualDisconnect) return;
      handleSignalMessage(event).catch((error) => {
        console.error('Ошибка обработки signaling-сообщения:', error);
        setHint('Ошибка обработки сообщения от signaling-сервера.');
      });
    };

    socket.onerror = () => {
      if (state.socket !== socket || state.manualDisconnect) return;
      setStatus('Ошибка сервера');
      setHint('Не удалось связаться с signaling-сервером. Проверьте интернет и попробуйте ещё раз.');
    };

    socket.onclose = () => {
      if (state.socket !== socket || state.manualDisconnect) return;
      cleanup(false);
      setStatus('Соединение закрыто');
      setHint('Signaling-соединение закрыто сервером. Возможно, сервер освободил место для третьего участника.');
    };
  } catch (error) {
    cleanup(false);
    setStatus('Ошибка подключения');
    setHint(`Не удалось открыть WebSocket: ${error.message}`);
  }
}

function cleanup(closeSocket = true) {
  state.manualDisconnect = true;
  state.started = false;
  state.connected = false;
  clearPeerConnection();

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }
  ui.localVideo.srcObject = null;
  ui.localPlaceholder.hidden = false;
  ui.localState.textContent = 'Камера выключена';

  const socket = state.socket;
  state.socket = null;
  if (closeSocket && socket) {
    socket.onclose = null;
    try { socket.close(); } catch (error) { console.warn('Ошибка закрытия WebSocket:', error); }
  }

  state.micEnabled = true;
  state.cameraEnabled = true;
  updateMediaButtons();
  setCallControls(false);
  setStatus('Не подключено');
}

ui.connectBtn.addEventListener('click', startCall);
ui.hangupBtn.addEventListener('click', () => {
  cleanup(true);
  setHint('Вы завершили звонок.');
});
ui.micBtn.addEventListener('click', () => {
  if (!state.localStream) return;
  state.micEnabled = !state.micEnabled;
  state.localStream.getAudioTracks().forEach((track) => { track.enabled = state.micEnabled; });
  updateMediaButtons();
  ui.localState.textContent = state.cameraEnabled
    ? (state.micEnabled ? 'Камера и микрофон включены' : 'Микрофон выключен')
    : (state.micEnabled ? 'Камера выключена' : 'Камера и микрофон выключены');
});
ui.camBtn.addEventListener('click', () => {
  if (!state.localStream) return;
  state.cameraEnabled = !state.cameraEnabled;
  state.localStream.getVideoTracks().forEach((track) => { track.enabled = state.cameraEnabled; });
  updateMediaButtons();
  ui.localState.textContent = state.cameraEnabled
    ? (state.micEnabled ? 'Камера и микрофон включены' : 'Камера включена')
    : (state.micEnabled ? 'Камера выключена' : 'Камера и микрофон выключены');
});

window.addEventListener('beforeunload', () => cleanup(true));
