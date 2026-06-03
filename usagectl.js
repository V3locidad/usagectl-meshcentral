/*
 * usagectl — Taux d'occupation des postes par salle sur N derniers jours.
 *
 * On lit la power timeline de MeshCentral (events etype='power') pour calculer
 * la durée pendant laquelle chaque poste a été power=1 (en ligne / sous tension).
 * Agrégation : par salle (mesh).
 *
 * Aucun agent module — tout est calculé côté serveur depuis la DB MC.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function sendJson(res, code, obj) {
    try { res.status(code).set('Content-Type', 'application/json').end(JSON.stringify(obj)); }
    catch (e) {}
}

module.exports.usagectl = function (parent) {
    const obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.exports = [];

    // Lit la timeline d'un seul node : essaie d'abord l'API native MC
    // (db.GetPowerTimelineByNode si elle existe), sinon fallback sur une
    // query directe des events.
    function getPowerTimeline(nodeId, oldestTime, cb) {
        const db = obj.meshServer.db;
        // MC expose getPowerTimeline(nodeid, oldestTime, lastSampleTime, func).
        if (typeof db.getPowerTimeline === 'function') {
            db.getPowerTimeline(nodeId, oldestTime, Date.now(), function (err, docs) {
                cb(err, docs || []);
            });
            return;
        }
        cb(new Error('db.getPowerTimeline indisponible'), []);
    }

    // Calcule la durée (ms) passée à power=1 dans [start, end] à partir d'une
    // série triée d'events { time, power }.
    function computeOnTimeMs(events, start, end) {
        let on = 0;
        let curState = null;
        let curStart = start;
        // events triés par time croissant
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            const t = (e.time instanceof Date) ? e.time.getTime() : Number(e.time);
            const p = (e.power !== undefined) ? Number(e.power) : Number(e.p);
            if (isNaN(t) || isNaN(p)) continue;
            if (t < start) { curState = p; continue; }
            if (t > end) break;
            if (curState === 1) on += (t - curStart);
            curState = p;
            curStart = t;
        }
        if (curState === 1) on += (end - curStart);
        return on;
    }

    obj.handleAdminReq = function (req, res, user) {
        const action = String((req.query && req.query.action) || '');
        if (!action) return res.render(path.join(__dirname, 'views/usagectl'), { user: user });

        if (action === 'ping') return sendJson(res, 200, { ok: true, plugin: 'usagectl' });

        if (action === 'debug') {
            // Inspecte ce qui est exposé par MC pour la power timeline et
            // remonte un échantillon brut sur un node.
            const db = obj.meshServer.db;
            const nodeId = String(req.query.nodeId || '');
            const oldest = Date.now() - 7 * 86400000;
            const info = {
                hasGetPowerTimeline: typeof db.getPowerTimeline === 'function',
                dbType: db.databaseType,
            };
            if (!nodeId) return sendJson(res, 200, info);
            if (typeof db.getPowerTimeline === 'function') {
                db.getPowerTimeline(nodeId, oldest, Date.now(), function (err, docs) {
                    info.timelineErr = err && err.message;
                    info.timelineCount = (docs || []).length;
                    info.timelineSample = (docs || []).slice(0, 10);
                    sendJson(res, 200, info);
                });
                return;
            }
            return sendJson(res, 200, info);
        }

        const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
        const now = Date.now();
        const start = now - days * 86400000;
        const totalMs = now - start;

        if (action === 'salles') {
            // Sérialisation totale : un seul getPowerTimeline en cours à la
            // fois pour éviter de saturer MC sur des centaines de postes.
            const db = obj.meshServer.db;
            db.GetAllType('mesh', function (e1, meshDocs) {
                if (e1) return sendJson(res, 500, { error: e1.message });
                const meshById = {};
                (meshDocs || []).forEach((m) => { if (m && m._id) meshById[m._id] = m.name || m._id; });
                db.GetAllType('node', function (e2, nodes) {
                    if (e2) return sendJson(res, 500, { error: e2.message });
                    const byMesh = {};
                    (nodes || []).forEach((n) => {
                        if (!n || !n._id || !n.meshid) return;
                        if (!byMesh[n.meshid]) byMesh[n.meshid] = [];
                        byMesh[n.meshid].push(n);
                    });
                    const meshIds = Object.keys(byMesh);
                    const meshTotals = {};   // meshid -> { totalOn, nodes }
                    meshIds.forEach((mid) => { meshTotals[mid] = { totalOn: 0, nodes: byMesh[mid].length }; });
                    const allNodes = (nodes || []).filter((n) => n && n._id && n.meshid);
                    let idx = 0;
                    let aborted = false;
                    function nextNode() {
                        if (aborted) return;
                        if (idx >= allNodes.length) {
                            const out = meshIds.map((mid) => ({
                                meshid: mid,
                                name: meshById[mid] || mid,
                                nodes: meshTotals[mid].nodes,
                                avgOnPct: meshTotals[mid].nodes ? Math.round(((meshTotals[mid].totalOn / (meshTotals[mid].nodes * totalMs)) * 100) * 10) / 10 : 0,
                                avgOnHoursPerDay: meshTotals[mid].nodes ? Math.round((meshTotals[mid].totalOn / meshTotals[mid].nodes / 86400000 * 24 / days) * 10) / 10 : 0,
                            }));
                            out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                            return sendJson(res, 200, { salles: out, days: days });
                        }
                        const n = allNodes[idx++];
                        let done = false;
                        const guard = setTimeout(() => {
                            if (done) return;
                            done = true;
                            // Node skip silencieux en cas de hang DB.
                            setImmediate(nextNode);
                        }, 5000);
                        try {
                            getPowerTimeline(n._id, start, function (_err, ev) {
                                if (done) return;
                                done = true;
                                clearTimeout(guard);
                                try {
                                    const on = computeOnTimeMs(ev || [], start, now);
                                    if (meshTotals[n.meshid]) meshTotals[n.meshid].totalOn += on;
                                } catch (_) {}
                                setImmediate(nextNode);
                            });
                        } catch (e) {
                            if (done) return;
                            done = true;
                            clearTimeout(guard);
                            setImmediate(nextNode);
                        }
                    }
                    nextNode();
                });
            });
            return;
        }

        if (action === 'salleDetail') {
            const meshid = String(req.query.meshid || '');
            if (!meshid) return sendJson(res, 400, { error: 'meshid requis' });
            const db = obj.meshServer.db;
            db.GetAllType('node', function (e2, nodes) {
                if (e2) return sendJson(res, 500, { error: e2.message });
                const list = (nodes || []).filter((n) => n && n.meshid === meshid);
                const out = [];
                if (!list.length) return sendJson(res, 200, { meshid: meshid, days: days, nodes: [] });
                let idx = 0;
                function nextNode() {
                    if (idx >= list.length) {
                        out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                        return sendJson(res, 200, { meshid: meshid, days: days, nodes: out });
                    }
                    const n = list[idx++];
                    let done = false;
                    const guard = setTimeout(() => {
                        if (done) return;
                        done = true;
                        out.push({ id: n._id, name: n.name || n._id, os: n.osdesc || '', onPct: 0, onHoursPerDay: 0, error: 'timeout' });
                        setImmediate(nextNode);
                    }, 5000);
                    try {
                        getPowerTimeline(n._id, start, function (_e, ev) {
                            if (done) return;
                            done = true;
                            clearTimeout(guard);
                            const on = computeOnTimeMs(ev || [], start, now);
                            out.push({
                                id: n._id,
                                name: n.name || n._id,
                                os: n.osdesc || '',
                                onPct: Math.round((on / totalMs * 100) * 10) / 10,
                                onHoursPerDay: Math.round((on / 86400000 * 24 / days) * 10) / 10,
                            });
                            setImmediate(nextNode);
                        });
                    } catch (e) {
                        if (done) return;
                        done = true;
                        clearTimeout(guard);
                        out.push({ id: n._id, name: n.name || n._id, os: n.osdesc || '', onPct: 0, onHoursPerDay: 0, error: e.message });
                        setImmediate(nextNode);
                    }
                }
                nextNode();
            });
            return;
        }

        return sendJson(res, 404, { error: 'action inconnue: ' + action });
    };

    return obj;
};
