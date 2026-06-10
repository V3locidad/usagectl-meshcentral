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

    function _runFind(coll, query, sortSpec, limit, cb) {
        try {
            let cur = coll.find(query);
            if (sortSpec && typeof cur.sort === 'function') cur = cur.sort(sortSpec);
            if (limit && typeof cur.limit === 'function') cur = cur.limit(limit);
            const arr = cur.toArray();
            if (arr && typeof arr.then === 'function') {
                arr.then(function (docs) { try { cb(null, docs || []); } catch (_) {} },
                         function (err) { try { cb(err, []); } catch (_) {} });
            } else {
                try { cur.toArray(function (err, docs) { try { cb(err, docs || []); } catch (_) {} }); }
                catch (e) { try { cb(e, []); } catch (_) {} }
            }
        } catch (e) { try { cb(e, []); } catch (_) {} }
    }

    // Récupère :
    //  - le dernier event power *avant* oldestTime (pour seed curState)
    //  - les events power dans [oldestTime, +∞[
    // Concatène le seed en tête (curStart sera correctement initialisé).
    function getPowerTimeline(nodeId, oldestTime, cb) {
        try {
            const db = obj.meshServer && obj.meshServer.db;
            const coll = db && (db.powerfile || db.eventsfile);
            if (!coll || typeof coll.find !== 'function') {
                return cb(new Error('db.powerfile indisponible'), []);
            }
            const oldestDate = new Date(oldestTime);
            _runFind(coll, { nodeid: nodeId, time: { $lt: oldestDate } }, { time: -1 }, 1, function (e1, seed) {
                _runFind(coll, { nodeid: nodeId, time: { $gte: oldestDate } }, { time: 1 }, 0, function (e2, recent) {
                    const out = (seed || []).concat(recent || []);
                    cb(e2 || e1 || null, out);
                });
            });
        } catch (e) {
            try { cb(e, []); } catch (_) {}
        }
    }

    // Construit la liste des créneaux scolaires [ts_start, ts_end] dans
    // [start, end] : Lun-Ven 8h-18h (heures locales du serveur).
    function buildSchoolWindows(start, end) {
        const out = [];
        const d0 = new Date(start);
        d0.setHours(0, 0, 0, 0);
        for (let t = d0.getTime(); t < end; t += 86400000) {
            const d = new Date(t);
            const dow = d.getDay();          // 0=dim, 1=lun, ..., 6=sam
            if (dow < 1 || dow > 5) continue;
            const ws = new Date(d); ws.setHours(8, 0, 0, 0);
            const we = new Date(d); we.setHours(18, 0, 0, 0);
            const a = Math.max(ws.getTime(), start);
            const b = Math.min(we.getTime(), end);
            if (b > a) out.push([a, b]);
        }
        return out;
    }

    function totalWindowsMs(windows) {
        let s = 0;
        for (let i = 0; i < windows.length; i++) s += windows[i][1] - windows[i][0];
        return s;
    }

    function intersectSum(a, b, windows) {
        let s = 0;
        for (let i = 0; i < windows.length; i++) {
            const ws = windows[i][0], we = windows[i][1];
            const x = Math.max(a, ws);
            const y = Math.min(b, we);
            if (y > x) s += y - x;
        }
        return s;
    }

    // Durée allumée (power=1) dans [start, end], restreinte aux créneaux
    // scolaires (Lun-Ven 8h-18h). Si windows est null → mode 24/7.
    function computeOnTimeMs(events, start, end, windows) {
        let on = 0;
        let curState = null;
        let curStart = start;
        events.sort(function (a, b) {
            const ta = (a.time instanceof Date) ? a.time.getTime() : Number(a.time);
            const tb = (b.time instanceof Date) ? b.time.getTime() : Number(b.time);
            return ta - tb;
        });
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
            curState = p;
            curStart = t;
        }
        if (curState === 1) add(curStart, end);
        return on;
    }

    obj.handleAdminReq = function (req, res, user) {
        try {
            return _handleAdminReq(req, res, user);
        } catch (e) {
            try { sendJson(res, 500, { error: 'usagectl: ' + (e && e.message) }); } catch (_) {}
        }
    };
    function _handleAdminReq(req, res, user) {
        const action = String((req.query && req.query.action) || '');
        if (!action) return res.render(path.join(__dirname, 'views/usagectl'), { user: user });

        if (action === 'ping') return sendJson(res, 200, { ok: true, plugin: 'usagectl' });

        if (action === 'debug') {
            // Inspecte ce qui est exposé par MC pour la power timeline et
            // remonte un échantillon brut sur un node.
            const db = obj.meshServer.db;
            const nodeId = String(req.query.nodeId || '');
            const oldest = Date.now() - 7 * 86400000;
            const info = { dbType: db.databaseType };
            if (!nodeId) return sendJson(res, 200, info);
            // Plusieurs queries pour identifier le bon schéma.
            info.hasPowerfile = !!(db && db.powerfile);
            const coll = db.powerfile || db.eventsfile;
            const queries = [
                { coll: 'powerfile', label: 'powerfile sample', q: {}, limit: 5 },
                { coll: 'powerfile', label: 'powerfile nodeid=X', q: { nodeid: nodeId }, limit: 5 },
                { coll: 'powerfile', label: 'powerfile nodeid=X time>=oldest(ms)', q: { nodeid: nodeId, time: { $gte: oldest } }, limit: 5 },
                { coll: 'powerfile', label: 'powerfile nodeid=X time>=oldest(date)', q: { nodeid: nodeId, time: { $gte: new Date(oldest) } }, limit: 5 },
            ];
            info.tries = [];
            let qi = 0;
            function nextQ() {
                if (qi >= queries.length) return sendJson(res, 200, info);
                const t = queries[qi++];
                try {
                    const targetColl = (t.coll === 'powerfile' ? db.powerfile : db.eventsfile);
                    if (!targetColl) { info.tries.push({ label: t.label, error: 'collection absente' }); return nextQ(); }
                    let cur = targetColl.find(t.q);
                    if (t.limit && typeof cur.limit === 'function') cur = cur.limit(t.limit);
                    const arr = cur.toArray();
                    if (arr && typeof arr.then === 'function') {
                        arr.then(function (docs) {
                            info.tries.push({ label: t.label, count: (docs || []).length, sample: (docs || []).slice(0, 3) });
                            nextQ();
                        }, function (err) {
                            info.tries.push({ label: t.label, error: err && err.message });
                            nextQ();
                        });
                    } else {
                        info.tries.push({ label: t.label, error: 'toArray non-promise' });
                        nextQ();
                    }
                } catch (e) {
                    info.tries.push({ label: t.label, error: e.message });
                    nextQ();
                }
            }
            nextQ();
            return;
        }

        // Deux modes :
        //  - ?weekStart=YYYY-MM-DD  → semaine précise (Lun→Ven 8h-18h), 1 semaine fixée
        //  - sinon ?days=N         → période glissante des N derniers jours
        // Rétention : 10 semaines max en arrière.
        let start, now = Date.now();
        let days;
        let schoolHours;
        let windows;
        let totalMs;
        const weekStart = String(req.query.weekStart || '').trim();
        let weekMode = false;
        let weekLabel = '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
            const parts = weekStart.split('-').map(Number);
            // Force le lundi de la semaine ISO indiquée (la date envoyée doit
            // déjà être un lundi côté UI, mais on re-normalise par sécurité).
            const d = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
            const dow = d.getDay(); // 0=dim
            const offsetToMonday = (dow === 0 ? -6 : 1 - dow);
            d.setDate(d.getDate() + offsetToMonday);
            // Rejette les semaines > 10 en arrière (rétention).
            const monMs = d.getTime();
            const tenWeeksAgo = (function () {
                const t = new Date(); t.setHours(0, 0, 0, 0);
                const dow2 = t.getDay();
                t.setDate(t.getDate() + (dow2 === 0 ? -6 : 1 - dow2)); // lundi courant
                t.setDate(t.getDate() - 9 * 7); // 10 semaines incluant celle-ci = 9 semaines avant la courante
                return t.getTime();
            })();
            if (monMs < tenWeeksAgo) return sendJson(res, 400, { error: 'semaine hors rétention (10 semaines max)' });
            start = monMs;
            // Fin = samedi 00:00 (couvre Lun→Ven inclus). buildSchoolWindows
            // restreint déjà à Lun-Ven 8h-18h.
            const endDate = new Date(d); endDate.setDate(endDate.getDate() + 5);
            const endMs = endDate.getTime();
            now = Math.min(now, endMs); // ne calcule pas au-delà de "maintenant" (semaine en cours)
            schoolHours = true;
            windows = buildSchoolWindows(start, endMs);
            totalMs = totalWindowsMs(windows);
            days = 7;
            weekMode = true;
            const fri = new Date(d); fri.setDate(fri.getDate() + 4);
            weekLabel = 'Lun ' + fmtDM(d) + ' → Ven ' + fmtDM(fri);
        } else {
            days = Math.max(1, Math.min(70, parseInt(req.query.days, 10) || 7));
            start = now - days * 86400000;
            schoolHours = req.query.schoolHours !== '0';
            windows = schoolHours ? buildSchoolWindows(start, now) : null;
            totalMs = schoolHours ? totalWindowsMs(windows) : (now - start);
        }
        function fmtDM(d) {
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            return dd + '/' + mm;
        }

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
                                avgOnMinutes: meshTotals[mid].nodes ? Math.round(meshTotals[mid].totalOn / meshTotals[mid].nodes / 60000) : 0,
                            }));
                            out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                            return sendJson(res, 200, { salles: out, days: days, totalMinutes: Math.round(totalMs / 60000), weekMode: weekMode, weekLabel: weekLabel });
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
                                    const on = computeOnTimeMs(ev || [], start, now, windows);
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
                        return sendJson(res, 200, { meshid: meshid, days: days, nodes: out, totalMinutes: Math.round(totalMs / 60000), weekMode: weekMode, weekLabel: weekLabel });
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
                            const on = computeOnTimeMs(ev || [], start, now, windows);
                            out.push({
                                id: n._id,
                                name: n.name || n._id,
                                os: n.osdesc || '',
                                onPct: Math.round((on / totalMs * 100) * 10) / 10,
                                onMinutes: Math.round(on / 60000),
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
    }

    return obj;
};
