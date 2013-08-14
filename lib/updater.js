// updater.js
//
// Updates the state of the world
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

var _ = require("underscore"),
    async = require("async"),
    User = require("../models/user"),
    Host = require("../models/host"),
    HostCount = require("../models/hostcount"),
    TotalCount = require("../models/totalcount"),
    PumpLive = require("../models/pumplive");

var ignore = function(err) {};

var S = 1000;
var M = 60 * S;
var H = 60 * M;

var Updater = function(options) {

    var log = options.log.child({component: "updater"}),
        logError = function(err) {
            if (err) {
                log.error(err);
            }
        },
        updateAll = function() {
            async.parallel([
                updateHosts,
                ensureActivityRate
            ], function(err) {
                logError(err);
            });
        },
        ensureActivityRate = function(callback) {
            var bank = Host.bank(),
                then = new Date(Date.now() - 1*H),
                key = [then.getUTCFullYear(), (then.getUTCMonth()+1), then.getUTCDate(), then.getUTCHours()].join("_");
                            
            bank.read("activityrate", key, function(err, rate) {
                if (err && err.name == "NoSuchThingError") {
                    updateActivityRate(callback);
                } else if (err) {
                    callback(err);
                } else {
                    callback(null);
                }
            });
        },
        updateActivityRate = function(callback) {
            var bank = Host.bank(),
                then,
                i,
                keys = [];

            for (i = 1; i < 25; i++) {
                then = new Date(Date.now() - i*H);
                keys.push([then.getUTCFullYear(), (then.getUTCMonth()+1), then.getUTCDate(), then.getUTCHours()].join("_"));
            }

            async.waterfall([
                function(callback) {
                    bank.readAll("hourlyactivitycount", keys, this);
                },
                function(counts, callback) {
                    var total = 0,
                        rate,
                        then = new Date(Date.now() - 1*H),
                        key = [then.getUTCFullYear(), (then.getUTCMonth()+1), then.getUTCDate(), then.getUTCHours()].join("_");

                    _.each(counts, function(count) {
                        if (count) {
                            total += count;
                        }
                    });
                    // To get average activities per second, divide total activities for
                    // 24 hours by 24 hours in seconds
                    rate = total / (24 * H / S);
                    bank.create("activityrate", key, rate, callback);
                }
            ], function(err) {
                callback(err);
            });
        },
        updateHosts = function(callback) {

            var bank = Host.bank(),
                cnt = 0,
                total = 0,
                done = 0,
                scanDone = false,
                hostQueue = async.queue(updateHost, 25);

            // When the queue is drained, update the total
            // XXX: I'm not sure about this.

            hostQueue.drain = function() {
                if (scanDone) {
                    TotalCount.create({count: total}, callback);
                }
            };

            // Scan all known hosts...

            Host.scan(
                function(host) {
                    cnt++;
                    
                    // Queue for processing
                    hostQueue.push(host.hostname, function(err, hostcnt) {
                        if (err) {
                            log.error(err);
                        } else {
                            total += hostcnt;
                            done++;
                        }
                    });
                },
                function(err) {
                    if (err) {
                        log.error(err);
                    }
                    scanDone = true;
                }
            );
        },
        updateHost = function(hostname, callback) {
            var cnt = 0;
            async.waterfall(
                [
                    function(callback) {
                        Host.ensureHost(hostname, callback);
                    },
                    function(host, callback) {
                        var oa = host.getOAuth();
                        log.info({hostname: hostname}, "Querying user count");
                        oa.get("http://"+hostname+"/api/users", null, null, callback);
                    },
                    function(doc, resp, callback) {
                        if (resp.statusCode != 200 ||
                            resp.headers['content-type'].substr(0, 16) != 'application/json') {
                            callback(new Error("Bad response"), null);
                            return;
                        }
                        try {
                            var obj = JSON.parse(doc);
                            callback(null, obj.totalItems);
                        } catch (err) {
                            callback(err, null);
                        }
                    },
                    function(cnt, callback) {
                        log.info({hostname: hostname, count: cnt}, "Save user count");
                        HostCount.create({hostname: hostname, count: cnt}, callback);
                    }
                ],
                function(err, hc) {
                    if (err) {
                        // XXX: exponential backoff
                        log.error(_.extend(err, {hostname: hostname}));
                        callback(null, 0);
                    } else {
                        callback(null, hc.count);
                    }
                }
            );
        };

    this.start = function() {
        // Do this every 15 minutes
        setInterval(updateAll, 15 * M);
        // Do one right now
        updateAll();
    };
};

Updater.EMPTY_NOTIFICATION_TIME = 24 * H;

module.exports = Updater;
