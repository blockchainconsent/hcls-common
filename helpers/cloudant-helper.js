/*
 *
 *
 * (c) Copyright Merative US L.P. and others 2020-2022 
 *
 * SPDX-Licence-Identifier: Apache 2.0
 *
 */

const { CloudantV1 } = require('@ibm-cloud/cloudant');
const {
  IamAuthenticator,
  BasicAuthenticator,
} = require('ibm-cloud-sdk-core');

const log = require('./logger').getLogger('cloudant-helper');

let cloudantObj;

function initCloudant() {

    if (!cloudantObj.connection) {
      throw new Error('Missing DB connection configuration');
    }

    // As long as user provides 'iamApiKey' and 'account' values in config file
    // IAM method will be the authentication method.
    const useIamAuth = cloudantObj.connection.account && cloudantObj.connection.iamApiKey;
    if (useIamAuth) {
      log.info('Use IAM auth for DB connection');

      const authenticator = new IamAuthenticator({
        apikey: cloudantObj.connection.iamApiKey,
      });

      const service = new CloudantV1({ authenticator });

      service.setServiceUrl(cloudantObj.connection.url);

      return service;
    }

    // If user provides 'url', 'username', 'password' values in config file
    // and does not provide 'iamApiKey' or 'account' values,
    // then legacy authentication method will be used.
    const useLegacyAuth = cloudantObj.connection.url && cloudantObj.connection.username && cloudantObj.connection.password;
    if (useLegacyAuth) {
      log.info('Use legacy auth for DB connection');

      const authenticator = new BasicAuthenticator({
        username: cloudantObj.connection.username,
        password: cloudantObj.connection.password,
      });

      const service = new CloudantV1({ authenticator });

      if (cloudantObj.connection.proxyUrl) {
        service.setServiceUrl(cloudantObj.connection.proxyUrl);
      } else {
        service.setServiceUrl(cloudantObj.connection.url);
      }

      return service;
    }
    throw new Error('Missing DB credentials');
  }

  let instance;
  class CloudantHelperLib {
    static getInstance(cloudantDataObj) {
        cloudantObj = Object.assign(cloudantDataObj);
      if (!instance) {
        instance = new CloudantHelperLib();
      } else if (!instance.cloudant) {
        const errMsg = 'Cloudant was not initialized during startup, please check configuration';
        log.error(errMsg);
        // eslint-disable-next-line no-throw-literal
        throw { status: 500, message: errMsg };
      }
      return instance;
    }

    async setupCloudant() {
      if (!this.cloudant) {
        try {
          this.cloudant = await initCloudant();
        } catch (err) {
          log.error(`Failed to initCloudant: ${err}`);
          throw err;
        }
      }
    }

    async pingCloudant() {
      try {
        const reply = await this.cloudant.getSessionInformation();
        log.info('Cloudant pinged successfully:', reply.result);
        return true;
      } catch (error) {
        log.error(`Failed to ping Cloudant: ${error.message}`);
        return false;
      }
    }

    async checkConnection() {
      const timeout = (promise, time, exception) => {
        let timer;
        return Promise.race(
          [promise, new Promise((res, rej) => {
            timer = setTimeout(rej, time, exception);
          })],
        )
          .finally(() => clearTimeout(timer));
      };
      const timeoutError = new Error(`Request timed out after ${cloudantObj.connection.timeout} ms`);

      try {
        return await timeout(
          this.pingCloudant(),
          cloudantObj. connection.timeout,
          timeoutError,
        );
      } catch (error) {
        log.error(`Cloudant service error: ${error}`);
        return false;
      }
    }

    async getOrCreateDB(db, indexes) {
      try {
        await this.cloudant.getDatabaseInformation({ db });
        log.info(`Successfully got Cloudant database ${db}`);
      } catch (err) {
        const debugMsg = `Failed to get Cloudant database ${db}: ${err.message}`;
        log.error(debugMsg);
        await this.createDB(db, indexes);
      }
    }

    async createDB(db, indexes) {
      try {
        await this.cloudant.putDatabase({ db, partitioned: true });
        log.info(`Created Cloudant database ${db}`);

        if (Array.isArray(indexes) && indexes.length) {
          for (const payloadForIndex of indexes) {
            if (Object.keys(payloadForIndex)[0] === "index") {
              await this.createIndex(db, payloadForIndex);
            } else {
              await this.createDesignDocument(db, payloadForIndex);
            }
          }
        }
      } catch (e) {
        log.error(`Failed to create Cloudant database ${db}: ${e.message}`);
        throw e;
      }
    }

    async createIndex(db, params) {
      try {
        await this.cloudant.postIndex({ db, ...params });
        log.info(`Creating Cloudant index in database ${db}: ${JSON.stringify(params)}`);
      } catch (err) {
        log.error(`Failed to create index in database ${db}: ${JSON.stringify(params)}`);
      }
    }

    async createDesignDocument(db, payload) {
      try {
        await this.cloudant.putDesignDocument({ db, ...payload });
        log.info(`Created the design view in the database ${db}`);
      } catch (err) {
        log.error(`Failed to create design view in the database ${db}: ${err.message}`);
        throw err;
      }
    }

    async getAllDocumentsByView(db, viewName, dbPartitionKey) {
      try {
        log.debug(`Getting a list of all documents by view in a database ${db}`);
        const { result } = await this.cloudant.postPartitionView({
          db,
          ddoc: viewName,
          view: viewName,
          partitionKey: dbPartitionKey,
        });
        return result;
      } catch (err) {
        log.error(`Failed to getting a list of all documents by view in the database ${db}: ${err.message}`);
        throw err;
      }
    }

    async savePii(db, pii) {
      const { result: generatedUuid } = await this.cloudant.getUuids({ count: 1 });
      const id = generatedUuid.uuids[0];
      const dePii = generatedUuid.uuids[0];

      const { result } = await this.cloudant.postDocument({
        db,
        document: {
          _id: `${cloudantObj.dbPartitionKey}:${id}`,
          pii,
          dePii,
        },
      });
      log.info(`PII has been saved successfully: ${JSON.stringify(result)}`);

      return {
        dePii,
        pii,
      };
    }

    async findByQuery(db, selector) {
      log.debug('Search for existing PII/PHI');
      const { result } = await this.cloudant.postPartitionFind({
        db,
        partitionKey: cloudantObj.dbPartitionKey,
        selector,
      });
      return result.docs;
    }

    async getDocument(db, docId) {
      try {
        log.debug('Retrieve a document');
        const { result } = await this.cloudant.getDocument({ db, docId });
        return result;
      } catch (err) {
        log.error(`Failed to retrieve a document in the database ${db}: ${err.message}`);
        throw err;
      }
    }

    async createOrUpdateBulk (db, docs) {
      try {
        log.debug(`Creating or updating a bulk of documents in a database ${db}`);
        const bulkDocs = CloudantV1.BulkDocs = { docs };
        await this.cloudant.postBulkDocs({
          db,
          bulkDocs
        });
        log.info('Cloudant has been updated successfully');
      } catch (err) {
        log.error(`Failed to create or update bulk in database ${db}: ${err.message}`);
        throw err;
      }
    }

    async deleteDB(db) {
      try {
        await this.cloudant.getDatabaseInformation({ db });
        log.info(`Deleting Cloudant database ${db}`);
        return await this.cloudant.deleteDatabase({ db });
      } catch (e) {
        log.error(`Failed to delete Cloudant database ${db}: ${e.message}`);
        throw e;
      }
    }
  }

module.exports = CloudantHelperLib;
