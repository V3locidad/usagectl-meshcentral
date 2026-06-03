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
        if (typeof db.GetPowerTimelineByNode === 'function') {
            db.GetPowerTimelineByNode(nodeId, oldestTime, function (err, docs) {
                cb(err, docs || []);
            });
            return;
        }
        // Fallback : query directe sur les events power.
        // En NeDB et MongoDB, l'API db.eventsfile.find existe.
        try {
            const q = { etype: 'power', nodeid: nodeId, time: { $gte: oldestTime } };
            // MC stocke parfois sous l'attribut "power" et parfois "p" — on
            // ne projette pas pour rester portable.
            if (db.eventsfile && typeof db.eventsfile.find === 'function') {
                const cur = db.eventsfile.find(q);
                if (typeof cur.sort === 'function') cur.sort({ time: 1 });
                cur.toArray(function (e2, docs) { cb(e2, docs || []); });
                return;
            }
        } catch (_) {}
        cb(new Error('API power timeline indisponible'), []);
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

        const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
        const now = Date.now();
        const start = now - days * 86400000;
        const totalMs = now - start;

        if (action === 'salles') {
            // Liste des salles avec leur taux d'occupation moyen (% du temps
            // pendant lequel les postes sont allumés, moyenné sur n postes).
            const db = obj.meshServer.db;
            db.GetAllType('mesh', function (e1, meshDocs) {
                if (e1) return sendJson(res, 500, { error: e1.message });
                const meshById = {};
                (meshDocs || []).forEach((m) => { if (m && m._id) meshById[m._id] = m.name || m._id; });
                db.GetAllType('node', function (e2, nodes) {
                    if (e2) return sendJson(res, 500, { error: e2.message });
                    // Groupe les nodes par meshid
                    const byMesh = {};
                    (nodes || []).forEach((n) => {
                        if (!n || !n._id || !n.meshid) return;
                        if (!byMesh[n.meshid]) byMesh[n.meshid] = [];
                        byMesh[n.meshid].push(n);
                    });
                    const meshIds = Object.keys(byMesh);
                    const out = [];
                    let i = 0;
                    function nextMesh() {
                        if (i >= meshIds.length) {
                            out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                            return sendJson(res, 200, { salles: out, days: days });
                        }
                        const mid = meshIds[i++];
                        const nodesInMesh = byMesh[mid];
                        let totalOn = 0, processed = 0;
                        if (!nodesInMesh.length) {
                            out.push({ meshid: mid, name: meshById[mid] || mid, nodes: 0, avgOnPct: 0 });
                            return nextMesh();
                        }
                        nodesInMesh.forEach(function (n) {
                            getPowerTimeline(n._id, start, function (_e, ev) {
                                const on = computeOnTimeMs(ev || [], start, now);
                                totalOn += on;
                                processed++;
                                if (processed === nodesInMesh.length) {
                                    const avgPct = (totalOn / (nodesInMesh.length * totalMs)) * 100;
                                    out.push({
                                        meshid: mid,
                                        name: meshById[mid] || mid,
                                        nodes: nodesInMesh.length,
                                        avgOnPct: Math.round(avgPct * 10) / 10,
                                        avgOnHoursPerDay: Math.round((totalOn / nodesInMesh.length / 86400000 * 24 / days) * 10) / 10,
                                    });
                                    nextMesh();
                                }
                            });
                        });
                    }
                    nextMesh();
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
                let processed = 0;
                if (!list.length) return sendJson(res, 200, { meshid: meshid, days: days, nodes: [] });
                list.forEach(function (n) {
                    getPowerTimeline(n._id, start, function (_e, ev) {
                        const on = computeOnTimeMs(ev || [], start, now);
                        out.push({
                            id: n._id,
                            name: n.name || n._id,
                            os: n.osdesc || '',
                            onPct: Math.round((on / totalMs * 100) * 10) / 10,
                            onHoursPerDay: Math.round((on / 86400000 * 24 / days) * 10) / 10,
                        });
                        processed++;
                        if (processed === list.length) {
                            out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                            sendJson(res, 200, { meshid: meshid, days: days, nodes: out });
                        }
                    });
                });
            });
            return;
        }

        return sendJson(res, 404, { error: 'action inconnue: ' + action });
    };

    return obj;
};
