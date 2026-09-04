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
    fs.existsSync = p => String(p).endsWith('usagectl-cache.json') || String(p).endsWith('usagectl-presence.json')
        ? false
        : realExistsSync(p);
    fs.writeFileSync = (p, data, ...args) => {
        if (String(p).endsWith('usagectl-cache.json') || String(p).endsWith('usagectl-presence.json.tmp')) {
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
    const agent = { dbNodeKey: nodeId, dbMeshKey: meshId };

    // MeshCentral charge le plugin alors que les agents peuvent être déjà
    // connectés : tous les nœuds doivent être amorcés immédiatement.
    plugin.server_startup();
    plugin.hook_processAgentData({ action: 'coreinfo', users: [] }, agent);
    now = new Date(2026, 7, 31, 9, 0, 0, 0).getTime();
    plugin.hook_processAgentData({ action: 'coreinfo', users: ['DOMAINE\\alice'] }, agent);
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

    // Une déconnexion agent clôt une session encore ouverte.
    now = new Date(2026, 7, 31, 13, 0, 0, 0).getTime();
    plugin.hook_processAgentData({ action: 'coreinfo', users: ['bob'] }, agent);
    now = new Date(2026, 7, 31, 14, 0, 0, 0).getTime();
    plugin.HandleEvent(null, { action: 'nodeconnect', nodeid: nodeId, meshid: meshId, conn: 0 });
    plugin.HandleEvent(null, { action: 'stopped' });

    const presencePath = Object.keys(writes).find(p => p.endsWith('usagectl-presence.json'));
    assert.ok(presencePath);
    assert.doesNotMatch(writes[presencePath], /alice|bob|DOMAINE/i);
    const stored = JSON.parse(writes[presencePath]);
    assert.deepEqual(stored.nodes[nodeId].events.map(e => e[1]), [0, 1, 0, 1, 0]);
});
