const User = require('api/models/users/user');

let kue = require('lib/queue/queue');
let config = require("config");
let winston = require("lib/loggers/logger").winston;
let constants = require("api/common/constants");
let Push = require("api/models/push/pushes");
let Chat = require("api/models/chats/chat");
let Device = require("api/models/push/device");
let async = require("async");

module.exports.sendCreateChatPush = function (user, chat, callback = function () {
}) {
    User.findOne({_id: user}, function (err, creatorUser) {
        if (err) return callback(err);
        let usersToNotify = chat.members.filter(function (element) {
            return !element.creator;
        }).map(function (element) {
            return element.user
        });
        Device.find({user: {$in: usersToNotify}}, function (err, devices) {
            if (err) return callback(err);
            let message = {
                title: 'New chat',
                topic: config.push.topic,
                body: creatorUser.name + ' wants to chat with you', // REQUIRED
                custom: {
                    chatId: chat._id,
                },
                priority: 'high', // gcm, apn. Supported values are 'high' or 'normal' (gcm). Will be translated to 10 and 5 for apn. Defaults to 'high'
                retries: 3, // gcm, apn
                badge: 2, // gcm for ios, apn
                //expiry: Math.floor(Date.now() / 1000) + 28 * 86400, // seconds
            };
            async.each(
                devices,
                function (element, isDone) {
                    let newPush = {pushMessage: JSON.parse(JSON.stringify(message))};
                    newPush.device = element;
                    let pushObject = new Push(newPush);
                    pushObject.save(function (err, object) {
                        if (err) return callback(err);
                        let job = kue.createJob("push", {
                            token: element.pushToken,
                            message: message
                        });
                        let pushId = object._id;
                        job.on('complete', function (result) {
                            Push.findOne({_id: pushId}, function (err, object) {
                                if (!object) return winston.error("PUSH: object not found for id " + pushId);
                                object.status = constants.pushes.statusNames.succeed;
                                object.save(function (err, object) {
                                    if (!object) return winston.error("PUSH: could not save object for id " + pushId);
                                    winston.info("PUSH: chat create push finished to " + object.device.pushToken);
                                })
                            })
                        }).on('failed attempt', function (result) {
                            Push.findOne({_id: pushId}, function (err, object) {
                                if (!object)  return winston.error("PUSH: object not found for id " + pushId);
                                object.status = constants.pushes.statusNames.failedAttempt;
                                object.save(function (err) {
                                    if (!object) return winston.error("PUSH: could not save object for id " + pushId);
                                    winston.warn("PUSH: chat create push failed attempt to " + object.device.pushToken);
                                })
                            })
                        }).on('failed', function (errorMessage) {
                            Push.findOne({_id: pushId}, function (err, object) {
                                if (!object) return winston.error("PUSH: object not found for id " + pushId);
                                object.status = constants.pushes.statusNames.failed;
                                object.save(function (err) {
                                    if (!object) return winston.error("PUSH: could not save object for id " + pushId);
                                    winston.err("PUSH: chat create push failed to " + object.device.pushToken);
                                })
                            })
                            winston.error("PUSH: Failed push " + errorMessage);
                        }).attempts(3).backoff({type: 'exponential'}).save(callback);
                    })
                },
                function (err) {
                    callback(err);
                });
        });
    });
};

module.exports.sendCreateMessagePush = function (message, callback = function () {
}) {
    let creatorUser, chat, devices, finalMessage;
    async.series([
        function (isDone) {
            User.findOne({_id: message.user}, function (err, aUser) {
                creatorUser = aUser;
                isDone(err);
            });
        },
        function (isDone) {
            Chat.findOne({_id: message.chat}, function (err, aChat) {
                if (!aChat) return isDone({
                    localizedError: "No chat found",
                    rawError: "No chat for "+message.chat
                });
                chat = aChat;
                isDone(err);
            });
        },
        function (isDone) {
            let usersToNotify = chat.members.filter(function (element) {
                return element.user._id.toString() !== creatorUser._id.toString();
            }).map(function (element) {
                return element.user._id
            });
            if (!usersToNotify ||usersToNotify.length===0) return isDone({
                localizedError: "No users to notify found",
                rawError: "No users to notify for "+message.chat
            });
            Device.find({user: {$in: usersToNotify}}, function (err, someDevices) {
                if (!someDevices || someDevices.length===0) return isDone({
                    localizedError: "No devices to notify found",
                    rawError: "No devices to notify for "+message.chat
                });
                devices = someDevices;
                finalMessage = {
                    title: 'New message from ' + creatorUser.name,
                    topic: config.push.topic,
                    body: message.message,
                    custom: {
                        chatId: chat._id,
                    },
                    priority: 'high', // gcm, apn. Supported values are 'high' or 'normal' (gcm). Will be translated to 10 and 5 for apn. Defaults to 'high'
                    retries: 3, // gcm, apn
                    badge: 2, // gcm for ios, apn
                    //expiry: Math.floor(Date.now() / 1000) + 28 * 86400, // seconds
                };
                isDone(err);
            })
        },
        function (isReallyDone) {
            async.each(
                devices,
                function (element, isDone) {
                    let newPush = { pushMessage: JSON.parse(JSON.stringify(finalMessage))};
                    newPush.device = element;
                    newPush.pushType = constants.pushes.pushTypeNames.chatMessage;
                    let pushObject = new Push(newPush);
                    pushObject.save(function (err, object) {
                        if (err) return isDone(err);
                        let job = kue.createJob("push", {
                            token: element.pushToken,
                            message: finalMessage
                        });
                        let pushId = object._id;
                        job.on('complete', function (result) {
                            Push.findOne({_id: pushId}, function (err, object) {
                                if (!object) return winston.error("PUSH: object not found for id " + pushId);
                                object.status = constants.pushes.statusNames.succeed;
                                object.save(function (err, object) {
                                    if (!object) return winston.error("PUSH: could not save object for id " + pushId);
                                    winston.info("PUSH: chat message push finished to " + object.device.pushToken);
                                })
                            })
                        }).on('failed attempt', function (result) {
                            Push.findOne({_id: pushId}, function (err, object) {
                                if (!object) return winston.error("PUSH: object not found for id " + pushId);
                                object.status = constants.pushes.statusNames.failedAttempt;
                                object.save(function (err) {
                                    if (!object) return winston.error("PUSH: could not save object for id " + pushId);
                                    winston.warn("PUSH: chat message push failed attempt to " + object.device.pushToken);
                                })
                            })
                        }).on('failed', function (errorMessage) {
                            Push.findOne({_id: pushId}, function (err, object) {
                                if (!object) return winston.error("PUSH: object not found for id " + pushId);
                                object.status = constants.pushes.statusNames.failed;
                                object.save(function (err) {
                                    if (!object) return winston.error("PUSH: could not save object for id " + pushId);
                                    winston.err("PUSH: chat message push failed to " + object.device.pushToken);
                                })
                            })

                            winston.error("PUSH: Failed push " + errorMessage);
                        }).attempts(3).backoff({type: 'exponential'}).save(isDone);
                    })
                },
                function (err) {
                    isReallyDone(err);
                });
        }
    ], function (err) {
        if (err) winston.error("PUSH: an error occurred for "+JSON.stringify(message)+" error: " + JSON.stringify(err));
        callback(err);
    });
};