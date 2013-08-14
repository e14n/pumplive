// index.js
//
// Most of the routes in the application
//
// Copyright 2013, StatusNet Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var wf = require("webfinger"),
    async = require("async"),
    _ = require("underscore"),
    uuid = require("node-uuid"),
    User = require("../models/user"),
    Host = require("../models/host"),
    RequestToken = require("../models/requesttoken"),
    PumpLive = require("../models/pumplive");

var S = 1000;
var M = 60 * S;
var H = 60 * M;

var softRead = function(bank, type, key, def, callback) {
    bank.read(type, key, function(err, result) {
        if (err && err.name == "NoSuchThingError") {
            callback(null, def);
        } else if (err) {
            callback(err, null);
        } else {
            callback(null, result);
        }
    });
};

var getStats = function(callback) {

    var bank = Host.bank();

    async.parallel([
        function(callback) {
            softRead(bank, "hosttotal", 0, 0, callback);
        },
        function(callback) {
            softRead(bank, "lasttotalcount", 0, {count: 0}, callback);
        },
        function(callback) {
            var then = new Date(Date.now() - 1*H),
                key = [then.getUTCFullYear(), (then.getUTCMonth()+1), then.getUTCDate(), then.getUTCHours()].join("_");

            softRead(bank, "activityrate", key, 0, callback);
        }
    ], function(err, results) {
        if (err) {
            callback(err, null);
        } else {
            callback(null, {
                hosts: results[0],
                users: results[1].count,
                activityRate: results[2]
            });
        }
    });

};

exports.hostmeta = function(req, res) {
    res.json({
        links: [
            {
                rel: "dialback",
                href: PumpLive.url("/dialback")
            }
        ]
    });
};

exports.index = function(req, res, next) {

    async.waterfall([
        function(callback) {
            getStats(callback);
        }
    ], function(err, stats) {
        if (err) {
            next(err);
        } else if (req.user) {
            res.render('userindex', { title: "Pump Live", user: req.user, users: stats.users, hosts: stats.hosts, activityRate: stats.activityRate });
        } else {
            res.render('index', { title: "Pump Live", users: stats.users, hosts: stats.hosts, activityRate: stats.activityRate });
        }
    });
};

exports.about = function(req, res) {
    res.render('about', { title: 'About Pump Live' });
};

exports.login = function(req, res) {
    res.render('login', { title: 'Login' });
};

exports.handleLogin = function(req, res, next) {

    var id = req.body.webfinger,
        hostname = User.getHostname(id),
        host;
    
    async.waterfall([
        function(callback) {
            Host.ensureHost(hostname, callback);
        },
        function(results, callback) {
            host = results;
            host.getRequestToken(callback);
        }
    ], function(err, rt) {
        if (err) {
            if (err instanceof Error) {
                next(err);
            } else if (err.data) {
                next(new Error(err.data));
            }
        } else {
            res.redirect(host.authorizeURL(rt));
        }
    });
};

exports.authorized = function(req, res, next) {

    var hostname = req.params.hostname,
        token = req.query.oauth_token,
        verifier = req.query.oauth_verifier,
        rt,
        host,
        access_token,
        token_secret,
        id,
        object,
        newUser = false;

    async.waterfall([
        function(callback) {
            async.parallel([
                function(callback) {
                    RequestToken.get(RequestToken.key(hostname, token), callback);
                },
                function(callback) {
                    Host.get(hostname, callback);
                }
            ], callback);
        },
        function(results, callback) {
            rt = results[0];
            host = results[1];
            host.getAccessToken(rt, verifier, callback);
        },
        function(token, secret, extra, callback) {
            access_token = token;
            token_secret = secret;
            async.parallel([
                function(callback) {
                    rt.del(callback);
                },
                function(callback) {
                    host.whoami(access_token, token_secret, callback);
                }
            ], callback);
        },
        function(results, callback) {
            object = results[1];
            id = object.id;
            if (id.substr(0, 5) == "acct:") {
                id = id.substr(5);
            }
            User.get(id, function(err, user) {
                if (err && err.name === "NoSuchThingError") {
                    newUser = true;
                    User.fromPerson(object, access_token, token_secret, callback);
                } else if (err) {
                    callback(err, null);
                } else {
                    callback(null, user);
                }
            });
        }
    ], function(err, user) {
        if (err) {
            next(err);
        } else {
            req.session.userID = user.id;
            res.redirect("/");
        }
    });
};

exports.handleLogout = function(req, res) {

    delete req.session.userID;
    delete req.user;

    res.redirect("/", 303);
};
