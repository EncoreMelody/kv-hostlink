'use strict';

/**
 * KEYENCE KV Host Link (upper link) client for Node.js, no dependencies
 */

const hostlink = require('./lib/hostlink');
const address = require('./lib/address');

module.exports = {
    HostLinkClient: hostlink.HostLinkClient,
    HostLinkError: hostlink.HostLinkError,
    HostLinkTimeoutError: hostlink.HostLinkTimeoutError,
    DEFAULT_PORT: hostlink.DEFAULT_PORT,
    DEFAULT_TIMEOUT: hostlink.DEFAULT_TIMEOUT,
    ERRORS: hostlink.ERRORS,
    MODES: hostlink.MODES,
    MODELS: hostlink.MODELS,
    DEVICES: address.DEVICES,
    FORMATS: address.FORMATS,
    parseAddress: address.parseAddress,
    formatAddress: address.formatAddress,
    buildReadPlan: address.buildReadPlan,
    decodeValue: address.decodeValue,
    encodeValue: address.encodeValue,
};
