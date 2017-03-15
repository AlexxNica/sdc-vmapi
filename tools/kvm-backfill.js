/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

// Backfill image_uuid for KVM VMs
var assert = require('assert-plus');
var bunyan = require('bunyan');
var fs = require('fs');
var jsprim = require('jsprim');
var path = require('path');
var util = require('util');

var configLoader = require('../lib/config-loader');
var MORAY = require('../lib/apis/moray');

var configFilePath = path.resolve(__dirname, '..', 'config.json');
var config = configLoader.loadConfig(configFilePath);

var VMS_LIMIT = (process.env.VMS_LIMIT) ? Number(process.env.VMS_LIMIT) : 10;

// Total number of VMs
var totalNbKvmVms = 0;
// Number of VMs we've finished with:
var nbProcessedVms = 0;

var log = new bunyan({
    name: 'kvm-backfill',
    streams: [ {
        level: config.logLevel || 'info',
        stream: process.stdout
    }]
});

var moray = new MORAY(config.moray);

moray.connect();

moray.once('moray-ready', function onMorayReady() {
    startProcessingVMs(moray);
});

function startProcessingVMs(morayClient) {
    assert.object(morayClient, 'morayClient');

    processVms(0, VMS_LIMIT, processCb);

    function processVms(offset, limit, cb) {
        var done = 0;

        function wait() {
            log.info({done: done, limit: limit}, 'inside wait');

            if (done === limit) {
                return cb();
            } else {
                return setTimeout(wait, 1000);
            }
        }

        morayClient.countVms({ brand: 'kvm' }, onCount);

        function onCount(countVmsErr, count) {
            if (countVmsErr) {
                log.error({err: countVmsErr}, 'Could not get count of vms');
                process.exit(1);
            }

            var query = { brand: 'kvm', offset: offset, limit: limit };
            morayClient.listVms(query, true, function (err, vms) {
                if (err) {
                    log.error({err: err}, 'Error fetching VMs');
                    return processCb(err);
                }
                // Should happen just on first pass
                if (totalNbKvmVms === 0) {
                    totalNbKvmVms = count;
                }
                if (count < limit) {
                    limit = count;
                }

                vms.forEach(processVm);
                function processVm(vm) {
                    var disks = vm.disks;

                    // If VM has a value here then it's already good
                    if (vm.image_uuid) {
                        nbProcessedVms += 1;
                        done += 1;
                        log.info('VM %d of %d already processed',
                            nbProcessedVms, totalNbKvmVms);
                        return;
                    }

                    try {
                        if (typeof (disks) == 'string') {
                            disks = JSON.parse(disks);
                        }
                    } catch (e) {
                        nbProcessedVms += 1;
                        done += 1;

                        log.error({
                            err: e,
                            vm_uuid: vm.uuid
                        }, 'Error parsing VM disks, skipping.');
                        return;
                    }

                    if (disks && disks[0] && disks[0].image_uuid) {
                        vm.image_uuid = disks[0].image_uuid;

                        morayClient.putVm(vm.uuid, vm, function (perr) {
                            nbProcessedVms += 1;
                            done += 1;

                            if (perr) {
                                log.error({
                                    err: perr,
                                    vm_uuid: vm.uuid
                                }, 'Error updating VM');
                            } else {
                                log.info({
                                    vm_uuid: vm.uuid,
                                    server_uuid: vm.server_uuid
                                },
                                util.format('VM %d of %d updated',
                                    nbProcessedVms, totalNbKvmVms));
                            }
                        });

                    // This should never happen
                    } else {
                        nbProcessedVms += 1;
                        done += 1;
                        log.warn({ vm_uuid: vm.uuid }, 'Error does not ' +
                        'have standard disks array, skipping.');
                    }
                }

                return wait();
            });
        }
    }

    function processCb(err) {
        if (err) {
            console.log(err.message);
        }

        if (nbProcessedVms < totalNbKvmVms) {
            log.info('% %d', nbProcessedVms, totalNbKvmVms);
            return processVms(nbProcessedVms, VMS_LIMIT, processCb);
        } else {
            log.info('%d VMS nbProcessedVms. DONE!', totalNbKvmVms);
            morayClient.connection.close();
            return (true);
        }
    }
}
