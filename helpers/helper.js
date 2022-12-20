/*
 *
 *
 * (c) Copyright Merative US L.P. and others 2020-2022 
 *
 * SPDX-Licence-Identifier: Apache 2.0
 *
 */

const { v4: uuidv4 } = require('uuid');

// generate random string with alphanumeric characters only
const idGenerator = () => {
    return uuidv4().replace(/[^0-9a-z]/g, '');
}

module.exports = idGenerator;
