'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

function makeResponse() {
    let resolve;
    const done = new Promise(r => { resolve = r; });
    const res = {
        statusCode: null,
        headers: {},
        body: null,
        status(code) { this.statusCode = code; return this; },
        set(name, value) { this.headers[name] = value; return this; },
        end(body) { this.body = body; resolve(this); return this; },
        render() { throw new Error('render inattendu'); },
    };
    return { res, done };
}

test('calcule l occupation sur les sessions et conserve l allumage séparément', async t => {
    const realNow = Date.now;
    const realExistsSync = fs.existsSync;
    const realWriteFileSync = fs.writeFileSync;
    const realRenameSync = fs.renameSync;
    let now = new Date(2026, 7, 31, 8, 0, 0, 0).getTime(); // lundi 08:00
    const writes = {};

    Date.now = () => now;
    fs.existsSync = p => String(p).endsWith('usagectl-cache.json') || String(p).endsWith('usagectl-presence.json') || String(p).endsWith('usagectl-logins.json')
        ? false
        : realExistsSync(p);
    fs.writeFileSync = (p, data, ...args) => {
        if (String(p).endsWith('usagectl-cache.json') || String(p).endsWith('usagectl-presence.json.tmp') || String(p).endsWith('usagectl-logins.json.tmp')) {
            writes[String(p)] = String(data);
            return;
        }
        return realWriteFileSync(p, data, ...args);
    };
    fs.renameSync = (from, to) => {
        if (String(from).endsWith('usagectl-presence.json.tmp') && String(to).endsWith('usagectl-presence.json')) {
            writes[String(to)] = writes[String(from)];
            delete writes[String(from)];
            return;
        }
        if (String(from).endsWith('usagectl-logins.json.tmp') && String(to).endsWith('usagectl-logins.json')) {
            writes[String(to)] = writes[String(from)];
            delete writes[String(from)];
            return;
        }
        return realRenameSync(from, to);
    };
    t.after(() => {
        Date.now = realNow;
        fs.existsSync = realExistsSync;
        fs.writeFileSync = realWriteFileSync;
        fs.renameSync = realRenameSync;
    });

    const nodeId = 'node//test-node';
    const meshId = 'mesh//salle-a';
    const powerEvents = [
        { time: new Date(2026, 7, 31, 8, 0, 0, 0), power: 1 },
        { time: new Date(2026, 7, 31, 12, 0, 0, 0), power: 0 },
    ];
    const db = {
        GetAllType(type, cb) {
            if (type === 'mesh') return cb(null, [{ _id: meshId, name: 'Salle A' }]);
            if (type === 'node') return cb(null, [{ _id: nodeId, meshid: meshId, name: 'PC-01', osdesc: 'Windows' }]);
            return cb(null, []);
        },
        powerfile: {
            find() {
                return {
                    sort() {
                        return { toArray: () => Promise.resolve(powerEvents) };
                    },
                };
            },
        },
    };
    const meshServer = {
        db,
        webserver: { wsagents: {} },
        AddEventDispatch() {},
        RemoveAllEventDispatch() {},
    };
    const plugin = require('../usagectl').usagectl({ parent: meshServer });
    const sent = [];
    const agent = {
        dbNodeKey: nodeId,
        dbMeshKey: meshId,
        agentInfo: { agentId: 4 },
        send(data) { sent.push(JSON.parse(data)); },
    };

    // MeshCentral charge le plugin alors que les agents peuvent être déjà
    // connectés : tous les nœuds doivent être amorcés immédiatement.
    plugin.server_startup();
    plugin.hook_processAgentData({ action: 'coreinfo', users: [] }, agent);
    now = new Date(2026, 7, 31, 9, 0, 0, 0).getTime();
    plugin.hook_processAgentData({ action: 'coreinfo', users: ['DOMAINE\\alice'] }, agent);
    const aliceLookup = sent[sent.length - 1];
    assert.equal(aliceLookup.action, 'msg');
    assert.equal(aliceLookup.type, 'console');
    assert.equal(aliceLookup.rights, 24);
    assert.match(aliceLookup.value, /WTSSessionInfo/);
    assert.match(aliceLookup.value, /getRawSessionAttribute/);
    assert.doesNotMatch(aliceLookup.value, /alice|DOMAINE/i);

    // MeshAgent n'annonce l'utilisateur qu'à 09:00, mais Windows indique que
    // la session interactive a réellement commencé à 08:50.
    plugin.hook_processAgentData({
        action: 'msg', type: 'console', sessionid: aliceLookup.sessionid,
        value: JSON.stringify([{ Domain: 'DOMAINE', Username: 'alice', SessionId: 4,
            LogonTime: new Date(2026, 7, 31, 8, 50, 0, 0).getTime() }]),
    }, agent);
    assert.equal(sent[sent.length - 1].type, 'ps');
    assert.equal(sent.filter(m => m.action === 'runcommands').length, 0);

    // Le chronomètre reste ouvert jusqu'au démarrage réel d'explorer.exe.
    now = new Date(2026, 7, 31, 9, 10, 0, 0).getTime();
    plugin.hook_processAgentData({
        action: 'msg', type: 'userSessions', sessionid: sent[sent.length - 1].sessionid,
        data: [{ Domain: 'DOMAINE', Username: 'alice', SessionId: 4, State: 'Active' }],
    }, agent);
    plugin.hook_processAgentData({
        action: 'msg', type: 'ps', sessionid: sent[sent.length - 1].sessionid,
        value: JSON.stringify({ 1234: { cmd: 'C:\\Windows\\explorer.exe', user: 'DOMAINE\\alice' } }),
    }, agent);
    assert.equal(sent[sent.length - 1].type, 'psinfo');
    plugin.hook_processAgentData({
        action: 'msg', type: 'psinfo', sessionid: sent[sent.length - 1].sessionid, pid: 1234,
        // Sous Windows, ProcessName peut être « explorer » sans l'extension.
        value: { processName: 'explorer', userName: 'DOMAINE\\alice', sessionId: 4, startTime: new Date(now).toISOString() },
    }, agent);

    now = new Date(2026, 7, 31, 11, 0, 0, 0).getTime();
    plugin.hook_processAgentData({ action: 'coreinfo', users: [] }, agent);
    now = new Date(2026, 7, 31, 12, 0, 0, 0).getTime();

    const { res, done } = makeResponse();
    plugin.handleAdminReq({ query: { action: 'salles', weekStart: '2026-08-31' } }, res, {});
    const response = await done;
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 200);
    assert.equal(body.metric, 'loggedInSessions');
    assert.equal(body.salles.length, 1);
    assert.equal(body.salles[0].avgOnPct, 50);
    assert.equal(body.salles[0].avgOnMinutes, 120);
    assert.equal(body.salles[0].avgObservedMinutes, 240);
    assert.equal(body.salles[0].avgPowerPct, 100);
    assert.equal(body.salles[0].avgPowerMinutes, 240);

    const loginResponse = makeResponse();
    plugin.handleAdminReq({ query: { action: 'loginTimes', weekStart: '2026-08-31' } }, loginResponse.res, {});
    const loginBody = JSON.parse((await loginResponse.done).body);
    assert.equal(loginBody.timeout, null);
    assert.equal(loginBody.measuredFrom, 'windows-interactive-logon');
    assert.equal(loginBody.rows[0].count, 1);
    assert.equal(loginBody.rows[0].lastMs, 20 * 60 * 1000);
    assert.equal(loginBody.rows[0].historyCount, 1);
    assert.equal(loginBody.rows[0].history[0].status, 'ready');
    assert.equal(loginBody.rows[0].history[0].source, 'windows-wts-session');
    assert.equal(loginBody.rows[0].history[0].durationMs, 20 * 60 * 1000);
    assert.equal(loginBody.rows[0].history[0].startReliable, true);

    // Une déconnexion agent clôt une session encore ouverte.
    now = new Date(2026, 7, 31, 13, 0, 0, 0).getTime();
    plugin.hook_processAgentData({ action: 'coreinfo', users: ['bob'] }, agent);
    const bobLookup = sent[sent.length - 1];
    assert.equal(bobLookup.type, 'console');
    now = new Date(2026, 7, 31, 13, 20, 0, 0).getTime();
    const pendingResponse = makeResponse();
    plugin.handleAdminReq({ query: { action: 'loginTimes', weekStart: '2026-08-31' } }, pendingResponse.res, {});
    const pendingBody = JSON.parse((await pendingResponse.done).body);
    assert.equal(pendingBody.rows[0].pendingMs, 20 * 60 * 1000);
    assert.equal(pendingBody.rows[0].pendingStage, 'waiting-logon-time');
    assert.equal(pendingBody.rows[0].history[0].status, 'pending');

    // Certaines versions de MeshAgent confirment explorer.exe sans fournir
    // startTime. On clôt alors à l'instant de détection, après validation de
    // l'utilisateur ou de la session, au lieu de laisser le chrono bloqué.
    plugin.hook_processAgentData({
        action: 'msg', type: 'console', sessionid: bobLookup.sessionid,
        value: JSON.stringify([{ Username: 'bob', SessionId: 5,
            LogonTime: new Date(2026, 7, 31, 13, 0, 0, 0).getTime() }]),
    }, agent);
    const bobSessionId = bobLookup.sessionid;
    plugin.hook_processAgentData({
        action: 'msg', type: 'userSessions', sessionid: bobSessionId,
        data: [{ Username: 'bob', SessionId: 5, State: 'Active' }],
    }, agent);
    plugin.hook_processAgentData({
        action: 'msg', type: 'ps', sessionid: bobSessionId,
        value: JSON.stringify({ 2345: { cmd: '"C:\\Windows\\explorer.exe"', user: 'bob' } }),
    }, agent);
    plugin.hook_processAgentData({
        action: 'msg', type: 'psinfo', sessionid: bobSessionId, pid: 2345,
        value: { processName: 'explorer', userName: 'bob', sessionId: 5 },
    }, agent);
    const fallbackResponse = makeResponse();
    plugin.handleAdminReq({ query: { action: 'loginTimes', weekStart: '2026-08-31' } }, fallbackResponse.res, {});
    const fallbackBody = JSON.parse((await fallbackResponse.done).body);
    assert.equal(fallbackBody.rows[0].count, 2);
    assert.equal(fallbackBody.rows[0].lastMs, 20 * 60 * 1000);

    now = new Date(2026, 7, 31, 13, 21, 0, 0).getTime();
    plugin.hook_processAgentData({ action: 'coreinfo', users: [] }, agent);
    now = new Date(2026, 7, 31, 13, 30, 0, 0).getTime();
    plugin.hook_processAgentData({ action: 'coreinfo', users: ['charlie'] }, agent);
    const charlieLookup = sent[sent.length - 1];
    assert.equal(charlieLookup.type, 'console');
    now = new Date(2026, 7, 31, 13, 31, 0, 0).getTime();
    // Si WTS n'est pas disponible, le plugin retombe sur la commande Windows.
    plugin.hook_processAgentData({
        action: 'msg', type: 'console', sessionid: charlieLookup.sessionid,
        value: '[]',
    }, agent);
    const charliePowerShell = sent[sent.length - 1];
    assert.equal(charliePowerShell.action, 'runcommands');
    assert.match(charliePowerShell.cmds, /EventID=4624/);
    assert.match(charliePowerShell.cmds, /Win32_LogonSession/);
    assert.doesNotMatch(charliePowerShell.cmds, /Win32_LoggedOnUser|Associators of/);
    assert.ok(charliePowerShell.cmds.indexOf('Get-WinEvent') < charliePowerShell.cmds.indexOf('Get-CimInstance'));
    assert.doesNotMatch(charliePowerShell.cmds, /charlie/i);
    plugin.hook_processAgentData({
        action: 'msg', type: 'runcommands', sessionid: charliePowerShell.sessionid,
        result: 'USAGECTL_LOGON_NOT_FOUND',
    }, agent);
    plugin.hook_processAgentData({
        action: 'msg', type: 'userSessions', sessionid: charlieLookup.sessionid,
        data: [{ Username: 'charlie', SessionId: 6, State: 'Active' }],
    }, agent);
    plugin.hook_processAgentData({
        action: 'msg', type: 'ps', sessionid: charlieLookup.sessionid,
        value: JSON.stringify({ 3456: { cmd: 'C:\\Windows\\explorer.exe', user: 'charlie' } }),
    }, agent);
    plugin.hook_processAgentData({
        action: 'msg', type: 'psinfo', sessionid: charlieLookup.sessionid, pid: 3456,
        value: { processName: 'explorer', userName: 'charlie', sessionId: 6, startTime: new Date(now).toISOString() },
    }, agent);

    const unavailableResponse = makeResponse();
    plugin.handleAdminReq({ query: { action: 'loginTimes', weekStart: '2026-08-31' } }, unavailableResponse.res, {});
    const unavailableBody = JSON.parse((await unavailableResponse.done).body);
    assert.equal(unavailableBody.rows[0].count, 2);
    assert.equal(unavailableBody.rows[0].failed, 1);
    assert.equal(unavailableBody.rows[0].history[0].status, 'start-unavailable');
    assert.equal(unavailableBody.rows[0].history[0].failureReason, 'not-found');
    assert.equal(unavailableBody.rows[0].history[0].startReliable, false);

    now = new Date(2026, 7, 31, 13, 32, 0, 0).getTime();
    plugin.hook_processAgentData({ action: 'coreinfo', users: [] }, agent);
    now = new Date(2026, 7, 31, 13, 35, 0, 0).getTime();
    plugin.hook_processAgentData({ action: 'coreinfo', users: ['dave'] }, agent);
    now = new Date(2026, 7, 31, 14, 0, 0, 0).getTime();
    plugin.HandleEvent(null, { action: 'nodeconnect', nodeid: nodeId, meshid: meshId, conn: 0 });
    plugin.HandleEvent(null, { action: 'stopped' });

    const presencePath = Object.keys(writes).find(p => p.endsWith('usagectl-presence.json'));
    assert.ok(presencePath);
    assert.doesNotMatch(writes[presencePath], /alice|bob|charlie|dave|DOMAINE/i);
    const stored = JSON.parse(writes[presencePath]);
    assert.deepEqual(stored.nodes[nodeId].events.map(e => e[1]), [0, 1, 0, 1, 0, 1, 0, 1, 0]);

    const loginPath = Object.keys(writes).find(p => p.endsWith('usagectl-logins.json'));
    assert.ok(loginPath);
    assert.doesNotMatch(writes[loginPath], /alice|bob|charlie|dave|DOMAINE/i);
    const storedLogins = JSON.parse(writes[loginPath]);
    assert.deepEqual(storedLogins.nodes[nodeId].events.map(e => e[3]), ['ready', 'ready', 'start-unavailable', 'agent-offline']);
    assert.deepEqual(storedLogins.nodes[nodeId].events.map(e => e[4]), ['windows-wts-session', 'windows-wts-session', 'meshagent-session', 'meshagent-session']);
});
