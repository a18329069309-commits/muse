import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {syncBuiltinESMExports} from 'node:module';

const denied = () => { throw Error('MUSE_OFFLINE_TEST_NETWORK_DISABLED'); };
globalThis.fetch = denied;
net.Socket.prototype.connect = denied;
net.connect = net.createConnection = tls.connect = denied;
http.request = http.get = https.request = https.get = denied;
syncBuiltinESMExports();
