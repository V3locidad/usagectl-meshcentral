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

const CACHE_VERSION = 4;
const CACHE_FILE = path.join(__dirname, 'usagectl-cache.json');
const PRESENCE_VERSION = 1;
const PRESENCE_FILE = path.join(__dirname, 'usagectl-presence.json');
const PRESENCE_RETENTION_DAYS = 400;
const PRESENCE_SAVE_DELAY_MS = 1000;
const CACHE_TTL_LIVE_MS = 5 * 60 * 1000;
const CACHE_MAX_WEEKS = 20;
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

    // Reçoit les changements de session immédiatement depuis MeshAgent.
    obj.hook_processAgentData = function (command, agent) {
        try {
            if (!command || command.action !== 'coreinfo' || !Array.isArray(command.users)) return;
            const count = uniqueUserCount(command.users);
            if (count == null) return;
            recordPresence(agent && agent.dbNodeKey, agent && agent.dbMeshKey, count, Date.now());
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
            } else if (event.action === 'stopped') {
                const now = Date.now();
                Object.keys(presence.nodes).forEach(id => {
                    const rec = presenceRecord(id);
                    if (rec && Number(rec.events[rec.events.length - 1][1]) > 0) recordPresence(id, rec.meshid, 0, now);
                });
                savePresenceNow();
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

            // Fermer d'abord les états éventuellement restés ouverts après un
            // arrêt brutal, puis réamorcer les agents en ligne depuis le nœud DB.
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
                        if (n && n._id && online && online[n._id] && Array.isArray(n.users)) {
                            const count = uniqueUserCount(n.users);
                            if (count != null) recordPresence(n._id, n.meshid, count, Date.now());
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
            const salles = sallesFromWeek(data);
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
            Object.keys(data.nodesByMesh).forEach(k => {
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

    // ============ Rolling mode (sans cache) ============
    function rollingHandler(action, req, res) {
        const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 7));
        const now = Date.now();
        const start = now - days * 86400000;
        const schoolHours = req.query.schoolHours !== '0';
        const windows = schoolHours ? buildSchoolWindowsRange(start, now) : null;
        const totalMs = schoolHours ? totalMsW(windows) : (now - start);

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
                    const allNodes = (nodes || []).filter(n => n && n._id && n.meshid && !excludedIds.has(n.meshid));
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
                                try { agg[n.meshid].totalPowerOn += computeOnInWindows(events, start, now, windows); } catch (_) {}
                            }
                            const p = presenceInWindows(n._id, start, now, windows);
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
                                avgPowerPct: a.withPowerData ? Math.round((avgPower / totalMs * 100) * 10) / 10 : null,
                                avgPowerMinutes: a.withPowerData ? Math.round(avgPower / 60000) : null,
                            };
                        }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                        sendJson(res, 200, {
                            salles, days, totalMinutes: Math.round(totalMs / 60000), weekMode: false,
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
                        const powerOn = hasPowerData ? computeOnInWindows(events, start, now, windows) : 0;
                        const p = presenceInWindows(n._id, start, now, windows);
                        out.push({
                            id: n._id, name: n.name || n._id, os: n.osdesc || '',
                            hasData: p.hasData,
                            onPct: p.hasData ? Math.round((p.occupiedMs / p.coverageMs * 100) * 10) / 10 : null,
                            onMinutes: p.hasData ? Math.round(p.occupiedMs / 60000) : null,
                            observedMinutes: p.hasData ? Math.round(p.coverageMs / 60000) : null,
                            powerPct: hasPowerData ? Math.round((powerOn / totalMs * 100) * 10) / 10 : null,
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
                        presenceSince: presenceSinceMs(), metric: 'loggedInSessions',
                    });
                });
            });
            return;
        }
        return sendJson(res, 404, { error: 'action inconnue (rolling): ' + action });
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
