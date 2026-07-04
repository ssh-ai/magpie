// @ts-check
/*
 * Magpie onboarding page — the zero-developer-skill surface.
 *
 * What this file does, end to end:
 *   1. Takes a pairing code the human pasted.
 *   2. Derives the relay `rendezvousId` from it (REAL crypto — see below).
 *   3. Opens a browser WebSocket to the relay and sends a `join` control frame.
 *   4. Renders the live call: `deliver` frames (transcript), `peer-joined`,
 *      `hangup`, and relay `error`s.
 *   5. Wires two buttons: "Approve tool action" and "Hang up".
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  HONEST-CRYPTO BOUNDARY  (read this before "fixing" the transcript)
 * ───────────────────────────────────────────────────────────────────────────
 *  The relay brokers CIPHERTEXT ONLY. Two distinct one-way functions of the
 *  pairing code are in play, both HKDF-SHA256 (RFC 5869) with an empty salt,
 *  matching `@magpie/protocol/pairing.ts` byte-for-byte:
 *
 *    rendezvousId = HKDF(code, info="magpie:rendezvous:v1", 16 bytes)  → hex
 *    channelKey   = HKDF(code, info="magpie:channel:v1",   32 bytes)  → AES-256-GCM key
 *
 *  The rendezvous id is JUST a digest the relay matches on — so we compute it
 *  here for real, with WebCrypto, and JOIN actually works. Good.
 *
 *  The channel key is what SEALS/OPENS message payloads. A `deliver` frame's
 *  `.frame` is base64( iv[12] ‖ tag[16] ‖ AES-256-GCM-ciphertext ). To show the
 *  human the actual transcript text — or to send a sealed "approve" message — we
 *  would need to port `channelFromCode` to the browser (derive channelKey via
 *  WebCrypto HKDF, then AES-GCM open/seal). WebCrypto can do all of this; it's a
 *  ~30-line port. It is deliberately NOT done in this scaffold.
 *
 *  >>> We DO NOT FAKE DECRYPTION. <<<  Until the port lands, the transcript shows
 *  only frame METADATA (which we can see honestly: callId, direction, byte size,
 *  arrival time), never invented plaintext. The approve button assembles the
 *  message it *would* seal and stops at the seal step with a visible notice.
 *
 *  TODO(channel-port): implement `channelFromCode(code)` here returning
 *  `{ seal(bytes), open(bytes) }` using:
 *    const ikm = new TextEncoder().encode(normalizeCode(code));
 *    const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
 *    const key  = await crypto.subtle.deriveKey(
 *      { name:'HKDF', hash:'SHA-256', salt:new Uint8Array(0),
 *        info: enc('magpie:channel:v1') },
 *      base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
 *    // open:  iv=frame[0:12]; tag=frame[12:28]; ct=frame[28:];
 *    //        crypto.subtle.decrypt({name:'AES-GCM', iv, additionalData:undefined,
 *    //          tagLength:128}, key, concat(ct, tag))  → JSON(Message)
 *    // seal:  iv=randomBytes(12); subtle.encrypt(...) → split off the trailing
 *    //        16-byte tag and reassemble iv‖tag‖ct to match Node's layout.
 *  Then replace renderDeliver()'s metadata path with parsed Message rendering,
 *  and replace the approve handler's TODO with `seal` + a real `send` frame.
 * ───────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ── Constants mirrored from @magpie/protocol (keep in sync) ─────────────
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_GROUP_LEN = 4;
const CODE_GROUPS = 3;
const CODE_TOTAL_LEN = CODE_GROUP_LEN * CODE_GROUPS; // 12
const PROTOCOL_VERSION = 1;
const RENDEZVOUS_INFO = 'magpie:rendezvous:v1';
const DEFAULT_RELAY_URL = 'ws://localhost:8787';

const enc = new TextEncoder();

// ── DOM handles ──────────────────────────────────────────────────────────────
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const els = {
  code: /** @type {HTMLInputElement} */ ($('code')),
  me: /** @type {HTMLInputElement} */ ($('me')),
  relay: /** @type {HTMLInputElement} */ ($('relay')),
  joinBtn: /** @type {HTMLButtonElement} */ ($('joinBtn')),
  joinError: $('joinError'),
  joinCard: $('joinCard'),
  callCard: $('callCard'),
  callMeta: $('callMeta'),
  transcript: $('transcript'),
  emptyState: $('emptyState'),
  approveBtn: /** @type {HTMLButtonElement} */ ($('approveBtn')),
  hangupBtn: /** @type {HTMLButtonElement} */ ($('hangupBtn')),
  dot: $('dot'),
  statusText: $('statusText'),
  liveDot: $('liveDot'),
  liveText: $('liveText'),
  cryptoStatus: $('cryptoStatus'),
};

// Prefill relay URL from the server injection (window.MAGPIE_RELAY_URL) or default.
els.relay.value =
  (typeof window !== 'undefined' && window.MAGPIE_RELAY_URL) || DEFAULT_RELAY_URL;

// ── Call state ───────────────────────────────────────────────────────────────
/** @type {WebSocket | null} */ let ws = null;
/** @type {string | null} */ let callId = null;
/** @type {string | null} */ let peer = null;
let frameCount = 0;

// ── Code helpers (mirror normalizePairingCode) ───────────────────────────────
/** Uppercase, strip non-alphanumerics, validate against the protocol alphabet. */
function normalizeCode(input) {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== CODE_TOTAL_LEN) {
    throw new Error(`Code should be ${CODE_TOTAL_LEN} letters/numbers (like K7F3-9M2P-XQ4R).`);
  }
  for (const ch of cleaned) {
    if (!CODE_ALPHABET.includes(ch)) {
      throw new Error(`"${ch}" isn't a valid code character — check for typos.`);
    }
  }
  return cleaned;
}

/** Pretty-format keystrokes back into GROUP-GROUP-GROUP as the user types. */
function formatCodeInput(raw) {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_TOTAL_LEN);
  return cleaned.match(new RegExp(`.{1,${CODE_GROUP_LEN}}`, 'g'))?.join('-') ?? cleaned;
}

/**
 * rendezvousId = HKDF-SHA256(code, salt=∅, info="magpie:rendezvous:v1", 16B) → hex.
 * REAL crypto: this is the exact digest the relay pairs on. The browser can and
 * should compute it honestly — no code secrecy is lost (it's one-way).
 */
async function rendezvousId(code) {
  const ikm = enc.encode(normalizeCode(code));
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(RENDEZVOUS_INFO) },
    base,
    16 * 8, // 16 bytes
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Tiny UI utilities ────────────────────────────────────────────────────────
function setStatus(text, kind /* '' | 'connecting' | 'live' | 'dead' */) {
  els.statusText.textContent = text;
  els.dot.className = 'dot' + (kind ? ' ' + kind : '');
}
function showJoinError(msg) {
  els.joinError.textContent = msg || '';
}
function enterCallView() {
  els.joinCard.classList.add('hidden');
  els.callCard.classList.remove('hidden');
}
function setLive(isLive) {
  els.liveDot.className = 'dot ' + (isLive ? 'live' : 'dead');
  els.liveText.textContent = isLive ? 'Live' : 'Ended';
  els.approveBtn.disabled = !isLive;
  els.hangupBtn.disabled = !isLive;
}

/** Append a transcript card. We render METADATA only — never faked plaintext. */
function addTranscriptCard({ klass, who, when, body, sealed }) {
  els.emptyState?.remove();
  const card = document.createElement('div');
  card.className = 'frame' + (klass ? ' ' + klass : '');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const whoEl = document.createElement('span');
  whoEl.className = 'who';
  whoEl.textContent = who;
  const whenEl = document.createElement('span');
  whenEl.textContent = when ?? new Date().toLocaleTimeString();
  meta.append(whoEl, whenEl);
  card.append(meta);
  if (body) {
    const b = document.createElement('div');
    b.className = 'body';
    b.textContent = body;
    card.append(b);
  }
  if (sealed) {
    const s = document.createElement('div');
    s.className = 'sealed';
    s.textContent = sealed;
    card.append(s);
  }
  els.transcript.append(card);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

// ── Relay frame handling ─────────────────────────────────────────────────────
/**
 * Render one delivered transcript frame. Because we can't (yet) open the
 * ciphertext, we surface what is genuinely observable: that a sealed message
 * arrived, its byte size, and the time. This is honest and still useful — the
 * human sees the call is alive and progressing.
 */
function renderDeliver(frame) {
  frameCount += 1;
  const b64 = typeof frame.frame === 'string' ? frame.frame : '';
  // Sealed bytes = base64-decoded length. The first 12 are IV, next 16 the GCM tag.
  const approxBytes = Math.max(0, Math.floor((b64.length * 3) / 4));
  const ctBytes = Math.max(0, approxBytes - 28);
  addTranscriptCard({
    who: `🔒 sealed message #${frameCount}` + (peer ? ` from ${peer}` : ''),
    body: `Encrypted payload · ~${ctBytes} bytes of content (the page can't read it yet — see crypto note).`,
    sealed: b64.length > 96 ? b64.slice(0, 96) + '…' : b64,
  });
}

function handleRelayFrame(raw) {
  let f;
  try {
    f = JSON.parse(raw);
  } catch {
    return; // never trust the wire; ignore non-JSON
  }
  if (!f || typeof f !== 'object') return;

  switch (f.t) {
    case 'joined':
      callId = String(f.callId ?? '');
      peer = typeof f.peer === 'string' ? f.peer : null;
      els.callMeta.textContent = `call ${callId}${peer ? ' · with ' + peer : ''}`;
      setLive(true);
      addTranscriptCard({
        klass: 'system',
        who: '👋 You joined the call',
        body: peer ? `You're patched through to ${peer}. Watching live.` : `You're on the line. Watching live.`,
      });
      break;

    case 'peer-joined':
      // We're already in; this is the opener learning we arrived. Informational.
      addTranscriptCard({ klass: 'system', who: 'ℹ️ Both sides connected', body: 'The agents can talk now.' });
      break;

    case 'deliver':
      renderDeliver(f);
      break;

    case 'hangup':
      addTranscriptCard({ klass: 'bye', who: '📴 Call ended', body: String(f.reason ?? 'the call was hung up') });
      setLive(false);
      break;

    case 'error':
      addTranscriptCard({
        klass: 'system',
        who: `⚠️ Relay said: ${f.code ?? 'error'}`,
        body: String(f.message ?? 'something went wrong'),
      });
      // A join error before we have a callId means we never got on the call.
      if (!callId) {
        setStatus('Could not join', 'dead');
        showJoinError(friendlyError(String(f.code ?? ''), String(f.message ?? '')));
        els.joinBtn.disabled = false;
      }
      break;
  }
}

/** Translate relay error codes into something a non-developer can act on. */
function friendlyError(code, message) {
  switch (code) {
    case 'UNKNOWN_RENDEZVOUS':
      return 'No call is waiting for that code. Double-check it, or ask your teammate to start the call first.';
    case 'EXPIRED':
      return 'That code has expired (codes last ~10 minutes). Ask for a fresh one.';
    case 'ALREADY_PAIRED':
      return 'Someone already joined with that code — codes are single-use. Ask for a new one.';
    case 'BAD_FRAME':
      return 'The relay rejected the request. Check the code and the relay address.';
    default:
      return message || 'Could not join the call.';
  }
}

// ── Join flow ────────────────────────────────────────────────────────────────
async function joinCall() {
  showJoinError('');
  const codeRaw = els.code.value;
  const from = (els.me.value || '@guest/watch').trim();
  const relayUrl = (els.relay.value || DEFAULT_RELAY_URL).trim();

  let rid;
  try {
    rid = await rendezvousId(codeRaw);
  } catch (err) {
    showJoinError(err instanceof Error ? err.message : String(err));
    return;
  }

  els.joinBtn.disabled = true;
  setStatus('Connecting…', 'connecting');

  try {
    ws = new WebSocket(relayUrl);
  } catch (err) {
    setStatus('Bad relay address', 'dead');
    showJoinError(`Couldn't open "${relayUrl}". It should look like ws://host:port.`);
    els.joinBtn.disabled = false;
    return;
  }

  ws.addEventListener('open', () => {
    setStatus('Joining…', 'connecting');
    // Control frame the relay expects (see @magpie/relay JoinFrame).
    ws?.send(JSON.stringify({ t: 'join', rendezvousId: rid, from }));
    // Optimistically reveal the call view; `joined`/`error` will confirm.
    enterCallView();
  });

  ws.addEventListener('message', (ev) => {
    handleRelayFrame(typeof ev.data === 'string' ? ev.data : '');
  });

  ws.addEventListener('close', () => {
    setStatus('Disconnected', 'dead');
    setLive(false);
    if (callId) {
      addTranscriptCard({ klass: 'bye', who: '🔌 Connection closed', body: 'The line to the relay dropped.' });
    } else {
      showJoinError('Lost the connection before joining. Is the relay running at that address?');
      els.joinBtn.disabled = false;
    }
  });

  ws.addEventListener('error', () => {
    setStatus('Connection error', 'dead');
    if (!callId) {
      showJoinError(`Couldn't reach the relay at "${relayUrl}". Make sure it's running.`);
      els.joinBtn.disabled = false;
    }
  });
}

// ── Approve tool action ──────────────────────────────────────────────────────
/*
 * What "approve" means: the peer agent asked to run a tool, and your side (the
 * human on this page) grants it. In the real protocol this is a `Message`
 * ({ type:'system', content:'approve:<id>' or a structured grant }) that gets
 * SEALED with the call's channel and shipped as a `send` control frame.
 *
 * We assemble that intent here but STOP at the seal step on purpose (no faked
 * crypto). See the channel-port TODO at the top of this file.
 */
function approveToolAction() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !callId) return;

  /** The Message we WOULD seal and send. Kept here so the port is a drop-in. */
  const approval = {
    v: PROTOCOL_VERSION,
    id: 'msg-' + cryptoRandomId(),
    callId,
    from: (els.me.value || '@guest/watch').trim(),
    to: peer ?? undefined,
    type: 'system',
    ts: new Date().toISOString(),
    turn: 0,
    inReplyTo: null,
    content: 'approve: tool action granted by human watcher',
  };

  // TODO(channel-port): seal + send for real, e.g.:
  //   const channel = await channelFromCode(els.code.value);
  //   const sealed  = await channel.seal(enc.encode(JSON.stringify(approval)));
  //   const frame   = base64(sealed);
  //   ws.send(JSON.stringify({ t:'send', callId, frame }));
  void approval;

  addTranscriptCard({
    klass: 'system',
    who: '✅ Approval prepared',
    body:
      'Your approval was assembled but NOT sent — sealing needs the channelFromCode ' +
      'browser port (see crypto note). No fake ciphertext is sent to the relay.',
  });
  els.cryptoStatus.textContent = ' Approve is wired; sealing is the only missing piece.';
}

function cryptoRandomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  // base64url-ish; the protocol only requires /^[A-Za-z0-9_-]{10,}$/ after msg-.
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c] ?? ''));
}

// ── Hang up ──────────────────────────────────────────────────────────────────
function hangUp() {
  if (ws && ws.readyState === WebSocket.OPEN && callId) {
    // Plain control frame — no payload to seal. The relay closes both sides.
    ws.send(JSON.stringify({ t: 'hangup', callId, reason: 'human watcher hung up' }));
  }
  addTranscriptCard({ klass: 'bye', who: '📴 You hung up', body: 'Ending the call for both sides.' });
  setLive(false);
  try {
    ws?.close();
  } catch {
    /* already closing */
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────
els.code.addEventListener('input', () => {
  const start = els.code.selectionStart ?? els.code.value.length;
  const before = els.code.value;
  els.code.value = formatCodeInput(before);
  // keep caret roughly sane after auto-dashing
  if (els.code.value.length >= before.length) els.code.setSelectionRange(start + (els.code.value.length - before.length), start + (els.code.value.length - before.length));
});
els.code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinCall();
});
els.joinBtn.addEventListener('click', joinCall);
els.approveBtn.addEventListener('click', approveToolAction);
els.hangupBtn.addEventListener('click', hangUp);

// Disabled until we're live.
setLive(false);
setStatus('Not connected', '');
