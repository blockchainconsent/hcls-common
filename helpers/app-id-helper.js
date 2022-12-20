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
const querystring = require('querystring');
const cloudIamHelper = require('./cloud-iam-helper');

const log = require('./logger').getLogger('appid-helper');

let appIDObj = {};

let managementServerUrl;
let oauthServerUrl;
let pingServerUrl;

const retries = 1;
const retryDelay = 3000;
const timeout = 10000;

const setConfig = (appIDDataObj) => {
    appIDObj = Object.assign(appIDDataObj);
    managementServerUrl = `${appIDObj.url}/management/v4/${appIDObj.tenantID}`;
    oauthServerUrl = `${appIDObj.url}/oauth/v4/${appIDObj.tenantID}`;
    pingServerUrl = `${appIDObj.url}/oauth/v4/${appIDObj.tenantID}/publickeys`;
};

const validateConfig = () => {
    let missingVar;
    if (!appIDObj.url) {
        missingVar = 'APP_ID_URL';
    } else if (!appIDObj.clientID) {
        missingVar = 'APP_ID_CLIENT_ID';
    } else if (!appIDObj.tenantID) {
        missingVar = 'APP_ID_TENANT_ID';
    } else if (!appIDObj.secret) {
        missingVar = 'APP_ID_SECRET';
    }

    if (missingVar) {
        throw new Error(`Invalid AppID config: missing variable '${missingVar}'`);
    }
};

const pingAppID = async () => {
    const { CancelToken } = axios;
    const source = CancelToken.source();
    const timeout = setTimeout(() => {
        source.cancel(`Request timed out after ${timeout} ms`);
    }, timeout);

    const pingClient = axios.create({
        baseURL: pingServerUrl,
        timeout: timeout,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
        }
    });

    try {
        await pingClient.get('/', {cancelToken: source.token}).finally(() => clearTimeout(timeout));
        log.info("AppID health is OK");
        return true;
    } catch (error) {
        log.error(`AppID health is not OK: ${error}`);
        return false;
    }
};

const appIdLoginClient = () => {
    const loginClient = axios.create({
        baseURL: `${oauthServerUrl}/token`,
        timeout: timeout,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
        },
        auth: {
            username: appIDObj.clientID,
            password: appIDObj.secret,
        },
    });

    // setup retry-axios config
    loginClient.defaults.raxConfig = {
        instance: loginClient,
        retry: retries,
        backoffType: 'static', // options are 'exponential' (default), 'static' or 'linear'
        noResponseRetries: retries, // retry when no response received (such as on ETIMEOUT)
        statusCodesToRetry: [[500, 599]], // retry only on 5xx responses (no retry on 4xx responses)
        retryDelay,
        httpMethodsToRetry: ['POST', 'GET', 'HEAD', 'PUT'],
        onRetryAttempt: (err) => {
            const cfg = rax.getConfig(err);
            log.warn('No response received from AppID, retrying login request:');
            log.warn(`Retry attempt #${cfg.currentRetryAttempt}`);
        },
    };

    rax.attach(loginClient);
    return loginClient;
};

const loginAppID = async (username, password) => {
    try {
        validateConfig();
        const loginClient = appIdLoginClient();
        const requestBody = {
            username,
            password,
            grant_type: 'password',
        };
        log.debug('Calling AppID to retrieve auth token');
        const response = await loginClient.post('/', querystring.stringify(requestBody));
        log.info('Login request to AppID was successful');

        return response.data;
    } catch (error) {
        log.error(`Login request to AppID failed: ${error}`);
        const errorObj = new Error();
        if (error.response) {
            const errorResponse = error.response;
            errorObj.status = errorResponse.status;
            errorObj.statusText = errorResponse.statusText;
            if ('data' in errorResponse) {
                errorObj.message = errorResponse.data.error_description;
            }
        } else {
            errorObj.status = 500;
            errorObj.statusText = error.code;
            errorObj.message = error.message;
        }
        throw errorObj;
    }
};

const appIdMgmtClient = async () => {
    validateConfig();

    const token = await cloudIamHelper.getCloudIAMToken(appIDObj.apikey);
    const axClient = axios.create({
        baseURL: managementServerUrl,
        timeout: timeout,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
        },
    });

    // setup retry-axios config
    axClient.defaults.raxConfig = {
        instance: axClient,
        retry: retries,
        backoffType: 'static', // options are 'exponential' (default), 'static' or 'linear'
        noResponseRetries: retries, // retry when no response received (such as on ETIMEOUT)
        statusCodesToRetry: [[500, 599]], // retry only on 5xx responses (no retry on 4xx responses)
        retryDelay,
        httpMethodsToRetry: ['POST', 'GET', 'HEAD', 'PUT'],
        onRetryAttempt: (err) => {
            const cfg = rax.getConfig(err);
            log.warn('No response received from AppID, retrying');
            log.warn(`Retry attempt #${cfg.currentRetryAttempt}`);
        },
    };

    rax.attach(axClient);
    return axClient;
};

const getAllRolesIds = async (client) => {
    log.debug('Getting all roles ids');
    try {
        const responseRoles = await client.get('/roles');
        const roles = responseRoles.data.roles.map(({ id }) => id); // getting roles ids to add them to our user
        return roles;
    } catch (error) {
        log.error(`Failed to get roles from AppID: ${error}`);
        throw error;
    }
};

const createUserCloudDirectory = async (username, password, client) => {
    log.debug('Creating new user in Cloud Directory');
    try {
        const data = {
            'active': true,
            'emails': [
                {
                    'value': username,
                    'primary': true
                }
            ],
            'name': {
                'givenName': 'QA',
                'familyName': 'User',
                'formatted': 'QA User'
            },
            'userName': appIDObj.userName,
            'password': password
        };
        await client.post('/cloud_directory/Users', data); // creating user in cloud directory
    } catch (error) {
        log.error(`Failed to create user in cloud directory: ${error}`);
        throw error;
    }
};

const activateNewUserProfile = async (username, password, client) => {
    log.debug('Activating new user profile');
    try {
        await loginAppID(username, password); // activating user's profile
        const responseUsers = await client.get('/users');
        const user = responseUsers.data.users.find((user) => user.email === username); // finding new user's id
        return user.id;
    } catch (error) {
        log.error(`Failed to get new user ID: ${error}`);
        throw error;
    }
};

const updateUserRoles = async (roles, newUserId, client) => {
    log.debug('Updating new user roles');
    try {
        const data = {
            'roles': {
                'ids': roles
            }
        };
        await client.put(`/users/${newUserId}/roles`, data); // updating new user's roles
    } catch (error) {
        log.error(`Failed to update roles: ${error}`);
        throw error;
    }
};

const updateUserAttributes = async (newUserId, client) => {
    log.debug('Updating new user attributes');
    try {
        const data = {
            'attributes': {
                'TenantID': appIDObj.userTenantID
            }
        };
        await client.put(`/users/${newUserId}/profile`, data); // updating new user's tenantID
    } catch (error) {
        log.error(`Failed to update attributes: ${error}`);
        throw error;
    }
};

const existUserCheckFunc = async (username, password) => {
    log.debug('Exist user check starting');
    let isUserExists; let newUserId;

    try {
        log.debug('Trying to login with current credentials');
        await loginAppID(username, password);
        isUserExists = true;
    } catch (error) {
        log.warn('Login failed, creating new user');
        isUserExists = false;
    }

    if(!isUserExists) {
        const userObj = {};
        try {
            const client = await appIdMgmtClient();
            const roles = await getAllRolesIds(client);
            userObj.client = client;
            userObj.roles = roles;
        } catch (error) {
            return error;
        }

        const { client, roles } = userObj;

        try {
            await createUserCloudDirectory(username, password, client);
            newUserId = await activateNewUserProfile(username, password, client);
            await updateUserRoles(roles, newUserId, client);
            await updateUserAttributes(newUserId, client);
        } catch (error) {
            return error;
        }
    };
};

const existUserCheck = async (username, password) => {
    const result = await existUserCheckFunc(username, password);
    if (result instanceof Error) {
      log.error(`Login was not successful! ${result}`)
    } else {
      log.info('Login was successful!');
    }
};

module.exports = {
    setConfig,
    pingAppID,
    loginAppID,
    existUserCheck
};
