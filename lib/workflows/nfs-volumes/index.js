/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * This module exports an object that has a "provisionChain" property which
 * represents a list of tasks that allows to provision NFS shared volumes that
 * are required/mounted by a given VM (e.g through the docker run -v
 * some-nfs-volume:/some-mountpoint command).
 * This list of task is currently used in the "start" workflow.
 */

var common = require('../job-common');
var jsprim = require('jsprim');
var vasync = require('vasync');

function provisionNfsVolumes(job, cb) {
    var vmapi = new sdcClients.VMAPI({
        url: vmapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    var volapi = new sdcClients.VOLAPI({
        url: volapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] },
        version: '^1',
        userAgent: job.name
    });

    var vmUuid = job.params['vm_uuid'];

    var context = {};
    vasync.pipeline({funcs: [
        /*
         * Gets the VM that is being started by job "job" and loads the value of
         * its "internal_metadata"'s "nfs_volumes_required"" property, which
         * stores what volumes this VM needs to have access to as soon as it
         * starts.
         */
        loadRequiredNfsVolumes,
        /*
         * Creates the NFS shared volumes required by the VM being started, and
         * updates the "docker:nfsvolumes" internal_metadata property with the
         * actual NFS remote path (IP:/exported/path) and the mountpoint, so
         * that dockerinit can actually mount the corresponding NFS filesystems
         * when that VM boots.
         */
        provisionRequiredNfsVolumes
    ],
    arg: context
    }, function allVolumesProvisioned(err, results) {
        if (err) {
            cb(new Error('Could not provision volumes, reason: ' + err));
        } else {
            job.createdVolumes = context.createdVolumes;
            cb(null, 'All volumes provisioned');
        }
    });

    function loadRequiredNfsVolumes(ctx, callback) {
        vmapi.getVm({
            uuid: vmUuid
        }, function onGetVm(err, vm) {
            var requiredNfsVolumesString;
            var parsedRequiredNfsVolumes;
            var mapRequiredNfsVolumes = {};

            if (!vm) {
                callback(new Error('Could not get VM with uuid ' + vmUuid));
                return;
            }

            job.vm = vm;

            if (!vm.internal_metadata ||
                typeof (vm.internal_metadata) !== 'object') {
                callback(new Error('internal_metadata property missing from '
                    + 'VM object'));
                return;
            }

            requiredNfsVolumesString =
                vm.internal_metadata['docker:nfs_volumes_required'];

            if (requiredNfsVolumesString !== undefined &&
                typeof (requiredNfsVolumesString) !== 'string') {
                callback(new Error('docker:nfs_volumes_required '
                    + 'internal_metadata property must be a string if '
                    + 'present'));
                return;
            }

            if (requiredNfsVolumesString) {
                try {
                    parsedRequiredNfsVolumes =
                        JSON.parse(requiredNfsVolumesString);
                } catch (parseErr) {
                    callback(new Error('Could not parse '
                        + 'docker:nfs_volumes_required internal metadata'));
                }
            }

            if (!Array.isArray(parsedRequiredNfsVolumes)) {
                callback(new Error('docker:nfs_volumes_required internal '
                    + 'metadata must represent an array'));
                return;
            }

            parsedRequiredNfsVolumes.forEach(function (requiredVolume) {
                if (requiredVolume === null ||
                    typeof (requiredVolume) !== 'object') {
                    callback(new Error('requiredVolume must be an object'));
                    return;
                }

                mapRequiredNfsVolumes[requiredVolume.name] = requiredVolume;
            });

            ctx.mapRequiredNfsVolumes = mapRequiredNfsVolumes;
            job.mapRequiredNfsVolumes = mapRequiredNfsVolumes;

            callback(err);
        });
    }

    function provisionRequiredNfsVolumes(ctx, callback) {
        if (ctx.mapRequiredNfsVolumes === null ||
            typeof (ctx.mapRequiredNfsVolumes) !== 'object') {
            callback(new Error('ctx.mapRequiredNfsVolumes must be an object'));
            return;
        }

        ctx.createdVolumes = {};

        if (ctx.mapRequiredNfsVolumes &&
            Object.keys(ctx.mapRequiredNfsVolumes).length === 0) {
            callback();
            return;
        }

        vasync.forEachParallel({
            func: provisionNfsVolume,
            inputs: Object.keys(ctx.mapRequiredNfsVolumes)
        }, function onAllRequiredVolumesProvisioned(err, results) {
            if (!err) {
                if (results === null || typeof (results) !== 'object') {
                    callback(new Error('results must be an object'));
                    return;
                }

                if (!Array.isArray(results.operations)) {
                    callback(new Error('results.operations must be an array'));
                    return;
                }

                var createdVolumes = {};
                var operationResultIndex;

                for (operationResultIndex in results.operations) {
                    var operationResult =
                        results.operations[operationResultIndex].result;

                    if (operationResult === null ||
                        typeof (operationResult) !== 'object') {
                        callback(new Error('operationResult must be an '
                            + 'object'));
                        return;
                    }

                    createdVolumes[operationResult.uuid] = operationResult;
                }

                ctx.createdVolumes = createdVolumes;
            }

            callback(err);
        });
    }

    function provisionNfsVolume(volumeName, callback) {
        if (typeof (volumeName) !== 'string') {
            callback(new Error('volumeName must be a string'));
            return;
        }

        volapi.createVolume({
            name: volumeName,
            owner_uuid: job.params.owner_uuid,
            type: 'tritonnfs',
            networks: job.vm.nics.map(function getOverlayNetwork(network) {
                if (typeof (network) !== 'object') {
                    callback('network must be an object');
                    return;
                }

                if (network.nic_tag &&
                    network.nic_tag.indexOf('sdc_overlay/') === 0) {
                    return network.network_uuid;
                }
            })
        }, function onVolumeCreated(volumeCreationErr, createdVolume) {
            if (volumeCreationErr &&
                volumeCreationErr.restCode === 'VOLUME_ALREADY_EXISTS') {
                volapi.listVolumes({
                    name:volumeName,
                    owner_uuid: job.params.owner_uuid
                }, function onListVolumes(listVolumesErr, volumes) {
                    var loadedVolume;

                    if (!listVolumesErr) {
                        if (!volumes || (volumes && volumes.length !== 1)) {
                            callback(new Error('There must be either no '
                                + 'or one volume with name '
                                + volumeName + ' for user '
                                + job.params.owner_uuid));
                            return;
                        }

                        loadedVolume = volumes[0];
                    }

                    callback(listVolumesErr, loadedVolume);
                    return;
                });
            } else {
                callback(volumeCreationErr, createdVolume);
            }
        });
    }
}

/*
 * Sets a request to CNAPI that updates the internal_metadata property of a VM
 * that depends on NFS volumes, in order for that VM to have the proper data in
 * its 'docker:nfsvolumes' internal_metadata property. That data is used by
 * dockerinit when the zone boots to mount exported filesystems from the
 * corresponding NFS shared volumes.
 *
 * This function only sets the request up. The request is performed later by
 * subsequent tasks in the same workflow. The next task with a body equal to
 * 'common.zoneAction' sends the request, and the task after with a body of
 * 'common.waitTask' waits for it to complete.
 */
function setupUpdateVmNfsVolumesMetadataRequest(job, callback) {
    if (job.updatedVmInternalMetadata === null ||
        typeof (job.updatedVmInternalMetadata) !== 'object') {
        callback(new Error('job.updatedVmInternalMetadata must be an object'));
        return;
    }

    job.endpoint = '/servers/' +
                   job.params.server_uuid + '/vms/' +
                   job.params.vm_uuid + '/update';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.action = 'update';
    job.server_uuid = job.params['server_uuid'];

    job.params.payload = {
        set_internal_metadata: job.updatedVmInternalMetadata
    };

    return callback(null, 'Request has been setup!');
}

function buildNfsVolumesMetadata(job, callback) {
    if (typeof (job.vm) !== 'object') {
        callback(new Error('job.vm must be an object'));
        return;
    }

    if (typeof (job.createdVolumes) !== 'object') {
        callback(new Error('job.createdVolumes must be an object'));
        return;
    }

    var volume;
    var volumeUuid;
    var nfsVolumesMetadata = [];
    var stringifiedNfsVolumesMetadata;

    // We just want to augment the current VM's metadata, so we perform a copy
    // instead of grabbing a reference so that we don't cause unintended side
    // effects by modifying internal metadata on the "job.vm"" object, which
    // might be used by other tasks/jobs.
    var vmInternalMetadata = jsprim.deepCopy(job.vm.internal_metadata);

    if (!job.createdVolumes || Object.keys(job.createdVolumes).length === 0) {
        callback(null, 'No NFS volume with which to update VM\'s internal '
            + 'metadata');
        return;
    }

    for (volumeUuid in job.createdVolumes) {
        volume = job.createdVolumes[volumeUuid];
        nfsVolumesMetadata.push({
            nfsvolume: volume.filesystem_path,
            mountpoint: job.mapRequiredNfsVolumes[volume.name].mountpoint
        });
    }

    stringifiedNfsVolumesMetadata = JSON.stringify(nfsVolumesMetadata);
    vmInternalMetadata['docker:nfsvolumes'] = stringifiedNfsVolumesMetadata;

    // job.requiredNfsVolumesMetadata will be compared to the actual value of
    // internal_metadata['docker:nfsvolumes'] in the next task to determine when
    // the update is completed. Without setting this property, there's no way to
    // know when the update is complete.
    job.updatedVmInternalMetadata = vmInternalMetadata;
    callback(null, 'Built docker:nfsvolumes internal_metadata:'
        + stringifiedNfsVolumesMetadata);
}

function waitForNfsVolumesMetadataUpdated(job, callback) {
    if (typeof (job.vm) !== 'object') {
        callback(new Error('job.vm must be an object'));
        return;
    }

    if (typeof (job.stringifiedRequiredNfsVolumesMetadata) !== 'string') {
        callback(new Error('job.stringifiedRequiredNfsVolumesMetadata must '
            + 'be a string'));
        return;
    }

    if (typeof (job.createdVolumes) !== 'object') {
        callback(new Error('job.createdVolumes must be an object'));
        return;
    }

    var stringifiedRequiredNfsVolumesMetadata =
        job.stringifiedRequiredNfsVolumesMetadata;

    var vmapi = new sdcClients.VMAPI({
        url: vmapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    if (!job.createdVolumes || Object.keys(job.createdVolumes).length === 0) {
        callback(null, 'No NFS volume with which to update VM\'s internal '
            + 'metadata');
        return;
    }

    function checkMetadataUpdated() {
        vmapi.getVm({
            uuid: job.vm.uuid,
            owner_uuid: job.vm.owner_uuid
        }, function onGetVm(err, vm) {
            var currentVmNfsVolumesMetadata;

            if (err) {
                callback(new Error('Error when getting VM: ' + err));
            } else {
                if (vm.internal_metadata) {
                    currentVmNfsVolumesMetadata =
                        vm.internal_metadata['docker:nfsvolumes'];
                }

                if (currentVmNfsVolumesMetadata ===
                    stringifiedRequiredNfsVolumesMetadata) {
                        callback(null,
                            'NFS volumes metadata updated successfully');
                    } else {
                        job.log.debug('NFS volumes metadata not updated '
                            + 'properly. Expected: '
                            + stringifiedRequiredNfsVolumesMetadata + ', got: '
                            + currentVmNfsVolumesMetadata
                            + '. Rescheduling check');
                        setTimeout(checkMetadataUpdated, 1000);
                    }
            }
        });
    }

    checkMetadataUpdated();
}

function waitForNfsVolumeProvisions(job, callback) {
    if (job.requiredNfsVolumes !== undefined &&
        !Array.isArray(job.requiredNfsVolumes)) {
        callback(new Error('job.requiredNfsVolumes must be an array if '
            + 'present'));
        return;
    }

    if (!job.createdVolumes || Object.keys(job.createdVolumes).length === 0) {
        callback(null, 'No required NFS volume to wait for');
        return;
    }

    var volapi = new sdcClients.VOLAPI({
        url: volapiUrl,
        headers: {'x-request-id': job.params['x-request-id']},
        version: '^1',
        userAgent: job.name
    });

    vasync.forEachParallel({
        func: function checkVolumeCreated(nfsVolumeUuid, done) {
            if (typeof (nfsVolumeUuid) !== 'string') {
                done(new Error('nfsVolumeUuid must be a string'));
                return;
            }

            function checkVolumeReady() {
                volapi.getVolume({
                    uuid: nfsVolumeUuid,
                    owner_uuid: job.params.owner_uuid
                }, function onGetVolume(getVolumeErr, volume) {
                    if (getVolumeErr) {
                        done(getVolumeErr);
                        return;
                    }

                    if (volume && volume.state === 'ready') {
                        job.createdVolumes[volume.uuid] = volume;
                        done();
                        return;
                    }

                    setTimeout(checkVolumeReady, 1000);
                });
            }

            checkVolumeReady();
        },
        inputs: Object.keys(job.createdVolumes)
    }, function allVolumesReady(err, results) {
        if (err) {
            callback(new Error('Could not determine if all required volumes '
                + 'are ready'));
        } else {
            callback(null, 'All required volumes ready');
        }
    });
}

module.exports = {
    provisionChain: [
        {
            name: 'volapi.provision_nfs_volumes',
            timeout: 120,
            retry: 1,
            body: provisionNfsVolumes,
            modules: {
                sdcClients: 'sdc-clients',
                vasync: 'vasync'
            }
        }, {
            name: 'cnapi.wait_for_nfs_volumes_provisions',
            timeout: 120,
            retry: 1,
            body: waitForNfsVolumeProvisions,
            modules: {
                sdcClients: 'sdc-clients',
                vasync: 'vasync'
            }
        }, {
            name: 'cnapi.build_nfs_volumes_metadata',
            timeout: 10,
            retry: 1,
            body: buildNfsVolumesMetadata,
            modules: {
                sdcClients: 'sdc-clients',
                vasync: 'vasync',
                jsprim: 'jsprim'
            }
        },
        {
            name: 'setup_update_vm_nfs_volumes_metadata_request',
            timeout: 10,
            retry: 1,
            body: setupUpdateVmNfsVolumesMetadataRequest,
            modules: {}
        }, {
            name: 'cnapi.update_vm',
            timeout: 10,
            retry: 1,
            body: common.zoneAction,
            modules: { restify: 'restify' }
        }, {
            name: 'cnapi.wait_task',
            timeout: 10,
            retry: 1,
            body: common.waitTask,
            modules: { sdcClients: 'sdc-clients' }
        }
    ]
};