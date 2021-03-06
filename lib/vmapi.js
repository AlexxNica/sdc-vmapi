/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017, Joyent, Inc.
 */

/*
 * Main entry-point for the VMs API.
 */

var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var EffluentLogger = require('effluent-logger');
var once = require('once');
var restify = require('restify');
var trace_event = require('trace-event');
var util = require('util');

var curlUserAgent = require('./restify-plugins/curl-user-agent');
var interceptors = require('./interceptors');
var jobs = require('./endpoints/jobs');
var metadata = require('./endpoints/metadata');
var ping = require('./endpoints/ping');
var roleTags = require('./endpoints/role-tags');
var statuses = require('./endpoints/statuses');
var vms = require('./endpoints/vms');
var validations = require('./common/validation');

var os = require('os');
var crypto = require('crypto');
var http = require('http');
var https = require('https');

var request_seq_id = 0;
var API_SERVER_DEFAULT_PORT = 80;

/*
 * VmapiApp constructor
 */
function VmapiApp(options) {
    assert.object(options, 'options');
    assert.optionalObject(options.log, 'options.log');

    // Fabric options
    assert.optionalObject(options.overlay, 'options.overlay');
    if (options.overlay) {
        assert.bool(options.overlay.enabled, 'options.overlay.enabled');
        if (options.overlay.enabled) {
            assert.uuid(options.overlay.natPool, 'options.overlay.natPool');
        }
    }

    assert.optionalObject(options.apiClients, 'options.apiClients');
    if (options.apiClients) {
        assert.optionalObject(options.apiClients.wfapi,
            'options.apiClients.wfapi');
        this.wfapi = options.apiClients.wfapi;

        assert.optionalObject(options.apiClients.cnapi,
            'options.apiClients.cnapi');
        this.cnapi = options.apiClients.cnapi;

        assert.optionalObject(options.apiClients.imgapi,
            'options.apiClients.imgapi');
        this.imgapi = options.apiClients.imgapi;

        assert.optionalObject(options.apiClients.napi,
            'options.apiClients.napi');
        this.napi = options.apiClients.napi;

        assert.optionalObject(options.apiClients.papi,
            'options.apiClients.papi');
        this.papi = options.apiClients.papi;
    }

    /*
     * options.moray is mandatory because VmapiApp cannot provide even its
     * most basic functionality without a moray backend.
     */
    assert.object(options.moray, 'options.moray');
    this.moray = options.moray;

    /*
     * options.changefeedPublisher is mandatory because we prefer to require the
     * behavior of *not* publishing changes to be set explicitly by passing a
     * mocked changefeed publisher that does not publish changes, rather than
     * allow typos or programming mistakes to result in no change being
     * published at all silently.
     */
    assert.object(options.changefeedPublisher, 'options.changefeedPublisher');
    this.changefeedPublisher = options.changefeedPublisher;

    /*
     * options.morayBucketsInitializer is mandatory because it's used by the
     * /ping endpoint to determine the status of the moray database
     * initialization, e.g when VMAPI's moray buckets haven't been setup, /ping
     * will respond with an "unhealthy" status.
     */
    assert.object(options.morayBucketsInitializer,
        'options.morayBucketsInitializer');
    this.morayBucketsInitializer = options.morayBucketsInitializer;

    if (options.log === undefined) {
        this.log = bunyan.createLogger({
            name: 'vmapi',
            level: 'debug',
            serializers: restify.bunyan.serializers
        });
    } else {
        this.log = options.log;
    }

    this.options = options;

    /*
     * We make it mandatory to pass a data migrations controller so that we
     * don't omit to pass it to the VMAPI application constructor by mistake at
     * some point, even though technically in a lot of use cases (e.g tests)
     * when we don't need to perform data migrations, it'd be perfectly fine to
     * omit it.
     */
    assert.object(options.dataMigrationsCtrl, 'options.dataMigrationsCtrl');
    this.dataMigrationsCtrl = options.dataMigrationsCtrl;

    validations.init(options);
    this._initApis(options);
}

function addFluentdHost(log, host) {
    var evtLogger = new EffluentLogger({
        filter: function _evtFilter(obj) { return (!!obj.evt); },
        host: host,
        log: log,
        port: 24224,
        tag: 'debug'
    });
    log.addStream({
        stream: evtLogger,
        type: 'raw'
    });
}

/*
 * Returns true if the response object "res" represents a response indicating a
 * successful HTTP request.
 */
function responseIndicatesSuccess(res) {
    assert.object(res, 'res');
    assert.finite(res.statusCode, 'res.statusCode');

    // Any 20X HTTP status code is considered to represent a successful request.
    return Math.floor(res.statusCode / 100) === 2;
}

/*
 * VmapiApp API objects initialization code
 */
VmapiApp.prototype._initApis = function _initApis(options) {
    assert.object(options, 'options');

    var apiVersion = options.version;

    var log = this.log;
    assert.object(log, 'log');

    // EXPERIMENTAL
    if (options.fluentd_host) {
        addFluentdHost(log, options.fluentd_host);
    }

    // Init VmapiApp server
    this.server = restify.createServer({
        name: 'VMAPI',
        log: log.child({ component: 'api' }, true),
        version: apiVersion,
        serverName: 'SmartDataCenter',
        formatters: {
            'application/json': formatJSON,
            'text/plain': formatJSON,
            'application/octet-stream': formatJSON,
            'application/x-json-stream': formatJSON,
            '*/*': formatJSON },
        handleUncaughtExceptions: false
    });

    // This allows VmapiApp to respond to HEAD requests sent by curl with proper
    // headers and prevents/fixes https://smartos.org/bugview/ZAPI-220.
    this.server.pre(curlUserAgent());

    this.server.on('after', function (req, res, route, err) {
        if (req.path() === '/ping') {
            return;
        }

        var method = req.method;

        var requestSuccessful = responseIndicatesSuccess(res);
        // For debugging purposes, include the response's body in the audit log
        // by default.
        var includeBodyInAuditLog = true;
        if (requestSuccessful) {
            // When the request is succesful, include the body of the response
            // in the audit log, unless in the following cases:
            //
            // 1. A GET request: the response's body is not particularly
            // interesting and is usually big.
            //
            // 2. A HEAD request: even if a body is set in this case, it's only
            // so that Content-Length and Content-MD5 response headers are
            // properly set in the custom JSON restify formatter according to
            // RFC 2616. Having it in the audit log is not relevant since it's
            // actually not sent to the client sending the request.
            //
            // 3. A PutVms request: the response's body would be equivalent to
            // the request's data and is usually big.
            if (method === 'GET' || method === 'HEAD' ||
                (route && route.name === 'putvms')) {
                includeBodyInAuditLog = false;
            }
        }

        restify.auditLogger({
            log: req.log.child({ route: route && route.name }, true),
            body: includeBodyInAuditLog
        })(req, res, route, err);
    });

    // Init Server middleware
    this.setMiddleware();
    this.setStaticRoutes();
    this.setRoutes();

    this.changefeedPublisher.mountRestifyServerRoutes(this.server);
};

VmapiApp.prototype.close = function close() {
    if (this.server) {
        this.server.close();
    }
};

/*
 * Sets custom middlewares to use for the API
 */
VmapiApp.prototype.setMiddleware = function () {
    var server = this.server;
    server.use(function (req, res, next) {
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('Server', server.name);
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', os.hostname());
        });

        next();
    });

    server.use(restify.requestLogger());

    var EVT_SKIP_ROUTES = {
        'ping': true,
        'changefeeds': true,
        'changefeeds_stats': true
    };
    server.use(function (req, res, next) {
        req.trace = trace_event.createBunyanTracer({
            log: req.log
        });
        if (req.route && !EVT_SKIP_ROUTES[req.route.name]) {
            request_seq_id = (request_seq_id + 1) % 1000;
            req.trace.seq_id = (req.time() * 1000) + request_seq_id;
            req.trace.begin({name: req.route.name, req_seq: req.trace.seq_id});
        }
        next();
    });
    server.on('after', function (req, res, route, err) {
        if (route && !EVT_SKIP_ROUTES[route.name]) {
            req.trace.end({name: route.name, req_seq: req.trace.seq_id});
        }
    });

    server.use(restify.acceptParser(server.acceptable));
    server.use(restify.bodyParser());
    server.use(restify.dateParser());
    server.use(restify.queryParser({allowDots: false, plainObjects: false}));
};



/*
 * Sets all routes for static content
 */
VmapiApp.prototype.setStaticRoutes = function () {
    return;
};



/*
 * Sets all routes for the VmapiApp server
 */
VmapiApp.prototype.setRoutes = function () {
    var vmapi = this;

    vmapi.server.use(function _setApp(req, res, next) {
        req.app = vmapi;
        return next();
    });

    ping.mount(this.server);

    /*
     * All endpoints _but_ the ping endpoint first check if moray buckets were
     * properly setup before running their route handler, as there's no way for
     * most endpoints to be able to work reliably if it's not the case.
     *
     * The ping endpoint has some custom code to handle problems with moray
     * buckets setup because it needs to respond with some context so that the
     * client can better understand the nature of the problem.
     */
    this.server.use(interceptors.checkMorayBucketsSetup);

    vms.mount(this.server);
    jobs.mount(this.server);
    roleTags.mount(this.server);
    metadata.mount(this.server);
    statuses.mount(this.server);
};



/*
 * Gets the server IP address for use by WFAPI on ping backs
 */
VmapiApp.prototype.serverIp = function () {
    var interfaces = os.networkInterfaces();

    var ifs = interfaces['net0'] || interfaces['en1'] || interfaces['en0'];
    var ip;

    for (var i = 0; i < ifs.length; i++) {
        if (ifs[i].family === 'IPv4') {
            ip = ifs[i].address;
            break;
        }
    }

    return ip;
};



/*
 * Starts listening on the port given by options.port or config.api.port. Takes
 * options and a callback function as arguments. The callback is called with no
 * arguments.
 */
VmapiApp.prototype.listen = function (options, callback) {
    var self = this;
    var bindAddr = '0.0.0.0';
    var port = API_SERVER_DEFAULT_PORT;

    if (typeof (options) === 'function') {
        callback = options;
        options = undefined;
    }

    if (options === undefined) {
        options = {};
    }

    assert.object(options, 'options');
    assert.optionalNumber(options.port, 'options.port');

    assert.optionalFunc(callback, 'callback');

    if (options && options.port !== undefined) {
        port = options.port;
    }

    self.server.listen(port, bindAddr, function () {
        self.log.info({ url: self.server.url },
                      '%s listening', self.server.name);

        if (callback) {
            callback();
        }

        return;
    });
};

VmapiApp.prototype.getLatestCompletedDataMigrationForModel =
    function getLatestCompletedDataMigrationForModel(modelName) {
    assert.ok(this.moray.isValidModelName(modelName), modelName + ' is valid');

    var dataMigrationsCtrl = this.dataMigrationsCtrl;
    if (dataMigrationsCtrl === undefined) {
        return;
    }

    return dataMigrationsCtrl.getLatestCompletedMigrationForModel(modelName);
};


/*
 * Force JSON for all accept headers
 */
function formatJSON(req, res, body, callback) {
    var formattedJson;

    if (body instanceof Error) {
        // snoop for RestError or HttpError, but don't rely on
        // instanceof
        res.statusCode = body.statusCode || 500;

        if (body.body) {
            body = body.body;
        } else {
            body = { message: body.message };
        }
    } else if (Buffer.isBuffer(body)) {
        body = body.toString('base64');
    }

    var data = JSON.stringify(body);
    var md5 = crypto.createHash('md5').update(data).digest('base64');

    res.setHeader('Content-Length', Buffer.byteLength(data));
    res.setHeader('Content-MD5', md5);
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'HEAD') {
        // In case of a successful response to a HEAD request, the formatter is
        // used to properly set the Content-Length and Content-MD5 headers, but
        // no data should actually be sent as part of the response's body. This
        // is all according to RFC 2616.
        formattedJson = '';
    } else {
        formattedJson = data;
    }

    callback(null, formattedJson);
}


module.exports = VmapiApp;
