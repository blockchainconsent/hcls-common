/*
 *
 *
 * (c) Copyright Merative US L.P. and others 2020-2022 
 *
 * SPDX-Licence-Identifier: Apache 2.0
 *
 */

const axios = require('axios');

const querystring = require('querystring');
const https = require('https');

const log = require('./logger').getLogger('cloud-iam-helper');

const iamUrl = 'https://iam.cloud.ibm.com/identity/token';

async function getCloudIAMToken(apiKey) {
    try {

      if (!apiKey) {
        throw new Error('getCloudIAMToken() is missing an API key argument');
      }

      log.info('getCloudIAMToken()');
      const agent = new https.Agent({
        rejectUnauthorized: false,
      });

      const reqBody = querystring.stringify({
        grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
        apikey: apiKey,
      });

      const response = await axios.post(
        iamUrl,
        reqBody,
        {
          httpsAgent: agent,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
        }
      );
      return response.data.access_token;
    } catch (error) {
      const errMsg = `Failed to get Cloud IAM token: ${error.message}`;
      log.error(errMsg);
      const errorObj = new Error();
      errorObj.statusCode = error.response ? error.response.status : 500;
      errorObj.message = errMsg;
      throw errorObj;
    }
  }

  module.exports = {
    getCloudIAMToken
  };
