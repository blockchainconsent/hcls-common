/*
 *
 *
 * (c) Copyright Merative US L.P. and others 2020-2022 
 *
 * SPDX-Licence-Identifier: Apache 2.0
 *
 */

const axios = require('axios');
const rax = require('retry-axios');
const moment = require('moment');

const cloudIamHelper = require('./cloud-iam-helper');

const log = require('./logger').getLogger('keyprotect-helper');

let keyProtectObj = {};

const setConfig = (keyProtectDataObj) => {
    keyProtectObj = Object.assign(keyProtectDataObj);
};

const validateConfig = () => {
    let missingVar;
    if (!keyProtectObj.url) {
        missingVar = 'KEYPROTECT_URL';
    } else if (!keyProtectObj.instanceID) {
        missingVar = 'KEYPROTECT_GUID';
    } else if (!keyProtectObj.apikey) {
        missingVar = 'KEYPROTECT_APIKEY';
    } else if (!keyProtectObj.retries) {
        missingVar = 'KEYPROTECT_RETRIES';
    } else if (!keyProtectObj.retryDelay) {
        missingVar = 'KEYPROTECT_RETRYDELAY';
    } else if (!keyProtectObj.timeout) {
        missingVar = 'KEYPROTECT_TIMEOUT';
    }

    if (missingVar) {
        throw new Error(`Invalid KeyProtect config: missing variable '${missingVar}'`);
    }
};

const keyProtectClient = (token) => {
    const client = axios.create({
        baseURL: keyProtectObj.url,
        timeout: keyProtectObj.timeout,
        headers: {
            Accept: 'application/vnd.ibm.kms.key+json',
            Authorization: `Bearer ${token}`,
            'bluemix-instance': keyProtectObj.instanceID
        }
    });

    // setup retry-axios config
    client.defaults.raxConfig = {
        instance: client,
        retry: keyProtectObj.retries,
        noResponseRetries: keyProtectObj.retries, // retry when no response received (such as on ETIMEOUT)
        statusCodesToRetry: [[500, 599]], // retry only on 5xx responses
        retryDelay: keyProtectObj.retryDelay,
        onRetryAttempt: (err) => {
            const cfg = rax.getConfig(err);
            log.warn('No response received from KeyProtect, retrying request:');
            log.warn(`Retry attempt #${cfg.currentRetryAttempt}`);
        },
    };

    rax.attach(client);
    return client;
};

const getAllKeysHelper = async (client) => {
    try {
        validateConfig();

        const response = await client.get();

        const keysArray = response.data.resources;
        log.info(`Successfully retrieved ${keysArray.length} from KeyProtect`);
        return keysArray;
    } catch (error) {
        let failureReasons = '';
        if (error.response && error.response.data && error.response.data.resources)
            failureReasons = JSON.stringify(error.response.data.resources);
        else if (error.message)
            failureReasons = error.message;

        const errMsg = `Failed to retrieve keys from KeyProtect: ${failureReasons}`;
        log.warn(errMsg);
        return [];
    }

};

const getAllKeys = async (client) => {
    if (!client) {
        const token = await cloudIamHelper.getCloudIAMToken(keyProtectObj.apikey);
        const client = keyProtectClient(token);
        return getAllKeysHelper(client)
    } else {
        return getAllKeysHelper(client)
    }
};

const getKeysByName = async (client, keyName) => {
    try {
        validateConfig();

        const response = await getAllKeys(client);

        const filteredKeys = response
            .filter((key) => {
                return key.name === keyName;
            });
        log.info(`Successfully retrieved ${filteredKeys.length} key id(s) for name = ${keyName} from KeyProtect`);
        return filteredKeys;
    } catch (error) {
        let failureReasons = '';
        if (error.response && error.response.data && error.response.data.resources)
            failureReasons = JSON.stringify(error.response.data.resources);
        else if (error.message)
            failureReasons = error.message;

        const errMsg = `Failed to retrieve key ids for ${keyName} from KeyProtect: ${failureReasons}`;
        log.warn(errMsg);
        return [];
    }
};

const deleteKey = async (keyID) => {
    try {
        validateConfig();

        const token = await cloudIamHelper.getCloudIAMToken(keyProtectObj.apikey);
        const client = keyProtectClient(token);

        await client.delete(keyID);

        log.info(`Successfully deleted key ${keyID} in KeyProtect`);
    } catch (error) {
        let failureReasons = '';
        if (error.response && error.response.data && error.response.data.resources)
            failureReasons = JSON.stringify(error.response.data.resources);
        else if (error.message)
            failureReasons = error.message;

        const errMsg = `Failed to delete key ${keyID} in KeyProtect: ${failureReasons}`;
        log.error(errMsg);
        throw new Error(errMsg);
    }
};

const getNewestKeyIDByName = async (client, searchName) => {
    const keyList = await getKeysByName(client, searchName);

    let newestKeyID = '';
    let newestCreationDate = moment(0);

    for (let i = 0; i < keyList.length; i += 1) {
        if (keyList[i].name === searchName) {
            const currentCreationDate = moment(keyList[i].creationDate);
            // check creation date against newest key with same name
            if (newestCreationDate.isBefore(currentCreationDate)) {
                newestCreationDate = currentCreationDate;

                // delete older key with same name
                if (newestKeyID) {
                    log.warn(`Attempting to delete older key ${newestKeyID} with name ${searchName} in KeyProtect`);
                    // eslint-disable-next-line no-await-in-loop
                    await deleteKey(newestKeyID);
                }

                newestKeyID = keyList[i].id;
            }
        }
    }
    return newestKeyID;
};

const parseKeyPayload = (response) => {
    try {
        const payloadExists =
            response.data
            && response.data.resources
            && response.data.resources.length
            && response.data.resources[0].payload;

        if (payloadExists) {
            const { payload } = response.data.resources[0];
            const decodedPayload = Buffer.from(payload, 'base64').toString();
            const jsonPayload = JSON.parse(decodedPayload);
            log.debug('Successfully parsed key from KeyProtect');
            return jsonPayload;
        }
        log.warn('Payload not found for key from KeyProtect');
    } catch (error) {
        log.warn(`Failed to parse key from KeyProtect: ${error}`);
    }
    return '';
};

const parseKeyID = (response) => {
    try {
        const idExists =
            response.data
            && response.data.resources
            && response.data.resources.length
            && response.data.resources[0].id;

        if (idExists) {
            return response.data.resources[0].id;
        }
        log.warn('ID not found for key from KeyProtect');
    } catch (error) {
        log.warn(`Failed to parse ID for key from KeyProtect: ${error}`);
    }
    return '';
};

const getKeyByID = async (keyID) => {
    try {
        validateConfig();

        const token = await cloudIamHelper.getCloudIAMToken(keyProtectObj.apikey);
        const client = keyProtectClient(token);

        const getKeyResponse = await client.get(keyID);

        log.info(`Successfully retrieved key ${keyID} from KeyProtect`);
        return parseKeyPayload(getKeyResponse);
    } catch (error) {
        let failureReasons = '';
        if (error.response && error.response.data && error.response.data.resources)
            failureReasons = JSON.stringify(error.response.data.resources);
        else if (error.message)
            failureReasons = error.message;

        const errMsg = `Failed to retrieve key ${keyID} from KeyProtect: ${failureReasons}`;
        log.warn(errMsg);
        return '';
    }
};

const getNewestKeyByName = async (keyName) => {
    try {
        validateConfig();

        const token = await cloudIamHelper.getCloudIAMToken(keyProtectObj.apikey);
        const client = keyProtectClient(token);

        const keyID = await getNewestKeyIDByName(client, keyName);
        if (!keyID) {
            const errMsg = `Key ${keyName} not found in KeyProtect`;
            log.warn(errMsg);
            return '';
        }

        const getKeyResponse = await client.get(keyID);

        log.info(`Successfully retrieved newest key for name = ${keyName} from KeyProtect (id = ${keyID})`);
        return parseKeyPayload(getKeyResponse);
    } catch (error) {
        let failureReasons = '';
        if (error.response && error.response.data && error.response.data.resources)
            failureReasons = JSON.stringify(error.response.data.resources);
        else if (error.message)
            failureReasons = error.message;

        const errMsg = `Failed to retrieve key ${keyName} from KeyProtect: ${failureReasons}`;
        log.warn(errMsg);
        return '';
    }
};

const createKey = async (keyName, keyPayload) => {
    try {
        validateConfig();

        if (!keyName)
            throw new Error('keyName is empty');
        if (!keyPayload)
            throw new Error('keyPayload is empty');

        log.debug('Attempting to check for existing key (before creating new key)');

        const token = await cloudIamHelper.getCloudIAMToken(keyProtectObj.apikey);
        const client = keyProtectClient(token);

        const existingKeyID = await getNewestKeyIDByName(client, keyName);
        if (existingKeyID) {
            log.debug('Existing key found, attempting to delete (before creating new key)');
            await deleteKey(existingKeyID);
        }

        const strPayload = JSON.stringify(keyPayload);
        const encodedPayload = Buffer.from(strPayload).toString('base64');

        const requestBody = {
            metadata: {
                collectionType: 'application/vnd.ibm.kms.key+json',
                collectionTotal: 1
            },
            resources: [
                {
                    type: 'application/vnd.ibm.kms.key+json',
                    name: keyName,
                    description: 'Simple Consent Blockchain Admin Identity',
                    extractable: true,
                    payload: encodedPayload
                }
            ]
        };

        const createResponse = await client.post('', JSON.stringify(requestBody));

        const keyID = parseKeyID(createResponse);
        log.info(`Successfully created key ${keyID} in KeyProtect`);
        return keyID;
    } catch (error) {
        let failureReasons = '';
        if (error.response && error.response.data && error.response.data.resources)
            failureReasons = JSON.stringify(error.response.data.resources);
        else if (error.message)
            failureReasons = error.message;

        const errMsg = `Failed to create key in KeyProtect: ${failureReasons}`;
        log.error(errMsg);
        throw new Error(errMsg);
    }
};

module.exports = {
    setConfig,
    getKeyByID,
    createKey,
    deleteKey,
    getNewestKeyByName,
    getAllKeys
};
