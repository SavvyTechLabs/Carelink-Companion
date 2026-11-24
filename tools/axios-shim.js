// Shim to force pkg to include the axios CJS build with a literal require path
module.exports = require('axios/dist/node/axios.cjs');
