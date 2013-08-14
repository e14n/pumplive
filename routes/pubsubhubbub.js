// Client for pubsubhubbub-json
//
// Copyright 2012, 2013 E14N https://e14n.com/
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

var urlparse = require("url").parse,
    async = require("async"),
    express = require("express"),
    bodyParser = express.bodyParser,
    _ = require("underscore"),
    crypto = require("crypto"),
    Host = require("../models/host"),
    PushRequest = require("../models/pushrequest"),
    Subscription = require("../models/subscription");

var subCallback = function(req, res) {

    var contentType = req.headers["content-type"];

    req.log.info("PuSH callback called.");

    // Verify

    if (contentType === "application/x-www-form-urlencoded") {

        verifySubscription(req, res);

    } else if (contentType === "application/json") { // Content

        receiveContent(req, res);

    } else {
        res.writeHead(400, {"Content-Type": "text/plain"});
        res.end("Suck it loser");
    }
};

var verifySubscription = function(req, res) {

    var params,
        verify_token;

    req.log.info("Verifying subscription.");

    async.waterfall([
        function(callback) {
            params = req.body;
            verify_token = params["hub.verify_token"];
            req.log.info(params, "Subscription");
            PushRequest.get(verify_token, callback);
        },
        function(pushreq, callback) {
            if (params["hub.mode"] == pushreq.mode &&
                params["hub.topic"] == pushreq.topic) {
                callback(null);
            } else {
                callback(new Error("Mismatched PuSH request"));
            }
        }
    ], function(err) {
        if (err) {
            res.writeHead(404, {"Content-Type": "text/plain"});
            res.end("Suck it loser");
        } else {
            res.writeHead(200, {"Content-Type": "text/plain"});
            res.end(params["hub.challenge"]);
        }
    });
};

var receiveContent = function(req, res) {

    req.log.info("Receiving content.");

    async.waterfall([
        function(callback) {
            var i, notice, topic, sub, sig;

            if (!_(req.body).has("items") || 
                !_(req.body.items).isArray() || 
                req.body.items.length === 0)
            {
                callback(new Error("Invalid payload"), null);
                return;
            }

            topic = req.body.items[0].topic;

            if (!_.every(req.body.items, function(item) { return item.topic == topic; })) {
                callback(new Error("Invalid payload"), null);
                return;
            }

            Subscription.get(topic, callback);
        },
        function(sub, callback) {

            var sigHeader = req.headers["x-hub-signature"],
                sig,
                calculated;

            if (!sigHeader) {
                callback(new Error("Unsigned message"));
                return;
            }

            // Header starts with 'sha1='; trim that out

            sig = sigHeader.substr(5);

            // Calculate the actual signature

            calculated = hmacSig(req.rawBody, sub.secret);            

            if (!sig || sig !== calculated) {
                callback(new Error("Bad signature; '" + sig + "' != '" + calculated + "'"));
            } else {
                callback(null);
            }
        }
    ], function(err) {
        if (err) {
            req.log.error(err);
            res.writeHead(404, {"Content-Type": "text/plain"});
            res.end("Suck it loser");
        } else {
            _.each(req.body.items, function(item) {
                deliverPayload(item.payload, req.log);
            });
        }
    });
};

var hmacSig = function(message, secret) {
    var hmac = crypto.createHmac("sha1", secret);
    hmac.update(message);
    return hmac.digest("hex");
};

var deliverPayload = function(activity, log) {
    
    async.parallel([
        function(callback) {
            ensureActivityHost(activity, log, callback);
        },
        function(callback) {
            updateActivityCount(activity, log, callback);
        }
    ], function(err) {
        if (err) {
            log.error(err);
        } else {
            log.info({activity: activity.id}, "Successfully handled activity.");
        }
    });
};

var updateActivityCount = function(activity, log, callback) {
    var now = new Date(),
        bank = Host.bank(),
        key = [now.getUTCFullYear(), (now.getUTCMonth()+1), now.getUTCDate(), now.getUTCHour()].join("_");

    bank.incr("hourlyactivitycount", key, function(err) {
        callback(err);
    });
};

var ensureActivityHost = function(activity, log, callback) {

    var parsed;

    if (!activity.actor || !activity.actor.url) {
        callback(null);
        return;
    }

    // XXX: Check other URLs, like to: and cc: 

    parsed = urlparse(activity.actor.url);

    Host.ensureHost(parsed.hostname, function(err, host) {
        callback(err);
    });
};

exports.subCallback = subCallback;
