/*
 *
 *
 * (c) Copyright Merative US L.P. and others 2020-2022 
 *
 * SPDX-Licence-Identifier: Apache 2.0
 *
 */

const CloudantHelperLib = require('./helpers/cloudant-helper');
const helperAppID = require('./helpers/app-id-helper');
const helperKeyProtect = require('./helpers/keyprotect-helper');
const idGenerator = require('./helpers/helper');
const deIdentifierIndexes = require('./cloudant-indexes/deIdentifier.json');
const gatewayListenerIndexes = require('./cloudant-indexes/gatewayListener.json');

module.exports = {
    CloudantHelperLib,
    helperAppID,
    helperKeyProtect,
    idGenerator,
    deIdentifierIndexes,
    gatewayListenerIndexes
};
