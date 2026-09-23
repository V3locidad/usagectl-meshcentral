/*
 * usagectl — Taux d'occupation réelle des postes par salle.
 *
 * Enregistre les changements de sessions OS remontés par MeshAgent (`coreinfo.users`)
 * et les agrège par poste et par salle. La power timeline reste utilisée pour
 * afficher séparément le taux d'allumage et le gaspillage hors heures.
 *
 * v0.0.35 :
 *   - Occupation basée sur les sessions OS ouvertes, avec historique local.
 *   - Retour à l'état libre à la déconnexion utilisateur ou agent.
 *   - Taux d'allumage conservé comme métrique distincte.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 5;
const CACHE_FILE = path.join(__dirname, 'usagectl-cache.json');
const PRESENCE_VERSION = 1;
const PRESENCE_FILE = path.join(__dirname, 'usagectl-presence.json');
const PRESENCE_RETENTION_DAYS = 400;
const PRESENCE_SAVE_DELAY_MS = 1000;
const LOGIN_VERSION = 2;
const LOGIN_FILE = path.join(__dirname, 'usagectl-logins.json');
const LOGIN_RETENTION_DAYS = 400;
const LOGIN_SAVE_DELAY_MS = 1000;
const LOGIN_POLL_MS = 5000;
const LOGIN_LOGON_LOOKBACK_MS = 4 * 60 * 60 * 1000;
const LOGIN_NATIVE_LOOKUP_TIMEOUT_MS = 5000;
// L'interrogation du journal Security est normalement quasi immédiate. On
// laisse néanmoins davantage de marge aux postes lents avant de déclarer la
// mesure incomplète (deux essais, soit au maximum une minute).
const LOGIN_LOOKUP_TIMEOUT_MS = 30000;
const LOGIN_LOOKUP_MAX_ATTEMPTS = 2;
const LOGIN_HISTORY_MAX_PER_NODE = 200;
const LOGIN_SESSION_ID = 'usagectl-login-monitor';
const CACHE_TTL_LIVE_MS = 5 * 60 * 1000;
// Les mesures brutes sont conservées 400 jours. Garder aussi suffisamment
// d'agrégats hebdomadaires pour consulter une année complète sans les
// recalculer à chaque affichage.
const CACHE_MAX_WEEKS = 60;
const CUSTOM_RANGE_MAX_DAYS = 366;
const CONCURRENCY = 6;
const NODE_TIMEOUT_MS = 8000;

// Salles à exclure des stats (mesh fourre-tout où arrivent les postes neufs).
const EXCLUDED_MESH_NAMES = ['PC-PEDAGO'];
function isExcludedMesh(name) {
    if (!name) return false;
    const u = String(name).toUpperCase();
    return EXCLUDED_MESH_NAMES.some(n => u === n.toUpperCase());
}

function sendJson(res, code, body) {
    try { res.status(code).set('Content-Type', 'application/json').end(JSON.stringify(body)); } catch (_) {}
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtIso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function fmtDM(d) { return pad(d.getDate()) + '/' + pad(d.getMonth() + 1); }
function fmtDMY(d) { return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear(); }
function mondayOf(d) {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    const dow = r.getDay();
    r.setDate(r.getDate() + (dow === 0 ? -6 : 1 - dow));
    return r;
}
function sumArr(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }

module.exports.usagectl = function (parent) {
    const obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.exports = [];

    // Sanity TZ check (les fenêtres Lun-Ven 8h-18h se basent sur l'heure locale du serveur).
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz && tz !== 'Europe/Paris') {
            console.log('usagectl: WARNING — server TZ=' + tz + ' (attendu Europe/Paris). Fenêtres 8h-18h potentiellement décalées.');
        }
    } catch (_) {}

    // ============ Cache ============
    let cache = { version: CACHE_VERSION, weeks: {} };
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            if (j && j.version === CACHE_VERSION) cache = j;
        }
    } catch (_) {}
    function saveCache() {
        try {
            const keys = Object.keys(cache.weeks);
            if (keys.length > CACHE_MAX_WEEKS) {
                const sorted = keys.sort((a, b) => (cache.weeks[b].computedAt || 0) - (cache.weeks[a].computedAt || 0));
                sorted.slice(CACHE_MAX_WEEKS).forEach(k => delete cache.weeks[k]);
            }
            fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
        } catch (_) {}
    }
    function invalidateWeek(key) { delete cache.weeks[key]; saveCache(); }

    // ============ Historique des sessions OS ==========
    // MeshCentral expose la liste courante dans coreinfo.users, mais ne conserve
    // pas un historique utilisable. On stocke uniquement le nombre de sessions
    // (jamais les identifiants utilisateurs) et seulement lors d'un changement.
    let presence = { version: PRESENCE_VERSION, createdAt: Date.now(), nodes: {} };
    let presenceSaveTimer = null;
    try {
        if (fs.existsSync(PRESENCE_FILE)) {
            const j = JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf8'));
            if (j && j.version === PRESENCE_VERSION && j.nodes && typeof j.nodes === 'object') presence = j;
        }
    } catch (_) {}

    function savePresenceNow() {
        if (presenceSaveTimer) { clearTimeout(presenceSaveTimer); presenceSaveTimer = null; }
        const tmp = PRESENCE_FILE + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(presence));
            fs.renameSync(tmp, PRESENCE_FILE);
        } catch (_) {
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        }
    }
    function savePresenceSoon() {
        if (presenceSaveTimer) return;
        presenceSaveTimer = setTimeout(savePresenceNow, PRESENCE_SAVE_DELAY_MS);
        if (presenceSaveTimer && typeof presenceSaveTimer.unref === 'function') presenceSaveTimer.unref();
    }
    function uniqueUserCount(users) {
        if (!Array.isArray(users)) return null;
        const seen = new Set();
        users.forEach(u => { if (typeof u === 'string' && u.trim()) seen.add(u.trim().toLowerCase()); });
        return seen.size;
    }
    function prunePresenceRecord(rec, now) {
        if (!rec || !Array.isArray(rec.events) || rec.events.length < 2) return;
        const cutoff = now - PRESENCE_RETENTION_DAYS * 86400000;
        // Conserver le dernier état antérieur à la rétention pour connaître
        // l'état initial au début de la fenêtre conservée.
        let keep = 0;
        while (keep + 1 < rec.events.length && Number(rec.events[keep + 1][0]) < cutoff) keep++;
        if (keep > 0) rec.events.splice(0, keep);
    }
    function recordPresence(nodeId, meshId, userCount, atMs) {
        if (!nodeId || !Number.isFinite(userCount)) return;
        const now = Number.isFinite(atMs) ? atMs : Date.now();
        let rec = presence.nodes[nodeId];
        let changed = false;
        if (!rec) {
            rec = presence.nodes[nodeId] = { meshid: meshId || '', firstSeenAt: now, events: [] };
            changed = true;
        }
        if (meshId && rec.meshid !== meshId) { rec.meshid = meshId; changed = true; }
        if (!Number.isFinite(rec.firstSeenAt)) rec.firstSeenAt = now;
        if (!Array.isArray(rec.events)) rec.events = [];
        const last = rec.events.length ? rec.events[rec.events.length - 1] : null;
        if (!last || Number(last[1]) !== userCount) { rec.events.push([now, userCount]); changed = true; }
        rec.lastSeenAt = now;
        if (!changed) return;
        prunePresenceRecord(rec, now);
        // Toute transition de la semaine courante rend son agrégat obsolète.
        delete cache.weeks[fmtIso(mondayOf(new Date(now)))];
        savePresenceSoon();
    }
    function presenceRecord(nodeId) {
        const rec = presence.nodes[nodeId];
        return (rec && Array.isArray(rec.events) && rec.events.length) ? rec : null;
    }
    function presenceEvents(nodeId) {
        const rec = presenceRecord(nodeId);
        if (!rec) return [];
        return rec.events.map(e => ({ time: Number(e[0]), power: Number(e[1]) > 0 ? 1 : 0 }));
    }
    function presenceSinceMs() {
        let min = null;
        Object.keys(presence.nodes).forEach(id => {
            const rec = presenceRecord(id);
            if (!rec) return;
            const t = Number.isFinite(rec.firstSeenAt) ? rec.firstSeenAt : Number(rec.events[0][0]);
            if (Number.isFinite(t) && (min == null || t < min)) min = t;
        });
        return min;
    }
    function coverageBuckets(nodeId, buckets, effectiveEnd) {
        const rec = presenceRecord(nodeId);
        const out = new Array(buckets.length).fill(0);
        if (!rec) return out;
        const first = Number.isFinite(rec.firstSeenAt) ? rec.firstSeenAt : Number(rec.events[0][0]);
        for (let i = 0; i < buckets.length; i++) {
            const a = Math.max(buckets[i][0], first);
            const b = Math.min(buckets[i][1], effectiveEnd);
            if (b > a) out[i] = b - a;
        }
        return out;
    }
    function presenceInWindows(nodeId, start, end, windows) {
        const rec = presenceRecord(nodeId);
        if (!rec) return { occupiedMs: 0, coverageMs: 0, hasData: false };
        const first = Number.isFinite(rec.firstSeenAt) ? rec.firstSeenAt : Number(rec.events[0][0]);
        const coverageStart = Math.max(start, first);
        if (coverageStart >= end) return { occupiedMs: 0, coverageMs: 0, hasData: false };
        const coverageMs = windows ? intersectSum(coverageStart, end, windows) : (end - coverageStart);
        const occupiedMs = computeOnInWindows(presenceEvents(nodeId), coverageStart, end, windows);
        return { occupiedMs, coverageMs, hasData: coverageMs > 0 };
    }

    // ============ Durée d'ouverture de session Windows ============
    // Le début privilégie la dernière saisie Windows précédant la création de
    // la session (généralement la validation par Entrée), puis retombe sur
    // l'heure de création WTS, Win32_LogonSession ou l'événement 4624. La fin
    // est l'heure à laquelle le bureau est confirmé disponible. Il n'y
    // a volontairement aucun timeout sur la connexion elle-même : une ouverture
    // de 20 minutes doit rester mesurable.
    let loginData = { version: LOGIN_VERSION, nodes: {} };
    let loginSaveTimer = null;
    const runtimeUsers = Object.create(null); // identifiants en mémoire uniquement
    const runtimeSessionIds = Object.create(null);
    const runtimeExplorerCandidates = Object.create(null);
    const runtimeLoginState = Object.create(null);
    const loginPollAt = Object.create(null);
    try {
        if (fs.existsSync(LOGIN_FILE)) {
            const j = JSON.parse(fs.readFileSync(LOGIN_FILE, 'utf8'));
            if (j && j.version === LOGIN_VERSION && j.nodes && typeof j.nodes === 'object') loginData = j;
        }
    } catch (_) {}

    function saveLoginNow() {
        if (loginSaveTimer) { clearTimeout(loginSaveTimer); loginSaveTimer = null; }
        const tmp = LOGIN_FILE + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(loginData));
            fs.renameSync(tmp, LOGIN_FILE);
        } catch (_) {
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        }
    }
    function saveLoginSoon() {
        if (loginSaveTimer) return;
        loginSaveTimer = setTimeout(saveLoginNow, LOGIN_SAVE_DELAY_MS);
        if (loginSaveTimer && typeof loginSaveTimer.unref === 'function') loginSaveTimer.unref();
    }
    function loginUserDisplay(value) {
        let raw = value;
        if (value && typeof value === 'object') {
            const user = value.Username || value.UserName || value.username || value.name || '';
            const domain = value.Domain || value.domain || '';
            raw = user && domain && String(user).indexOf('\\') < 0 ? domain + '\\' + user : user;
        }
        return String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().substring(0, 256);
    }
    function loginUserKey(value) {
        let s = loginUserDisplay(value).toLowerCase();
        if (!s) return '';
        const slash = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
        if (slash >= 0) s = s.substring(slash + 1);
        const at = s.indexOf('@');
        if (at > 0) s = s.substring(0, at);
        return s;
    }
    function loginUserKeys(users) {
        const out = [];
        (Array.isArray(users) ? users : []).forEach(u => {
            const k = loginUserKey(u);
            if (k && out.indexOf(k) < 0) out.push(k);
        });
        return out;
    }
    function loginUserDisplays(users, wantedKeys) {
        const out = [];
        const wanted = Array.isArray(wantedKeys) ? wantedKeys : null;
        (Array.isArray(users) ? users : []).forEach(u => {
            const display = loginUserDisplay(u);
            const key = loginUserKey(display);
            if (!display || !key || (wanted && wanted.indexOf(key) < 0)) return;
            if (!out.some(v => loginUserKey(v) === key)) out.push(display);
        });
        return out;
    }
    function isWindowsAgent(agent, command) {
        const id = agent && agent.agentInfo && Number(agent.agentInfo.agentId);
        if (Number.isFinite(id)) return ((id > 0 && id < 5) || (id > 41 && id < 44));
        return !!(command && typeof command.osdesc === 'string' && /windows/i.test(command.osdesc));
    }
    function loginNodeRecord(nodeId, meshId) {
        let rec = loginData.nodes[nodeId];
        if (!rec) rec = loginData.nodes[nodeId] = { meshid: meshId || '', events: [] };
        if (meshId) rec.meshid = meshId;
        if (!Array.isArray(rec.events)) rec.events = [];
        return rec;
    }
    function pruneLoginRecord(rec, now) {
        const cutoff = now - LOGIN_RETENTION_DAYS * 86400000;
        if (rec && Array.isArray(rec.events)) rec.events = rec.events.filter(e => Number(e && e[0]) >= cutoff);
    }
    function loginSessionId(pending) {
        const id = pending && typeof pending === 'object'
            ? (pending.attemptId || pending.detectedAt || pending.startAt)
            : pending;
        return LOGIN_SESSION_ID + ':' + String(id);
    }
    function sendAgent(agent, command) {
        try {
            if (agent && typeof agent.send === 'function') {
                agent.send(JSON.stringify(command));
                return true;
            }
        } catch (_) {}
        return false;
    }
    function loginRuntimeState(nodeId) {
        if (!runtimeLoginState[nodeId]) runtimeLoginState[nodeId] = {};
        return runtimeLoginState[nodeId];
    }
    function buildLogonLookupCommand(users) {
        const payload = Buffer.from(JSON.stringify(loginUserKeys(users)), 'utf8').toString('base64');
        return [
            "$ErrorActionPreference = 'Stop'",
            "$wantedJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "'))",
            '$wanted = @($wantedJson | ConvertFrom-Json)',
            'function Get-UsagectlUserKey([string]$value) {',
            "  if ([string]::IsNullOrWhiteSpace($value)) { return '' }",
            '  $v = $value.Trim().ToLowerInvariant()',
            "  $slash = [Math]::Max($v.LastIndexOf('\\'), $v.LastIndexOf('/'))",
            '  if ($slash -ge 0) { $v = $v.Substring($slash + 1) }',
            "  $at = $v.IndexOf('@')",
            '  if ($at -gt 0) { $v = $v.Substring(0, $at) }',
            '  return $v',
            '}',
            '$lookback = ' + String(LOGIN_LOGON_LOOKBACK_MS),
            '$cutoff = (Get-Date).AddMilliseconds(-$lookback)',
            // L'événement 4624 est filtré côté Windows et permet d'identifier
            // directement l'utilisateur. Il doit passer avant CIM : les
            // associations Win32_LoggedOnUser peuvent prendre plusieurs
            // dizaines de secondes sur certains postes.
            '$eventError = $false',
            'try {',
            "  $xpath = \"*[System[(EventID=4624) and TimeCreated[timediff(@SystemTime) <= $lookback]]] and *[EventData[(Data[@Name='LogonType']='2' or Data[@Name='LogonType']='10' or Data[@Name='LogonType']='11' or Data[@Name='LogonType']='12')]]\"",
            "  foreach ($event in @(Get-WinEvent -LogName Security -FilterXPath $xpath -MaxEvents 256 -ErrorAction Stop)) {",
            '    $xml = [xml]$event.ToXml()',
            '    $values = @{}',
            "    foreach ($item in @($xml.Event.EventData.Data)) { $values[[string]$item.Name] = [string]$item.'#text' }",
            "    $key = Get-UsagectlUserKey ([string]$values['TargetUserName'])",
            '    if ($wanted -contains $key) {',
            "      Write-Output ('USAGECTL_LOGON_EVENT=' + $event.TimeCreated.ToUniversalTime().ToString('o'))",
            '      exit 0',
            '    }',
            '  }',
            '} catch { $eventError = $true }',
            // Secours sans association WMI par utilisateur : au moment où
            // coreinfo annonce une nouvelle session, la session interactive
            // Windows la plus récente est précisément celle recherchée. Cette
            // requête est nettement plus rapide que N requêtes Associators.
            '$cimError = $false',
            'try {',
            "  $session = Get-CimInstance -ClassName Win32_LogonSession -Filter 'LogonType = 2 OR LogonType = 10 OR LogonType = 11 OR LogonType = 12' -ErrorAction Stop | Where-Object {",
            '    ($null -ne $_.StartTime) -and ([datetime]$_.StartTime -ge $cutoff)',
            '  } | Sort-Object StartTime -Descending | Select-Object -First 1',
            '  if ($null -ne $session) {',
            "    Write-Output ('USAGECTL_LOGON_CIM=' + ([datetime]$session.StartTime).ToUniversalTime().ToString('o'))",
            '    exit 0',
            '  }',
            '} catch { $cimError = $true }',
            "if ($cimError -and $eventError) { Write-Output 'USAGECTL_LOGON_ERROR' } else { Write-Output 'USAGECTL_LOGON_NOT_FOUND' }",
        ].join('\r\n');
    }
    function buildNativeLogonLookupCommand() {
        // WTSINFOW se termine par cinq LARGE_INTEGER : ConnectTime,
        // DisconnectTime, LastInputTime, LogonTime et CurrentTime. Les lire
        // relativement à la fin évite de dépendre de l'alignement 32/64 bits.
        // Cette interrogation s'exécute directement dans MeshAgent : aucun
        // PowerShell ni processus externe ne peut la bloquer.
        const code = "(function(){var u=require('user-sessions'),s=require('kvm-helper').users(),o=[];for(var k in s){var x=s[k];if(!x||x.SessionId==null||!x.Username)continue;try{var b=u.getRawSessionAttribute(x.SessionId,u.InfoClass.WTSSessionInfo);if(b&&b.length>=40){var p=b.length-16,lo=b.readUInt32LE(p),hi=b.readUInt32LE(p+4),ms=Math.floor((hi*4294967296+lo)/10000-11644473600000),ip=b.length-24,ilo=b.readUInt32LE(ip),ihi=b.readUInt32LE(ip+4),ims=Math.floor((ihi*4294967296+ilo)/10000-11644473600000);o.push({SessionId:x.SessionId,Username:x.Username,Domain:x.Domain||'',LogonTime:ms,LastInputTime:ims});}}catch(e){}}return o;})()";
        return 'eval "' + code + '"';
    }
    function requestNativeLogonStart(nodeId, agent) {
        const rec = loginData.nodes[nodeId];
        if (!rec || !rec.pending) return false;
        const state = loginRuntimeState(nodeId);
        const sent = sendAgent(agent, {
            action: 'msg', type: 'console', rights: 24,
            sessionid: loginSessionId(rec.pending),
            value: buildNativeLogonLookupCommand(),
        });
        if (sent) state.nativeLogonLookupAt = Date.now();
        return sent;
    }
    function requestLogonStart(nodeId, agent) {
        const rec = loginData.nodes[nodeId];
        if (!rec || !rec.pending) return false;
        const users = runtimeUsers[nodeId] || [];
        if (!users.length) return false;
        const state = loginRuntimeState(nodeId);
        const sent = sendAgent(agent, {
            action: 'runcommands', type: 2, runAsUser: 0, reply: true,
            responseid: 'usagectl-logon-time', sessionid: loginSessionId(rec.pending),
            cmds: buildLogonLookupCommand(users),
        });
        if (sent) {
            state.logonLookupAt = Date.now();
            state.logonLookupAttempts = Number(state.logonLookupAttempts || 0) + 1;
        }
        return sent;
    }
    function useLogonLookupFallback(nodeId, reason) {
        const rec = loginData.nodes[nodeId];
        if (!rec || !rec.pending || rec.pending.logonSource) return;
        rec.pending.logonSource = 'meshagent-session';
        rec.pending.logonFailure = reason || 'unavailable';
        loginRuntimeState(nodeId).logonLookupFailed = true;
        saveLoginSoon();
    }
    function pollLogin(nodeId, agent, force) {
        const rec = loginData.nodes[nodeId];
        const pending = rec && rec.pending;
        if (!pending) return;
        if (!runtimeSessionIds[nodeId] && Array.isArray(pending.sessionIds) && pending.sessionIds.length) {
            runtimeSessionIds[nodeId] = pending.sessionIds.slice();
        }
        const now = Date.now();
        const state = loginRuntimeState(nodeId);
        if (!pending.logonSource) {
            const nativeAt = Number(state.nativeLogonLookupAt || 0);
            if (!nativeAt) {
                requestNativeLogonStart(nodeId, agent);
                return;
            }
            if (!state.nativeLogonLookupCompletedAt && now - nativeAt < LOGIN_NATIVE_LOOKUP_TIMEOUT_MS) return;
            const attempts = Number(state.logonLookupAttempts || 0);
            const lookupAt = Number(state.logonLookupAt || 0);
            if (!lookupAt || (now - lookupAt >= LOGIN_LOOKUP_TIMEOUT_MS && attempts < LOGIN_LOOKUP_MAX_ATTEMPTS)) {
                requestLogonStart(nodeId, agent);
                return;
            }
            if (now - lookupAt < LOGIN_LOOKUP_TIMEOUT_MS) return;
            useLogonLookupFallback(nodeId, 'timeout');
        }
        if (!force && Number(loginPollAt[nodeId]) + LOGIN_POLL_MS > now) return;
        const sessionid = loginSessionId(pending);
        if (!runtimeSessionIds[nodeId]) {
            sendAgent(agent, { action: 'msg', type: 'userSessions', sessionid });
        }
        if (sendAgent(agent, { action: 'msg', type: 'ps', sessionid })) {
            loginPollAt[nodeId] = now;
            state.lastPollAt = now;
        }
    }
    function pollPendingLogins() {
        const online = obj.meshServer.webserver && obj.meshServer.webserver.wsagents;
        if (!online) return;
        Object.keys(loginData.nodes).forEach(nodeId => {
            const rec = loginData.nodes[nodeId];
            if (rec && rec.pending && online[nodeId]) pollLogin(nodeId, online[nodeId], false);
        });
    }
    function startLoginAttempt(nodeId, meshId, users, agent, atMs, userDisplays) {
        if (!nodeId) return;
        const rec = loginNodeRecord(nodeId, meshId);
        if (rec.pending) return;
        const now = Number.isFinite(atMs) ? atMs : Date.now();
        const displays = loginUserDisplays(userDisplays, loginUserKeys(users));
        rec.pending = {
            attemptId: now,
            detectedAt: now,
            startAt: now,
            username: loginUserDisplay((displays.length ? displays : loginUserDisplays(users)).join(', ')) || null,
        };
        runtimeUsers[nodeId] = loginUserKeys(users);
        runtimeExplorerCandidates[nodeId] = Object.create(null);
        runtimeLoginState[nodeId] = {};
        pruneLoginRecord(rec, now);
        saveLoginSoon();
        pollLogin(nodeId, agent, true);
    }
    function finishLoginAttempt(nodeId, readyAt, status) {
        const rec = loginData.nodes[nodeId];
        if (!rec || !rec.pending) return;
        const startAt = Number(rec.pending.startAt);
        const endAt = Number.isFinite(readyAt) ? readyAt : Date.now();
        rec.events.push([startAt, endAt, Math.max(0, endAt - startAt), status || 'ready',
            rec.pending.logonSource || 'meshagent-session', rec.pending.logonFailure || null,
            loginUserDisplay(rec.pending.username) || null]);
        delete rec.pending;
        delete loginPollAt[nodeId];
        delete runtimeSessionIds[nodeId];
        delete runtimeExplorerCandidates[nodeId];
        delete runtimeLoginState[nodeId];
        pruneLoginRecord(rec, endAt);
        saveLoginSoon();
    }
    function isExplorerValue(value) {
        const text = String(value || '').trim().toLowerCase();
        if (!text) return false;
        // System.Diagnostics.Process.ProcessName renvoie souvent « explorer »
        // sans extension, tandis que cmd/path contiennent explorer.exe.
        return /(^|[\\/])explorer(?:\.exe)?(?=$|[\s"',])/.test(text);
    }
    function isLoginBlockerValue(value) {
        const text = String(value || '').trim().toLowerCase();
        if (!text) return false;
        // Explorer peut démarrer alors que Windows affiche encore
        // « Bienvenue ». LogonUI porte cet écran et userinit exécute encore
        // l'initialisation de la session avant de rendre le bureau utilisable.
        return /(^|[\\/])(?:logonui|userinit)(?:\.exe)?(?=$|[\s"',])/.test(text);
    }
    function explorerProcess(command) {
        const v = (command && command.value && typeof command.value === 'object') ? command.value : {};
        return [v.processName, v.ProcessName, v.name, v.Name, v.cmd, v.Cmd, v.path, v.Path,
            v.executablePath, v.ExecutablePath].some(isExplorerValue);
    }
    function processInfoUser(command) {
        const v = (command && command.value && typeof command.value === 'object') ? command.value : {};
        if (v.userName || v.UserName) return loginUserKey(v.userName || v.UserName);
        const user = v.processUser || v.ProcessUser;
        const domain = v.processDomain || v.ProcessDomain;
        if (user) return loginUserKey((domain ? domain + '\\' : '') + user);
        return '';
    }
    function handleLoginAgentMessage(command, agent) {
        if (!command || command.action !== 'msg' || typeof command.sessionid !== 'string' ||
            command.sessionid.indexOf(LOGIN_SESSION_ID + ':') !== 0) return false;
        const nodeId = agent && agent.dbNodeKey;
        const rec = nodeId && loginData.nodes[nodeId];
        if (!rec || !rec.pending || command.sessionid !== loginSessionId(rec.pending)) return true;

        if (command.type === 'console') {
            const state = loginRuntimeState(nodeId);
            state.nativeLogonLookupCompletedAt = Date.now();
            let sessions = null;
            try { sessions = JSON.parse(String(command.value || '')); } catch (_) {}
            const wanted = runtimeUsers[nodeId] || [];
            const detectedAt = Number(rec.pending.detectedAt || rec.pending.startAt);
            let best = null;
            (Array.isArray(sessions) ? sessions : []).forEach(s => {
                if (!s) return;
                const owner = loginUserKey((s.Domain ? s.Domain + '\\' : '') + (s.Username || ''));
                const eventAt = Number(s.LogonTime);
                const inputAt = Number(s.LastInputTime);
                if (wanted.length && owner && wanted.indexOf(owner) < 0) return;
                if (!Number.isFinite(eventAt) || eventAt < detectedAt - LOGIN_LOGON_LOOKBACK_MS || eventAt > detectedAt + 5 * 60000) return;
                const inputReliable = Number.isFinite(inputAt) && inputAt > 0 &&
                    inputAt >= detectedAt - LOGIN_LOGON_LOOKBACK_MS && inputAt <= eventAt + 1000;
                if (!best || eventAt > best.eventAt) {
                    best = {
                        eventAt,
                        startAt: inputReliable ? inputAt : eventAt,
                        source: inputReliable ? 'windows-wts-input' : 'windows-wts-session',
                        sessionId: Number(s.SessionId),
                        username: loginUserDisplay(s),
                    };
                }
            });
            if (best) {
                rec.pending.startAt = best.startAt;
                rec.pending.logonSource = best.source;
                if (best.username) rec.pending.username = best.username;
                if (Number.isFinite(best.sessionId)) {
                    runtimeSessionIds[nodeId] = [best.sessionId];
                    rec.pending.sessionIds = [best.sessionId];
                }
                state.logonLookupCompletedAt = Date.now();
                delete state.logonLookupFailed;
                saveLoginSoon();
                pollLogin(nodeId, agent, true);
            } else if (!state.logonLookupAt) {
                // Ancien MeshAgent ou API WTS indisponible : conserver le
                // chemin PowerShell comme secours, sans attendre 5 secondes.
                requestLogonStart(nodeId, agent);
            }
            return true;
        }

        if (command.type === 'runcommands') {
            const result = String(command.result || '');
            const match = result.match(/USAGECTL_LOGON_(CIM|EVENT)=([^\r\n]+)/);
            const eventAt = match ? new Date(match[2].trim()).getTime() : NaN;
            const detectedAt = Number(rec.pending.detectedAt || rec.pending.startAt);
            if (Number.isFinite(eventAt) && eventAt >= detectedAt - LOGIN_LOGON_LOOKBACK_MS && eventAt <= detectedAt + 5 * 60000) {
                rec.pending.startAt = eventAt;
                rec.pending.logonSource = match[1] === 'CIM' ? 'windows-logon-session' : 'windows-event-4624';
                const state = loginRuntimeState(nodeId);
                state.logonLookupCompletedAt = Date.now();
                delete state.logonLookupFailed;
                saveLoginSoon();
            } else {
                useLogonLookupFallback(nodeId, result.indexOf('USAGECTL_LOGON_ERROR') >= 0 ? 'command-error' : 'not-found');
            }
            pollLogin(nodeId, agent, true);
            return true;
        }

        if (command.type === 'userSessions') {
            loginRuntimeState(nodeId).lastAgentReplyAt = Date.now();
            const wanted = runtimeUsers[nodeId] || [];
            const ids = [];
            (Array.isArray(command.data) ? command.data : []).forEach(s => {
                if (!s || s.SessionId == null) return;
                const state = String(s.State || '').toLowerCase();
                if (state && state !== 'active' && state !== 'connected') return;
                const owner = loginUserKey((s.Domain ? s.Domain + '\\' : '') + (s.Username || ''));
                if (wanted.length && owner && wanted.indexOf(owner) < 0) return;
                const username = loginUserDisplay(s);
                if (username) rec.pending.username = username;
                const id = Number(s.SessionId);
                if (Number.isFinite(id) && ids.indexOf(id) < 0) ids.push(id);
            });
            if (ids.length) {
                runtimeSessionIds[nodeId] = ids;
                rec.pending.sessionIds = ids.slice();
                saveLoginSoon();
            }
            return true;
        }

        if (command.type === 'ps') {
            const replyAt = Date.now();
            const state = loginRuntimeState(nodeId);
            state.lastAgentReplyAt = replyAt;
            state.lastProcessReplyAt = replyAt;
            let processes = null;
            try { processes = (typeof command.value === 'string') ? JSON.parse(command.value) : command.value; } catch (_) {}
            if (!processes || typeof processes !== 'object') return true;
            const wanted = runtimeUsers[nodeId] || [];
            const candidates = [];
            let blockerCount = 0;
            Object.keys(processes).forEach(pid => {
                const p = processes[pid];
                if (!p || typeof p !== 'object') return;
                const cmd = p.cmd || p.name || p.path;
                if (isLoginBlockerValue(cmd)) blockerCount++;
                if (!isExplorerValue(cmd)) return;
                const owner = loginUserKey(p.user);
                candidates.push({ pid, owner });
            });
            const matching = candidates.filter(p => !p.owner || !wanted.length || wanted.indexOf(p.owner) >= 0);
            const remembered = runtimeExplorerCandidates[nodeId] = Object.create(null);
            const hasExplorer = (matching.length ? matching : candidates).length > 0;
            if (!hasExplorer || blockerCount > 0) {
                state.desktopReadyConfirmations = 0;
                delete state.desktopReadySince;
            } else {
                state.desktopReadyConfirmations = Number(state.desktopReadyConfirmations || 0) + 1;
                if (!state.desktopReadySince) state.desktopReadySince = replyAt;
            }
            state.loginBlockerPresent = blockerCount > 0;
            const desktopReady = hasExplorer && blockerCount === 0 && state.desktopReadyConfirmations >= 2;
            (matching.length ? matching : candidates).forEach(p => {
                remembered[String(p.pid)] = { owner: p.owner, seenAt: replyAt, desktopReady, readyAt: replyAt };
                sendAgent(agent, { action: 'msg', type: 'psinfo', pid: p.pid, sessionid: command.sessionid });
            });
            if (Object.keys(remembered).length) state.explorerSeenAt = replyAt;
            else delete state.explorerSeenAt;
            return true;
        }

        if (command.type === 'psinfo') {
            const candidates = runtimeExplorerCandidates[nodeId] || {};
            const candidate = candidates[String(command.pid)];
            if (!candidate && !explorerProcess(command)) return true;
            // Explorer seul ne suffit pas : Windows peut l'avoir lancé en
            // arrière-plan alors que l'écran de connexion est encore visible.
            if (!candidate || !candidate.desktopReady) return true;
            const replyAt = Date.now();
            const state = loginRuntimeState(nodeId);
            state.lastAgentReplyAt = replyAt;
            state.lastProcessInfoAt = replyAt;
            const wanted = runtimeUsers[nodeId] || [];
            const owner = processInfoUser(command) || (candidate && candidate.owner) || '';
            if (owner && wanted.length && wanted.indexOf(owner) < 0) return true;
            const v = command.value || {};
            const processSessionId = Number(v.sessionId != null ? v.sessionId : v.SessionId);
            const wantedSessions = runtimeSessionIds[nodeId] || [];
            if (Number.isFinite(processSessionId) && wantedSessions.length && wantedSessions.indexOf(processSessionId) < 0) return true;
            const rawStart = command.value && (command.value.startTime || command.value.StartTime || command.value.creationDate);
            const processStart = rawStart ? new Date(rawStart).getTime() : NaN;
            const attemptStart = Number(rec.pending.startAt);
            const readyStatus = rec.pending.logonSource === 'meshagent-session' ? 'start-unavailable' : 'ready';
            // Une petite tolérance couvre le délai entre la création très rapide
            // de la session et l'arrivée du coreinfo sur le serveur.
            if (Number.isFinite(processStart) && processStart >= attemptStart - 30000 && processStart <= Date.now() + 5000) {
                finishLoginAttempt(nodeId, Math.max(attemptStart, Number(candidate.readyAt) || replyAt), readyStatus);
            } else {
                // Certains MeshAgent Windows confirment explorer mais ne donnent
                // pas startTime. Une identité ou une session concordante suffit
                // alors ; l'instant de détection est précis à LOGIN_POLL_MS près.
                const ownerMatches = !!(owner && wanted.length && wanted.indexOf(owner) >= 0);
                const sessionMatches = Number.isFinite(processSessionId) && wantedSessions.indexOf(processSessionId) >= 0;
                if (ownerMatches || sessionMatches) {
                    const readyAt = Number(candidate.readyAt);
                    finishLoginAttempt(nodeId, Number.isFinite(readyAt) ? readyAt : replyAt, readyStatus);
                }
            }
            return true;
        }
        return true;
    }

    // Reçoit les changements de session immédiatement depuis MeshAgent.
    obj.hook_processAgentData = function (command, agent) {
        try {
            if (handleLoginAgentMessage(command, agent)) return;
            if (!command || command.action !== 'coreinfo' || !Array.isArray(command.users)) return;
            const count = uniqueUserCount(command.users);
            if (count == null) return;
            const nodeId = agent && agent.dbNodeKey;
            const meshId = agent && agent.dbMeshKey;
            const nextUsers = loginUserKeys(command.users);
            const nextUserDisplays = loginUserDisplays(command.users);
            const previousUsers = nodeId ? runtimeUsers[nodeId] : null;
            runtimeUsers[nodeId] = nextUsers;
            if (previousUsers) {
                const addedUsers = nextUsers.filter(u => previousUsers.indexOf(u) < 0);
                const loginRec = loginData.nodes[nodeId];
                if (loginRec && loginRec.pending && nextUsers.length === 0) {
                    finishLoginAttempt(nodeId, Date.now(), 'session-ended');
                } else if (addedUsers.length > 0 && isWindowsAgent(agent, command)) {
                    startLoginAttempt(nodeId, meshId, addedUsers, agent, Date.now(), nextUserDisplays);
                }
            } else {
                const loginRec = nodeId && loginData.nodes[nodeId];
                if (loginRec && loginRec.pending) pollLogin(nodeId, agent, true);
            }
            recordPresence(nodeId, meshId, count, Date.now());
        } catch (_) {}
    };

    // Ferme la présence lors d'une déconnexion agent. Cela évite qu'une session
    // restée ouverte au moment d'un arrêt soit comptée après l'extinction du PC.
    obj.HandleEvent = function (_source, event) {
        try {
            if (!event) return;
            if (event.action === 'nodeconnect' && event.nodeid &&
                (((event.conn != null) && ((Number(event.conn) & 1) === 0)) ||
                 ((event.pwr != null) && Number(event.pwr) === 0))) {
                recordPresence(event.nodeid, event.meshid, 0, Date.now());
                finishLoginAttempt(event.nodeid, Date.now(), 'agent-offline');
                delete runtimeUsers[event.nodeid];
                delete runtimeSessionIds[event.nodeid];
            } else if (event.action === 'stopped') {
                const now = Date.now();
                Object.keys(presence.nodes).forEach(id => {
                    const rec = presenceRecord(id);
                    if (rec && Number(rec.events[rec.events.length - 1][1]) > 0) recordPresence(id, rec.meshid, 0, now);
                });
                savePresenceNow();
                saveLoginNow();
                if (obj.meshServer.__usagectlLoginPollTimer) {
                    clearInterval(obj.meshServer.__usagectlLoginPollTimer);
                    obj.meshServer.__usagectlLoginPollTimer = null;
                }
            }
        } catch (_) {}
    };

    obj.server_startup = function () {
        try {
            // Un rechargement à chaud du plugin ne doit pas laisser l'ancienne
            // instance abonnée aux événements.
            const old = obj.meshServer.__usagectlPresenceListener;
            if (old && old !== obj && typeof obj.meshServer.RemoveAllEventDispatch === 'function') {
                obj.meshServer.RemoveAllEventDispatch(old);
            }
            if (typeof obj.meshServer.AddEventDispatch === 'function') obj.meshServer.AddEventDispatch(['*'], obj);
            obj.meshServer.__usagectlPresenceListener = obj;

            // Une seule boucle de surveillance, même après un rechargement à
            // chaud du plugin. Elle ne sonde que les postes dont la connexion
            // Windows est encore en cours, sans limite de durée.
            if (obj.meshServer.__usagectlLoginPollTimer) clearInterval(obj.meshServer.__usagectlLoginPollTimer);
            obj.meshServer.__usagectlLoginPollTimer = setInterval(pollPendingLogins, LOGIN_POLL_MS);
            if (typeof obj.meshServer.__usagectlLoginPollTimer.unref === 'function') obj.meshServer.__usagectlLoginPollTimer.unref();

            // Fermer d'abord les états éventuellement restés ouverts après un
            // arrêt brutal, puis amorcer TOUS les nœuds. Sans cet amorçage, seuls
            // les agents qui changent de session après le chargement du plugin
            // apparaissent comme suivis dans l'interface MeshCentral.
            const now = Date.now();
            Object.keys(presence.nodes).forEach(id => {
                const rec = presenceRecord(id);
                if (rec && Number(rec.events[rec.events.length - 1][1]) > 0) recordPresence(id, rec.meshid, 0, now);
            });
            const db = obj.meshServer.db;
            const online = obj.meshServer.webserver && obj.meshServer.webserver.wsagents;
            if (db && typeof db.GetAllType === 'function') {
                db.GetAllType('node', function (_err, nodes) {
                    (nodes || []).forEach(n => {
                        if (!n || !n._id) return;
                        const recent = presenceRecord(n._id);
                        // Ne pas écraser un coreinfo arrivé pendant la lecture DB.
                        if (recent && Number(recent.lastSeenAt) > now) return;
                        const isOnline = !!(online && online[n._id]);
                        // Une liste absente ne prouve pas une présence. On part
                        // donc de zéro jusqu'au prochain coreinfo de l'agent.
                        const count = (isOnline && Array.isArray(n.users)) ? uniqueUserCount(n.users) : 0;
                        if (isOnline && Array.isArray(n.users)) runtimeUsers[n._id] = loginUserKeys(n.users);
                        recordPresence(n._id, n.meshid, count == null ? 0 : count, Date.now());
                        if (isOnline && loginData.nodes[n._id] && loginData.nodes[n._id].pending) {
                            pollLogin(n._id, online[n._id], true);
                        }
                    });
                });
            }
        } catch (_) {}
    };

    // ============ Job en cours (pour barre de progression UI) ============
    let currentJob = null; // { kind, weekKey, processed, total, startedAt }

    // ============ Power timeline ============
    function powerNodeId(nodeId) {
        const s = String(nodeId || '');
        return s.indexOf('node//') === 0 ? s : ('node//' + s);
    }
    function getPowerTimeline(nodeId, oldestMs, cb) {
        try {
            const db = obj.meshServer && obj.meshServer.db;
            const coll = db && (db.powerfile || db.eventsfile);
            if (!coll || typeof coll.find !== 'function') return cb(new Error('powerfile indisponible'), []);
            const q = { nodeid: powerNodeId(nodeId), time: { $gte: new Date(oldestMs) } };
            const cur = coll.find(q);
            const sorted = (typeof cur.sort === 'function') ? cur.sort({ time: 1 }) : cur;
            const r = sorted.toArray();
            if (r && typeof r.then === 'function') {
                r.then(d => cb(null, d || []), e => cb(e, []));
            } else {
                try { sorted.toArray((e, d) => cb(e, d || [])); } catch (e) { cb(e, []); }
            }
        } catch (e) { cb(e, []); }
    }

    // ============ Fenêtres temporelles ============
    // 50 buckets 1h (Lun-Ven × 8h-18h), index = dayIdx*10 + (hour-8)
    function buildSchoolHourBuckets(monMs) {
        const out = [];
        const d0 = new Date(monMs); d0.setHours(0, 0, 0, 0);
        for (let day = 0; day < 5; day++) {
            for (let h = 8; h < 18; h++) {
                const a = new Date(d0); a.setDate(a.getDate() + day); a.setHours(h, 0, 0, 0);
                const b = new Date(a); b.setHours(h + 1, 0, 0, 0);
                out.push([a.getTime(), b.getTime()]);
            }
        }
        return out;
    }
    // Tout sauf Lun-Ven 8h-18h dans la semaine [monMs, monMs+7j]
    function buildOffHoursWindows(monMs) {
        const out = [];
        const d0 = new Date(monMs); d0.setHours(0, 0, 0, 0);
        for (let day = 0; day < 7; day++) {
            const dayStart = new Date(d0); dayStart.setDate(dayStart.getDate() + day);
            const dow = dayStart.getDay();
            const dayStartMs = dayStart.getTime();
            const dayEndMs = dayStartMs + 86400000;
            if (dow >= 1 && dow <= 5) {
                const e1 = new Date(dayStart); e1.setHours(8, 0, 0, 0);
                const s2 = new Date(dayStart); s2.setHours(18, 0, 0, 0);
                out.push([dayStartMs, e1.getTime()]);
                out.push([s2.getTime(), dayEndMs]);
            } else {
                out.push([dayStartMs, dayEndMs]);
            }
        }
        return out.filter(w => w[1] > w[0]);
    }
    function buildSchoolWindowsRange(start, end) {
        const out = [];
        const d0 = new Date(start); d0.setHours(0, 0, 0, 0);
        for (let t = d0.getTime(); t < end; t += 86400000) {
            const d = new Date(t); const dow = d.getDay();
            if (dow < 1 || dow > 5) continue;
            const ws = new Date(d); ws.setHours(8, 0, 0, 0);
            const we = new Date(d); we.setHours(18, 0, 0, 0);
            const a = Math.max(ws.getTime(), start), b = Math.min(we.getTime(), end);
            if (b > a) out.push([a, b]);
        }
        return out;
    }
    function totalMsW(W) { let s = 0; for (let i = 0; i < W.length; i++) s += W[i][1] - W[i][0]; return s; }
    function intersectSum(a, b, W) {
        let s = 0;
        for (let i = 0; i < W.length; i++) {
            const x = Math.max(a, W[i][0]), y = Math.min(b, W[i][1]);
            if (y > x) s += y - x;
        }
        return s;
    }
    function sortEvents(events) {
        events.sort((a, b) => {
            const ta = (a.time instanceof Date) ? a.time.getTime() : Number(a.time);
            const tb = (b.time instanceof Date) ? b.time.getTime() : Number(b.time);
            return ta - tb;
        });
    }
    function computeOnInWindows(events, start, end, windows) {
        sortEvents(events);
        let on = 0, curState = null, curStart = start;
        function add(from, to) {
            if (to <= from) return;
            on += windows ? intersectSum(from, to, windows) : (to - from);
        }
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            const t = (e.time instanceof Date) ? e.time.getTime() : Number(e.time);
            const p = (e.power !== undefined) ? Number(e.power) : Number(e.p);
            if (isNaN(t) || isNaN(p)) continue;
            if (t < start) { curState = p; continue; }
            if (t > end) break;
            if (curState === 1) add(curStart, t);
            curState = p; curStart = t;
        }
        if (curState === 1) add(curStart, end);
        return on;
    }
    // Per-bucket on time (1 pass per bucket — buckets sont disjoints donc l'état initial se recalcule).
    function computeBuckets(events, buckets, limitEnd) {
        sortEvents(events);
        const out = new Array(buckets.length).fill(0);
        for (let i = 0; i < buckets.length; i++) {
            const start = buckets[i][0];
            const end = Math.min(buckets[i][1], Number.isFinite(limitEnd) ? limitEnd : buckets[i][1]);
            if (end <= start) continue;
            let on = 0, curState = null, curStart = start;
            for (let j = 0; j < events.length; j++) {
                const e = events[j];
                const t = (e.time instanceof Date) ? e.time.getTime() : Number(e.time);
                const p = (e.power !== undefined) ? Number(e.power) : Number(e.p);
                if (isNaN(t) || isNaN(p)) continue;
                if (t <= start) { curState = p; continue; }
                if (t >= end) break;
                if (curState === 1) on += t - curStart;
                curState = p; curStart = t;
            }
            if (curState === 1) on += end - curStart;
            out[i] = on;
        }
        return out;
    }

    // ============ Pool de workers (concurrence limitée) ============
    function runPool(items, concurrency, worker, done) {
        if (!items.length) return done();
        let idx = 0, active = 0, finished = 0;
        function spawn() {
            while (active < concurrency && idx < items.length) {
                const i = idx++;
                active++;
                let settled = false;
                const t = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    active--; finished++;
                    if (finished === items.length) done();
                    else spawn();
                }, NODE_TIMEOUT_MS);
                try {
                    worker(items[i], i, function () {
                        if (settled) return;
                        settled = true;
                        clearTimeout(t);
                        active--; finished++;
                        if (finished === items.length) done();
                        else spawn();
                    });
                } catch (_) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(t);
                    active--; finished++;
                    if (finished === items.length) done();
                    else spawn();
                }
            }
        }
        spawn();
    }

    // ============ Calcul + persistance d'une semaine ============
    function computeWeek(weekKey, force, cb) {
        const existing = cache.weeks[weekKey];
        if (existing && !force) {
            const now = Date.now();
            if (existing.permanent || (now - (existing.computedAt || 0) < CACHE_TTL_LIVE_MS)) {
                return cb(null, existing);
            }
        }
        if (currentJob) return cb(new Error('Calcul déjà en cours'), null);

        const p = weekKey.split('-').map(Number);
        const mon = mondayOf(new Date(p[0], p[1] - 1, p[2]));
        const monMs = mon.getTime();
        const sat = new Date(mon); sat.setDate(sat.getDate() + 5);
        const weekEndMs = sat.getTime();
        const nowMs = Date.now();
        const effectiveEnd = Math.min(weekEndMs, nowMs);
        const isPermanent = (weekEndMs <= nowMs);

        const buckets = buildSchoolHourBuckets(monMs);
        const offWindows = buildOffHoursWindows(monMs)
            .map(w => [w[0], Math.min(w[1], effectiveEnd)])
            .filter(w => w[1] > w[0]);

        const totalSchoolMs = buckets.reduce((s, b) => {
            const e = Math.min(b[1], effectiveEnd);
            return s + Math.max(0, e - b[0]);
        }, 0);
        const totalOffMs = totalMsW(offWindows);

        const db = obj.meshServer.db;
        db.GetAllType('mesh', function (e1, meshDocs) {
            if (e1) { currentJob = null; return cb(e1, null); }
            const meshNames = {};
            const excludedIds = new Set();
            (meshDocs || []).forEach(m => {
                if (m && m._id) {
                    meshNames[m._id] = m.name || m._id;
                    if (isExcludedMesh(m.name)) excludedIds.add(m._id);
                }
            });
            db.GetAllType('node', function (e2, nodes) {
                if (e2) { currentJob = null; return cb(e2, null); }
                const allNodes = (nodes || []).filter(n => n && n._id && n.meshid && !excludedIds.has(n.meshid));
                currentJob = { kind: 'week', weekKey, processed: 0, total: allNodes.length, startedAt: Date.now() };
                const nodesByMesh = {};
                runPool(allNodes, CONCURRENCY, function (n, _i, doneOne) {
                    getPowerTimeline(n._id, monMs, function (_err, ev) {
                        try {
                            const events = ev || [];
                            const hasData = events.length > 0;
                            const powerBuckets = hasData ? computeBuckets(events, buckets, effectiveEnd) : new Array(50).fill(0);
                            const offOn = hasData ? computeOnInWindows(events, monMs, effectiveEnd, offWindows) : 0;
                            const occupiedBuckets = computeBuckets(presenceEvents(n._id), buckets, effectiveEnd);
                            const observedBuckets = coverageBuckets(n._id, buckets, effectiveEnd);
                            const hasPresenceData = sumArr(observedBuckets) > 0;
                            if (!nodesByMesh[n.meshid]) nodesByMesh[n.meshid] = [];
                            nodesByMesh[n.meshid].push({
                                id: n._id, name: n.name || n._id, os: n.osdesc || '',
                                meshid: n.meshid,
                                // `buckets` reste l'occupation principale pour
                                // compatibilité avec les réponses historiques.
                                buckets: occupiedBuckets,
                                observedBuckets,
                                powerBuckets,
                                offMs: offOn,
                                hasData: hasPresenceData,
                                hasPresenceData,
                                hasPowerData: hasData,
                            });
                        } catch (_) {}
                        if (currentJob) currentJob.processed++;
                        doneOne();
                    });
                }, function () {
                    const out = {
                        weekKey, monMs, weekEndMs, effectiveEnd,
                        totalSchoolMs, totalOffMs,
                        computedAt: Date.now(),
                        permanent: isPermanent,
                        meshNames, nodesByMesh,
                    };
                    cache.weeks[weekKey] = out;
                    saveCache();
                    currentJob = null;
                    cb(null, out);
                });
            });
        });
    }

    // ============ Réponses dérivées du cache semaine ============
    function weekLabel(data) {
        const d = new Date(data.monMs);
        const f = new Date(d); f.setDate(f.getDate() + 4);
        return 'Lun ' + fmtDM(d) + ' → Ven ' + fmtDM(f);
    }
    function prevWeekKey(weekKey) {
        const p = weekKey.split('-').map(Number);
        const d = mondayOf(new Date(p[0], p[1] - 1, p[2]));
        d.setDate(d.getDate() - 7);
        return fmtIso(d);
    }
    function sallesFromWeek(data) {
        const tSchool = data.totalSchoolMs || 1;
        const meshIds = Object.keys(data.nodesByMesh);
        return meshIds.map(mid => {
            const nodes = data.nodesByMesh[mid];
            const withData = nodes.filter(n => n.hasPresenceData || n.hasData);
            const withPower = nodes.filter(n => n.hasPowerData || (!n.hasPresenceData && n.hasData));
            const sumOccupied = withData.reduce((s, n) => s + sumArr(n.buckets || []), 0);
            const sumObserved = withData.reduce((s, n) => s + sumArr(n.observedBuckets || []), 0);
            const avgOccupied = withData.length ? sumOccupied / withData.length : 0;
            const sumPower = withPower.reduce((s, n) => s + sumArr(n.powerBuckets || []), 0);
            const avgPower = withPower.length ? sumPower / withPower.length : 0;
            return {
                meshid: mid,
                name: data.meshNames[mid] || mid,
                nodes: nodes.length,
                nodesWithData: withData.length,
                nodesWithPowerData: withPower.length,
                avgOnPct: sumObserved ? Math.round((sumOccupied / sumObserved * 100) * 10) / 10 : 0,
                avgOnMinutes: Math.round(avgOccupied / 60000),
                avgObservedMinutes: withData.length ? Math.round((sumObserved / withData.length) / 60000) : null,
                avgPowerPct: withPower.length ? Math.round((avgPower / tSchool * 100) * 10) / 10 : null,
                avgPowerMinutes: withPower.length ? Math.round(avgPower / 60000) : null,
            };
        }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
    }

    function respondWeek(action, req, res, data) {
        const tSchool = data.totalSchoolMs || 1;
        const tOff = data.totalOffMs || 1;
        const lbl = weekLabel(data);

        if (action === 'salles') {
            const requestedMeshId = String(req.query.meshid || '').trim();
            const salles = sallesFromWeek(data).filter(s => !requestedMeshId || s.meshid === requestedMeshId);
            // Delta vs semaine précédente si déjà en cache (lecture seule)
            const prevKey = prevWeekKey(data.weekKey);
            const prev = cache.weeks[prevKey];
            if (prev) {
                const prevByMesh = {};
                sallesFromWeek(prev).forEach(s => { prevByMesh[s.meshid] = s.avgOnPct; });
                salles.forEach(s => {
                    if (prevByMesh[s.meshid] != null) {
                        s.prevPct = prevByMesh[s.meshid];
                        // Variation relative en % (ex : 40% → 51% → +27.5%)
                        if (s.prevPct > 0) {
                            s.deltaRel = Math.round(((s.avgOnPct - s.prevPct) / s.prevPct * 100) * 10) / 10;
                        } else if (s.avgOnPct > 0) {
                            s.deltaRel = null; // partait de 0 → infini, on n'affiche rien
                            s.deltaFromZero = true;
                        } else {
                            s.deltaRel = 0;
                        }
                    }
                });
            }
            return sendJson(res, 200, {
                salles, weekMode: true, weekLabel: lbl,
                totalMinutes: Math.round(tSchool / 60000), days: 7,
                cachedAt: data.computedAt, permanent: data.permanent,
                prevWeekAvailable: !!prev,
                presenceSince: presenceSinceMs(), metric: 'loggedInSessions',
            });
        }

        if (action === 'salleDetail') {
            const mid = String(req.query.meshid || '');
            const nodes = (data.nodesByMesh[mid] || []).map(n => {
                const occupied = sumArr(n.buckets || []);
                const observed = sumArr(n.observedBuckets || []);
                const power = sumArr(n.powerBuckets || []);
                const hasPresence = observed > 0;
                const hasPower = n.hasPowerData || (!n.hasPresenceData && n.hasData);
                return {
                    id: n.id, name: n.name, os: n.os,
                    hasData: hasPresence,
                    onPct: hasPresence ? Math.round((occupied / observed * 100) * 10) / 10 : null,
                    onMinutes: hasPresence ? Math.round(occupied / 60000) : null,
                    observedMinutes: hasPresence ? Math.round(observed / 60000) : null,
                    powerPct: hasPower ? Math.round((power / tSchool * 100) * 10) / 10 : null,
                    powerMinutes: hasPower ? Math.round(power / 60000) : null,
                    offMinutes: hasPower ? Math.round(n.offMs / 60000) : null,
                };
            }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
            return sendJson(res, 200, {
                meshid: mid, nodes, weekMode: true, weekLabel: lbl,
                totalMinutes: Math.round(tSchool / 60000), days: 7,
                presenceSince: presenceSinceMs(), metric: 'loggedInSessions',
            });
        }

        if (action === 'heatmap') {
            const mid = String(req.query.meshid || 'all');
            let nodes = [];
            if (mid === 'all') {
                Object.keys(data.nodesByMesh).forEach(k => { nodes = nodes.concat(data.nodesByMesh[k]); });
            } else {
                nodes = data.nodesByMesh[mid] || [];
            }
            const withData = nodes.filter(n => n.hasPresenceData || n.hasData);
            const grid = new Array(50).fill(null);
            const observedGrid = new Array(50).fill(0);
            if (withData.length) {
                for (let b = 0; b < 50; b++) {
                    let occupied = 0, observed = 0;
                    for (let i = 0; i < withData.length; i++) {
                        occupied += (withData[i].buckets || [])[b] || 0;
                        observed += (withData[i].observedBuckets || [])[b] || 0;
                    }
                    observedGrid[b] = observed;
                    grid[b] = observed ? Math.round((occupied / observed * 100) * 10) / 10 : null;
                }
            }
            const sallesList = Object.keys(data.nodesByMesh).map(k => ({ meshid: k, name: data.meshNames[k] || k }))
                .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
            return sendJson(res, 200, {
                grid, weekLabel: lbl, meshid: mid,
                meshName: (mid === 'all') ? 'Tous les postes' : (data.meshNames[mid] || mid),
                nodesCount: withData.length, observedGrid, salles: sallesList,
                presenceSince: presenceSinceMs(), metric: 'loggedInSessions',
            });
        }

        if (action === 'horsHeures') {
            const mid = String(req.query.meshid || 'all');
            let nodes = [];
            if (mid === 'all') {
                Object.keys(data.nodesByMesh).forEach(k => {
                    data.nodesByMesh[k].forEach(n => { nodes.push(Object.assign({}, n, { meshName: data.meshNames[k] || k })); });
                });
            } else {
                (data.nodesByMesh[mid] || []).forEach(n => nodes.push(Object.assign({}, n, { meshName: data.meshNames[mid] || mid })));
            }
            const list = nodes.filter(n => n.hasPowerData || (!n.hasPresenceData && n.hasData)).map(n => ({
                id: n.id, name: n.name, mesh: n.meshName,
                offMinutes: Math.round(n.offMs / 60000),
                offPct: Math.round((n.offMs / tOff * 100) * 10) / 10,
            })).sort((a, b) => b.offMinutes - a.offMinutes);
            const sallesList = Object.keys(data.nodesByMesh).map(k => ({ meshid: k, name: data.meshNames[k] || k }))
                .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
            return sendJson(res, 200, {
                nodes: list, totalOffMinutes: Math.round(tOff / 60000), weekLabel: lbl,
                salles: sallesList, meshid: mid,
            });
        }

        if (action === 'topPostes') {
            const all = [];
            const requestedMeshId = String(req.query.meshid || '').trim();
            Object.keys(data.nodesByMesh).forEach(k => {
                if (requestedMeshId && k !== requestedMeshId) return;
                data.nodesByMesh[k].forEach(n => {
                    const observed = sumArr(n.observedBuckets || []);
                    if (!observed) return;
                    const on = sumArr(n.buckets || []);
                    all.push({
                        id: n.id, name: n.name, mesh: data.meshNames[k] || k,
                        onMinutes: Math.round(on / 60000),
                        observedMinutes: Math.round(observed / 60000),
                        onPct: Math.round((on / observed * 100) * 10) / 10,
                    });
                });
            });
            all.sort((a, b) => b.onMinutes - a.onMinutes);
            return sendJson(res, 200, {
                top: all.slice(0, 10),
                bottom: all.slice(-10).reverse(),
                weekLabel: lbl,
                totalMinutes: Math.round(tSchool / 60000),
            });
        }

        return sendJson(res, 404, { error: 'action inconnue: ' + action });
    }

    function parseLocalDateOnly(value) {
        const text = String(value || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
        const p = text.split('-').map(Number);
        const date = new Date(p[0], p[1] - 1, p[2]);
        if (date.getFullYear() !== p[0] || date.getMonth() !== p[1] - 1 || date.getDate() !== p[2]) return null;
        date.setHours(0, 0, 0, 0);
        return date;
    }

    function requestedPeriod(req) {
        const fromText = String(req.query.from || '').trim();
        const toText = String(req.query.to || '').trim();
        const now = Date.now();
        if (fromText || toText) {
            const from = parseLocalDateOnly(fromText);
            const to = parseLocalDateOnly(toText);
            if (!from || !to) throw new Error('Les dates de début et de fin sont requises au format AAAA-MM-JJ.');
            const inclusiveDays = Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86400000) + 1;
            if (inclusiveDays < 1) throw new Error('La date de fin doit être postérieure ou égale à la date de début.');
            if (inclusiveDays > CUSTOM_RANGE_MAX_DAYS) throw new Error('La période personnalisée est limitée à ' + CUSTOM_RANGE_MAX_DAYS + ' jours.');
            const endExclusive = new Date(to); endExclusive.setDate(endExclusive.getDate() + 1);
            const end = Math.min(endExclusive.getTime(), now);
            if (from.getTime() >= end) throw new Error('La période sélectionnée ne contient encore aucune heure écoulée.');
            return {
                start: from.getTime(), end,
                days: inclusiveDays, customRange: true,
                label: fmtDMY(from) + ' → ' + fmtDMY(to),
            };
        }
        const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 7));
        return {
            start: now - days * 86400000, end: now,
            days, customRange: false,
            label: days === 1 ? '24 dernières heures' : days + ' derniers jours',
        };
    }

    // ============ Période glissante ou dates précises (sans cache) ============
    function rollingHandler(action, req, res) {
        let period;
        try { period = requestedPeriod(req); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
        const start = period.start;
        const end = period.end;
        const days = period.days;
        const schoolHours = req.query.schoolHours !== '0';
        const windows = schoolHours ? buildSchoolWindowsRange(start, end) : null;
        const totalMs = schoolHours ? totalMsW(windows) : (end - start);
        const totalDivisor = totalMs || 1;

        const db = obj.meshServer.db;
        if (action === 'salles') {
            db.GetAllType('mesh', function (e1, meshDocs) {
                if (e1) return sendJson(res, 500, { error: e1.message });
                const meshNames = {};
                const excludedIds = new Set();
                (meshDocs || []).forEach(m => {
                    if (m && m._id) {
                        meshNames[m._id] = m.name || m._id;
                        if (isExcludedMesh(m.name)) excludedIds.add(m._id);
                    }
                });
                db.GetAllType('node', function (e2, nodes) {
                    if (e2) return sendJson(res, 500, { error: e2.message });
                    const requestedMeshId = String(req.query.meshid || '').trim();
                    const allNodes = (nodes || []).filter(n => n && n._id && n.meshid && !excludedIds.has(n.meshid) && (!requestedMeshId || n.meshid === requestedMeshId));
                    currentJob = { kind: 'rolling', processed: 0, total: allNodes.length, startedAt: Date.now() };
                    const agg = {};
                    runPool(allNodes, CONCURRENCY, function (n, _i, doneOne) {
                        getPowerTimeline(n._id, start, function (_err, ev) {
                            if (!agg[n.meshid]) agg[n.meshid] = {
                                totalOccupied: 0, totalObserved: 0,
                                totalPowerOn: 0, nodes: 0, withData: 0, withPowerData: 0,
                            };
                            agg[n.meshid].nodes++;
                            const events = ev || [];
                            if (events.length) {
                                agg[n.meshid].withPowerData++;
                                try { agg[n.meshid].totalPowerOn += computeOnInWindows(events, start, end, windows); } catch (_) {}
                            }
                            const p = presenceInWindows(n._id, start, end, windows);
                            if (p.hasData) {
                                agg[n.meshid].withData++;
                                agg[n.meshid].totalOccupied += p.occupiedMs;
                                agg[n.meshid].totalObserved += p.coverageMs;
                            }
                            if (currentJob) currentJob.processed++;
                            doneOne();
                        });
                    }, function () {
                        currentJob = null;
                        const salles = Object.keys(agg).map(mid => {
                            const a = agg[mid];
                            const avgOccupied = a.withData ? a.totalOccupied / a.withData : 0;
                            const avgPower = a.withPowerData ? a.totalPowerOn / a.withPowerData : 0;
                            return {
                                meshid: mid, name: meshNames[mid] || mid,
                                nodes: a.nodes, nodesWithData: a.withData,
                                nodesWithPowerData: a.withPowerData,
                                avgOnPct: a.totalObserved ? Math.round((a.totalOccupied / a.totalObserved * 100) * 10) / 10 : 0,
                                avgOnMinutes: Math.round(avgOccupied / 60000),
                                avgObservedMinutes: a.withData ? Math.round((a.totalObserved / a.withData) / 60000) : null,
                                avgPowerPct: a.withPowerData ? Math.round((avgPower / totalDivisor * 100) * 10) / 10 : null,
                                avgPowerMinutes: a.withPowerData ? Math.round(avgPower / 60000) : null,
                            };
                        }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                        sendJson(res, 200, {
                            salles, days, totalMinutes: Math.round(totalMs / 60000), weekMode: false,
                            customRange: period.customRange, periodLabel: period.label,
                            rangeStart: start, rangeEnd: end, schoolHours,
                            presenceSince: presenceSinceMs(), metric: 'loggedInSessions',
                        });
                    });
                });
            });
            return;
        }
        if (action === 'salleDetail') {
            const meshid = String(req.query.meshid || '');
            db.GetAllType('node', function (e, nodes) {
                if (e) return sendJson(res, 500, { error: e.message });
                const list = (nodes || []).filter(n => n && n.meshid === meshid);
                const out = [];
                currentJob = { kind: 'rolling-detail', processed: 0, total: list.length, startedAt: Date.now() };
                runPool(list, CONCURRENCY, function (n, _i, doneOne) {
                    getPowerTimeline(n._id, start, function (_e, ev) {
                        const events = ev || [];
                        const hasPowerData = events.length > 0;
                        const powerOn = hasPowerData ? computeOnInWindows(events, start, end, windows) : 0;
                        const p = presenceInWindows(n._id, start, end, windows);
                        out.push({
                            id: n._id, name: n.name || n._id, os: n.osdesc || '',
                            hasData: p.hasData,
                            onPct: p.hasData ? Math.round((p.occupiedMs / p.coverageMs * 100) * 10) / 10 : null,
                            onMinutes: p.hasData ? Math.round(p.occupiedMs / 60000) : null,
                            observedMinutes: p.hasData ? Math.round(p.coverageMs / 60000) : null,
                            powerPct: hasPowerData ? Math.round((powerOn / totalDivisor * 100) * 10) / 10 : null,
                            powerMinutes: hasPowerData ? Math.round(powerOn / 60000) : null,
                        });
                        if (currentJob) currentJob.processed++;
                        doneOne();
                    });
                }, function () {
                    currentJob = null;
                    out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                    sendJson(res, 200, {
                        meshid, nodes: out, days, totalMinutes: Math.round(totalMs / 60000), weekMode: false,
                        customRange: period.customRange, periodLabel: period.label,
                        rangeStart: start, rangeEnd: end, schoolHours,
                        presenceSince: presenceSinceMs(), metric: 'loggedInSessions',
                    });
                });
            });
            return;
        }
        return sendJson(res, 404, { error: 'action inconnue (rolling): ' + action });
    }

    function loginRange(req) {
        if (String(req.query.from || '').trim() || String(req.query.to || '').trim()) {
            const period = requestedPeriod(req);
            return {
                start: period.start, end: period.end, weekMode: false,
                customRange: true, days: period.days, label: period.label,
            };
        }
        const ws = String(req.query.weekStart || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(ws)) {
            const p = ws.split('-').map(Number);
            const mon = mondayOf(new Date(p[0], p[1] - 1, p[2]));
            const end = new Date(mon); end.setDate(end.getDate() + 7);
            const fri = new Date(mon); fri.setDate(fri.getDate() + 4);
            return {
                start: mon.getTime(), end: end.getTime(), weekMode: true,
                label: 'Lun ' + fmtDM(mon) + ' → Ven ' + fmtDM(fri),
            };
        }
        let days = parseInt(req.query.days || '7', 10);
        if (![1, 7, 30, 70].includes(days)) days = 7;
        const end = Date.now();
        return { start: end - days * 86400000, end, weekMode: false, days, label: days + ' derniers jours' };
    }
    function isWindowsNode(n) {
        const id = n && n.agent && Number(n.agent.id);
        return !!(n && ((typeof n.osdesc === 'string' && /windows/i.test(n.osdesc)) ||
            (Number.isFinite(id) && ((id > 0 && id < 5) || (id > 41 && id < 44)))));
    }
    function respondLoginTimes(req, res) {
        const db = obj.meshServer.db;
        if (!db || typeof db.GetAllType !== 'function') return sendJson(res, 500, { error: 'base MeshCentral indisponible' });
        let range;
        try { range = loginRange(req); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
        const requestedMeshId = String(req.query.meshid || '').trim();
        db.GetAllType('mesh', function (e1, meshes) {
            if (e1) return sendJson(res, 500, { error: e1.message || String(e1) });
            const meshNames = {};
            const excluded = new Set();
            (meshes || []).forEach(m => {
                if (!m || !m._id) return;
                meshNames[m._id] = m.name || m._id;
                if (isExcludedMesh(m.name)) excluded.add(m._id);
            });
            db.GetAllType('node', function (e2, nodes) {
                if (e2) return sendJson(res, 500, { error: e2.message || String(e2) });
                const now = Date.now();
                const rows = (nodes || []).filter(n => n && n._id && !excluded.has(n.meshid) && isWindowsNode(n) && (!requestedMeshId || n.meshid === requestedMeshId)).map(n => {
                    const rec = loginData.nodes[n._id];
                    const events = (rec && Array.isArray(rec.events) ? rec.events : []).filter(e => {
                        const startAt = Number(e && e[0]);
                        return startAt >= range.start && startAt < range.end;
                    });
                    const completed = events.filter(e => e[3] === 'ready');
                    const failed = events.filter(e => e[3] !== 'ready');
                    const durations = completed.map(e => Number(e[2])).filter(Number.isFinite);
                    const durationTotalMs = durations.reduce((s, v) => s + v, 0);
                    const latest = completed.slice().sort((a, b) => Number(b[1]) - Number(a[1]))[0];
                    const pending = rec && rec.pending && Number(rec.pending.startAt) >= range.start && Number(rec.pending.startAt) < range.end
                        ? rec.pending : null;
                    const history = events.slice().sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, LOGIN_HISTORY_MAX_PER_NODE).map(e => {
                        const source = String(e[4] || 'meshagent-session');
                        return {
                            startAt: Number(e[0]), endAt: Number(e[1]), durationMs: Number(e[2]),
                            status: String(e[3] || 'unknown'), source,
                            startReliable: source !== 'meshagent-session',
                            failureReason: e[5] ? String(e[5]) : null,
                            username: e[6] ? loginUserDisplay(e[6]) : null,
                        };
                    });
                    if (pending) {
                        const source = String(pending.logonSource || '');
                        history.unshift({
                            startAt: Number(pending.startAt), endAt: null,
                            durationMs: Math.max(0, now - Number(pending.startAt)), status: 'pending', source,
                            startReliable: source && source !== 'meshagent-session',
                            failureReason: pending.logonFailure || null,
                            username: loginUserDisplay(pending.username) || null,
                        });
                    }
                    const pendingState = runtimeLoginState[n._id] || {};
                    let pendingStage = null;
                    if (pending) {
                        if (!pending.logonSource) pendingStage = 'waiting-logon-time';
                        else if (pendingState.loginBlockerPresent) pendingStage = 'waiting-windows-shell';
                        else if (Number(pendingState.desktopReadyConfirmations || 0) === 1) pendingStage = 'confirming-desktop';
                        else if (pendingState.explorerSeenAt) pendingStage = 'explorer-seen';
                        else if (pendingState.lastProcessReplyAt) pendingStage = 'waiting-explorer';
                        else if (pendingState.lastPollAt) pendingStage = 'waiting-agent';
                        else pendingStage = 'starting';
                    }
                    return {
                        id: n._id,
                        name: n.name || n._id,
                        meshid: n.meshid,
                        mesh: meshNames[n.meshid] || n.meshid || '',
                        lastMs: latest ? Number(latest[2]) : null,
                        lastAt: latest ? Number(latest[1]) : null,
                        avgMs: durations.length ? Math.round(durationTotalMs / durations.length) : null,
                        maxMs: durations.length ? Math.max.apply(null, durations) : null,
                        count: durations.length,
                        durationTotalMs,
                        failed: failed.length,
                        pendingStartedAt: pending ? Number(pending.startAt) : null,
                        pendingMs: pending ? Math.max(0, now - Number(pending.startAt)) : null,
                        pendingStage,
                        history,
                        historyCount: events.length + (pending ? 1 : 0),
                        historyTruncated: events.length > LOGIN_HISTORY_MAX_PER_NODE,
                    };
                }).sort((a, b) => {
                    if (a.pendingStartedAt && !b.pendingStartedAt) return -1;
                    if (!a.pendingStartedAt && b.pendingStartedAt) return 1;
                    return (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true });
                });
                const roomMap = Object.create(null);
                rows.forEach(row => {
                    const key = row.meshid || row.mesh || 'sans-salle';
                    let room = roomMap[key];
                    if (!room) {
                        room = roomMap[key] = {
                            id: key,
                            name: row.mesh || 'Sans salle',
                            totalMs: 0,
                            count: 0,
                            devicesWithMeasurements: 0,
                            devicesTotal: 0,
                        };
                    }
                    room.devicesTotal++;
                    room.totalMs += Number(row.durationTotalMs || 0);
                    room.count += Number(row.count || 0);
                    if (row.count > 0) room.devicesWithMeasurements++;
                });
                const roomStats = Object.keys(roomMap).map(key => {
                    const room = roomMap[key];
                    return {
                        id: room.id,
                        name: room.name,
                        avgMs: room.count ? Math.round(room.totalMs / room.count) : null,
                        count: room.count,
                        devicesWithMeasurements: room.devicesWithMeasurements,
                        devicesTotal: room.devicesTotal,
                    };
                }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                const globalTotalMs = rows.reduce((sum, row) => sum + Number(row.durationTotalMs || 0), 0);
                const globalCount = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
                const globalStats = {
                    avgMs: globalCount ? Math.round(globalTotalMs / globalCount) : null,
                    count: globalCount,
                    devicesWithMeasurements: roomStats.reduce((sum, room) => sum + room.devicesWithMeasurements, 0),
                    devicesTotal: rows.length,
                    roomsWithMeasurements: roomStats.filter(room => room.count > 0).length,
                    roomsTotal: roomStats.length,
                };
                sendJson(res, 200, {
                    rows, roomStats, globalStats, weekMode: range.weekMode, weekLabel: range.label, days: range.days,
                    customRange: !!range.customRange, periodLabel: range.label,
                    filteredMeshid: requestedMeshId || null,
                    measuredFrom: 'windows-last-input-or-interactive-logon', measuredUntil: 'confirmed-desktop', timeout: null,
                });
            });
        });
    }

    // ============ Routeur ============
    obj.handleAdminReq = function (req, res, user) {
        try { return _handle(req, res, user); }
        catch (e) { try { sendJson(res, 500, { error: 'usagectl: ' + (e && e.message) }); } catch (_) {} }
    };
    function _handle(req, res, user) {
        const action = String((req.query && req.query.action) || '');
        if (!action) return res.render(path.join(__dirname, 'views/usagectl'), { user });
        if (action === 'ping') return sendJson(res, 200, { ok: true, plugin: 'usagectl' });

        if (action === 'lib') {
            const name = String((req.query && req.query.name) || '');
            const allowed = { 'html2pdf': 'html2pdf.bundle.min.js' };
            const file = allowed[name];
            if (!file) { res.status(404).end('unknown lib'); return; }
            const p = path.join(__dirname, 'lib', file);
            try {
                const buf = fs.readFileSync(p);
                res.set('Content-Type', 'application/javascript; charset=utf-8');
                res.set('Cache-Control', 'public, max-age=86400');
                return res.end(buf);
            } catch (e) {
                res.status(500).end('lib read err: ' + e.message);
                return;
            }
        }

        if (action === 'progress') return sendJson(res, 200, currentJob || { idle: true });

        if (action === 'presenceStatus') {
            return sendJson(res, 200, {
                since: presenceSinceMs(),
                trackedNodes: Object.keys(presence.nodes).filter(id => presenceRecord(id)).length,
                retentionDays: PRESENCE_RETENTION_DAYS,
                metric: 'loggedInSessions',
            });
        }

        if (action === 'loginTimes') return respondLoginTimes(req, res);

        if (action === 'invalidate') {
            const wk = String(req.query.weekStart || '').trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(wk)) {
                const p = wk.split('-').map(Number);
                const key = fmtIso(mondayOf(new Date(p[0], p[1] - 1, p[2])));
                invalidateWeek(key);
                return sendJson(res, 200, { ok: true, invalidated: key });
            }
            // Full flush
            cache.weeks = {}; saveCache();
            return sendJson(res, 200, { ok: true, invalidated: 'all' });
        }

        if (action === 'cacheStatus') {
            const weeks = Object.keys(cache.weeks).map(k => ({
                weekKey: k,
                permanent: !!cache.weeks[k].permanent,
                computedAt: cache.weeks[k].computedAt,
                nodes: Object.values(cache.weeks[k].nodesByMesh).reduce((s, a) => s + a.length, 0),
            })).sort((a, b) => a.weekKey < b.weekKey ? 1 : -1);
            return sendJson(res, 200, { weeks });
        }

        if (action === 'dataRange') {
            const db = obj.meshServer.db;
            const coll = db.powerfile || db.eventsfile;
            const pMin = presenceSinceMs();
            if (!coll || typeof coll.aggregate !== 'function') {
                return sendJson(res, 200, { min: pMin, max: null, presenceMin: pMin, powerMin: null });
            }
            Promise.resolve(coll.aggregate([{ $group: { _id: null, min: { $min: '$time' }, max: { $max: '$time' } } }]).toArray()).then(r => {
                const row = (r && r[0]) || {};
                sendJson(res, 200, {
                    // La métrique principale est désormais la présence humaine.
                    min: pMin, max: row.max || null,
                    presenceMin: pMin, powerMin: row.min || null,
                });
            }).catch(e => sendJson(res, 500, { error: e.message }));
            return;
        }

        const wsParam = String(req.query.weekStart || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(wsParam)) {
            const p = wsParam.split('-').map(Number);
            const monKey = fmtIso(mondayOf(new Date(p[0], p[1] - 1, p[2])));
            const force = req.query.force === '1';
            computeWeek(monKey, force, function (err, data) {
                if (err) return sendJson(res, 500, { error: err.message });
                return respondWeek(action, req, res, data);
            });
            return;
        }

        if (action === 'salles' || action === 'salleDetail') return rollingHandler(action, req, res);

        return sendJson(res, 404, { error: 'action inconnue: ' + action });
    }

    return obj;
};
